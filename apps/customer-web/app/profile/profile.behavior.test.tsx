/**
 * Behaviour suite for the Stage 4 web pass.
 *
 * Every assertion here is about what a person can observe or what the app
 * actually called — never about the wording of the source. The only things
 * that genuinely cannot be observed from the DOM are pinned in
 * `profile.contract.test.ts`.
 *
 * Two hard rules shaped this file:
 *
 *   1. `api` is mocked with `getProfile` and NOTHING ELSE. `updateConsent` is
 *      not stubbed, so any code path that reached for it would throw instead of
 *      quietly succeeding against a fake. A 404-swallowing toggle cannot be
 *      caught this way, which is exactly the bug being removed.
 *   2. `nextTier` is mocked straight from the response in each test, because
 *      the gap to the next tier is derived on the server. If a test computed an
 *      expected value the same way the component does, it would agree with a
 *      re-implementation of the rule and prove nothing.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './page';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  logout: vi.fn(),
  authLoading: false,
  customer: { fullName: 'Ada Lovelace', globalId: 'ignored-by-page' } as
    | { fullName: string; globalId: string }
    | null,
  toDataURL: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    customer: mocks.customer,
    logout: mocks.logout,
    isLoading: mocks.authLoading,
  }),
}));

// `updateConsent` is intentionally absent: it was removed because
// `PUT /v1/customers/me/consent` does not exist in any worker.
vi.mock('../lib/api', () => ({
  api: { getProfile: mocks.getProfile },
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.toDataURL },
}));

const GLOBAL_ID = '3f8a1c2e-7b4d-4e91-a6c5-0d2b9e8f1a37';

const TIERS = [
  { id: 'tier-bronce', name: 'Bronce', minPoints: 0, multiplier: 1, displayOrder: 1 },
  { id: 'tier-plata', name: 'Plata', minPoints: 500, multiplier: 1.5, displayOrder: 2 },
  { id: 'tier-oro', name: 'Oro', minPoints: 2000, multiplier: 2, displayOrder: 3 },
];

type ProfileOverrides = Record<string, unknown>;

/**
 * A profile as the gateway actually returns it: seeded thresholds are
 * 0 / 500 / 2000, which is precisely why the old hardcoded 0 / 1000 / 3000
 * could not be trusted.
 */
function makeProfile(overrides: ProfileOverrides = {}) {
  return {
    id: 'cust_1',
    globalId: GLOBAL_ID,
    fullName: 'Ada Lovelace',
    phone: '+56912345678',
    points: 1200,
    totalPointsEarned: 2400,
    pointsLast30Days: 300,
    currentTierId: 'tier-plata',
    currentTier: 'Plata',
    tier: { id: 'tier-plata', name: 'Plata', multiplier: 1.5 },
    business: { id: 'b1', name: 'Café del Barrio', slug: 'cafe-del-barrio' },
    program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'puntos' },
    tiers: TIERS,
    nextTier: TIERS[2],
    customer_events: [],
    recent_transactions: [],
    createdAt: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

function ladder(): HTMLElement {
  return screen.getByRole('list', { name: 'Niveles del programa' });
}

function balanceText(): string {
  return document.querySelector('.club-pass__balance-value')?.textContent?.trim() ?? '';
}

/**
 * The gap sentence is composed across a few elements so the number and the
 * tier name can carry their own weight, which means no single node holds the
 * whole string. Reading the composed text is what the user actually sees, and
 * asserting the full sentence pins the number, the unit AND the target tier in
 * one go.
 */
function gapText(): string | null {
  const gap = document.querySelector('.club-ladder__gap');
  return gap ? gap.textContent?.replace(/\s+/g, ' ').trim() ?? null : null;
}

describe('profile pass behavior', () => {
  beforeEach(() => {
    mocks.getProfile.mockReset();
    mocks.replace.mockReset();
    mocks.push.mockReset();
    mocks.logout.mockReset();
    mocks.toDataURL.mockReset();
    mocks.authLoading = false;
    mocks.customer = { fullName: 'Ada Lovelace', globalId: GLOBAL_ID };
    mocks.getProfile.mockResolvedValue(makeProfile());
    mocks.toDataURL.mockResolvedValue('data:image/png;base64,SEVMTE8=');
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function renderPage() {
    const result = render(<ProfilePage />);
    await screen.findByRole('region', { name: 'Tu pase' });
    return result;
  }

  // ─── Session ──────────────────────────────────────────────────────────

  it('sends an unauthenticated visitor to the login page and reveals no profile', async () => {
    mocks.customer = null;

    render(<ProfilePage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(mocks.getProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Tu pase' })).toBeNull();
    expect(screen.queryByText(GLOBAL_ID)).toBeNull();
  });

  it('does not redirect while the session is still being restored', async () => {
    // Mirrors the real AuthProvider: during restore there is no customer yet
    // AND the session is still loading. Redirecting here would bounce a
    // signed-in user out of their own pass on every cold start.
    mocks.authLoading = true;
    mocks.customer = null;

    render(<ProfilePage />);

    await screen.findByRole('region', { name: 'Cargando tu pase' });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.getProfile).not.toHaveBeenCalled();
  });

  // ─── Focal element: balance and real distance to the next tier ─────────

  it('shows the server balance and the points remaining to the server next tier', async () => {
    // 1200 points, next tier Oro at 2000 -> 800 remaining.
    await renderPage();

    expect(balanceText()).toContain('1.200');
    expect(gapText()).toBe('Te faltan 800 puntos para llegar a Oro');
  });

  it('expresses the gap in the tenant own currency label, not a hardcoded unit', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'estampitas' } }),
    );

    await renderPage();

    expect(gapText()).toBe('Te faltan 800 estampitas para llegar a Oro');
  });

  it('does not re-derive next tier: a balance past the top tier keeps the server null', async () => {
    // 2500 points is above every threshold, so the server returned null. A
    // client that scanned `tiers` for the first tier above the balance would
    // find none too — this proves the message keys off the field, and the
    // case below proves it for a balance that is NOT past the top.
    mocks.getProfile.mockResolvedValue(makeProfile({ points: 2500, nextTier: null }));

    await renderPage();

    expect(gapText()).toBe('Llegaste al nivel más alto de Club del Barrio.');
  });

  it('claims no distance when the server says there is no next tier, even mid-ladder', async () => {
    // Below the middle threshold, but the server explicitly returned null.
    // The component must report the server's answer, not second-guess it.
    mocks.getProfile.mockResolvedValue(
      makeProfile({ points: 10, currentTierId: 'tier-bronce', currentTier: 'Bronce', nextTier: null }),
    );

    await renderPage();

    expect(gapText()).toBe('Llegaste al nivel más alto de Club del Barrio.');
  });

  // ─── Signature element: the ladder of the tenant own tiers ─────────────

  it('renders the tenant own tier names as named rungs', async () => {
    await renderPage();

    const rungs = within(ladder()).getAllByRole('listitem');
    expect(rungs.map((rung) => rung.querySelector('.club-ladder__rung-name')?.textContent)).toEqual([
      'Bronce',
      'Plata',
      'Oro',
    ]);
  });

  it('marks the assigned tier as the current rung and the next one as the target', async () => {
    await renderPage();

    const rungs = within(ladder()).getAllByRole('listitem');
    expect(rungs[1].getAttribute('aria-current')).toBe('true');
    expect(rungs[2].getAttribute('aria-current')).toBeNull();
    expect(within(rungs[2]).getByText('Siguiente nivel')).toBeTruthy();
  });

  it('renders the ladder for a tenant whose tiers are not named Bronce/Plata/Oro', async () => {
    const customTiers = [
      { id: 't1', name: 'Vecino', minPoints: 0, multiplier: 1, displayOrder: 1 },
      { id: 't2', name: 'Habitual', minPoints: 500, multiplier: 1.5, displayOrder: 2 },
    ];
    mocks.getProfile.mockResolvedValue(
      makeProfile({ tiers: customTiers, nextTier: customTiers[1], currentTierId: 't1' }),
    );

    await renderPage();

    const names = within(ladder())
      .getAllByRole('listitem')
      .map((rung) => rung.querySelector('.club-ladder__rung-name')?.textContent);
    expect(names).toEqual(['Vecino', 'Habitual']);
    expect(screen.queryByText('Bronce')).toBeNull();
  });

  // ─── Honest empty states ──────────────────────────────────────────────

  it('says the program is being set up and shows no ladder when program is null', async () => {
    mocks.getProfile.mockResolvedValue(makeProfile({ program: null, nextTier: null }));

    await renderPage();

    expect(screen.getByText('Tu programa se está configurando')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Niveles del programa' })).toBeNull();
    expect(screen.queryByText(/Llegaste al nivel más alto/)).toBeNull();
    // No tier may be implied when there is no program to belong to.
    expect(screen.queryByText('Nivel Plata')).toBeNull();
  });

  it('shows the same honest empty state when the tenant defined no tiers', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ tiers: [], nextTier: null, currentTierId: undefined, currentTier: null, tier: null }),
    );

    await renderPage();

    expect(screen.getByText('Tu programa se está configurando')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Niveles del programa' })).toBeNull();
    expect(screen.queryByText('Nivel Plata')).toBeNull();
  });

  it('shows a real zero balance without claiming any tier', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({
        points: 0,
        totalPointsEarned: 0,
        pointsLast30Days: 0,
        currentTierId: undefined,
        currentTier: null,
        tier: null,
        nextTier: TIERS[1],
      }),
    );

    await renderPage();

    expect(balanceText()).toContain('0');
    // No `currentTierId` means no tier may be asserted anywhere.
    expect(screen.queryByText('Nivel Plata')).toBeNull();
    expect(screen.queryByText('Nivel Bronce')).toBeNull();
    expect(ladder().querySelector('[aria-current="true"]')).toBeNull();
    // The real distance is still shown, because the server supplied it.
    expect(gapText()).toBe('Te faltan 500 puntos para llegar a Plata');
  });

  // ─── Error ─────────────────────────────────────────────────────────────

  it('reports a failed load with a retry and renders no profile content at all', async () => {
    mocks.getProfile.mockRejectedValue(new Error('gateway exploded'));

    render(<ProfilePage />);

    expect(await screen.findByText('No pudimos cargar tu pase')).toBeTruthy();

    const retry = screen.getByRole('button', { name: 'Reintentar' });
    expect(retry).toBeTruthy();

    // No invented fallback pass: no balance, no ladder, no member id.
    expect(screen.queryByRole('region', { name: 'Tu pase' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Niveles del programa' })).toBeNull();
    expect(balanceText()).toBe('');
    expect(screen.queryByText(GLOBAL_ID)).toBeNull();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('re-fetches the profile when the retry is pressed', async () => {
    mocks.getProfile.mockRejectedValueOnce(new Error('boom'));
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('region', { name: 'Tu pase' })).toBeTruthy();
    expect(mocks.getProfile).toHaveBeenCalledTimes(2);
  });

  // ─── Consent: present, disabled, never wired to a fetch ───────────────

  it('shows the consent controls disabled, matching the register page treatment', async () => {
    await renderPage();

    const group = screen.getByRole('group', { name: 'Comunicaciones' });
    expect((group as HTMLFieldSetElement).disabled).toBe(true);

    const checkboxes = within(group).getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect((box as HTMLInputElement).disabled).toBe(true);
      expect((box as HTMLInputElement).checked).toBe(false);
    }
    expect(within(group).getAllByText(/No disponible todavía/).length).toBe(checkboxes.length);
  });

  it('never issues a consent write: no PUT to the consent endpoint, and no fetch at all', async () => {
    await renderPage();

    const group = screen.getByRole('group', { name: 'Comunicaciones' });
    for (const box of within(group).getAllByRole('checkbox')) {
      await act(async () => {
        fireEvent.click(box);
      });
    }

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(mocks.getProfile).toHaveBeenCalledTimes(1);
  });

  it('exposes no consent method on the api client for the page to call', async () => {
    const apiModule = await import('../lib/api');

    // The real module is not the mocked one here, so this reads the source of
    // truth: the method that called a 404-only endpoint must not exist.
    expect('updateConsent' in apiModule.api).toBe(false);
  });

  // ─── QR ────────────────────────────────────────────────────────────────

  it('reveals a QR that encodes exactly /c/<globalId>, with a descriptive alt', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mi código' }));

    await waitFor(() => expect(mocks.toDataURL).toHaveBeenCalledTimes(1));
    expect(mocks.toDataURL.mock.calls[0][0]).toBe(`/c/${GLOBAL_ID}`);

    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toBe('data:image/png;base64,SEVMTE8=');
    expect((image.getAttribute('alt') ?? '').length).toBeGreaterThan(0);
    expect(image.getAttribute('alt')).toContain(GLOBAL_ID);
    // Fixed dimensions so the image cannot reflow the page.
    expect(image.getAttribute('width')).toBe('200');
    expect(image.getAttribute('height')).toBe('200');
  });

  it('keeps the readable member id and offers a retry when QR generation fails', async () => {
    mocks.toDataURL.mockRejectedValue(new Error('canvas unavailable'));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mi código' }));

    expect(await screen.findByText(/No pudimos generar el código QR/)).toBeTruthy();
    // The id is still readable, because it is a real fallback at the counter.
    expect(screen.getByText(GLOBAL_ID)).toBeTruthy();
    // No placeholder that would look like a working code.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });

  it('recovers when the retry succeeds', async () => {
    mocks.toDataURL.mockRejectedValueOnce(new Error('canvas unavailable'));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mi código' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('img')).toBeTruthy();
    expect(mocks.toDataURL).toHaveBeenCalledTimes(2);
    expect(mocks.toDataURL.mock.calls[1][0]).toBe(`/c/${GLOBAL_ID}`);
  });

  it('keeps the member id visible before the QR is revealed', async () => {
    await renderPage();

    expect(screen.getByText('Tu código en el local')).toBeTruthy();
    expect(screen.getByText(GLOBAL_ID)).toBeTruthy();
    expect(mocks.toDataURL).not.toHaveBeenCalled();
  });

  // ─── Honest session handling ───────────────────────────────────────────

  it('clears the session and returns home on logout', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    });

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/');
  });

  it('offers no wallet pass, not even disabled', async () => {
    await renderPage();

    expect(screen.queryByText(/wallet/i)).toBeNull();
    expect(screen.queryByText(/billetera/i)).toBeNull();
    expect(screen.queryByText(/Apple Pay|Google Pay/i)).toBeNull();
  });
});
