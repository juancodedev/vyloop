# Proposal: Push Campaign Composer (Dashboard UI)

## Intent

The endpoint `POST /v1/communication/push/campaigns` already exists in `workers/communication` and works. What is missing is the **dashboard UI** that lets an operator compose a campaign, pick a target (one venue or a radius around a point), and see the audience size before sending.

Today the only way to send a campaign is `curl`. An operator cannot:
- See the list of venues with coordinates to pick one
- Draw a radius on a map (or type coordinates) to target an area
- Preview the audience size before committing
- See the history of campaigns sent and their delivery counts

## Scope

### In Scope

1. **Composer page** at `/dashboard/communication/campaigns/new`:
   - Form with title, body, optional link
   - Target selector: one venue (dropdown, only active + located) OR point + radius (max 50 km)
   - Audience preview button (calls the endpoint with `dry_run=true` or a dedicated preview route)
   - Idempotency key field (optional, auto-generated if empty)
   - Submit → 202 with `reference_id` and `audience_size`, toast with result

2. **History list** at `/dashboard/communication/campaigns`:
   - Paginated table: date, title, target type, audience, delivered, failed, skipped
   - Link to campaign detail (modal or page) showing per-branch breakdown if radius

3. **API client** in `apps/dashboard/src/lib/api.ts`:
   - `composePushCampaign(payload)`
   - `getPushCampaigns({ page, per_page, status })`
   - `getPushCampaignDetail(referenceId)`

### Out of Scope

- **Automated/scheduled campaigns** — this is the manual composer only
- **Customer device positions** — vyloop never receives them; Google evaluates proximity on device
- **Map-based radius picker** — v1 uses numeric fields + "use my location" (like the venue form). A map is a separate decision (tile provider, cost, complexity).
- **Consent management UI** — already exists in `ConsentList` (disabled for now); enabling it is a separate change

## Prerequisites (must be true before this change starts)

| What | Where |
|---|---|
| `POST /v1/communication/push/campaigns` exists and works | `workers/communication/src/campaign-routes.ts` |
| `GET /v1/communication/history?channel=push` exists | `workers/communication/src/routes.ts` |
| Venue coordinates exist on `branches.latitude/longitude` | `packages/db/src/schema.ts` |
| `findBranchesInRadius` exists | `packages/db/src/proximity.ts` |
| `INTERACTION_WINDOW_DAYS = 180` constant | `workers/communication/src/push-campaigns.ts` |
| `MAX_CAMPAIGN_RADIUS_METERS = 50_000` | `workers/communication/src/campaign-routes.ts` |

## Risks

| Risk | Mitigation |
|---|---|
| Audience preview takes too long | Separate preview route that only counts, no queue publish; timeout 5s |
| Radius picker without map is hard to use | "Use my location" button gives the operator's position as a starting point |
| 400-line budget | Two small PRs: (1) API client + list page, (2) composer page + history detail |
| Operator picks a radius with zero venues | Validation returns audience=0 before sending; UI shows warning |

## Chained PR Strategy

| PR | Goal | Files |
|---|---|---|
| 1 | API client + list page (skeleton) | `api.ts`, `dashboard/communication/campaigns/page.tsx` |
| 2 | Composer page + history detail | `campaigns/new/page.tsx`, `campaigns/[referenceId]/page.tsx` |

---

# Proposal: Branch Geolocation UI (Dashboard)

## Intent

Venues (`branches`) carry `latitude`/`longitude` columns since `2026-10-20-venue-geolocation`, but **no UI exists to edit them**. An operator cannot register a venue's position from the dashboard.

This is a blocker for:
- **Push campaigns** (need located venues to target)
- **Wallet nearby notifications** (need `merchantLocations` on the pass)

## Scope

### In Scope

1. **Venues section** under Settings at `/dashboard/settings/venues`:
   - List table: name, address, coordinates (or "Sin coordenadas"), active/inactive, actions
   - "Nueva sede" button → form with coordinates

2. **Venue form** (create + edit):
   - Name, address (existing fields)
   - Latitude / Longitude (two numeric inputs, step=0.000001, min/max per spec)
   - **"Use my location" button** → asks browser for position, fills both fields
   - Active toggle
   - Validation: both coordinates together or neither; range check (-90..90, -180..180)

3. **API client** in `apps/dashboard/src/lib/api.ts`:
   - `createVenue`, `updateVenue`, `deactivateVenue`, `getVenues`

### Out of Scope

- **Map picker** — v1 uses numeric fields + "use my location" (same rationale as wallet-notifications Q6)
- **Address search / geocoding** — deferred
- **Bulk import** — deferred

## Prerequisites

| What | Where |
|---|---|
| `POST/PUT/DELETE /v1/loyalty/branches` exist | `workers/identity/src/routes.ts` (verify) |
| `branches` table has `latitude`, `longitude`, `isActive` | `packages/db/src/schema.ts` |

## Risks

| Risk | Mitigation |
|---|---|
| "Use my location" fails on HTTP (not HTTPS) | Only show button on `https:` or `localhost`; fallback to manual entry |
| Coordinates outside valid range | Client + server validation; readable error messages |
| 400-line budget | One PR: list + form + API client |