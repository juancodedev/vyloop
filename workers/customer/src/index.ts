import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Bindings } from './helpers';
import { extractAuthHeaders } from './helpers';
import router from './routes';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: { auth: ReturnType<typeof extractAuthHeaders> } }>();

// ---------------------------------------------------------------------------
// Global middleware: auth header extraction + defense-in-depth stripping
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
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
  console.error('[customer] Unhandled error:', err);

  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: 'ERROR', message: err.message } },
      err.status,
    );
  }

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500,
  );
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
