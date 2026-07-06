# Proposal: Demo-Ready

## Intent

Complete the customer loyalty loop end-to-end (register → login → points → browse catalog → redeem) and prove merchant value with a live analytics dashboard. The product is functional internally but has mock auth, no redemption UI, no analytics, and untested growth engine — blocking sales demos.

## Scope

### In Scope
- **Customer auth**: Phone-based JWT. Identity worker `POST /v1/auth/customer/token` looks up customer by phone, issues JWT with `role: customer`. Reuses existing gateway middleware.
- **Redemption UI**: Customer-web `/profile/rewards` — catalog browsing (`GET /v1/loyalty/rewards?active=true`), redeem flow, confirmation with visual feedback.
- **Dashboard analytics**: Analytics worker with direct DB queries (customers, points, redemption rate, tier distribution). New `/dashboard/analytics` page.
- **Growth worker tests**: Full test suite for all handlers (points assign, redeem, rewards CRUD, tiers CRUD, config CRUD, event handlers) following customer-worker patterns.

### Out of Scope
Real OTP, push notifications, design tokens, dark mode, i18n, e2e tests, API documentation, license.

## Capabilities

### New Capabilities
- `customer-auth`: Phone-based JWT issuance for customer web login
- `customer-redeem`: Reward catalog browsing and redemption flow in customer-web
- `business-analytics`: KPI dashboard for merchants (metrics, redemption rate, tier distribution)

### Modified Capabilities
- `customer-web`: Extends beyond registration — adds auth flow and reward redemption scenarios
- `api-gateway`: New public route exemption for customer auth endpoint; customer JWT validated by existing middleware

## Approach

Four phases by dependency:

| Phase | Deliverable | Depends On |
|-------|-------------|------------|
| 1 | Identity worker: `POST /v1/auth/customer/token`. Customer-web: login with JWT storage | None |
| 2 | Customer-web: `/profile/rewards` — catalog + redeem + confirmation | Phase 1 (auth) |
| 3 | Analytics worker: KPI SQL aggregations. Dashboard: `/dashboard/analytics` page | None |
| 4 | Growth worker: full test suite for all routes + event handlers | None |

Phase 3 and 4 are independent and can parallelize with 1–2.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `workers/identity/src/index.ts` | New | Customer token endpoint |
| `apps/customer-web/` | Major | Auth provider rewrite, new rewards page, new API client |
| `apps/gateway/src/index.ts` | Minor | Public route for customer auth |
| `apps/gateway/src/middleware/auth.ts` | None | Reuses existing JWT validation |
| `workers/analytics/src/index.ts` | New | Full KPI query implementation |
| `apps/dashboard/src/app/dashboard/analytics/` | New | Analytics page + nav item |
| `workers/growth/src/index.test.ts` | Major | Replace scaffold with full test suite |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Auth is gatekeeper for redeem UI | High | Phase 1 delivered first; blocks Phase 2 if delayed |
| Analytics worker built from scratch (placeholder today) | Medium | Direct DB queries — simplest path, low risk |
| Customer globalId vs phone mismatch for JWT sub | Medium | Customer fetch by phone returns globalId; use as sub |

## Rollback Plan

- **Analytics**: Feature flag on dashboard — invisible nav link. Analytics worker routes behind `/v1/analytics/*` — revert to placeholder handler.
- **Auth**: Canary deploy identity worker. Old customers see no change. Rollback by reverting identity worker deploy.
- **Redemption UI**: Customer-web deploy — static asset revert on Cloudflare Pages.

## Dependencies

- Identity worker endpoint → customer-web auth (Phase 1 → 2)
- No external dependencies — all services exist in monorepo

## Success Criteria

- [ ] Customer can log in with phone, receive JWT, and call authenticated endpoints
- [ ] Customer can browse reward catalog, select reward, and see points deducted with confirmation
- [ ] Dashboard shows real KPI data (customer count, total issued/redeemed points, redemption rate, tier distribution)
- [ ] All growth worker handlers have passing tests (>1 assertion each) covering happy path, validation, dedup, and error states
