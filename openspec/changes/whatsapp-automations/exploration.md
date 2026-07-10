## Exploration: WhatsApp + Automations

### Current State
The vyloop platform already has two scaffolded-but-empty workers for Communication and Automation, plus the full event bus / queue consumer pattern used by the Growth engine. The database schema already includes `workflows` and `workflow_executions` tables. The gateway already routes `/v1/communication` and `/v1/automation` prefixes to the respective service bindings. However, both workers are placeholders (return JSON service status only), the dashboard has no Communication or Automation pages, and there's no WhatsApp provider integration anywhere.

### Existing Infrastructure

**Event Bus & Queue:**
- Single shared queue `vyloop-domain-events` used by ALL workers
- 6 event types: CustomerRegistered, PointsAssigned, RewardRedeemed, RewardAutoGranted, ProfileViewed, QRDisplayed
- Queue configuration: max_batch_size=5, max_concurrency=1 — processes 1 message at a time
- Event envelope: CloudEvents-inspired with header (business_id, timestamp, localization) + payload
- Schema validation via KV-backed schema registry (AJV)

**Queue Consumer Pattern (Growth Engine):**
- Growth worker imports `consume()` from `@vyloop/event-bus`
- Consumes from `vyloop-domain-events` in wrangler.jsonc
- Also PRODUCES to the same queue (publishes PointsAssigned, RewardAutoGranted, RewardRedeemed)
- `handleEvent()` switch-based dispatcher → per-event handlers
- Growth wrangler has both `consumers` and `producers` sections for the same queue
- Customer worker is producer-only; Growth is consumer+producer

**Customer Data Available:**
- `customers` table: phone, email, fullName, birthDate, language, optedInAt, lastVisitAt, globalId, metadata
- Unique constraints: (business_id, phone) and (business_id, email)
- Phone normalization: whitespace stripped at registration
- `consents` table: consentType (e.g. 'whatsapp', 'email'), granted, grantedAt, revokedAt
- `customer_events` table: event history per customer
- Customers have points balance via points_transactions (balance_after running ledger)

**Schema Registry:**
- 3 registered schemas: CustomerRegistered (payload-only), PointsAssigned (envelope), RewardRedeemed (envelope)
- RewardAutoGranted schema defined but NOT registered in register-schemas.ts
- KV-backed, compiled/validated via AJV
- Customer worker validates BEFORE publishing

**Existing Workers:**
1. `identity` — auth, users, businesses
2. `customer` — customer CRUD, registration, profile
3. `growth` — loyalty program config, tiers, points assign/redeem, rewards
4. `analytics` — KPIs, timeline
5. `communication` — **PLACEHOLDER** (returns JSON service status)
6. `automation` — **PLACEHOLDER** (returns JSON service status)
7. `compliance` — compliance domain

**Dashboard (Next.js):**
- Pages: Inicio, Clientes, Analytics, Loyalty (config/tiers/rewards/pos/customers), QR, Settings
- No Communication/Automation pages exist
- API client uses `NEXT_PUBLIC_API_URL` → gateway (localhost:8787)
- Gateway routes: `/v1/communication` → communication worker, `/v1/automation` → automation worker

**Customer-web (Next.js):**
- Pages: register, login, profile, confirm
- No communication preferences page

**Database Schema (existing automation tables):**
- `workflows` table: id, business_id, name, trigger_event, conditions (jsonb), actions (jsonb), is_active
- `workflow_executions` table: id, business_id, workflow_id, customer_id, status, error, executed_at
- Works with existing RLS policies (business_id column present)

**Env/Config:**
- `.env.example` only has DATABASE_URL, JWT_SECRET, MAILPIT — no WhatsApp/Twilio config
- Both communication/.dev.vars and automation/.dev.vars have DATABASE_URL + JWT_SECRET
- No Resend, Twilio, or any communication provider configured anywhere

### Affected Areas
- `workers/communication/` — currently placeholder; must be built into a real worker
- `workers/automation/` — currently placeholder; must be built into a real worker
- `packages/event-bus/src/index.ts` — may need new event types (e.g., WhatsAppSent, WorkflowTriggered)
- `packages/schema-registry/src/index.ts` — needs new event schemas
- `packages/schema-registry/scripts/register-schemas.ts` — needs new schemas registered
- `packages/db/src/schema.ts` — may need communication-related tables (e.g., message_log)
- `packages/db/src/index.ts` — re-exports
- `packages/db/src/indexes.ts` — new indexes
- `packages/db/src/rls.ts` — RLS for new tables
- `workers/growth/src/event-handler.ts` — pattern to replicate for automation event handlers
- `workers/growth/src/helpers.ts` — Bindings pattern to replicate
- `workers/growth/wrangler.jsonc` — queue config pattern to replicate
- `workers/customer/src/routes.ts` — CustomerRegistered publishes event (automation trigger)
- `apps/gateway/src/router.ts` — already has routes, but may need adjustments
- `apps/dashboard/src/lib/navigation.ts` — needs new nav items
- `apps/dashboard/src/app/dashboard/` — needs new settings page for WhatsApp/automation config
- `apps/customer-web/app/` — may need opt-in/consent management
- `.env.example` — needs WHATSAPP_API_KEY, WHATSAPP_PHONE_ID env vars documented

### Approaches

1. **Single Communication Worker (follows existing pattern)** — Build `workers/communication` as a Hono app that provides REST endpoints (send message, get status) AND queue consumer. Uses Queue-based dispatching for automated messages. Replicates Growth queue consumer pattern exactly.
   - Pros: Follows established architecture; gateway already routes; queue pattern proven
   - Cons: Communication and Automation are distinct domains — coupling them would violate DDD
   - Effort: Medium

2. **WhatsApp Provider Abstraction Layer** — Create a `packages/communication` package that provides a provider abstraction (Twilio, Meta WhatsApp API, etc.) so the worker doesn't hardcode providers. Different businesses might use different providers.
   - Pros: Clean abstraction; testable; replaceable
   - Cons: More upfront design; likely over-engineered for v1 (Meta API is the standard)
   - Effort: Medium

3. **Automation Engine as Queue Consumer + Rule Evaluator** — `workers/automation` consumes from `vyloop-domain-events`, evaluates workflow rules (conditions stored in `workflows` table), and enqueues outbound messages to the domain-events queue for the communication worker to pick up and deliver.
   - Pros: Clean separation; Automation = pure business logic + orchestration, Communication = delivery layer
   - Cons: Two hops through the event bus adds latency for fully automated flows
   - Effort: Medium

### Recommendation
Build the communication and automation capabilities as two separate workers, following the existing Growth engine queue consumer pattern precisely:

1. **workers/communication** — Hono REST API + queue consumer. REST endpoints: send manual WhatsApp messages, manage templates, get message history. Queue consumer handles automated outbound messages dispatched by the automation worker.
2. **workers/automation** — Queue consumer ONLY (no REST API). Consumer listens to `vyloop-domain-events`, evaluates workflow rules from the `workflows` table, and triggers actions (which enqueue WhatsApp messages back to the domain events queue for the communication worker).
3. Shared `packages/communication` package if provider abstraction is needed later.

### Communication Architecture Suggestions
- **New worker approach**: Use existing `workers/communication` scaffold. Add queue consumer (producer+consumer pattern like Growth).
- **Queue topology**: Reuse `vyloop-domain-events`. Automation consumes events, evaluates workflows, publishes new "SendWhatsAppMessage" events. Communication consumes those and handles the WhatsApp API call.
- **WhatsApp provider**: Meta Cloud API (direct HTTP to graph.facebook.com). No SDK needed — simple fetch(). Provider abstraction as `packages/communication` package later.
- **Provider abstraction**: Optional for v1. Meta API is industry-standard. Abstract behind `sendMessage(provider, to, content)`.
- **Webhook handling**: Communication worker needs a public endpoint for WhatsApp incoming messages/webhooks. Meta sends webhooks to a configured URL. This is a REST route, not queue-based.

### Risks
- Meta WhatsApp API requires business verification, phone number ID, permanent access token, and webhook setup — external dependency with significant setup overhead
- WhatsApp business messaging has strict policies: opt-in required, template messages for first contact, 24-hour free-form window
- `workers/communication/.dev.vars` already has DATABASE_URL + JWT_SECRET but NO WhatsApp credentials
- Automation engine must handle deleted/blocked customers gracefully
- Workflow conditions in jsonb (untyped) could produce runtime evaluation errors
- Queue at-least-once delivery could cause duplicate WhatsApp sends — idempotency needed

### Ready for Proposal
Yes