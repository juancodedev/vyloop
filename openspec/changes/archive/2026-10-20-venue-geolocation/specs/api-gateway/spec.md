# Delta for api-gateway

## ADDED Requirements

### Requirement: The Venue Routes Are Reachable

The gateway MUST route `/v1/businesses` to the `identity` worker, and
`/v1/businesses` MUST remain in the gateway's route map. The four venue routes
below MUST be reachable through it without the gateway rewriting the path:

| Method | Path | Success |
| --- | --- | --- |
| `GET` | `/v1/businesses/{id}/branches` | `200 { branches, total, business_id }` |
| `POST` | `/v1/businesses/{id}/branches` | `201 { branch }` |
| `PATCH` | `/v1/businesses/{id}/branches/{branchId}` | `200 { branch }` |
| `DELETE` | `/v1/businesses/{id}/branches/{branchId}` | `200 { branch }` |

`DELETE` MUST deactivate the venue rather than remove the row, and the answer
MUST carry the venue with `is_active: false`. A deactivated venue MUST still
appear in the list, because a caller that needs only active venues filters on
the field it was given.

Every venue view MUST carry `latitude` and `longitude` as numbers or `null`,
`geohash` and `geohash_precision` as `null` or their stored values, and
`located_at` as an ISO 8601 string or `null`.

#### Scenario: The list returns positions

- GIVEN a tenant with one located and one unlocated venue
- WHEN it calls `GET /v1/businesses/{id}/branches`
- THEN both venues are returned
- AND the located one carries numbers for `latitude` and `longitude`
- AND the unlocated one carries `null` for both

#### Scenario: Deleting a venue keeps the row

- GIVEN a venue of the tenant
- WHEN it calls `DELETE /v1/businesses/{id}/branches/{branchId}`
- THEN the answer is `200` with `is_active: false`
- AND a later list still contains the venue

### Requirement: The Venue Error Contract

A caller MUST be able to branch on the error code without parsing prose, and the
codes MUST be stable:

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | The body is not JSON, a field has the wrong type, or a required field is absent or blank |
| `400` | `BRANCH_LOCATION_INCOMPLETE` | One coordinate arrived without the other |
| `400` | `BRANCH_LOCATION_INVALID` | A coordinate is present but is not a number |
| `400` | `BRANCH_LOCATION_OUT_OF_RANGE` | A coordinate is outside the globe |
| `400` | `BRANCH_LOCATION_INVALID_GEOHASH` | A geohash arrived and is not one |
| `401` | `AUTH_TOKEN_INVALID` | The bearer token is missing, malformed or expired |
| `403` | `OPERATOR_ROLE_REQUIRED` | The subject is a customer or a counter |
| `404` | `NOT_FOUND` | The path names another business, or the venue is not the tenant's |
| `500` | `INTERNAL_ERROR` | The worker cannot reach its configuration or database |

A position MAY arrive as numbers or as numeric strings, because a form sends
strings. An empty string MUST be refused rather than read as `0`: an empty input
silently becoming a position off the coast of Africa is not a rounding detail.

Sending every position field as `null` MUST clear the position. Sending none of
them MUST leave it untouched. Sending `latitude` and `longitude` together MUST
win over a `geohash` in the same body, because the geohash is the derived value.

A `geohash` sent alone MUST be decoded to its cell centre and re-encoded at the
precision the string carried, and the stored coordinates MUST be that pair. The
row MUST never carry a geohash the server did not compute.

#### Scenario: A form sends strings

- GIVEN a create request whose `latitude` and `longitude` are numeric strings
- WHEN the venue is created
- THEN the answer is `201`
- AND the stored position matches those numbers

#### Scenario: An empty coordinate is not zero

- GIVEN a create request whose `latitude` is `""`
- WHEN the venue is created
- THEN the answer is `400 BRANCH_LOCATION_INVALID`
- AND no venue is written

#### Scenario: A partial update leaves the position alone

- GIVEN a located venue
- WHEN a `PATCH` changes only `name`
- THEN the position is unchanged

#### Scenario: Nulls clear the position

- GIVEN a located venue
- WHEN a `PATCH` sends `latitude` and `longitude` as `null`
- THEN the venue is stored with no position

### Requirement: The Venue Surface Is Documented, Not Published

`docs/08-API-Design.md` MUST list the four venue routes and name the coordinate
fields. The published OpenAPI document MUST NOT gain them: it carries only the
counter-subject surface (`/v1/auth/pos/token`, `/v1/loyalty/passes/resolve`,
`/v1/loyalty/checkins`), and a business-facing route added there would change the
documented contract for every integration that reads it.

#### Scenario: The documentation matches the routes

- GIVEN `docs/08-API-Design.md`
- WHEN a reader looks for the venue routes
- THEN all four are listed with their methods and paths

#### Scenario: The published contract does not grow

- GIVEN `api/docs/openapi.yaml`
- WHEN it is read
- THEN it contains no `/v1/businesses` path
