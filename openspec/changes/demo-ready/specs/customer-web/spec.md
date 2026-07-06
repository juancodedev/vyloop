# Delta for Customer Web

## MODIFIED Requirements

### Requirement: Landing Page

The landing page MUST display a QR scan simulation or placeholder. It MAY include a manual "Start Registration" button as fallback. If a valid JWT exists in storage, the page MUST redirect to `/profile` instead of showing the landing content.

(Previously: No auth-awareness — always showed landing content.)

#### Scenario: Landing renders (unauthenticated)

- GIVEN a visitor to the PWA with no stored JWT
- WHEN the landing page loads
- THEN QR placeholder and "Start Registration" button are visible

#### Scenario: Redirect to profile (authenticated)

- GIVEN a visitor with a valid stored JWT
- WHEN the landing page loads
- THEN redirect to `/profile`

### Requirement: Registration Form

The form MUST collect `fullName` (required), `phone` (required), `email` (optional), and `birthDate` (optional). On submit, the form MUST POST the payload to `POST /v1/customers` via the gateway. After successful registration, the system MUST call `POST /v1/auth/customer/token` with the submitted phone to obtain a JWT, store it, and redirect to `/profile`.

(Previously: Redirected to confirmation screen only, no auto-login.)

#### Scenario: Valid submission with auto-login

- GIVEN required fields filled with valid data
- WHEN user submits the form
- THEN POST to `/v1/customers` is called
- AND on success, JWT is obtained via customer-auth endpoint
- AND JWT is stored in local/session storage
- AND user is redirected to `/profile`

#### Scenario: Missing required field

- GIVEN `fullName` or `phone` is empty
- WHEN user attempts to submit
- THEN inline validation error is shown
- AND no POST is made

## ADDED Requirements

### Requirement: Login Page

The system MUST provide a `/login` page with a phone input and submit button. On submit, it MUST call `POST /v1/auth/customer/token`, store the returned JWT, and redirect to `/profile`.

#### Scenario: Successful login

- GIVEN a known phone number
- WHEN submitting the login form
- THEN JWT is stored
- AND redirect to `/profile`

#### Scenario: Unknown phone

- GIVEN an unknown phone number
- WHEN submitting the login form
- THEN "Phone not registered" message is shown
- AND no redirect occurs

### Requirement: Auth Guard

All `/profile/*` routes MUST check JWT validity before rendering. If expired or missing, redirect to `/login`.

#### Scenario: Valid JWT

- GIVEN a valid stored JWT
- WHEN navigating to `/profile/rewards`
- THEN the profile page renders normally

#### Scenario: Expired or missing JWT

- GIVEN no JWT or expired JWT
- WHEN navigating to `/profile/rewards`
- THEN redirect to `/login`
