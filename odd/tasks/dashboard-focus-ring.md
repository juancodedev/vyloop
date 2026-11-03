# ODD — Dashboard and landing focus ring contrast

> Objective: give the dashboard and the landing page a focus indicator that meets WCAG's 3:1 non-text contrast. Status: **pending — not started**.
> Delivery strategy: one small PR. Test runner: `npx vitest run` in apps/dashboard, `npx tsc --noEmit`.

## Specs

- **S1 — The defect (measured 2026-11-03).** The focus ring is the brand yellow `#f2c230`, which measures **1.60:1** on the paper `#fafaf7` and **1.68:1** on white. A focus indicator needs 3:1 (WCAG 2.2 SC 1.4.11 / 2.4.13). Keyboard users cannot reliably see where focus is.
  - `apps/dashboard/src/app/globals.css:116-119` — global `:focus-visible { outline: 3px solid var(--yellow); }`
  - `apps/dashboard/src/app/globals.css:76` — `--border-focus: var(--yellow);`
  - `apps/dashboard/src/app/(landing)/landing.module.css:602-605` — `.faqQuestion:focus-visible` uses the same yellow outline.

- **S2 — Form inputs (same area, found alongside).** `.form-control:focus` (`apps/dashboard/src/app/globals.css:708-712`) sets `outline: none` and replaces it with `box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12)`, a 12% blue that is not from the dashboard palette and is too faint to read as a focus indicator.

- **S3 — The reference fix already shipped in customer-web.** Customer-web adopted the dashboard palette (#329) but kept a blue focus ring, `#1e67b1`, which measures 5.53:1 on the paper and 5.78:1 on white. Its contract test (`apps/customer-web/app/globals.contract.test.ts`) checks the ring's contrast on both backgrounds. Options to decide when the work starts:
  1. Use the same blue `#1e67b1`, for one focus colour across the product.
  2. Use the primary green `#1f4d3a` (9.21:1 on the paper).

  Either way, the green sidebar (`#1f4d3a`) keeps the yellow: on green the yellow measures 5.75:1, while the blue measures 1.66:1 and the green 1:1. The fix is a light-surface ring plus a sidebar-scoped yellow ring, not one colour everywhere.

- **S4 — Out of scope.** Typography (Inter in customer-web vs Instrument Sans + Bricolage Grotesque in the dashboard) is a separate design debt.

## Tasks

- [ ] T1 (S1-S3) — Replace the yellow ring and the input shadow, check the sidebar and every dark surface, and add a contrast test like customer-web's. Route: inline.

## Log

- L1 (2026-11-03) — The user asked to record the dashboard focus-ring contrast defect as pending: "anotalo como pendiente".
