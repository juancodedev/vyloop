# Delta for Growth Dashboard

## ADDED Requirements

### Requirement: Registrar Venta Modal

The customer detail page (`/dashboard/customers/[id]`) MUST provide a "Registrar Venta" action button. Clicking it MUST open a modal with a dollar amount input. On submit, the system MUST call `POST /v1/loyalty/points/assign` with `points` equal to the entered dollar amount, `customer_id` from the current customer record, and `reference_id` formatted as `sale-{customerId}-{timestamp}`.

On success, the modal MUST close and the customer's points display MUST refresh to reflect the new balance.

#### Scenario: Admin records a $500 sale

- GIVEN admin is on customer detail page for customer with Bronze tier (1.0x) and earnRate 1.0
- WHEN admin opens modal, enters 500, and submits
- THEN `POST /v1/loyalty/points/assign` called with `points: 500`
- AND modal closes
- AND customer points display refreshes

#### Scenario: Empty amount blocked

- GIVEN modal is open
- WHEN amount input is empty or zero
- THEN submit button is disabled

#### Scenario: API error handling

- GIVEN the assign endpoint returns an error
- WHEN modal submit completes with failure
- THEN error toast is displayed
- AND modal remains open for retry
