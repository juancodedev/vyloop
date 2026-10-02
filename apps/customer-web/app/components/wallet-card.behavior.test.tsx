/**
 * Behaviour suite for the Google Wallet card on the profile.
 *
 * Four properties are asserted, and they are the whole reason this component
 * exists:
 *
 *   1. It asks the API. The bug it fixes is that nothing ever called
 *      `GET /v1/wallet/pass`, and a component that renders a plausible card
 *      without calling anything would look identical in a screenshot.
 *   2. There is a real loading state, not a button that appears already done.
 *   3. Every refusal renders differently, and none of them says the customer
 *      has no pass. A 409 and a 500 are the same number to a component that
 *      only looks at `status`.
 *   4. The link it hands over is Google's, verbatim.
 *
 * `api` is mocked with `getWalletPass` and nothing else, so any other call would
 * throw rather than quietly succeed against a fake.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletCard } from './wallet-card';

const mocks = vi.hoisted(() => ({ getWalletPass: vi.fn() }));

vi.mock('../lib/api', () => ({
  api: { getWalletPass: mocks.getWalletPass },
}));

const SAVE_URL = 'https://pay.google.com/gp/v/save/ABC123?jwt.encoded.here';

/** A pass as `GET /v1/wallet/pass` actually answers. */
function pass(overrides: Record<string, unknown> = {}) {
  return {
    save_url: SAVE_URL,
    object_id: '3388000000023206930.tenant-1.member-3f8a',
    class_id: '3388000000023206930.tenant-1',
    member_code: 'K7M2QX',
    balance_points: 1200,
    points_currency: 'puntos',
    ...overrides,
  };
}

/**
 * A refusal as `ApiError` would carry it: a stable code and a status.
 *
 * Built by hand rather than imported so this suite does not depend on `apiFetch`'s
 * behaviour — the component is handed what the network layer would hand it.
 */
function refusal(code: string, status: number) {
  const error = new Error(code);

  Object.assign(error, { name: 'ApiError', code, status });

  return error as Error & { code: string; status: number };
}

/** The `role="alert"` block the failure renders into. */
function alertText(): string {
  return screen.getByRole('alert').textContent ?? '';
}

beforeEach(() => {
  mocks.getWalletPass.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('the wallet card asks the API', () => {
  it('calls GET /v1/wallet/pass on mount, which is the bug it fixes', async () => {
    // The defect being removed: nothing in the profile ever asked. A card that
    // rendered without a request would satisfy every other assertion in this
    // file, so this is asserted first and on its own.
    mocks.getWalletPass.mockResolvedValue(pass());

    render(<WalletCard />);

    await waitFor(() => expect(mocks.getWalletPass).toHaveBeenCalledTimes(1));
  });

  it('shows a loading state while it is asking', async () => {
    // Never resolved: the point is the state in between. A card that is either
    // absent or already complete has no loading state to be honest about.
    mocks.getWalletPass.mockReturnValue(new Promise(() => {}));

    render(<WalletCard />);

    const status = screen.getByRole('status');

    expect(status.textContent).toMatch(/preparando/i);
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('link', { name: /google wallet/i })).toBeNull();
  });

  it('asks again when the customer retries after a refusal', async () => {
    mocks.getWalletPass
      .mockRejectedValueOnce(refusal('WALLET_CLASS_NOT_APPROVED', 409))
      .mockResolvedValueOnce(pass());

    render(<WalletCard />);

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));

    await waitFor(() => expect(mocks.getWalletPass).toHaveBeenCalledTimes(2));
    await screen.findByRole('link', { name: /google wallet/i });
  });

  it('does not ask again after a success, on a re-render', async () => {
    // One request per visit. The endpoint creates the object at Google on every
    // call, so a component that re-fetched on each render would be a rate limit
    // incident with no visible symptom.
    mocks.getWalletPass.mockResolvedValue(pass());

    const { rerender } = render(<WalletCard />);

    await screen.findByRole('link', { name: /google wallet/i });
    rerender(<WalletCard />);

    await waitFor(() => expect(mocks.getWalletPass).toHaveBeenCalledTimes(1));
  });
});

describe('the wallet card hands over the link the API gave it', () => {
  it('links to the save_url verbatim, and never rebuilds it', async () => {
    mocks.getWalletPass.mockResolvedValue(pass());

    render(<WalletCard />);

    const link = await screen.findByRole('link', { name: /google wallet/i });

    expect(link.getAttribute('href')).toBe(SAVE_URL);
  });

  it('opens it in the same tab, because it is a navigation and not a popup', async () => {
    mocks.getWalletPass.mockResolvedValue(pass());

    render(<WalletCard />);

    const link = await screen.findByRole('link', { name: /google wallet/i });

    // `target="_blank"` here would be a new-tab gesture nobody asked for, and a
    // `window.open` would be blocked by most browsers anyway.
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBeNull();
  });

  it('shows the member code, which only exists once a pass has been requested', async () => {
    mocks.getWalletPass.mockResolvedValue(pass());

    render(<WalletCard />);

    await screen.findByRole('link', { name: /google wallet/i });

    expect(screen.getByText('K7M2QX')).toBeTruthy();
  });
});

describe('every refusal renders as itself', () => {
  const CASES: ReadonlyArray<{ code: string; status: number; expected: RegExp }> = [
    {
      code: 'WALLET_CLASS_NOT_PROVISIONED',
      status: 409,
      expected: /comercio/i,
    },
    {
      code: 'WALLET_CLASS_NOT_APPROVED',
      status: 409,
      expected: /revisi[óo]n/i,
    },
    { code: 'WALLET_CLASS_ID_MISMATCH', status: 409, expected: /configuraci[óo]n/i },
    { code: 'WALLET_PASS_NOT_CREATABLE', status: 409, expected: /google no pudo/i },
    { code: 'WALLET_BALANCE_NOT_DISPLAYABLE', status: 409, expected: /saldo/i },
    { code: 'LOYALTY_PROGRAM_NOT_CONFIGURED', status: 409, expected: /programa/i },
    { code: 'WALLET_NOT_CONFIGURED', status: 500, expected: /entorno/i },
    { code: 'WALLET_DEMO_MODE', status: 409, expected: /prueba/i },
  ];

  for (const { code, status, expected } of CASES) {
    it(`renders ${code} as its own message, not a generic refusal`, async () => {
      mocks.getWalletPass.mockRejectedValue(refusal(code, status));

      render(<WalletCard />);

      const text = await screen.findByRole('alert').then(() => alertText());

      expect(text, code).toMatch(expected);
    });
  }

  it('never renders a refusal as "you do not have a pass"', async () => {
    // The one property every one of the eight cases above shares, asserted once
    // over all of them so a new branch cannot be added without meeting it.
    for (const { code, status } of CASES) {
      mocks.getWalletPass.mockRejectedValue(refusal(code, status));

      const { unmount } = render(<WalletCard />);

      await screen.findByRole('alert');

      const text = alertText().toLowerCase();

      expect(text, code).not.toMatch(/no ten[eé]s (una |tu )?(tarjeta|pase)/);
      expect(text, code).not.toMatch(/no tienes (una |tu )?(tarjeta|pase)/);
      expect(text, code).not.toMatch(/tu cuenta no (tiene|posee)/);

      unmount();
    }
  });

  it('does not render WALLET_CLASS_NOT_APPROVED as "you do not have a pass"', async () => {
    // Stated on its own because it is the case that actually happens in
    // production for a merchant whose class Google has not finished reviewing,
    // and because a 409 is the status most likely to be mistaken for "nothing
    // here".
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_CLASS_NOT_APPROVED', 409));

    render(<WalletCard />);

    const text = (await screen.findByRole('alert').then(() => alertText())).toLowerCase();

    expect(text).not.toMatch(/no (tenés|tienes|hay) (una )?(tarjeta|pase)/);
    expect(text).toMatch(/tu cuenta est[áa] bien/i);
  });

  it('shows no save link while the pass is refused', async () => {
    // A link that survived a refusal would be a promise the component cannot
    // keep: there is no URL to point it at.
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_CLASS_NOT_APPROVED', 409));

    render(<WalletCard />);

    await screen.findByRole('alert');

    expect(screen.queryByRole('link', { name: /google wallet/i })).toBeNull();
  });

  it('falls back to naming us when the failure carries no code', async () => {
    // A request that never reached the gateway. There is no code to branch on,
    // and the copy still must not blame the account.
    mocks.getWalletPass.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<WalletCard />);

    const text = (await screen.findByRole('alert').then(() => alertText())).toLowerCase();

    expect(text).toMatch(/tu cuenta (y tus puntos )?est[áa]n? bien/i);
  });

  it('announces the refusal as an alert, so it interrupts rather than waiting', async () => {
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_NOT_CONFIGURED', 500));

    render(<WalletCard />);

    const alert = await screen.findByRole('alert');

    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.getAttribute('aria-atomic')).toBe('true');
  });
});