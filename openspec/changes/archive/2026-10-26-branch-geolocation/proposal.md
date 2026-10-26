# Proposal: Branch Geolocation UI (Dashboard)

## Intent

Venues (`branches`) have carried `latitude`/`longitude` columns since `2026-10-20-venue-geolocation`, and the identity worker exposes CRUD routes for them. But **no dashboard UI exists** to edit coordinates.

This is a hard blocker for:
- **Push campaigns** — the composer needs located venues to target
- **Wallet nearby notifications** — the pass needs `merchantLocations` from active, located venues

## Scope

### In Scope

1. **Venues section** under Settings at `/dashboard/settings/venues`:
   - List table: nombre, dirección, coordenadas (o "Sin coordenadas"), estado activo/inactivo, acciones
   - "Nueva sede" → formulario de creación
   - Cada fila: editar, activar/desactivar, eliminar (soft: `isActive=false`)

2. **Venue form** (crear + editar) — componente reutilizable:
   - Nombre (requerido)
   - Dirección (opcional, existente)
   - Latitud / Longitud (dos inputs numéricos, `step=0.000001`, `min=-90 max=90` / `min=-180 max=180`)
   - **Botón "Usar mi ubicación"** → `navigator.geolocation.getCurrentPosition()`, rellena ambos campos
   - Toggle "Activa" (default true)
   - Validación: ambas coordenadas juntas o ninguna; rango estricto; mensaje legible para `BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`

3. **API client** en `apps/dashboard/src/lib/api.ts`:
   - `getVenues({ page, per_page, includeInactive })`
   - `createVenue(data)`
   - `updateVenue(id, data)`
   - `deactivateVenue(id)`

### Out of Scope

- **Map picker** — v1 usa campos numéricos + "usar mi ubicación" (misma decisión que wallet-notifications Q6: un pin arrastrado es peor dato que la posición del navegador del operador estando en el local)
- **Búsqueda de dirección / geocoding** — diferido
- **Importación masiva** — diferido

## Prerequisites

| Qué | Dónde |
|---|---|
| `POST /v1/businesses/{id}/branches` (create) | `workers/identity/src/index.ts:1117` |
| `PATCH /v1/businesses/{id}/branches/{branchId}` (update) | `workers/identity/src/index.ts:1179` |
| `DELETE /v1/businesses/{id}/branches/{branchId}` (deactivate) | `workers/identity/src/index.ts:1246` |
| `branches` tiene `latitude`, `longitude`, `isActive` | `packages/db/src/schema.ts` |

**Verified:** All routes exist and accept `location: { latitude, longitude, geohash?, geohashPrecision? }` in body. Error codes returned: `BRANCH_LOCATION_ABSENT`, `BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`.

## Risks

| Riesgo | Mitigación |
|---|---|
| "Usar mi ubicación" falla en HTTP | Solo mostrar botón en `https:` o `localhost`; fallback a entrada manual |
| Coordenadas fuera de rango | Validación cliente + servidor; mensajes legibles (`BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`) |
| Presupuesto 400 líneas | Un solo PR: list + form + API client |

## Chained PR Strategy

| PR | Goal | Files |
|---|---|---|
| 1 | API client + list page + form | `api.ts`, `dashboard/settings/venues/page.tsx`, `components/venue-form.tsx` |