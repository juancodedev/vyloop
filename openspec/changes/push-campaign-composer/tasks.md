# Tasks: Push Campaign Composer (Dashboard UI)

> Status: proposed. Depends on wallet-notifications Unit 0 (decisions) and communication worker existing endpoints.

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~600 |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: API client + list page; PR 2: Composer + detail |

Decision needed before apply: No (endpoint already exists)
Chained PRs recommended: Yes
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Lines | Notes |
|---|---|---|---|---|
| 1 | API client + campaigns list page | PR 1 | ~200 | Reuses existing `apiFetch` |
| 2 | Composer page + history detail | PR 2 | ~400 | Form + preview + submit |

---

## Unit 1: API Client + Campaigns List Page

- [ ] 1.1 `apps/dashboard/src/lib/api.ts`: add `composePushCampaign`, `getPushCampaigns`, `getPushCampaignDetail`
- [ ] 1.2 `apps/dashboard/src/app/dashboard/communication/campaigns/page.tsx`:
  - Paginated table with columns: Fecha, Título, Tipo objetivo, Audiencia, Entregados, Fallidos, Omitidos
  - Filtros: estado (todos/enviados/fallidos), página, por página
  - Botón "Nueva campaña" → `/dashboard/communication/campaigns/new`
  - Empty state con CTA
- [ ] 1.3 Tests en `specs/growth-dashboard` "Campaigns List"

## Unit 2: Composer Page + History Detail

- [ ] 2.1 `apps/dashboard/src/app/dashboard/communication/campaigns/new/page.tsx`:
  - Formulario: título (requerido), cuerpo (requerido), link (opcional)
  - Selector de objetivo: **radio** entre
    - "Una sede" → dropdown con sedes activas y con coordenadas (name + distancia si hay ubicación actual)
    - "Radio alrededor de un punto" → latitud, longitud, radio en metros (máx 50 000)
  - Botón "Usar mi ubicación" (solo en modo radio): pide `navigator.geolocation`, rellena lat/long
  - Botón "Previsualizar audiencia" → llama endpoint con `dry_run=true` (nuevo parámetro) o `/preview` y muestra `audience_size` + breakdown por sede
  - Campo `reference_id` (opcional, autogenerado si vacío)
  - Submit → POST, muestra toast con `reference_id` y `audience_size`, navega a detalle
  - Validación cliente: título/cuerpo no vacíos, radio ≤ 50km, coordenadas válidas
- [ ] 2.2 `apps/dashboard/src/app/dashboard/communication/campaigns/[referenceId]/page.tsx`:
  - Detalle de campaña: título, cuerpo, link, objetivo, audiencia, entregados, fallidos, omitidos
  - Si objetivo radio: tabla por sede (nombre, distancia, entregados, fallidos)
  - Botón "Reenviar" (mismo reference_id → 409, UI lo maneja)
- [ ] 2.3 Tests en `specs/growth-dashboard` "Campaign Composer" y "Campaign Detail"

---

## Spec Deltas (to create in `openspec/changes/push-campaign-composer/specs/growth-dashboard/`)

### `specs/growth-dashboard/spec.md` — new deltas

**Delta: Campaigns List Page**
- New page at `/dashboard/communication/campaigns`
- Table with pagination, filters, empty state
- Navigation to composer

**Delta: Campaign Composer Page**
- New page at `/dashboard/communication/campaigns/new`
- Form with title, body, link, target selector (branch or radius), preview button, reference_id
- "Use my location" button for radius mode
- Submission flow with toast and navigation

**Delta: Campaign Detail Page**
- New page at `/dashboard/communication/campaigns/[referenceId]`
- Shows all campaign fields + per-branch breakdown for radius targets
- Resend button (idempotent)

---

## Open Questions (none — decisions deferred to wallet-notifications)

| Q | Depends on |
|---|---|
| Dry-run endpoint shape | `workers/communication` to add `?dry_run=true` to compose route |
| Per-branch breakdown in detail | `messageLog` already carries target info via `reference_id` prefix |
| Toast/notification library | Existing dashboard patterns (check `apps/dashboard/src/components/`) |