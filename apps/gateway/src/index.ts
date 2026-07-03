import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { ingestor } from './ingestor';
import { authMiddleware } from './middleware/auth';
import { authInjectMiddleware } from './middleware/auth-inject';
import { businessIdMiddleware } from './middleware/business-id';
import {
  rateLimitMiddleware,
  DEFAULT_LIMITS,
  DEFAULT_WINDOW,
} from './middleware/rate-limit';
import { routerMiddleware, type GatewayEnv } from './router';

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: GatewayEnv }>();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

app.use('*', cors());

// ---------------------------------------------------------------------------
// Public routes (no auth required)
// ---------------------------------------------------------------------------

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount the event ingestor — public endpoint for external event sources
app.route('/', ingestor);

// ---------------------------------------------------------------------------
// Middleware chain for /v1/* routes
// ---------------------------------------------------------------------------

// Middleware 1: Auth (JWT validation) — skip auth routes + customer registration
app.use('/v1/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;

  // Public routes — no JWT required
  if (
    path.startsWith('/v1/auth/') ||
    (method === 'PUT' && path === '/v1/customers')
  ) {
    await next();
    return;
  }

  const secret = (c.env as GatewayEnv).JWT_SECRET;
  if (!secret) {
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } },
      500,
    );
  }

  // Run the auth middleware factory and return its result (Response or undefined to continue)
  return authMiddleware(secret)(c, next);
});

// Middleware 2: Auth header injection — strip incoming X-* headers, inject from JWT
// MUST run before business-id enforcement and router so injected headers
// are available for validation and forwarding.
app.use('/v1/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;

  // Skip for public routes — no JWT to inject from
  if (
    path.startsWith('/v1/auth/') ||
    (method === 'PUT' && path === '/v1/customers')
  ) {
    await next();
    return;
  }

  return authInjectMiddleware()(c, next);
});

// Middleware 3: X-Business-ID enforcement — skip /v1/auth/* + registration
app.use('/v1/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  if (
    path.startsWith('/v1/auth/') ||
    (method === 'PUT' && path === '/v1/customers')
  ) {
    await next();
    return;
  }
  return businessIdMiddleware(c, next) as unknown as ReturnType<typeof next>;
});

// Middleware 4: Rate limiting — skip /v1/auth/*
app.use('/v1/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/v1/auth/')) {
    await next();
    return;
  }

  const env = c.env as GatewayEnv;
  return rateLimitMiddleware({
    kv: env.RATE_LIMITER,
    limits: DEFAULT_LIMITS,
    windowSeconds: DEFAULT_WINDOW,
  })(c, next);
});

// Middleware 5: Route dispatch to service bindings
app.use('/v1/*', routerMiddleware);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        request_id: crypto.randomUUID(),
      },
    },
    404,
  );
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('Gateway error:', err);
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        request_id: crypto.randomUUID(),
      },
    },
    500,
  );
});

export default app;
