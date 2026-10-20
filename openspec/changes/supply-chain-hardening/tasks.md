# Tasks: Supply-Chain Hardening

> Status: deferred — post-PMV. Units 1–2 and 3.1/3.2 implemented 2026-10-20; 2.5 (secret rotation) and 3.3–3.5 (override removal) still open.

## Review Workload Forecast

| Field                   | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| Estimated changed lines | ~450 (additions + deletions), excluding lockfile churn       |
| 400-line budget risk    | Low                                                         |
| Chained PRs recommended | No                                                          |
| Suggested split         | Three independent PRs: audit, TLS mode, override cleanup    |
| Delivery strategy       | ask-on-risk                                                 |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal                                   | Likely PR | Lines | Notes                                       |
| ---- | -------------------------------------- | --------- | ----- | ------------------------------------------- |
| 1    | Advisory audit and allowlist in CI     | PR #1     | ~220  | Independent.                                |
| 2    | `sslmode=verify-full` and its guard    | PR #2     | ~150  | Independent; includes a secret rotation.    |
| 3    | Inert override cleanup                 | PR #3     | ~80   | Independent; lockfile must stay identical.  |

## Unit 1: Advisory audit

- [x] 1.1 Look up the GHSA id and the exact dependency path of Dependabot alert #124 (`gh api repos/{owner}/{repo}/dependabot/alerts/124`) and record them.
- [x] 1.2 `scripts/audit-allowlist.json` — the schema (`id`, `package`, `path`, `reason`, `acceptedBy`, `expires`) and the #124 entry.
- [x] 1.3 `scripts/check-audit.mjs` — run `pnpm audit --json` (no `--fix`, no network beyond the registry), parse advisories, match against the allowlist by id + package, fail on unallowed `high`/`critical`, on expired entries and on a registry error; print allowed and stale entries. Pure functions exported for tests, as `check-dependency-overrides.mjs` does.
- [x] 1.4 `scripts/check-audit.test.mjs` — fixtures for: an unallowed high (fail), an allowed high (pass), an expired entry (fail), a second advisory id in an allowlisted package (fail), a moderate (pass, printed), a registry error payload (fail), a stale entry (pass, reported). Runs under the existing `Test operational scripts` step.
- [x] 1.5 `package.json` — `"deps:audit": "node scripts/check-audit.mjs"`.
- [x] 1.6 `.github/workflows/ci.yml` — a `Dependency audit` step in the `quality` job after `Install dependencies`, running `pnpm deps:audit`.

## Unit 2: Verified TLS

- [x] 2.1 Verify how `@neondatabase/serverless` (`^1.2.0`, used by `createDb` in `packages/db/src/index.ts`) treats `sslmode` in the connection string; record the finding in `docs/18-Verificacion-y-Seguridad-Operativa.md`. Apply the guard to `createDb` only if the driver reads it.
- [x] 2.2 `scripts/lib/database-url.mjs` — `assertVerifiedTls(url)` (throws unless `sslmode=verify-full`) and `isProductionHost(url)` (`ep-shiny-paper-aibbf0hk` endpoints); never prints the URL, only the host, per the masking rule in `docs/18-Verificacion-y-Seguridad-Operativa.md`.
- [x] 2.3 Call `assertVerifiedTls` before opening the pool in `scripts/check-migration-drift.mjs` (`observeDatabase`), `scripts/check-checkin-backlog.mjs`, `scripts/check-payment-reconciliation.mjs`; in `scripts/check-wallet-readiness.mjs` keep `rejectUnauthorized: false` (line 454) for non-production hosts and refuse it for the production host.
- [x] 2.4 `scripts/lib/database-url.test.mjs` and the existing script tests — `require`, `prefer`, `verify-ca`, missing `sslmode` and `disable` are refused; `verify-full` passes; the error message contains the host and not the password.
- [ ] 2.5 **(pending — production only)** Rewrite the `DATABASE_URL` GitHub secret with `sslmode=verify-full`; run the `migration-drift` job of `.github/workflows/deploy.yml` to confirm; update each worker's local `.dev.vars` (gitignored, not committed).
- [x] 2.6 `docs/18-Trabajo-Pendiente.md` — close the "`sslmode=require` se va a debilitar en silencio" entry, pointing at the guard.

## Unit 3: Override cleanup

- [x] 3.1 `scripts/check-dependency-overrides.mjs` — `--list-inert` prints `gate.inert` (already computed by `checkOverrides`) one per line with its key and selector; exit code unchanged.
- [x] 3.2 `scripts/check-dependency-overrides.test.mjs` — `--list-inert` lists exactly the inert entries of a fixture and does not change the exit code.
- [ ] 3.3 For each listed override except `react`, `react-dom` and `jsdom>undici`: remove it from `package.json` `pnpm.overrides`, run `pnpm install --lockfile-only`, keep the removal only if `git diff --quiet pnpm-lock.yaml`. Record the removed and the kept entries in the PR description.
- [ ] 3.4 `pnpm deps:overrides` and `pnpm -r test` green after the cleanup.
- [ ] 3.5 `docs/18-Trabajo-Pendiente.md` — update the override count stated in the "Hecho — hay un check que afirma que el grafo respeta sus overrides" section and in the header comment of `scripts/check-dependency-overrides.mjs`.
