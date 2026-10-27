# Customer Profile Redesign — Phase 1: frontend with the current API

Objective: rebuild `/profile` in `apps/customer-web` so a customer sees, in order: who
they are, how close the next redemption is, what recent purchases earned, and their own
data. QR moves out of the scroll into a fixed button. Phase 1 uses the current API only
(no purchase amount yet). Branch `feat/customer-profile-redesign`.

## Specs

S1. Points are earned by purchase amount, not by visit. No stamps/punch-card metaphors.
    Progress is a bar with numbers. (proposal §Decisions 1)

S2. Everything counted in points (the program's `pointsCurrency`). A reward's name is never
    used as a unit. (§Decisions 2)

S3. Identity card shows one figure: the points balance. No visit/purchase counts. (§Decisions 3)

S4. Recent activity is a list of purchases: amount spent, date, points earned, resulting
    balance. No item detail. Closes with one line about how close the next redemption is.
    (§Decisions 4)

S5. Date helpers: `formatMovementDate` (relative up to 6 days, then "28 sep", year when not
    current), `formatClp`, `initials`. (task 1.1)

## Tasks (Phase 1)

- [ ] 1.1 Date helpers in `apps/customer-web/app/lib/format.ts` + unit tests. S5.
- [ ] 1.2 `ProfileTopBar` and `IdentityCard`. Behavior tests.
- [ ] 1.3 `PurchaseTimeline` (replaces `Activity`, keeps `buildTimeline`). Behavior tests.
- [ ] 1.4 `PersonalData` read-only list.
- [x] 1.5 `QrDock` + `QrSheet` (dialog, focus trap, Esc, wake lock, member code). Remove inline `MemberQr`.
- [ ] 1.6 `WalletCard` compact variant.
- [ ] 1.7 Recompose `app/profile/page.tsx`. Update `profile.behavior.test.tsx` and `profile.contract.test.ts`.
- [ ] 1.8 Styles in `globals.css` with design-system tokens. Check 360px + reduced motion.

## Log

L1 (verbatim): "vamos por customer-profile-redesign"
