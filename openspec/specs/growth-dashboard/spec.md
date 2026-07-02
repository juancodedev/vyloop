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
