# Proposal: PMV Demo Ready

## Intent

Close last demo gaps: admin sell flow, customer real data view, seed data, fix broken redeem.

## Scope

### In Scope
- **GET /v1/customers/me**: customer profile + points balance + tier + last 10 events
- **Seed data**: 3 tiers (Bronce/Plata/Oro), 3-5 rewards, 3 test customers, ~5 historical tx
- **Registrar Venta modal**: admin enters $ → calls `POST /v1/loyalty/points/assign`
- **Customer-web profile**: real points/tier/earned from API (not placeholder)
- **Customer-web history**: real transactions filtered by earn/redeem
- **Fix redeemReward**: `{ rewardId }` → `{ customer_id, points, reward_id, reference_id }`

### Out of Scope
QR redeem, push, i18n, e2e, real OTP, analytics, growth tests.

## Capabilities

### New
- `customer-self-service`: customer-facing profile + history from real API
- `seed-data`: demo seeding script

### Modified
- `growth-dashboard`: add Registrar Venta modal
- `customer-web`: profile/history move from placeholder to real; redeem payload fixed
- `customer-crud`: add GET /v1/customers/me route

## Approach

| # | Deliverable | Key detail |
|---|-------------|------------|
| 1 | `/me` endpoint | New route in customer worker. Reads `globalId` from `X-User-Id` (injected by gateway from customer JWT). Computes balance from `points_transactions`. Joined with tier. |
| 2 | Seed script | Standalone script. Inserts tiers → rewards → customers → sample tx against Neon branch. |
| 3 | Registrar Venta | React modal on dashboard customer detail. Input amount $ → sends points=amount to `/v1/loyalty/points/assign`. `reference_id = sale-{id}-{ts}`. |
| 4 | Real profile | Replace placeholder card with `api.getProfile()`. Show points, tier, total earned. |
| 5 | Real history | Fetch `GET /v1/loyalty/points/transactions`. Show earn/redeem movements with filter tabs. |
| 6 | Fix redeem | `customer_id` from JWT (globalId), `points` from reward.pointsCost, `reference_id = redeem-{id}-{rewardId}-{ts}`. |

## Affected Areas

| Area | Impact |
|------|--------|
| `workers/customer/src/routes.ts` | Add `/me` route |
| `workers/growth/src/routes.ts` | Add `GET /v1/loyalty/points/transactions` |
| `scripts/seed-demo.ts` | New seed script |
| `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx` | Add sell modal |
| `apps/dashboard/src/lib/api.ts` | Add `assignPoints()` |
| `apps/customer-web/app/profile/page.tsx` | Real API data |
| `apps/customer-web/app/profile/history/page.tsx` | Real transactions |
| `apps/customer-web/app/lib/api.ts` | Fix redeem payload |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `/me` route conflicts with `/:id` in Hono | Low | Register `/me` before `/:id` |
| Seed script runs on prod branch | Low | Document branch param; use Neon ephemeral branch |
| No points/transactions endpoint | Medium | Add as `GET /v1/loyalty/points/transactions` in growth worker |

## Rollback

- **Backend**: revert customer/growth worker deploy
- **Frontend**: revert Pages deploy (static assets)
- **Seed data**: truncate demo rows via DB console

## Dependencies

- Customer JWT auth (shipped in `demo-ready`)
- `POST /v1/loyalty/points/assign` already exists in growth worker

## Success Criteria

- [ ] `/me` returns full profile with points, tier, events
- [ ] Admin enters $500 sale, sees points assigned in history
- [ ] Customer-web profile shows real points balance
- [ ] Customer-web history shows real earn/redeem transactions
- [ ] Redeem sends correct payload and returns 201
- [ ] Seed creates 3 customers, 3 tiers, 3-5 rewards, 5 transactions
