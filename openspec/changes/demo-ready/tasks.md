# Tasks: Demo-Ready

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~710 (additions + deletions) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Phase 1 → Phase 2 (sequential); Phase 3, Phase 4 (parallel, anytime) |
| Delivery strategy | ask-on-risk |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Lines | Notes |
|------|------|-----------|-------|-------|
| 1 | Customer auth (8 files) | PR #1 | ~230 | Ships identity endpoint + gateway exemption + customer-web auth stack + login/register + delete mocks. Base: main |
| 2 | Redemption UI (2 files) | PR #2 | ~130 | Catalog + confirm pages. Needs PR #1 merged (depends on auth). Base: main |
| 3 | Analytics dashboard (4 files) | PR #3 | ~150 | Analytics worker rewrite + dashboard page + nav. Fully parallel. Base: main |
| 4 | Growth worker tests (1 file) | PR #4 | ~200 | Full test suite. Fully parallel. Base: main |

PR #3 and PR #4 can be created and reviewed in any order, independently of PR #1–#2.

## Phase 1: Customer Auth

- [x] 1.1 `workers/identity/src/index.ts` — Add `POST /v1/auth/customer/token`: phone → `issueToken()` with `role: customer`
- [x] 1.2 `apps/gateway/src/index.ts` — Add `/v1/auth/customer/token` to public route exemptions (already covered by `/v1/auth/` wildcard prefix — no change needed)
- [x] 1.3 `apps/customer-web/app/lib/api.ts` — Create `apiFetch()` helper with Bearer token from localStorage
- [x] 1.4 `apps/customer-web/app/lib/auth.tsx` — Rewrite from mock to JWT-based provider (login calls API, stores `vyloop_jwt`, logout clears)
- [x] 1.5 `apps/customer-web/app/login/page.tsx` — Replace mock login with real `POST /v1/auth/customer/token` call
- [x] 1.6 `apps/customer-web/app/register/page.tsx` — Auto-login after `PUT /v1/customers`, store JWT, redirect to profile
- [x] 1.7 `apps/customer-web/app/page.tsx` — Auth-aware redirect: JWT present → `/profile`, else landing (already had the redirect logic — auth provider now restores JWT from localStorage on mount)
- [x] 1.8 `apps/customer-web/app/lib/mock-data.ts` — Delete file (all data sourced from API now)

## Phase 2: Redemption UI

- [x] 2.1 `apps/customer-web/app/profile/rewards/page.tsx` — Create: fetch `GET /v1/loyalty/rewards?active=true`, render catalog cards with redeem button
- [x] 2.2 `apps/customer-web/app/profile/rewards/confirm/page.tsx` — Create: call `POST /v1/loyalty/rewards/redeem`, show success/error/info states

## Phase 3: Analytics Dashboard

- [ ] 3.1 `workers/analytics/src/index.ts` — Rewrite placeholder to Hono app with `GET /v1/analytics/kpis` using Drizzle raw SQL
- [ ] 3.2 `apps/dashboard/src/lib/api.ts` — Add `getKpis(): Promise<KpiResponse>` method
- [ ] 3.3 `apps/dashboard/src/app/dashboard/analytics/page.tsx` — Create responsive KPI card layout (4-col → 2-col → stacked)
- [ ] 3.4 `apps/dashboard/src/app/dashboard/layout.tsx` — Add Analytics nav item to sidebar

## Phase 4: Growth Worker Tests

- [ ] 4.1 `workers/growth/src/index.test.ts` — Full rewrite: `describe` blocks per handler covering happy path, validation, dedup, and error states
