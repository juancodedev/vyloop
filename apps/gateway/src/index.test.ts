import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

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
        fetch: async (req: Request) => {
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
  });

  describe('X-Business-ID enforcement', () => {
    it('returns 403 when X-Business-ID does not match JWT claims', async () => {
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

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('AUTH_BUSINESS_MISMATCH');
    });

    it('returns 403 when X-Business-ID is missing', async () => {
      const token = await getValidToken();

      const res = await app.fetch(
        new Request('http://localhost/v1/customers', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
        mockEnv(),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('AUTH_BUSINESS_MISMATCH');
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
