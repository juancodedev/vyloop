# Design: Growth Engine

## Technical Approach

Single Cloudflare Worker (`workers/growth`) with dual capability: **Hono HTTP router** (for `/v1/loyalty/*` endpoints, mirroring `workers/customer` pattern) and **native `queue()` handler** (consuming `DOMAIN_EVENTS_QUEUE` for wallet init and tier evaluation). Points mutations use atomic SQL (`balance_after = balance_after + delta`) inside transactions with `referenceId` UNIQUE constraint for idempotency. FIFO per customer via Wrangler queue consumer concurrency keyed on `customer_id`.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| Queue Consumer Pattern | Function-based inside `index.ts` calling `consume()` + `event-handler.ts` dispatcher | Separate Worker | Same Worker avoids extra deployment + latency; `consume()` from `@vyloop/event-bus` provides ack/retry |
| Points Balance Update | `UPDATE SET balance_after = balance_after + N` (atomic SQL) within `INSERT` transaction | Read-balance-then-write | Eliminates race from concurrent events; balance is a computed column, not read-modify-write |
| FIFO Per Customer | Wrangler `max_concurrency: 1` per consumer key using `customer_id` from event payload | Dedicated per-customer queue | Native Wrangler feature — no infra overhead; proven pattern in Cloudflare docs |
| Partial Redeem | Consume available balance, return `fulfilled: N, partial: true` in response | Reject the whole redeem | Spec requirement; customer gets value even with insufficient balance |
| No-Downgrade | Tier eval: find highest tier where `min_points <= balance`, skip if same tier | Always evaluate down | Written decision; downgrade never occurs |

## Data Flow

```
HTTP path:
  Client → Gateway (router) → Growth Worker fetch()
    → Hono router → route handler → DB (Neon) → DOMAIN_EVENTS_QUEUE (new events)

Event consumer path:
  DOMAIN_EVENTS_QUEUE → Growth Worker queue() → consume()
    → event-handler.ts dispatcher
      → CustomerRegistered: upsert wallet, assign Bronze tier
      → PointsAssigned: re-read balance, evaluate tier upgrade
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `workers/growth/src/index.ts` | Modify | Replace placeholder with Hono app + `queue()` export |
| `workers/growth/src/routes.ts` | Create | Points assign/redeem, tier CRUD, program config endpoints |
| `workers/growth/src/helpers.ts` | Create | Auth extraction, event builders, RLS, Bindings type |
| `workers/growth/src/event-handler.ts` | Create | Queue consumer dispatcher (CustomerRegistered → wallet, PointsAssigned → tier eval) |
| `workers/growth/wrangler.jsonc` | Modify | Add QUEUE consumer/producer bindings, DATABASE_URL, SCHEMA_REGISTRY KV |
| `workers/growth/package.json` | Modify | Add hono, @vyloop/db, @vyloop/event-bus, @vyloop/schema-registry |
| `workers/growth/src/index.test.ts` | Modify | Rewrite tests for Hono routes + queue handler |
| `packages/event-bus/src/index.ts` | Modify | Export `POINTS_ASSIGNED`, `REWARD_REDEEMED` constants |
| `packages/schema-registry/src/index.ts` | Modify | Export `pointsAssignedSchema`, `rewardRedeemedSchema` |
| `packages/schema-registry/scripts/register-schemas.ts` | Modify | Register new envelope schemas |
| `packages/db/src/schema.ts` | Modify | Add `currentTierId` to `customers`, add UNIQUE `(customerId, referenceId)` on `pointsTransactions` |
| `packages/db/drizzle/` | Modify | New migration for `current_tier_id` + `uq_points_tx_reference` |
| `apps/dashboard/src/app/layout.tsx` | Modify | Add sidebar nav with "Loyalty" section (after Customers, before Analytics) |
| `apps/dashboard/src/app/loyalty/config/page.tsx` | Create | Program config view (earn rate, program name) |
| `apps/dashboard/src/app/loyalty/tiers/page.tsx` | Create | Tier management view (CRUD, sorted by display_order) |
| `apps/dashboard/src/app/loyalty/customers/page.tsx` | Create | Customer points list (paginated, searchable) |

## Worker Bindings / Env Type

```typescript
// workers/growth/src/helpers.ts
export interface Bindings {
  DATABASE_URL: string;
  DOMAIN_EVENTS_QUEUE: Queue;      // producer — publish PointsAssigned, RewardRedeemed
  SCHEMA_REGISTRY: KVNamespace;
}
```

Wrangler consumer config — FIFO per customer:

```jsonc
"queues": {
  "consumers": [{
    "queue": "vyloop-domain-events",
    "max_batch_size": 5,
    "max_batch_timeout": 5,
    "max_concurrency": 1
  }],
  "producers": [{
    "binding": "DOMAIN_EVENTS_QUEUE",
    "queue": "vyloop-domain-events"
  }]
}
```

`max_concurrency: 1` at the consumer level ensures sequential batch processing. Per-message keying on `customer_id` is handled within the handler by processing one message per customer at a time (the queue delivers batches of 5, but the handler processes them sequentially per key).

## Points Transaction `referenceId` UNIQUE Constraint

Current `pointsTransactions` has no unique constraint on `referenceId`. Add:

```typescript
// In schema.ts, pointsTransactions table definition
(table) => [
  unique('uq_points_tx_reference').on(table.customerId, table.referenceId),
]
```

This prevents double-credit at the DB level regardless of application logic.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `helpers.ts` — auth extraction, event builders | Vitest, no DB/queue needed |
| Unit | `event-handler.ts` — wallet init, tier eval logic | Mock DB, verify SQL calls |
| Integration | HTTP routes — points assign, redeem, tier CRUD | Miniflare + test DB (Neon serverless) + mock queue |
| Integration | Queue consumer — `CustomerRegistered` → wallet init | Miniflare with `env.queue.sendMessage` |
| Integration | Duplicate `referenceId` → 409 | Miniflare, send same reference twice |
| Unit | Points formula: `balance += points * earnRate * tierMultiplier` | Pure function tests |

## Migration / Rollout

1. **DB first**: Apply `current_tier_id` + `uq_points_tx_reference` migration before deploying worker
2. **Deploy growth worker**: New Hono routes + queue consumer become active
3. **Register schemas**: Run `register-schemas.ts` to push PointsAssigned/RewardRedeemed schemas to KV
4. **No data backfill needed**: Wallet init is idempotent (upsert). First `CustomerRegistered` event processed post-deploy creates wallets. Pre-existing customers get wallets on their next event.

## Open Questions

- [ ] Should the `queue()` handler publish `PointsAssigned` back to the queue after an HTTP assign, or should the HTTP handler publish it directly? (Spec says HTTP endpoint publishes it)
- [ ] Dashboard: is the sidebar nav a simple `<nav>` or should it match an existing shared layout component? (Current layout is a scaffold — no sidebar exists yet)
