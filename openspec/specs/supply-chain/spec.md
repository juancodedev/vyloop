# supply-chain Specification

## Purpose
Guard the dependencies and the database connections the repository controls:
every advisory is scanned in CI, accepted advisories expire, and no script opens a
`pg` pool over an unverified TLS connection. These are properties the repository
enforces on itself, not conventions a contributor has to remember.

## Requirements

### Requirement: Dependency Advisory Audit

Every pull request MUST run a dependency advisory audit (`pnpm deps:audit`, implemented by `scripts/check-audit.mjs` over `pnpm audit --json`) in the `quality` job of `.github/workflows/ci.yml`. The audit MUST fail on any `high` or `critical` advisory that no allowlist entry covers, and MUST fail when the registry cannot be queried. `moderate` and `low` advisories SHOULD be printed without failing.

#### Scenario: A new high advisory blocks the pull request

- GIVEN a resolved package with a `high` advisory and no allowlist entry for it
- WHEN the audit runs
- THEN it exits non-zero and names the advisory id, the package and the dependency path

#### Scenario: The registry is unreachable

- GIVEN `pnpm audit` cannot reach the registry
- WHEN the audit runs
- THEN it exits non-zero with a message saying the audit could not run
- AND it does not report a pass

### Requirement: Audit Allowlist With Expiry

Accepted advisories MUST be recorded in `scripts/audit-allowlist.json`, one entry per advisory, with `id`, `package`, `path`, `reason`, `acceptedBy` and `expires` (an ISO date). An entry MUST cover only the advisory id and package it names. An entry past its `expires` date MUST fail the audit. An entry matching no current advisory SHOULD be reported as stale without failing.

#### Scenario: A dismissed advisory is allowed until it expires

- GIVEN the `braces` advisory of Dependabot alert #124 with an allowlist entry expiring in the future
- WHEN the audit runs
- THEN the advisory is reported as allowed with its reason
- AND the audit passes

#### Scenario: An expired entry fails

- GIVEN an allowlist entry whose `expires` date has passed
- WHEN the audit runs
- THEN it exits non-zero and names the entry and its expiry

#### Scenario: An entry does not cover another advisory in the same package

- GIVEN an allowlist entry for one advisory id of `braces`
- WHEN a different `high` advisory id is reported for `braces`
- THEN the audit fails on the new advisory

### Requirement: Verified TLS For Database Connections

Every database connection string the repository controls (the `DATABASE_URL` secret consumed by `.github/workflows/deploy.yml` and the workers' `.dev.vars`) MUST use `sslmode=verify-full`. Every script under `scripts/` that opens a `pg` pool MUST refuse a URL whose `sslmode` is absent or anything other than `verify-full`, before connecting. A script MAY disable certificate verification only for a non-production host, and MUST refuse to do so for the production endpoint.

#### Scenario: A weaker mode is refused

- GIVEN `DATABASE_URL` ending in `sslmode=require`
- WHEN `pnpm db:drift` starts
- THEN it exits non-zero before opening a connection
- AND the message names `sslmode=verify-full`

#### Scenario: The production host cannot skip verification

- GIVEN `check-wallet-readiness.mjs` configured to skip certificate verification
- WHEN the URL's host is the production endpoint
- THEN the script refuses to connect

### Requirement: Override Hygiene

`scripts/check-dependency-overrides.mjs` MUST offer a `--list-inert` mode that prints every override whose selector selects no resolution in `pnpm-lock.yaml`, without changing its exit-code rules. An override MAY be removed from `pnpm.overrides` only when removing it leaves `pnpm-lock.yaml` unchanged after `pnpm install --lockfile-only`. Inert overrides MUST NOT be reported as violations.

#### Scenario: Inert overrides are listed

- GIVEN an override whose selector matches no resolved version
- WHEN `pnpm deps:overrides -- --list-inert` runs
- THEN the override is listed as inert
- AND the exit code is the same as without the flag

#### Scenario: An override that still shapes the lockfile is kept

- GIVEN an inert-looking override whose removal changes `pnpm-lock.yaml`
- WHEN the cleanup is applied
- THEN the override stays in `package.json`
