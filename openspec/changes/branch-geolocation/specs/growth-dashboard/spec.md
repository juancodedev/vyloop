# Delta for growth-dashboard

## ADDED Requirements

### Requirement: Venues Section (Settings)

The dashboard MUST offer a "Venues" section under Settings at `/dashboard/settings/venues` where an operator lists, creates, edits and deactivates the business's venues through the existing identity routes: `GET` and `POST /v1/businesses/me/branches`, `PATCH` and `DELETE /v1/businesses/me/branches/:branchId`.

The venue form MUST carry `name` (required), `address`, `city`, `country` (required, default "AR"), `timezone`, `isActive` (default true) and a position. The position MUST be set by typing `latitude` and `longitude` (step=0.000001, ranges -90..90 / -180..180), and the operator MUST be able to fill both in one action via a "Usar mi ubicación" button that calls `navigator.geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })` — visible only on `https:` or `localhost`.

The form MUST send `latitude` and `longitude` together, or neither to clear the position. It MUST show the identity worker's refusal codes (`BRANCH_LOCATION_INCOMPLETE`, `BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`) as readable messages next to the inputs.

The list MUST show, per venue: name, address (city, country), coordinates badge ("Ubicada" with lat/long on hover, or "Sin coordenadas"), active/inactive toggle, and actions (Edit, Deactivate). Pagination, search by name/address, and "Include inactive" filter are required.

#### Scenario: An operator registers a venue with a position

- GIVEN an operator on the Venues section
- WHEN they fill the form, enter the position or use their current location, and save
- THEN the venue is created with that `latitude` and `longitude`
- AND the list shows it as "Ubicada" with coordinates on hover

#### Scenario: The browser refuses the current position

- GIVEN an operator on the Venues section
- WHEN they ask for their current location and the browser denies the permission
- THEN the form shows a toast saying the position could not be read
- AND the operator can still type the coordinates manually

#### Scenario: An operator clears a position

- GIVEN a located venue
- WHEN the operator clears both coordinates and saves
- THEN the venue is updated with neither coordinate
- AND the list shows it as "Sin coordenadas"

#### Scenario: The API refuses the position

- GIVEN the API answers `400 BRANCH_LOCATION_OUT_OF_RANGE`
- WHEN the operator saves
- THEN the form explains that the position is outside the valid range next to the inputs
- AND the venue is not changed

#### Scenario: An operator deactivates a venue

- GIVEN an active venue
- WHEN the operator clicks "Desactivar" and confirms
- THEN the list shows it as inactive (toggle off)

#### Scenario: An operator edits an existing venue

- GIVEN a venue in the list
- WHEN the operator clicks "Editar", changes fields, and saves
- THEN the venue is updated and the list reflects the changes

### Requirement: Venue Form Component

A reusable component at `apps/dashboard/src/components/venue-form.tsx` MUST implement the create/edit form for venues. It MUST accept `initialData` (for edit) or null (for create), `onSubmit`, `onCancel`, `isSubmitting`, and `submitLabel` props. It MUST use the same modal pattern as `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx` (overlay + modal with header/body/footer, `modal-overlay` + `modal` classes).

The form MUST validate client-side: lat/long both present or both absent; lat in [-90, 90]; long in [-180, 180]. Error mapping for server codes MUST be implemented.

#### Scenario: Creating a new venue opens the modal with empty fields

- GIVEN an operator on the Venues list
- WHEN they click "Nueva sede"
- THEN the modal opens with empty fields, "Activa" checked, country default "AR", and "Crear sede" button

#### Scenario: Editing a venue pre-fills the form

- GIVEN a venue in the list
- WHEN the operator clicks "Editar"
- THEN the modal opens with all fields pre-filled, "Guardar cambios" button, and the same validation

### Requirement: API Client Extensions

The `api` object in `apps/dashboard/src/lib/api.ts` MUST expose `getVenues(filters)`, `createVenue(data)`, `updateVenue(id, data)`, and `deactivateVenue(id)` methods that call the identity worker routes (`/v1/businesses/me/branches` with `businessId` from token). Error mapping for location validation codes MUST be implemented client-side.

#### Scenario: Fetching venues with filters

- GIVEN an operator on the Venues page
- WHEN the page loads or filters change
- THEN `api.getVenues({ page, per_page, includeInactive })` is called and the table renders the result

#### Scenario: Creating a venue via API

- GIVEN valid form data
- WHEN the operator submits
- THEN `api.createVenue(data)` POSTs to `/v1/businesses/me/branches` and returns the created venue

#### Scenario: Updating a venue via API

- GIVEN a venue being edited
- WHEN the operator submits
- THEN `api.updateVenue(id, data)` PATCHes `/v1/businesses/me/branches/:id` with only changed fields

#### Scenario: Deactivating a venue via API

- GIVEN a venue in the list
- WHEN the operator clicks "Desactivar" and confirms
- THEN `api.deactivateVenue(id)` DELETEs `/v1/businesses/me/branches/:id`