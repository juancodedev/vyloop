# Design: Demo-Ready

## Technical Approach

Four parallel-safe phases: (1) customer JWT auth in identity worker + login in customer-web, (2) reward catalog + redeem UI, (3) analytics KPI queries + dashboard page, (4) growth worker test suite. Each phase delivers independently deployable value. Auth is the gatekeeper for redemption UI — Phase 1 before Phase 2.

## Architecture Decisions

| # | Decision | Choice | Alternatives | Rationale |
|---|----------|--------|--------------|-----------|
| 1 | Customer JWT issuance | Reuse `issueToken()` from `workers/identity/src/auth.ts` | New customer-specific auth module | Same HS256, same `jose` lib, same issuer — gateway validates both. Phone lookup → `customer.globalId` as `sub`. No need to duplicate auth logic |
| 2 | OTP-ready pattern | `{phone, otp?}` in request body; skip OTP check when absent | Two separate endpoints, query param flag | Backward-compatible. Demo bypasses OTP; real OTP plugs in as middleware or pre-step without contract change |
| 3 | Customer-web API client | New `app/lib/api.ts` (like dashboard's pattern) | `useSWR`, direct fetch in components | Follows existing dashboard pattern — single `apiFetch()` helper with Bearer token from localStorage, typed responses |
| 4 | Auth provider | Replace `useAuth()` mock with JWT-based provider | Keep mock + overlay | Spec requires real auth. Provider reads JWT from localStorage, exposes `login()` that calls customer-auth endpoint, `logout()` that clears token. Redirect guard on `/profile/*` |
| 5 | Analytics KPI queries | Direct Drizzle SQL via raw `db.execute()` | Precomputed materialized views, external BI tool | Drizzle raw SQL = same pattern as growth worker's points/balance queries. PMV: no cache layer needed. All KPIs are simple aggregate queries on existing tables |
| 6 | Growth test suite | vitest + mock `@vyloop/db` (same as identity tests) | Separate test DB, contract tests | Follows existing pattern (`identity/src/index.test.ts`). Mock `createDb()` returns controlled data per handler. Tests per route file |

## Data Flow

```
Phase 1 - Auth Flow:
┌──────────────┐   POST /v1/auth/customer/token   ┌──────────────────┐
│ customer-web ├───────────────────────────────────→│ identity worker  │
│ login page   │←──── {token, customer} ────────────│ phone→globalId   │
└──────┬───────┘                                    │ issueToken()    │
       │ store JWT in localStorage                  └──────────────────┘
       ▼
┌──────────────┐   Bearer + X-Business-Id          ┌──────────────────┐
│ customer-web ├───────────────────────────────────→│ gateway          │
│ profile/*    │←──── forwarded to service ────────→│ jwt→headers      │
└──────────────┘                                    └──────────────────┘

Phase 2 - Redeem Flow:
customer-web → GET /v1/loyalty/rewards?active=true → growth worker → DB → catalog cards
customer-web → POST /v1/loyalty/rewards/redeem → growth worker → atomic tx → event → confirmation

Phase 3 - Analytics Flow:
dashboard → GET /v1/analytics/kpis (admin JWT) → analytics worker → Drizzle aggregates → JSON
```

## File Changes

| Phase | File | Action | Description |
|-------|------|--------|-------------|
| 1 | `workers/identity/src/index.ts` | Modify | Add `POST /v1/auth/customer/token` — phone lookup → JWT |
| 1 | `apps/gateway/src/index.ts` | Modify | Add `/v1/auth/customer/token` to public route exemptions |
| 1 | `apps/customer-web/app/lib/auth.tsx` | Rewrite | Mock → JWT-based. `login()` calls API, stores token in `vyloop_jwt` |
| 1 | `apps/customer-web/app/lib/api.ts` | Create | `apiFetch()` helper with Bearer token injection |
| 1 | `apps/customer-web/app/page.tsx` | Modify | Auth-aware redirect (already wired, JWT check now real) |
| 1 | `apps/customer-web/app/login/page.tsx` | Modify | Replace `useAuth().login()` mock with real API call |
| 1 | `apps/customer-web/app/register/page.tsx` | Modify | After PUT /v1/customers → fetch JWT → store → redirect |
| 2 | `apps/customer-web/app/profile/rewards/page.tsx` | Create | Catalog page: fetch rewards, card list, redeem button |
| 2 | `apps/customer-web/app/profile/rewards/confirm/page.tsx` | Create | Confirmation modal/page with success/error feedback |
| 2 | `apps/customer-web/app/lib/mock-data.ts` | Delete | No longer needed — all data comes from API |
| 3 | `workers/analytics/src/index.ts` | Rewrite | Placeholder → Hono app with `GET /v1/analytics/kpis` |
| 3 | `apps/dashboard/src/app/dashboard/analytics/page.tsx` | Create | KPI card layout page |
| 3 | `apps/dashboard/src/app/dashboard/layout.tsx` | Modify | Add Analytics nav item |
| 3 | `apps/dashboard/src/lib/api.ts` | Modify | Add `getKpis()` method |
| 4 | `workers/growth/src/index.test.ts` | Rewrite | Full test file: per-handler describe blocks |

## Interfaces / Contracts

```typescript
// Customer JWT payload (extends existing JwtClaims)
interface CustomerJwtClaims extends JWTPayload {
  sub: string;           // customer.globalId
  business_id: string;
  role: 'customer';
  scopes: ['rewards:read', 'rewards:redeem'];
}

// POST /v1/auth/customer/token
interface CustomerTokenRequest {
  phone: string;
  otp?: string;      // future: OTP verification
}
interface CustomerTokenResponse {
  token: string;
  customer: { name: string; globalId: string };
  expiresIn: number;
}

// GET /v1/analytics/kpis → response
interface KpiResponse {
  totalCustomers: number;
  activeCustomers: number;
  totalPointsIssued: number;
  totalPointsRedeemed: number;
  redemptionRate: number;          // redeemed / issued
  tierDistribution: Record<string, number>;  // {bronze: N, silver: N, ...}
  rewardsClaimed: number;
}
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | JWT lifecycle (customer claims) | Same pattern as identity `index.test.ts`: mock DB, test token issuance/validation for `role: customer` |
| Unit | Growth handlers | vitest + mock `@vyloop/db`. One `describe` per handler: happy path, validation errors, duplicates, edge cases |
| Integration | Auth → gateway → identity | Hono app.fetch() test with real middleware chain, mock JWT_SECRET |
| Integration | Analytics KPI query | Drizzle raw SQL against mock DB, verify aggregate shape |

## Migration / Rollout

- **Phase 1**: Canary identity worker deploy → customer-web deploy (Pages static revert)
- **Phase 2**: Static asset deploy (customer-web). No backend changes — growth worker already has GET/POST redeem
- **Phase 3**: Analytics worker behind `/v1/analytics/*` routing. Dashboard nav item flagged — invisible until analytics worker responds 200
- **Phase 4**: Tests only — no rollout concern
- **No DB migrations needed**: all queries operate on existing tables

## Open Questions

- [ ] None — all decisions resolved by codebase patterns and specs
