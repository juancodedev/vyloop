# Delta for growth-dashboard

## ADDED Requirements

### Requirement: Pass Management View

The dashboard MUST provide a view at `/dashboard/loyalty/passes`, linked from the Loyalty navigation section, that lists the business's Google Wallet passes from `GET /v1/wallet/passes`. Each row MUST show the customer name, the member code, the pass state and when it was last verified. State wording MUST keep `not_issued`, `not_saved` and `revoked` distinguishable, reusing `apps/dashboard/src/lib/pass-state.ts`. Each row MUST offer Reissue and Revoke; Revoke MUST require an explicit confirmation that states the pass stays on the holder's phone marked inactive.

#### Scenario: Browse passes

- GIVEN an operator signed in to a business with passes
- WHEN they open `/dashboard/loyalty/passes`
- THEN the first page of passes is listed
- AND a control loads the next page when a cursor is returned

#### Scenario: Revoke with confirmation

- GIVEN a row whose state is issued
- WHEN the operator chooses Revoke and confirms
- THEN `POST /v1/wallet/passes/{customerId}/revoke` is called
- AND the row shows the revoked state

#### Scenario: Revoke cancelled

- GIVEN the revoke confirmation is open
- WHEN the operator cancels
- THEN no request is sent
