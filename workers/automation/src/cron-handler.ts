import { createDb, customers, workflows } from '@vyloop/db';
import { WHATSAPP_OUTBOUND_REQUESTED, createEnvelope, publish } from '@vyloop/event-bus';
import { eq, and, sql } from 'drizzle-orm';

import type { Bindings, Condition } from './helpers';
import { withRls, evaluateConditions, buildWorkflowTriggeredEvent } from './helpers';

// ---------------------------------------------------------------------------
// Birthday cron handler
// ---------------------------------------------------------------------------

/**
 * Handle the birthday cron trigger (daily).
 *
 * Queries active workflows with trigger_event = 'birthday' and, for each,
 * finds customers whose birth_date matches today's month/day.
 *
 * For matching customers, evaluates workflow conditions, checks consent,
 * and publishes WhatsAppOutboundRequested + WorkflowTriggered events.
 */
export async function handleBirthdayCron(env: Bindings): Promise<void> {
  console.log('[automation] Running birthday cron check');

  // Get all active birthday workflows across all businesses
  // We iterate per business because of RLS scoping
  const db = createDb(env.DATABASE_URL);

  // Query distinct business_ids that have active birthday workflows
  const businessResult = await db.execute<{ business_id: string }>(sql`
    SELECT DISTINCT business_id FROM workflows
    WHERE trigger_event = 'birthday'
    AND is_active = true
  `);

  const businessIds = (businessResult.rows ?? []) as Array<{ business_id: string }>;

  for (const { business_id: businessId } of businessIds) {
    await withRls(db, businessId);

    // Read active birthday workflows for this business
    const activeWorkflows = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.businessId, businessId),
          eq(workflows.isActive, true),
          eq(workflows.triggerEvent, 'birthday'),
        ),
      );

    if (activeWorkflows.length === 0) continue;

    // Query customers whose birthday matches today
    const today = new Date();
    const currentMonth = today.getMonth() + 1; // PostgreSQL EXTRACT uses 1-12
    const currentDay = today.getDate();

    const birthdayCustomers = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.businessId, businessId),
          sql`EXTRACT(MONTH FROM ${customers.birthDate}) = ${currentMonth}`,
          sql`EXTRACT(DAY FROM ${customers.birthDate}) = ${currentDay}`,
        ),
      );

    if (birthdayCustomers.length === 0) continue;

    // Process each workflow for each matching customer
    for (const workflow of activeWorkflows) {
      const actions = (workflow.actions ?? []) as Array<{ type: string; config?: Record<string, unknown> }>;

      for (const customer of birthdayCustomers) {
        const customerData = buildCustomerData(customer);
        const conditions = (workflow.conditions ?? []) as Condition[];

        // Evaluate workflow conditions
        if (!evaluateConditions(conditions, customerData)) {
          console.log(
            `[automation] Birthday workflow ${workflow.id} conditions not met for customer ${customer.id}`,
          );
          continue;
        }

        // Consent check
        if (!hasWhatsAppConsent(customerData)) {
          console.log(
            `[automation] Customer ${customer.id} has no WhatsApp consent — skipping birthday workflow ${workflow.id}`,
          );
          continue;
        }

        for (const action of actions) {
          if (action.type !== 'send_whatsapp') continue;

          const templateName = action.config?.template_name as string | undefined;
          if (!templateName) continue;

          const params = (action.config?.parameters as string[] | undefined) ?? [];
          const parameters: Record<string, string> = {};
          params.forEach((param, index) => {
            parameters[String(index + 1)] = param;
          });

          // Publish WhatsAppOutboundRequested
          const whatsappEvent = createEnvelope(
            WHATSAPP_OUTBOUND_REQUESTED,
            { business_id: businessId, timestamp: new Date().toISOString() },
            {
              customer_id: customer.id,
              business_id: businessId,
              template_name: templateName,
              parameters,
              idempotency_key: `${workflow.id}-${customer.id}-birthday`,
            },
          );

          await publish(env.DOMAIN_EVENTS_QUEUE, whatsappEvent);

          // Publish WorkflowTriggered
          const triggeredEvent = buildWorkflowTriggeredEvent(
            workflow.id,
            customer.id,
            businessId,
            'send_whatsapp',
            templateName,
          );

          await publish(env.DOMAIN_EVENTS_QUEUE, triggeredEvent);

          console.log(
            `[automation] Birthday trigger for customer ${customer.id} via workflow ${workflow.id}`,
          );
        }
      }
    }
  }

  console.log('[automation] Birthday cron check complete');
}

// ---------------------------------------------------------------------------
// Inactivity cron handler
// ---------------------------------------------------------------------------

/**
 * Handle the inactivity cron trigger (daily).
 *
 * Queries active workflows with trigger_event = 'inactivity' and, for each,
 * finds customers whose last_visit_at is older than the configured N days.
 *
 * For matching customers, evaluates workflow conditions, checks consent,
 * and publishes WhatsAppOutboundRequested + WorkflowTriggered events.
 */
export async function handleInactivityCron(env: Bindings): Promise<void> {
  console.log('[automation] Running inactivity cron check');

  const db = createDb(env.DATABASE_URL);

  // Query distinct business_ids that have active inactivity workflows
  const businessResult = await db.execute<{ business_id: string }>(sql`
    SELECT DISTINCT business_id FROM workflows
    WHERE trigger_event = 'inactivity'
    AND is_active = true
  `);

  const businessIds = (businessResult.rows ?? []) as Array<{ business_id: string }>;

  for (const { business_id: businessId } of businessIds) {
    await withRls(db, businessId);

    // Read active inactivity workflows for this business
    const activeWorkflows = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.businessId, businessId),
          eq(workflows.isActive, true),
          eq(workflows.triggerEvent, 'inactivity'),
        ),
      );

    if (activeWorkflows.length === 0) continue;

    for (const workflow of activeWorkflows) {
      const actions = (workflow.actions ?? []) as Array<{ type: string; config?: Record<string, unknown> }>;

      // Read inactivity threshold from workflow config (default 30 days)
      const workflowConfig = (workflow.actions?.[0]?.config ?? {}) as Record<string, unknown>;
      const inactivityDays = (workflowConfig.inactivity_days as number) ?? 30;

      // Query customers who haven't visited in N days
      const inactiveCustomers = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.businessId, businessId),
            sql`${customers.lastVisitAt} < NOW() - INTERVAL '${sql.raw(String(inactivityDays))} days'`,
          ),
        );

      if (inactiveCustomers.length === 0) continue;

      for (const customer of inactiveCustomers) {
        const customerData = buildCustomerData(customer);
        const conditions = (workflow.conditions ?? []) as Condition[];

        // Evaluate workflow conditions
        if (!evaluateConditions(conditions, customerData)) {
          continue;
        }

        // Consent check
        if (!hasWhatsAppConsent(customerData)) {
          continue;
        }

        for (const action of actions) {
          if (action.type !== 'send_whatsapp') continue;

          const templateName = action.config?.template_name as string | undefined;
          if (!templateName) continue;

          const params = (action.config?.parameters as string[] | undefined) ?? [];
          const parameters: Record<string, string> = {};
          params.forEach((param, index) => {
            parameters[String(index + 1)] = param;
          });

          // Publish WhatsAppOutboundRequested
          const whatsappEvent = createEnvelope(
            WHATSAPP_OUTBOUND_REQUESTED,
            { business_id: businessId, timestamp: new Date().toISOString() },
            {
              customer_id: customer.id,
              business_id: businessId,
              template_name: templateName,
              parameters,
              idempotency_key: `${workflow.id}-${customer.id}-inactivity`,
            },
          );

          await publish(env.DOMAIN_EVENTS_QUEUE, whatsappEvent);

          // Publish WorkflowTriggered
          const triggeredEvent = buildWorkflowTriggeredEvent(
            workflow.id,
            customer.id,
            businessId,
            'send_whatsapp',
            templateName,
          );

          await publish(env.DOMAIN_EVENTS_QUEUE, triggeredEvent);

          console.log(
            `[automation] Inactivity trigger for customer ${customer.id} via workflow ${workflow.id}`,
          );
        }
      }
    }
  }

  console.log('[automation] Inactivity cron check complete');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCustomerData(customer: Record<string, unknown>): Record<string, unknown> {
  return {
    id: customer.id,
    global_id: customer.globalId,
    phone: customer.phone,
    email: customer.email,
    full_name: customer.fullName,
    birth_date: customer.birthDate,
    last_visit_at: customer.lastVisitAt,
    metadata: customer.metadata ?? {},
  };
}

function hasWhatsAppConsent(customerData: Record<string, unknown>): boolean {
  const metadata = (customerData.metadata ?? {}) as Record<string, unknown>;
  const consent = (metadata.consent ?? {}) as Record<string, unknown>;
  return consent.whatsapp === true;
}
