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
