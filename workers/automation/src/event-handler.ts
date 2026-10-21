import type { Message } from '@cloudflare/workers-types';
import { createDb, customers, workflows, readConsentMap } from '@vyloop/db';
import type { EventEnvelope } from '@vyloop/event-bus';
import { WHATSAPP_OUTBOUND_REQUESTED, createEnvelope, publish } from '@vyloop/event-bus';
import { logPrefix } from '@vyloop/request-context';
import { eq, and } from 'drizzle-orm';

import type { Bindings, Condition } from './helpers';
import { withRls, evaluateConditions, buildWorkflowTriggeredEvent } from './helpers';

/**
 * Log prefix for a queued event. The id travels in the envelope, so a failure
 * here is traceable back to the request that produced the event.
 */
function tag(event: EventEnvelope): string {
  const requestId = event.header.request_id;
  return requestId ? logPrefix('automation', requestId) : '[automation]';
}


// ---------------------------------------------------------------------------
// Queue consumer dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle a single domain event from the queue.
 *
 * Dispatches to the appropriate handler based on event type.
 */
export async function handleEvent(
  event: EventEnvelope,
  message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  switch (event.type) {
    case 'CustomerRegistered':
      return handleCustomerRegistered(event, message, env);
    case 'PointsAssigned':
      return handlePointsAssigned(event, message, env);
    case 'RewardRedeemed':
      return handleRewardRedeemed(event, message, env);
    default:
      console.warn(`${tag(event)} Unknown event type: ${event.type} — acking and skipping`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build customer data map for condition evaluation.
 *
 * The `consent` entry is assembled from the authoritative store — the
 * `consents` table — and not from a flag in the customer's metadata, which had
 * no writer and could say neither when the agreement began nor when it was
 * withdrawn. It is what makes `consent.whatsapp` the field path a workflow
 * author writes.
 */
function buildCustomerData(
  customer: Record<string, unknown>,
  consents: Record<string, boolean> = {},
): Record<string, unknown> {
  return {
    id: customer.id,
    global_id: customer.globalId,
    phone: customer.phone,
    email: customer.email,
    full_name: customer.fullName,
    birth_date: customer.birthDate,
    last_visit_at: customer.lastVisitAt,
    metadata: customer.metadata ?? {},
    consent: consents,
  };
}

/**
 * Check if a customer has consented to WhatsApp messaging.
 *
 * Takes the consent map, which is also what the evaluation context is built
 * from — so the implicit filter and a workflow's own `consent.whatsapp`
 * condition cannot answer from two different places.
 */
function hasWhatsAppConsent(consents: Record<string, boolean>): boolean {
  return consents.whatsapp === true;
}

/**
 * Build the payload for a WhatsAppOutboundRequested event from a workflow action.
 */
function buildOutboundPayload(
  customerId: string,
  businessId: string,
  action: { config?: { template_name?: string; parameters?: string[] } },
  _idempotencyKey: string,
): { template_name: string; parameters: Record<string, string> } | null {
  const templateName = action.config?.template_name;
  if (!templateName) {
    return null;
  }

  // Convert parameter list to a keyed object (e.g. ["{{customer.full_name}}"] → { "1": "..." })
  const params = action.config?.parameters ?? [];
  const parameters: Record<string, string> = {};
  params.forEach((param, index) => {
    parameters[String(index + 1)] = param;
  });

  return { template_name: templateName, parameters };
}

/**
 * Evaluate workflow conditions against customer data.
 */
function workflowConditionsPass(
  workflow: Record<string, unknown>,
  customerData: Record<string, unknown>,
): boolean {
  const conditions = (workflow.conditions ?? []) as Condition[];
  return evaluateConditions(conditions, customerData);
}

// ---------------------------------------------------------------------------
// CustomerRegistered handler
// ---------------------------------------------------------------------------

/**
 * Handle a CustomerRegistered event.
 *
 * Reads active workflows with trigger_type = 'customer_registered' for the
 * business. For each matching workflow, evaluates conditions and, if passed,
 * publishes a WhatsAppOutboundRequested event and a WorkflowTriggered event.
 */
async function handleCustomerRegistered(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as {
    customer_id: string;
    full_name: string;
    business_id: string;
  };
  const businessId = event.header.business_id;
  const customerGlobalId = payload.customer_id;

  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  // Resolve internal customer id
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.globalId, customerGlobalId)))
    .limit(1);

  if (!customer) {
    console.warn(
      `${tag(event)} Customer ${customerGlobalId} not found in business ${businessId} — skipping CustomerRegistered`,
    );
    return;
  }

  // Read active workflows
  const activeWorkflows = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.businessId, businessId),
        eq(workflows.isActive, true),
        eq(workflows.triggerEvent, 'customer_registered'),
      ),
    );

  if (activeWorkflows.length === 0) {
    console.log(`${tag(event)} No active customer_registered workflows for business ${businessId}`);
    return;
  }

  // The customer's consents, from the authoritative store. The gate and the
  // context are built from the same read, so they cannot disagree.
  const consents = await readConsentMap(db, {
    businessId,
    customerId: customer.id as string,
  });

  // Consent check.
  //
  // This path had no gate, and it is the one that needed it most: the
  // registration flow is where a customer says whether they agree to be
  // contacted, and the workflow it usually triggers is the welcome message. A
  // welcome sent to someone who declined is the failure the consent is
  // supposed to prevent.
  if (!hasWhatsAppConsent(consents)) {
    console.log(
      `${tag(event)} Customer ${customerGlobalId} has no WhatsApp consent — skipping CustomerRegistered`,
    );
    return;
  }

  const customerData = buildCustomerData(customer as unknown as Record<string, unknown>, consents);
  const customerInternalId = customer.id;

  // Process each matched workflow
  for (const workflow of activeWorkflows) {
    if (!workflowConditionsPass(workflow as unknown as Record<string, unknown>, customerData)) {
      console.log(
        `${tag(event)} Workflow ${workflow.id} conditions not met for customer ${customerInternalId}`,
      );
      continue;
    }

    const actions = (workflow.actions ?? []) as Array<{
      type: string;
      config?: Record<string, unknown>;
    }>;

    for (const action of actions) {
      if (action.type !== 'send_whatsapp') {
        console.log(
          `${tag(event)} Unknown action type ${action.type} in workflow ${workflow.id} — skipping`,
        );
        continue;
      }

      const outbound = buildOutboundPayload(
        customerInternalId,
        businessId,
        action as { config?: { template_name?: string; parameters?: string[] } },
        `${workflow.id}-${customerInternalId}-${Date.now()}`,
      );

      if (!outbound) {
        console.warn(`${tag(event)} Workflow ${workflow.id} has no template_name in action config`);
        continue;
      }

      // Publish WhatsAppOutboundRequested
      const whatsappEvent = createEnvelope(
        WHATSAPP_OUTBOUND_REQUESTED,
        { business_id: businessId, timestamp: new Date().toISOString() },
        {
          customer_id: customerInternalId,
          business_id: businessId,
          template_name: outbound.template_name,
          parameters: outbound.parameters,
          idempotency_key: `${workflow.id}-${customerInternalId}`,
        },
      );

      await publish(env.DELIVERY_QUEUE, whatsappEvent);

      // Publish WorkflowTriggered event
      const triggeredEvent = buildWorkflowTriggeredEvent(
        workflow.id,
        customerInternalId,
        businessId,
        'send_whatsapp',
        outbound.template_name,
        // skipped / skipReason stay unset; the id is the last parameter.
        undefined,
        undefined,
        event.header.request_id,
      );

      await publish(env.DOMAIN_EVENTS_QUEUE, triggeredEvent);

      console.log(
        `${tag(event)} CustomerRegistered triggered workflow ${workflow.id} for customer ${customerInternalId}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// PointsAssigned handler
// ---------------------------------------------------------------------------

/**
 * Handle a PointsAssigned event.
 *
 * Reads active workflows with trigger_type = 'points_milestone' for the
 * business. Evaluates conditions and threshold, checks consent, and publishes
 * WhatsAppOutboundRequested + WorkflowTriggered if all pass.
 */
async function handlePointsAssigned(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as {
    customer_id: string;
    points_assigned: number;
    total_points: number;
    reference_id: string;
  };
  const businessId = event.header.business_id;
  const customerId = payload.customer_id;

  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  // Read customer data
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, customerId)))
    .limit(1);

  if (!customer) {
    console.warn(`${tag(event)} Customer ${customerId} not found — skipping PointsAssigned`);
    return;
  }

  // The customer's consents, from the authoritative store.
  const consents = await readConsentMap(db, { businessId, customerId: customer.id as string });

  // Consent check
  if (!hasWhatsAppConsent(consents)) {
    console.log(
      `${tag(event)} Customer ${customerId} has no WhatsApp consent — skipping PointsAssigned`,
    );
    return;
  }

  // Read active workflows
  const activeWorkflows = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.businessId, businessId),
        eq(workflows.isActive, true),
        eq(workflows.triggerEvent, 'points_milestone'),
      ),
    );

  if (activeWorkflows.length === 0) {
    return;
  }

  const customerData = buildCustomerData(customer as unknown as Record<string, unknown>, consents);
  // Add points data for condition evaluation
  customerData.total_points = payload.total_points;

  for (const workflow of activeWorkflows) {
    if (!workflowConditionsPass(workflow as unknown as Record<string, unknown>, customerData)) {
      continue;
    }

    const actions = (workflow.actions ?? []) as Array<{
      type: string;
      config?: Record<string, unknown>;
    }>;

    for (const action of actions) {
      if (action.type !== 'send_whatsapp') continue;

      const workflowRecord = workflow as unknown as Record<string, unknown>;
      // Check threshold from workflow config if specified
      const threshold = (workflowRecord.threshold ?? 0) as number;
      if (threshold > 0 && payload.total_points < threshold) {
        console.log(
          `${tag(event)} PointsAssigned: customer ${customerId} total ${payload.total_points} < threshold ${threshold} — skipping`,
        );
        continue;
      }

      const outbound = buildOutboundPayload(
        customerId,
        businessId,
        action as { config?: { template_name?: string; parameters?: string[] } },
        `${workflow.id}-${customerId}-${Date.now()}`,
      );

      if (!outbound) continue;

      const whatsappEvent = createEnvelope(
        WHATSAPP_OUTBOUND_REQUESTED,
        { business_id: businessId, timestamp: new Date().toISOString() },
        {
          customer_id: customerId,
          business_id: businessId,
          template_name: outbound.template_name,
          parameters: outbound.parameters,
          idempotency_key: `${workflow.id}-${customerId}`,
        },
      );

      await publish(env.DELIVERY_QUEUE, whatsappEvent);

      const triggeredEvent = buildWorkflowTriggeredEvent(
        workflow.id,
        customerId,
        businessId,
        'send_whatsapp',
        outbound.template_name,
        // skipped / skipReason stay unset; the id is the last parameter.
        undefined,
        undefined,
        event.header.request_id,
      );

      await publish(env.DOMAIN_EVENTS_QUEUE, triggeredEvent);

      console.log(
        `${tag(event)} PointsAssigned triggered workflow ${workflow.id} for customer ${customerId}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// RewardRedeemed handler
// ---------------------------------------------------------------------------

/**
 * Handle a RewardRedeemed event.
 *
 * Reads active workflows with trigger_type = 'reward_redeemed' for the
 * business. Evaluates conditions, checks first_redeem if configured, and
 * checks consent. Publishes WhatsAppOutboundRequested + WorkflowTriggered.
 */
async function handleRewardRedeemed(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as {
    customer_id: string;
    points_redeemed: number;
    total_points_after: number;
    reference_id: string;
    reward_name?: string;
    reward_id?: string;
  };
  const businessId = event.header.business_id;
  const customerId = payload.customer_id;

  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  // Read customer data
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, customerId)))
    .limit(1);

  if (!customer) {
    console.warn(`${tag(event)} Customer ${customerId} not found — skipping RewardRedeemed`);
    return;
  }

  // The customer's consents, from the authoritative store.
  const consents = await readConsentMap(db, { businessId, customerId: customer.id as string });

  // Consent check
  if (!hasWhatsAppConsent(consents)) {
    console.log(
      `${tag(event)} Customer ${customerId} has no WhatsApp consent — skipping RewardRedeemed`,
    );
    return;
  }

  // Read active workflows
  const activeWorkflows = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.businessId, businessId),
        eq(workflows.isActive, true),
        eq(workflows.triggerEvent, 'reward_redeemed'),
      ),
    );

  if (activeWorkflows.length === 0) {
    return;
  }

  const customerData = buildCustomerData(customer as unknown as Record<string, unknown>, consents);
  customerData.reward_name = payload.reward_name;

  for (const workflow of activeWorkflows) {
    if (!workflowConditionsPass(workflow as unknown as Record<string, unknown>, customerData)) {
      continue;
    }

    const actions = (workflow.actions ?? []) as Array<{
      type: string;
      config?: Record<string, unknown>;
    }>;

    for (const action of actions) {
      if (action.type !== 'send_whatsapp') continue;

      const workflowRecord = workflow as unknown as Record<string, unknown>;
      // Check first_redeem flag — skip if customer has redeemed before
      const firstRedeemOnly = (workflowRecord.first_redeem ?? false) as boolean;
      if (firstRedeemOnly) {
        // We could check redemption history here
        // For now, we always pass through and let the condition handle filtering
        console.log(
          `${tag(event)} RewardRedeemed: first_redeem filter configured for workflow ${workflow.id}`,
        );
      }

      const outbound = buildOutboundPayload(
        customerId,
        businessId,
        action as { config?: { template_name?: string; parameters?: string[] } },
        `${workflow.id}-${customerId}-${Date.now()}`,
      );

      if (!outbound) continue;

      const whatsappEvent = createEnvelope(
        WHATSAPP_OUTBOUND_REQUESTED,
        { business_id: businessId, timestamp: new Date().toISOString() },
        {
          customer_id: customerId,
          business_id: businessId,
          template_name: outbound.template_name,
          parameters: outbound.parameters,
          idempotency_key: `${workflow.id}-${customerId}`,
        },
      );

      await publish(env.DELIVERY_QUEUE, whatsappEvent);

      const triggeredEvent = buildWorkflowTriggeredEvent(
        workflow.id,
        customerId,
        businessId,
        'send_whatsapp',
        outbound.template_name,
        // skipped / skipReason stay unset; the id is the last parameter.
        undefined,
        undefined,
        event.header.request_id,
      );

      await publish(env.DOMAIN_EVENTS_QUEUE, triggeredEvent);

      console.log(
        `${tag(event)} RewardRedeemed triggered workflow ${workflow.id} for customer ${customerId}`,
      );
    }
  }
}
