// @vitest-environment node

/**
 * What the dashboard sends, and what it refuses to do to the answer.
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs
 * in `node`. There is no jsdom and no testing-library — but `lib/api.ts` is plain
 * `fetch` plus a module-scope `API_URL`, so it can be exercised for real by
 * stubbing the global. These are not source-reading tests: they assert on the
 * actual `fetch` calls the helper makes.
 *
 * Three things are load-bearing here:
 *
 * 1. The lookup sends **exactly one** identifier. A second one, or a `q`, is how
 *    "find the person at the counter" becomes "list the customers".
 * 2. `pass.state` arrives verbatim. `not_issued` (we never checked) and
 *    `not_saved` (Google says it is not there) are opposite facts, and a mapper
 *    that turns either into `hasPass: false` destroys the distinction before the
 *    UI ever sees it.
 * 3. A 404 and a 500 must be tellable apart. The 404 is an invitation to
 *    register the customer; a 500 is a broken system, and answering it with
 *    "register them" would be a lie.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '../lib/api';

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];

/** Answer the next fetch with `status` and `body`. */
function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

const CUSTOMER = {
  id: 'cust-1',
  globalId: 'global-1',
  fullName: 'Ana Ruiz',
  phone: '+56911111111',
  email: 'ana@test.com',
  points: 1250,
  currentTier: 'Oro',
  tier: { id: 'tier-oro', name: 'Oro', multiplier: 1.5 },
  pass: { state: 'issued', lastSyncedAt: null },
};

function ok(state: string | null) {
  return {
    data: {
      ...CUSTOMER,
      pass: { state, lastSyncedAt: null },
    },
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── One identifier, one request ───────────────────────────────────────

describe('lookupCustomer', () => {
  it('sends exactly one identifier', async () => {
    respondWith(200, ok('issued'));
    await api.lookupCustomer({ phone: '+56911111111' });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toContain('/v1/customers/lookup');
    expect(url.searchParams.get('phone')).toBe('+56911111111');
    expect(url.searchParams.has('email')).toBe(false);
    expect(url.searchParams.has('globalId')).toBe(false);
  });

  it('never sends a free-text query parameter', async () => {
    // `q` is how a lookup becomes a list. It must not exist on this call.
    respondWith(200, ok('issued'));
    await api.lookupCustomer({ email: 'ana@test.com' });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.has('query')).toBe(false);
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('never sends a businessId', async () => {
    // The tenant comes from the token alone.
    respondWith(200, ok('issued'));
    await api.lookupCustomer({ globalId: 'global-1' });

    expect(new URL(calls[0]!.url).searchParams.has('businessId')).toBe(false);
  });

  it('refuses to send two identifiers at once', async () => {
    // Caught on the client so the mistake never becomes a request. The server
    // refuses it too; this is about the error being ours and specific.
    await expect(
      api.lookupCustomer({ phone: '+56911111111', email: 'ana@test.com' }),
    ).rejects.toThrow(/exactamente un|exactly one/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses to send none', async () => {
    await expect(api.lookupCustomer({})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// ─── The pass state survives the trip ──────────────────────────────────

describe('pass state mapping', () => {
  it('passes not_issued through untouched', async () => {
    respondWith(200, ok('not_issued'));
    const found = await api.lookupCustomer({ phone: '+56911111111' });

    expect(found.pass.state).toBe('not_issued');
    expect(found.pass.unverified).toBe(true);
  });

  it('passes not_saved through untouched', async () => {
    respondWith(200, ok('not_saved'));
    const found = await api.lookupCustomer({ phone: '+56911111111' });

    expect(found.pass.state).toBe('not_saved');
    // A definite answer from Google is not a gap in our knowledge.
    expect(found.pass.unverified).toBe(false);
  });

  it('keeps a missing pass row distinct from either state', async () => {
    respondWith(200, ok(null));
    const found = await api.lookupCustomer({ phone: '+56911111111' });

    expect(found.pass.state).toBeNull();
    expect(found.pass.unverified).toBe(true);
  });

  it('exposes no hasPass boolean to collapse the states with', async () => {
    respondWith(200, ok('not_issued'));
    const found = await api.lookupCustomer({ phone: '+56911111111' });

    expect((found.pass as Record<string, unknown>).hasPass).toBeUndefined();
  });

  it('keeps an unrecognised state rather than defaulting it', async () => {
    // Fail closed, as the schema requires of every reader of this column.
    respondWith(200, ok('some_future_state'));
    const found = await api.lookupCustomer({ phone: '+56911111111' });

    expect(found.pass.state).toBe('some_future_state');
    expect(found.pass.unverified).toBe(true);
  });
});

// ─── Telling "not registered" from "broken" ────────────────────────────

describe('lookup errors', () => {
  it('raises a not-registered error the UI can act on', async () => {
    respondWith(404, {
      error: { code: 'CUSTOMER_NOT_REGISTERED', message: 'No customer is registered.' },
    });

    const err = await api
      .lookupCustomer({ phone: '+56999999999' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe('CUSTOMER_NOT_REGISTERED');
  });

  it('raises a duplicate-phone error as its own thing', async () => {
    respondWith(409, {
      error: { code: 'CUSTOMER_PHONE_AMBIGUOUS', message: 'More than one customer.' },
    });

    const err = await api
      .lookupCustomer({ phone: '+56911111111' })
      .catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('CUSTOMER_PHONE_AMBIGUOUS');
  });

  it('keeps a system failure distinct from a missing customer', async () => {
    // The distinction the whole 404 path depends on: answering a broken system
    // with "register this customer" sends a real person into a wrong form.
    respondWith(500, {
      error: { code: 'INTERNAL_ERROR', message: 'Something broke.' },
    });

    const err = await api
      .lookupCustomer({ phone: '+56999999999' })
      .catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).not.toBe('CUSTOMER_NOT_REGISTERED');
  });

  it('still carries the message the server wrote', async () => {
    // Existing call sites render `err.message`; ApiError must not swallow it.
    respondWith(404, {
      error: { code: 'CUSTOMER_NOT_REGISTERED', message: 'No customer is registered.' },
    });

    await expect(api.lookupCustomer({ phone: '+56999999999' })).rejects.toThrow(
      'No customer is registered.',
    );
  });

  it('is an Error, so existing catch blocks keep working', async () => {
    respondWith(404, {
      error: { code: 'CUSTOMER_NOT_REGISTERED', message: 'nope' },
    });

    const err = await api.lookupCustomer({ phone: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });
});
