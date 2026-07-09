import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import { setCurrentBusinessId } from '@vyloop/db';
import { WHATSAPP_OUTBOUND_REQUESTED, createEnvelope } from '@vyloop/event-bus';
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

export interface Bindings {
  DATABASE_URL: string;
  DOMAIN_EVENTS_QUEUE: Queue;
  SCHEMA_REGISTRY: KVNamespace;
  WHATSAPP_PHONE_ID: string;
  WHATSAPP_TOKEN: string;
  WHATSAPP_API_VERSION: string;
  WHATSAPP_VERIFY_TOKEN: string;
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
 * Build a WhatsAppOutboundRequested event envelope for the domain events queue.
 */
export function buildWhatsAppOutboundRequestedEvent(
  customerId: string,
  businessId: string,
  templateName: string,
  parameters: Record<string, string>,
  idempotencyKey: string,
  phone?: string,
): EventEnvelope {
  const payload: Record<string, unknown> = {
    customer_id: customerId,
    business_id: businessId,
    template_name: templateName,
    parameters,
    idempotency_key: idempotencyKey,
  };

  if (phone !== undefined) {
    payload.phone = phone;
  }

  return createEnvelope(
    WHATSAPP_OUTBOUND_REQUESTED,
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
// Meta API helpers
// ---------------------------------------------------------------------------

/**
 * Call the Meta Graph API to send a WhatsApp template message.
 *
 * Uses the WHATSAPP_TOKEN and WHATSAPP_PHONE_ID from env bindings.
 */
export async function callMetaApi(
  env: Bindings,
  to: string,
  templateName: string,
  parameters: Record<string, string>,
): Promise<Response> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_ID}/messages`;

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'es' },
    },
  };

  const paramKeys = Object.keys(parameters);
  if (paramKeys.length > 0) {
    const components = paramKeys.map((key) => ({
      type: 'body' as const,
      parameters: [{ type: 'text' as const, text: parameters[key] }],
    }));
    body.template = {
      ...(body.template as Record<string, unknown>),
      components,
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  return response;
}

/**
 * Parse a Meta API response into a standardised shape.
 */
export function parseMetaResponse(
  response: Response,
): { ok: boolean; providerMessageId?: string; error?: { code: number; message: string } } {
  if (response.ok) {
    // Successful send — extract the wamid from the response body
    return {
      ok: true,
      providerMessageId: undefined, // parsed asynchronously below if needed
    };
  }

  // Error response
  return {
    ok: false,
    error: {
      code: response.status,
      message: `Meta API returned ${response.status}`,
    },
  };
}

/**
 * Determine if a Meta API error is retryable (rate-limit / temporary).
 */
export function isRetryableError(error: { status?: number; code?: number }): boolean {
  // 429 = rate limit, 5xx = server errors
  if (error.status === 429) return true;
  if (error.status && error.status >= 500 && error.status < 600) return true;
  return false;
}
