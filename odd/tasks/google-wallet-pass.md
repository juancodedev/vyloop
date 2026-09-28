# Google Wallet — loyalty pass for the customer web

## Objective

Issue a Google Wallet loyalty pass per customer, so a vyloop member can carry their balance in the one wallet already on their phone. One Google issuer for vyloop; one pass class per tenant.

**The commercial destination is selling.** Everything below is scoped to that, not to a demo.

## The model, and the decision behind it

`vyloop` is a **single Google issuer**. Each tenant is one `LoyaltyClass`; each customer is one `LoyaltyObject`.

- `classId` = `<issuerId>.tenant-<tenantId>`
- `objectId` = `<issuerId>.member-<customerGlobalId>`

## External prerequisites — not code, and on the critical path

Verified against the Google Wallet docs (last updated 2026-09-01):

1. **Issuer account** in the Google Pay & Wallet console: a Google account with the Admin role, a public business name, and agreement to the Google Wallet API Additional Terms + privacy policy.
2. **A Business Profile** is a prerequisite for publishing access — a payments profile identifying the business.
3. **A Google Cloud project** with the Google Wallet REST API enabled.
4. **A service account** with a JSON key. Its email must be invited to the Issuer account at the `Developer` access level.
5. **At least one Passes Class must exist** before publishing access can even be requested.
6. **Publishing access is ONE approval for the whole issuer** — the Google Wallet team reviews the Issuer account, not each class. This is what makes the single-issuer model viable.
7. **Every account starts in Demo Mode.** Passes only reach Admin/Developer/test accounts until publishing access is granted. The `[TEST ONLY]` prefix is removed on approval.

**Until step 6 lands, passes are test-account-only.** No code in this feature changes that, and the UI must not imply otherwise.

## The operational cost of one class per tenant, stated plainly

`reviewStatus` is a per-class field, and a `LoyaltyObject` requires its class to "already exist, and **must be approved**". A `draft` class cannot create objects, and review state cannot go back to `draft`.

So **each tenant needs its own Google class review.** Consequences:

- A newly onboarded tenant's customers have no working pass until that tenant's class is approved.
- Mitigation adopted here: **create the class during tenant onboarding, not on first redemption**, so the review overlaps with merchant setup. The growth worker's redeem path must never be what creates a class.
- A class that is `draft` or `underReview` must produce an honest, non-broken customer state — not a "Add to Google Wallet" button that fails.

## Data model

Two additions. Both are tracking state only; the balance and program data stay where they are (`customers.points`, `loyalty_programs`, `membership_tiers`) so there is one source of truth.

`tenant_wallet_programs`
- `tenantId` → `tenants.id` (PK, and the sole key)
- `issuerId` — the Google-issued issuer id. Same for every tenant, stored per row so a migration to a different issuer is a data change, not a code change
- `classId` — the full `<issuerId>.tenant-<tenantId>`
- `reviewStatus` — `none` | `draft` | `under_review` | `approved` | `rejected`
- `lastSyncedAt`, `createdAt`, `updatedAt`

`customer_wallet_passes`
- `customerId` → `customers.id` (PK)
- `tenantId` → `tenants.id`, indexed
- `objectId` — the full `<issuerId>.member-<globalId>`
- `state` — `not_issued` | `issued` | `inactive` | `expired` | `completed`
- `lastSyncedAt`, `createdAt`, `updatedAt`

`customers.memberCode` (additive column on the existing table)
- `text`, nullable, so existing customers are unaffected by the migration
- unique index on `(business_id, member_code)` — tenant-scoped, and partial so the many NULLs of existing rows do not collide
- 6 Crockford Base32 characters

`objectId` derives from `customers.globalId` deliberately, not `customers.id`: the pass id must be stable across environments and across a database restore.

## ID derivation rules

- The class suffix comes from the **tenant UUID**, not the slug. `tenants.slug` is `text` with a unique index and **no format validation anywhere in the repo**, so a merchant can set a slug containing spaces or accents. Google requires a class identifier made only of alphanumerics, `.`, `_` and `-`. Deriving from the UUID makes the id valid by construction and stable under a slug rename.
- The object suffix comes from `customers.globalId`, a `uuid` with `defaultRandom()`.
- Both ids are lowercased and passed through a defensive sanitiser anyway. A function that cannot emit an invalid id is worth more than a validation someone might forget to call.

## Payload constraints that are easy to get wrong

- `loyaltyPoints.balance` is a **string**, recommended maximum **7 characters** so it is not truncated on small screens. Render **without thousands separators**: `96942` is 5 characters, and the format stays valid to 9,999,999. A balance beyond that needs `secondaryLoyaltyPoints` or a custom layout; document the limit rather than silently truncating.
- `issuerName` and `programName` may be ellipsised after **20 characters**. Merchant names longer than that will be cut; the class stores the real name and the display is Google's call.
- `accountId` recommended maximum 20 characters — vyloop's `globalId` is a 36-character UUID and **does not fit**. Resolved: see "Member code" below.

## Member code

`accountId` carries a **short, non-correlational member code**. Six characters, Crockford Base32, uppercase.

Grounding: the POS resolves customers **only** by `globalId`, scanned from the barcode (`getCustomerByGlobalId` → `/v1/customers/by-global-id/:globalId`). So `accountId` is never machine-read in this system. The barcode therefore keeps the full `globalId` — **no POS contract changes** — and `accountId` exists solely to be read aloud by a person at a counter, which is what a loyalty pass is for.

**Non-correlational is a privacy requirement, not a style choice.** A per-tenant sequential code would leak a merchant's customer count to any competitor who saw a customer's pass. The code must therefore carry no ordering information.

**Crockford Base32** specifically: it excludes `I`, `L`, `O` and `U` and folds `1→I`, `0→O`, which is what makes a code dictatable over a noisy counter.

**Stored, not derived.** Storing it decouples the code from the derivation algorithm, so the algorithm can change later without invalidating codes customers have already memorised, and it leaves room for a merchant-chosen code later. A unique index on `(tenant_id, code)` enforces tenant-scoped uniqueness at the database level rather than in application logic.

**Tenant-salted.** The same person must get a different code at two different merchants, or those two merchants can correlate the customer. Derivation is salted per tenant.
- A class change **propagates immediately** to every object referencing it. Merchant logo and program name updates are therefore cheap — one class patch — which is the main operational payoff of one class per tenant.

## Tasks

- [ ] **T1** — DB migration adding the two tables, their indexes, and `customers.memberCode` with a partial unique index.
- [ ] **T2** — `id.ts`: `classIdFor`, `objectIdFor`, and a sanitiser. Property-style tests: every output matches Google's allowed character set; distinct tenants and customers never collide; stable across calls.
- [ ] **T2b** — `member-code.ts`: Crockford Base32 generation, tenant-salted, collision-checked. Tests: length 6, uppercase, never contains `I L O U`, two customers in the same tenant differ, the same customer in two tenants differs, and codes carry no ordering information.
- [ ] **T3** — `class.ts`: build a `LoyaltyClass` from a tenant + program. `programName`, `issuerName`, `reviewStatus`, `countryCode`.
- [ ] **T4** — `object.ts`: build a `LoyaltyObject` from a customer + tier + balance. `state`, `accountName`, `accountId` (the member code), `loyaltyPoints`, and a `barcode` carrying the full `globalId`.
- [ ] **T5** — `jwt.ts`: sign the save-to-wallet JWT with the service account key. Tested against a locally generated RSA key, never a real credential.
- [ ] **T6** — Balance formatting: no separators, and a documented ceiling beyond which the display must change strategy.
- [ ] **T7** — A Google Wallet REST client behind an interface, so the builders and signer are testable without network.
- [ ] **T8** — Tests: every constraint above has a test that fails when the constraint is violated.
- [ ] **T9** — Customer-facing surface: **out of scope for the first unit.** No "Add to Google Wallet" button ships until publishing access is granted and a class is approved. A button that fails is worse than no button.

## Constraints

1. **No real Google credentials in the repo, in tests, or in any commit.** Tests generate their own RSA key. Secrets arrive as worker secrets.
2. **No network call in a unit test.** Everything behind an interface.
3. **Never invent program data.** The class and object carry only what a real row contains. No placeholder merchant name, no fake logo URL, no default balance.
4. **The backend owns the balance.** The pass reflects `customers.points`; it never computes one.
5. **One source of truth for the balance.** The pass is a projection, not a second ledger.
6. **Do not touch the customer web yet.** T9 is explicitly deferred, and Stage 7's delivery gate forbids a wallet CTA until the capability is real.

## ## Verification

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter @vyloop/wallet lint
pnpm --filter @vyloop/wallet typecheck
pnpm --filter @vyloop/wallet test
pnpm -r test
```

## Progress

Not started. `accountId` (T4) is the one open decision.
