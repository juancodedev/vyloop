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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './page';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getWalletPass: vi.fn(),
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
//
// `getWalletPass` is present because the profile now asks for the pass, and it
// is stubbed rather than left undefined so that a refusal path could not throw
// inside a test that was only about the balance. The wallet behaviour itself is
// asserted in `wallet-card.behavior.test.tsx`; what is asserted here is that the
// profile asks at all.
vi.mock('../lib/api', () => ({
  api: {
    getProfile: mocks.getProfile,
    getWalletPass: mocks.getWalletPass,
    getCustomerConsents: vi.fn().mockResolvedValue({ consents: { promotions: false, nearby_notifications: false } }),
    updateCustomerConsent: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.toDataURL },
}));

const GLOBAL_ID = '3f8a1c2e-7b4d-4e91-a6c5-0d2b9e8f1a37';

/** Copy shown when no milestone can honestly be claimed. */
/** The milestone copy, referenced negatively by the incoherence tests. */
const TOP_COPY = 'Estás en el nivel más alto';

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

function makeWalletPass(overrides: Record<string, unknown> = {}) {
  return {
    save_url: 'https://pay.google.com/gp/v/save/ABC123?jwt.encoded',
    object_id: '3388000000023206930.tenant-1.member-3f8a',
    class_id: '3388000000023206930.tenant-1',
    member_code: 'K7M2QX',
    balance_points: 1200,
    points_currency: 'puntos',
    ...overrides,
  };
}

function balanceText(): string {
  return document.querySelector('.club-identity-card__balance-value')?.textContent?.trim() ?? '';
}

/** The identity card tier line: the gap to the next tier, or the top-tier claim. */
function tierLineText(): string | null {
  const line = document.querySelector('.club-identity-card__tierline-text');
  return line ? line.textContent?.replace(/\s+/g, ' ').trim() ?? null : null;
}

describe('profile pass behavior', () => {
  beforeEach(() => {
    mocks.getProfile.mockReset();
    mocks.getWalletPass.mockReset();
    mocks.replace.mockReset();
    mocks.push.mockReset();
    mocks.logout.mockReset();
    mocks.toDataURL.mockReset();
    mocks.authLoading = false;
    mocks.customer = { fullName: 'Ada Lovelace', globalId: GLOBAL_ID };
    mocks.getProfile.mockResolvedValue(makeProfile());
    mocks.getWalletPass.mockResolvedValue(makeWalletPass());
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
    await screen.findByRole('region', { name: 'Tu identidad' });
    return result;
  }

  // ─── Session ──────────────────────────────────────────────────────────

  it('sends an unauthenticated visitor to the login page and reveals no profile', async () => {
    mocks.customer = null;

    render(<ProfilePage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
    expect(mocks.getProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Tu identidad' })).toBeNull();
    expect(screen.queryByText(GLOBAL_ID)).toBeNull();
  });

  it('does not redirect while the session is still being restored', async () => {
    // Mirrors the real AuthProvider: during restore there is no customer yet
    // AND the session is still loading. Redirecting here would bounce a
    // signed-in user out of their own pass on every cold start.
    mocks.authLoading = true;
    mocks.customer = null;

    render(<ProfilePage />);

    expect(screen.getByRole('status').textContent).toContain('Cargando tu pase');
    // A skeleton of the identity card, the redemption card and three rows; no spinner.
    expect(document.querySelectorAll('.club-skeleton--identity')).toHaveLength(1);
    expect(document.querySelectorAll('.club-skeleton--redemption')).toHaveLength(1);
    expect(document.querySelectorAll('.club-skeleton--row')).toHaveLength(3);
    expect(document.querySelector('.club-status__indicator, .club-qr__spinner')).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.getProfile).not.toHaveBeenCalled();
  });

  // ─── Page order ────────────────────────────────────────────────────────

  it('renders the sections in the specified order', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({
        nextReward: { id: 'r-1', name: 'Burger gratis', pointsCost: 2000, pointsMissing: 800 },
        affordableReward: null,
        affordableRewardsCount: 0,
        activeRewardsCount: 2,
      }),
    );
    await renderPage();

    const order = [
      screen.getByText('Café del Barrio'),
      screen.getByRole('region', { name: 'Tu identidad' }),
      screen.getByRole('region', { name: 'Tu próximo canje' }),
      screen.getByRole('region', { name: 'Actividad reciente' }),
      screen.getByRole('region', { name: 'Tu tarjeta en Google Wallet' }),
      screen.getByRole('button', { name: 'Cerrar sesión' }),
    ];

    for (let i = 1; i < order.length; i += 1) {
      const relation = order[i - 1].compareDocumentPosition(order[i]);
      expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The tier ladder lives on the history page now.
    expect(screen.queryByRole('list', { name: 'Niveles del programa' })).toBeNull();
  });

  // ─── Focal element: balance and real distance to the next tier ─────────

  it('shows the server balance and the points remaining to the server next tier', async () => {
    // 1200 points, next tier Oro at 2000 -> 800 remaining.
    await renderPage();

    expect(balanceText()).toContain('1.200');
    expect(screen.getByText('Nivel Plata')).toBeTruthy();
    expect(tierLineText()).toBe('Te faltan 800 puntos para el nivel Oro');
  });

  it('expresses the gap in the tenant own currency label, not a hardcoded unit', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'estampitas' } }),
    );

    await renderPage();

    expect(tierLineText()).toBe('Te faltan 800 estampitas para el nivel Oro');
  });

  it('keeps the top-tier copy for a customer genuinely on the last rung', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ points: 2500, currentTierId: 'tier-oro', currentTier: 'Oro', nextTier: null }),
    );

    await renderPage();

    expect(tierLineText()).toBe(TOP_COPY);
  });

  it('does not re-derive next tier: a null from the server produces no invented gap', async () => {
    // Below the middle threshold and the server explicitly returned null. A
    // client-side re-derivation would find Plata here and print a distance the
    // server never claimed.
    mocks.getProfile.mockResolvedValue(
      makeProfile({ points: 10, currentTierId: 'tier-bronce', currentTier: 'Bronce', nextTier: null }),
    );

    await renderPage();

    expect(screen.queryByText(/Te faltan/)).toBeNull();
    expect(screen.queryByText(TOP_COPY)).toBeNull();
  });

  it('withholds the milestone when the assigned tier is not the last rung but the balance is past the top', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ points: 2500, currentTierId: 'tier-plata', currentTier: 'Plata', nextTier: null }),
    );

    await renderPage();

    expect(screen.queryByText(TOP_COPY)).toBeNull();
  });

  it('withholds the milestone when the customer has no assigned tier at all', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ points: 5000, currentTierId: undefined, currentTier: null, tier: null, nextTier: null }),
    );

    await renderPage();

    expect(screen.queryByText(TOP_COPY)).toBeNull();
    expect(screen.queryByText(/^Nivel /)).toBeNull();
  });

  // ─── Honest empty states ──────────────────────────────────────────────

  it('says the program is being set up and claims no tier when program is null', async () => {
    mocks.getProfile.mockResolvedValue(makeProfile({ program: null, nextTier: null }));

    await renderPage();

    expect(screen.getByText('Tu programa se está configurando')).toBeTruthy();
    expect(screen.queryByText(TOP_COPY)).toBeNull();
    expect(screen.queryByText('Nivel Plata')).toBeNull();
  });

  it('shows the same honest empty state when the tenant defined no tiers', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({ tiers: [], nextTier: null, currentTierId: undefined, currentTier: null, tier: null }),
    );

    await renderPage();

    expect(screen.getByText('Tu programa se está configurando')).toBeTruthy();
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

    expect(balanceText()).toBe('0');
    expect(screen.queryByText('Nivel Plata')).toBeNull();
    expect(screen.queryByText('Nivel Bronce')).toBeNull();
    // The real distance is still shown, because the server supplied it.
    expect(tierLineText()).toBe('Te faltan 500 puntos para el nivel Plata');
  });

  // ─── Error ─────────────────────────────────────────────────────────────

  it('reports a failed load with a retry and renders no profile content at all', async () => {
    mocks.getProfile.mockRejectedValue(new Error('gateway exploded'));

    render(<ProfilePage />);

    expect(await screen.findByText('No pudimos cargar tu pase')).toBeTruthy();

    const retry = screen.getByRole('button', { name: 'Reintentar' });
    expect(retry).toBeTruthy();

    // No invented fallback pass: no balance, no ladder, no member id.
    expect(screen.queryByRole('region', { name: 'Tu identidad' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Niveles del programa' })).toBeNull();
    expect(balanceText()).toBe('');
    expect(screen.queryByText(GLOBAL_ID)).toBeNull();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('re-fetches the profile when the retry is pressed', async () => {
    mocks.getProfile.mockRejectedValueOnce(new Error('boom'));
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByRole('region', { name: 'Tu identidad' })).toBeTruthy();
    expect(mocks.getProfile).toHaveBeenCalledTimes(2);
  });

  // ─── Consent: interactive, loads from API, writes on change ──────────────

  it('shows interactive consent controls that load from the API', async () => {
    await renderPage();

    const group = screen.getByRole('group', { name: 'Comunicaciones' });
    expect((group as HTMLFieldSetElement).disabled).toBe(false);

    // Wait for checkboxes to appear (ConsentList finishes loading)
    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect((box as HTMLInputElement).disabled).toBe(false);
    }
    expect(screen.queryAllByText(/No disponible todavía/)).toHaveLength(0);
  });

  it('loads consent state from the API on mount', async () => {
    await renderPage();

    // getCustomerConsents is called to load the initial state
    const apiModule = await import('../lib/api');
    expect(apiModule.api.getCustomerConsents).toHaveBeenCalled();
  });

  it('writes consent changes to the API', async () => {
    await renderPage();

    const _group = screen.getByRole('group', { name: 'Comunicaciones' });
    // Wait for checkboxes to appear (ConsentList finishes loading)
    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThan(0);

    const nearbyNotifications = screen.getByRole('checkbox', { name: /Avisos cercanos/ });

    await act(async () => {
      fireEvent.click(nearbyNotifications);
    });

    // The UI identifier must match the canonical consent type accepted by the API.
    const apiModule = await import('../lib/api');
    expect(apiModule.api.updateCustomerConsent).toHaveBeenCalledWith({
      consentType: 'nearby_notifications',
      granted: true,
    });
  });

  // ─── Next redemption ───────────────────────────────────────────────────

  it('renders the next redemption card from the server fields', async () => {
    mocks.getProfile.mockResolvedValue(
      makeProfile({
        points: 30,
        nextReward: { id: 'r-burger', name: 'Burger gratis', pointsCost: 100, pointsMissing: 70 },
        affordableReward: null,
        affordableRewardsCount: 0,
        activeRewardsCount: 4,
      }),
    );
    await renderPage();

    const card = screen.getByRole('region', { name: 'Tu próximo canje' });
    expect(card.textContent).toContain('Te faltan 70 puntos');
    expect(screen.getByText('Con 70 puntos más, tu canje Burger gratis es tuyo')).toBeTruthy();
  });

  it('renders no redemption card and no error when the API sends no reward fields', async () => {
    await renderPage();

    expect(screen.queryByRole('region', { name: 'Tu próximo canje' })).toBeNull();
    expect(screen.queryByText('No pudimos cargar tu pase')).toBeNull();
  });

  // ─── QR ────────────────────────────────────────────────────────────────

  it('opens a QR sheet that encodes exactly /c/<globalId>, with a descriptive alt', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mi código' }));

    expect(screen.getByRole('dialog', { name: 'Mostrale esto en caja' })).toBeTruthy();
    await waitFor(() => expect(mocks.toDataURL).toHaveBeenCalledTimes(1));
    expect(mocks.toDataURL.mock.calls[0][0]).toBe(`/c/${GLOBAL_ID}`);

    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toBe('data:image/png;base64,SEVMTE8=');
    expect(image.getAttribute('alt')).toContain(GLOBAL_ID);
    // Fixed dimensions so the image cannot reflow the sheet.
    expect(image.getAttribute('width')).toBe('210');
    expect(image.getAttribute('height')).toBe('210');
  });

  it('shows the member code from the wallet pass in the QR sheet, grouped in threes', async () => {
    await renderPage();
    await waitFor(() => expect(mocks.getWalletPass).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mi código' }));

    expect(await screen.findByText('K7M 2QX')).toBeTruthy();
    // The sheet reuses the answer the wallet card already has.
    expect(mocks.getWalletPass).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when QR generation fails, with no placeholder image', async () => {
    mocks.toDataURL.mockRejectedValue(new Error('canvas unavailable'));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mi código' }));

    expect(await screen.findByText(/No pudimos generar el código QR/)).toBeTruthy();
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

  it('does not render the QR inline before the customer asks for it', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Mostrar mi código' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.toDataURL).not.toHaveBeenCalled();
  });

  // ─── Honest session handling ───────────────────────────────────────────

  it('clears the session and returns home on logout', async () => {
    const { rerender } = await renderPage();
    mocks.logout.mockImplementation(() => {
      mocks.customer = null;
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    });

    rerender(<ProfilePage />);

    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  // ─── The Google Wallet pass ────────────────────────────────────────────
  //
  // This block replaces `offers no wallet pass, not even disabled`, which
  // asserted the absence of a control on the premise that the issuer was
  // unapproved. The issuer is approved and a pass works on a real phone, so the
  // premise is retired — and what replaces it is not "the button exists" but the
  // rule the button has to obey: it says the truth about the state, and a
  // refusal is never dressed as "you have no card".

  it('asks for the pass, which is the link this page was missing', async () => {
    // The bug being fixed, asserted as a call. A card that rendered without
    // asking would satisfy every other assertion here and look identical in a
    // screenshot.
    await renderPage();

    await waitFor(() => expect(mocks.getWalletPass).toHaveBeenCalled());
  });

  it('offers the save link the API returned', async () => {
    mocks.getWalletPass.mockResolvedValue(
      makeWalletPass({ save_url: 'https://pay.google.com/gp/v/save/XYZ?jwt.abc' }),
    );

    await renderPage();

    const link = await screen.findByRole('link', { name: /google wallet/i });

    expect(link.getAttribute('href')).toBe('https://pay.google.com/gp/v/save/XYZ?jwt.abc');
  });

  it('shows the member code that only exists once a pass has been asked for', async () => {
    // A profile seen before this answers has no code. That is the ordinary state
    // — `issuance.ts` mints it lazily and deliberately not at registration — and
    // the page says so rather than leaving the customer to conclude their
    // account is broken.
    await renderPage();

    expect(await screen.findByText('K7M2QX')).toBeTruthy();
  });

  it('still renders the balance and the QR when the pass is refused', async () => {
    // The wallet card is an addition to this page, not a gate in front of it. A
    // refusal from Google's side cannot take away the parts of the profile that
    // work.
    mocks.getWalletPass.mockRejectedValue(
      Object.assign(new Error('refused'), {
        name: 'ApiError',
        code: 'WALLET_CLASS_NOT_APPROVED',
        status: 409,
      }),
    );

    await renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    // The pass area is the one thing that is gone; the pass itself is not.
    expect(screen.getByRole('region', { name: 'Tu identidad' })).toBeTruthy();
    expect(balanceText()).toContain('1.200');
    expect(screen.getByRole('button', { name: /c[oó]digo|qr/i })).toBeTruthy();
  });
});
