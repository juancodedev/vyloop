# Tasks: Venue Geolocation

Documentation only. No task below changes behaviour; the behaviour they record is
already shipped by `0014_branch_geolocation` and the identity worker.

## 1. Record the contract

- [x] 1.1 Write `specs/database/spec.md`: the five columns, `NULL` semantics, the pair and range constraints, the derived geohash, the index, and the two-stage nearby query with its three exclusions.
- [x] 1.2 Write `specs/api-gateway/spec.md`: the four routes, the view shape, the error code table, and the rule that the surface is documented but not published in OpenAPI.
- [x] 1.3 Write `specs/multi-tenant-iam/spec.md`: tenant from the token, `404` for a cross-tenant path, and the double scoping of every venue statement.
- [x] 1.4 Trace every requirement to its evidence in the code (`packages/db/src/schema.ts`, `packages/db/src/proximity.ts`, `workers/identity/src/branch-location.ts`, `workers/identity/src/branches.ts`, `workers/identity/src/index.ts`) and remove any claim the code does not support.

## 2. Close the documented surface

- [x] 2.1 Add the three missing routes to `docs/08-API-Design.md` and name the coordinate fields in the branch description.
- [x] 2.2 Point `docs/20-Revision-Openspec.md` R6 at this change instead of describing it as missing.

## 3. Validate

- [x] 3.1 `openspec validate venue-geolocation --strict` passes.
- [x] 3.2 `openspec validate database --type spec`, `openspec validate api-gateway --type spec` and `openspec validate multi-tenant-iam --type spec` still pass (they do not see the delta until it is archived).
- [x] 3.3 Re-read the deltas against the route handlers once more; a scenario that describes what the code does not do is worse than no scenario.
- [x] 3.4 Archive with `openspec archive venue-geolocation -y` after review, then `openspec validate <capability> --type spec` for the three merged specs.
