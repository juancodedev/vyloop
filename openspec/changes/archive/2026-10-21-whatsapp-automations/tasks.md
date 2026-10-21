# Tasks: WhatsApp + Automations

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1400–1800 |
| 800-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Foundation) → PR 2 (Workers) → PR 3 (Dashboard + Gateway) |
| Delivery strategy | ask-always |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Foundation — DB schema, event-bus, schema-registry, shared infra | PR 1 | Base = main. No worker code, only shared packages |
| 2 | Workers — communication + automation + env vars | PR 2 | Base = main (or PR 1 branch if feature-branch). Two workers + Meta integration |
| 3 | Dashboard UI + Gateway routing + Customer-web consent | PR 3 | Base = main (or PR 2 branch). Frontend + gateway wiring |

---

## Phase 1: Foundation — DB Schema, Event Bus, Schema Registry

- [x] 1.1 Add `message_log` table to `packages/db/src/schema.ts` (id, business_id, customer_id, direction, channel, status, provider_message_id, content jsonb, metadata jsonb, created_at)
- [x] 1.2 Add `whatsapp_templates` table to `packages/db/src/schema.ts` (id, business_id, name, language, category, body, status, meta_template_id, created_at, updated_at)
- [x] 1.3 Re-export both new tables from `packages/db/src/index.ts`
- [x] 1.4 Add both tables to `BUSINESS_ID_TABLES` in `packages/db/src/rls.ts`
- [x] 1.5 Add indexes for `message_log` (customer_id, status, created_at) and `whatsapp_templates` (business_id, name) in `packages/db/src/indexes.ts`
- [x] 1.6 Add `WHATSAPP_OUTBOUND_REQUESTED` and `WORKFLOW_TRIGGERED` event constants to `packages/event-bus/src/index.ts`
- [x] 1.7 Add Zod schemas for new event types to `packages/schema-registry/src/index.ts`
- [x] 1.8 Register new schemas in `packages/schema-registry/scripts/register-schemas.ts`
- [x] 1.9 Update `.env.example` with `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_API_VERSION`

## Phase 2: Communication Worker — REST Routes, Queue Consumer, Meta Webhook

- [x] 2.1 Create `workers/communication/src/helpers.ts`: Bindings type, auth middleware setup, event builders, Meta API helpers
- [x] 2.2 Create `workers/communication/src/routes.ts`: `POST /send` (consent check, idempotency, enqueue), `GET /templates`, `POST /templates`, `GET /history` (paginated, filtered)
- [x] 2.3 Create `workers/communication/src/event-handler.ts`: consume `WhatsAppOutboundRequested`, call Meta Graph API, update message_log status, handle 429 retry
- [x] 2.4 Modify `workers/communication/src/index.ts`: wire Hono app with routes + queue consumer + webhook route
- [x] 2.5 Modify `workers/communication/wrangler.jsonc`: add queue consumer/producer + KV bindings
- [x] 2.6 Modify `workers/communication/package.json`: add @vyloop/event-bus, @vyloop/db, @vyloop/schema-registry, hono, drizzle-orm
- [x] 2.7 Create `workers/communication/.dev.vars` with WHATSAPP_* placeholders
- [x] 2.8 Add webhook route `POST /webhook` + `GET /webhook` (Meta verification) to communication worker routes — `POST` persists inbound messages/status callbacks, `GET` handles `hub.challenge`

## Phase 3: Automation Worker — Event Handlers, Cron, Conditions

- [x] 3.1 Create `workers/automation/src/helpers.ts`: Bindings type, event builders, conditions evaluator (jsonb → boolean with eq/neq/gt/gte/lt/lte/exists, AND logic)
- [x] 3.2 Create `workers/automation/src/routes.ts`: placeholder file (worker is queue-only)
- [x] 3.3 Create `workers/automation/src/event-handler.ts`: dispatcher for `CustomerRegistered`, `PointsAssigned` (with threshold check), `RewardRedeemed` (first-redeem check) — evaluate conditions, publish `WhatsAppOutboundRequested` + `WorkflowTriggered`
- [x] 3.4 Create `workers/automation/src/cron-handler.ts`: birthday (daily, match birth_date month/day) + inactivity (daily, last_visit_at < now - N days) cron handlers
- [x] 3.5 Modify `workers/automation/src/index.ts`: wire Hono app with event handler + cron exports
- [x] 3.6 Modify `workers/automation/wrangler.jsonc`: add queue + KV + cron triggers (`0 6 * * *`)
- [x] 3.7 Modify `workers/automation/package.json`: add @vyloop/event-bus, @vyloop/db, hono, drizzle-orm

## Phase 4: Dashboard UI + Gateway + Consent

- [x] 4.1 Add "Comunicación" navigation section to `apps/dashboard/src/lib/navigation.ts` (Templates, Message Log, Workflows)
- [x] 4.2 Create dashboard workflow builder page (list/create/edit workflows, activate/deactivate)
- [x] 4.3 Create dashboard templates page (list, create, delete WhatsApp templates)
- [x] 4.4 Create dashboard message log page (paginated history, status filters, per-customer view)
- [x] 4.5 Create dashboard send message UI (select template, customer, trigger manual dispatch)
- [x] 4.6 Add WhatsApp consent toggle to `apps/customer-web/` (opt-in checkbox/profile page)
- [x] 4.7 Update `apps/gateway/src/index.ts`: bypass auth for webhook path (`/v1/communication/webhook`)

## Phase 5: Testing

- [x] 5.1 Unit tests for `workers/communication/src/routes.ts` — send, templates, history, webhook using Hono test client + mock DB
- [x] 5.2 Unit tests for `workers/communication/src/event-handler.ts` — Meta API success, error, rate-limit, idempotent redelivery
- [x] 5.3 Unit tests for `workers/automation/src/event-handler.ts` — CustomerRegistered trigger, workflow matching, publish verification
- [x] 5.4 Unit tests for `workers/automation/src/cron-handler.ts` — birthday match/no-match, inactivity detection
- [x] 5.5 Unit tests for conditions evaluator (pure function) — all operators, AND/OR groups, nested rules
- [x] 5.6 Integration test: queue consumer cycle — trigger event → handler → Meta API → status update
- [x] 5.7 Integration test: Meta webhook handler — status callbacks, incoming messages, empty payload