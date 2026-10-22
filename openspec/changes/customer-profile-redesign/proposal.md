# Proposal: Customer Profile Redesign

> Status: approved design, not scheduled. Proposal accepted 2026-10-22.
> Visual reference: `mockup.html` in this folder (version 3 of the reviewed proposal).
> Delivery: chained PRs, stacked-to-main, one PR per phase in `tasks.md`.

## Intent

Rebuild `/profile` in `apps/customer-web` so a customer sees, in this order:
who they are, how close their next redemption is, what their recent purchases
earned them, and their own data. The QR used at the counter moves out of the
scroll into a fixed button.

The current page answers "how many points do I have" well. It does not answer
"what can I get and how close am I": the customer has to open
`/profile/rewards` to find out. It also shows no personal data, so a customer
cannot check the phone or email the club uses to reach them.

Competitive context: the reference screen reviewed for this change (a
competitor PWA profile) and `docs/analisis.md` both put identity and the next
reward above the fold. This proposal keeps that order and avoids the
reference's defects: English relative dates in a Spanish UI, all-caps labels,
a reward's name used as a point unit, and empty fields rendered as "-".

## Decisions taken in review (2026-10-22)

1. **Points are earned by purchase amount, not by visit.** No stamps or
   punch-card metaphors. Progress is a bar with numbers.
2. **Everything is counted in points** (the program's `pointsCurrency`). A
   reward's name is never used as a unit. The reward card is titled
   "Tu próximo canje" and shows the reward's catalog name.
3. **The identity card shows one figure: the points balance**, as today. No
   visit or purchase counts.
4. **Recent activity is a list of purchases**: amount spent, date, points
   earned, resulting balance. No item detail. It closes with one line about
   how close the next redemption is.

## The current state, verified against the code

- **Page**: `apps/customer-web/app/profile/page.tsx` renders `MemberPass`,
  `MemberQr`, `WalletCard`, `Activity`, two nav buttons, `ConsentList`, and a
  logout button, in that order.
- **Profile endpoint**: `GET /v1/customers/me` in
  `workers/customer/src/routes.ts:414`. It returns `points`, `tiers`,
  `nextTier` (derived server-side at line 615, "the rule has exactly one
  owner"), `customer_events` and `recent_transactions`.
- **Purchase amount is not stored.** `POST` earn in
  `workers/growth/src/routes.ts:884-917` reads `amount_pesos` for
  `earn_by = 'purchase'` programs and derives points from it, but the insert
  into `points_transactions` (same file, around line 1007) writes only
  `type, points, balance_after, reference_id, note`. The table
  (`packages/db/src/schema.ts:455`) has no amount column.
- **Rewards catalog**: `rewards` (`packages/db/src/schema.ts:893`) has
  `points_cost`, `stock`, `valid_from`, `valid_until`, `deleted_at`. The
  customer app reads it through `GET /v1/loyalty/rewards?active=true`.
- **Self-service writes do not exist.** `PATCH /v1/customers/:id` (line 1217)
  and the soft `DELETE /v1/customers/:id` (line 1376) are merchant routes.
  The customer token carries `rewards:read` and `rewards:redeem` only
  (`apps/customer-web/app/lib/api.ts`, `api.login`).
- **Consents**: `ConsentList` is disabled today. The
  `enable-nearby-consent` change makes it interactive. This change reuses it.

## Scope

### In scope

1. New `/profile` layout and components (frontend only, current API).
2. QR bottom sheet opened from a fixed "Mostrar mi código" button.
3. `nextReward` derived server-side in `GET /v1/customers/me`.
4. `purchase_amount` stored on earn, and returned in recent transactions and
   the history endpoint.
5. Customer self-service edit of name, email and birth date
   (`PATCH /v1/customers/me`).

### Out of scope

- **Delete account.** The button is specified but hidden behind a decision:
  retention and anonymisation rules are not defined. Tracked as Phase 5,
  blocked.
- Business logo or brand colour in the top bar.
- Changing the phone number (it is the login identity).
- Visit counts, purchase counts, money-to-next-reward estimates.
- `/profile/history` and `/profile/rewards` redesigns. They only receive the
  new date and unit rules where they share helpers.

## Risks

- **Database migration** (Phase 2): adds a nullable column. Historical rows
  stay `NULL` and the UI falls back to the row's note. No backfill.
- **Contract change** (Phases 2-3): `recent_transactions` and `GET /v1/customers/me`
  gain optional fields. Additive only; existing consumers (dashboard, wallet)
  ignore unknown fields.
- **Self-service write** (Phase 4): a new customer-token scope that can write
  customer data. Needs gateway scope enforcement and tenant scoping by
  `X-User-Id` + `X-Business-Id`, never by a path id.

## Rollback

- Phase 1 is a frontend-only revert of `apps/customer-web/app/profile/**` and
  the new components.
- Phase 2: the column is nullable and unused by older code; rolling back the
  worker leaves it in place harmlessly. Drop it only in a later migration.
- Phases 3-4: remove the fields or route; the UI already renders without them
  (see the `customer-web` delta, "data honesty" scenarios).
