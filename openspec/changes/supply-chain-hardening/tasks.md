# Tasks: Supply-Chain Hardening

> Status: done — all three units implemented 2026-10-20. Unit 3 removed 34 of the 43 inert overrides;
> 9 stayed because removing them changes a resolution (see 3.3).

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
| 3    | Inert override cleanup                 | PR #3     | ~80   | Independent; 34 removed, resolutions unchanged. |

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
- [x] 2.5 Rewrite the `DATABASE_URL` GitHub secret with `sslmode=verify-full`; run the `migration-drift` job of `.github/workflows/deploy.yml` to confirm; update each worker's local `.dev.vars` (gitignored, not committed). Done 2026-10-20: secret rotated 19:34 UTC, `migration-drift` green on the next deploy, 8 `.dev.vars` normalized (only the `sslmode` token changed).
- [x] 2.6 `docs/18-Trabajo-Pendiente.md` — close the "`sslmode=require` se va a debilitar en silencio" entry, pointing at the guard.
- [x] 2.7 `packages/db/src/tls.ts` — `assertVerifiedTls` ported from the scripts helper (the script runs on plain Node and cannot import the package), called by `createDb` before the `Pool` is constructed; `packages/db/src/tls.test.ts` covers `verify-full`, `require`, `prefer`, `verify-ca`, `disable`, `no-verify`, a missing `sslmode`, a non-URL, an empty value, loopback, and a message that names the host but never the password.

## Unit 3: Override cleanup

- [x] 3.1 `scripts/check-dependency-overrides.mjs` — `--list-inert` prints `gate.inert` (already computed by `checkOverrides`) one per line with its key and selector; exit code unchanged.
- [x] 3.2 `scripts/check-dependency-overrides.test.mjs` — `--list-inert` lists exactly the inert entries of a fixture and does not change the exit code.
- [x] 3.3 For each listed override except `react`, `react-dom` and `jsdom>undici`: remove it from `package.json` `pnpm.overrides`, run `pnpm install --lockfile-only`, keep the removal only if it changes no resolution. Done 2026-10-20: 34 of 43 removed, 9 kept (`brace-expansion@<1.1.18`, `cookie@<0.7.0`, `esbuild@<=0.24.2`, `fast-uri@>=3.0.0 <3.1.7`, `nanoid@<3.3.18`, `sharp@<0.35.4`, `undici@<6.27.0`, `undici@>=7.28.0 <7.29.1`, `ws@>=8.0.0 <8.21.0`). **The criterion as written could not work:** `pnpm-lock.yaml` records the `overrides:` table itself, so every removal — inert or not — edits the lockfile, and `git diff --quiet pnpm-lock.yaml` rejects all 43. The criterion used instead: the set of `packages:`/`snapshots:` keys is identical before and after (`git diff` outside the `overrides:` block is empty). Removals were applied one at a time and re-checked after each, because inert entries overlap: `sharp@<0.35.0` and `sharp@<0.35.4` are each inert alone and each covers for the other — dropping both drags sharp to 0.34.5.
- [x] 3.4 `pnpm deps:overrides` and `pnpm -r test` green after the cleanup. `deps:overrides` PASS with 12 overrides; full suite green on Node 22.23.1 (`pnpm -r --workspace-concurrency=1 --no-bail test`, 14 projects, 2,883 tests). On the default Node 20.20.2 the two Next apps cannot start a jsdom worker (`ReferenceError: Iterator is not defined`, `jsdom@30.1.2`), which is the pre-existing environmental failure, not the cleanup.
- [x] 3.5 `docs/18-Trabajo-Pendiente.md` — override count updated to 12, with the "inert is not removable" finding; header comment of `scripts/check-dependency-overrides.mjs` updated to the 9 remaining rewrites plus the same caveat.
