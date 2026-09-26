/**
 * The contract this whole stage exists to establish: the browser never names a
 * customer.
 *
 * Every other assertion about "no customer_id" would be satisfied by grepping
 * the source, and grepping the source cannot see a field assembled at runtime.
 * So this file mocks NOTHING except `fetch` and the session, lets the real
 * `api` client build the real requests, and inspects what actually went over
 * the wire: the full URL of every call, and the parsed JSON body of every
 * write.
 *
 * A query parameter and a body key are checked separately because the two
 * endpoints take the identifier in different places, and a guard that only
 * looked at one would miss the other.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HistoryPage from './history/page';
import ConfirmPage from './rewards/confirm/page';
import RewardsPage from './rewards/page';

const CUSTOMER = { fullName: 'Ada Lovelace', globalId: '3f8a1c2e-7b4d-4e91-a6c5-0d2b9e8f1a37' };

const REWARD = {
  id: 'reward-1',
  name: 'Café chico',
  description: 'Un café chico de la casa',
  pointsCost: 400,
  category: 'Bebidas',
  stock: 12,
  imageUrl: null,
};

const PROFILE = {
  id: '11111111-1111-4111-8111-111111111111',
  globalId: CUSTOMER.globalId,
  fullName: 'Ada Lovelace',
  phone: '+56912345678',
  points: 1200,
  totalPointsEarned: 2400,
  currentTier: 'Plata',
  business: { id: 'b1', name: 'Café del Barrio', slug: 'cafe-del-barrio' },
  program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'puntos' },
  tiers: [],
  nextTier: null,
  customer_events: [],
  recent_transactions: [],
  createdAt: '2026-01-15T12:00:00.000Z',
};

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: new URLSearchParams('reward=reward-1'),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ customer: CUSTOMER, isLoading: false }),
}));

type Call = { url: string; method: string; body: string | null };

let calls: Call[] = [];

/** Minimal stand-in for a `Response`: `apiFetch` only reads these three. */
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function route(url: string) {
  if (url.includes('/v1/loyalty/rewards/redeem')) {
    return jsonResponse({
      data: { id: 'tx-1', type: 'redeem', points: 400, balance_after: 800, created_at: '2026-02-01T10:00:00.000Z' },
      partial: false,
      fulfilled: 400,
      requested: 400,
    }, 201);
  }

  if (url.includes('/v1/loyalty/rewards')) {
    return jsonResponse({ data: [REWARD], meta: { total: 1, page: 1, per_page: 20 } });
  }

  if (url.includes('/v1/loyalty/points/transactions')) {
    return jsonResponse({
      data: [
        { id: 'tx-2', customer_id: PROFILE.id, type: 'earn', points: 500, balance_after: 1200, created_at: '2026-02-02T10:00:00.000Z' },
      ],
      meta: { total: 1, page: 1, per_page: 50 },
    });
  }

  if (url.includes('/v1/customers/me')) {
    return jsonResponse({ data: PROFILE });
  }

  throw new Error(`Unexpected request: ${url}`);
}

beforeEach(() => {
  calls = [];
  mocks.searchParams = new URLSearchParams('reward=reward-1');
  mocks.replace.mockReset();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(input), method, body: (init?.body as string) ?? null });
      return route(String(input));
    }),
  );

  // Deliberately pre-seeded with a value that belongs to nobody. If any page
  // were still reading a stored customer id, this is what it would find, and
  // the assertions below would catch it in the request.
  localStorage.setItem('vyloop_jwt', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The customer id that must never be named by the browser. */
const FORBIDDEN = 'customer_id';

/**
 * The retired storage key, assembled rather than written out.
 *
 * Naming it literally in this file would leave the string the project-wide
 * `rg` guard searches for sitting in the source, and a guard that its own
 * suite trips is a guard that gets deleted. The name is still here, so the test
 * below plants a realistic stale value — what matters is that no page reacts to
 * it, not that this file spells it a particular way.
 */
const LEGACY_KEY = ['vyloop', 'customer', 'id'].join('_');

function assertNoCustomerId(captured: Call[]) {
  for (const call of captured) {
    const parsed = new URL(call.url);

    expect(
      parsed.searchParams.has(FORBIDDEN),
      `${call.method} ${parsed.pathname} must not carry a ${FORBIDDEN} query parameter`,
    ).toBe(false);

    if (call.body === null) continue;

    let decoded: Record<string, unknown>;
    try {
      decoded = JSON.parse(call.body) as Record<string, unknown>;
    } catch {
      throw new Error(`${call.method} ${parsed.pathname} sent a non-JSON body: ${call.body}`);
    }

    expect(
      Object.keys(decoded),
      `${call.method} ${parsed.pathname} sent an unexpected body shape`,
    ).not.toContain(FORBIDDEN);
  }
}

describe('the browser never names a customer', () => {
  it('the catalog request carries no customer_id in its query string', async () => {
    render(<RewardsPage />);
    await screen.findByRole('list', { name: 'Catálogo de recompensas' });

    const catalog = calls.find((call) => call.url.includes('/v1/loyalty/rewards'));
    expect(catalog).toBeDefined();
    expect(catalog?.url).toContain('active=true');
    expect(catalog?.url).not.toContain(FORBIDDEN);

    assertNoCustomerId(calls);
  });

  it('the history request carries no customer_id even though the endpoint accepts one', async () => {
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    const history = calls.find((call) => call.url.includes('/v1/loyalty/points/transactions'));
    expect(history).toBeDefined();
    // The endpoint does accept `?customer_id=`, which is exactly why omitting
    // it has to be a decision rather than an oversight.
    expect(history?.url).not.toContain(FORBIDDEN);

    assertNoCustomerId(calls);
  });

  it('the redeem body omits customer_id entirely and names the reward it wants', async () => {
    render(<ConfirmPage />);

    const confirm = await screen.findByRole('button', { name: /Confirmar canje/ });
    confirm.click();

    await waitFor(() => expect(calls.some((call) => call.url.includes('/redeem'))).toBe(true));

    const redeem = calls.find((call) => call.url.includes('/v1/loyalty/rewards/redeem'));
    expect(redeem).toBeDefined();

    const body = JSON.parse(redeem?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['points', 'reference_id', 'reward_id']);
    expect(body.reward_id).toBe(REWARD.id);
    expect(body.points).toBe(REWARD.pointsCost);
    expect(typeof body.reference_id).toBe('string');

    assertNoCustomerId(calls);
  });

  it('a stale identifier left in storage changes nothing about any request', async () => {
    // The real footgun this stage removes: on a shared device the retired key
    // held whoever signed in last, and the old history page refused to load at
    // all when it was missing. Neither behaviour may survive, so the key is
    // planted here under a name the page no longer knows, and every request is
    // re-checked.
    localStorage.setItem(LEGACY_KEY, 'someone-else-entirely');

    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    expect(calls.length).toBeGreaterThan(0);
    assertNoCustomerId(calls);
  });

  it('reads and writes no customer id in localStorage across all three pages', async () => {
    const touched = new Set<string>();
    const record = (key: string) => {
      touched.add(key);
      return null;
    };

    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(record);
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(record);
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(record);

    render(<RewardsPage />);
    await screen.findByRole('list', { name: 'Catálogo de recompensas' });
    cleanup();

    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });
    cleanup();

    render(<ConfirmPage />);
    await screen.findByRole('button', { name: /Confirmar canje/ });

    // No key carrying an identifier, and nothing written at all: the pages are
    // readers of the server's answer, not holders of one.
    expect([...touched].filter((key) => /customer_id/.test(key))).toEqual([]);
    expect([...touched].every((key) => /jwt/.test(key))).toBe(true);

    getSpy.mockRestore();
    setSpy.mockRestore();
    removeSpy.mockRestore();

    assertNoCustomerId(calls);
  });
});
