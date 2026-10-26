# Wallet Notifications — Unit 3: storage

Objective: deliver the storage layer for manual wallet messages — the two tables, the
`promotions` consent type in the shared registry, and the 24h budget query — so Unit 4 can
build the send route on top of it. Branch `feat/wallet-merchant-locations`.

## Specs

S1. Migration: `wallet_messages` (id, business_id, header, body, link, created_by, created_at)
    and `wallet_message_deliveries` (message_id, object_id, mode `notify|text`, status,
    delivered_at), primary key `(message_id, object_id)`; both tables in
    `BUSINESS_ID_TABLES`. (openspec/changes/wallet-notifications/tasks.md Unit 3.1)

S2. "Add the consent type decided in Q2 to `CONSENT_TYPES` and the customer-web consent list."
    (Q2 = `promotions`, off by default.) Q2 says the push-campaign gate still reads
    `nearby_notifications`, which contradicts docs/10 §15; out of scope here.

S3. Budget query: notifying deliveries per object in the last 24h. (Unit 3.3)

S4. Q3: daily limit per business = 1 per business per day, as a constant in code, not a column.

S5. Q4: `header` 1-40 chars, `body` 1-300 chars, declared once in `WALLET_MESSAGE_LIMITS`
    in `@vyloop/types` so the form and the route cannot disagree.

## Tasks

- [x] T1. Add `walletMessages` and `walletMessageDeliveries` to `packages/db/src/schema.ts` with the
      types exported. S1.
- [x] T2. Add both tables to `BUSINESS_ID_TABLES` in `packages/db/src/rls.ts`. S1.
- [x] T3. Generate and ship migration 0023. S1.
- [x] T4. Add `promotions` to `CONSENT_TYPES` in `packages/types`. S2.
- [x] T5. Add `WALLET_MESSAGE_LIMITS` to `packages/types`. S5.
- [x] T6. `WalletStore` budget query + drizzle impl. S3.
- [x] T7. Tests. S1-S5.
- [x] T8. OpenSpec bookkeeping (mark tasks).

## Log

L1 (verbatim): "veamos esto primero" (then reported the audit error; resolved via allowlist PR #284)
L2 (2026-10-26): Starting Unit 3. Last migration is 0022 (flimsy_red_skull); next is 0023.
