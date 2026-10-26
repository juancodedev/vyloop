# Growth Dashboard Specification

## Purpose

Loyalty management dashboard views — navigation, program configuration, tier management, and customer points listing.

## Requirements

### Requirement: Navigation Section

The dashboard MUST display a "Loyalty" section in the primary sidebar navigation. It MUST contain links to "Program Config", "Tiers", and "Customer Points". The section MUST appear after "Customers" and before "Analytics" in the navigation order. It MUST be highlighted when any loyalty route is active.

#### Scenario: Active state
- GIVEN user navigates to `/dashboard/loyalty/tiers`
- WHEN the sidebar renders
- THEN "Loyalty" section is highlighted

### Requirement: Program Config View

The Loyalty Program Config view at `/dashboard/loyalty/config` MUST display `earn_rate` and `program_name` for the current business. It MUST provide an inline edit form to update both fields. Changes MUST persist via `PUT /v1/loyalty/config`.

#### Scenario: Load and edit
- GIVEN earnRate is 1.0, program name is "Puntos Vyloop"
- WHEN user opens `/dashboard/loyalty/config`
- THEN form shows current values
- WHEN user changes earnRate to 2.0 and saves
- THEN updated value reflected immediately

### Requirement: Tier Management View

The Tier Management view at `/dashboard/loyalty/tiers` MUST list all `membership_tiers` sorted by `display_order`. Each tier MUST show name, min_points, multiplier, and benefits. The view MUST provide create, edit, and delete actions. Deleting a tier with assigned customers MUST display an error message.

#### Scenario: List tiers
- GIVEN three tiers (Bronze, Silver, Gold)
- WHEN `/dashboard/loyalty/tiers` loads
- THEN tiers rendered in display_order sequence

#### Scenario: Delete error
- GIVEN a tier with customers assigned
- WHEN user attempts delete
- THEN error message "Cannot delete tier with active members" shown

### Requirement: Customer Points View

The Customer Points view at `/dashboard/loyalty/customers` MUST display a paginated list of customers with their current loyalty points, current tier name, and total points earned. The view MUST support search by customer name. Each row MUST link to the customer 360° profile.

#### Scenario: Paginated points list
- GIVEN 25 customers with points data
- WHEN view loads with default page size
- THEN first 20 customers shown with points and tier

#### Scenario: Search filters
- GIVEN customers "Alice" (500pts) and "Bob" (200pts)
- WHEN user searches "ali"
- THEN only Alice shown

#### Scenario: Row links to profile
- GIVEN a customer row
- WHEN user clicks the row
- THEN navigates to `/dashboard/customers/{id}`

### Requirement: Campaigns List Page

The dashboard MUST offer a "Campañas push" page at `/dashboard/communication/campaigns` that lists all composed push campaigns with pagination, filtering, and navigation to compose/detail.

The page MUST show a table with columns: Fecha, Título, Tipo objetivo (Sede única / Radio), Audiencia, Entregados, Fallidos, Omitidos. Rows MUST be clickable and navigate to the detail page `/dashboard/communication/campaigns/[referenceId]`. A "Nueva campaña" button MUST link to `/dashboard/communication/campaigns/new`. Filters: status (all/sent/failed), pagination. Empty state with CTA to create first campaign.

#### Scenario: An operator views the campaigns list

- GIVEN an operator on the Communication section
- WHEN they navigate to Campañas push
- THEN the table shows all campaigns with their metrics

#### Scenario: Filtering campaigns by status

- GIVEN an operator on the campaigns list
- WHEN they select "Fallidas" in the status filter
- THEN the table shows only campaigns with failed deliveries

### Requirement: Campaign Composer Page

The dashboard MUST offer a composer page at `/dashboard/communication/campaigns/new` where an operator composes a push campaign and sends it via `POST /v1/communication/push/campaigns`.

The form MUST include:
- **Título** (required, 1-40 chars) — matches `WALLET_MESSAGE_LIMITS.header`
- **Cuerpo** (required, 1-300 chars) — matches `WALLET_MESSAGE_LIMITS.body`
- **Link** (optional, valid URL, validated against allowlist origin)
- **Objetivo** (radio, exactly one): "Una sede" → dropdown with active+located venues, or "Radio alrededor de un punto" → lat/long/radius_m (max 50 000)
- **Referencia** (optional, auto UUID if empty) — idempotency key
- **Botón "Previsualizar audiencia"** → calls endpoint with `dry_run=true` (no event published, no messageLog written), shows `audience_size` and per-branch breakdown
- **Submit** → POST, toast with `reference_id` + `audience_size`, navigate to detail page

The "Radio" mode MUST include a "Usar mi ubicación" button (HTTPS/localhost only) that fills lat/long via `navigator.geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })`.

Validation: title/body required and length-limited; exactly one target form; radius ≤ 50km; coords in valid ranges; link allowlisted if present. Client validation before submit; server errors mapped to toasts.

#### Scenario: An operator composes a campaign targeting one venue

- GIVEN an operator on the composer page
- WHEN they fill title, body, select "Una sede", pick a located venue, and submit
- THEN the campaign is sent, toast shows `reference_id` and `audience_size`, and they are navigated to the detail page

#### Scenario: An operator composes a campaign targeting a radius

- GIVEN an operator on the composer page
- WHEN they fill title, body, select "Radio", enter lat/long/radius (or use "Usar mi ubicación"), and submit
- THEN the campaign is sent with that target

#### Scenario: An operator previews the audience before sending

- GIVEN an operator on the composer page with valid form
- WHEN they click "Previsualizar audiencia"
- THEN the endpoint is called with `dry_run=true`, no event is published, no messageLog is written, and the response shows `audience_size` and per-branch breakdown

#### Scenario: Validation prevents invalid submit

- GIVEN an operator on the composer page
- WHEN they submit with empty title or body, or invalid radius, or missing target
- THEN the form shows inline errors and does not submit

### Requirement: Campaign Detail Page

The dashboard MUST offer a detail page at `/dashboard/communication/campaigns/[referenceId]` showing all campaign fields, aggregated metrics, and per-branch breakdown for radius targets. A "Reenviar" button MUST re-POST the same payload (idempotent via `reference_id`).

#### Scenario: An operator views a campaign detail

- GIVEN an operator on the campaigns list
- WHEN they click a row
- THEN the detail page shows title, body, link, target, audience, delivered/failed/skipped, and per-branch breakdown for radius

#### Scenario: Re-sending a campaign

- GIVEN an operator on a campaign detail
- WHEN they click "Reenviar" and confirm
- THEN the same payload is POSTed, the detail refreshes with updated counts, and toast confirms

### Requirement: API Client Extensions

The `api` object in `apps/dashboard/src/lib/api.ts` MUST expose:
- `composePushCampaign(payload: PushCampaignPayload): Promise<PushCampaignPreview>` — supports `dry_run`
- `getPushCampaigns(params): Promise<{ campaigns: PushCampaignSummary[]; total }>` — pagination, status filter
- `getPushCampaignDetail(referenceId): Promise<PushCampaignDetail>` — includes per_branch for radius

#### Scenario: Composing a campaign with dry-run

- GIVEN an operator previews a campaign
- WHEN the preview button is clicked
- THEN `api.composePushCampaign({ ...payload, dry_run: true })` returns `audience_size` without publishing event

#### Scenario: Listing campaigns with filters

- GIVEN an operator on the campaigns list
- WHEN the page loads or filters change
- THEN `api.getPushCampaigns({ page, per_page, status })` is called

### Requirement: Dry-Run Endpoint (Worker)

The communication worker MUST support `?dry_run=true` on `POST /v1/communication/push/campaigns`.

Behavior: Same validation, same audience resolution (`resolveCampaignAudience`), **does not** publish `PushCampaignRequested` event, **does not** write to `messageLog`. Returns `{ reference_id, audience_size, per_branch }` with a generated (not persisted) `reference_id`.

#### Scenario: Dry-run returns audience without side effects

- GIVEN a composer calls the endpoint with `dry_run=true`
- WHEN the worker processes the request
- THEN the response contains the audience size and no `PushCampaignRequested` event is published

### Requirement: Dashboard Worker Deployment Runtime

The dashboard application (`apps/dashboard`) that hosts the growth dashboard views MUST be built with the OpenNext Cloudflare adapter (`@opennextjs/cloudflare`) and deployed as a Cloudflare Worker with static assets. The repository MUST NOT depend on `@cloudflare/next-on-pages`, and no route under `apps/dashboard/src/app` SHALL declare `export const runtime = 'edge'`.

Every dashboard route that rendered before the migration MUST render after it, including the dynamic route `/dashboard/customers/[id]`.

#### Scenario: Dynamic customer route

- GIVEN the dashboard is deployed as a Worker
- WHEN an operator opens `/dashboard/customers/<id>` for an existing customer
- THEN the page renders and loads the customer detail from the gateway

#### Scenario: No edge runtime declaration remains

- GIVEN the migrated source tree
- WHEN `apps/dashboard/src` is searched for `runtime = 'edge'`
- THEN there are no matches

### Requirement: Dashboard Hostname Continuity

After cut-over, the `vyloop-dashboard` Pages project MUST answer every path with a 301 to the same path and query string on the dashboard Worker's hostname, so bookmarked operator URLs keep working. The Pages project MUST NOT be deleted until a separate decision retires it.

#### Scenario: A bookmarked URL

- GIVEN an operator bookmarked `https://vyloop-dashboard.pages.dev/dashboard/loyalty/tiers`
- WHEN they open it after cut-over
- THEN they are redirected to `/dashboard/loyalty/tiers` on the dashboard Worker's hostname

### Requirement: Venue Management

The dashboard MUST offer a "Venues" section under Settings where an operator lists, registers, edits and deactivates the business's venues through the existing identity routes: `GET` and `POST /v1/businesses/:id/branches`, `PATCH` and `DELETE /v1/businesses/:id/branches/:branchId`.

The venue form MUST carry `name`, `address`, `city`, `country`, `timezone` and a position. The operator MUST be able to set the position by typing `latitude` and `longitude`, and MUST be able to fill both from the browser's current position in one action. _(Decided, Q6: no map and no address search in v1. The operator registers a venue while standing in it, so the device's position is better data than a dragged pin, and a map would force a tile-provider decision for one pair of numbers.)_

The form MUST send `latitude` and `longitude` together, or neither to clear the position. It MUST show the identity worker's refusal codes (`BRANCH_LOCATION_INCOMPLETE`, `BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`) as readable messages.

The list MUST show, per venue, whether it has a position.

#### Scenario: An operator registers a venue with a position

- GIVEN an operator on the Venues section
- WHEN they fill the form, enter the position or use their current location, and save
- THEN the venue is created with that `latitude` and `longitude`
- AND the list shows it as located

#### Scenario: The browser refuses the current position

- GIVEN an operator on the Venues section
- WHEN they ask for their current location and the browser denies the permission
- THEN the form says the position could not be read
- AND the operator can still type the coordinates

#### Scenario: An operator clears a position

- GIVEN a located venue
- WHEN the operator clears both coordinates and saves
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
