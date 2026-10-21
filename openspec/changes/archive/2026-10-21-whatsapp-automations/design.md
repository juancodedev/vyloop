# Design: WhatsApp + Automations

## Technical Approach

Two new workers following the exact Growth worker pattern (Hono app factory, auth middleware via `extractAuthHeaders`, RLS via `withRls`, queue consumer via `consume()`). Communication worker serves REST + queue consumer + Meta webhook. Automation worker is queue-consumer only. Both share the existing `vyloop-domain-events` queue. No provider abstraction layer — Meta API via `fetch()`.

## Architecture Decisions

### Decision: Event flow design

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Automation publishes directly to Communication | Tight coupling, routing logic duplicated | **Rejected** |
| Automation publishes `WhatsAppOutboundRequested` to same domain queue | Loosely coupled, retry semantics built-in, Growth pattern | **Chosen** |

### Decision: Meta webhook route

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Gateway forwards `POST /v1/communication/webhook/meta` | Requires auth bypass in gateway for Meta callbacks | **Chosen** — gateway already has middleware; add route exception for webhook path or Meta uses query token auth |
| Communication worker handles its own fetch | Simple, Meta sends to worker URL directly | **Rejected** — all external traffic must go through gateway |

### Decision: Inactivity trigger mechanism

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Daily cron scanned by automation worker | Simple, no infra changes | **Chosen** — Cloudflare Workers cron triggers (`* 6 * * *`) query customers with lastVisitAt older than workflow's configured days |
| Event-based on customer_event inactivity | Unreliable — no event fires when user is absent | **Rejected** |

### Decision: Points milestone trigger

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Evaluate on every PointsAssigned | Simpler, catch all thresholds | **Chosen** — evaluate in automation's PointsAssigned handler: check if current balance crosses any threshold defined in workflows table |
| Pre-computed thresholds | Requires external state | **Rejected** |

### Decision: Birthday trigger

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Daily cron queries customers where birthday month/day matches today | Works without cron infra changes | **Chosen** — runs in automation worker as a cron-triggered handler alongside inactivity check |
| Evaluate on every login/visit | Misses customers who don't visit on birthday | **Rejected** |

## Data Flow

```
                    ┌──────────────────────────┐
                    │   Domain Events Queue    │
                    │  (vyloop-domain-events)  │
                    └──────┬───────────┬───────┘
                           │           │
              consumes     │           │  consumes
                    ┌──────┘           └──────┐
                    ▼                         ▼
    ┌───────────────────────┐   ┌──────────────────────┐
    │   automation worker   │   │  communication       │
    │   (queue consumer)    │   │  worker (queue + REST)│
    │                       │   │                      │
    │ Trigger evaluators:   │   │ REST endpoints:      │
    │ • CustomerRegistered  │   │ POST /v1/comm/send   │
    │ • PointsAssigned      │   │ GET /v1/comm/templates│
    │ • Birthday (cron)     │   │ POST /v1/comm/templates│
    │ • Inactivity (cron)   │   │ GET /v1/comm/history  │
    │ • RewardRedeemed      │   │ POST /v1/comm/webhook │
    │                       │   │                      │
    │ Conditions → matches    │   │ Meta API fetch()     │
    │ → publishes            │   │ → message_log insert │
    │ WhatsAppOutboundRqstd │   │                      │
    └──────────┬────────────┘   └──────────────────────┘
               │                        ▲
               │ publishes              │ consumes
               └────────────────────────┘
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `workers/communication/src/index.ts` | Modify | Full Hono app + queue export (Growth pattern) |
| `workers/communication/src/routes.ts` | Create | REST routes: send, templates, history, webhook |
| `workers/communication/src/helpers.ts` | Create | Auth headers, Bindings type, event builders |
| `workers/communication/src/event-handler.ts` | Create | Consumes WhatsAppOutboundRequested, calls Meta API |
| `workers/communication/wrangler.jsonc` | Modify | Add queue consumer/producer, KV_SCHEMA_REGISTRY |
| `workers/communication/package.json` | Modify | Add @vyloop/event-bus, @vyloop/db, @vyloop/schema-registry, hono, drizzle-orm |
| `workers/communication/.dev.vars` | Modify | Add WHATSAPP_PHONE_ID, WHATSAPP_TOKEN |
| `workers/automation/src/index.ts` | Modify | Full Hono app + queue + cron export |
| `workers/automation/src/routes.ts` | Create | Placeholder (worker is queue-only) |
| `workers/automation/src/helpers.ts` | Create | Auth/Bindings types, event builders |
| `workers/automation/src/event-handler.ts` | Create | Dispatcher: CustomerRegistered, PointsAssigned, RewardRedeemed |
| `workers/automation/src/cron-handler.ts` | Create | Birthday + inactivity cron evaluators |
| `workers/automation/wrangler.jsonc` | Modify | Add queue + KV + cron triggers |
| `workers/automation/package.json` | Modify | Add @vyloop/event-bus, @vyloop/db, hono, drizzle-orm |
| `packages/event-bus/src/index.ts` | Modify | Add event constants: WHATSAPP_OUTBOUND_REQUESTED, WORKFLOW_TRIGGERED |
| `packages/schema-registry/src/index.ts` | Modify | Add schemas for new event types |
| `packages/schema-registry/scripts/register-schemas.ts` | Modify | Register new schemas in startup list |
| `packages/db/src/schema.ts` | Modify | Add message_log, whatsapp_templates tables |
| `packages/db/src/index.ts` | Modify | Re-export new tables + types |
| `packages/db/src/rls.ts` | Modify | Add new tables to BUSINESS_ID_TABLES |
| `packages/db/src/indexes.ts` | Modify | Add indexes for message_log, whatsapp_templates |
| `apps/dashboard/src/lib/navigation.ts` | Modify | Add Comunicación section + nav items |
| `apps/gateway/wrangler.jsonc` | Verify | automation + communication bindings already exist |
| `.env.example` | Modify | Add WHATSAPP_PHONE_ID, WHATSAPP_TOKEN, WHATSAPP_API_VERSION |

## Interfaces / Contracts

### New event types (packages/event-bus)
```ts
export const WHATSAPP_OUTBOUND_REQUESTED = 'WhatsAppOutboundRequested';
export const WORKFLOW_TRIGGERED = 'WorkflowTriggered';
```

### WhatsAppOutboundRequested payload shape
```ts
{
  customer_id: string;      // internal uuid
  business_id: string;      // business uuid
  template_name: string;    // registered Meta template
  parameters: Record<string, string>;  // e.g. {"1": "Juan"}
  idempotency_key: string;  // workflow_execution.id for dedup
  phone?: string;           // pre-resolved, or resolve from customers table
}
```

### message_log table columns
- `id` uuid PK, `business_id` uuid FK, `customer_id` uuid FK, `direction` text ('outbound'|'inbound'), `channel` text ('whatsapp'), `status` text ('queued'|'sent'|'delivered'|'read'|'failed'), `provider_message_id` text (Meta wamid.id), `content` jsonb, `metadata` jsonb, `created_at` timestamp

### whatsapp_templates table columns
- `id` uuid PK, `business_id` uuid FK, `name` text, `language` text, `category` text, `body` text, `status` text ('pending'|'approved'|'rejected'), `meta_template_id` text, `created_at` timestamp, `updated_at` timestamp

### Automation conditions jsonb shape (workflows.conditions)
```json
[
  { "field": "consent.whatsapp", "operator": "eq", "value": true },
  { "field": "customer.min_points", "operator": "gte", "value": 100 }
]
```

### Automation actions jsonb shape (workflows.actions)
```json
[
  {
    "type": "send_whatsapp",
    "config": {
      "template_name": "welcome_message",
      "parameters": ["{{customer.full_name}}"]
    }
  }
]
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Route handlers (send, templates, history) | Hono test client, mock DB |
| Unit | Event handlers (all 5 triggers) | Mock queue + DB assertions |
| Unit | Cron handlers (inactivity, birthday) | Mock DB, fixed dates |
| Unit | Conditions matcher | Pure function test (jsonb → boolean) |
| Integration | Queue consumer cycle | Trigger event → verify WhatsAppOutboundRequested published |
| Integration | Meta webhook handler | Verify signature verification, message_log insertion |

## Migration / Rollout

1. Deploy DB schema changes (add `message_log`, `whatsapp_templates`)
2. Deploy event-bus + schema-registry changes (new event types, schemas)
3. Deploy worker package.json dependency updates
4. Deploy communication worker (routes + webhook + consumer)
5. Deploy automation worker (consumers + cron handlers)
6. Add WHATSAPP_* vars to production .dev.vars
7. No data migration required — all new tables are additive

## Open Questions

None. All design decisions resolved.

---

## Design Created

**Change**: whatsapp-automations  
**Location**: `openspec/changes/whatsapp-automations/design.md`

### Summary
- **Approach**: Two Growth-pattern workers sharing domain event queue; automation publishes WhatsAppOutboundRequested → communication consumes and calls Meta API
- **Key Decisions**: 5 decisions documented (event flow, webhook routing, inactivity/birthday/points triggers)
- **Files Affected**: 19 modified, 5 created
- **Testing Strategy**: Unit (routes, handlers, cron, matcher) + Integration (queue cycle, webhook)

### Open Questions
None

### Next Step
Ready for tasks (sdd-tasks).