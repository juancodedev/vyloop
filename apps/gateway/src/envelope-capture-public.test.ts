/**
 * The temporary envelope capture, as seen from the gateway.
 *
 * ## Why this file exists and not just a route test
 *
 * A capture behind a 401 captures nothing, and the 401 says nothing useful: the
 * request is unsigned, exactly like a real Google delivery, so the failure reads
 * as "Google is not posting" or "the diagnostic is broken" rather than "the
 * gateway never exempted this path". The exemption lives in *this* package, so
 * only a test here can see it missing.
 *
 * Two things must be true and they pull in opposite directions, so both are
 * asserted:
 *
 * 1. **Public**, because Google has no JWT, no `X-User-Id` and no `X-Business-Id`
 *    to send.
 * 2. **Rate limited**, because this repo's limiter deliberately leaves a route
 *    absent from `anonymousLimits` *unlimited*. Public by necessity is exactly the
 *    shape that needs a number, and an exemption added without one would be an
 *    unbounded anonymous endpoint.
 *
 * The path must also stay an exact match, so a sibling under it stays
 * authenticated.
 */

import { describe, expect, it, vi } from 'vitest';

import app, {
  ENVELOPE_CAPTURE_LIMIT_PER_WINDOW,
  ENVELOPE_CAPTURE_PATH as GATEWAY_CAPTURE_PATH,
  isPublicApiPath,
} from './index';

/**
 * The cross-package drift guard.
 *
 * `isPublicApiPath` cannot be checked against the worker's constant by
 * importing it: this package does not depend on `@vyloop/wallet`, and adding a
 * runtime edge dependency from the public face to the service behind it would be
 * the wrong direction for a diagnostic. So the guard reads the worker's source
 * and checks the literal — the same shape as `wrangler-config.contract.test.ts`,
 * which reads `wrangler.jsonc` rather than importing it.
 *
 * Without this, both suites stay green after a one-sided rename: the gateway
 * keeps forwarding a path the worker no longer serves, and the answer is a 404
 * from a diagnostic nobody is watching.
 */
describe('the capture path agrees across packages', () => {
  it('is the exact literal the wallet worker defines', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const workerSource = readFileSync(
      join(__dirname, '..', '..', '..', 'workers', 'wallet', 'src', 'envelope-capture.ts'),
      'utf8',
    );

    const declared = /ENVELOPE_CAPTURE_PATH = '([^']+)'/.exec(workerSource)?.[1];

    expect(declared).toBeDefined();
    expect(GATEWAY_CAPTURE_PATH).toBe(declared);
  });

  it('is genuinely public, read straight off the predicate', async () => {
    expect(isPublicApiPath(GATEWAY_CAPTURE_PATH, 'POST')).toBe(true);
    expect(isPublicApiPath(`${GATEWAY_CAPTURE_PATH}/admin`, 'POST')).toBe(false);
  });
});

/** Mirrors the wallet worker's `ENVELOPE_CAPTURE_PATH`; asserted there and here. */
const CAPTURE_PATH = '/v1/wallet/google/envelope-capture';

function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    JWT_SECRET: 'test-jwt-secret-key-for-unit-tests-only',
    RATE_LIMITER: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    wallet: {
      fetch: async () => new Response('{}', { status: 200 }),
    },
    ...overrides,
  };
}

function captureRequest(path = CAPTURE_PATH): Request {
  return new Request(`https://api.test${path}`, {
    method: 'POST',
    body: JSON.stringify({ protocolVersion: 'ECv2SigningOnly' }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('The envelope capture exemption', () => {
  it('forwards an unsigned capture to the wallet worker instead of 401', async () => {
    const wallet = { fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) };

    const res = await app.fetch(captureRequest(), mockEnv({ wallet }) as never);

    expect(res.status).toBe(200);
    expect(wallet.fetch).toHaveBeenCalledTimes(1);
  });

  it('demands no X-Business-Id, because a capture carries none', async () => {
    const res = await app.fetch(captureRequest(), mockEnv() as never);

    expect(res.status).toBe(200);
  });

  it('stays an exact path, so a sibling under it is not public', async () => {
    // The exemption is a comparison, not a prefix. A prefix would make
    // `/v1/wallet/google/envelope-capture/admin` public too, and nothing about
    // that failure would look like an auth decision.
    for (const sibling of [
      `${CAPTURE_PATH}/admin`,
      '/v1/wallet/google/envelope-captureX',
      '/v1/wallet/google/envelope',
    ]) {
      const res = await app.fetch(captureRequest(sibling), mockEnv() as never);
      expect(res.status, sibling).toBe(401);
    }
  });

  it('treats a query string as the same route, because pathname excludes it', async () => {
    // Not a hole: the exemption compares `pathname`, so `?x=1` is the capture
    // route and not a different one. Pinned because the first draft of this file
    // asserted the opposite and was wrong — a query string cannot widen an
    // exact-match exemption, it only reaches the route it already matched.
    const res = await app.fetch(captureRequest(`${CAPTURE_PATH}?x=1`), mockEnv() as never);

    expect(res.status).toBe(200);
  });

  it('leaves the real callback and the customer wallet routes authenticated or as they were', async () => {
    // The narrowness assertion that matters: adding a public diagnostic must not
    // widen anything else.
    for (const path of ['/v1/wallet/status', '/v1/wallet/pass']) {
      const res = await app.fetch(new Request(`https://api.test${path}`), mockEnv() as never);
      expect(res.status, path).toBe(401);
    }
  });
});

describe('The envelope capture rate limit', () => {
  /** `requestCount` stands in for the stored per-window counter. */
  function rateLimitMock(initial: number) {
    let count = initial;
    return {
      get: async () => String(count),
      put: async () => {
        count += 1;
      },
      delete: async () => {},
    };
  }

  it('throttles the capture, which is public and would otherwise be unlimited', async () => {
    // The repo's limiter keys on business_id and leaves routes absent from
    // `anonymousLimits` with no limit at all. That is the right default for a
    // narrow public surface and the wrong one for a route added by necessity, so
    // this asserts the limit exists rather than trusting the shape of the code.
    const res = await app.fetch(
      captureRequest(),
      mockEnv({ RATE_LIMITER: rateLimitMock(ENVELOPE_CAPTURE_LIMIT_PER_WINDOW) }) as never,
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('sets the limit high enough that a real burst of saves is not dropped', async () => {
    // A capture that throttles the investigation is worse than no capture: the
    // operator loses the delivery they were waiting for, silently, and the
    // envelope expires in hours. Google retries with backoff and its callbacks
    // arrive from one address, so the number is generous by design.
    expect(ENVELOPE_CAPTURE_LIMIT_PER_WINDOW).toBeGreaterThanOrEqual(120);
  });

  it('does not throttle the real callback with the capture limit', async () => {
    // Each public route needs its own number. Sharing one means tightening the
    // capture to stop abuse would also start dropping real deliveries.
    const res = await app.fetch(
      new Request('https://api.test/v1/wallet/google/callback', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      }),
      mockEnv({ RATE_LIMITER: rateLimitMock(ENVELOPE_CAPTURE_LIMIT_PER_WINDOW) }) as never,
    );

    expect(res.status).not.toBe(429);
  });
});