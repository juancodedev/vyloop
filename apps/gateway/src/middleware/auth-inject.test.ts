import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';

import type { JwtClaims, AuthEnv } from './auth';
import { authInjectMiddleware } from './auth-inject';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal Hono app that applies `authInjectMiddleware`, optionally
 * preceded by a middleware that sets JWT claims (to simulate the real chain).
 *
 * A terminal handler echoes back the headers that the router would see on
 * `c.req.raw`, so we can verify stripping and injection.
 */
function createTestApp(jwt?: JwtClaims) {
  const app = new Hono<AuthEnv>();

  // Simulate the real chain: earlier middleware sets JWT before auth-inject runs
  if (jwt) {
    app.use('/*', async (c, next) => {
      c.set('jwt', jwt);
      await next();
    });
  }

  app.use('/*', authInjectMiddleware());

  // Terminal handler — echoes the three auth headers
  app.get('/*', (c) => {
    return c.json({
      userId: c.req.header('X-User-Id'),
      businessId: c.req.header('X-Business-Id'),
      userRole: c.req.header('X-User-Role'),
    });
  });

  return app;
}

const baseClaims: JwtClaims = {
  sub: 'user_abc123',
  business_id: 'biz_def456',
  role: 'staff',
  scopes: ['read:customers', 'write:customers'],
  iss: 'vyloop',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authInjectMiddleware', () => {
  it('strips incoming spoofed headers', async () => {
    const app = createTestApp();

    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: {
          'X-User-Id': 'spoofed-user',
          'X-Business-Id': 'spoofed-biz',
          'X-User-Role': 'hacker',
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userId).toBeUndefined();
    expect(body.businessId).toBeUndefined();
    expect(body.userRole).toBeUndefined();
  });

  it('injects headers from JWT claims', async () => {
    const app = createTestApp(baseClaims);

    const res = await app.fetch(new Request('http://localhost/test'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userId).toBe('user_abc123');
    expect(body.businessId).toBe('biz_def456');
    expect(body.userRole).toBe('staff');
  });

  it('strips spoofed headers before JWT injection', async () => {
    const app = createTestApp(baseClaims);

    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: {
          'X-User-Id': 'spoofed',
          'X-Business-Id': 'spoofed',
          'X-User-Role': 'spoofed',
        },
      }),
    );

    // Injected values must win — spoofed values are stripped first
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userId).toBe('user_abc123');
    expect(body.businessId).toBe('biz_def456');
    expect(body.userRole).toBe('staff');
  });

  it('omits header when JWT claim is missing (does not fail)', async () => {
    // JWT without business_id and role claims — simulate token that only has
    // sub and scopes (e.g., a scoped system token)
    const { business_id: _business_id, role: _role, ...partialClaims } = baseClaims;

    const app = createTestApp(partialClaims as unknown as JwtClaims);

    const res = await app.fetch(new Request('http://localhost/test'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // sub is set, so X-User-Id should be present
    expect(body.userId).toBe('user_abc123');
    // Missing claims → header omitted entirely (undefined)
    expect(body.businessId).toBeUndefined();
    expect(body.userRole).toBeUndefined();
  });

  it('passes through gracefully when no JWT is set (e.g., /v1/auth/*)', async () => {
    const app = createTestApp(); // no JWT

    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: {
          'X-User-Id': 'spoofed',
        },
      }),
    );

    // Spoofed headers are stripped, no injection happens
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userId).toBeUndefined();
    expect(body.businessId).toBeUndefined();
    expect(body.userRole).toBeUndefined();
  });

  it('preserves other incoming headers (not auth-related)', async () => {
    const app = createTestApp(baseClaims);

    const res = await app.fetch(
      new Request('http://localhost/test', {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Custom-Trace': 'trace-123',
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userId).toBe('user_abc123');
    expect(body.businessId).toBe('biz_def456');
    expect(body.userRole).toBe('staff');
  });
});
