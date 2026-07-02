# Database Specification

## Purpose

PostgreSQL for 7 domains: RLS, indexes, Drizzle migrations.

## Requirements

### Requirement: Schema

Tables from v2.0 Database Design across all domains.

#### Scenario: Migration
- GIVEN a fresh Neon database
- WHEN `pnpm db:migrate` runs
- THEN 15 tables exist with FK + constraints. Re-run idempotent.

### Requirement: RLS

Every `business_id` table MUST enable RLS via `app.current_business_id`.

#### Scenario: Isolation
- GIVEN user for tenant A
- WHEN querying `customers`
- THEN only matching rows visible

### Requirement: Indexes

Partial indexes on `phone`, `last_visit_at`, `points_transactions`. GIN on `customers.metadata`.

#### Scenario: Phone scan
- GIVEN `idx_customers_phone`
- WHEN filtering `business_id + phone`
- THEN index scan, no seq scan
