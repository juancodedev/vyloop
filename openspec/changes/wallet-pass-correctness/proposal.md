# Proposal: Wallet Pass Correctness

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Intent

Close three gaps in the Google Wallet integration that do not block the PMV but
leave the pass either technically wrong, absent for some customers, or
unmanageable by the merchant:

1. **The balance is sent with the wrong type.** `loyaltyPoints.balance` goes to
   Google as `{ "string": "<digits>" }`
   (`workers/wallet/src/object.ts:275`, `workers/wallet/src/reconcile.ts:314`),
   while the value is an integer and Google's `LoyaltyPointsBalance` has an
   `int` field for it (`docs/14-Backlog.md:284-287`). Google accepts the string
   today and the pass renders, but the contract is the wrong one and stops
   working silently the day Google validates it.
2. **`member_code` exists only for customers who asked for a pass.**
   `ensureMemberCode` (`workers/wallet/src/issuance.ts:317`) is called only from
   `buildSignedPass` (`issuance.ts:485`). A registered customer who never opens
   the pass has `member_code = NULL` — 4 of 12 production customers had one when
   it was measured (`docs/14-Backlog.md:176-183`). The code is also what the POS
   resolves at the counter (`workers/growth/src/routes.ts:1855-1950`,
   `resolveMemberCode`), so the customer without a pass is exactly the one the
   cashier cannot identify by code.
3. **The merchant cannot see or manage their customers' passes.**
   `workers/wallet/src/routes.ts` serves the customer's own pass
   (`GET /v1/wallet/pass`, `:506`), the program record (`:948`, `:1030`,
   `:1125`) and Google's callback (`:212`), and nothing that lists a tenant's
   passes, reissues one or revokes one (`docs/14-Backlog.md:258-263`).
   `/dashboard/settings` shows the program, not the passes.

## Scope

### In Scope

1. Send the balance as `{ "int": <points> }` when creating and when patching a
   loyalty object, and read it back as an integer in the reconcile idempotency
   gate, accepting the legacy `string` form on objects written before the change.
2. Mint `member_code` when a customer registers, by having the growth worker's
   existing `CustomerRegistered` handler ask the wallet worker over the existing
   `WALLET` service binding. The pepper stays in the wallet worker.
3. A one-time, resumable backfill of `member_code` for existing customers, run by
   the wallet worker using the batch shape already written in
   `workers/wallet/sql/member-code-backfill.sql`.
4. Operator endpoints on the wallet worker: list the tenant's passes (paginated),
   reissue a pass, revoke a pass.
5. A pass-management view in `apps/dashboard`.

### Out of Scope

- Apple Wallet, or any second wallet provider.
- Changing the member code format, length or derivation
  (`workers/wallet/src/member-code.ts`).
- The balance display ceiling (`BALANCE_DISPLAY_MAX = 9_999_999`,
  `workers/wallet/src/balance.ts:26`). It is kept as a product rule even though
  an `int` balance no longer has a seven-character string budget; lifting it is
  a separate decision.
- Bulk actions (revoke all, reissue all).
- Leaving demo mode (`WALLET_DEMO_MODE`) or Google's publishing approval.

## Capabilities

### New Capabilities

- `google-wallet`: the loyalty object the platform writes to Google, the member
  code that identifies the holder, and the operator's management of a tenant's
  passes. No existing capability covers the wallet worker; `growth-engine`'s
  "Wallet Initialization" is the points ledger, not the Google pass.

### Modified Capabilities

- `growth-dashboard`: a pass-management view.

## Approach

### 1. The balance as an integer

`object.ts` changes `LoyaltyPointsBalance` from `{ string: string }` to a type
that writes `{ int: number }`. `formatBalance` (`balance.ts:85`) is replaced on
this path by a validator that returns the integer after
`balanceDisplayFailure` accepts it — the same single predicate both the builder
and `GET /v1/wallet/status` already share, so the two still cannot disagree.

`balanceStringOf` (`reconcile.ts:338`) becomes `balancePointsOf`, returning a
number: `balance.int` when present, otherwise `Number(balance.string)` when the
string is all digits, otherwise `null`. That keeps the idempotency gate correct
for passes written in the old form: the first reconcile after the change sees an
equal number and skips, or a different number and patches in the new form. The
post-condition check after `patchObject` (`reconcile.ts:320-323`) compares
numbers.

Google's response shape for `int` (whether it echoes `int` as a number or as a
string in JSON) MUST be verified against the Google Wallet REST reference at
implementation time; the reader accepts both.

### 2. `member_code` at registration

The lazy design is deliberate (`issuance.ts:296-306`): minting in
`workers/customer` would spread `MEMBER_CODE_PEPPER` into a worker with no other
reason to hold it. This change keeps that property. The customer worker already
publishes `CustomerRegistered` once the registration transaction commits
(`workers/customer/src/routes.ts:263,294`), and the growth worker already
consumes it (`workers/growth/src/event-handler.ts:27-28`,
`handleCustomerRegistered`) and already holds a `WALLET` service binding
(`workers/growth/wrangler.jsonc:44-49`, `WalletWorker` in
`workers/growth/src/helpers.ts:48-50`).

So the wallet worker gains a second exported RPC method beside
`reconcileCustomer` (`workers/wallet/src/index.ts:496-502`):
`ensureCustomerMemberCode({ tenantId, customerId })`. It reads the customer's
`global_id` and stored code and calls the existing `ensureMemberCode` — the same
compare-and-set (`drizzle-store.ts:384-419`, guarded by the partial unique index
`uq_customers_business_member_code`), so it is idempotent and race-safe against
a concurrent first pass issuance. The growth handler calls it after the ledger
initialisation, under the same failure contract as `schedulePassReconcile`: a
missing binding or a thrown error is logged and does not fail the event, because
issuance still mints lazily and remains the structural guarantee.

A queue consumer on the wallet worker was considered and rejected for the same
reason `workers/growth/wrangler.jsonc:36-43` records: the domain events queue
already has its one consumer, and the wallet's config contract test forbids a
`queues` block.

### 3. Backfill

A wallet export `backfillMemberCodes({ batchSize })` loops over the batch shape
in `sql/member-code-backfill.sql` (`member_code IS NULL AND deleted_at IS NULL`,
`FOR UPDATE SKIP LOCKED`, `LIMIT $1`), derives each code with
`findAvailableMemberCode`, and claims it with the same `claimMemberCode`
compare-and-set. It returns `{ claimed, skipped, remaining }` and is safe to run
again. It is invoked from an operator script
(`scripts/backfill-member-codes.mjs`) through `wrangler` against the deployed
worker, or through the existing `automation` → `wallet` scheduled call for one
day; the choice is made at implementation time, and either way the run is
recorded with its counts. The file's status header changes from `NOT APPLIED` to
the date and counts of the run.

### 4. Operator pass management

Three routes on the wallet worker, under the existing `/v1/wallet` gateway prefix
(`apps/gateway/src/router.ts:43`), each guarded by `requireOperatorRole`
(`workers/wallet/src/helpers.ts:390`) and scoped to `auth.businessId` through the
tenant session (`openTenantSession`):

- `GET /v1/wallet/passes?limit=&cursor=&state=` — rows of
  `customer_wallet_passes` joined to `customers` for the tenant: `customer_id`,
  customer name, `member_code`, `object_id`, `state`, `last_synced_at`,
  `updated_at`. Keyset pagination on `(updated_at desc, customer_id)`; `limit`
  defaults to 50 and is capped at 200. `idx_customer_wallet_passes_tenant`
  (`packages/db/src/schema.ts:1051`) already serves the tenant filter.
- `POST /v1/wallet/passes/:customerId/reissue` — returns a fresh signed save
  link for that customer by the same `issuePass` path the customer route
  uses (`routes.ts:668`), and, if Google holds the object as `INACTIVE` because of a revoke, patches
  it back to `ACTIVE` (Google first, post-condition checked, then the tracking
  row), mirroring `applyInactivityDeactivation` in reverse.
- `POST /v1/wallet/passes/:customerId/revoke` — patches the Google object to
  `INACTIVE` (Google first, post-condition checked, as
  `workers/wallet/src/inactivity.ts:443-529` does) and records the tracking row
  as `revoked`.

`revoked` is a new tracking state, distinct from `inactive`, because `inactive`
is written by the inactivity sweep and by callbacks and a customer's next
activity may legitimately move it on; a merchant's revocation must not be undone
by anything but a reissue. While a row is `revoked`, `GET /v1/wallet/pass`
answers a refusal (`WALLET_PASS_REVOKED`, 409) instead of a save link, and
`reconcilePass` already leaves non-`ACTIVE` objects alone (`reconcile.ts:277`).
`PassTrackingState` (`workers/wallet/src/object.ts:121-127`) gains `revoked`, and
`objectStateFor` (`object.ts:197`) maps it to the revocation object state.
`state` is `text` without a check constraint on purpose
(`schema.ts:1031-1034`), so this is a code change, not a migration. Whether
Google's `INACTIVE` or `EXPIRED` is the better object state for a revocation MUST
be decided against Google's documentation at implementation time; the spec fixes
the tracking semantics, not the Google enum value.

### 5. Dashboard view

A new route `/dashboard/loyalty/passes`
(`apps/dashboard/src/app/dashboard/loyalty/passes/page.tsx`), linked from the
loyalty section in `apps/dashboard/src/lib/navigation.ts`. It lists the passes
with the wording already established in `apps/dashboard/src/lib/pass-state.ts`
(which keeps `not_issued` and `not_saved` distinct), extended with `revoked`,
and offers Reissue and Revoke per row, Revoke behind a confirmation. API calls go
through `apps/dashboard/src/lib/api.ts`.

## Risks

- **A balance Google rejects.** A wrong field name fails at Google, not in tests.
  The first deploy MUST be followed by one real reconcile in demo mode and a look
  at the pass on a phone.
- **Registration latency.** The member-code call runs in the growth queue
  consumer, not on the registration request, so registration is unaffected; a
  failed call leaves the lazy path as the fallback.
- **Revocation misread as deletion.** Google keeps the object; the holder still
  sees it, marked inactive. The dashboard copy MUST say so.
- **Pepper exposure.** None added: the pepper stays a wallet secret and is never
  passed over the service binding.

## Rollback Plan

- Balance type: revert `object.ts` and `reconcile.ts`. Because the reader accepts
  both forms, passes already patched with `int` are read correctly by the
  reverted code only if the revert keeps the dual reader; the revert MUST keep
  `balancePointsOf` and only change the writer back.
- Member code at registration: remove the call in
  `workers/growth/src/event-handler.ts`. Codes already minted are valid and stay.
- Backfill: nothing to undo; codes are valid and stable.
- Pass management: remove the routes and the dashboard page. Rows left in
  `revoked` are re-activated by running reissue for each before the revert, or by
  an `UPDATE customer_wallet_passes SET state = 'inactive' WHERE state =
  'revoked'` so the old code reads a known state.
