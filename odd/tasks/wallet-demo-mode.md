# Google Wallet — demo-mode test path and per-tenant switch

## Objective

Let a pass be minted while Google's pass class is still a draft, so the
integration can be exercised end to end, and give the operator a per-tenant
switch in the dashboard to declare whether the deployment has publishing
access.

## Problem

`classReadinessFor` requires `reviewStatus === 'approved'`. Google keeps a
new issuer in demo mode and reports the class as `draft` until the publishing
access request is granted — a grant Google makes, on Google's timeline, with no
way to test the integration before it arrives.

Google's own behaviour is narrower than the gate: in demo mode it allows pass
creation and limits *delivery* to the issuer's test accounts. So the gate is
stricter than the platform, and the cost of that strictness is that the signing
path, the save link and the sweep cannot be exercised at all.

A second blocker is not code: `tenant_wallet_programs` has no row, so
`findProgram` returns null and the answer is `class_not_provisioned` before
review status is even the question.

## Design

The two gates answer one question from two inputs:

| demo mode | class status | result |
| --- | --- | --- |
| on (default) | `draft` | mint; delivery limited by Google to test accounts |
| on | `approved` | mint |
| off | `approved` | mint |
| off | anything else | refuse, `class_not_approved` |

Effective demo mode is `env || db`. The environment variable stays as a
deployment-wide ceiling so an incident can stop every mint without editing
rows, and the database flag is the per-tenant switch. Default for the column is
`true`, so an absent or unreadable value refuses rather than claims readiness —
the asymmetry is documented in `parseDemoMode` and holds here too.

## Scope

- [ ] T1 migration: `demo_mode` boolean on `tenant_wallet_programs`, default true
- [ ] T2 schema: column, type, and the row type the store returns
- [ ] T3 gate: `classReadinessFor` takes the effective demo mode; draft is
      acceptable only while demo mode is on
- [ ] T4 store: read and write the flag, tenant-scoped
- [ ] T5 admin API: read and set the switch, operator-role gated like every
      other write in the app
- [ ] T6 dashboard: the toggle
- [ ] T7 data: insert the row for the tenant, with the status Google reports
- [ ] T8 verify: full gates, plus a minted pass reaching a test account

## Constraints

- Fail closed. Anything unrecognised, absent or unreadable means demo mode, and
  demo mode means "do not claim a pass works for the public".
- Never weaken tenant scoping. The flag is per tenant and every read and write
  keeps the tenant filter.
- The class id is derived, not stored by hand. The row records the issuer id
  and the class id, and the derivation is checked at read time.
- The row records what Google reports, not what would be convenient. `draft` is
  written as `draft`.
- No customer-web surface. The pass link stays behind the wallet routes.

## Verification

- Lint, typecheck, full suite, and the mutation harness.
- A mint against the draft class produces a signed link, and the object exists
  in the issuer account.
- With demo mode off and the class still draft, the mint is refused with
  `class_not_approved`.
- With the flag unreadable, the result is the same as demo mode on.

## Route

- T1–T5, T7: one writer, backend.
- T6: separate writer once the API shape is fixed.
