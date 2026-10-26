# Delta for customer-web

## ADDED Requirements

### Requirement: Nearby notifications consent opt-in at registration

The customer registration flow MUST allow the customer to opt in to nearby
notifications (push) at registration time, instead of rendering the control as
permanently disabled.

The `ConsentList` component in `apps/customer-web/app/components/consent-list.tsx`
MUST render the `nearbyNotifications` option as an interactive checkbox
(defaulted to unchecked) and MUST NOT render the "No disponible todavía" state
for that option.

The registration payload MUST include the `nearbyNotifications` value when
submitted, so the backend can persist the consent.

#### Scenario: Customer opts in to nearby notifications at registration

- GIVEN a customer on the registration page
- WHEN they check "Avisos cercanos" and submit
- THEN the registration payload includes `nearbyNotifications: true`
- AND the backend persists a `consents` row with `consent_type = 'nearby_notifications'` and `granted = true`

#### Scenario: Customer does not opt in

- GIVEN a customer on the registration page
- WHEN they leave "Avisos cercanos" unchecked and submit
- THEN the registration payload includes `nearbyNotifications: false`
- AND no `nearby_notifications` consent row is created (or it is created with `granted = false`)

### Requirement: Backend consent persistence endpoint

The identity worker MUST expose an endpoint to upsert a customer's consent
(e.g. `POST /v1/customers/me/consents` or as part of registration), accepting
`{ consentType, granted }` and writing to the `consents` table with the
correct `business_id` / `customer_id` scoping.

#### Scenario: Consent upsert

- GIVEN an authenticated customer
- WHEN they POST `{ consentType: "nearby_notifications", granted: true }`
- THEN a `consents` row is upserted with `granted = true`
