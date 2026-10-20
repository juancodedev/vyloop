# Proposal: Consent Unification

## Intent

A customer's consent lives in two places that disagree, and neither of them is written.

The `consents` table — with `consent_type`, `granted`, `granted_at`, `revoked_at` and `ip_address` — is the model the specifications describe and the only one with an audit trail. It has **zero writes** anywhere in the repository. It is read by the customer worker and shown by the dashboard, and it is always empty.

The gate that actually runs is different: `workers/communication/src/routes.ts` reads `customer.metadata.consent.whatsapp` from a jsonb bag, and the automation worker reads the same bag in two more places. **That flag has no writer either.** So no customer can consent to anything, and no WhatsApp message can ever be sent.

The specifications describe a third thing: `consents.whatsapp_opt_in`, a boolean column that has never existed.

This change makes the `consents` table the single source of truth, gives it a writer, and points every gate at it.

## Scope

### In Scope

1. `consents` gains a unique index on `(business_id, customer_id, consent_type)`, so a consent is one row per type and can be upserted.
2. A closed consent-type vocabulary, shared by every process that has to agree on it.
3. `PUT /v1/customers` accepts a `consents` object and persists it, with `granted_at` on grant and `revoked_at` on revoke.
4. The communication worker's send gate reads the table.
5. The automation worker's consent filter and its condition-evaluation context read the table. The context still exposes `consent.<type>`, so a workflow's condition syntax does not change.
6. Spec deltas for `database`, `customer-crud`, `communication-whatsapp` and `automation-engine`.

### Out of Scope

- **Enabling the customer-web consent controls.** `apps/customer-web/app/register.contract.test.ts` deliberately asserts that the controls render as unavailable and stay out of the payload. Turning that on is a product decision about what the business asks a customer to agree to, not a consequence of unifying the model.
- **Service vs promotions granularity.** The customer-web offers "Mensajes de servicio" and "Promociones" as separate options. Splitting them is a policy question about which template category needs which consent, and it has a legal dimension. The vocabulary leaves room for it.
- **Push.** `nearby_notifications` is defined so push (F2) has a home, but nothing subscribes to it yet.
- **Migrating existing consents.** There are none: 0 rows in `consents`, and 0 customers with the jsonb flag set, in both production and the local database.

## Capabilities

### New Capabilities

- `consent-model`: the consent vocabulary, and the guarantee that a consent is one row per customer per type, with the timestamps that make a revocation auditable.

### Modified Capabilities

- `database`: `consents` gains its uniqueness constraint and becomes the authoritative store.
- `customer-crud`: registration accepts and persists consents.
- `communication-whatsapp`: the send gate reads the authoritative store instead of a jsonb flag.
- `automation-engine`: the implicit consent filter and the condition context read the authoritative store.

## Approach

**Storage.** `consents` becomes authoritative, one row per `(business_id, customer_id, consent_type)`. A grant writes `granted = true` and `granted_at = now()`. A revoke writes `granted = false` and `revoked_at = now()`. **The row is never deleted**: the history of what a customer agreed to, and when, is the reason the table has timestamps and an `ip_address`.

**Vocabulary.** `whatsapp` and `nearby_notifications`, in `@vyloop/types`, because a name that two processes spell differently is a name that means nothing. `whatsapp` keeps the semantics the automation's condition syntax already assumes.

**Read path.** One helper builds a consent map for a customer, and every gate uses it. The automation's evaluation context is assembled from that map, so `resolveField('consent.whatsapp', …)` keeps working and a workflow author is not asked to learn a new field path.

**Write path.** `PUT /v1/customers` accepts `consents: { whatsapp?: boolean, nearby_notifications?: boolean }`. Absent means "not mentioned"; `false` means "revoke". Only the types present are touched.

**Rollback.** Reverting is: drop the unique index, ignore the `consents` field on registration, and point the gates back at the jsonb. No data is destroyed by the rollback, because no data is destroyed by the change.

## Risks

- **A gate that reads a table nobody writes blocks everything.** That is the current state in a different shape, and the write path in this change is what makes it safe. The customer-web is not switched on in this change, so the number of consents in production stays at zero until a surface starts collecting them.
- **Automation conditions.** The condition syntax is preserved by assembling the context from the table, but the field a workflow may reference changes from `metadata.consent.whatsapp` to `consent.whatsapp`. There are 0 workflows in production, so nothing breaks; the `automation-engine` spec is updated to state the supported form.
