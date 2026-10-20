# Proposal: Supply-Chain Hardening

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Intent

Close three small gaps in how the repository guards its dependencies and its
database connections, each of which fails silently today:

1. **No advisory scanner runs in CI.** Neither `.github/workflows/ci.yml` nor
   `.github/workflows/deploy.yml` runs `pnpm audit`. The override gate
   (`scripts/check-dependency-overrides.mjs`) checks that the lockfile respects
   the overrides that exist; by its own docs it is "not an advisory scanner"
   (`docs/18-Trabajo-Pendiente.md`, "Lo que este check NO caza"). A new advisory
   with no override is seen only through Dependabot alerts, and a dismissed alert
   — #124, `braces` through `@cloudflare/next-on-pages` → `chokidar@3.6.0`, no
   patched version, dismissed as tolerable risk — leaves no record in the
   repository of who accepted it or until when.
2. **`sslmode=require` will weaken on a `pg` major bump.** Every connection
   string ends in `sslmode=require` (`docs/18-Trabajo-Pendiente.md`, "Pendiente —
   `sslmode=require` se va a debilitar en silencio"). With `pg` `^8.23.1`
   (`packages/db/package.json:23`, installed 8.23.1) `require` is an alias of
   `verify-full`. In `pg` v9 / `pg-connection-string` v3 it adopts libpq
   semantics: encrypted, certificate not verified. Nothing in the code would
   notice the change.
3. **`pnpm.overrides` carries entries that may no longer do anything.** The root
   `package.json` holds 46 overrides; the override gate already classifies 45 of
   them as inert (`checkOverrides` returns an `inert` list,
   `check-dependency-overrides.mjs:555-640`). After Dependabot #198 and #199 were
   merged (`docs/18-Trabajo-Pendiente.md:1076-1078`) more may have become inert.
   An inert override is not a risk, but a table of 46 entries nobody can explain
   hides the few that are load-bearing.

## Scope

### In Scope

1. `scripts/check-audit.mjs` (`pnpm deps:audit`): runs `pnpm audit --json`,
   fails on any `high` or `critical` advisory not covered by an allowlist entry,
   and fails on allowlist entries past their expiry.
2. `scripts/audit-allowlist.json`: one entry per accepted advisory, with the
   advisory id, the package, the dependency path, the reason, who accepted it and
   an expiry date. Dependabot #124 is its first entry.
3. A `Dependency audit` step in the `quality` job of `.github/workflows/ci.yml`.
4. `sslmode=verify-full` written explicitly in every connection string the
   repository controls, and a guard in each script that opens a `pg` pool
   refusing a URL whose `sslmode` is anything else.
5. A one-off cleanup of inert overrides, using a `--list-inert` mode added to
   `scripts/check-dependency-overrides.mjs`, removing only overrides whose removal
   leaves `pnpm-lock.yaml` byte-identical.
6. Documentation in `docs/18-Trabajo-Pendiente.md` and
   `docs/18-Verificacion-y-Seguridad-Operativa.md`.

### Out of Scope

- **Replacing `@cloudflare/next-on-pages`**, which is what would actually remove
  the `braces` path. That is the separate `pages-opennext-migration` change.
- **Bumping `pg` to v9.** This change makes the bump safe; it does not do it.
- **Turning the inert-override report into a gate.** The override gate's header
  explains why that would be switched off within a month; the report stays
  informational.
- **Secret scanning, SBOMs, provenance.** Separate concerns.

## Capabilities

### New Capabilities

- `supply-chain`: the advisory audit and its allowlist, the TLS mode of database
  connections, and the hygiene of `pnpm.overrides`. No existing spec covers
  dependency or connection policy.

### Modified Capabilities

- None.

## Approach

**An allowlist with an expiry, not `--audit-level` alone.** Raising the audit
level until the build is green hides the next advisory in the same package. A
per-advisory entry records the decision Dependabot's "dismiss" button records
only in GitHub's UI, and the expiry forces it to be re-made. The script parses
`pnpm audit --json` itself, so the matching rule (advisory id + package) does not
depend on which ignore settings the pinned pnpm (`9.15.9` locally) supports. A
registry error is a failure, not a pass: a check that passes when it could not
look is not a check.

**Example entry:**

```json
{
  "id": "<GHSA id from Dependabot alert #124>",
  "package": "braces",
  "path": "@cloudflare/next-on-pages > chokidar@3.6.0 > braces",
  "reason": "Build-time only; no patched version; removed by pages-opennext-migration.",
  "acceptedBy": "<GitHub handle>",
  "expires": "2027-01-31"
}
```

**Make the connection string say what it does.** The repository controls the
`DATABASE_URL` GitHub secret used by `deploy.yml` and the gitignored `.dev.vars`
of each worker. Each is rewritten to `sslmode=verify-full`. The scripts that open
a `pg` pool — `check-migration-drift.mjs`, `check-checkin-backlog.mjs`,
`check-payment-reconciliation.mjs`, `check-wallet-readiness.mjs` — share one
`assertVerifiedTls(url)` helper that throws on any other `sslmode`, so a `pg` v9
bump cannot weaken them silently. `check-wallet-readiness.mjs:454` sets
`ssl: { rejectUnauthorized: false }` deliberately for Neon development branches;
that exception is kept, documented, and refused when the URL's host is the
production endpoint. The workers connect through `@neondatabase/serverless`,
whose TLS handling is not the `pg` connection-string parser; whether it reads
`sslmode` at all is verified as the first task, and the guard is applied there
only if it does.

**Remove an override only when the lockfile proves it is dead.** For each entry
`--list-inert` reports, delete it, run `pnpm install --lockfile-only`, and keep the
deletion only if `pnpm-lock.yaml` is unchanged. The exact pins `react` and
`react-dom` are out of the cleanup (a pin "cannot be inert",
`check-dependency-overrides.mjs:585`), and so is the parent-scoped
`jsdom>undici`, which exists for a compatibility reason rather than an advisory.

## Risks

- **`pnpm audit` depends on the registry** being up; a registry outage blocks
  PRs. Accepted: the alternative is a gate that passes when it did not look.
- **A wrong `sslmode` in a secret breaks deploys.** The secret is write-only
  (`docs/18-Verificacion-y-Seguridad-Operativa.md`), so it is rewritten whole and
  tested with `pnpm db:drift` before the workers are redeployed.
- **Removing an override that guarded a future resolution.** Mitigated by the
  lockfile-unchanged rule and by the override gate, which still fails if a later
  resolution lands below an advisory floor of an override that remains.

## Rollback Plan

Each part reverts independently. The audit step is removed from `ci.yml` (or an
allowlist entry added) if it blocks unrelated work. The `sslmode` guard reverts
with its PR; the secret can be restored to `sslmode=require`, which under `pg` 8
is equivalent. Removed overrides are restored from the PR's diff of
`package.json` followed by `pnpm install`.
