import { createDb, customers, readConsentMap, tenants, withTenantTransaction, workflows } from '@vyloop/db';
import { WHATSAPP_OUTBOUND_REQUESTED, createEnvelope, publish } from '@vyloop/event-bus';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import type { Bindings, Condition } from './helpers';
import { evaluateConditions, buildWorkflowTriggeredEvent } from './helpers';

// ---------------------------------------------------------------------------
// One tenant at a time
//
// `workflows`, `customers` and `consents` are tenant tables. Under row-level
// security their policy reads `current_setting('app.current_business_id')` with
// no default, so a query with no tenant set errors rather than returning no
// rows — including the `SELECT DISTINCT business_id FROM workflows` these crons
// used to start from. So each cron enumerates `tenants` (exempt from RLS) by
// keyset and reads each tenant's workflows, customers and consents inside that
// tenant's own `withTenantTransaction`.
//
// The transaction only reads. The events it decides on are published after it
// has committed, because a queue send is a network call and a transaction held
// open across it holds a pooled connection for somebody else's latency. A
// failure in one tenant is logged with its id, the next tenant still runs, and
// the summary line names every tenant that failed.
// ---------------------------------------------------------------------------

/** How many tenants one page of the enumeration reads. */
export const TENANT_PAGE_SIZE = 100;

type Db = ReturnType<typeof createDb>;

/** The transaction handle `withTenantTransaction` gives: the tenant is set on it. */
type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** One WhatsApp request and the matching `WorkflowTriggered`, ready to publish. */
interface Dispatch {
  whatsappEvent: ReturnType<typeof createEnvelope>;
  triggeredEvent: ReturnType<typeof buildWorkflowTriggeredEvent>;
  log: string;
}

/**
 * Run `fn` for every tenant, by keyset on the primary key, and answer the ids
 * of the tenants whose `fn` threw.
 */
async function forEachTenant(
  db: Db,
  cron: string,
  fn: (tenantId: string) => Promise<void>,
): Promise<string[]> {
  const failed: string[] = [];
  let after: string | null = null;

  for (;;) {
    const page: Array<{ id: string }> = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(after === null ? undefined : gt(tenants.id, after))
      .orderBy(asc(tenants.id))
      .limit(TENANT_PAGE_SIZE);

    for (const { id: tenantId } of page) {
      try {
        await fn(tenantId);
      } catch (error) {
        failed.push(tenantId);
        console.error(
          `[automation] ${cron} cron failed for tenant ${tenantId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (page.length < TENANT_PAGE_SIZE) break;
    after = page[page.length - 1]!.id;
  }

  return failed;
}

/** Publish what one tenant's transaction decided, after it has committed. */
async function publishDispatches(env: Bindings, dispatches: Dispatch[]): Promise<void> {
  for (const dispatch of dispatches) {
    await publish(env.DELIVERY_QUEUE, dispatch.whatsappEvent);
    await publish(env.DOMAIN_EVENTS_QUEUE, dispatch.triggeredEvent);
    console.log(dispatch.log);
  }
}

/** The summary line of a cron run, naming the tenants that failed. */
function logCompletion(cron: string, failed: string[]): void {
  console.log(
    `[automation] ${cron} cron check complete` +
      (failed.length > 0 ? ` failed_tenants=${failed.join(',')}` : ''),
  );
}

/**
 * The WhatsApp request and `WorkflowTriggered` for every `send_whatsapp` action
 * of `workflow` that may go to `customer`, read on the tenant transaction.
 *
 * Evaluates the workflow's conditions and the consent gate from one consent
 * read, so the two cannot disagree.
 */
async function dispatchesFor(
  tx: TenantTx,
  businessId: string,
  workflow: typeof workflows.$inferSelect,
  customer: Record<string, unknown>,
  kind: 'birthday' | 'inactivity',
): Promise<Dispatch[]> {
  const actions = (workflow.actions ?? []) as Array<{
    type: string;
    config?: Record<string, unknown>;
  }>;

  // The customer's consents, from the authoritative store. The gate and the
  // context are built from the same read, so they cannot disagree.
  const consents = await readConsentMap(tx, {
    businessId,
    customerId: customer.id as string,
  });
  const customerData = buildCustomerData(customer, consents);
  const conditions = (workflow.conditions ?? []) as Condition[];

  // Evaluate workflow conditions
  if (!evaluateConditions(conditions, customerData)) {
    if (kind === 'birthday') {
      console.log(
        `[automation] Birthday workflow ${workflow.id} conditions not met for customer ${String(customer.id)}`,
      );
    }
    return [];
  }

  // Consent check
  if (!hasWhatsAppConsent(consents)) {
    if (kind === 'birthday') {
      console.log(
        `[automation] Customer ${String(customer.id)} has no WhatsApp consent — skipping birthday workflow ${workflow.id}`,
      );
    }
    return [];
  }

  const dispatches: Dispatch[] = [];
  for (const action of actions) {
    if (action.type !== 'send_whatsapp') continue;

    const templateName = action.config?.template_name as string | undefined;
    if (!templateName) continue;

    const params = (action.config?.parameters as string[] | undefined) ?? [];
    const parameters: Record<string, string> = {};
    params.forEach((param, index) => {
      parameters[String(index + 1)] = param;
    });

    dispatches.push({
      whatsappEvent: createEnvelope(
        WHATSAPP_OUTBOUND_REQUESTED,
        { business_id: businessId, timestamp: new Date().toISOString() },
        {
          customer_id: customer.id,
          business_id: businessId,
          template_name: templateName,
          parameters,
          idempotency_key: `${workflow.id}-${String(customer.id)}-${kind}`,
        },
      ),
      triggeredEvent: buildWorkflowTriggeredEvent(
        workflow.id,
        customer.id as string,
        businessId,
        'send_whatsapp',
        templateName,
      ),
      log:
        kind === 'birthday'
          ? `[automation] Birthday trigger for customer ${String(customer.id)} via workflow ${workflow.id}`
          : `[automation] Inactivity trigger for customer ${String(customer.id)} via workflow ${workflow.id}`,
    });
  }

  return dispatches;
}

// ---------------------------------------------------------------------------
// Birthday cron handler
// ---------------------------------------------------------------------------

/**
 * Handle the birthday cron trigger (daily).
 *
 * For every tenant, reads its active workflows with trigger_event = 'birthday'
 * and the customers whose birth_date matches today's month/day, inside that
 * tenant's transaction.
 *
 * For matching customers, evaluates workflow conditions, checks consent, and
 * publishes WhatsAppOutboundRequested + WorkflowTriggered events once the
 * transaction has closed.
 */
export async function handleBirthdayCron(env: Bindings): Promise<void> {
  console.log('[automation] Running birthday cron check');

  const db = createDb(env.DATABASE_URL);

  // Today, once for the whole run, so every tenant matches the same day.
  const today = new Date();
  const currentMonth = today.getMonth() + 1; // PostgreSQL EXTRACT uses 1-12
  const currentDay = today.getDate();

  const failed = await forEachTenant(db, 'Birthday', async (businessId) => {
    const dispatches = await withTenantTransaction(db, { businessId }, async (tx) => {
      // Read active birthday workflows for this business
      const activeWorkflows = await tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.businessId, businessId),
            eq(workflows.isActive, true),
            eq(workflows.triggerEvent, 'birthday'),
          ),
        );

      if (activeWorkflows.length === 0) return [];

      // Query customers whose birthday matches today
      const birthdayCustomers = await tx
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.businessId, businessId),
            sql`EXTRACT(MONTH FROM ${customers.birthDate}) = ${currentMonth}`,
            sql`EXTRACT(DAY FROM ${customers.birthDate}) = ${currentDay}`,
          ),
        );

      const decided: Dispatch[] = [];
      for (const workflow of activeWorkflows) {
        for (const customer of birthdayCustomers) {
          decided.push(...(await dispatchesFor(tx, businessId, workflow, customer, 'birthday')));
        }
      }
      return decided;
    });

    await publishDispatches(env, dispatches);
  });

  logCompletion('Birthday', failed);
}

// ---------------------------------------------------------------------------
// Inactivity cron handler
// ---------------------------------------------------------------------------

/**
 * Handle the inactivity cron trigger (daily).
 *
 * For every tenant, reads its active workflows with trigger_event =
 * 'inactivity' and, for each, the customers whose last_visit_at is older than
 * the configured N days, inside that tenant's transaction.
 *
 * For matching customers, evaluates workflow conditions, checks consent, and
 * publishes WhatsAppOutboundRequested + WorkflowTriggered events once the
 * transaction has closed.
 */
export async function handleInactivityCron(env: Bindings): Promise<void> {
  console.log('[automation] Running inactivity cron check');

  const db = createDb(env.DATABASE_URL);

  const failed = await forEachTenant(db, 'Inactivity', async (businessId) => {
    const dispatches = await withTenantTransaction(db, { businessId }, async (tx) => {
      // Read active inactivity workflows for this business
      const activeWorkflows = await tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.businessId, businessId),
            eq(workflows.isActive, true),
            eq(workflows.triggerEvent, 'inactivity'),
          ),
        );

      const decided: Dispatch[] = [];
      for (const workflow of activeWorkflows) {
        const actions = (workflow.actions ?? []) as Array<{ config?: Record<string, unknown> }>;

        // Read inactivity threshold from workflow config (default 30 days)
        const workflowConfig = (actions[0]?.config ?? {}) as Record<string, unknown>;
        const inactivityDays = (workflowConfig.inactivity_days as number) ?? 30;

        // Query customers who haven't visited in N days
        const inactiveCustomers = await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.businessId, businessId),
              sql`${customers.lastVisitAt} < NOW() - INTERVAL '${sql.raw(String(inactivityDays))} days'`,
            ),
          );

        for (const customer of inactiveCustomers) {
          decided.push(...(await dispatchesFor(tx, businessId, workflow, customer, 'inactivity')));
        }
      }
      return decided;
    });

    await publishDispatches(env, dispatches);
  });

  logCompletion('Inactivity', failed);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build customer data map for condition evaluation.
 *
 * The `consent` entry is assembled from the authoritative store — the
 * `consents` table — and not from a flag in the customer's metadata, which had
 * no writer and could say neither when the agreement began nor when it was
 * withdrawn.
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
 * Takes the consent map, which is also what the evaluation context is built
 * from — so the implicit filter and a workflow's own `consent.whatsapp`
 * condition cannot answer from two different places.
 */
function hasWhatsAppConsent(consents: Record<string, boolean>): boolean {
  return consents.whatsapp === true;
}
