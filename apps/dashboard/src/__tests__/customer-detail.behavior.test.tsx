// @vitest-environment jsdom

/**
 * The customer profile, read for what it prints: names and words, never the
 * ids and event codes the API hands over.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CustomerDetailPage from '../app/dashboard/customers/[id]/page';
import type { CustomerDetail } from '../lib/api';

const TIER_ID = 'b0000000-0000-4000-8000-00000000000b';

const mocks = vi.hoisted(() => ({
  customer: {} as Record<string, unknown>,
  tiers: [] as Array<{ id: string; name: string; multiplier: number }>,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'a0000000-0000-4000-8000-000000000001' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      getCustomer: vi.fn(async () => mocks.customer as unknown as CustomerDetail),
      getTiers: vi.fn(async () => mocks.tiers),
      getLoyaltyConfig: vi.fn(async () => ({ earnRate: 1, programName: 'Puntos' })),
      updateCustomer: vi.fn(),
    },
  };
});

beforeEach(() => {
  mocks.customer = {
    id: 'a0000000-0000-4000-8000-000000000001',
    fullName: 'Ana Ruiz',
    phone: '+56911112222',
    points: 320,
    totalPointsEarned: 900,
    currentTier: TIER_ID,
    currentTierId: TIER_ID,
    createdAt: '2025-11-02',
    customer_events: [
      {
        id: 'e1',
        eventType: 'customer.checked_in',
        payload: {},
        createdAt: new Date().toISOString(),
      },
    ],
    recent_transactions: [
      { id: 't1', type: 'adjust', points: 50, note: null, createdAt: new Date().toISOString() },
    ],
    consents: [],
  };
  mocks.tiers = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the customer profile', () => {
  it('never prints the tier id when the tier list is unavailable', async () => {
    render(<CustomerDetailPage />);
    await screen.findAllByText('Ana Ruiz');

    expect(screen.queryByText(new RegExp(TIER_ID))).toBeNull();
  });

  it('shows the tier by name when it is known', async () => {
    mocks.tiers = [{ id: TIER_ID, name: 'Plata', multiplier: 1.2 }];
    render(<CustomerDetailPage />);

    expect((await screen.findAllByText('Plata')).length).toBeGreaterThan(0);
  });

  it('describes activity in words, not event codes', async () => {
    render(<CustomerDetailPage />);
    await screen.findAllByText('Ana Ruiz');

    expect(screen.getByText('Visitó el local')).toBeTruthy();
    expect(screen.getByText('Ajuste de puntos')).toBeTruthy();
    expect(screen.queryByText('customer.checked_in')).toBeNull();
    expect(screen.queryByText('adjust')).toBeNull();
  });

  it('dates the customer’s start in the Chilean format', async () => {
    render(<CustomerDetailPage />);
    await screen.findAllByText('Ana Ruiz');

    expect(screen.getAllByText(/02-11-2025/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/2025-11-02/)).toBeNull();
  });
});
