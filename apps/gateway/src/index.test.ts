import { SignJWT } from 'jose';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

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

async function getValidToken(): Promise<string> {
  const jwt = await new SignJWT({
    sub: TEST_SUB,
    business_id: TEST_BUSINESS_ID,
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
                event_type: { type: 'string', const: 'test_event' },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    it('returns 202 for a valid event with registered schema', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            header: {
              event_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              event_type: 'test_event',
              event_version: '1.0.0',
              business_id: '12345678-1234-1234-1234-123456789abc',
              timestamp: '2026-07-02T12:00:00Z',
            },
            payload: {
              message: 'Hello from test!',
            },
          }),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('accepted', true);
      expect(body).toHaveProperty('event_id');
      expect(body).toHaveProperty('event_type', 'test_event');
    });

    it('returns 400 for an invalid event payload', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Missing required 'header' field
            payload: { message: 'test' },
          }),
        }),
        mockEnv(),
      );

      expect(res.status).toBe(400);
    });

    it('returns 400 for non-JSON content type', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/events/test_event', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            header: {
              event_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              event_type: 'unknown_type',
              event_version: '1.0.0',
              business_id: '12345678-1234-1234-1234-123456789abc',
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
});
