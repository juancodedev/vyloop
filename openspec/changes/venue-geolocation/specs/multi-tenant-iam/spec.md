# Delta for multi-tenant-iam

## ADDED Requirements

### Requirement: The Venue Tenant Comes From the Token

Every venue request MUST take its business from the token's `business_id`. The
`{id}` in the path MUST NOT be used as the tenant; it only gets to agree with the
token.

The request MUST be authenticated first and authorized second: a missing,
malformed or expired bearer token MUST answer `401 AUTH_TOKEN_INVALID`, and a
subject that is a customer or a counter MUST answer `403 OPERATOR_ROLE_REQUIRED`
with a message naming the action that was refused.

A customer and a counter are refused for the same reason: both exist, both hold a
valid token, and neither configures a business's venues. The check MUST ask the
same predicate the loyalty routes ask, so a later role the issuer adds is not
silently refused by an allow-list that was written before it existed.

#### Scenario: A customer cannot configure venues

- GIVEN a valid token whose subject is a customer
- WHEN it calls any venue route
- THEN the answer is `403 OPERATOR_ROLE_REQUIRED`
- AND no venue is read or written

#### Scenario: A counter terminal cannot configure venues

- GIVEN a valid token whose subject is a counter
- WHEN it calls any venue route
- THEN the answer is `403 OPERATOR_ROLE_REQUIRED`

#### Scenario: No token

- GIVEN a request with no `Authorization` header
- WHEN it calls any venue route
- THEN the answer is `401 AUTH_TOKEN_INVALID`

### Requirement: A Cross-Tenant Path Is Indistinguishable From an Absent Business

When the `{id}` in the path names a business other than the token's, the answer
MUST be `404 NOT_FOUND`, and the body MUST NOT reveal that the identifier exists.

`403` would confirm it: a business that can tell "not yours" from "does not
exist" can enumerate the platform's tenants. The two answers MUST therefore be
the same answer.

#### Scenario: Another business's path

- GIVEN a valid operator token for business A
- WHEN it calls `/v1/businesses/B/branches` where B is a different business
- THEN the answer is `404 NOT_FOUND`
- AND no venue of B is read or written

#### Scenario: A business that does not exist

- GIVEN a valid operator token for business A
- WHEN it calls `/v1/businesses/does-not-exist/branches`
- THEN the answer is `404 NOT_FOUND`
- AND the body is the same shape as the previous scenario's

### Requirement: Venue Access Is Scoped By the Tenant

Every venue read and write MUST be scoped twice: the tenant context MUST be armed
for the business inside the transaction, and the statement MUST carry the
`business_id` predicate.

The two are not redundant. The context is what row-level security will read when
`branches` receives its policy; the predicate is what holds today, and what keeps
the rule true if a policy is ever missing or misapplied.

A venue id that belongs to another business MUST resolve to nothing and answer
`404 NOT_FOUND`, exactly like a venue that does not exist.

#### Scenario: A foreign venue id

- GIVEN a valid operator token for business A
- WHEN it calls `PATCH /v1/businesses/A/branches/{branchId}` with a venue id of business B
- THEN the answer is `404 NOT_FOUND`
- AND the venue of B is unchanged

#### Scenario: A list never spans tenants

- GIVEN two businesses with venues
- WHEN one of them lists its venues
- THEN every returned venue belongs to that business
- AND the total is that business's count alone
