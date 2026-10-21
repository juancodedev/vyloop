# Proposal: Wallet Notifications

## Intent

Let a Google Wallet loyalty pass notify its holder in two ways:

1. **Nearby notifications.** The pass carries the positions of the business's
   venues, so Google shows the pass on the lock screen when the holder is at
   one of them.
2. **Manual messages.** An operator writes a message in the dashboard and sends
   it to the business's pass holders, as a Google Wallet message that triggers
   a push notification.

Today neither exists. The only push channel is Web Push (`push-notifications`),
and the wallet worker deliberately sends no notification: `reconcile.ts:43` and
`sweep.ts:111` keep `notifyPreference` off every patch, and no code calls
`addMessage`.

## Why now

The venue positions already exist (`2026-10-20-venue-geolocation`): `branches`
carries `latitude`/`longitude`, and the identity worker exposes the venue
routes. Google made nearby notifications available for every regular pass type
on 2025-10-14. The storage and the routes are there, but no operator can fill them: the
dashboard only lists venues to scope rewards (`apps/dashboard/src/lib/api.ts:668`)
and has no form to register a venue or its position (`docs/19` F4, never
started). Without that form no venue has coordinates, and every pass would carry
empty `merchantLocations`. So the venue form is the first step of this change.

The manual message is the feature the competition sells as "push to the
wallet" (see `docs/analisis.md`). Sending it without the rules below would put
the issuer account at risk: Google throttles issuers it considers spammers.

## Google's rules this change is built on

Verified against the Google Wallet loyalty-card documentation on 2026-10-21.

| Rule | Source |
| --- | --- |
| "You can add up to 10 locations per class and 10 per object." | Trigger Push Notifications, loyalty cards |
| Google decides the distance and the notification text of a nearby notification; the notification disappears when the holder leaves. | same |
| Nearby notifications need "precise, always on location access to the Google Wallet app". | same |
| A message notifies only with `messageType: TEXT_AND_NOTIFY`. | same |
| "You may send a maximum of 3 messages that trigger a push notification in a 24 hour period." More yields `QuotaExceededException`. | same |
| Update notifications share the same 3-per-24h budget. | same, page summary |
| "It is a violation of the Acceptable Use Policy to send users to links not related to the pass." | same |
| Google may throttle the quota of an issuer it deems to be spamming. | same |
| `merchantLocations` replaces the deprecated `locations`. | LoyaltyClass reference |

## Scope

### In Scope

1. `growth-dashboard`: a "Venues" section under Settings to register, edit and
   deactivate venues and set each one's position with a map pin, on the
   existing identity routes. No backend change.
2. `google-wallet`: the pass object of a consenting customer carries up to 10
   `merchantLocations` from the business's active, located venues, kept in step
   when venues or consent change.
3. `google-wallet`: an operator route that sends one message to the eligible
   pass holders of the business, per object, with a notification budget the
   worker tracks itself.
4. `growth-dashboard`: a "Wallet" section under Communication to write, preview
   and send a message, and to see its delivery counts.
5. `docs/08` gains the new route; `docs/19` records the Google channel.

### Out of Scope

- **Update notifications** (`notifyPreference`). Balance changes stay silent,
  as `reconcile.test.ts:776` requires.
- **Apple Wallet.** No Apple pass exists yet.
- **Scheduled or automated wallet messages.** Automations can call the same
  route later; this change ships the manual send only.
- **Customer device positions.** Google evaluates proximity on the device;
  vyloop never receives the holder's position.

## Approach

- **Locations on the object, not the class.** A class is shared by every holder
  of the business, so class-level locations would reach customers who never
  granted `nearby_notifications`. `docs/10` §13 requires that consent to be
  separate and revocable. Object-level locations make consent enforceable per
  customer.
- **Messages per object, not on the class.** A class message reaches every
  holder, again regardless of consent. Per-object `addMessage` lets the worker
  skip customers without consent and count each object's budget.
- **The worker keeps its own budget ledger.** Google's quota is per pass and
  shared with update notifications. The worker records each notifying message
  per object and, when an object has used its budget, sends the message as
  `TEXT` (shown on the card, no notification) instead of failing.

## Risks and Rollback

| Risk | Mitigation | Rollback |
| --- | --- | --- |
| Issuer throttled for spam | Per-business daily send limit (Q3); links restricted to the business's pass-related URLs | Disable the route with a feature flag |
| A revoked consent keeps locations on the pass | Consent revocation patches the object in the same flow that records it | Run the object sweep with locations cleared |
| Large business: one send = thousands of `addMessage` calls | Fan out through the existing queue, one job per object, idempotent on `(message_id, object_id)` | Stop the consumer; already-sent messages can be removed with `patchObject` |

## Open Questions

See `tasks.md` Unit 0. The spec marks every answer it assumes.
