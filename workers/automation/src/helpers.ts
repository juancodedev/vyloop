import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import { setCurrentBusinessId } from '@vyloop/db';
import { WORKFLOW_TRIGGERED, createEnvelope } from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthHeaders {
  userId: string;
  businessId: string;
  userRole: string;
}

/**
 * The wallet worker's RPC surface, as this worker calls it.
 *
 * A plain `Fetcher` models only `fetch` and `connect`, so the target's exported
 * functions — which are the entire point of this binding — need their own shape.
 * Declaring them here also documents what the wallet must keep exporting: rename
 * `scheduled` there and this stops typechecking.
 */
export interface WalletWorker {
  scheduled(controller: unknown): Promise<void>;
  /**
   * The pass-inactivity rule's own entry point.
   *
   * A separate method rather than something inside `scheduled`, and the reason is
   * not tidiness. `runScheduledSweep` refuses to run in demo mode before it opens
   * a database, because it is a background writer with no Google publishing
   * access behind it. An inactivity rule hung off that call would inherit the
   * refusal and never run in any environment. Calling a different method means
   * the two rules have independent fates, while sharing this one cron slot.
   *
   * `dryRun` defaults to `true` on the wallet side, so a binding that passes
   * nothing gets a report and not a mass state change over real phones.
   */
  deactivateInactivePasses(options?: { dryRun?: boolean }): Promise<unknown>;
}

export interface Bindings {
  DATABASE_URL: string;
  DOMAIN_EVENTS_QUEUE: Queue;
  SCHEMA_REGISTRY: KVNamespace;
  /**
   * The wallet worker, dispatched to from the daily cron.
   *
   * A service binding rather than a `fetch`: the wallet's own `scheduled` export
   * is called over RPC, so the sweep runs with the *wallet's* bindings and its
   * secrets. A fetch would have to forward them by hand and would leak them
   * through this worker's request path.
   */
  WALLET: WalletWorker;
}

export type AppEnv = { Bindings: Bindings; Variables: { auth: AuthHeaders } };

// ---------------------------------------------------------------------------
// Auth header extraction
// ---------------------------------------------------------------------------

/**
 * Extract X-User-Id, X-Business-Id, X-User-Role from request headers.
 * Throws 403 if any header is missing.
 *
 * These headers are injected by the gateway auth-inject middleware after
 * JWT validation.
 */
export function extractAuthHeaders(c: Context): AuthHeaders {
  const userId = c.req.header('X-User-Id');
  const businessId = c.req.header('X-Business-Id');
  const userRole = c.req.header('X-User-Role');

  if (!userId || !businessId || !userRole) {
    throw new HTTPException(403, { message: 'Missing authentication headers' });
  }

  return { userId, businessId, userRole };
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

/**
 * Build a WorkflowTriggered event envelope for the domain events queue.
 */
export function buildWorkflowTriggeredEvent(
  workflowId: string,
  customerId: string,
  businessId: string,
  actionType: string,
  templateName?: string,
  skipped?: boolean,
  skipReason?: string,
): EventEnvelope {
  const payload: Record<string, unknown> = {
    workflow_id: workflowId,
    customer_id: customerId,
    business_id: businessId,
    action_type: actionType,
  };

  if (templateName !== undefined) {
    payload.template_name = templateName;
  }

  if (skipped !== undefined) {
    payload.skipped = skipped;
  }

  if (skipReason !== undefined) {
    payload.skip_reason = skipReason;
  }

  return createEnvelope(
    WORKFLOW_TRIGGERED,
    { business_id: businessId, timestamp: new Date().toISOString() },
    payload,
  );
}

// ---------------------------------------------------------------------------
// RLS helper
// ---------------------------------------------------------------------------

/**
 * Set the `app.current_business_id` session variable for RLS isolation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function withRls(db: any, businessId: string): Promise<void> {
  await db.execute(setCurrentBusinessId(businessId));
}

// ---------------------------------------------------------------------------
// Conditions evaluator
// ---------------------------------------------------------------------------

export interface Condition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
  value?: unknown;
}

/**
 * Evaluate a set of conditions against provided data (AND logic).
 *
 * All conditions must pass for the result to be true.
 * Supports nested field access via dot notation (e.g. 'metadata.consent.whatsapp').
 */
export function evaluateConditions(
  conditions: Condition[],
  data: Record<string, unknown>,
): boolean {
  if (!conditions || conditions.length === 0) {
    return true; // No conditions = always matches
  }

  for (const condition of conditions) {
    const actualValue = resolveField(condition.field, data);

    switch (condition.operator) {
      case 'eq':
        if (actualValue !== condition.value) return false;
        break;
      case 'neq':
        if (actualValue === condition.value) return false;
        break;
      case 'gt':
        if (typeof actualValue !== 'number' || typeof condition.value !== 'number') return false;
        if (!(actualValue > condition.value)) return false;
        break;
      case 'gte':
        if (typeof actualValue !== 'number' || typeof condition.value !== 'number') return false;
        if (!(actualValue >= condition.value)) return false;
        break;
      case 'lt':
        if (typeof actualValue !== 'number' || typeof condition.value !== 'number') return false;
        if (!(actualValue < condition.value)) return false;
        break;
      case 'lte':
        if (typeof actualValue !== 'number' || typeof condition.value !== 'number') return false;
        if (!(actualValue <= condition.value)) return false;
        break;
      case 'exists':
        if (actualValue === undefined || actualValue === null) return false;
        break;
      default:
        console.warn(`[automation] Unknown operator: ${condition.operator} — treating as fail`);
        return false;
    }
  }

  return true;
}

/**
 * Resolve a dot-notation field path on a nested data object.
 *
 * Example: resolveField('metadata.consent.whatsapp', { metadata: { consent: { whatsapp: true } } }) => true
 */
function resolveField(path: string, data: Record<string, unknown>): unknown {
  const parts = path.split('.');
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
