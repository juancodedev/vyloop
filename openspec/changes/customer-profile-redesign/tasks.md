# Tasks: Customer Profile Redesign

Each phase is one PR, stacked to main. Run `pnpm -r test`, `pnpm -r typecheck`
and `pnpm -r lint` before closing a phase.

## Phase 1: Frontend with the current API

- [ ] 1.1 Add date helpers in `apps/customer-web/app/lib/format.ts`: `formatMovementDate` (relative up to 6 days, then "28 sep", year when not current), `formatClp`, `initials`. Unit tests.
- [ ] 1.2 `ProfileTopBar` and `IdentityCard` (avatar, name, member since, tier chip, balance, tier line). Reuse `currentTierName` rules from `member-pass.tsx`. Behavior tests for the identity-card scenarios.
- [ ] 1.3 `PurchaseTimeline` replacing `Activity`, keeping `buildTimeline`. Handles optional `purchaseAmount` (absent today, so titles fall back to note). Behavior tests for the row scenarios.
- [ ] 1.4 `PersonalData` read-only list (omit empty fields, birthday as day and month). No "Editar" yet.
- [ ] 1.5 `QrDock` + `QrSheet` (dialog, focus trap, Esc, wake lock with tolerated refusal, member code from the wallet pass when present). Remove the inline `MemberQr` from the page.
- [ ] 1.6 `WalletCard` compact variant.
- [ ] 1.7 Recompose `app/profile/page.tsx` in the new order with the new skeleton. Update `profile.behavior.test.tsx` and `profile.contract.test.ts`, keeping every data-honesty assertion.
- [ ] 1.8 Styles in `globals.css` using design-system tokens only. Check at 360px and with reduced motion.

## Phase 2: Store the purchase amount

- [ ] 2.1 Migration: `points_transactions.purchase_amount numeric(12,2) NULL` with the positive `CHECK`. Update `schema.ts`, journal, and regenerate the drift baseline.
- [ ] 2.2 Growth earn route writes `amount_pesos` into `purchase_amount` for purchase programs, `NULL` otherwise. Tests for purchase, visit, redeem and idempotent retry.
- [ ] 2.3 Return `purchase_amount` from `GET /v1/loyalty/points/transactions` and `purchaseAmount` in `recent_transactions` of `GET /v1/customers/me`. Update `Transaction` and `RecentTransaction` types in `apps/customer-web/app/lib/api.ts`.

## Phase 3: Next reward

- [ ] 3.1 Customer worker: query active rewards for the tenant alongside the other profile reads; derive `nextReward`, `affordableReward`, `affordableRewardsCount`, `activeRewardsCount` next to `nextTier`. Tests for every customer-crud scenario, including cross-tenant.
- [ ] 3.2 `NextRedemptionCard` with its three states and the closing line in `PurchaseTimeline`. Add the fields to `CustomerProfile` as optional.
- [ ] 3.3 Behavior tests for the redemption-card scenarios, including "fields absent".

## Phase 4: Self-service edit

- [ ] 4.1 Issue `profile:write` in the customer token and enforce it in the gateway for `PATCH /v1/customers/me`.
- [ ] 4.2 `PATCH /v1/customers/me` in the customer worker, reusing the merchant update validation, rejecting `phone` and unknown fields, publishing `customer.profile_updated`. Tests for all scenarios.
- [ ] 4.3 `api.updateProfile` and the edit form in `PersonalData` ("Guardar cambios", toast "Cambios guardados", inline validation).

## Phase 5: Delete account (blocked)

- [ ] 5.1 Decide retention and anonymisation rules (product/legal). Blocks 5.2-5.3.
- [ ] 5.2 `DELETE /v1/customers/me` per that decision, with session revocation.
- [ ] 5.3 "Eliminar mi cuenta" with an in-page confirm step.
