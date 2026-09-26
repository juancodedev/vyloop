/**
 * The catalog page.
 *
 * `api` is mocked with `getRewards` and `getProfile` only, so a page reaching
 * for anything else would throw rather than quietly pass. What is asserted is
 * what a customer can observe: the real reward names, an honest absence when
 * the catalog is empty, and a link that carries the reward's own id.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RewardsPage from './page';

const mocks = vi.hoisted(() => ({
  getRewards: vi.fn(),
  getProfile: vi.fn(),
  replace: vi.fn(),
  authLoading: false,
  customer: { fullName: 'Ada Lovelace', globalId: 'global-1' } as
    | { fullName: string; globalId: string }
    | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ customer: mocks.customer, isLoading: mocks.authLoading }),
}));

vi.mock('../../lib/api', () => ({
  api: { getRewards: mocks.getRewards, getProfile: mocks.getProfile },
}));

type CatalogRow = Record<string, unknown>;

function makeReward(overrides: CatalogRow = {}): CatalogRow {
  return {
    id: 'reward-1',
    name: 'Café chico',
    description: 'Un café chico de la casa',
    pointsCost: 400,
    category: 'Bebidas',
    stock: 12,
    imageUrl: null,
    ...overrides,
  };
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cust-1',
    globalId: 'global-1',
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
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getRewards.mockReset();
  mocks.getProfile.mockReset();
  mocks.replace.mockReset();
  mocks.authLoading = false;
  mocks.customer = { fullName: 'Ada Lovelace', globalId: 'global-1' };
  mocks.getRewards.mockResolvedValue([makeReward()]);
  mocks.getProfile.mockResolvedValue(makeProfile());
});

afterEach(cleanup);

describe('rewards catalog, session', () => {
  it('sends an unauthenticated visitor to login and reveals no catalog', async () => {
    mocks.customer = null;

    render(<RewardsPage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(mocks.getRewards).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Catálogo de recompensas' })).toBeNull();
  });

  it('does not redirect while the session is still being restored', async () => {
    mocks.authLoading = true;
    mocks.customer = null;

    render(<RewardsPage />);

    await screen.findByText('Cargando recompensas…');
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.getRewards).not.toHaveBeenCalled();
  });
});

describe('rewards catalog, real rows', () => {
  it('renders the rewards the server returned and nothing else', async () => {
    mocks.getRewards.mockResolvedValue([
      makeReward(),
      makeReward({ id: 'reward-2', name: 'Medialunas', pointsCost: 250, category: 'Comida', stock: 3 }),
    ]);

    render(<RewardsPage />);
    const list = await screen.findByRole('list', { name: 'Catálogo de recompensas' });

    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Café chico' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Medialunas' })).toBeTruthy();
    expect(screen.getByText('250 puntos')).toBeTruthy();
  });

  it('expresses every cost in the tenant own points label', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'estampitas' } }),
    );

    render(<RewardsPage />);
    await screen.findByRole('list', { name: 'Catálogo de recompensas' });

    expect(screen.getByText('400 estampitas')).toBeTruthy();
  });

  it('drops the unit when the tenant has no program configured', async () => {
    mocks.getProfile.mockResolvedValue(makeProfile({ program: null }));

    render(<RewardsPage />);
    await screen.findByRole('list', { name: 'Catálogo de recompensas' });

    expect(screen.getByText('400')).toBeTruthy();
  });

  it('points each card at the confirmation step for that reward id', async () => {
    render(<RewardsPage />);
    await screen.findByRole('list', { name: 'Catálogo de recompensas' });

    expect(screen.getByRole('link', { name: 'Canjear Café chico' }).getAttribute('href')).toBe(
      '/profile/rewards/confirm?reward=reward-1',
    );
  });
});

describe('rewards catalog, honest absence', () => {
  it('says so when the catalog is empty, and announces it', async () => {
    mocks.getRewards.mockResolvedValue([]);

    render(<RewardsPage />);

    const status = await screen.findByText('No hay recompensas disponibles');
    expect(status).toBeTruthy();
    // Announced as a status, not left as blank space the user has to interpret.
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Catálogo de recompensas' })).toBeNull();
  });

  it('never falls back to a placeholder reward when the catalog is empty', async () => {
    mocks.getRewards.mockResolvedValue([]);

    render(<RewardsPage />);
    await screen.findByText('No hay recompensas disponibles');

    // No invented name, price or stock level to fill the gap.
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByText(/\d+\s*puntos/)).toBeNull();
  });

  it('reports a failed load with a retry and renders no catalog at all', async () => {
    mocks.getRewards.mockRejectedValue(new Error('gateway exploded'));

    render(<RewardsPage />);

    expect(await screen.findByText('No pudimos cargar las recompensas')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Catálogo de recompensas' })).toBeNull();
  });

  it('re-fetches the catalog when the retry is pressed', async () => {
    mocks.getRewards.mockRejectedValueOnce(new Error('boom'));
    render(<RewardsPage />);

    (await screen.findByRole('button', { name: 'Reintentar' })).click();

    expect(await screen.findByRole('list', { name: 'Catálogo de recompensas' })).toBeTruthy();
    expect(mocks.getRewards).toHaveBeenCalledTimes(2);
  });
});

describe('rewards catalog, stock reaching the page', () => {
  it('refuses to offer a reward the server reported as sold out', async () => {
    // The `?active=true` filter normally drops these rows, so this is the race:
    // the catalog was read while stock was still positive.
    mocks.getRewards.mockResolvedValue([makeReward({ stock: 0 })]);

    render(<RewardsPage />);
    await screen.findByRole('list', { name: 'Catálogo de recompensas' });

    const button = screen.getByRole('button', { name: 'Agotado' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole('link', { name: /Canjear/ })).toBeNull();
  });

  it('still offers a reward whose stock is not tracked', async () => {
    mocks.getRewards.mockResolvedValue([makeReward({ stock: null })]);

    render(<RewardsPage />);
    await screen.findByRole('list', { name: 'Catálogo de recompensas' });

    expect(screen.getByText('Stock no controlado')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Canjear Café chico' })).toBeTruthy();
  });
});
