// @vitest-environment jsdom

/**
 * The summary page that replaced Inicio, Programa and Analytics.
 *
 * The API reports totals since the program started, not per day, so the page
 * labels them that way instead of calling them "today".
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getKpis: vi.fn(), getTimeline: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getKpis: mocks.getKpis, getTimeline: mocks.getTimeline },
}));

import SummaryPage from '../app/dashboard/page';

beforeEach(() => {
  mocks.getKpis.mockResolvedValue({
    totalCustomers: 412,
    activeCustomers: 120,
    totalPointsIssued: 31240,
    totalPointsRedeemed: 4200,
    redemptionRate: 13,
    tierDistribution: { Bronce: 300, Plata: 100, Oro: 12 },
    rewardsClaimed: 37,
  });
  mocks.getTimeline.mockResolvedValue([
    {
      type: 'points.earned',
      customerName: 'Ana Rojas',
      description: 'sumó 45 puntos',
      timestamp: new Date().toISOString(),
    },
  ]);
});

afterEach(cleanup);

describe('the summary page', () => {
  it('shows the program totals, labelled as totals', async () => {
    render(<SummaryPage />);

    expect(await screen.findByText('Desde que empezó tu programa')).toBeTruthy();
    expect(screen.getByText('412')).toBeTruthy();
    expect(screen.getByText('120 activos')).toBeTruthy();
    expect(screen.getByText('31.240')).toBeTruthy();
    expect(screen.getByText('37')).toBeTruthy();
    expect(screen.getByText('13%')).toBeTruthy();
    expect(screen.queryByText(/hoy/i)).toBeNull();
  });

  it('lists recent movements and customers per tier', async () => {
    render(<SummaryPage />);

    expect(await screen.findByText('sumó 45 puntos', { exact: false })).toBeTruthy();
    expect(screen.getByText('Plata')).toBeTruthy();
    expect(screen.getByText('100 · 24%')).toBeTruthy();
  });

  it('points an empty feed at the till', async () => {
    mocks.getTimeline.mockResolvedValue([]);
    render(<SummaryPage />);

    const link = await screen.findByRole('link', { name: 'caja' });
    expect(link.getAttribute('href')).toBe('/dashboard/loyalty/pos');
  });
});
