// @vitest-environment node

/**
 * The two card-token calls, asserted on the `fetch` they actually make.
 *
 * - `getCustomerByCardToken` resolves the opaque credential a new pass carries.
 *   The token is user-supplied text going into a URL path, so it is encoded.
 * - `rotateCardToken` revokes the current credential with an operator reason.
 *   `PASS_UPDATE_FAILED` must survive as a code: the QR was revoked even though
 *   the Wallet pass was not updated, and the page has to say exactly that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '../lib/api';

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

let calls: Call[] = [];

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

const TOKEN = `vyc1.${'Ab9_-'.repeat(8)}xYz`;

const CUSTOMER = {
  id: 'cust-1',
  globalId: '879e76de-1f50-4afe-8b93-11949e9a9ae4',
  fullName: 'Ana Ruiz',
  phone: '+56911111111',
  points: 1250,
  currentTier: 'Oro',
  tier: { id: 'tier-oro', name: 'Oro', multiplier: 1.5 },
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getCustomerByCardToken', () => {
  it('asks the by-card-token route with the token encoded in the path', async () => {
    respondWith(200, { data: CUSTOMER });

    await api.getCustomerByCardToken(TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(
      new RegExp(`/v1/customers/by-card-token/${encodeURIComponent(TOKEN).replace(/[.]/g, '\\.')}$`),
    );
  });

  it('cannot be steered to another endpoint by what was scanned', async () => {
    respondWith(404, { error: { code: 'NOT_FOUND', message: 'Customer not found' } });

    await api.getCustomerByCardToken('../lookup?phone=1').catch(() => {});

    expect(calls[0]!.url).toContain('/v1/customers/by-card-token/..%2Flookup%3Fphone%3D1');
  });

  it('returns the same customer shape as a globalId scan', async () => {
    respondWith(200, { data: CUSTOMER });

    const found = await api.getCustomerByCardToken(TOKEN);

    expect(found).toEqual({
      id: 'cust-1',
      globalId: CUSTOMER.globalId,
      fullName: 'Ana Ruiz',
      phone: '+56911111111',
      points: 1250,
      currentTier: 'Oro',
      tier: CUSTOMER.tier,
    });
  });

  it('raises a 404 as an ApiError the page can recognise', async () => {
    respondWith(404, { error: { code: 'NOT_FOUND', message: 'Customer not found' } });

    const err = await api.getCustomerByCardToken(TOKEN).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

describe('rotateCardToken', () => {
  it('posts the reason to the rotate route of that customer', async () => {
    respondWith(200, { data: { version: 3, pass: 'updated' } });

    const result = await api.rotateCardToken('cust-1', 'Tarjeta extraviada');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/customers\/cust-1\/card-token\/rotate$/);
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({ reason: 'Tarjeta extraviada' });
    expect(result).toEqual({ version: 3, pass: 'updated' });
  });

  it('keeps PASS_UPDATE_FAILED as the error code', async () => {
    respondWith(502, {
      error: { code: 'PASS_UPDATE_FAILED', message: 'Google did not confirm' },
    });

    const err = await api.rotateCardToken('cust-1', 'Tarjeta extraviada').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe('PASS_UPDATE_FAILED');
  });
});
