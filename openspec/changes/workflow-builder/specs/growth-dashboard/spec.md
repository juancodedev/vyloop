# Delta for growth-dashboard

## ADDED Requirements

### Requirement: Flujos Page

The Flujos page (`/dashboard/communication/workflows`) MUST list the business's
workflows with their name, trigger in words, setting, template and an on/off
switch. It MUST create and edit them with a guided form, never raw JSON:

1. **Nombre.**
2. **Cuándo**: one of "Se registra", "Está de cumpleaños", "Canjea un premio",
   "Llega a cierta cantidad de puntos", "Lleva tiempo sin venir".
3. **The trigger's setting**, shown only for its trigger: a points amount, or
   a number of days (7–365).
4. **Mensaje**: a select of the business's approved WhatsApp templates, with the
   template's body previewed. When there are none, the form MUST say so and
   link to Plantillas instead of offering an empty select.
5. **Datos del mensaje**: one select per `{{n}}` placeholder in the body, from
   the supported customer fields, labelled in Spanish.

The page MUST state that only customers who accepted WhatsApp messages
receive them. Deleting a workflow MUST ask through the in-app confirmation
dialog. A `400 VALIDATION_ERROR` MUST be shown next to the field it names.

#### Scenario: No approved template

- GIVEN a business with no approved WhatsApp template
- WHEN the merchant opens the new-workflow form
- THEN the form says there is no approved template yet
- AND links to Plantillas
- AND the save button is disabled

#### Scenario: The setting follows the trigger

- WHEN the merchant chooses "Lleva tiempo sin venir"
- THEN a days field appears, prefilled with 30
- WHEN they choose "Está de cumpleaños"
- THEN no setting field is shown

### Requirement: Coming Soon Until Shipped

Until the routes in the automation-engine delta are deployed, the sidebar MUST
list Flujos as "Próximamente", not as a link, and the page MUST show a notice
and make no API call. Shipping the page MUST remove the `comingSoon` flag in
`apps/dashboard/src/lib/navigation.ts`.

#### Scenario: Before the routes exist

- WHEN the merchant opens the sidebar
- THEN Flujos shows "Próximamente" and cannot be clicked
