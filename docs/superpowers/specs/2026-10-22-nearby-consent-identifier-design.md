# Nearby Consent Identifier Alignment

## Goal

Make the “Avisos cercanos” consent send the identifier already accepted by the shared consent registry. Leave “Promociones y novedades” unchanged.

## Design

Change only the nearby-consent option name in the shared `ConsentList` from `nearbyNotifications` to `nearby_notifications`. The component is used on both registration and profile screens, so the same correction applies in both places. Keep the existing request payload shape and API route unchanged. Add or update a focused behavior assertion to verify the consent update sends `nearby_notifications` with the selected boolean value.

Do not map either consent to WhatsApp. Do not change the promotions identifier or add a backend consent type. The shared registry in `packages/types/src/index.ts` already accepts `nearby_notifications`.

## Verification

- Run the focused customer-web profile behavior test covering consent updates.
- Run the customer-web test suite once.
- Read back the changed option and test assertion; confirm registration and profile continue using the shared component.

## Risk

Risk: none — this changes the identifier sent by one shared UI option to match the existing registry; it does not change the server contract or persisted format.
