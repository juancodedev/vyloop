import { Hono } from 'hono';
import { consume, type EventEnvelope } from '@vyloop/event-bus';
import type { MessageBatch } from '@cloudflare/workers-types';
import { issueTokenPair, validateToken, type JwtClaims } from './auth';
import { handleTestEvent } from './event-handler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  JWT_SECRET: string;
}

type Variables = {
  jwt: JwtClaims;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /v1/auth/token
// ---------------------------------------------------------------------------

app.post('/v1/auth/token', async (c) => {
  const secret = c.env.JWT_SECRET;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{
      client_id?: string;
      client_secret?: string;
      grant_type?: string;
      refresh_token?: string;
      scope?: string;
      business_id?: string;
      role?: string;
    }>();

    // For PMV: accept direct credentials in the body.
    // In production, validate against DB and use OAuth 2.0 flows.
    if (!body.client_id || !body.client_secret) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing client_id or client_secret' } },
        401,
      );
    }

    // Determine scopes from request or use defaults
    const scopes = body.scope?.split(' ') ?? ['read:customers'];
    const businessId = body.business_id ?? body.client_id;
    const role = body.role ?? 'staff';

    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(
      secret,
      body.client_id,
      businessId,
      role,
      scopes,
    );

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    });
  } catch (err) {
    console.error('Token issuance error:', err);
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid credentials' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/auth/refresh
// ---------------------------------------------------------------------------

app.post('/v1/auth/refresh', async (c) => {
  const secret = c.env.JWT_SECRET;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{ refresh_token?: string; client_id?: string }>();

    if (!body.refresh_token || !body.client_id) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing refresh_token or client_id' } },
        401,
      );
    }

    // PMV: accept any non-empty refresh token (no DB validation yet)
    // In production: validate refresh token against DB, check expiry
    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(
      secret,
      body.client_id,
      body.client_id, // business_id = client_id for PMV
      'staff',
      ['read:customers'],
    );

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: 'read:customers',
    });
  } catch (err) {
    console.error('Token refresh error:', err);
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /v1/me
// ---------------------------------------------------------------------------

app.get('/v1/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing or invalid Authorization header' } },
      401,
    );
  }

  const secret = c.env.JWT_SECRET;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }

  try {
    const token = authHeader.slice(7);
    const claims = await validateToken(secret, token);

    return c.json({
      sub: claims.sub,
      business_id: claims.business_id,
      role: claims.role,
      scopes: claims.scopes,
      iat: claims.iat,
      exp: claims.exp,
    });
  } catch {
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Token invalid or expired' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /v1/businesses/{id}
// ---------------------------------------------------------------------------

app.get('/v1/businesses/:id', async (c) => {
  const businessId = c.req.param('id');

  // PMV: return minimal tenant info.
  // In production: query the database for tenant details.
  return c.json({
    id: businessId,
    name: `Business ${businessId}`,
    status: 'active',
    // In production, return more fields:
    // plan, country, timezone, currency, createdAt, etc.
  });
});

// ---------------------------------------------------------------------------
// GET /v1/businesses/{id}/branches
// ---------------------------------------------------------------------------

app.get('/v1/businesses/:id/branches', async (c) => {
  const businessId = c.req.param('id');

  // PMV: return empty branch list.
  // In production: query the database for branches of this tenant.
  return c.json({
    branches: [],
    total: 0,
    business_id: businessId,
  });
});

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error('Identity service error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

// ---------------------------------------------------------------------------
// Queue consumer — TestEvent handler
// ---------------------------------------------------------------------------

async function queueHandler(batch: MessageBatch<EventEnvelope>, _env: Env): Promise<void> {
  await consume(batch, handleTestEvent);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,
  queue: queueHandler,
};
