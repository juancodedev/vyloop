# ODD — Plan limits (Local / Plus / Pro)

> Objective: make the product enforce what each published plan includes. Status: **pending — not started**. Only the landing's pricing section shipped (branch `feat/landing-value-sections`).
> Delivery strategy: to be decided when the work starts. Test runner: `npx vitest run` per app/worker, `npx tsc --noEmit`.

## Specs

- **S1 — The plans, as published on the landing.** The user approved them on 2026-11-03 ("si, me sirven esos planes"):

  | Plan | Monthly (CLP) | Includes |
  |---|---|---|
  | Local | $19.990 | Google Wallet card, points by purchase amount, POS screen, 1 branch |
  | Plus | $34.990 | Everything in Local + up to 4 campaigns per month |
  | Pro (recommended) | $39.990 | Unlimited campaigns, tiers and rewards, "Quién dejó de venir", up to 3 branches |

  Annual billing: 2 months free. Pricing follows the decoy effect: Plus exists so Pro reads as the better deal ("Por $5.000 más que Plus, campañas sin límite y todo lo demás").

- **S2 — Enforcement is a later iteration.** The user said: "lo de el "limite", lo podemos hacer en otra iteracion, pero debemos dejarlo documentado como tarea a hacer, donde, luego haremos la implementacion con las spec y todo ese proceso."

- **S3 — Current state (verified 2026-11-03).**
  - `tenants.plan` exists (`packages/db/src/schema.ts:74`) and defaults to `'free'`. Self-service signup never writes it (`workers/identity/src/business-signup.ts:121`).
  - The only plan checks today are `isPosPlan` (`workers/identity/src/auth.ts:85`) and the gateway rate limiter, which is keyed on the plan.
  - Nothing limits branches, campaigns, tiers or analytics by plan, and there is no billing. Every tenant gets every feature.

## Open questions (to resolve before the specs are final)

1. The plan values to store (`local` / `plus` / `pro`?), and what happens to existing `free` tenants.
2. How a tenant gets a plan: manual assignment by an operator first, or a payment flow. Payment is future work.
3. Campaign quota: what counts as one campaign (one `reference_id`?), and whether the month is the calendar month in America/Santiago.
4. Behavior at the limit: block with a message, or warn and suggest upgrading. The same question applies to the 4th branch on Pro.
5. Tiers on Local and Plus: signup always creates a first tier. Does "tiers" in Pro mean *more than one* tier?
6. Downgrade: what happens to extra branches or tiers that a tenant already has.
7. Whether the dashboard shows the current plan and its usage.

## Tasks

| ID | Specs | Task | Route | Status |
|---|---|---|---|---|
| T1 | S1–S3 | Resolve the open questions with the user and rewrite S1–S3 as final specs | inline | pending |
| T2 | S1 | Plan model: store the plan and assign it (operator path first) | TBD | pending |
| T3 | S1 | Enforce the branch limit | TBD | pending |
| T4 | S1 | Enforce the monthly campaign quota | TBD | pending |
| T5 | S1 | Gate tiers and "Quién dejó de venir" by plan | TBD | pending |
| T6 | S1 | Show plan and usage in the dashboard | TBD | pending |

## Log

- **L1 (2026-11-03, user, verbatim):** "si, me sirven esos planes / lo de el "limite", lo podemos hacer en otra iteracion, pero debemos dejarlo documentado como tarea a hacer, donde, luego haremos la implementacion con las spec y todo ese proceso."
- **L2 (2026-11-03):** The pricing section was added to the landing with no enforcement behind it, a known gap the user accepted. Until T2–T5 ship, every tenant can use every feature.
