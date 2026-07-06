import type { MessageBatch } from '@cloudflare/workers-types';
import { createDb, schema } from '@vyloop/db';
import { consume, type EventEnvelope } from '@vyloop/event-bus';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { issueToken, issueTokenPair, validateToken, type JwtClaims } from './auth';
import { handleTestEvent } from './event-handler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  JWT_SECRET: string;
  DATABASE_URL: string;
}

type Variables = {
  jwt: JwtClaims;
};

// ---------------------------------------------------------------------------
// Password verification (PBKDF2 via Web Crypto API)
// ---------------------------------------------------------------------------

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(saltHex), iterations: 100_000, hash: 'SHA-256' },
    key,
    512,
  );

  const computedHex = Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (computedHex.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ hashHex.charCodeAt(i);
  }
  return diff === 0;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /v1/auth/token
// ---------------------------------------------------------------------------

app.post('/v1/auth/token', async (c) => {
  const secret = c.env.JWT_SECRET;
  const dbUrl = c.env.DATABASE_URL;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{ email?: string; password?: string; grant_type?: string }>();

    if (!body.email || !body.password) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing email or password' } },
        401,
      );
    }

    // Create DB connection
    const db = createDb(dbUrl);

    // Find user by email
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(1);

    if (!user) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid email or password' } },
        401,
      );
    }

    // Verify password
    const isValid = await verifyPassword(body.password, user.passwordHash ?? '');
    if (!isValid) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid email or password' } },
        401,
      );
    }

    const scopes = ['read:customers', 'write:customers', 'write:loyalty', 'read:analytics'];

    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(
      secret,
      user.id,
      user.businessId,
      user.role,
      scopes,
    );

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
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
  const dbUrl = c.env.DATABASE_URL;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{ refresh_token?: string; email?: string }>();

    if (!body.refresh_token || !body.email) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing refresh_token or email' } },
        401,
      );
    }

    const db = createDb(dbUrl);
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(1);

    if (!user) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid email or refresh token' } },
        401,
      );
    }

    const scopes = ['read:customers', 'write:customers', 'write:loyalty', 'read:analytics'];

    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(
      secret,
      user.id,
      user.businessId,
      user.role,
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
    console.error('Token refresh error:', err);
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' } },
      401,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/auth/customer/token — phone-only auth (demo mode, no OTP)
// ---------------------------------------------------------------------------

app.post('/v1/auth/customer/token', async (c) => {
  const secret = c.env.JWT_SECRET;
  const dbUrl = c.env.DATABASE_URL;
  if (!secret) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' } }, 500);
  }
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  try {
    const body = await c.req.json<{ phone?: string; otp?: string; businessSlug?: string }>();

    if (!body.phone) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing phone number' } },
        401,
      );
    }

    // Normalize phone: strip all whitespace so '+569 5678 9012' matches '+56956789012'
    const normalizedPhone = body.phone.replace(/\s+/g, '');

    const db = createDb(dbUrl);

    // Look up customer by phone
    let [customer] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.phone, normalizedPhone))
      .limit(1);

    // If businessSlug provided, refine the lookup to a specific tenant
    if (body.businessSlug) {
      const [tenant] = await db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.slug, body.businessSlug))
        .limit(1);

      if (tenant) {
        [customer] = await db
          .select()
          .from(schema.customers)
          .where(
            and(
              eq(schema.customers.phone, normalizedPhone),
              eq(schema.customers.businessId, tenant.id),
            ),
          )
          .limit(1);
      }
    }

    if (!customer || customer.deletedAt) {
      return c.json(
        { error: { code: 'AUTH_TOKEN_INVALID', message: 'Número no registrado' } },
        401,
      );
    }

    // Demo mode: skip OTP verification when absent
    // In production, validate body.otp here before issuing the token

    const token = await issueToken(
      secret,
      customer.globalId,
      customer.businessId,
      'customer',
      ['rewards:read', 'rewards:redeem'],
    );

    return c.json({
      token,
      customer: {
        name: customer.fullName,
        globalId: customer.globalId,
      },
      expiresIn: 3600,
    });
  } catch (err) {
    console.error('Customer token issuance error:', err);
    return c.json(
      { error: { code: 'AUTH_TOKEN_INVALID', message: 'Error al verificar el número' } },
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
