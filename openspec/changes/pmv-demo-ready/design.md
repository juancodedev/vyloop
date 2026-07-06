# Design: PMV Demo Ready

## Technical Approach

Seven deliverables closing the demo gap. Backend changes add two read endpoints (`/me` and `/transactions`). Frontend changes replace stubs with real API calls and add a sell-flow modal. A standalone seed script populates demo data. All changes follow existing patterns: Hono routes with `extractAuthHeaders()`, Drizzle ORM queries, `apiFetch()` clients.

## Architecture Decisions

| Decision | Option A | Option B | Choice | Rationale |
|----------|----------|----------|--------|-----------|
| `/me` lookup key | Internal `id` | `globalId` | **globalId** | JWT `sub` = `customer.globalId` (confirmed in identity worker L277). Gateway injects `X-User-Id` = `sub`. |
| `/me` route location | Identity worker | Customer worker | **Customer worker** | Customer profile data lives in customer domain. Gateway already routes `/v1/customers` → customer binding. |
| Transactions endpoint owner | Customer worker | Growth worker | **Growth worker** | `points_transactions` is growth domain. Existing assign/redeem routes are in growth. Follows DDD boundary. |
| Seed script runtime | Worker route | Standalone TS | **Standalone TS** | One-shot operation. No need to expose as API. Run via `npx tsx scripts/seed-demo.ts`. |
| Seed idempotency strategy | TRUNCATE + INSERT | ON CONFLICT DO NOTHING | **ON CONFLICT** | Safer for re-runs. TRUNCATE is destructive. Use slug/phone/name as natural keys for conflict detection. |
| Sell modal points value | Apply earn_rate formula | Pass raw $ amount | **Raw amount** | The `POST /points/assign` endpoint already applies `earnRate × tierMultiplier` server-side. Dashboard sends `points = amount`. |
| History filter approach | Server-side `?type=` | Client-side filter | **Both** | Server supports `?type=earn|redeem` for efficiency. Client tabs filter the already-fetched result set for instant UX. |

## Data Flow

### GET /v1/customers/me

```
Customer Browser → Gateway (JWT validate, inject X-User-Id=globalId, X-Business-Id)
  → Customer Worker
    1. extractAuthHeaders() → { userId: globalId, businessId }
    2. SELECT * FROM customers WHERE global_id = userId AND business_id = businessId
    3. SELECT balance_after FROM points_transactions WHERE customer_id = globalId ORDER BY created_at DESC LIMIT 1
    4. SELECT * FROM membership_tiers WHERE id = customer.currentTierId
    5. SELECT * FROM customer_events WHERE customer_id = customer.id ORDER BY created_at DESC LIMIT 10
    6. Return { ...customer, points: balance, tier: { name, multiplier }, events: [...] }
```

### GET /v1/loyalty/points/transactions

```
Client → Gateway → Growth Worker
  1. extractAuthHeaders() → { businessId }
  2. withRls(db, businessId)
  3. Build WHERE: business_id = businessId [+ customer_id filter] [+ type filter]
  4. SELECT ... ORDER BY created_at DESC LIMIT per_page OFFSET (page-1)*per_page
  5. Return { data: [...], meta: { total, page, per_page } }
```

### Registrar Venta Modal

```
Dashboard → Modal (amount input) → api.assignPoints(customerId, amount, refId)
  → POST /v1/loyalty/points/assign { customer_id, points: amount, reference_id: "sale-{id}-{ts}" }
  → Growth Worker applies earnRate × tierMultiplier → inserts transaction
  → 201 → Modal closes → customer detail refetches
```

### Fix Redeem Payload

```
BEFORE: apiFetch('/v1/loyalty/rewards/redeem', { body: { rewardId } })  ← 400
AFTER:  apiFetch('/v1/loyalty/rewards/redeem', {
  body: { customer_id: globalId, points: reward.pointsCost, reward_id: reward.id,
          reference_id: `redeem-${globalId}-${reward.id}-${Date.now()}` }
})
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `workers/customer/src/routes.ts` | Modify | Add `GET /v1/customers/me` BEFORE `/:id` route (L209). Queries by `globalId`, joins balance + tier + events. |
| `workers/growth/src/routes.ts` | Modify | Add `GET /v1/loyalty/points/transactions` with pagination, `?customer_id=`, `?type=` filters. |
| `scripts/seed-demo.ts` | Create | Standalone seed script. Uses `@vyloop/db` + raw SQL. Accepts `DATABASE_URL` env. |
| `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx` | Modify | Add "Registrar Venta" button + modal component. State: `showModal`, `amount`, `submitting`. |
| `apps/dashboard/src/lib/api.ts` | Modify | Add `assignPoints(customerId, points, referenceId)` method. |
| `apps/customer-web/app/profile/page.tsx` | Modify | Replace placeholder card with `api.getProfile()` data. Show points, tier, total earned. |
| `apps/customer-web/app/profile/history/page.tsx` | Modify | Replace empty `movements` state with `api.getTransactions()` fetch. Wire filter tabs to real data. |
| `apps/customer-web/app/lib/api.ts` | Modify | Fix `redeemReward()` payload. Add `getTransactions(filters?)` method. |

## Interfaces / Contracts

### GET /v1/customers/me — Response

```typescript
{
  id: string;              // internal id
  globalId: string;        // exposed to customer
  fullName: string;
  phone: string;
  email?: string;
  birthDate?: string;
  points: number;          // current balance (from last tx.balance_after)
  totalPointsEarned: number; // SUM of earn-type transactions
  tier: {
    id: string;
    name: string;          // "Bronce" | "Plata" | "Oro"
    multiplier: number;
  } | null;
  events: Array<{          // last 10, newest first
    id: string;
    eventType: string;
    points: number | null;
    createdAt: string;
  }>;
}
```

### GET /v1/loyalty/points/transactions — Response

```typescript
{
  data: Array<{
    id: string;
    customer_id: string;   // globalId
    type: 'earn' | 'redeem';
    points: number;        // absolute value
    balance_after: number;
    reference_id: string;
    note: string | null;
    created_at: string;
  }>;
  meta: { total: number; page: number; per_page: number };
}
```

### Dashboard api.assignPoints()

```typescript
assignPoints(customerId: string, points: number, referenceId: string): Promise<{ data: unknown }>
// POST /v1/loyalty/points/assign { customer_id, points, reference_id }
```

### Customer-web api.getTransactions()

```typescript
getTransactions(filters?: { type?: 'earn' | 'redeem' }): Promise<Transaction[]>
// GET /v1/loyalty/points/transactions?type={type}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Manual | `/me` returns correct profile for seeded customer | curl with customer JWT |
| Manual | Transactions endpoint with filters | curl with admin JWT |
| Manual | Seed script idempotency | Run twice, verify no duplicates |
| Manual | Registrar Venta end-to-end | Dashboard UI → verify points appear |
| Manual | Customer-web profile + history | Login as customer → verify real data |
| Manual | Redeem fix | Customer-web redeem → verify 201 |

## Migration / Rollout

No schema migration required. All changes are additive routes and frontend updates.

**Rollback**: Revert worker deploys (customer + growth) and Pages deploys (dashboard + customer-web). Seed data is removable via `DELETE` on seeded rows.

## Implementation Order

1. **Seed script** — unblocks all other work by providing test data
2. **GET /v1/customers/me** — needed by customer-web profile
3. **GET /v1/loyalty/points/transactions** — needed by customer-web history
4. **Fix redeemReward payload** — quick fix, no dependencies
5. **Registrar Venta modal** + `assignPoints()` — dashboard feature
6. **Customer-web real profile** — depends on `/me`
7. **Customer-web real history** — depends on `/transactions`

## Open Questions

- [ ] **`customer_id` FK mismatch**: `points_transactions.customer_id` has a Drizzle FK to `customers.id`, but the existing `POST /points/assign` inserts `body.customer_id` which is looked up via `customers.globalId`. Verify whether the FK is enforced at DB level or if `customer_id` actually stores `globalId`. This affects how `/me` and `/transactions` query the table.
- [ ] **Seed tenant slug**: Need to agree on a demo tenant slug (e.g., `demo-shop`) for seed data and customer login flow.
