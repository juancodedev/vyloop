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
    // A first visit: nothing existed, so the object was created by this request.
    already_existed: false,
    pass_state: 'issued',
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
    // The retry control has to exist somewhere, or "offers a retry" is vacuous.
    // `WALLET_PASS_NOT_CREATABLE` is chosen because it is the one refusal whose
    // cause is Google's API failing at that moment, which a second request can
    // plausibly get past — see `lib/wallet-remedy.test.ts`, which holds the whole
    // table. A class review would not do here: there is nothing to click.
    mocks.getWalletPass
      .mockRejectedValueOnce(refusal('WALLET_PASS_NOT_CREATABLE', 409))
      .mockResolvedValueOnce(pass());

    render(<WalletCard />);

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));

    await waitFor(() => expect(mocks.getWalletPass).toHaveBeenCalledTimes(2));
    await screen.findByRole('link', { name: /google wallet/i });
  });

  it('never asks again on a re-render, and never re-renders the refusal into a retry', () => {
    // The two failure modes of a retry control are the same failure: a control
    // that fires without the customer's intent. A refusal that cannot be retried
    // must not carry one at all, or a stray keypress re-issues a request that
    // will be refused identically.
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_CLASS_NOT_APPROVED', 409));

    const { rerender } = render(<WalletCard />);

    return screen.findByRole('alert').then(() => {
      expect(screen.queryByRole('button')).toBeNull();

      rerender(<WalletCard />);

      expect(mocks.getWalletPass).toHaveBeenCalledTimes(1);
    });
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

/**
 * The worker hands back a pass that already exists without creating one, and the
 * response is otherwise indistinguishable from a new issuance: same link, same
 * fields, same 200. That difference is the only thing stopping the page from
 * telling someone who already had the card that it was just created for them.
 */
describe('the wallet card tells a returning customer apart from a new one', () => {
  it('does not claim a fresh card was just added when the pass already existed', async () => {
    mocks.getWalletPass.mockResolvedValue(pass({ already_existed: true, pass_state: 'issued' }));

    render(<WalletCard />);

    await screen.findByRole('link', { name: /google wallet/i });

    // "Agregala una vez" is the phrase that lies to a returning customer.
    expect(document.body.textContent).not.toMatch(/agreg[áa]la una vez/i);
  });

  it('says the card is already theirs when the pass exists and was saved', async () => {
    mocks.getWalletPass.mockResolvedValue(pass({ already_existed: true, pass_state: 'issued' }));

    render(<WalletCard />);

    const note = await screen.findByText(/ya (est[áa]|la ten[eé]s)/i);

    expect(note.textContent).toMatch(/google wallet/i);
  });

  it('offers to bring a deactivated card back rather than acting as if it were new', async () => {
    // `inactive` is the same pass with the customer's finger off the switch, so
    // the honest copy is about re-adding, not about a first add.
    mocks.getWalletPass.mockResolvedValue(pass({ already_existed: true, pass_state: 'inactive' }));

    render(<WalletCard />);

    await screen.findByRole('link', { name: /google wallet/i });

    expect(document.body.textContent).toMatch(/volver a agregar|volver a sumar/i);
    expect(document.body.textContent).not.toMatch(/agreg[áa]la una vez/i);
  });

  it('still reads as a first add when the customer never saved the pass', async () => {
    // `not_saved` means Google was asked and has no object. The card is genuinely
    // not in their phone, so claiming otherwise is the same lie in the other
    // direction — and `already_existed` alone cannot tell the two apart.
    mocks.getWalletPass.mockResolvedValue(pass({ already_existed: true, pass_state: 'not_saved' }));

    render(<WalletCard />);

    await screen.findByRole('link', { name: /google wallet/i });

    expect(document.body.textContent).toMatch(/agreg[áa]la una vez/i);
  });

  it('still shows the link either way, because a returning customer may want it', async () => {
    // The flag changes the sentence, never the affordance: a customer who deleted
    // the pass needs the link back, and one whose balance went stale gets it
    // refreshed by opening it.
    for (const pass_state of ['issued', 'inactive', 'not_saved']) {
      mocks.getWalletPass.mockResolvedValue(pass({ already_existed: true, pass_state }));

      const { unmount } = render(<WalletCard />);

      const link = await screen.findByRole('link', { name: /google wallet/i });

      expect(link.getAttribute('href'), pass_state).toBe(SAVE_URL);

      unmount();
    }
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

// ============================================================================
// The retry button
//
// The component rendered `<button>Reintentar</button>` for every refusal it was
// given, because `ClubError` renders its `action` slot whenever one is passed
// and `wallet-card.tsx` passed one unconditionally. The button re-requests
// `/v1/wallet/pass`, which answers with the same refusal — for seven of the ten
// codes, because those describe a condition that does not change between two
// taps.
//
// `WALLET_CLASS_NOT_APPROVED` is the case that makes the change acceptable: its
// own copy says the review is Google's and takes days, so a button underneath
// it asking the customer to tap is the same bug in two layers.
// ============================================================================

describe('the retry button is offered only when retrying can work', () => {
  /**
   * Every code, its verdict, and why.
   *
   * Written out rather than derived, so this table reads as the decision and not
   * as a restatement of `lib/wallet.ts` — a table copied out of the
   * implementation asserts nothing. The reason travels with the verdict because
   * a verdict without a reason is a guess, and a guess here is a dead button.
   */
  const VERDICTS: ReadonlyArray<{
    code: string;
    status: number;
    retry: boolean;
    why: string;
  }> = [
    {
      code: 'WALLET_CLASS_NOT_PROVISIONED',
      status: 409,
      retry: false,
      why: 'the commerce has not finished onboarding; a second request does not finish it',
    },
    {
      code: 'WALLET_CLASS_NOT_APPROVED',
      status: 409,
      retry: false,
      why: "Google's review takes days and no tap shortens a queue at Google",
    },
    {
      code: 'WALLET_CLASS_ID_MISMATCH',
      status: 409,
      retry: false,
      why: 'a defect in our own tables, which does not heal on its own',
    },
    {
      code: 'WALLET_PASS_NOT_CREATABLE',
      status: 409,
      retry: true,
      why: "Google's own API is failing at this moment — the dominant cause of this code",
    },
    {
      code: 'WALLET_BALANCE_NOT_DISPLAYABLE',
      status: 409,
      retry: false,
      why: 'the remedy is a layout decision the commerce has to make',
    },
    {
      code: 'WALLET_PASS_TERMINAL',
      status: 409,
      retry: false,
      why: 'Google will not un-expire the object, so the card is finished rather than missing',
    },
    {
      code: 'LOYALTY_PROGRAM_NOT_CONFIGURED',
      status: 409,
      retry: false,
      why: 'the commerce has to configure the programme; the next request finds the same row',
    },
    {
      code: 'WALLET_NOT_CONFIGURED',
      status: 500,
      retry: false,
      why: 'the deployment is missing configuration; the worker calls it "no pass will ever work"',
    },
    {
      code: 'WALLET_DEMO_MODE',
      status: 409,
      retry: false,
      why: 'publishing access is the commerce to obtain, and a review does not grant it',
    },
    {
      code: 'WALLET_MALFORMED_RESPONSE',
      status: 200,
      retry: true,
      why: 'the answer we received carried no pass; asking again is the only possible remedy',
    },
  ];

  it('renders no retry button for WALLET_CLASS_NOT_APPROVED', async () => {
    // The assertion that makes the change acceptable, stated on its own. This is
    // the code that reaches production today: the class exists and Google has not
    // approved it, so the page says the review is the commerce's to submit and
    // takes days — and the button directly underneath asks the comensal to tap.
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_CLASS_NOT_APPROVED', 409));

    render(<WalletCard />);

    await screen.findByRole('alert');

    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toMatch(/reintentar/i);
  });

  for (const { code, status, retry, why } of VERDICTS) {
    it(`${code} ${retry ? 'offers' : 'offers no'} retry — ${why}`, async () => {
      mocks.getWalletPass.mockRejectedValue(refusal(code, status));

      const { unmount } = render(<WalletCard />);

      await screen.findByRole('alert');

      const button = screen.queryByRole('button', { name: /reintentar/i });

      if (retry) {
        expect(button, code).not.toBeNull();
      } else {
        // The button is not merely renamed or disabled: a control that cannot
        // help is decoration, and decoration is what taught a customer to tap a
        // dead end. It is not in the tree at all.
        expect(button, code).toBeNull();
        expect(document.body.textContent, code).not.toMatch(/reintentar/i);
      }

      unmount();
    });
  }

  it('replaces the button with what the customer can actually do', async () => {
    // The slot is not left empty. Removing a control that was doing nothing is
    // the easy half; leaving the comensal with a title and no next step is the
    // half that turns this fix into a worse page. So a non-retry refusal says
    // who has to act — a sentence, not a second control, because a control here
    // would have to be a support channel this app does not have.
    for (const { code, status, retry } of VERDICTS) {
      mocks.getWalletPass.mockRejectedValue(refusal(code, status));

      const { unmount } = render(<WalletCard />);

      await screen.findByRole('alert');

      const alert = screen.getByRole('alert');

      // The remedy is rendered as text inside the same slot the button used, so
      // the layout does not change shape between a retryable refusal and one
      // that is not.
      expect(alert.querySelector('.club-status__action'), code).not.toBeNull();

      if (!retry) {
        expect(screen.queryByRole('button'), code).toBeNull();
        expect(alert.querySelector('.club-status__action')?.textContent?.trim(), code).toMatch(
          /\S/,
        );
      }

      unmount();
    }
  });

  it('keeps a retry for the refusal whose cause is Google having a bad minute', async () => {
    // Verified against the worker rather than from memory. `routes.ts:763` is the
    // `catch` around `client.insertObject`, and its own comment records that the
    // branch is reached when Google's API refuses — a 5xx from Google clears on
    // its own, which is the definition of transient.
    //
    // The same branch also catches `GoogleWalletAuthError` from
    // `mintAccessToken`, so an invalid token here would land on the same code.
    // That is a real ambiguity, held open in `lib/wallet-remedy.test.ts` rather
    // than forced into a verdict here: the dominant cause is Google's, and the
    // copy has always promised a retry, so the button stays and the ambiguity is
    // documented instead of guessed away.
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_PASS_NOT_CREATABLE', 409));

    render(<WalletCard />);

    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: /reintentar/i })).toBeTruthy();
  });

  it('offers the retry for a 200 that carried no pass', async () => {
    // The client-side code, thrown by `api.getWalletPass` when the body held no
    // `data`. Nothing here is misconfigured: the request succeeded and the answer
    // was unusable, so a second identical request is a reasonable thing to offer
    // — and the only remedy available.
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_MALFORMED_RESPONSE', 200));

    render(<WalletCard />);

    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: /reintentar/i })).toBeTruthy();
  });

  it('offers the retry for a request that never got an answer', async () => {
    // The case that would regress without thought. A dropped connection is
    // exactly what re-asking fixes, so banning the button outright would have
    // traded one lie for a worse answer.
    mocks.getWalletPass.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<WalletCard />);

    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: /reintentar/i })).toBeTruthy();
  });

  it('offers no retry to a server that answered with a code this build does not know', async () => {
    // `WALLET_PASS_STATE_UNKNOWN` is a real code the worker sends today with a
    // 500, and it is deliberately not in the map. A stable code is a code that
    // will answer the same way next time, so retrying is provably useless here
    // and the copy must not promise it.
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_PASS_STATE_UNKNOWN', 500));

    render(<WalletCard />);

    await screen.findByRole('alert');

    expect(screen.queryByRole('button')).toBeNull();
  });
});

// ============================================================================
// The support reader
//
// `data-wallet-code` and `data-wallet-status` were added for somebody reading
// the page at the counter: a comensal showing a phone that says "something went
// wrong" hands over a 409 or a 500 and the reader knows whose problem it is.
// Those attributes are the feature and must not be disturbed by this change.
// ============================================================================

describe('the refusal stays readable by a support reader', () => {
  it('keeps the code and the status it already exposed', async () => {
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_CLASS_NOT_APPROVED', 409));

    const { container } = render(<WalletCard />);

    await screen.findByRole('alert');

    const wrapper = container.querySelector('[data-wallet-code]');

    expect(wrapper?.getAttribute('data-wallet-code')).toBe('WALLET_CLASS_NOT_APPROVED');
    expect(wrapper?.getAttribute('data-wallet-status')).toBe('409');
  });

  it('now also says why there is no button, because absence is not self-explaining', async () => {
    // A missing control is exactly the thing a reader cannot diagnose: the page
    // looks broken in a different way. Publishing the verdict turns "why is there
    // no retry here" into a value in the DOM.
    for (const [code, status, expected] of [
      ['WALLET_CLASS_NOT_APPROVED', '409', 'wait'],
      ['WALLET_NOT_CONFIGURED', '500', 'ours'],
      ['WALLET_CLASS_NOT_PROVISIONED', '409', 'tell-anyone'],
      ['WALLET_PASS_NOT_CREATABLE', '409', 'retry'],
      ['WALLET_PASS_STATE_UNKNOWN', '500', 'ours'],
    ] as const) {
      mocks.getWalletPass.mockRejectedValue(refusal(code, Number(status)));

      const { container, unmount } = render(<WalletCard />);

      await screen.findByRole('alert');

      expect(
        container.querySelector('[data-wallet-code]')?.getAttribute('data-wallet-remedy'),
        code,
      ).toBe(expected);

      unmount();
    }
  });

  it('reports a request that never arrived as no answer, not as an absent code', async () => {
    // `describeFailure` substitutes `NO_RESPONSE` for an absent code, so the
    // attribute is always populated and a reader never has to tell "no code"
    // from "an attribute that was not rendered".
    mocks.getWalletPass.mockRejectedValue(new TypeError('Failed to fetch'));

    const { container } = render(<WalletCard />);

    await screen.findByRole('alert');

    const wrapper = container.querySelector('[data-wallet-code]');

    expect(wrapper?.getAttribute('data-wallet-code')).toBe('NO_RESPONSE');
    expect(wrapper?.getAttribute('data-wallet-status')).toBe('0');
    expect(wrapper?.getAttribute('data-wallet-remedy')).toBe('retry');
  });

  it('carries no customer data on the element it publishes', async () => {
    // It is read on a phone by a person and never sent anywhere, so it stays a
    // closed set of values drawn from a code, a status and a verdict — no name,
    // no balance, no member code.
    mocks.getWalletPass.mockRejectedValue(refusal('WALLET_BALANCE_NOT_DISPLAYABLE', 409));

    const { container } = render(<WalletCard />);

    await screen.findByRole('alert');

    const wrapper = container.querySelector('[data-wallet-code]')!;

    expect(wrapper.getAttributeNames().filter((n) => n.startsWith('data-wallet'))).toEqual([
      'data-wallet-code',
      'data-wallet-status',
      'data-wallet-remedy',
    ]);
  });
});