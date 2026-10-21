# Proposal: Venue Geolocation

## Intent

Record, as a specification, the venue-geolocation contract that F1 shipped
without one.

`docs/19-Geolocalizacion-Notificaciones.md` §11 describes F1 as a phase, and
`docs/20-Revision-Openspec.md` R6 lists the change it never got: "the F1 change
that never existed". The code landed — migration, columns, constraints, index,
geohash, the four routes and their tests — and none of it is described by a
capability spec. That is the gap this change closes. It changes no behaviour.

## Why a retroactive change and not a comment in the backlog

A spec is what later work reads instead of re-deriving the rules from the code.
Three pieces of work already depend on this contract and cannot cite it:

- `branch-reward-trigger` scopes a reward to venues and needs to know what a
  venue position is and is not.
- `campaign-delivery-idempotency` resolves a radius target through
  `findBranchesInRadius`, whose exclusions are rules, not implementation
  details.
- `docs/19` F4 and the dashboard venue form both need the error contract to
  show a caller why a position was refused.

Left unwritten, each of them re-reads `branch-location.ts` and `proximity.ts`
and re-derives the same three answers differently.

## What is already true, verified against the code

| Claim | Evidence |
| --- | --- |
| `branches` carries five nullable position columns | `packages/db/drizzle/0014_branch_geolocation.sql`; `packages/db/src/schema.ts:109-126` |
| A half-position and an out-of-globe position are refused by the database | `branches_coordinates_pair_chk`, `branches_coordinates_range_chk` (`schema.ts:139-156`) |
| The nearby lookup is a geohash prefix scan | `idx_branches_geohash` (`schema.ts:136`) |
| A position is resolved once, purely, with four refusal codes | `workers/identity/src/branch-location.ts` |
| Four routes exist, gated by token, operator role and tenant | `workers/identity/src/index.ts:1089, 1114, 1176, 1243` |
| The gateway routes `/v1/businesses` to identity | `apps/gateway/src/router.ts:19` |
| The radius query is tenant-scoped, geohash-coarse and distance-exact | `packages/db/src/proximity.ts:294` |

## Scope

### In Scope

1. The `database` capability: the columns, what `NULL` means, the pair and range
   constraints, the derived geohash and its precision, the index, and the
   nearby-venue query with its three exclusions.
2. The `api-gateway` capability: the four routes, their response shapes, and the
   error contract a caller can branch on.
3. The `multi-tenant-iam` capability: the tenant comes from the token, the path
   only agrees with it, and a path naming another business answers `404`.
4. The documented surface: `docs/08` gains the three routes it was missing and
   the coordinate fields.

### Out of Scope

- **Any behaviour change.** No route, column, constraint or default moves.
- **Customer device positions.** None are stored, and this change does not start.
- **The proximity trigger.** `CustomerCheckedIn`, `RewardAvailableAtBranch` and
  radius campaigns are F3, and two of them are their own changes.
- **The dashboard venue form.** It consumes the contract; it is not specified
  here.
- **Row-level security.** `branches` is in `BUSINESS_ID_TABLES` and receives its
  policy in the separate RLS rollout, exactly as migration `0014` states.

## Decisions carried forward

These were made in `docs/19` and are now binding because a spec says them:

- **D2** — `located_at` instead of `updated_at`: the table has no row lifecycle
  to describe, and a position needs to say when it was asserted.
- **D3** — nullable instead of a `0,0` default: `NULL` means "not registered",
  and `0,0` would put every unlocated venue in the Gulf of Guinea.
- **D4** — the geohash is derived on every write and never authoritative. No
  trigger keeps it in step; the write path is the only writer.
- **D9** — the index is registered in `packages/db/src/indexes.ts` like every
  other derived index, so the drift check sees it.

## Open questions

None. Every rule below is already enforced; where the code and `docs/19`
disagreed, the code won, and the disagreement is noted in the delta.

## Impact

- Capabilities: `database` (+5 requirements), `api-gateway` (+3), `multi-tenant-iam` (+2).
- Code: none.
- Docs: `docs/08-API-Design.md` (three routes and the coordinate fields),
  `docs/20-Revision-Openspec.md` R6 (closed by this change).
- Migration: none. `0014` is already applied and recorded in
  `_applied-outside-drizzle.json`.
