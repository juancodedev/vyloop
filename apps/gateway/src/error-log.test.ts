import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import app from './index';

/**
 * What the error log is allowed to contain.
 *
 * This file exists because `onError` generated a `request_id`, returned it to the
 * client, and never wrote it anywhere. A user given an id and asked to report it
 * produced an id nobody could search for — one real 500 was diagnosed with a
 * `request_id` in hand and `wrangler tail --search` returned nothing.
 *
 * The second half is the harder half. An error handler is the one place in a
 * gateway that sees every customer's `Authorization` header, cookie and JSON body
 * at the same time, and logs are retained, searchable and copy-pasted into issues.
 * So "log the request_id with context" is a change that can leak a bearer token
 * if it is done by serialising the request, which is why the PII assertions below
 * are written as hard failures rather than as a review note.
 */

const TEST_SECRET = 'test-jwt-secret-key-for-unit-tests-only';

/** A secret in each place credentials actually travel, so a leak cannot hide. */
const AUTH_TOKEN_VALUE = 'super-secret-bearer-token-value';
const COOKIE_VALUE = 'super-secret-session-cookie-value';
const BODY_VALUE = 'super-secret-request-body-value';

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/**
 * Everything passed to `console.error`, flattened into one string.
 *
 * Flattening matters: a handler that logs `console.error('x', { headers })` leaks
 * just as surely as one that interpolates, and asserting only the first argument
 * would pass it.
 */
function errorText(): string {
  return errorSpy.mock.calls
    .map((args: unknown[]) =>
      args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '),
    )
    .join('\n');
}

/**
 * The first argument of each `console.error` call, as lines.
 *
 * `mock.calls` is untyped on a spied `console`, so the cast is stated here once
 * instead of as an annotation on every callback in the file.
 */
function errorLines(): string[] {
  return (errorSpy.mock.calls as unknown[][]).map((args) => String(args[0]));
}

/** The single error line containing `needle`, or `undefined`. */
function errorLineWith(needle: string): string | undefined {
  return errorLines().find((first) => first.includes(needle));
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A token the auth middleware accepts.
 *
 * Issuer, `role` and `scopes` are all required claims, and omitting any one of
 * them produces a 401 before the route is reached — which would quietly turn the
 * 400 test below into a second 401 test asserting nothing.
 */
async function validToken(): Promise<string> {
  return new SignJWT({
    sub: 'user_test',
    business_id: 'biz_test_001',
    role: 'admin',
    scopes: ['read:customers', 'write:customers'],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('vyloop')
    .setSubject('user_test')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    JWT_SECRET: TEST_SECRET,
    RATE_LIMITER: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    // An R2 bucket that fails. `/brand/*` awaits this with no try/catch, so this
    // is a real unhandled throw reaching the real `onError` — an R2 outage is a
    // real production 500, and it needs no test-only hook in the app to produce.
    BRAND_ASSETS: {
      get: async () => {
        throw new Error('R2 bucket unavailable');
      },
    },
    identity: {
      fetch: async () => new Response('{}', { status: 200 }),
    },
    ...overrides,
  };
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A request carrying a credential in every place one can travel. */
function credentialedRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN_VALUE}`,
      Cookie: `session=${COOKIE_VALUE}`,
      'X-Business-ID': 'biz_test_001',
    },
  });
}

async function triggerReal500(): Promise<Response> {
  return app.fetch(
    credentialedRequest('https://api.test/brand/tenant-1.jpg'),
    mockEnv() as never,
  );
}

// ---------------------------------------------------------------------------
// The request_id is findable
// ---------------------------------------------------------------------------

describe('a 500 logs the request_id it returned', () => {
  it('logs the exact same id the client received', async () => {
    const res = await triggerReal500();

    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: { request_id: string } };
    const requestId = body.error.request_id;

    expect(requestId).toBeTruthy();
    // The whole point. A different id in the response than in the log is the
    // original bug wearing a different hat.
    expect(errorText()).toContain(requestId);
  });

  it('emits at error, not warn or log', async () => {
    // It is a failure. At `warn` it does not turn the error filter on, and at
    // `log` it is invisible in a log stream that does not show it.
    await triggerReal500();

    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('carries the error itself, not just the request_id', async () => {
    await triggerReal500();

    expect(errorText()).toContain('R2 bucket unavailable');
  });
});

// ---------------------------------------------------------------------------
// Enough context to triage
// ---------------------------------------------------------------------------

describe('the 500 line carries enough context to act on it', () => {
  it('names the method, the path and the status', async () => {
    // A `request_id` on a line by itself is decoration. Whoever is on call at 6am
    // needs to know which route broke without opening sixteen other log lines.
    await triggerReal500();

    const text = errorText();
    expect(text).toContain('GET');
    expect(text).toContain('/brand/tenant-1.jpg');
    expect(text).toContain('500');
  });

  it('puts them on one line, so `wrangler tail` searching the id finds them', async () => {
    await triggerReal500();

    // The original diagnosis cost a whole session because the id was in no line at
    // all. Splitting the context across lines would make a text search on the id
    // return the id and none of the context that makes it useful.
    const line = errorLineWith('request_id=');

    expect(line).toBeDefined();
    expect(line).toMatch(/request_id=\S+ GET \S+ 500/);
  });

  it('logs the status the client actually received', async () => {
    await triggerReal500();

    // Read off the response object rather than a literal, so the line cannot
    // drift from what went out.
    const res = await app.fetch(
      new Request('https://api.test/brand/tenant-1.jpg'),
      mockEnv() as never,
    );
    expect(errorText()).toContain(String(res.status));
  });
});

// ---------------------------------------------------------------------------
// Nothing secret reaches the log
// ---------------------------------------------------------------------------

describe('the error log leaks nothing from the request', () => {
  it('contains no Authorization header', async () => {
    // THE test in this file. An error handler is the one place in a gateway that
    // sees every tenant's bearer token at once, and logs are retained, searchable
    // and pasted into tickets. Serialising the request "for context" would write
    // live customer credentials to disk on every 500.
    await triggerReal500();

    expect(errorText()).not.toContain(AUTH_TOKEN_VALUE);
  });

  it('contains no cookie', async () => {
    await triggerReal500();

    expect(errorText()).not.toContain(COOKIE_VALUE);
  });

  it('contains no request body', async () => {
    // The secret body is attached to a request that genuinely 500s: a KV outage
    // in the schema registry. Attaching it to a 400 would prove nothing, because
    // a 400 emits no error line at all and the assertion would pass trivially.
    const res = await app.fetch(
      new Request('https://api.test/v1/events/customer.created', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN_VALUE}`,
          Cookie: `session=${COOKIE_VALUE}`,
          'X-Business-ID': 'biz_test_001',
        },
        body: JSON.stringify({ customer_email: 'someone@example.com', ssn: BODY_VALUE }),
      }),
      mockEnv({
        ...{},
        SCHEMA_REGISTRY: {
          get: async () => {
            throw new Error('schema registry unavailable');
          },
          put: async () => {},
          delete: async () => {},
        },
      }) as never,
    );

    expect(res.status).toBe(500);
    expect(errorText()).not.toContain(BODY_VALUE);
    expect(errorText()).not.toContain('someone@example.com');
  });

  it('never logs the header names it declines to log', async () => {
    // Guards against a future "let me just include the headers for context" edit
    // that redacts the value but leaves the shape of a credential in the log.
    await triggerReal500();

    const text = errorText();
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/cookie/i);
  });

  it('does not log the query string, where credentials live', async () => {
    // `?token=`, `?code=`, `?signature=` — a path is enough to identify the route
    // and the full URL would put all three into every 500 line.
    await app.fetch(
      credentialedRequest(
        'https://api.test/brand/tenant-1.jpg?token=super-secret-query-token-value&code=abc123',
      ),
      mockEnv() as never,
    );

    const text = errorText();
    expect(text).not.toContain('super-secret-query-token-value');
    expect(text).not.toContain('abc123');
    // The pathname still has to be there, or the line loses its point.
    expect(text).toContain('/brand/tenant-1.jpg');
  });
});

// ---------------------------------------------------------------------------
// Non-500 responses are not errors
// ---------------------------------------------------------------------------

describe('non-500 responses do not log at error', () => {
  it('a 404 from the notFound handler stays silent', async () => {
    // The design, stated: `onError` is the only place that logs at error, and
    // Hono reaches it only for an unhandled throw, which is always a 500 here.
    // A 404 is a client asking for something that is not there — expected traffic,
    // not an incident. If these logged at error, the 500 that matters would be
    // buried under the noise and nobody would read it.
    const res = await app.fetch(
      new Request('https://api.test/no-such-route'),
      mockEnv() as never,
    );

    expect(res.status).toBe(404);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a 401 from a missing or invalid JWT stays silent', async () => {
    const res = await app.fetch(
      new Request('https://api.test/v1/customers', {
        headers: { Authorization: `Bearer ${AUTH_TOKEN_VALUE}` },
      }),
      mockEnv() as never,
    );

    expect(res.status).toBe(401);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a 400 from the event ingestor stays silent', async () => {
    // A wrong Content-Type gives a genuine `SCHEMA_INVALID` before any schema
    // lookup, so this measures one status and not a chain. Reached with a valid
    // token and a business id: `/v1/events/*` is not public, so without them the
    // 401 above answers first and this would assert nothing about 400s.
    const res = await app.fetch(
      new Request('https://api.test/v1/events/customer.created', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Authorization: `Bearer ${await validToken()}`,
          'X-Business-ID': 'biz_test_001',
        },
        body: 'not json',
      }),
      mockEnv() as never,
    );

    expect(res.status).toBe(400);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still returns a request_id on a 404, for the same reason as on a 500', async () => {
    const res = await app.fetch(
      new Request('https://api.test/no-such-route'),
      mockEnv() as never,
    );

    const body = (await res.json()) as { error: { request_id?: string } };
    expect(body.error.request_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The failure this was written for
// ---------------------------------------------------------------------------

describe('the merchant-page 500', () => {
  it('logs a findable line, which is the incident that motivated all of this', async () => {
    // `GET /p/{slug}` reads Neon directly, so an unreachable or out-of-date
    // database turns it into a 500 — which is exactly what an unapplied migration
    // did on this host: a dead public URL that the deploy reported as `success`
    // and that cost a full session to diagnose, with a `request_id` in hand that
    // appeared in no log line anywhere.
    //
    // No mock and no stub: `DATABASE_URL` points nowhere, the query fails, and
    // the throw travels the real route into the real `onError`.
    const res = await app.fetch(
      new Request('https://api.test/p/sonda-a2-1116'),
      mockEnv({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }) as never,
    );

    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: { request_id: string } };
    const line = errorLineWith(body.error.request_id);

    // The three facts needed to start: which id, which route, that it was a 500.
    expect(line).toBeDefined();
    expect(line).toContain('GET /p/sonda-a2-1116 500');
  });

  it('does not leak the connection string into that line', async () => {
    // The error object carries the driver's message, which can quote the URL it
    // failed on. This asserts the *handler* adds no credential of its own — the
    // thrown error's own text is what the operator needs and is not scrubbed,
    // which is why the surrounding line is built from the path and nothing else.
    await app.fetch(
      new Request('https://api.test/p/sonda-a2-1116'),
      mockEnv({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }) as never,
    );

    const line = errorLines().join('\n');
    expect(line).not.toContain('postgres://');
    expect(line).not.toContain('JWT_SECRET');
  });
});

// ---------------------------------------------------------------------------
// Two failures, two distinct ids
// ---------------------------------------------------------------------------

describe('each failure gets its own id', () => {
  it('does not reuse one id across requests', async () => {
    const first = await triggerReal500();
    const second = await triggerReal500();

    const idOf = async (res: Response) =>
      ((await res.json()) as { error: { request_id: string } }).error.request_id;

    expect(await idOf(first)).not.toBe(await idOf(second));
  });

  it('logs one line per failure, so a count in the logs means a count of failures', async () => {
    await triggerReal500();
    await triggerReal500();

    expect(errorLines().filter((first) => first.includes('request_id='))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The credential never appears even under an unrelated failure
// ---------------------------------------------------------------------------

describe('a valid token is not echoed either', () => {
  it('does not leak a real-looking JWT when the failure is something else', async () => {
    // A guard against the shape "log the request when debugging" creeping back in
    // with a valid token, which is the case that actually matters.
    const token = await validToken();
    await app.fetch(
      new Request('https://api.test/brand/tenant-1.jpg', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      mockEnv() as never,
    );

    expect(errorText()).not.toContain(token);
    expect(errorText()).not.toContain(TEST_SECRET);
  });
});