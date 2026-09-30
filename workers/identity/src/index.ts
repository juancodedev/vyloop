import type { MessageBatch } from '@cloudflare/workers-types';
import { checkPasswordPolicy, createDb, hashPassword, schema, verifyPassword } from '@vyloop/db';
import { consume, type EventEnvelope } from '@vyloop/event-bus';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { issueToken, issueTokenPair, validateToken, type JwtClaims } from './auth';
import { signupBusiness, SlugNotDerivableError } from './business-signup';
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
// POST /v1/auth/business/signup
//
// Public. The path has to live under `/v1/auth/` for one reason: that prefix is
// the exemption the gateway already grants in `apps/gateway/src/index.ts`
// (auth middleware, business-id resolution and rate limiting all skip it), and
// widening that exemption to reach a new path would hand the whole `/v1/*`
// surface the same bypass. Reusing the prefix costs nothing and touches no
// gateway line.
//
// The same prefix is why this endpoint is unthrottled, and that is worth naming
// rather than discovering: `/v1/auth/*` skips the rate limiter, and the limiter
// is itself keyed on `jwt.business_id`, so it would have no counter to increment
// for a request that carries no JWT. An unauthenticated endpoint that creates
// tenants and runs a 100k-iteration KDF is the shape a script farm looks for.
// The password minimum in `@vyloop/db` is the only control behind it. Moving the
// exemption to a per-route allowlist is the fix; it is not this slice, and it is
// not this file, because the middleware lives in the gateway.
//
// No token is issued. The administrator can log in immediately afterwards, and
// returning one here would quietly route around the known defect in that login
// path — it resolves `users.email` globally while the unique constraint is per
// tenant — by making signup the only way in. That defect is tracked as its own
// change; a signup endpoint that returns a working session is the worst possible
// way to discover it later.
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive. The addresses this endpoint sees are typed by humans
 * into a browser form, and a regex stricter than "looks like an address" rejects
 * real ones far more often than it rejects typos. The database treats
 * `users.email` as opaque text.
 *
 * Case folding is not so much about this endpoint as about the one it feeds.
 * `POST /v1/auth/token` looks the user up with `eq(users.email, body.email)`, a
 * plain equality on stored text — so an address stored as `Owner@x.com` and
 * typed as `owner@x.com` at the login form would not match, and the merchant
 * would be told their credentials are wrong. Storing the folded form here means
 * signup cannot mint an account the login path is unable to find.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_SHAPE.test(value);
}

app.post('/v1/auth/business/signup', async (c) => {
  const dbUrl = c.env.DATABASE_URL;
  if (!dbUrl) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Database not configured' } }, 500);
  }

  let body: { name?: unknown; email?: unknown; password?: unknown; full_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Body must be JSON' } }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'name is required' } },
      400,
    );
  }

  if (!isEmail(body.email)) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'email must be a valid address' } },
      400,
    );
  }
  const email = body.email.toLowerCase();

  // Checked before the transaction opens, so a rejected password costs no
  // connection and no write. The policy lives in `@vyloop/db` so the length is
  // defined once for every future writer, not restated per route.
  const policy = checkPasswordPolicy(typeof body.password === 'string' ? body.password : '');
  if (!policy.ok) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: policy.message } }, 400);
  }

  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : undefined;

  try {
    const db = createDb(dbUrl);
    const outcome = await signupBusiness(db, {
      name,
      adminEmail: email,
      adminPasswordHash: await hashPassword(body.password as string),
      adminFullName: fullName,
    });

    if (!outcome.ok) {
      // 409, not 400: the request was well formed and the caller can fix it,
      // but not by changing what they sent — they have to change the name, and
      // the slug is derived from the name, so the response has to name the slug
      // they are actually colliding on. Sending them back a message about
      // "Café Central" when they typed "Café Central!" is the whole point.
      return c.json(
        {
          error: {
            code: 'BUSINESS_SLUG_TAKEN',
            message: `A business with the slug "${outcome.slug}" already exists. Choose a different business name.`,
          },
        },
        409,
      );
    }

    return c.json({ data: outcome.value }, 201);
  } catch (err) {
    if (err instanceof SlugNotDerivableError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
    }
    throw err;
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
