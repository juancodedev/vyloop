/**
 * `api.getWalletCard`, against a stubbed `fetch`.
 *
 * The member QR encodes whatever this returns, so the two properties that matter
 * are the wire ones: it asks `GET /v1/wallet/card` with the customer's own JWT
 * (the route resolves the customer from the token, never from a parameter), and
 * it hands back exactly `string | null`. Anything else is malformed and must
 * reject, so the caller falls back to the uuid instead of encoding `undefined`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './api';
import { WALLET_RESPONSE_MALFORMED } from './wallet';

const TOKEN = `vyc1.${'A'.repeat(43)}`;

function createResponse(status: number, body: unknown = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  localStorage.clear();
  localStorage.setItem('vyloop_jwt', 'customer-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('api.getWalletCard', () => {
  it('asks GET /v1/wallet/card with the customer JWT and returns the token', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200, { data: { card_token: TOKEN } }));

    await expect(api.getWalletCard()).resolves.toBe(TOKEN);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/wallet\/card$/);
    expect(options.method ?? 'GET').toBe('GET');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer customer-token');
  });

  it('returns null for a legacy customer', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200, { data: { card_token: null } }));

    await expect(api.getWalletCard()).resolves.toBeNull();
  });

  it('rejects a 200 without a card_token string or null as malformed', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200, { data: {} }));

    const thrown = await api.getWalletCard().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe(WALLET_RESPONSE_MALFORMED);
  });

  it('rejects a non-2xx answer with its status and code', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(503, { error: { code: 'WALLET_UNAVAILABLE', message: 'down' } }),
    );

    const thrown = await api.getWalletCard().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(503);
    expect((thrown as ApiError).code).toBe('WALLET_UNAVAILABLE');
  });
});
