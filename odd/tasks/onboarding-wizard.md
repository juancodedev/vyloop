# ODD — Merchant onboarding wizard

> Objective: replace the 4-field signup with a short guided setup. The merchant configures the program first, sees the pass while doing it, and creates the account at the end. Status: **pending — not started**.
> Delivery strategy: to be decided when the work starts. Test runner: `npx vitest run` (apps/dashboard, workers/identity), `npx tsc --noEmit`.

## Specs

Source: the benchmark of Almendro's signup on 2026-11-03. The user asked "lo otro que quiero abordar es el oboarding, de ese sitio, revisalo". The proposal below was then approved with "si, procede". Items marked *assumption* still need the user's confirmation (T1).

- **S1 — Configure first, account last.** About 5 steps, one question per screen, with no more than Almendro's 16:
  1. Business name.
  2. How many pesos one point is worth, with a live example: "una boleta de $5.000 suma 5 puntos".
  3. First reward, picked from presets (for example: free coffee, % discount), or "decidir después".
  4. Branches (one / two / three or more).
  5. Account: email, password, your name, and acceptance of terms and privacy.
- **S2 — Live pass preview.** The Google Wallet pass preview updates on every step (name, balance example, reward).
- **S3 — Reassurance.** Every step says, in neutral Spanish, that everything can be changed later.
- **S4 — Plan from the pricing cards.** `/login?signup=true&plan=<local|plus|pro>` preselects the plan. *Depends on* `odd/tasks/plan-limits.md` T2 (plan model), so the param is only carried until then.
- **S5 — "Prueba tu tarjeta" as the last step.** The merchant scans their own QR and saves their own pass, so they live the customer's side once.
- **S6 — Attribution (assumption).** An optional "¿Dónde nos conociste?" question.
- **Out of scope:** Google login (later), social proof and "#1" claims, Apple Wallet.

## Facts the design starts from (verified 2026-11-03)

- Signup today: `apps/dashboard/src/app/login/page.tsx` (`SignupCard`). The fields are name, email, password and an optional full name. It calls `POST /v1/auth/business/signup` (`workers/identity/src/index.ts:811`), then logs in and goes to `/dashboard`.
- `signupBusiness` (`workers/identity/src/business-signup.ts:132`) creates the tenant, the admin, the program and a first tier in one transaction. Since branch `feat/landing-value-sections`, the program starts on `earn_by = 'purchase'` at 1 point per $1.000, with a minimum redemption of 100 points.
- The wizard can apply the steps 2–4 answers after login through the existing loyalty config, rewards and branches endpoints, so the signup contract does not have to change. *To confirm in T1.*
- A customer-facing privacy policy exists (PR #319). No merchant terms of service page was found.

## Open questions

1. Where the wizard's answers are written: through existing endpoints after login, or by extending the signup payload so everything is in one transaction.
2. Which reward presets to offer, and their default point costs.
3. Whether merchant terms of service need to be written before S1.5 can ask for acceptance.
4. Whether the wizard runs before the account (state kept client-side) or right after a minimal account.
5. Whether to ask S6.

## Tasks

| ID | Specs | Task | Route | Status |
|---|---|---|---|---|
| T1 | S1–S6 | Resolve the open questions with the user and finalize the specs | inline | pending |
| T2 | S1, S2, S3 | Wizard steps 1–4 with the live pass preview | TBD | pending |
| T3 | S1 | Account step, then apply the configuration | TBD | pending |
| T4 | S1 | Terms and privacy acceptance | TBD | pending |
| T5 | S5 | "Prueba tu tarjeta" final step | TBD | pending |
| T6 | S4 | `plan` param from the pricing cards (after plan-limits T2) | TBD | pending |
| T7 | S6 | Attribution question | TBD | pending |

## Log

- **L1 (2026-11-03, user, verbatim):** "lo otro que quiero abordar es el oboarding, de ese sitio, revisalo https://merchant.almendroapp.com/es/business/sign_up"
- **L2 (2026-11-03, user, verbatim):** "si, procede" (approving: fix the signup default mechanic and the demo credentials first, then write this document).
- **L3 (2026-11-03):** Pre-work done on `feat/landing-value-sections`:
  - The signup program now starts on purchase points.
  - The demo credentials hint and the `cafecentral` placeholder were removed from `/login`.
- **L4 (2026-11-03, follow-up found):** The gateway's public merchant page (`apps/gateway/src/merchant-page.ts:308`) says "Por cada peso gastado acumulas {earnRate}". That is false under both mechanics: it ignores `earn_by` and `earn_unit_amount`. This is a separate fix and is not part of this wizard.
