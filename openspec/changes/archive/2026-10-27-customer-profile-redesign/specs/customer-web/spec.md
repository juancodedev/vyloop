# Delta for customer-web

## ADDED Requirements

### Requirement: Profile Page Order

The `/profile` page MUST render, top to bottom: top bar, identity card, next
redemption card, recent purchases, wallet row, personal data, notifications,
account actions. A "Mostrar mi código" button MUST stay fixed at the bottom of
the viewport while the page scrolls.

#### Scenario: Loaded profile

- GIVEN an authenticated customer whose profile loads successfully
- WHEN `/profile` renders
- THEN the sections appear in the order above
- AND the "Mostrar mi código" button is visible without scrolling, at any scroll position

#### Scenario: Loading

- GIVEN the profile request is pending
- WHEN `/profile` renders
- THEN a skeleton of the identity card, the redemption card and three purchase rows is shown
- AND no spinner is shown

#### Scenario: Load error

- GIVEN `GET /v1/customers/me` fails
- WHEN `/profile` renders
- THEN `ClubError` is shown with "Reintentar"
- AND no name, balance, tier or reward is shown

### Requirement: Identity Card

The identity card MUST show an initials avatar, the full name, "Miembro desde
<month> de <year>", the tier chip when a tier is assigned, the points balance
with `program.pointsCurrency`, and the progress to the next tier. It MUST NOT
show visit counts or purchase counts.

#### Scenario: Initials

- GIVEN `fullName = "Juan Muñoz Castillo"`
- WHEN the identity card renders
- THEN the avatar shows "JM"

#### Scenario: Single-word name

- GIVEN `fullName = "Juan"`
- WHEN the identity card renders
- THEN the avatar shows "J"

#### Scenario: Tier and progress

- GIVEN `currentTierId` resolves to "Plata", `points = 30` and `nextTier = { name: "Oro", minPoints: 150 }`
- WHEN the identity card renders
- THEN it shows the chip "Nivel Plata"
- AND the line "Te faltan 120 puntos para el nivel Oro" with a 20% bar

#### Scenario: Top tier

- GIVEN a tier is assigned and `nextTier = null`
- WHEN the identity card renders
- THEN the line reads "Estás en el nivel más alto" and no bar is shown

#### Scenario: No program

- GIVEN `program = null` or `tiers = []`
- WHEN the identity card renders
- THEN no tier chip and no tier line are shown
- AND the existing "Tu programa se está configurando" status is shown

### Requirement: Next Redemption Card

The page MUST render a card titled "Tu próximo canje" from the server fields
`nextReward`, `affordableReward` and `affordableRewardsCount`. The client MUST
NOT choose the reward itself. All quantities MUST use `program.pointsCurrency`;
a reward's name MUST NOT be used as a unit.

#### Scenario: Progress toward a reward

- GIVEN `points = 30`, `affordableRewardsCount = 0` and `nextReward = { name: "Burger gratis", pointsCost: 100, pointsMissing: 70 }`
- WHEN the card renders
- THEN it shows the title "Burger gratis" and "Te faltan 70 puntos"
- AND a bar at 30% with the accessible name "30 de 100 puntos"
- AND the stub shows "100 puntos"
- AND a link "Ver los <activeRewardsCount>" to `/profile/rewards`

#### Scenario: A reward is already affordable

- GIVEN `affordableRewardsCount >= 1` and `affordableReward = { id: "r1", name: "Papas medianas" }`
- WHEN the card renders
- THEN it shows "Ya podés canjear Papas medianas"
- AND a "Canjear" button linking to `/profile/rewards/confirm?reward=r1`

#### Scenario: No rewards

- GIVEN `nextReward = null` and `affordableRewardsCount = 0`
- WHEN the page renders
- THEN the card is not rendered and no placeholder reward is shown

#### Scenario: Fields absent (older API)

- GIVEN the profile response has no `nextReward` field
- WHEN the page renders
- THEN the card is not rendered and no error is shown

### Requirement: Recent Purchases

The page MUST list at most 5 movements from `buildTimeline`, newest first. An
earn row with `purchaseAmount` MUST be titled "Compra de <amount in CLP>". Each
row MUST show the date, the points with direction, and the resulting balance.
The list MUST end with "Con <n> <unit> más, tu canje <reward name> es tuyo"
when `nextReward` is present.

#### Scenario: Purchase row

- GIVEN an earn transaction with `purchaseAmount = 11400`, `points = 20`, `balanceAfter = 30`, created 2 days ago
- WHEN the row renders
- THEN it shows "Compra de $11.400", "Hace 2 días", "+20 puntos" and "saldo 30"

#### Scenario: Earn without amount

- GIVEN an earn transaction with `purchaseAmount = null` and `note = "Bono de bienvenida"`
- WHEN the row renders
- THEN the title is "Bono de bienvenida"
- AND "$0" is never shown

#### Scenario: Redemption row

- GIVEN a redeem transaction with `points = 100` (positive magnitude) and `note = "Burger gratis"`
- WHEN the row renders
- THEN it shows "Canjeaste Burger gratis" and "−100 puntos"

#### Scenario: Old date

- GIVEN a movement created 30 days ago in the current year
- WHEN the row renders
- THEN the date reads like "28 sep", not "Hace 4 sem"

#### Scenario: Empty

- GIVEN no transactions and no visible events
- WHEN the section renders
- THEN it shows "Todavía no hay movimientos. Cuando sumes en el local, aparecen acá."

### Requirement: QR Sheet

Tapping "Mostrar mi código" MUST open a modal bottom sheet with the member QR
and, when available, the member code grouped in threes. The sheet MUST request
a screen wake lock and MUST tolerate its refusal.

#### Scenario: Open and close

- GIVEN the profile is loaded
- WHEN the customer taps "Mostrar mi código"
- THEN a dialog opens with the heading "Mostrale esto en caja" focused
- AND pressing Esc or "Listo" closes it and returns focus to the dock button

#### Scenario: Wake lock refused

- GIVEN `navigator.wakeLock.request` rejects or is undefined
- WHEN the sheet opens
- THEN the QR is shown and no error is shown

#### Scenario: Member code not minted

- GIVEN the wallet pass has not returned a member code
- WHEN the sheet opens
- THEN only the QR is shown, with "Tu código aparece cuando agregás la tarjeta a Wallet"

### Requirement: Personal Data

The page MUST list name, phone, email and birthday (day and month only).
Fields without a value MUST be omitted, not rendered as "-". An "Editar"
action MUST open a form for name, email and birth date; phone MUST stay
read-only.

#### Scenario: Missing email

- GIVEN `email` is undefined
- WHEN the section renders
- THEN no email row is shown

#### Scenario: Birthday

- GIVEN `birthDate = "1981-07-27"`
- WHEN the section renders
- THEN the row reads "Cumpleaños: 27 de julio"

#### Scenario: Save edit

- GIVEN the edit form with a new email "nuevo@example.com"
- WHEN the customer taps "Guardar cambios" and `PATCH /v1/customers/me` succeeds
- THEN the list shows the new email and the toast "Cambios guardados"

#### Scenario: Invalid email

- GIVEN the edit form with email "nuevo@"
- WHEN the customer taps "Guardar cambios"
- THEN no request is sent and the field shows "Ingresá un email válido, por ejemplo nombre@dominio.cl"

#### Scenario: Edit unavailable

- GIVEN the API does not support `PATCH /v1/customers/me` yet (Phase 4 not shipped)
- WHEN the section renders
- THEN no "Editar" action is shown

### Requirement: Spanish Dates and Units Everywhere on the Profile

Every date on `/profile` MUST be formatted in `es-CL`. No English relative
strings ("a year ago") MAY appear. No label MAY be rendered in all caps.

#### Scenario: No English dates

- GIVEN any profile data
- WHEN the page renders
- THEN no text matches `/\b(ago|year|month|day)s?\b/i`

### Requirement: Delete Account

The profile MUST offer "Eliminar mi cuenta". The first action MUST only open an
in-page confirm step that says the deletion cannot be undone and names the
balance lost when there is one. Only "Sí, eliminar mi cuenta" sends the
request; on success the web MUST sign out.

#### Scenario: Confirm before deleting

- WHEN the customer taps "Eliminar mi cuenta"
- THEN no request is sent
- AND the confirm step says "Esto no se puede deshacer"

#### Scenario: Deleted

- WHEN the customer confirms and the API answers 204
- THEN the session is closed and the customer lands on the home page
