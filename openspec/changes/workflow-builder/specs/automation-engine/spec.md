# Delta for automation-engine

## MODIFIED Requirements

### Requirement: Workflow CRUD

The automation worker MUST serve, under `/v1/automation/workflows`:

- `GET /` — the caller's workflows, newest first, as `{ data: Workflow[] }`.
- `POST /` — create a workflow; responds `201` with the created row.
- `PATCH /{id}` — change any of `name`, `config`, `actions`, `is_active`.
- `DELETE /{id}` — delete it; responds `204`.

Every route MUST be scoped to the `X-Business-Id` the gateway injects and MUST
run under RLS for that business. A workflow of another business MUST respond
`404`, never `403`, so ids cannot be probed.

A request MUST be rejected with `400 VALIDATION_ERROR` and a field-level message
when:

- `name` is empty or longer than 80 characters;
- `trigger_event` is not one of `customer_registered`, `points_milestone`,
  `reward_redeemed`, `birthday`, `inactivity`;
- `points_milestone` has no `config.points`, or it is not an integer ≥ 1;
- `inactivity` has no `config.inactivity_days`, or it is not an integer between
  7 and 365;
- `actions` is not exactly one `send_whatsapp` action;
- `config.template_name` does not name a template of the same business whose
  status is approved;
- a parameter is not one of the supported customer fields.

#### Scenario: Create a birthday workflow

- GIVEN an approved template `cumpleanos` for business B
- WHEN B sends `POST /v1/automation/workflows` with `{ name: "Saludo de cumpleaños", trigger_event: "birthday", actions: [{ type: "send_whatsapp", config: { template_name: "cumpleanos", parameters: ["first_name"] } }] }`
- THEN it responds `201`
- AND the workflow is stored for B with `is_active` true

#### Scenario: Another business's workflow is invisible

- GIVEN a workflow W of business A
- WHEN business B sends `PATCH /v1/automation/workflows/{W}`
- THEN it responds `404`
- AND W is unchanged

#### Scenario: An unapproved template is refused

- GIVEN a template `promo` of business B with status `pending`
- WHEN B creates a workflow that sends `promo`
- THEN it responds `400 VALIDATION_ERROR` naming `template_name`

#### Scenario: An action the engine cannot run is refused

- WHEN a workflow is created with an action of type `send_email`
- THEN it responds `400 VALIDATION_ERROR` naming `actions`

## ADDED Requirements

### Requirement: Per-Trigger Settings

A workflow MUST keep its trigger's setting in a `config jsonb` column:
`{ points }` for `points_milestone` and `{ inactivity_days }` for `inactivity`.
The engine MUST read them from there. For one release it MUST fall back to
`actions[0].config.inactivity_days` for rows without `config`, and MUST treat a
`points_milestone` row without `config.points` as inactive rather than as a
threshold of 0.

The inactivity days MUST reach SQL as a bound parameter, never through
`sql.raw`.

#### Scenario: The milestone fires once, when crossed

- GIVEN a `points_milestone` workflow with `config.points` 500
- AND a customer with 450 points
- WHEN a `PointsAssigned` event takes the balance to 520
- THEN one WhatsApp is requested
- WHEN another `PointsAssigned` event takes it to 600
- THEN no WhatsApp is requested

#### Scenario: Inactivity uses the configured days

- GIVEN an `inactivity` workflow with `config.inactivity_days` 45
- AND a customer whose last visit was 40 days ago
- WHEN the daily cron runs
- THEN the customer is not messaged

### Requirement: Template Parameters From Customer Fields

`parameters` MUST be a list of field keys from a fixed set: `first_name`,
`full_name`, `points`, `tier`, `business_name`. The engine MUST replace each
key with the customer's value at send time. Any other value MUST be refused
at creation; it MUST NOT be sent to the customer as literal text.

#### Scenario: The name is filled in

- GIVEN a workflow whose parameters are `["first_name"]`
- AND a customer named "Ana Rojas"
- WHEN the workflow fires
- THEN the template's `{{1}}` is sent as `Ana`

### Requirement: One Greeting Per Occasion

The idempotency key of a cron-driven send MUST include its occasion:
the year for `birthday`, and the date of the last visit for `inactivity`. A
customer MUST be greeted on each birthday, and nudged again only after a new
visit followed by another inactive period.

#### Scenario: A second birthday is greeted

- GIVEN a customer greeted by a birthday workflow last year
- WHEN the cron runs on this year's birthday
- THEN one WhatsApp is requested
