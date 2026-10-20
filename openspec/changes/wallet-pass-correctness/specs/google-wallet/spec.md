# Delta for google-wallet

## ADDED Requirements

### Requirement: Integer Points Balance

The loyalty object written to Google Wallet MUST carry the points balance in `loyaltyPoints.balance.int` as an integer, both when the object is first built and when the reconcile path patches it. The system MUST NOT write `loyaltyPoints.balance.string`.

A balance that `balanceDisplayFailure` rejects (non-finite, fractional, negative, or above `BALANCE_DISPLAY_MAX`) MUST still be refused before anything is sent to Google.

When reading an object back from Google, the system MUST interpret `balance.int` when present and SHOULD fall back to an all-digit `balance.string`, so objects written before this change are compared correctly by the reconcile idempotency gate.

#### Scenario: A new pass carries an integer balance

- GIVEN a customer with a ledger balance of 120 points
- WHEN the loyalty object is built for issuance
- THEN `loyaltyPoints.balance` is `{ "int": 120 }`
- AND it has no `string` field

#### Scenario: A legacy object in sync is not patched

- GIVEN a Google object whose `loyaltyPoints.balance` is `{ "string": "120" }`
- AND the ledger balance is 120
- WHEN the pass is reconciled
- THEN no patch is sent
- AND the reconciliation is recorded as in sync

#### Scenario: A legacy object out of sync is patched in the new form

- GIVEN a Google object whose `loyaltyPoints.balance` is `{ "string": "100" }`
- AND the ledger balance is 120
- WHEN the pass is reconciled
- THEN the patch sends `{ "int": 120 }`
- AND the echoed balance is checked as the number 120 before the reconciliation is recorded

### Requirement: Member Code at Registration

Every active customer MUST hold a valid `member_code` shortly after registering, whether or not they ever request a pass. When the growth worker handles `CustomerRegistered`, it MUST ask the wallet worker, over the `WALLET` service binding, to ensure the customer's member code. The code MUST be derived and claimed by the existing `ensureMemberCode` compare-and-set, so it is unique per business (`uq_customers_business_member_code`) and a concurrent first issuance returns the same code.

`MEMBER_CODE_PEPPER` MUST remain a secret of the wallet worker only. A failure to ensure the code MUST be logged and MUST NOT fail the `CustomerRegistered` handling; the issuance path MUST still mint a code lazily when none is stored.

#### Scenario: A customer registers and never asks for a pass

- GIVEN a business with a configured wallet program
- WHEN a customer registers and `CustomerRegistered` is handled by the growth worker
- THEN `customers.member_code` for that customer is a valid six-character code
- AND the cashier can resolve the customer by that code at the counter

#### Scenario: The event is delivered twice

- GIVEN a customer whose member code was set by the first delivery of `CustomerRegistered`
- WHEN the same event is delivered again
- THEN the stored member code is unchanged

#### Scenario: The wallet binding is unavailable

- GIVEN the growth worker has no `WALLET` binding or the call throws
- WHEN `CustomerRegistered` is handled
- THEN the ledger initialisation still completes
- AND the error is logged with the customer and tenant ids
- AND the customer's code is minted on their first pass request

### Requirement: Member Code Backfill

The wallet worker MUST provide an idempotent, resumable backfill that assigns a `member_code` to every active customer (`deleted_at IS NULL`) whose code is `NULL`, in batches that use `FOR UPDATE SKIP LOCKED`, through the same derivation and compare-and-set as issuance. Running it again MUST NOT change any code already stored. Each run MUST report how many codes were claimed and how many customers remain without one.

#### Scenario: Backfill over existing customers

- GIVEN 12 active customers of which 4 have a member code
- WHEN the backfill runs to completion
- THEN all 12 have a valid member code
- AND the 4 pre-existing codes are unchanged
- AND the run reports 8 claimed and 0 remaining

### Requirement: Operator Pass Listing

`GET /v1/wallet/passes` MUST return the passes of the caller's business only, for operators only. A customer-role caller MUST receive 403 `OPERATOR_ROLE_REQUIRED`. Each item MUST include the customer id, the customer's display name, `member_code`, `object_id`, the tracking `state` and `last_synced_at`. The listing MUST be paginated by an opaque cursor with a default page size of 50 and a maximum of 200, and MAY be filtered by `state`.

#### Scenario: An operator lists the passes

- GIVEN a business with 60 tracked passes
- WHEN an operator requests `GET /v1/wallet/passes`
- THEN 50 items of that business are returned
- AND a cursor for the next page is returned

#### Scenario: Tenant isolation

- GIVEN two businesses with passes
- WHEN an operator of the first requests the listing
- THEN no pass of the second business appears

#### Scenario: A customer token is refused

- GIVEN a customer-role caller
- WHEN they request `GET /v1/wallet/passes`
- THEN the response is 403 with code `OPERATOR_ROLE_REQUIRED`

### Requirement: Operator Pass Revocation

`POST /v1/wallet/passes/{customerId}/revoke` MUST, for an operator of the customer's business, set the Google object to the revocation state and only then record the tracking row as `revoked`. If Google fails or echoes a different state, the tracking row MUST be left unchanged and the response MUST be an error. While a pass is `revoked`, `GET /v1/wallet/pass` for that customer MUST answer 409 `WALLET_PASS_REVOKED` instead of a save link, and neither the reconcile path nor the inactivity sweep SHALL change the row's state.

#### Scenario: Revoke an issued pass

- GIVEN a customer whose pass is `issued`
- WHEN an operator of the same business revokes it
- THEN Google holds the object in the revocation state
- AND the tracking row is `revoked`

#### Scenario: The customer asks for the pass after revocation

- GIVEN a customer whose pass is `revoked`
- WHEN the customer requests `GET /v1/wallet/pass`
- THEN the response is 409 with code `WALLET_PASS_REVOKED`

#### Scenario: A customer of another business

- GIVEN a customer of business B
- WHEN an operator of business A requests the revocation
- THEN the response is 404
- AND nothing is sent to Google

### Requirement: Operator Pass Reissue

`POST /v1/wallet/passes/{customerId}/reissue` MUST, for an operator of the customer's business, return a fresh signed save link built from the customer's stored member code and current ledger balance. If the pass is `revoked`, the Google object MUST be set back to `ACTIVE` first and the tracking row moved to `issued` only after Google confirms.

#### Scenario: Reissue a revoked pass

- GIVEN a customer whose pass is `revoked`
- WHEN an operator reissues it
- THEN Google holds the object as `ACTIVE`
- AND the tracking row is `issued`
- AND the response carries a save link for the same `object_id`
