# Delta for growth-dashboard

## ADDED Requirements

### Requirement: Venue Management

The dashboard MUST offer a "Venues" section under Settings where an operator lists, registers, edits and deactivates the business's venues through the existing identity routes: `GET` and `POST /v1/businesses/:id/branches`, `PATCH` and `DELETE /v1/businesses/:id/branches/:branchId`.

The venue form MUST carry `name`, `address`, `city`, `country`, `timezone` and a position. The operator MUST be able to set the position by placing a pin on a map, and MAY set it by searching an address. _(Assumption, Q6: address search needs a geocoding provider, which is not chosen yet; the pin works without one.)_

The form MUST send `latitude` and `longitude` together, or neither to clear the position. It MUST show the identity worker's refusal codes (`BRANCH_LOCATION_INCOMPLETE`, `BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`) as readable messages.

The list MUST show, per venue, whether it has a position.

#### Scenario: An operator registers a venue with a pin

- GIVEN an operator on the Venues section
- WHEN they fill the form, place the pin and save
- THEN the venue is created with that `latitude` and `longitude`
- AND the list shows it as located

#### Scenario: An operator clears a position

- GIVEN a located venue
- WHEN the operator removes the pin and saves
- THEN the venue is updated with neither coordinate
- AND the list shows it as not located

#### Scenario: The API refuses the position

- GIVEN the API answers `400 BRANCH_LOCATION_OUT_OF_RANGE`
- WHEN the operator saves
- THEN the form explains that the position is outside the valid range
- AND the venue is not changed

#### Scenario: An operator deactivates a venue

- GIVEN an active venue
- WHEN the operator deactivates it
- THEN the list shows it as inactive

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

The Venues section MUST show, per venue, whether it is included in the passes' nearby notifications, and MUST explain why one is not: no position, inactive, or beyond the 10-venue limit.

#### Scenario: A venue without coordinates

- GIVEN an active venue with no position
- WHEN the operator opens the Venues section
- THEN the venue is marked as not included because it has no position
