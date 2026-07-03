import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import { setCurrentBusinessId } from '@vyloop/db';
import { CUSTOMER_REGISTERED, createEnvelope } from '@vyloop/event-bus';
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

export interface Bindings {
  DATABASE_URL: string;
  DOMAIN_EVENTS_QUEUE: Queue;
  SCHEMA_REGISTRY: KVNamespace;
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
 * JWT validation. The customer worker also strips them from the raw request
 * as defense-in-depth before they reach route handlers.
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
 * Build a CustomerRegistered event envelope for the domain events queue.
 *
 * The payload follows the CustomerRegistered schema registered in the
 * schema registry: { customer_id, full_name, business_id }.
 */
export function buildCustomerRegisteredEvent(
  customer: { globalId: string; fullName: string | null },
  businessId: string,
) {
  const payload = {
    customer_id: customer.globalId,
    full_name: customer.fullName ?? '',
    business_id: businessId,
  };

  return createEnvelope(
    CUSTOMER_REGISTERED,
    { business_id: businessId, timestamp: new Date().toISOString() },
    payload,
  );
}

// ---------------------------------------------------------------------------
// RLS helper
// ---------------------------------------------------------------------------

/**
 * Set the `app.current_business_id` session variable for RLS isolation.
 *
 * Call this at the start of every request that touches tenant-scoped tables.
 * With the Neon HTTP driver this sends a `SET LOCAL` statement to the
 * database — effective for the current transaction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function withRls(db: any, businessId: string): Promise<void> {
  await db.execute(setCurrentBusinessId(businessId));
}
