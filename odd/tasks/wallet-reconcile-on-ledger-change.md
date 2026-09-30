# Reconcile the wallet pass when the ledger changes

## Objective

A Google Wallet pass must show the balance the customer has **at the moment the cashier scans it**. Today the projection only runs when the customer opens the app (`GET /v1/wallet/pass`) and once a day (`cron 0 6 * * *`), so a sale changes nothing until the customer happens to reopen the app. Verified: registering a sale in production left the pass showing its previous balance.

## Problem

A loyalty pass is a live surface at the till. Every other number in the product moves when the ledger moves; this one moves when the holder opens an app. The two are not the same event and the gap is visible to a customer standing at a counter.

## Why the existing triggers are the wrong shape

Both are **pull**. The balance is correct only if the customer pulls, and the daily sweep bounds the staleness at 24 hours — which is longer than a shift. Neither trigger knows a sale happened.

## Approach

Push, at the moment the ledger moves, **without blocking the sale**.

`POST /v1/loyalty/points/assign` and `POST /v1/loyalty/rewards/redeem` are the only two handlers that move a balance. After each commits, the handler asks the wallet worker to project that one customer, and hands the work to `waitUntil` so the 201 does not wait on Google.

### Why a service binding and not the queue

Growth already publishes `PointsAssigned` to `vyloop-domain-events`, so the event exists and the obvious move is a wallet queue consumer. Two things argue against it:

- The account's limits are the unknown, not the code. `workers/wallet/wrangler.jsonc` declares no cron trigger because the account allows five and all five are used; nothing in the repository says whether a fourth queue consumer would fit, and guessing at an account limit is how a deploy fails in CI instead of in a test.

  **Correction.** This section originally claimed a contract test forbids a `queues` block on the wallet. It does not: `wrangler-config.contract.test.ts:62` asserts the config does not contain `"triggers"`, and its comment is about cron slots. The wallet has no `queues` block either. A queue consumer was therefore not blocked by anything I could read — it stays unchosen because the account limit is unverified and because the reasons below stand on their own, not because a test forbade it.
- A consumer adds a delivery contract, a retry story and a dead-letter path to a projection that is already idempotent and already has a daily sweep as its backstop. `waitUntil` has neither.

If the account turns out to allow it, a consumer is still the better long-term shape: it survives a dropped `waitUntil`. That is a follow-up, not a prerequisite.

### Why not synchronous

Making the sale wait on Google would couple a till's availability to Google's. A Google minute would then be a sales outage, which is a worse failure than a balance that is briefly stale and converges within a day.

### Why it is safe to fire and forget

`reconcilePass` is already idempotent: two calls with an unchanged balance issue no Google write. The projection converges from any of the three triggers, and a failed `waitUntil` is picked up by the sweep.

## Authorized scope

- `workers/growth/**` — service binding, bindings type, fire the projection from the two ledger handlers
- `workers/wallet/**` — one exported RPC entry point for a single-customer reconcile
- No change to `reconcilePass`, `sweep`, the pass route, or the database schema
- Not in this change: the operator sync button and the navigation contract test's blind spot. Both are dashboard defects, tracked separately.

## Tasks

- [x] **T1** Export a per-customer reconcile on the wallet worker, as an RPC method beside the existing `scheduled`. Reuses `reconcilePass`; must not read the class or gate on anything the pass route already decided.
- [x] **T2** Bind `wallet` into the growth worker and widen `Bindings`. Growth currently declares no `services` block at all.
- [x] **T3** Fire the projection from the earn path, after the ledger row commits, under `waitUntil`.
- [x] **T4** Fire it from the redeem path, same shape. Redemption moves the balance too and is the case where an over-limit balance must stop being pushed.
- [x] **T5** Tests that pin the trigger: the sale still answers 201, the projection is not awaited, a failure inside it does not fail the sale, and a balance the pass cannot display is not pushed.
- [x] **T6** `pnpm -r lint && pnpm -r typecheck && pnpm -r test`.

## Acceptance criteria

- Registering points updates the pass without the customer reopening the app.
- The 201 is not delayed by Google.
- A Google failure leaves the ledger correct and the pass converging, not a failed sale.
- No existing test changes meaning. `reconcilePass` keeps its own tests untouched.

## Result

Done in `feat/wallet-reconcile-on-ledger-change`. Both ledger handlers fire the projection after the write commits; the sale never awaits it. `growth` gained a `WALLET` service binding and `schedulePassReconcile`; the wallet exports `reconcileCustomer` beside `scheduled` and delegates to `reconcilePass` without a second readiness gate.

Two things the implementation had to handle that the plan above did not name:

- `c.executionCtx` **throws** in Hono when there is no `ExecutionContext`, rather than returning undefined. Every pre-existing growth test calls `app.fetch(req, env)` with two arguments, so an unguarded read would have turned ~100 tests into failures. The helper catches it and treats a missing context as one more way the projection is unavailable: log, sale proceeds.
- The redeem handler's transaction is **conditional**. With a `reward_id` it also carries the stock decrement, so the projection sits after `await performRedeem()`, which is after the commit on both branches.

Also unverified, and the writer was right to flag it: no browser check. Confirming the balance actually moves in Google needs a real issuer and this deployment is still in `WALLET_DEMO_MODE`.

## Verification

- `pnpm -r lint`
- `pnpm -r typecheck`
- `pnpm -r test`
- Browser: register points on a customer who already holds a pass, then re-read the pass object from the Google API and confirm the balance moved.

## Deferred — recorded, not done

Kept here rather than in a backlog because this is the document for the wallet balance path, and every item below is a defect in the suite that guards it. **A note is only debt if someone reads it**, and this is where anyone working on this path will look.

### D1 — the wallet fakes still return an upper-case state

`workers/wallet/src/{routes,reconcile,jwt,object,reconcile-customer}.test.ts` construct objects with `state: 'ACTIVE'`. Google answers `"active"`. Production no longer depends on the casing, so nothing fails today — but these fakes no longer describe the API they stand in for, and a fake that lies is not testing anything.

The mix is deliberate right now: the fakes that stand for **what Google holds** should be lower case, and the ones that describe **what we send** should stay upper case, because that is what we send. Sorting that out per fake is the work. Deferred by request, 2026-09-30.

### D2 — the balance projection has one test guarding the state comparison

Reverting `reconcile.ts`'s comparison to a literal `!== 'ACTIVE'` fails exactly one test. The fix is verified, but one test is a thin tripwire for a defect that was silent for the life of the feature. What is wanted: a case that pins the whole path from a lower-case remote state to a patch reaching Google, so the failure is an obvious log line rather than a `last_synced_at` tick that reads as healthy.

### D3 — the dashboard surfaces were never built against real endpoints

Not wallet work, recorded here so it is not lost, and both predate the balance work:

- `GET /v1/customers/:id` does not exist. `workers/customer/src/routes.ts` has `/v1/customers`, `/v1/customers/me` and `/v1/customers/by-global-id/:globalId`. The customer detail page calls the first and has never worked.
- `/dashboard/rewards` is linked from `dashboard/page.tsx` and has no route.
- `navigation.contract.test.ts` reads only `lib/navigation.ts`, so a link declared inside a `page.tsx` is invisible to it. The guard has a blind spot, which is the same failure as the original `/dashboard/settings` 404 it was written to prevent.

## Route

Delegated writer: the change spans the growth worker, the wallet worker and both test suites. One writer, one pass, then these gates in the parent.

## Constraints

- Do not add a cron trigger to the wallet: the account has 5/5 cron slots used, and `wrangler-config.contract.test.ts` asserts the config contains no `"triggers"`.
- Do not add a `queues` block to the wallet in this change. Not because a test forbids it — none does — but because the consumer limit is unverified and a consumer is the follow-up, not the prerequisite.
- Growth has no `services` block today; adding one must not disturb its existing queue producer/consumer bindings.
