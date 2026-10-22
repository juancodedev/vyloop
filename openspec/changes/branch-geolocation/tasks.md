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
| `POST /v1/loyalty/branches` (create) | `workers/identity/src/routes.ts` |
| `PUT /v1/loyalty/branches/:id` (update) | `workers/identity/src/routes.ts` |
| `POST /v1/loyalty/branches/:id/revoke` o `isActive` toggle | `workers/identity/src/routes.ts` |
| `branches` tiene `latitude`, `longitude`, `isActive` | `packages/db/src/schema.ts` |

## Riesgos

| Riesgo | Mitigación |
|---|---|
| "Usar mi ubicación" falla en HTTP | Solo mostrar botón en `https:` o `localhost`; fallback a entrada manual |
| Coordenadas fuera de rango | Validación cliente + servidor; mensajes legibles (`BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`) |
| Presupuesto 400 líneas | Un solo PR: list + form + API client |

## Chained PR Strategy

| PR | Goal | Files |
|---|---|---|
| 1 | API client + list page + form | `api.ts`, `dashboard/settings/venues/page.tsx`, `components/venue-form.tsx` |

---

# Tasks: Branch Geolocation UI

> Status: proposed. Depends on identity worker having the CRUD routes (verify first).

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~350 |
| 400-line budget risk | Low |
| Chained PRs recommended | No (one PR fits) |

Decision needed before apply: Yes — verify identity worker routes exist
Chained PRs recommended: No
400-line budget risk: Low

---

## Unit 0: Verify Prerequisites

- [ ] 0.1 Confirm `POST /v1/loyalty/branches` exists and accepts `latitude`, `longitude`, `isActive`
- [ ] 0.2 Confirm `PUT /v1/loyalty/branches/:id` exists for updates
- [ ] 0.3 Confirm `POST /v1/loyalty/branches/:id/revoke` or `PATCH` with `isActive` exists
- [ ] 0.4 If any route missing → create `identity-worker-branches-crud` change first

## Unit 1: API Client + List Page + Form

- [ ] 1.1 `apps/dashboard/src/lib/api.ts`: add `getVenues`, `createVenue`, `updateVenue`, `deactivateVenue`
- [ ] 1.2 `apps/dashboard/src/app/dashboard/settings/venues/page.tsx`:
  - Tabla paginada: Nombre, Dirección, Coordenadas (badge "Ubicada" / "Sin coordenadas"), Estado (Activa/Inactiva), Acciones
  - Filtro: incluir inactivas (checkbox)
  - Empty state con CTA "Registrar primera sede"
  - Botón "Nueva sede" → abre formulario en modal o navega a `/dashboard/settings/venues/new`
- [ ] 1.3 `apps/dashboard/src/components/venue-form.tsx` (reutilizable crear/editar):
  - Props: `initialData?`, `onSubmit`, `onCancel`
  - Campos: nombre, dirección, latitud, longitud, toggle activa
  - Botón "Usar mi ubicación" → `navigator.geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })` → rellena lat/long
  - Solo visible en `https:` o `localhost` (check `window.location.protocol`)
  - Validación cliente: lat/long ambos o ninguno; rango -90..90 / -180..180; mensajes:
    - `BRANCH_LOCATION_INCOMPLETE` → "Ambas coordenadas son obligatorias si se proporciona una"
    - `BRANCH_LOCATION_INVALID` → "Latitud debe estar entre -90 y 90, longitud entre -180 y 180"
    - `BRANCH_LOCATION_OUT_OF_RANGE` → "El valor supera el rango permitido"
  - Submit → llama API client, toast éxito/error, cierra modal o navega
- [ ] 1.4 Tests en `specs/growth-dashboard` "Venue Management"

---

## Spec Deltas (to create in `openspec/changes/branch-geolocation/specs/growth-dashboard/`)

### `specs/growth-dashboard/spec.md` — new deltas

**Delta: Venues Settings Page**
- New page at `/dashboard/settings/venues`
- Paginated list with coordinates badge, active toggle, actions
- Navigation to create/edit

**Delta: Venue Form Component**
- Reusable create/edit form with name, address, lat/long, active toggle
- "Use my location" button (HTTPS/localhost only)
- Client validation with readable error codes
- Submits to API client

**Delta: API Client Extensions**
- `getVenues`, `createVenue`, `updateVenue`, `deactivateVenue` in `api.ts`
- Error mapping for location validation codes