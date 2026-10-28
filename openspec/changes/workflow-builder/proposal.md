# Proposal: Workflow Builder

> Status: deferred. Documented 2026-10-28; not scheduled. Until it ships, the
> dashboard lists Flujos as "Próximamente" and the page makes no API calls.

## Intent

Let a merchant set up automatic WhatsApp messages ("Flujos") from the
dashboard, with a guided form instead of raw JSON, and have the automation
worker honour every setting the form offers.

## The current behaviour, verified against the code

**The management API does not exist.** The automation worker registers one
route, `GET /health` (`workers/automation/src/routes.ts:21`). The gateway
forwards `/v1/automation/*` to it (`apps/gateway/src/router.ts:40`), so the
dashboard's `GET /v1/automation/workflows`, `POST /v1/automation/workflows` and
`PUT /v1/automation/workflows/{id}/toggle` all end in the worker's own 404.
`apps/gateway/src/wrangler-route-reachability.contract.test.ts:70-79` records
this. `docs/08-API-Design.md` documents a PATCH and a DELETE that do not exist
either.

**The engine runs, against rows nobody can create.** Workflows stored in the
`workflows` table (`packages/db/src/schema.ts:782-792`: `name`,
`trigger_event text`, `conditions jsonb`, `actions jsonb`, `is_active`) are
executed today:

| trigger_event         | Fires on                                   | Extra data for conditions |
| --------------------- | ------------------------------------------ | ------------------------- |
| `customer_registered` | `CustomerRegistered` event                 | none                      |
| `points_milestone`    | every `PointsAssigned` event               | `total_points`            |
| `reward_redeemed`     | `RewardRedeemed` event                     | `reward_name` (optional)  |
| `birthday`            | daily cron, today's month and day          | none                      |
| `inactivity`          | daily cron, `last_visit_at` older than N days | none                   |

Conditions are AND-combined `{ field, operator, value }` with dot paths
(`workers/automation/src/helpers.ts:166-241`), evaluated against `id`,
`global_id`, `phone`, `email`, `full_name`, `birth_date`, `last_visit_at`,
`metadata` and `consent`. Every path also requires `consent.whatsapp === true`,
whatever the conditions say.

**Only one action exists**: `{ type: 'send_whatsapp', config: { template_name,
parameters? } }`. Other types are skipped, silently on four of the five
triggers.

**Defects the form would expose:**

1. The points threshold is read from `workflow.threshold`
   (`workers/automation/src/event-handler.ts:363-364`), a column that does not
   exist, so it is always 0, and a milestone workflow fires on every
   assignment.
2. A milestone fires on every assignment above the threshold instead of once,
   when the balance crosses it.
3. Inactivity days are read from `actions[0].config.inactivity_days`
   (`workers/automation/src/cron-handler.ts:204-215`), default 30, and reach SQL
   through `sql.raw`.
4. `first_redeem` is read from a property that does not exist and only logged
   (`event-handler.ts:502-509`).
5. Template `parameters` are sent as literal strings. A comment suggests
   `{{customer.full_name}}`, but nothing substitutes it, so a placeholder would
   reach the customer verbatim (`event-handler.ts:103-110`).
6. The cron idempotency keys (`-birthday`, `-inactivity`) carry no date, so a
   customer can be greeted on one birthday only, ever
   (`cron-handler.ts:126,262`).
7. Nothing checks that the referenced template exists or is approved.

## Scope

- Workflow CRUD in the automation worker, business-scoped under RLS, with
  validation that accepts only what the engine executes.
- A `config jsonb` column for per-trigger settings (milestone points,
  inactivity days), read by the engine instead of `threshold` and
  `actions[0].config`.
- Engine fixes 1–3 and 5–6 above; 4 is dropped from the engine (no UI offers it).
- A guided form in the dashboard: name, trigger, its setting, an approved
  template, parameters from a fixed list of customer fields, and on/off.

## Out of scope

- Actions other than WhatsApp (push, email, adding points).
- Free-form conditions. The form offers the trigger's own setting only; the
  `conditions` column stays, for workflows created by other means.
- Workflow execution history in the dashboard (`workflow_executions` exists but
  nothing writes it).

## Risks and rollback

- **Security (high risk item 2):** new write routes must be scoped to the
  caller's business through RLS and the gateway's auth headers, as the other
  workers' routes are. Independent verification required.
- **Persisted format (high risk item 1):** adding `config` is additive; rows
  without it keep today's behaviour. The engine change that moves the
  inactivity days and threshold must read the old locations as a fallback for
  one release.
- **Rollback:** the dashboard flag (`comingSoon` in
  `apps/dashboard/src/lib/navigation.ts`) hides the form again; the routes can
  be removed without touching stored workflows.
