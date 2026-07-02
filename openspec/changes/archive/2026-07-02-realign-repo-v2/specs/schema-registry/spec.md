# Schema Registry Specification

## Purpose

KV-backed schema storage, semver, CRUD, pre-publish validation.

## Requirements

### Requirement: Storage + Versioning

Schemas in Workers KV keyed `{event_type}:{version}`, JSON Schema format.

#### Scenario: Lookup
- GIVEN `PurchaseCompleted` at `v1.2.0`
- WHEN requesting `purchase_completed:v1.2.0`
- THEN exact schema returned

### Requirement: Validation

Ingestor MUST validate payloads. Invalid → 400 `SCHEMA_INVALID`.

#### Scenario: Invalid
- GIVEN payload missing a required field
- WHEN Ingestor validates
- THEN 400 `SCHEMA_INVALID`

### Requirement: CRUD

Endpoints to register, read, list, deprecate. Admin-only modify.
