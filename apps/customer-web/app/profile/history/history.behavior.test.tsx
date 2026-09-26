/**
 * The history page.
 *
 * The regression this file exists to prevent: the page used to read a stored
 * customer id out of localStorage, refuse to call the API at all when it was
 * missing, and tell the user to go back to a page that no longer wrote it. So
 * the mock here is `getOwnTransactions` and nothing else — there is no longer a
 * function on the client that could take a customer id.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HistoryPage from './page';

const mocks = vi.hoisted(() => ({
  getOwnTransactions: vi.fn(),
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
  api: {
    getOwnTransactions: mocks.getOwnTransactions,
    getProfile: mocks.getProfile,
  },
}));

const CUST = 'cust-1';

function makeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    customer_id: CUST,
    type: 'earn',
    points: 500,
    balance_after: 1200,
    reference_id: 'ref-1',
    note: null,
    created_at: '2026-02-02T10:00:00.000Z',
    ...overrides,
  };
}

function page(transactions: Record<string, unknown>[]) {
  return { data: transactions, meta: { total: transactions.length, page: 1, per_page: 50 } };
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: CUST,
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
  mocks.getOwnTransactions.mockReset();
  mocks.getProfile.mockReset();
  mocks.replace.mockReset();
  mocks.authLoading = false;
  mocks.customer = { fullName: 'Ada Lovelace', globalId: 'global-1' };
  mocks.getOwnTransactions.mockResolvedValue(page([makeTransaction()]));
  mocks.getProfile.mockResolvedValue(makeProfile());
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('history, no customer id anywhere', () => {
  it('loads on a device that has never stored an identifier, which used to be fatal', async () => {
    // The old page bailed out with a hard error when its stored key was absent,
    // so a customer on a fresh device could never see their own history.
    expect(localStorage.length).toBe(0);

    render(<HistoryPage />);

    expect(await screen.findByRole('list', { name: 'Tus movimientos de puntos' })).toBeTruthy();
    expect(mocks.getOwnTransactions).toHaveBeenCalled();
  });

  it('touches no localStorage key that could hold a customer id', async () => {
    // Asserted against the live storage calls rather than by naming the retired
    // key, so the guard keeps its meaning after the key is gone for good and
    // still catches any other key that turns up carrying an identifier.
    const touched = new Set<string>();
    const record = (key: string) => {
      touched.add(key);
      return null;
    };

    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(record);
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(record);
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(record);

    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    const identifierKeys = [...touched].filter((key) => /customer_id/.test(key));
    expect(identifierKeys).toEqual([]);
    // Only the session token is read, and nothing is written at all.
    expect([...touched].every((key) => /jwt/.test(key))).toBe(true);

    getSpy.mockRestore();
    setSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('asks the server for nobody in particular and passes no customer filter', async () => {
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    const [filters] = mocks.getOwnTransactions.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(filters)).not.toContain('customer_id');
    // Omitted means "mine": the server narrows a customer to their own rows
    // from the token, so sending nothing is the correct request, not a gap.
    expect(filters.type).toBeUndefined();
  });

  it('never mentions going back to a page to obtain an identifier', async () => {
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    expect(screen.queryByText(/No se encontró el perfil del cliente/)).toBeNull();
    expect(screen.queryByText(/Volvé a la página de perfil/)).toBeNull();
  });
});

describe('history, real rows', () => {
  it('renders the movements the server returned, newest first', async () => {
    mocks.getOwnTransactions.mockResolvedValue(
      page([
        makeTransaction({ id: 'tx-1', type: 'earn', points: 500, balance_after: 1200 }),
        makeTransaction({ id: 'tx-2', type: 'redeem', points: 400, balance_after: 800, note: 'Café chico' }),
      ]),
    );

    render(<HistoryPage />);
    const list = await screen.findByRole('list', { name: 'Tus movimientos de puntos' });
    const rows = within(list).getAllByRole('listitem');

    // Order is the server's response order, not a client sort.
    expect(rows[0].textContent).toContain('+500');
    expect(rows[1].textContent).toContain('−400');
    expect(screen.getByText('Café chico')).toBeTruthy();
  });

  it('renders an earn and a spend distinctly', async () => {
    mocks.getOwnTransactions.mockResolvedValue(
      page([
        makeTransaction({ id: 'tx-1', type: 'earn', points: 500, balance_after: 1200 }),
        makeTransaction({ id: 'tx-2', type: 'redeem', points: 400, balance_after: 800 }),
      ]),
    );

    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    expect(screen.getByText('Ganaste 500 puntos')).toBeTruthy();
    expect(screen.getByText('Canjeaste 400 puntos')).toBeTruthy();
    expect(document.querySelectorAll('.movement__points--earned')).toHaveLength(1);
    expect(document.querySelectorAll('.movement__points--redeemed')).toHaveLength(1);
  });

  it('expresses amounts in the tenant own points label', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'estampitas' } }),
    );

    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    expect(screen.getByText('Ganaste 500 estampitas')).toBeTruthy();
  });

  it('shows the balance each movement produced', async () => {
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    expect(screen.getByText('Saldo: 1.200 puntos')).toBeTruthy();
  });
});

describe('history, filters', () => {
  it('re-asks the server for one type when a filter is chosen', async () => {
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    fireEvent.click(screen.getByRole('button', { name: 'Canjeados' }));

    await waitFor(() =>
      expect(mocks.getOwnTransactions).toHaveBeenCalledWith({ type: 'redeem', limit: 50 }),
    );
  });

  it('exposes which filter is active rather than only colouring it', async () => {
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    const group = screen.getByRole('group', { name: 'Filtrar movimientos' });
    const pressed = within(group)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');

    expect(pressed.map((button) => button.textContent)).toEqual(['Todos']);
  });

  it('returns to the unfiltered list when Todos is chosen again', async () => {
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    fireEvent.click(screen.getByRole('button', { name: 'Ganados' }));
    await waitFor(() => expect(mocks.getOwnTransactions).toHaveBeenCalledWith({ type: 'earn', limit: 50 }));

    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => expect(mocks.getOwnTransactions).toHaveBeenCalledWith({ type: undefined, limit: 50 }));
  });

  it('keeps the filter controls on screen while the next filter is loading', async () => {
    // Tearing the whole page down for a round trip would remove the control the
    // customer just pressed from under their finger.
    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    // A mutable holder rather than a `let release: (() => void) | null`: the
    // assignment happens inside a promise executor, and control-flow analysis
    // narrows the variable to `null` at every use site outside it.
    const gate: { open: () => void } = { open: () => {} };
    mocks.getOwnTransactions.mockImplementationOnce(
      () => new Promise((resolve) => {
        gate.open = () =>
          resolve(page([makeTransaction({ id: 'tx-9', type: 'redeem', points: 400, balance_after: 800 })]));
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Canjeados' }));

    // Still there, and the previous rows are not being shown under a filter
    // they are not the answer to.
    expect(screen.getByRole('group', { name: 'Filtrar movimientos' })).toBeTruthy();
    expect(screen.getByText('Cargando tu historial…')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Tus movimientos de puntos' })).toBeNull();

    gate.open();
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });
  });

  it('ignores a slow answer to a filter the customer has already moved off', async () => {
    // Two filters in quick succession put two reads in flight and nothing
    // orders the responses. If the first lands last it would repopulate the
    // list with the wrong rows under the newer filter's heading.
    const resolvers: ((value: unknown) => void)[] = [];

    render(<HistoryPage />);
    await screen.findByRole('list', { name: 'Tus movimientos de puntos' });

    mocks.getOwnTransactions.mockImplementation(
      () => new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ganados' }));
    fireEvent.click(screen.getByRole('button', { name: 'Canjeados' }));

    const [first, second] = resolvers;

    // The newest request answers first, then the stale one arrives late.
    second?.(page([makeTransaction({ id: 'tx-latest', type: 'redeem', points: 400, balance_after: 800 })]));
    await screen.findByText('Canjeaste 400 puntos');

    first?.(page([makeTransaction({ id: 'tx-stale', type: 'earn', points: 999, balance_after: 1799 })]));

    // The stale rows never appear: the list still answers the filter that is
    // actually selected.
    await waitFor(() => expect(screen.queryByText('+999')).toBeNull());
    expect(screen.getByText('−400')).toBeTruthy();
  });
});

describe('history, honest absence', () => {
  it('says there is nothing yet, and announces it', async () => {
    mocks.getOwnTransactions.mockResolvedValue(page([]));

    render(<HistoryPage />);

    const status = await screen.findByText('Sin movimientos');
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Tus movimientos de puntos' })).toBeNull();
  });

  it('distinguishes an empty filter from an empty history', async () => {
    mocks.getOwnTransactions.mockResolvedValue(page([]));

    render(<HistoryPage />);
    await screen.findByText('Sin movimientos');

    fireEvent.click(screen.getByRole('button', { name: 'Canjeados' }));

    expect(await screen.findByText(/Todavía no canjeaste ninguna recompensa/)).toBeTruthy();
  });

  it('renders no invented movement to fill an empty list', async () => {
    mocks.getOwnTransactions.mockResolvedValue(page([]));

    render(<HistoryPage />);
    await screen.findByText('Sin movimientos');

    expect(document.querySelectorAll('.movement')).toHaveLength(0);
    expect(screen.queryByText(/Saldo:/)).toBeNull();
  });

  it('reports a failed load with a retry and shows no movements at all', async () => {
    mocks.getOwnTransactions.mockRejectedValue(new Error('gateway exploded'));

    render(<HistoryPage />);

    expect(await screen.findByText('No pudimos cargar tu historial')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    expect(document.querySelectorAll('.movement')).toHaveLength(0);
  });

  it('re-fetches when the retry is pressed', async () => {
    mocks.getOwnTransactions.mockRejectedValueOnce(new Error('boom'));
    render(<HistoryPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('list', { name: 'Tus movimientos de puntos' })).toBeTruthy();
    expect(mocks.getOwnTransactions).toHaveBeenCalledTimes(2);
  });
});

describe('history, session', () => {
  it('sends an unauthenticated visitor to login and reveals no movements', async () => {
    mocks.customer = null;

    render(<HistoryPage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(mocks.getOwnTransactions).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.movement')).toHaveLength(0);
  });
});
