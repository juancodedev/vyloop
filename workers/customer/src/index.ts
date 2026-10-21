import { getRequestId, logPrefix, requestIdMiddleware } from '@vyloop/request-context';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Bindings } from './helpers';
import { extractAuthHeaders } from './helpers';
import router from './routes';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: { auth: ReturnType<typeof extractAuthHeaders> } }>();

app.use('*', requestIdMiddleware());

// ---------------------------------------------------------------------------
// Global middleware: auth header extraction + defense-in-depth stripping
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  // Skip auth header check for public registration endpoint
  const path = new URL(c.req.url).pathname;
  if (path === '/v1/customers' && c.req.method === 'PUT') {
    await next();
    return;
  }

  try {
    // Extract and validate auth headers (injected by gateway).
    // The gateway already strips incoming X-* headers before forwarding,
    // so defense-in-depth stripping here is redundant but harmless.
    // Route handlers call extractAuthHeaders() again when needed.
    extractAuthHeaders(c);

    await next();
  } catch (err) {
    if (err instanceof HTTPException) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: err.message } },
        err.status,
      );
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.route('/', router);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json(
    { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    404,
  );
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  const requestId = getRequestId(c);
  console.error(`${logPrefix('customer', requestId)} ${c.req.method} ${new URL(c.req.url).pathname}:`, err);

  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: 'ERROR', message: err.message, request_id: requestId } },
      err.status,
    );
  }

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: requestId } },
    500,
  );
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
