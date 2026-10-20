# Delta for automation-engine

## MODIFIED Requirements

### Requirement: Opt-In Consent Filtering

Every automation dispatch path MUST verify that the customer has a granted `whatsapp` consent before publishing a `WhatsAppOutboundRequested` event. The consent MUST be read from the `consents` table. This condition MUST be implicitly applied in addition to any explicit workflow conditions.

A workflow's conditions MUST be evaluated against a context that exposes the customer's consents under `consent.<type>`, assembled from the `consents` table. The field path `consent.whatsapp` is therefore the supported form; `metadata.consent.whatsapp` is not, and a workflow using it no longer matches.

#### Scenario: Consent filter

- GIVEN customer matches all workflow conditions
- WHEN the customer has no granted `whatsapp` consent
- THEN no action dispatched
- AND `WorkflowTriggered` with `skipped=true` reason logged

#### Scenario: A revoked consent does not dispatch

- GIVEN a customer whose `whatsapp` consent has `granted = false`
- WHEN a workflow that targets that customer is evaluated
- THEN no action dispatched

#### Scenario: A condition reads the consent

- GIVEN a workflow with condition `{ "field": "consent.whatsapp", "operator": "eq", "value": true }`
- WHEN the customer has a granted `whatsapp` consent
- THEN the condition matches
