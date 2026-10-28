// @vitest-environment jsdom

/**
 * A campaign's detail, as a merchant reads it: what was sent, to which
 * branch, how many notifications arrived, and why the others did not.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPushCampaignDetail: vi.fn(),
  composePushCampaign: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ referenceId: 'promo-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({ api: mocks }));

import CampaignDetailPage from '../app/dashboard/communication/campaigns/[referenceId]/page';

const DETAIL = {
  reference_id: 'promo-1',
  title: 'Café al 2x1',
  body: 'Solo hoy',
  target: { branch_id: '11111111-1111-4111-8111-111111111111' },
  target_type: 'branch',
  branch_name: 'Providencia',
  audience_size: 12,
  delivered: 9,
  failed: 1,
  pending: 2,
  failures: [
    {
      customer_name: 'Pedro Soto',
      error: 'The browser is no longer registered for push.',
      created_at: '2026-10-28T12:01:00.000Z',
    },
  ],
  created_at: '2026-10-28T12:00:00.000Z',
};

beforeEach(() => {
  mocks.getPushCampaignDetail.mockResolvedValue(DETAIL);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the campaign detail', () => {
  it('shows the real counts, and no "omitidos" it cannot know', async () => {
    render(<CampaignDetailPage />);

    expect(await screen.findByRole('heading', { name: 'Café al 2x1' })).toBeTruthy();
    expect(screen.getByText('Enviadas').nextElementSibling?.textContent).toBe('9');
    expect(screen.getByText('Fallidas').nextElementSibling?.textContent).toBe('1');
    expect(screen.getByText('En cola').nextElementSibling?.textContent).toBe('2');
    expect(screen.queryByText('Omitidos')).toBeNull();
  });

  it('names the branch instead of printing its id', async () => {
    render(<CampaignDetailPage />);

    expect(await screen.findByText(/Providencia/)).toBeTruthy();
    expect(screen.queryByText(/11111111-1111/)).toBeNull();
  });

  it('lists each failed delivery with the customer and the reason, in Spanish', async () => {
    render(<CampaignDetailPage />);

    expect(await screen.findByText('Pedro Soto')).toBeTruthy();
    expect(screen.getByText(/ya no acepta notificaciones/)).toBeTruthy();
  });

  it('offers no resend the server would refuse', async () => {
    render(<CampaignDetailPage />);
    await screen.findByText('Pedro Soto');

    expect(screen.queryByRole('button', { name: /Reenviar/ })).toBeNull();
  });

  it('says so when the campaign cannot be loaded', async () => {
    mocks.getPushCampaignDetail.mockRejectedValueOnce(new Error('Campaign not found.'));
    render(<CampaignDetailPage />);

    expect(await screen.findByText('No pudimos cargar esta campaña.')).toBeTruthy();
  });
});
