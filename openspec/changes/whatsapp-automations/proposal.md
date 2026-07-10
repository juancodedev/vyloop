# Proposal: WhatsApp + Automations

## Intent

Add configurable WhatsApp messaging and workflow automation to vyloop. Businesses can define IFTTT-style workflows (trigger → conditions → WhatsApp action) and manually send WhatsApp messages, all via Meta WhatsApp Business API. Email is explicitly out of scope.

## Scope

### In Scope
- WhatsApp Business API integration (Meta, official) — message send, template management, incoming webhook
- Configurable workflow engine — business-defined triggers/conditions/actions stored in `workflows` table
- 5 initial automation triggers: welcome (CustomerRegistered), inactivity (N days), birthday, points milestones, first redeem
- Dashboard UI for workflow builder, message log, template management
- Customer-web consent management for WhatsApp opt-in
- Idempotent message dispatch (queue at-least-once safe)

### Out of Scope
- Email or SMS communication
- Third-party WhatsApp providers (Twilio, etc.)
- Pre-built automation template library (v1 is IFTTT-style rule builder)
- WhatsApp broadcast/campaign scheduling

## Capabilities

### New Capabilities
- `communication-whatsapp`: WhatsApp message dispatch, template lifecycle (create/edit/approve), incoming webhook handler, message history query. REST + queue consumer.
- `automation-engine`: Workflow rule evaluator consuming domain events, triggers configurable conditions from `workflows` table, enqueues actions. Queue consumer only — no REST.

### Modified Capabilities
- `event-bus`: New event types — `WhatsAppOutboundRequested`, `WhatsAppSent`, `WhatsAppFailed`, `WorkflowTriggered`, `WorkflowActionCreated`
- `database`: New tables — `message_log` (sent/received messages), `whatsapp_templates` (Meta template registry). Affected files: `schema.ts`, `rls.ts`, `indexes.ts`
- `schema-registry`: Register schemas for all new event types. Update `register-schemas.ts`
- `api-gateway`: Rate limiting tuning for `/v1/communication/*` (Meta API has per-phone-number rate windows). Webhook route needs auth-bypass for Meta callbacks.

## Approach

Two workers following the existing Growth engine pattern:

1. **workers/communication** — Hono REST API + queue consumer. REST for manual send, templates, history, webhooks. Consumes `WhatsAppOutboundRequested` events from the queue, calls Meta Graph API, persists to `message_log`.

2. **workers/automation** — Queue consumer only. Consumes domain events (`CustomerRegistered`, `PointsAssigned`, etc.), evaluates workflow rules from `workflows` table, publishes `WhatsAppOutboundRequested` back to the queue.

No provider abstraction package for v1 — Meta API via `fetch()` directly. Both workers share the same wrangler queue config pattern (producer + consumer on `vyloop-domain-events`).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `workers/communication/` | New | Full worker: REST + queue consumer + webhook |
| `workers/automation/` | New | Queue consumer: workflow evaluator |
| `packages/event-bus/src/` | Modified | New event type exports |
| `packages/schema-registry/` | Modified | New schemas + registration script |
| `packages/db/src/schema.ts` | Modified | `message_log`, `whatsapp_templates` tables |
| `packages/db/src/rls.ts` | Modified | RLS for new tables |
| `apps/dashboard/` | Modified | New pages: workflows, templates, message log |
| `apps/customer-web/` | Modified | Consent management page |
| `apps/gateway/src/router.ts` | Modified | Tune rate limits, bypass auth for webhooks |
| `.env.example` | Modified | WHATSAPP_PHONE_ID, WHATSAPP_TOKEN vars |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Meta business verification delays | High | Start onboarding early, decouple from dev |
| Meta API rate limits (per phone) | Med | Queue-based dispatch with retry; dashboard feedback |
| Duplicate sends from at-least-once | Low | Idempotency key per execution in `message_log` |
| Workflow conditions in jsonb untyped | Med | Runtime validation before evaluation; log failures |

## Rollback Plan

1. Disable queue consumers for both workers (remove `consumers` from wrangler.jsonc).
2. Deactivate workflows via dashboard OR direct DB update (`workflows.is_active = false`).
3. If Meta integration fails: delete credentials, workers become 501 placeholders again.
4. New DB tables (`message_log`, `whatsapp_templates`) are additive — no data loss on rollback.

## Dependencies

- Meta WhatsApp Business Account + permanent access token
- `workers/communication/.dev.vars` needs `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_API_VERSION`

## Success Criteria

- [ ] Business can send a manual WhatsApp message via dashboard
- [ ] Welcome workflow triggers automatically on customer registration
- [ ] Birthday workflow triggers on daily cron, respects opt-in consent
- [ ] Incoming Meta webhooks are persisted to `message_log`
- [ ] All 5 automation triggers function end-to-end
