# Customer Web Specification

## Purpose

PWA registration form — QR scan landing page, customer data entry, and confirmation screen. Mobile-first responsive design.

## Requirements

### Requirement: Landing Page

The landing page MUST display a QR scan simulation or placeholder. It MAY include a manual "Start Registration" button as fallback.

#### Scenario: Landing renders
- GIVEN a visitor to the PWA
- WHEN the landing page loads
- THEN QR placeholder and "Start Registration" button are visible

### Requirement: Registration Form

The form MUST collect `fullName` (required), `phone` (required), `email` (optional), and `birthDate` (optional). On submit, the form MUST POST the payload to `POST /v1/customers` via the gateway.

#### Scenario: Valid submission
- GIVEN required fields filled with valid data
- WHEN user submits the form
- THEN POST to `/v1/customers` is called
- AND user is redirected to confirmation screen

#### Scenario: Missing required field
- GIVEN `fullName` or `phone` is empty
- WHEN user attempts to submit
- THEN inline validation error is shown
- AND no POST is made

### Requirement: Confirmation Screen

After successful registration, the system MUST display a thank-you screen with the customer's name and a summary message.

#### Scenario: Confirmation shown
- GIVEN registration POST succeeded
- WHEN confirmation screen renders
- THEN customer name is displayed
- AND a "Thank you" message is shown

### Requirement: Mobile-First Responsive

The PWA MUST render correctly on screens 320px wide and above. Touch targets MUST be at least 44x44px.

#### Scenario: Mobile viewport
- GIVEN a 375px wide viewport
- WHEN the form renders
- THEN all elements fit without horizontal scroll
- AND touch targets meet minimum size

### Requirement: Worker Deployment Runtime

The customer web application MUST be built with the OpenNext Cloudflare adapter (`@opennextjs/cloudflare`) and deployed as a Cloudflare Worker with static assets. The repository MUST NOT depend on `@cloudflare/next-on-pages`, and no route in `apps/customer-web/app` SHALL declare `export const runtime = 'edge'`.

The production build MUST still be produced by `next build`, so the guards in `apps/customer-web/next.config.mjs` that refuse an empty or `localhost` `NEXT_PUBLIC_API_URL` and an empty `NEXT_PUBLIC_VAPID_PUBLIC_KEY` MUST keep failing the build.

#### Scenario: Production build

- GIVEN `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` are set
- WHEN the deploy job runs the OpenNext build for `apps/customer-web`
- THEN the build produces a Worker bundle and its static assets
- AND the deploy publishes them as the `vyloop-customer-web` Worker

#### Scenario: Missing gateway URL still fails the build

- GIVEN `NEXT_PUBLIC_API_URL` is empty in a production build
- WHEN the OpenNext build runs
- THEN the build fails with the existing `NEXT_PUBLIC_API_URL is required` error
- AND nothing is deployed

### Requirement: Programme Page Path

`GET /program` MUST return the programme page with status 200 on the deployed Worker, without a file extension in the URL. The rewrite MUST live in `next.config.mjs` and no `public/_redirects` file SHALL claim the job. This MUST be proven against a served build, not only by a source-text test.

#### Scenario: Served request

- GIVEN the OpenNext build of `apps/customer-web` is running under the Workers preview or a deployed preview
- WHEN a client requests `/program`
- THEN the response status is 200
- AND the body is the content of `public/program/index.html`

### Requirement: Printed Hostname Continuity

Every URL under `https://vyloop-customer-web.pages.dev` that existed before the migration MUST keep resolving after it, because that hostname is printed in merchant QR codes and embedded in issued Google Wallet passes. After cut-over the Pages project MUST answer every path with a 301 to the same path and query string on the Worker's hostname. The Pages project MUST NOT be deleted.

#### Scenario: A printed QR code is scanned after cut-over

- GIVEN a QR code printed with `https://vyloop-customer-web.pages.dev/register?biz=cafe-central`
- WHEN a customer opens it after the cut-over
- THEN the Pages project answers 301 to `/register?biz=cafe-central` on the Worker's hostname
- AND the registration page loads for `cafe-central`

#### Scenario: A pass link opened after cut-over

- GIVEN a Google Wallet pass issued with a link to `https://vyloop-customer-web.pages.dev/profile`
- WHEN the holder taps the link
- THEN the request is redirected to `/profile` on the Worker's hostname
