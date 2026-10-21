# Proposal: Branch Reward Trigger

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Intent

Tell a customer, by push, that a reward they earned can be redeemed at a
specific venue of the business.

This is the `RewardAvailableAtBranch` trigger listed in
`docs/19-Geolocalizacion-Notificaciones.md` §7.4 (line 304) and in the F3 phase
(line 398). It was deliberately left out of the proximity work
(`odd/tasks/proximidad-y-hardening.md`, Log L1, "Desviaciones", item 1) because
it needs a vertical the proximity gate does not cover: rewards have no venue.

## Why it is deferred

The PMV already tells a business's customers about a venue through campaigns
(`PushCampaignRequested`), and a customer already sees their rewards in the
customer web. This trigger adds a second, automatic message on top of that, and
it raises product questions (below) that are not needed to demonstrate the PMV.

## The current state, verified against the code

- **Rewards have no venue.** `rewards` (`packages/db/src/schema.ts:853-879`)
  carries the business, cost, stock, `auto_grant_threshold` and validity, and
  no branch.
- **The auto-grant path exists.** `handlePointsAssigned`
  (`workers/growth/src/event-handler.ts:196`) re-reads the balance, selects the
  rewards whose `auto_grant_threshold` is reached (lines 299-309), inserts a
  `reward_grants` row (lines 330-339) and publishes `RewardAutoGranted` to
  `DOMAIN_EVENTS_QUEUE` (line 355) through `buildRewardAutoGrantedEvent`
  (`workers/growth/src/helpers.ts:480`).
- **The growth worker can already publish deliveries.** It holds a
  `DELIVERY_QUEUE` producer binding (`workers/growth/wrangler.jsonc`), and the
  check-in route publishes `CustomerCheckedIn` there
  (`workers/growth/src/routes.ts:1838-1850`).
- **The delivery path exists.** The communication worker consumes
  `vyloop-notification-deliveries`, dispatches by `event.type`
  (`workers/communication/src/event-handler.ts:21-41`), and
  `deliverPushNotification` (`workers/communication/src/push-delivery.ts:130`)
  re-checks the `nearby_notifications` consent and delivers to every
  registered browser, deduplicating by `reference_id`.

## Scope

### In Scope

1. A `reward_branches` table: the venues at which a reward can be redeemed.
   A reward with no rows is redeemable everywhere (today's behaviour).
2. The reward API in the growth worker accepts and returns `branch_ids` on
   create, update and read.
3. The `RewardAvailableAtBranch` event constant and its JSON schema, registered
   at startup with the others.
4. A producer in the auto-grant path: when a reward that is scoped to one or
   more venues is granted, publish `RewardAvailableAtBranch` to the delivery
   queue.
5. A consumer in the communication worker that turns the event into a push
   delivery through `deliverPushNotification`, with a reference derived from
   the grant so a redelivered event never notifies twice.
6. The dashboard reward form lets the business choose the venues.

### Out of Scope

- **Redemption restricted to the venue.** Whether `POST /v1/loyalty/rewards/redeem`
  must refuse a redemption at another venue is a separate rule (open question
  Q4). This change only notifies.
- **Notifying when a reward is published to the catalog** (a broadcast to a
  venue's audience). That is a campaign, and the campaign path already exists.
- **WhatsApp or email.** Push only, through the existing transport.
- **Fixing the auto-grant race** (check-then-insert on `reward_grants`,
  `event-handler.ts:311-335`). Noted; the delivery reference prevents a double
  push even if the grant race produced two grants of the same reward.

## Open Product Questions

These MUST be answered before the change is scheduled. The specs below encode
the recommended answer and mark it as an assumption.

| #  | Question                                                                                               | Recommendation (assumption)                                                                                   |
| -- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Q1 | Who receives it: only the customer the reward was granted to, or every customer of the venue's audience? | Only the granted customer. A broadcast is a campaign.                                                         |
| Q2 | Is the `nearby_notifications` consent the right one, or does this need its own consent type?           | Reuse `nearby_notifications`: the message is about a venue. Revisit if legal review says otherwise.           |
| Q3 | Frequency cap: how many reward notifications per customer per day?                                     | At most one per customer per 24 h per business; further grants in the window are not notified.               |
| Q4 | Must redemption be refused at a venue the reward is not scoped to?                                      | Not in this change.                                                                                           |
| Q5 | With several venues, which one does the message name?                                                   | The venue the customer interacted with most recently within `INTERACTION_WINDOW_DAYS` (180); otherwise the first by name; the message links to the reward, not to one venue. |
| Q6 | Quiet hours (no pushes at night in the business's timezone)?                                            | Not in this change; applies to every push and belongs to the transport.                                       |

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `growth-engine`: rewards can be scoped to venues; the auto-grant publishes
  `RewardAvailableAtBranch` for a scoped reward.
- `push-notifications` (canonical in `openspec/specs/push-notifications/spec.md`
  since `push-transport` was archived on 2026-10-20): the delivery of
  `RewardAvailableAtBranch`.
- `event-bus`: the `RewardAvailableAtBranch` event type.
- `schema-registry`: its schema.
- `database`: the `reward_branches` table.

## Approach

**A join table, not a column.** A business with three venues will scope a
reward to two of them; a nullable `rewards.branch_id` would force a choice of
one, and changing it later is a data migration. `reward_branches(reward_id,
branch_id, business_id)` with a primary key on `(reward_id, branch_id)` keeps
"no rows" meaning "every venue", so every existing reward keeps its meaning
without a backfill.

**The event travels on the delivery queue.** It is produced by growth and
consumed by communication. The domain events queue's single consumer is growth
itself; the delivery queue is the one communication consumes, and growth
already publishes `CustomerCheckedIn` there. The event is published after the
`reward_grants` insert, exactly where `RewardAutoGranted` is published today,
and only when the reward has at least one `reward_branches` row.

**The payload names the customer by global id.** `deliverPushNotification`
resolves the customer by `(global_id, business_id)`; the grant path holds the
internal id (`customer.id`), so the producer reads `customers.global_id`
alongside, as the check-in producer does.

**The delivery reuses the push path entirely.** The handler calls
`deliverPushNotification` with `reference_id = reward-grant:<reward_grants.id>`.
The consent is re-checked there; a customer without a browser or without the
consent is acked silently, as today. The frequency cap (Q3) is read from
`message_log`: a `sent` push row for this customer whose reference begins with
`reward-grant:` in the last 24 h skips the delivery.

```mermaid
sequenceDiagram
    participant G as growth (handlePointsAssigned)
    participant DB as Postgres
    participant DQ as Delivery queue
    participant C as communication
    participant PS as Push service

    G->>DB: INSERT reward_grants
    G->>DB: SELECT branch_id FROM reward_branches WHERE reward_id
    alt reward is scoped to venues
        G->>DQ: RewardAvailableAtBranch {customer global id, reward, grant, branches}
        DQ->>C: event
        C->>DB: frequency cap (message_log, last 24 h)
        C->>C: deliverPushNotification(reference reward-grant:<grant id>)
        C->>DB: consent + subscriptions
        C->>PS: encrypted push
    else not scoped
        G-->>G: nothing more (RewardAutoGranted only)
    end
```

**The message text** is built in the communication worker from the payload
(reward name and venue name), in Spanish, with a URL to the customer web's
rewards view. No points balance and no customer data travel in the push body.

## Risks

- **Product risk is the main risk.** An automatic message a customer did not
  expect is the fastest way to lose a push permission. Q1-Q3 exist for that.
- **A new table read in a hot path.** `handlePointsAssigned` runs on every
  points assignment; the extra read happens only after a grant, which is rare.
- **Schema registration drift.** A new schema must be added to
  `packages/schema-registry/scripts/register-schemas.ts` and to its test mocks,
  or the deploy registers a set that does not include it.

## Rollback Plan

1. Revert the growth deploy: the producer stops; nothing else depends on it.
2. Revert the communication deploy: an event already queued falls into the
   `default` branch of `handleEvent`, which logs and acks it.
3. `reward_branches` can stay: an empty or ignored table changes no existing
   behaviour. Dropping it loses only the venue scoping the businesses entered.
