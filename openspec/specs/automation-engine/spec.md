# Automation Engine Specification

## Purpose

IFTTT-style workflow rule evaluator: consume domain events, evaluate jsonb conditions, dispatch WhatsApp actions via queue. Cron-driven triggers for birthday and inactivity detection.

## Requirements

### Requirement: Workflow CRUD

`GET /v1/automation/workflows`, `POST`, `PUT /v1/automation/workflows/{id}`, `DELETE /v1/automation/workflows/{id}` MUST manage workflows per `business_id`. Each workflow has: `name`, `trigger` (enum), `conditions` (jsonb array), `actions` (jsonb array), `is_active` (bool), `config` (jsonb for tier/point thresholds, inactivity days). A workflow SHALL only be active when all referenced templates exist.

#### Scenario: Create workflow
- GIVEN valid `{ trigger: "CustomerRegistered", conditions: [{ field: "consent.whatsapp", operator: "eq", value: true }], actions: [{ type: "send_whatsapp", config: { template_name: "welcome" } }] }`
- WHEN `POST /v1/automation/workflows`
- THEN workflow created, business-scoped

#### Scenario: Delete workflow
- GIVEN exists an active workflow
- WHEN `DELETE` succeeds
- THEN workflow removed, running evaluations unaffected (no orphan actions)

### Requirement: CustomerRegistered Trigger

The `queue()` handler MUST consume `CustomerRegistered` events. For each active workflow with trigger=`CustomerRegistered`, the handler MUST evaluate `conditions`. When ALL conditions match, the handler MUST publish a `WhatsAppOutboundRequested` event to the queue. A `WorkflowTriggered` event MUST also be published.

#### Scenario: Welcome workflow fires
- GIVEN active "welcome" workflow with `consent.whatsapp eq true`
- WHEN `CustomerRegistered` with `whatsapp_opt_in = true`
- THEN `WhatsAppOutboundRequested` published
- AND `WorkflowTriggered` published

#### Scenario: Customer opted out
- GIVEN same workflow
- WHEN `CustomerRegistered` with `whatsapp_opt_in = false`
- THEN conditions fail
- AND no action dispatched

#### Scenario: No matching workflow
- GIVEN business has no active `CustomerRegistered` workflows
- WHEN `CustomerRegistered` consumed
- THEN no-op

### Requirement: PointsAssigned Trigger

The `queue()` handler MUST consume `PointsAssigned` events. For active workflows with trigger=`PointsAssigned`, conditions are evaluated against the event payload and customer data. The handler MUST also evaluate tier upgrade workflows with `config.threshold_points` — fires when balance crosses a threshold.

#### Scenario: Milestone reached
- GIVEN workflow with threshold_points=500, customer has 600 points
- WHEN `PointsAssigned` with balance=600 consumed
- THEN action dispatched

#### Scenario: Threshold not crossed
- GIVEN same workflow, customer with 200 points
- WHEN `PointsAssigned` with 50 points → balance 250
- THEN no action (below threshold)

### Requirement: RewardRedeemed Trigger

The `queue()` handler MUST consume `RewardRedeemed` events. For active workflows with trigger=`RewardRedeemed`, conditions determine whether to congratulate the customer (e.g., on first-ever redemption).

#### Scenario: First redeem congratulation
- GIVEN workflow with condition `customer.total_redeemed == points_redeemed` (first redeem)
- WHEN `RewardRedeemed` consumed with `points_redeemed` matching total history
- THEN congratulations sent

#### Scenario: Repeat redeem
- GIVEN customer with multiple past redemptions
- WHEN `RewardRedeemed` consumed
- THEN condition fails (not first), no action

### Requirement: Birthday (Cron) Trigger

The cron handler (`* 6 * * *`) MUST query all active workflows with `trigger=birthday`. For each, it MUST query customers whose `birth_date` month and day match today. Each matched customer MUST be evaluated against workflow conditions before dispatch.

#### Scenario: Birthday match
- GIVEN active birthday workflow and 5 customers with birthday today
- WHEN cron fires
- THEN each consenting customer gets a `WhatsAppOutboundRequested`
- AND `WorkflowTriggered` published per match

#### Scenario: No birthdays today
- GIVEN active birthday workflow
- WHEN cron fires and no customer matches
- THEN no-op

### Requirement: Inactivity (Cron) Trigger

The cron handler MUST also process active `inactivity` workflows. For each workflow, the handler MUST query customers whose `last_visit_at` is older than `config.inactivity_days` from today. Each customer MUST be evaluated against conditions.

#### Scenario: Inactivity detected
- GIVEN active inactivity workflow with `inactivity_days=30`
- WHEN cron runs
- THEN customers with `last_visit_at < now() - 30 days` targeted

#### Scenario: Recently active
- GIVEN same workflow
- WHEN customer visited 15 days ago
- THEN customer excluded from alert

### Requirement: Conditions Evaluation

The conditions engine MUST accept a jsonb array of `{ field, operator, value }` objects. Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `exists`. All conditions within a workflow MUST match (AND logic). Conditions MUST be evaluated against a runtime context built from the event payload + customer DB record + consents.

#### Scenario: All conditions match
- GIVEN `[{field:"consent.whatsapp", operator:"eq", value:true}, {field:"tier", operator:"gte", value:2}]`
- WHEN customer has consent and tier_id >= 2
- THEN true

#### Scenario: One condition fails
- GIVEN same conditions
- WHEN customer has consent but tier = 1
- THEN false

#### Scenario: Malformed conditions
- GIVEN `[{field:"", operator:"unknown", value:null}]`
- WHEN evaluator processes
- THEN condition parse error logged
- AND workflow skipped gracefully (no crash)

### Requirement: Action Dispatch

On successful condition match, the engine MUST build and publish a `WhatsAppOutboundRequested` event with: `customer_id`, `business_id`, `template_name` (from action config), `parameters` (with template variable substitutions from context), and `idempotency_key` (generated as `{workflow_id}-{customer_id}-{timestamp_slot}`).

#### Scenario: Template variables substituted
- GIVEN action config `{ template_name: "welcome", parameters: ["{{customer.full_name}}"] }`
- WHEN dispatch runs
- THEN `parameters` contains resolved `full_name` value

#### Scenario: Missing template
- GIVEN action references `template_name: "nonexistent"`
- WHEN dispatch runs
- THEN error logged, action NOT dispatched

### Requirement: Opt-In Consent Filtering

Every automation dispatch path MUST verify `consents.whatsapp_opt_in = true` before publishing a `WhatsAppOutboundRequested` event. This condition MUST be implicitly applied in addition to any explicit workflow conditions.

#### Scenario: Consent filter
- GIVEN customer matches all workflow conditions
- WHEN `whatsapp_opt_in = false`
- THEN no action dispatched
- AND `WorkflowTriggered` with `skipped=true` reason logged

### Requirement: RLS Scoping

All workflow queries MUST use `app.current_business_id` for RLS isolation. Cron handlers (birthday, inactivity) MUST scope queries to workflows of the business only.

#### Scenario: Cross-business isolation
- GIVEN workflows for business A and B
- WHEN business A's cron runs
- THEN only business A's customers queried