# Business Analytics Specification

## Purpose

KPI dashboard for merchants. Direct DB queries (no caching for PMV). Requires JWT with `role: admin`.

## Requirements

### Requirement: KPI Endpoint

`GET /v1/analytics/kpis` MUST return aggregated metrics from direct DB queries.

**Response**: `{totalCustomers, activeCustomers, totalPointsIssued, totalPointsRedeemed, redemptionRate, tierDistribution: {bronze, silver, gold, platinum}, rewardsClaimed}`

#### Scenario: KPI data returned

- GIVEN authenticated admin
- WHEN `GET /v1/analytics/kpis`
- THEN 200 with all metric fields
- AND values reflect current DB state

#### Scenario: Unauthorized access

- GIVEN no JWT or role != admin
- WHEN `GET /v1/analytics/kpis`
- THEN 401/403 via gateway auth

### Requirement: Analytics Dashboard

`/dashboard/analytics` MUST render KPIs in a responsive card layout matching the dashboard design system.

#### Scenario: Dashboard renders

- GIVEN authenticated admin
- WHEN navigating to `/dashboard/analytics`
- THEN KPIs are displayed in cards (4-column desktop, 2-column tablet, stacked mobile)
- AND each card shows label, value, and icon
