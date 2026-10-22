# Delta for growth-dashboard

## ADDED Requirements

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