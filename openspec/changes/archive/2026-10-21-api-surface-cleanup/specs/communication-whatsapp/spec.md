# Delta for communication-whatsapp

## MODIFIED Requirements

### Requirement: Meta Webhook Handler

The Meta webhook is served by the communication worker at its own hostname on the path `/webhook`, which is the URL configured in Meta; it MUST NOT be routed through the gateway, and the gateway's `/v1/communication/webhook` prefix is a different namespace. The webhook is dormant until the product decision of 2026-10-08 is reversed; when it is enabled, the following MUST hold.

`/webhook` MUST be exempted from the worker's gateway-header extraction by an exact path match on the raw pathname, checked before extraction. No other path SHALL be exempted.

`GET /webhook` MUST handle Meta's verification challenge (`hub.mode`, `hub.verify_token`, `hub.challenge`) and MUST compare the token with `WHATSAPP_VERIFY_TOKEN`, which MUST be provided to the worker as a secret. A missing or empty `WHATSAPP_VERIFY_TOKEN` MUST make verification fail rather than match an empty token.

`POST /webhook` MUST verify Meta's payload signature over the raw request body with the app secret, provided to the worker as a secret, before parsing or persisting anything, and MUST reject a missing or invalid signature with 401. Incoming messages MUST be persisted to message_log with direction `inbound`. Status callbacks MUST update the corresponding message_log status field.

The tests for both handlers MUST send no gateway identity headers.

#### Scenario: Verification

- GIVEN `WHATSAPP_VERIFY_TOKEN` is set
- AND Meta sends `GET /webhook` with the correct `hub.verify_token` and no gateway headers
- WHEN the handler processes the challenge
- THEN it responds 200 with `hub.challenge` as plain text

#### Scenario: Invalid verify token

- GIVEN Meta sends `GET /webhook` with a wrong `hub.verify_token`
- WHEN handler processes challenge
- THEN 403 returned

#### Scenario: Verification with no configured token

- GIVEN `WHATSAPP_VERIFY_TOKEN` is not set
- WHEN a request sends `GET /webhook` with an empty `hub.verify_token`
- THEN the response is 403

#### Scenario: Inbound message

- GIVEN a customer sends a WhatsApp message
- WHEN Meta forwards it as `POST /webhook` with a valid signature and no gateway headers
- THEN a message_log row is created with direction `inbound`

#### Scenario: Unsigned delivery

- GIVEN a `POST /webhook` with no signature or an invalid one
- WHEN the handler receives it
- THEN the response is 401
- AND nothing is written to message_log

#### Scenario: Status callback

- GIVEN a sent message has `provider_message_id`
- WHEN Meta sends a signed status update (sent, delivered, read, failed)
- THEN the matching message_log status is updated
