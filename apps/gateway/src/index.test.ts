import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clearCache } from '@vyloop/schema-registry';
import { SignJWT } from 'jose';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { SUPPORT_LIMIT_PER_WINDOW } from './support';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-key-for-unit-tests-only';
const TEST_SUB = 'user_test';
const TEST_BUSINESS_ID = 'biz_test_001';
const TEST_ROLE = 'admin';
const TEST_SCOPES = ['read:customers', 'write:customers'];

// ---------------------------------------------------------------------------
// Helper: issue a JWT for testing (self-contained, no external imports)
// ---------------------------------------------------------------------------

async function getValidToken(businessId: string = TEST_BUSINESS_ID): Promise<string> {
  const jwt = await new SignJWT({
    sub: TEST_SUB,
    business_id: businessId,
    role: TEST_ROLE,
    scopes: TEST_SCOPES,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('vyloop')
    .setSubject(TEST_SUB)
    .sign(new TextEncoder().encode(TEST_SECRET));

  return jwt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock env object for testing the gateway.
 */
function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    JWT_SECRET: TEST_SECRET,
    RATE_LIMITER: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    identity: {
      fetch: async (req: Request) => {
        return new Response(JSON.stringify({ service: 'identity', path: req.url }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
    customer: {
      fetch: async (req: Request) => {
        return new Response(JSON.stringify({ service: 'customer', path: req.url }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
    growth: {
      fetch: async (req: Request) => {
        return new Response(JSON.stringify({ service: 'growth', path: req.url }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
    SCHEMA_REGISTRY: {
      get: async () => {
        return JSON.stringify({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          required: ['header', 'payload'],
          properties: {
            header: {
              type: 'object',
              required: ['event_id', 'event_type', 'business_id', 'timestamp'],
              properties: {
                event_id: { type: 'string', format: 'uuid' },
                event_type: { type: 'string' },
                event_version: { type: 'string' },
                business_id: { type: 'string', format: 'uuid' },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
            payload: {
              type: 'object',
              properties: {
                message: { type: 'string' },
              },
            },
          },
        });
      },
      put: async () => {},
      delete: async () => {},
    },
    EVENT_QUEUE: {
      send: async () => {},
      sendBatch: async () => {},
    },
    DOMAIN_EVENTS_QUEUE: {
      send: async () => {},
      sendBatch: async () => {},
    },
    ...overrides,
  };
}

/**
 * The KV binding names `wrangler.jsonc` actually publishes.
 *
 * Read out of the config rather than taken from `mockEnv` so this file can build
 * an environment shaped like a real deployment's. A hand-written mock binding is
 * green whether or not the config publishes it, which is exactly the shape of the
 * bug: the binding was missing from the config and every test that supplied it by
 * hand still passed.
 *
 * Scoped to the `kv_namespaces` array and read as flat `{ … }` objects, because
 * both halves of a naive whole-file read are wrong in this file — every value is
 * an `https://` URL, and the comments discuss routes containing braces.
 */
function declaredKvBindings(): string[] {
  const source = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  const block = /"kv_namespaces"\s*:\s*\[([\s\S]*?)\n {2}\]/.exec(source)?.[1] ?? '';

  return [...block.matchAll(/"binding"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * The configuration `POST /v1/support` reads.
 *
 * Kept next to `mockEnv` rather than inline in each test because the four names
 * are the route's whole configuration surface, and a test that supplied them one
 * at a time would pass with three of the four missing.
 *
 * `mockEnv()` with no override is deliberately *not* this object — one test above
 * asserts the route answers 503 when none of them is present, which is the state
 * every real deployment is in today.
 */
function supportEnv() {
  return {
    RESEND_API_KEY: 're_test_key',
    SUPPORT_EMAIL_FROM: 'Vyloop <soporte@vyloop.test>',
    SUPPORT_EMAIL_TO: 'jmunoz@juancode.dev',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
  };
}

describe('API Gateway', () => {
  let app: typeof import('./index').default;

  beforeAll(async () => {
    app = (await import('./index')).default;
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await app.fetch(
        new Request('http://localhost/health'),
        mockEnv(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('status', 'ok');
    });
  });

  describe('Auth middleware (JWT validation)', () => {
    it('returns 401 without Authorization header on protected routes', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/customers'),
        mockEnv(),
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/customers', {
          headers: { Authorization: 'Bearer invalid-token' },
        }),
        mockEnv(),
      );

      expect(res.status).toBe(401);
    });

    it('passes auth routes without token (POST /v1/auth/token)', async () => {
      // /v1/auth/* routes skip auth middleware
      const identityMock = {
        fetch: async (_req: Request) => {
          return new Response(
            JSON.stringify({ access_token: 'mock', token_type: 'Bearer', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      };
      const res = await app.fetch(
        new Request('http://localhost/v1/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: 'test', client_secret: 'test' }),
        }),
        mockEnv({ identity: identityMock }),
      );

      expect(res.status).toBe(200);
    });

    it('passes business signup without a token (POST /v1/auth/business/signup)', async () => {
      // Pinned because the exemption is a path *prefix* match, and a public
      // endpoint that accidentally falls outside it fails closed: the request
      // comes back 401 with no error anyone can act on, and the feature looks
      // broken in a place that is not the feature. If the signup route is ever
      // moved off `/v1/auth/`, this is the test that says so — and the fix is
      // to move it back, not to widen the exemption, which would hand the whole
      // `/v1/*` surface the same bypass.
      const identityMock = {
        fetch: async (_req: Request) => {
          return new Response(JSON.stringify({ data: { businessId: 'biz-1' } }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      };
      const res = await app.fetch(
        new Request('http://localhost/v1/auth/business/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Café Central', email: 'a@b.cl', password: 'a-long-password' }),
        }),
        mockEnv({ identity: identityMock }),
      );

      expect(res.status).toBe(201);
    });

    it('still rejects an unauthenticated business read, so the exemption stayed narrow', async () => {
      // The counterpart to the test above: the exemption must cover the signup
      // path and not have been widened to `/v1/businesses/*`, which is where
      // the business reads live.
      const res = await app.fetch(
        new Request('http://localhost/v1/businesses/biz-001'),
        mockEnv(),
      );

      expect(res.status).toBe(401);
    });
  });

  // ==========================================================================
  // The Google Wallet pass callback
  //
  // The only `/v1/*` path that reaches a worker with no gateway-injected
  // identity. Google has no JWT for this system and no business id to send, so
  // a token requirement would be a credential nobody could present. What
  // authenticates the request instead is an `ECv2SigningOnly` signature the
  // wallet worker verifies before it opens a database.
  //
  // These tests are about the *exemption* being exactly as narrow as that
  // arrangement, because a 403 on this path is indistinguishable, from the
  // outside, from a rejected signature — and would be read as the latter.
  // ==========================================================================

  describe('The Google Wallet callback exemption', () => {
    const CALLBACK_PATH = '/v1/wallet/google/callback';

    it('forwards an unsigned callback to the wallet worker instead of 401', async () => {
      // The gateway's job stops at routing. Whether the body is authentic is the
      // wallet worker's decision, and it makes it with a signature — so a
      // gateway-level 401 here would be a second, weaker opinion on a question
      // this layer cannot answer.
      const wallet = { fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) };

      const res = await app.fetch(
        new Request(`http://localhost${CALLBACK_PATH}`, {
          method: 'POST',
          body: JSON.stringify({ hello: 'world' }),
        }),
        mockEnv({ wallet } as never),
      );

      expect(res.status).toBe(200);
      expect(wallet.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not require an X-Business-ID header, because the callback carries none', async () => {
      // The business-id middleware normally injects or demands a tenant. A
      // callback names a Google class, not a tenant, and the wallet worker
      // resolves the tenant from the verified `classId` — so demanding the header
      // here would reject every real delivery.
      const wallet = { fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) };

      const res = await app.fetch(
        new Request(`http://localhost${CALLBACK_PATH}`, {
          method: 'POST',
          body: '{}',
          headers: { 'Content-Type': 'application/json' },
        }),
        mockEnv({ wallet } as never),
      );

      expect(res.status).toBe(200);
    });

    it('stays an exact path, so a sibling under it is not public', async () => {
      // An exact comparison, not a prefix. A prefix would exempt
      // `/v1/wallet/google/callback/admin` and anything else appended later, and
      // nothing about the failure would look like an auth decision.
      const res = await app.fetch(
        new Request('http://localhost/v1/wallet/google/callback/admin', { method: 'POST' }),
        mockEnv(),
      );

      expect(res.status).toBe(401);
    });

    it('leaves the customer wallet routes authenticated', async () => {
      // The narrowness assertion that matters most: the exemption covers one
      // POST and not `/v1/wallet/*`, which serves a customer's own pass.
      for (const path of ['/v1/wallet/status', '/v1/wallet/pass']) {
        const res = await app.fetch(new Request(`http://localhost${path}`), mockEnv());
        expect(res.status, path).toBe(401);
      }
    });
  });

  describe('route scopes', () => {
    async function customerToken(scopes: string[]): Promise<string> {
      return new SignJWT({ sub: 'global-1', business_id: TEST_BUSINESS_ID, role: 'customer', scopes })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .setIssuer('vyloop')
        .setSubject('global-1')
        .sign(new TextEncoder().encode(TEST_SECRET));
    }

    function patchMe(token: string) {
      return app.fetch(
        new Request('http://localhost/v1/customers/me', {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nuevo@example.com' }),
        }),
        mockEnv(),
      );
    }

    it('refuses PATCH /v1/customers/me without profile:write, before the worker', async () => {
      const res = await patchMe(await customerToken(['rewards:read', 'rewards:redeem']));

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string }; service?: string };
      expect(body.error.code).toBe('AUTH_SCOPE_MISSING');
      expect(body.service).toBeUndefined();
    });

    it('forwards PATCH /v1/customers/me with profile:write', async () => {
      const res = await patchMe(await customerToken(['rewards:read', 'rewards:redeem', 'profile:write']));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { service?: string };
      expect(body.service).toBe('customer');
    });

    async function deleteMe(token: string): Promise<Response> {
      return app.fetch(
        new Request('http://localhost/v1/customers/me', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }),
        mockEnv(),
      );
    }

    it('refuses DELETE /v1/customers/me without profile:write, before the worker', async () => {
      const res = await deleteMe(await customerToken(['rewards:read', 'rewards:redeem']));

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string }; service?: string };
      expect(body.error.code).toBe('AUTH_SCOPE_MISSING');
      expect(body.service).toBeUndefined();
    });

    it('forwards DELETE /v1/customers/me with profile:write', async () => {
      const res = await deleteMe(await customerToken(['rewards:read', 'rewards:redeem', 'profile:write']));

      expect(res.status).toBe(200);
      expect(((await res.json()) as { service?: string }).service).toBe('customer');
    });

    it.each([
      ['a percent-encoded segment', '/v1/customers/%6De'],
      ['a trailing slash', '/v1/customers/me/'],
      ['a doubled slash', '/v1/customers//me'],
    ])('applies the scope to %s', async (_label, path) => {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${await customerToken(['rewards:read'])}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: 'nuevo@example.com' }),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_SCOPE_MISSING');
    });

    it('leaves reading your own profile to the token alone', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/customers/me', {
          headers: { Authorization: `Bearer ${await customerToken(['rewards:read'])}` },
        }),
        mockEnv(),
      );

      expect(res.status).toBe(200);
    });
  });

  describe('identity headers on public routes', () => {
    // A public route carries no token, so nothing the gateway forwards may claim
    // an identity. A client-sent X-User-* header would otherwise reach the worker
    // as if the gateway had injected it from a verified token.
    function capturing() {
      const seen: Headers[] = [];
      const service = {
        fetch: async (req: Request) => {
          seen.push(req.headers);
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      };
      return { seen, service };
    }

    const SPOOFED = {
      'X-User-Id': 'attacker',
      'X-Business-Id': 'someone-elses-business',
      'X-User-Role': 'admin',
    };

    it('strips them from the public customer registration', async () => {
      const { seen, service } = capturing();

      await app.fetch(
        new Request('http://localhost/v1/customers', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...SPOOFED },
          body: JSON.stringify({ fullName: 'Ada', phone: '+56912345678', businessSlug: 'cafe' }),
        }),
        mockEnv({ customer: service }),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]!.get('X-User-Id')).toBeNull();
      expect(seen[0]!.get('X-Business-Id')).toBeNull();
      expect(seen[0]!.get('X-User-Role')).toBeNull();
    });

    it('still forwards a public request that carries a stale token, with no identity', async () => {
      // A client interceptor may attach an old token to the login call. The
      // public route never verifies it, so it must neither be refused nor turned
      // into an identity.
      const { seen, service } = capturing();

      const res = await app.fetch(
        new Request('http://localhost/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer expired.or.forged' },
          body: JSON.stringify({ email: 'a@b.cl', password: 'x' }),
        }),
        mockEnv({ identity: service }),
      );

      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.get('X-User-Id')).toBeNull();
      expect(seen[0]!.get('X-Business-Id')).toBeNull();
      expect(seen[0]!.get('X-User-Role')).toBeNull();
    });

    it('strips them from the public auth routes', async () => {
      const { seen, service } = capturing();

      await app.fetch(
        new Request('http://localhost/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...SPOOFED },
          body: JSON.stringify({ email: 'a@b.cl', password: 'x' }),
        }),
        mockEnv({ identity: service }),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]!.get('X-User-Id')).toBeNull();
      expect(seen[0]!.get('X-Business-Id')).toBeNull();
      expect(seen[0]!.get('X-User-Role')).toBeNull();
    });
  });

  describe('X-Business-ID enforcement', () => {
    it('forwards request when X-Business-ID is spoofed (auth-inject normalizes it)', async () => {
      // authInjectMiddleware runs BEFORE businessIdMiddleware and
      // overwrites X-Business-Id from the JWT claims, so a spoofed
      // header never reaches businessIdMiddleware.
      const token = await getValidToken();

      const res = await app.fetch(
        new Request('http://localhost/v1/customers', {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Business-ID': 'different-business-id',
          },
        }),
        mockEnv(),
      );

      // Auth-inject normalizes the header → no mismatch → forwarded to service
      expect(res.status).toBe(200);
      const body = (await res.json()) as { service?: string };
      expect(body.service).toBe('customer');
    });

    it('forwards request when X-Business-ID is missing (auth-inject injects it from JWT)', async () => {
      const token = await getValidToken();

      const res = await app.fetch(
        new Request('http://localhost/v1/customers', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
        mockEnv(),
      );

      // Auth-inject sets X-Business-Id from JWT → header present → forwarded
      expect(res.status).toBe(200);
      const body = (await res.json()) as { service?: string };
      expect(body.service).toBe('customer');
    });
  });

  describe('Rate limiting', () => {
    let requestCount: number;

    function rateLimitMock() {
      return {
        get: async () => {
          return String(requestCount);
        },
        put: async () => {
          requestCount++;
        },
        delete: async () => {},
      };
    }

    beforeEach(() => {
      requestCount = 0;
    });

    it('throttles the public signup route, which has no identity to key on', async () => {
      // `/v1/auth/*` used to skip the limiter wholesale. Signup is the first route
      // under that prefix that creates a tenant and runs a 100k-iteration key
      // derivation, and it is public, so the skip was the shape a script farm looks
      // for. `requestCount` stands in for the stored counter.
      requestCount = 5;

      const res = await app.fetch(
        new Request('https://api.test/v1/auth/business/signup', { method: 'POST' }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('throttles signup even though the request carries no Authorization header', async () => {
      // The counter is keyed per business_id and an unauthenticated request has
      // none. The old code took that as a reason to skip, so a limit written that
      // way would only ever have applied to a request that was already
      // authenticated — which signup, being public, never is.
      requestCount = 5;

      const res = await app.fetch(
        new Request('https://api.test/v1/auth/business/signup', { method: 'POST' }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).toBe(429);
    });

    it('throttles the Google Wallet callback, which is public and unauthenticated', async () => {
      // The callback is exempt from auth because Google has no JWT to send, and
      // an unauthenticated request still costs two ECDSA verifications before it
      // is refused. Without a limit that is a public endpoint spending CPU on the
      // attacker's behalf.
      //
      // The limit is deliberately generous (600) so it bounds amplification
      // without throttling a real burst of saves from one Googlebot address. It
      // is not the security control; the signature is.
      requestCount = 600;

      const res = await app.fetch(
        new Request('https://api.test/v1/wallet/google/callback', { method: 'POST', body: '{}' }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).toBe(429);
    });

    it('leaves the login route unlimited, because locking someone out is worse', async () => {
      // A login is a credential check whose cost is one PBKDF2. Limiting it hands
      // a legitimate user a 429 because someone else guessed at their password,
      // and they cannot tell that from being locked out.
      requestCount = 9999;

      const res = await app.fetch(
        new Request('https://api.test/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
        }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).not.toBe(429);
    });

    it('throttles the POS token exchange, which is public and expensive', async () => {
      // The third `/v1/auth/*` route to reach this treatment, and the same shape
      // signup was: public by prefix, so it skips auth and arrives at the limiter
      // with no `jwt` and no `business_id` to key on. Because it was absent from
      // `ANONYMOUS_LIMITS` it was not "unthrottled by default" — the limiter skips
      // an endpoint the table does not name, which is *unbounded*. Each call runs a
      // 100k-iteration key derivation to compare a presented terminal secret, so an
      // unbounded loop here is an amplifier rather than a leak.
      requestCount = 5;

      const res = await app.fetch(
        new Request('https://api.test/v1/auth/pos/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ terminal_id: 't-1', secret: 'nope' }),
        }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('throttles the POS token exchange even with no Authorization header', async () => {
      // The counter is keyed per client address for anonymous callers. A terminal
      // has no session to send one, so this is the only shape the route ever has —
      // a limit keyed on anything the caller supplies would be spendable by
      // rotating a header.
      requestCount = 5;

      const res = await app.fetch(
        new Request('https://api.test/v1/auth/pos/token', { method: 'POST' }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).toBe(429);
    });

    it('leaves a till that authenticates once, alone below the limit', async () => {
      // The other direction, and the reason this is not login's deliberate
      // unlimited: a till exchanges its token once per boot, so five a minute is
      // never a merchant's traffic. Below the ceiling the route must still be
      // reachable, or the limit is just an outage with a nicer status code.
      requestCount = 4;

      const res = await app.fetch(
        new Request('https://api.test/v1/auth/pos/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ terminal_id: 't-1', secret: 'nope' }),
        }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).not.toBe(429);
    });

    it('returns 429 after exceeding rate limit', async () => {
      // Set the counter to exceed the limit (free tier = 60)
      requestCount = 60;

      const token = await getValidToken();
      const res = await app.fetch(
        new Request('http://localhost/v1/customers', {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Business-ID': TEST_BUSINESS_ID,
          },
        }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('passes requests under the rate limit', async () => {
      requestCount = 5;

      const token = await getValidToken();
      const res = await app.fetch(
        new Request('http://localhost/v1/customers', {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Business-ID': TEST_BUSINESS_ID,
          },
        }),
        mockEnv({ RATE_LIMITER: rateLimitMock() }),
      );

      // Should pass through (not 429)
      expect(res.status).not.toBe(429);
    });
  });

  describe('Event Ingestor', () => {
    // A uuid, because the registered schemas type `header.business_id` as one.
    // ## What this block mocks, and what it does not
    //
    // The registry below answers every key with one schema, which is what makes
    // the ingestor's *logic* — auth by position, tenant from the claim, both
    // body shapes, error codes — testable without the schema package. It is also
    // why this block cannot speak about which keys exist: a namespace that
    // answers everything cannot report a missing one. All the paths here are
    // therefore `test_event`, a type no deploy registers, so no real name is
    // paired with a body its real schema would reject.
    //
    // The compiled-validator cache is module state keyed by event type, not by
    // schema content, so a test that swaps the registry for one type only takes
    // effect if the previous compilation is dropped first.
    //
    // The shipped names, and the bodies their real schemas accept, live in
    // `event-ingestor.real-registry.test.ts`; the names vs. the deploy payload
    // live in `event-ingestor.registry.contract.test.ts`.
    const EVENT_BUSINESS_ID = '12345678-1234-1234-1234-123456789abc';
    const OTHER_BUSINESS_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    let token: string;

    beforeAll(async () => {
      token = await getValidToken(EVENT_BUSINESS_ID);
    });

    beforeEach(() => {
      clearCache();
    });

    /** The headers a real caller sends. The gateway injects none of them. */
    function authedHeaders(contentType = 'application/json') {
      return {
        'Content-Type': contentType,
        Authorization: `Bearer ${token}`,
        'X-Business-ID': EVENT_BUSINESS_ID,
      };
    }

    function envelopeBody(businessId: string = EVENT_BUSINESS_ID, type = 'test_event') {
      return JSON.stringify({
        header: {
          event_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          event_type: type,
          event_version: '1.0.0',
          business_id: businessId,
          timestamp: '2026-07-02T12:00:00Z',
        },
        payload: { message: 'Hello from test!' },
      });
    }

    it('returns 202 for a valid event with registered schema', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: envelopeBody(),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('accepted', true);
      expect(body).toHaveProperty('event_id');
      expect(body).toHaveProperty('event_type', 'test_event');
    });

    it('refuses an unauthenticated POST, which is what this route used to accept', async () => {
      // The route was mounted above the whole middleware chain, so this exact
      // request answered 202 and published. Public-write regression guard: no
      // token, a body that would otherwise validate, and the answer is 401.
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: envelopeBody(),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('replaces a client-supplied X-Business-ID with the token\'s', async () => {
      // `authInjectMiddleware` strips incoming `X-*` headers and re-injects them
      // from the claim, so a caller cannot choose its tenant by header any more
      // than it can by body. Without that, the business-id check below would be
      // comparing two values the caller controls.
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: { ...authedHeaders(), 'X-Business-ID': OTHER_BUSINESS_ID },
          body: envelopeBody(),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(202);
    });

    it('refuses a body that names another business', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: envelopeBody(OTHER_BUSINESS_ID),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('EVENT_BUSINESS_MISMATCH');
    });

    it('publishes an envelope whose business_id is the token\'s', async () => {
      const sent: Array<{ header: { business_id: string }; payload: unknown }> = [];

      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: envelopeBody(),
        }),
        mockEnv({
          EVENT_QUEUE: {
            send: async (event: { header: { business_id: string }; payload: unknown }) => {
              sent.push(event);
            },
            sendBatch: async () => {},
          },
        }),
      );

      expect(res.status).toBe(202);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.header.business_id).toBe(EVENT_BUSINESS_ID);
      expect(sent[0]?.payload).toEqual({ message: 'Hello from test!' });
    });

    it('publishes test_event to the dev queue, a branch no registered key reaches today', async () => {
      // The dev/domain split is real code and `register-schemas.ts` publishes no
      // `test_event` key, so this is the only place the branch can be exercised.
      // The registry contract test asserts the absence; this asserts the branch.
      const sent: Array<{ type: string }> = [];

      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: envelopeBody(EVENT_BUSINESS_ID, 'test_event'),
        }),
        mockEnv({
          EVENT_QUEUE: {
            send: async (event: { type: string }) => {
              sent.push(event);
            },
            sendBatch: async () => {},
          },
        }),
      );

      expect(res.status).toBe(202);
      expect(sent).toHaveLength(1);
    });

    it('accepts a bare-payload schema and wraps the body as the payload', async () => {
      // `CustomerRegistered` validates the payload alone. The envelope branch
      // used to publish `payload: undefined` for a body like this one; both
      // shapes have to reach the queue with something in them.
      const barePayloadRegistry = {
        get: async () =>
          JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            required: ['customer_id'],
            properties: { customer_id: { type: 'string' } },
          }),
        put: async () => {},
        delete: async () => {},
      };
      const sent: Array<{ payload: unknown }> = [];

      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: JSON.stringify({ customer_id: 'cust_1' }),
        }),
        mockEnv({
          SCHEMA_REGISTRY: barePayloadRegistry,
          EVENT_QUEUE: {
            send: async (event: { payload: unknown }) => {
              sent.push(event);
            },
            sendBatch: async () => {},
          },
        }),
      );

      expect(res.status).toBe(202);
      expect(sent[0]?.payload).toEqual({ customer_id: 'cust_1' });
    });

    it('returns 400 for an invalid event payload', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: JSON.stringify({
            // Missing required 'header' field
            payload: { message: 'test' },
          }),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(400);
    });

    it('returns 400 for a JSON body that is not an object', async () => {
      // `c.req.json()` parses `null` and `"text"` happily. Before the guard this
      // reached `body.header` and threw, so a malformed request answered 500.
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: 'null',
        }),
        mockEnv(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('SCHEMA_INVALID');
    });

    it('returns 400 for non-JSON content type', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders('text/plain'),
          body: 'not json',
        }),
        mockEnv(),
      );

      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown event type', async () => {
      // Override SCHEMA_REGISTRY to return null for unknown event types
      const schemaRegistry = {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
      };

      const res = await app.fetch(
        new Request('http://localhost/v1/events/unknown_type', {
          method: 'POST',
          headers: authedHeaders(),
          body: JSON.stringify({
            header: {
              event_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              event_type: 'unknown_type',
              event_version: '1.0.0',
              business_id: EVENT_BUSINESS_ID,
              timestamp: '2026-07-02T12:00:00Z',
            },
            payload: {},
          }),
        }),
        mockEnv({ SCHEMA_REGISTRY: schemaRegistry }),
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('EVENT_TYPE_UNKNOWN');
    });

    it('reaches a SCHEMA_REGISTRY that is not undefined, because the deployment declares one', async () => {
      // The route's own dependency, end to end.
      //
      // `mockEnv` always carries a `SCHEMA_REGISTRY`, so every other test in this
      // file is green whether or not `wrangler.jsonc` publishes the binding — which
      // is precisely how an undeclared binding reached production as a 500 on every
      // `POST /v1/events/:type`: `kv.get()` on `undefined`, throwing before any
      // lookup. So the environment here is built from what the config actually
      // declares. Remove the binding from `wrangler.jsonc` and this answers 500
      // again, which is the point.
      const schemaRegistry = {
        get: vi.fn(async () =>
          JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            required: ['header', 'payload'],
            properties: {
              header: { type: 'object' },
              payload: { type: 'object' },
            },
          }),
        ),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      };

      const declared = declaredKvBindings();

      expect(declared, 'wrangler.jsonc publishes no KV binding at all').not.toEqual([]);
      expect(declared, 'the deployment does not declare SCHEMA_REGISTRY').toContain(
        'SCHEMA_REGISTRY',
      );

      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: authedHeaders(),
          body: JSON.stringify({
            header: {
              event_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              event_type: 'test_event',
              event_version: '1.0.0',
              business_id: EVENT_BUSINESS_ID,
              timestamp: '2026-07-02T12:00:00Z',
            },
            payload: { message: 'Hello from test!' },
          }),
        }),
        mockEnv({
          // `undefined` rather than the hand-written mock when the config does not
          // declare it, so the route sees exactly what a deployment would hand it.
          SCHEMA_REGISTRY: declared.includes('SCHEMA_REGISTRY') ? schemaRegistry : undefined,
        }) as never,
      );

      // The read happened against the namespace the route was handed — asserted
      // on the call, not on the status, because a 500 could in principle arrive
      // from somewhere else and this is the claim that the binding was resolved.
      expect(schemaRegistry.get).toHaveBeenCalledWith('test_event:latest');
      expect(res.status).toBe(202);
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const token = await getValidToken();
      const res = await app.fetch(
        new Request('http://localhost/v1/unknown', {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Business-ID': TEST_BUSINESS_ID,
          },
        }),
        mockEnv(),
      );

      expect(res.status).toBe(404);
    });

    it('returns 200 for /health', async () => {
      const res = await app.fetch(
        new Request('http://localhost/health'),
        mockEnv(),
      );

      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // The support channel, through the real middleware chain
  // -------------------------------------------------------------------------
  //
  // `support.test.ts` drives the handler on its own, which is the right place to
  // test Turnstile, the honeypot and the PII rules. What cannot be tested there
  // is the part that actually went wrong the last time a public route was added
  // to this gateway: whether it survives the five `/v1/*` middlewares without a
  // JWT. A route can be perfect in isolation and 401 in production, and the only
  // way to see that is to let the chain run.
  describe('The support channel', () => {
    /** A real submission, as `apps/customer-web` builds it. */
    function submission(overrides: Record<string, unknown> = {}) {
      return {
        wallet_code: 'WALLET_CLASS_NOT_APPROVED',
        wallet_status: 409,
        message: 'No me aparece la tarjeta y ya me registre dos veces.',
        company_website: '',
        'cf-turnstile-response': 'a-token',
        ...overrides,
      };
    }

    /** Answers siteverify with success and records nothing else. */
    function stubFetch(): { calls: string[]; impl: typeof fetch } {
      const calls: string[] = [];

      return {
        calls,
        impl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          calls.push(url);

          if (url.includes('siteverify')) return Response.json({ success: true });
          return Response.json({ id: 'email_1' });
        }) as unknown as typeof fetch,
      };
    }

    it('answers an unsigned request instead of 401, because the writer has no session', async () => {
      // The premise of the whole route. The person who most needs to write to us
      // is the one whose registration failed, so a JWT requirement would exclude
      // exactly them.
      const stub = stubFetch();
      vi.stubGlobal('fetch', stub.impl);

      try {
        const res = await app.fetch(
          new Request('http://localhost/v1/support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission()),
          }),
          mockEnv({ ...supportEnv() }),
        );

        expect(res.status).toBe(202);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('reaches the Resend call, so the ROUTE_MAP entry is not missing', async () => {
      // Without the `binding: 'gateway'` entry, `routerMiddleware` answers 404 for
      // any `/v1/*` path no prefix matches — and a 404 from the gateway looks
      // exactly like the route not existing. That is what the wallet service
      // binding did for as long as it had no route.
      const stub = stubFetch();
      vi.stubGlobal('fetch', stub.impl);

      try {
        await app.fetch(
          new Request('http://localhost/v1/support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission()),
          }),
          mockEnv({ ...supportEnv() }),
        );

        expect(stub.calls.some((url) => url.includes('siteverify'))).toBe(true);
        expect(stub.calls.some((url) => url.includes('resend'))).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('throttles the support form, which is public and has no identity to key on', async () => {
      // The property `support-limits.contract.test.ts` argues for structurally,
      // proven here with the real chain. `requestCount` stands in for the counter,
      // and `SUPPORT_LIMIT_PER_WINDOW` is read rather than repeated so the two
      // cannot disagree.
      const requestCount = SUPPORT_LIMIT_PER_WINDOW;

      const res = await app.fetch(
        new Request('http://localhost/v1/support', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission()),
        }),
        mockEnv({
          ...supportEnv(),
          RATE_LIMITER: {
            get: async () => String(requestCount),
            put: async () => {},
            delete: async () => {},
          },
        }),
      );

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('lets a real first message through', async () => {
      // The other half of the pair above. A limit that refuses everything is
      // indistinguishable from a broken route, and it would be found by a
      // customer rather than by a test.
      const stub = stubFetch();
      vi.stubGlobal('fetch', stub.impl);

      try {
        const res = await app.fetch(
          new Request('http://localhost/v1/support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission()),
          }),
          mockEnv({
            ...supportEnv(),
            RATE_LIMITER: { get: async () => null, put: async () => {}, delete: async () => {} },
          }),
        );

        expect(res.status).toBe(202);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('answers 503 and sends nothing when the support keys are absent', async () => {
      // The state every environment is actually in today. Asserted end to end
      // because the honesty of this route *is* this behaviour: a deployment
      // without a Turnstile secret must be visibly non-functional rather than
      // quietly unprotected.
      const stub = stubFetch();
      vi.stubGlobal('fetch', stub.impl);

      try {
        const res = await app.fetch(
          new Request('http://localhost/v1/support', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission()),
          }),
          mockEnv(),
        );

        expect(res.status).toBe(503);
        expect(stub.calls.some((url) => url.includes('resend'))).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('leaves the customer wallet routes authenticated, so the exemption stayed narrow', async () => {
      // A sibling under `/v1/*` must still 401. The exemption is an exact match,
      // so it cannot grow into a prefix.
      for (const path of ['/v1/wallet/pass', '/v1/support/admin']) {
        const res = await app.fetch(
          new Request(`http://localhost${path}`, { method: 'POST' }),
          mockEnv(),
        );

        expect(res.status, path).toBe(401);
      }
    });
  });

  describe('request id', () => {
    const ID = 'X-Request-Id';

    it('generates one and echoes it', async () => {
      const res = await app.fetch(new Request('http://localhost/health'), mockEnv());
      expect(res.headers.get(ID)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it('keeps a well-formed client id', async () => {
      const res = await app.fetch(
        new Request('http://localhost/health', { headers: { [ID]: 'client-id-1234' } }),
        mockEnv(),
      );
      expect(res.headers.get(ID)).toBe('client-id-1234');
    });

    it('replaces a malformed client id', async () => {
      const res = await app.fetch(
        new Request('http://localhost/health', { headers: { [ID]: 'bad id!' } }),
        mockEnv(),
      );
      expect(res.headers.get(ID)).not.toBe('bad id!');
    });

    it('answers a 404 with the id it echoes', async () => {
      const res = await app.fetch(new Request('http://localhost/nope'), mockEnv());
      const body = (await res.json()) as { error: { request_id: string } };
      expect(body.error.request_id).toBe(res.headers.get(ID));
    });

    it('answers a 401 with the id it echoes', async () => {
      const res = await app.fetch(new Request('http://localhost/v1/customers'), mockEnv());
      const body = (await res.json()) as { error: { request_id: string } };
      expect(body.error.request_id).toBe(res.headers.get(ID));
    });
  });
});

