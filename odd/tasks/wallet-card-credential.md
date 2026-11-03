# wallet-card-credential

Objective: make the scannable member credential (Wallet barcode and customer-web QR) a rotatable opaque token, separate from `customers.global_id`. Implements points 2 and 3 of `docs/21-Hardening-Tarjetas-Wallet.md`.
Branch: `feat/wallet-card-credential`. Delivery: ask-on-risk (forecast > 400 lines, chain strategy asked before the second commit). Test runner: vitest per package (Node 22).

## Specs

- **S1 (token shape and storage).** The credential is `vyc1.<base64url>` derived as HMAC-SHA256(`CARD_TOKEN_SECRET`, tenant id, `customers.global_id`, `card_token_version`). The database stores only `customers.card_token_version` and `customers.card_token_hash` (SHA-256 hex of the token), unique per business. Only the wallet worker holds `CARD_TOKEN_SECRET`; resolvers hash what they scan.
- **S2 (legacy passes keep working).** Doc 21 §2.5: "Un pase emitido antes del cambio sigue funcionando: el POS acepta `global_id` en el barcode y resuelve por la ruta actual." A customer whose Google object already carries the uuid barcode gets no token until a rotation rewrites that barcode, so their uuid keeps resolving.
- **S3 (new passes carry the token).** Doc 21 §2.5: "Un pase emitido después lleva el token y resuelve por `resolve`, con el mismo `known`/`fullName` que hoy." Adjusted (L3): the real scanner is the dashboard POS, so the token resolves through a new operator route in `workers/customer` returning the same customer shape as `by-global-id`.
- **S4 (rotation).** Doc 21 §2.5: "Existe una operación que rota el token de un pase, confirma el cambio leyendo el objeto, y deja el anterior inválido." Rotation bumps the version, patches the barcode of an existing Google object and confirms it with `confirmObjectBindings`.
- **S5 (rotated token is unknown).** Doc 21 §2.5: "Un token rotado devuelve `known: false` sin revelar si el pase existe." The token route answers a rotated token exactly as an unknown one.
- **S6 (object id stable).** Doc 21 §2.5: "`object_id` no cambia al rotar (test explícito)."
- **S7 (revocation path).** Doc 21 §3.3: "Existe al menos un camino de revocación de la credencial escaneable que no toque `global_id` ni `object_id`." User decision (L2): "Operador desde dashboard": a "Revocar QR" action on the POS customer view, with a mandatory reason.
- **S8 (audit).** Doc 21 §3.3: "La revocación queda auditada (quién, cuándo, por qué)." New table `customer_credential_revocations`, RLS by `business_id`.
- **S9 (no side effects).** Doc 21 §3.3: "Un test verifica que revocar no altera el saldo, el tier ni el historial."
- **S10 (everything on the token).** User decision (L4): "Todo al token". The customer-web QR shows the same token as the pass. The POS stops accepting the uuid of a customer who has a token. Rotating a legacy pass migrates it to the token.

## Tasks

| ID | Specs | Work | Route | Status | Commit |
|---|---|---|---|---|---|
| T1 | S1, S8 | Migration 0025: customer token columns + unique index, revocations table with RLS; schema, indexes and RLS lists | inline | pending | |
| T2 | S1, S2, S3, S10 | Wallet: card-token module, lazy `ensureCardToken` (legacy-safe), object builder uses the token, `GET /v1/wallet/card` | inline | pending | |
| T3 | S4, S6, S8, S9 | Wallet: `rotateCardToken` RPC (DB first, then barcode patch and confirmation, audit row) | inline | pending | |
| T4 | S3, S5, S7, S10 | Customer worker: `by-card-token` operator route; `by-global-id` refuses tokened customers; operator rotate route calling the wallet RPC | inline | pending | |
| T5 | S3, S7, S10 | Dashboard: parser accepts the token, POS resolves it, "Revocar QR" with reason | inline | pending | |
| T6 | S10 | Customer-web: QR shows the token from `GET /v1/wallet/card` | inline | pending | |
| T7 | all | Docs: doc 21 §2-3 status and corrections; onboarding secret `CARD_TOKEN_SECRET` | inline | pending | |

`passes/resolve` (growth) does not take the token in this feature: it only accepts `pos:` counters, and none can exist yet (`pos_terminals` has no writer). Left as follow-up.

## Log

- **L1 (2026-11-03, user):** "arrancalo ahora juntos" (points 2 and 3 of doc 21).
- **L2 (2026-11-03, user decision):** "Operador desde dashboard (Recomendado)" for who can rotate.
- **L3 (2026-11-03, evidence):** The only barcode reader is the dashboard POS camera (`apps/dashboard/src/app/dashboard/loyalty/pos/page.tsx:276`) calling operator-gated `GET /v1/customers/by-global-id/:globalId`; its parser `lib/pass-code.ts` accepts uuids only. `passes/resolve` never sees the barcode. Doc 21's "resolve by `passes/resolve`" is adjusted to the POS route.
- **L4 (2026-11-03, user decision):** "Todo al token (Recomendado)" for customer-web QR and issued passes.
- **L5 (design):** Token derived, not stored, so the wallet can re-render the save link and the customer-web QR without keeping the raw token. Rotation writes the DB first and then patches Google; a failed patch is reported and retried by re-running rotation sync without bumping the version.
