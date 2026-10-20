# Delta for communication-whatsapp

## MODIFIED Requirements

### Requirement: Send WhatsApp Message

`POST /v1/communication/whatsapp/send` MUST accept `{ customer_id, template_name, parameters, idempotency_key }`. The endpoint MUST validate customer consent — a `consents` row with `consent_type = 'whatsapp'`, `granted = true` and `revoked_at` null — normalize the phone number (E.164), and enqueue a `WhatsAppOutboundRequested` event. A `message_log` record MUST be created with status `queued`. Duplicate `idempotency_key` MUST return `409 DUPLICATE_IDEMPOTENCY_KEY`.

The consent MUST be read from the `consents` table. A jsonb flag on the customer row MUST NOT be consulted, because the table is the authoritative store and a flag has no revocation timestamp.

#### Scenario: Happy send

- GIVEN customer with a granted `whatsapp` consent and valid phone
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
