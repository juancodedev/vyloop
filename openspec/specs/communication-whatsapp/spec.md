# Communication — WhatsApp Specification

## Purpose

WhatsApp message dispatch via Meta Business API: manual send, template management, incoming webhook handler, message history with status tracking. Queue consumer for automated dispatch from automation engine.

## Requirements

### Requirement: Send WhatsApp Message

`POST /v1/communication/whatsapp/send` MUST accept `{ customer_id, template_name, parameters, idempotency_key }`. The endpoint MUST validate customer consent — a `consents` row with `consent_type = 'whatsapp'`, `granted = true` and `revoked_at` null — normalize the phone number (E.164), and enqueue a `WhatsAppOutboundRequested` event. A message_log record MUST be created with status `queued`. Duplicate `idempotency_key` MUST return `409 DUPLICATE_IDEMPOTENCY_KEY`.

The consent MUST be read from the `consents` table. A jsonb flag on the customer row MUST NOT be consulted, because the table is the authoritative store and a flag has no revocation timestamp.

#### Scenario: Happy send

- GIVEN customer with `whatsapp_opt_in = true` and valid phone
- WHEN `POST /v1/communication/whatsapp/send`
- THEN status 202, message_log queued, event published

#### Scenario: Missing consent

- GIVEN customer with no `whatsapp` consent, or one that was revoked
- WHEN same request
- THEN `403 CONSENT_REQUIRED`

#### Scenario: A revoked consent is not a granted one

- GIVEN a customer whose `whatsapp` consent has `granted = false` and `revoked_at` set
- WHEN same request
- THEN `403 CONSENT_REQUIRED`

#### Scenario: Duplicate idempotency key

- GIVEN existing message_log with same `idempotency_key`
- WHEN same request
- THEN `409 DUPLICATE_IDEMPOTENCY_KEY`

#### Scenario: Invalid phone

- GIVEN customer with no phone or unparseable number
- WHEN same request
- THEN `422 INVALID_PHONE`

### Requirement: Meta Webhook Handler

`POST /v1/communication/whatsapp/webhook` MUST accept Meta's standard webhook callbacks. `GET` on the same path MUST handle Meta's verification challenge (`hub.mode`, `hub.verify_token`, `hub.challenge`). Incoming messages MUST be persisted to message_log with direction `inbound`. Status callbacks MUST update the corresponding message_log status field.

#### Scenario: Verification

- GIVEN Meta sends `GET` with correct `hub.verify_token`
- WHEN handler processes challenge
- THEN responds with `hub.challenge` as plain text

#### Scenario: Inbound message

- GIVEN a customer sends a WhatsApp message
- WHEN Meta forwards it as `POST` webhook
- THEN message_log created with direction `inbound`

#### Scenario: Status callback

- GIVEN a sent message has `provider_message_id`
- WHEN Meta sends a status update (sent, delivered, read, failed)
- THEN matching message_log status updated

#### Scenario: Invalid verify token

- GIVEN Meta sends `GET` with wrong `hub.verify_token`
- WHEN handler processes challenge
- THEN 403 returned

### Requirement: Template Management

`GET /v1/communication/whatsapp/templates` MUST list templates per business. `POST /v1/communication/whatsapp/templates` MUST create a local template record and optionally sync to Meta. `DELETE /v1/communication/whatsapp/templates/{id}` MUST soft-delete.

#### Scenario: List templates

- GIVEN 3 templates for a business
- WHEN `GET` called
- THEN all 3 returned, scoped by business_id

#### Scenario: Create template

- GIVEN valid `{ name, language, category, body }`
- WHEN `POST` called
- THEN record created, optionally published to Meta

#### Scenario: Delete template

- GIVEN an existing template
- WHEN `DELETE` succeeds
- THEN template hidden from list, row persisted

### Requirement: Message History

`GET /v1/communication/whatsapp/history` MUST return paginated message_log entries. Supports filters: `?customer_id=`, `?status=`, `?direction=`, `?from_date=`, `?to_date=`. Default sort by `created_at DESC`.

#### Scenario: Filter by customer

- GIVEN 10 messages for customer A and 5 for customer B
- WHEN `GET /v1/communication/whatsapp/history?customer_id={A}`
- THEN only 10 messages for A returned

#### Scenario: Filter by status

- GIVEN 3 failed and 7 successful messages
- WHEN `GET /v1/communication/whatsapp/history?status=failed`
- THEN 3 failed messages returned

### Requirement: Queue Consumer Dispatch

The communication queue consumer MUST consume `WhatsAppOutboundRequested` events. On receipt, it MUST call Meta's Graph API (`/{api-version}/{phone-id}/messages`), update message_log status to `sent` on success (storing `provider_message_id`), or `failed` on error (storing error details in `metadata`). Idempotency is guaranteed by message_log status check before dispatch.

#### Scenario: Successful dispatch

- GIVEN a `WhatsAppOutboundRequested` event
- WHEN Meta API returns 200 with message ID
- THEN message_log updated to `sent` with `provider_message_id`

#### Scenario: Meta API error

- GIVEN a `WhatsAppOutboundRequested` event
- WHEN Meta API returns 400+ with error
- THEN message_log updated to `failed`, error details in metadata

#### Scenario: Rate limited

- GIVEN Meta API returns 429 with retry-after
- WHEN consumer processes
- THEN message remains `queued`, consumer retries per queue policy

#### Scenario: Idempotent re-delivery

- GIVEN a message_log already in `sent` status
- WHEN same event delivered again (at-least-once)
- THEN consumer skips dispatch (no-op)

### Requirement: Status Tracking

Message status MUST follow the lifecycle: `queued` → `sent` → `delivered` → `read` OR `failed` at any point. Status transitions MUST be recorded in `message_log.metadata.status_history` as an array of `{ status, timestamp }`.

#### Scenario: Full lifecycle

- GIVEN a message is queued
- WHEN Meta sends status callbacks for sent, delivered, read
- THEN message_log status progresses through each state
- AND `metadata.status_history` contains all transitions

### Requirement: RLS Scoping

All `message_log` and `whatsapp_templates` tables MUST enable RLS via `business_id`. The `app.current_business_id` session variable MUST filter all queries.

#### Scenario: Business isolation

- GIVEN messages for business A and B
- WHEN business A queries history
- THEN only business A messages returned

## Error States

The body is always `{ "error": { "code": "…", "message": "…" } }`, the shape
`api-gateway` defines. The `request_id` the gateway adds is present on the
responses the gateway itself produces.

| Code                      | Scenario                      | HTTP Status                            |
| ------------------------- | ----------------------------- | -------------------------------------- |
| CONSENT_REQUIRED          | Customer opted out            | 403                                    |
| DUPLICATE_IDEMPOTENCY_KEY | Retry of known send           | 409                                    |
| INVALID_PHONE             | No phone or E.164 fail        | 422                                    |
| TEMPLATE_NOT_FOUND        | Unknown template_name         | 404                                    |
| META_API_ERROR            | Meta Graph API failure        | 502 (queue) — stored in metadata.error |
| VERIFICATION_FAILED       | Webhook verify_token mismatch | 403 — plain text                       |
