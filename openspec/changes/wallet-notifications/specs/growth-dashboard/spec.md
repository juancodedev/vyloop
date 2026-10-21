# Delta for growth-dashboard

## ADDED Requirements

### Requirement: Wallet Message Section

The dashboard MUST offer a "Wallet" section under Communication where an operator writes a message (`header`, `body`, optional `link`), sees a preview shaped like a Google Wallet notification, and sends it through `POST /v1/wallet/messages`.

Before sending, the section MUST show the number of eligible passes and state that Google shows at most 3 notifications per pass per 24 hours, and that passes over that budget receive the message on the card without a notification.

The section MUST enforce the `header` and `body` length limits as the operator types, and MUST show the API's refusal codes (`LINK_NOT_ALLOWED`, `WALLET_MESSAGE_LIMIT`) as readable messages.

#### Scenario: An operator sends a message

- GIVEN an operator on the Wallet section
- WHEN they fill header and body and confirm
- THEN the message is sent
- AND the section shows the eligible count returned by the API

#### Scenario: The daily limit is reached

- GIVEN the API answers `429 WALLET_MESSAGE_LIMIT`
- WHEN the operator sends
- THEN the section explains that the business already sent its message for today

### Requirement: Wallet Message History

The Wallet section MUST list the business's sent messages with their `notified`, `silent` and `failed` counts from `GET /v1/wallet/messages`.

#### Scenario: Reviewing a send

- GIVEN a message already delivered
- WHEN the operator opens the Wallet section
- THEN the message is listed with its three counts

### Requirement: Nearby Notification Status

The venues view MUST show, per venue, whether it is included in the passes' nearby notifications, and MUST explain why one is not: no position, inactive, or beyond the 10-venue limit.

#### Scenario: A venue without coordinates

- GIVEN an active venue with no position
- WHEN the operator opens the venues view
- THEN the venue is marked as not included because it has no position
