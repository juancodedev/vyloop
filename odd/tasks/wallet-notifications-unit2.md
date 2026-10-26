# Wallet Notifications — Unit 2: venue locations on the pass, kept in step

Objective: finish Unit 2 of `openspec/changes/wallet-notifications` — the pass carries
`merchantLocations` for consenting customers and the wallet keeps them in step when consent or
venues change. Branch `feat/wallet-merchant-locations`; delivery strategy `ask-on-risk`; runner
`pnpm --filter @vyloop/wallet test`.

## Specs

S1. A consenting customer's object carries the positions of the business's active, located
venues: "The loyalty object of a customer with a granted `nearby_notifications` consent MUST
carry, in `merchantLocations`, the positions of the business's venues that are active and have
both `latitude` and `longitude`. It MUST carry at most 10 of them, the limit Google accepts per
object." (authorised by `openspec/changes/wallet-notifications/specs/google-wallet/spec.md`)

S2. "When the business has more than 10 such venues, the object MUST carry the 10 whose
coordinates were updated most recently."

S3. "The loyalty object of a customer without that consent, or with it withdrawn, MUST carry no
`merchantLocations`. The loyalty class MUST carry no `merchantLocations`, because a class reaches
every holder regardless of consent."

S4. "The wallet worker MUST synchronise the `merchantLocations` of the affected objects when: a
customer grants or withdraws `nearby_notifications`: that customer's object; a venue is
registered, moved, deactivated or reactivated: the objects of the business's consenting
customers."

S5. "A withdrawn consent MUST be reflected on the pass without waiting for a periodic sweep. A
synchronisation MUST NOT set `notifyPreference`, so it is never a push notification."

S6. Scenarios that must hold (verbatim from the spec): "A consenting customer holds a pass … its
`merchantLocations` holds the three positions"; "A customer without the consent … its
`merchantLocations` is empty"; "A venue without a position … that venue is not in
`merchantLocations`"; "More than ten venues … `merchantLocations` holds exactly ten positions";
"The class never carries locations"; "The customer withdraws the consent … the object is patched
with empty `merchantLocations` AND the patch carries no `notifyPreference`"; "A venue is
deactivated … those objects no longer carry its position".

Scope note (assumption, recorded): consent rows are keyed by `customers.id` everywhere the
platform honours them (`workers/communication`, `readConsentMap`). The identity consent routes
introduced in #279 write and read `claims.sub`, which is `customers.global_id`, so those rows are
invisible to every reader. Unit 2 cannot work without resolving it; S4 is implemented against the
internal id and the identity routes are corrected to match.

## Tasks

- [x] T1. `WalletStore.listConsentingPasses(tenantId, { after, limit })` + drizzle query joining
      `customer_wallet_passes` with `consents` (granted `nearby_notifications`, state `issued`),
      keyset on `customer_id`. S4.
- [x] T2. `workers/wallet/src/locations-sync.ts`: `syncCustomerLocations` (patch always carries
      `merchantLocations`, `[]` included, never `notifyPreference`) and `syncBusinessLocations`
      (concurrency-bounded fan-out, returns `synced`/`failed`/`nextCursor`). S1-S5.
- [x] T3. Export `syncLocations({ tenantId, customerGlobalId?, businessWide? })` from the wallet
      worker's default export. S4.
- [x] T4. Identity: resolve `customers.id` from `claims.sub` before reading/writing consents, so
      the row lands where `readConsentMap` reads it. S4.
- [x] T5. Identity: schedule the wallet sync after a consent change (the customer) and after
      venue create/update/deactivate (the business), best effort over the existing `WALLET`
      service binding, never failing the request. S4-S5.
- [x] T6. Tests: wallet sync scenarios (S6), selector/object cases already green, identity route
      behaviour for both triggers.
- [x] T7. OpenSpec bookkeeping: mark implemented tasks, archive the finished changes.

## Log

L1 (verbatim): "si, arranquemos unidad 2 y lo que este listo hay que marcalos como listo y
archivar"

L2: Verified before writing: `pnpm --filter @vyloop/wallet typecheck` exit 0 and
`pnpm --filter @vyloop/wallet test` 801/801 passing with the uncommitted Unit 2 work in place.

L4 (2026-10-26): Implemented and committed as ccad530. Typecheck + tests green (wallet 808/808,
identity 172/172). Openspec wallet-notifications now 16/28 (Units 1-2 done). Archived
branch-geolocation, enable-nearby-consent, pages-opennext-migration, push-campaign-composer.
