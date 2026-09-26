/**
 * The redeem step.
 *
 * `fetch` is stubbed and the real `api` client is left in place, so every
 * refusal below travels the whole way the real one does: a 409 body becomes an
 * `ApiError` with a real `code`, and the page maps that code. Mocking the api
 * module instead would hand the page an error object the gateway never produces.
 *
 * Four things are protected here, and each has a test that fails if the
 * protection is removed:
 *
 *   1. One gesture spends points once. The lock is a ref, not the `disabled`
 *      attribute, because two activations in the same tick both see a stale
 *      `disabled === false`.
 *   2. The server decides. A short balance, a sold-out reward and a repeated
 *      reference are three different codes, and each keeps its own meaning.
 *   3. The post-redeem balance shown is the one the server returned.
 *   4. The reward's name and price come from the catalog, never from the URL.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConfirmPage from './page';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: new URLSearchParams('reward=reward-1'),
  authLoading: false,
  customer: { fullName: 'Ada Lovelace', globalId: 'global-1' } as
    | { fullName: string; globalId: string }
    | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ customer: mocks.customer, isLoading: mocks.authLoading }),
}));

const REWARD_ID = 'reward-1';

function makeReward(overrides: Record<string, unknown> = {}) {
  return {
    id: REWARD_ID,
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

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'tx-9',
      business_id: 'b1',
      customer_id: 'cust-1',
      type: 'redeem',
      points: 400,
      balance_after: 800,
      reference_id: 'redeem-abc',
      note: 'Café chico',
      created_at: '2026-02-03T10:00:00.000Z',
    },
    partial: false,
    fulfilled: 400,
    requested: 400,
    ...overrides,
  };
}

type Reply = { status: number; body: unknown };

let catalog: Record<string, unknown>[] = [makeReward()];
let profile: Record<string, unknown> = makeProfile();
let redeemReply: Reply = { status: 201, body: successBody() };
let redeemCalls: { url: string; body: Record<string, unknown> }[] = [];
let holdRedeem: Promise<void> | null = null;

/**
 * Holds the redeem response open so several activations can be fired while the
 * request is still in flight.
 *
 * A mutable holder rather than a `let release: (() => void) | null`: the
 * assignment happens inside a promise executor, and control-flow analysis
 * narrows the variable to `null` at every use site outside it, which makes the
 * call a type error even though it is the only assignment that ever happens.
 */
function createGate() {
  const holder: { open: () => void } = { open: () => {} };

  holdRedeem = new Promise<void>((resolve) => {
    holder.open = () => {
      holdRedeem = null;
      resolve();
    };
  });

  return holder;
}

function json(reply: Reply) {
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
}

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.authLoading = false;
  mocks.customer = { fullName: 'Ada Lovelace', globalId: 'global-1' };
  mocks.searchParams = new URLSearchParams(`reward=${REWARD_ID}`);

  catalog = [makeReward()];
  profile = makeProfile();
  redeemReply = { status: 201, body: successBody() };
  redeemCalls = [];
  holdRedeem = null;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/v1/loyalty/rewards/redeem')) {
        redeemCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });

        if (holdRedeem) await holdRedeem;
        return json(redeemReply);
      }

      if (url.includes('/v1/loyalty/rewards')) {
        return json({ status: 200, body: { data: catalog, meta: { total: catalog.length, page: 1, per_page: 20 } } });
      }

      if (url.includes('/v1/customers/me')) {
        return json({ status: 200, body: { data: profile } });
      }

      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  localStorage.setItem('vyloop_jwt', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function renderConfirm() {
  render(<ConfirmPage />);
  return screen.findByRole('button', { name: /Confirmar canje/ });
}

describe('confirm, resolving the reward', () => {
  it('takes the name and price from the catalog, not from the URL', async () => {
    // The URL could carry any name and any price at all. Reading either from it
    // would put a value on screen the server never sent.
    mocks.searchParams = new URLSearchParams(`reward=${REWARD_ID}&name=Regalo&points=1`);

    await renderConfirm();

    expect(screen.getByRole('heading', { name: 'Café chico' })).toBeTruthy();
    expect(screen.getByText('400 puntos')).toBeTruthy();
    expect(screen.queryByText('Regalo')).toBeNull();
  });

  it('reports a reward the catalog no longer lists instead of inventing one', async () => {
    catalog = [];

    render(<ConfirmPage />);

    expect(await screen.findByText('No encontramos esa recompensa')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Confirmar canje/ })).toBeNull();
  });

  it('refuses to confirm a reward the server says is sold out', async () => {
    catalog = [makeReward({ stock: 0 })];

    render(<ConfirmPage />);

    await screen.findByText('Agotado');
    const button = (await screen.findByRole('button', { name: /Confirmar canje/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('still allows confirming a reward whose stock is not tracked', async () => {
    catalog = [makeReward({ stock: null })];

    const button = await renderConfirm();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Stock no controlado')).toBeTruthy();
  });

  it('shows the balance as information without letting it gate the redeem', async () => {
    // 10 on the profile against a 400 reward: a client-side affordability check
    // would switch the control off and refuse something the server has not
    // ruled on.
    profile = makeProfile({ points: 10 });

    const button = await renderConfirm();

    expect(screen.getByText('Tu saldo: 10 puntos')).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('confirm, one gesture spends once', () => {
  it('three activations in the same tick issue exactly one request', async () => {
    // All three are dispatched inside ONE `act`, so React does not re-render
    // between them and every handler sees `disabled === false` and a stale
    // `submitting === false`. That is the real race: a fast double tap, or an
    // activation arriving from a keyboard and a pointer in the same frame.
    //
    // Dispatching them as separate `fireEvent.click` calls would prove nothing
    // here — each one is its own `act`, so the button is already disabled by the
    // second and the assertion would pass with no lock in the code at all.
    const gate = createGate();

    const button = await renderConfirm();

    act(() => {
      button.click();
      button.click();
      button.click();
    });

    expect(redeemCalls).toHaveLength(1);

    gate.open();
    await screen.findByText(/Canjeaste/);
  });

  it('the in-flight control reports that it is working', async () => {
    const gate = createGate();

    const button = await renderConfirm();
    fireEvent.click(button);

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('Canjeando…')).toBeTruthy();

    gate.open();
    await screen.findByText(/Canjeaste/);
  });

  it('generates a different reference id for each attempt', async () => {
    // A repeated reference is rejected as DUPLICATE_REFERENCE, so the value
    // has to be per attempt rather than per page load.
    redeemReply = { status: 409, body: { error: { code: 'REWARD_OUT_OF_STOCK', message: 'Reward is out of stock' } } };

    const button = await renderConfirm();
    fireEvent.click(button);
    await screen.findByText('Nos quedamos sin stock');

    redeemReply = { status: 201, body: successBody() };
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar canje/ }));
    await screen.findByText(/Canjeaste/);

    const [first, second] = redeemCalls;
    expect(redeemCalls).toHaveLength(2);
    expect(first.body.reference_id).not.toBe(second.body.reference_id);
    expect(first.body.reference_id).toMatch(/^redeem-/);
  });

  it('sends the reward id, the cost and the reference, and no customer id', async () => {
    await renderConfirm();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar canje/ }));
    await screen.findByText(/Canjeaste/);

    expect(Object.keys(redeemCalls[0].body).sort()).toEqual(['points', 'reference_id', 'reward_id']);
    expect(redeemCalls[0].body.reward_id).toBe(REWARD_ID);
    expect(redeemCalls[0].body.points).toBe(400);
    expect(redeemCalls[0].url).not.toContain('customer_id');
  });
});

describe('confirm, the outcome', () => {
  it('shows the balance the server returned, not a locally computed one', async () => {
    // 1200 on the profile and 400 spent, so a client-side subtraction would
    // also arrive at 800. The server is made to answer 775 to show which is used.
    redeemReply = { status: 201, body: successBody({ data: { ...successBody().data, balance_after: 775 } }) };

    await renderConfirm();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar canje/ }));

    expect(await screen.findByText('Saldo restante')).toBeTruthy();
    // The number and the unit are separate text nodes, so the composed value is
    // read off the element that holds both.
    const shown = document.querySelector('.confirm-balance__value')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(shown).toBe('775 puntos');
    expect(shown).not.toContain('800');
  });

  it('names the reward and what it cost', async () => {
    await renderConfirm();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar canje/ }));

    const message = await screen.findByText(/Canjeaste/);
    expect(message.textContent).toContain('Café chico');
    expect(message.textContent).toContain('400');
  });

  it('moves focus to the outcome so the result is not silent', async () => {
    await renderConfirm();

    const button = screen.getByRole('button', { name: /Confirmar canje/ });
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    await screen.findByText(/Canjeaste/);

    await waitFor(() => {
      const outcome = document.querySelector('.confirm-outcome');
      expect(outcome).toBeTruthy();
      expect(document.activeElement).toBe(outcome);
    });
  });

  it('marks the control as pressed once the reward is theirs', async () => {
    await renderConfirm();

    const button = screen.getByRole('button', { name: /Confirmar canje/ });
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);

    const pressed = await screen.findByRole('button', { name: 'Canjeado' });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect((pressed as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports a partial redemption with the amount actually spent', async () => {
    redeemReply = {
      status: 201,
      body: successBody({
        partial: true,
        fulfilled: 120,
        data: { ...successBody().data, points: 120, balance_after: 0 },
      }),
    };

    await renderConfirm();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar canje/ }));

    const message = await screen.findByText(/Canjeaste/);
    expect(message.textContent).toContain('120');
  });
});

describe('confirm, server refusals keep their meaning', () => {
  async function refuseWith(code: string, message: string, status = 409) {
    redeemReply = { status, body: { error: { code, message } } };
    const button = await renderConfirm();
    fireEvent.click(button);
    return screen.findByRole('alert');
  }

  it('a sold-out reward says so, and not that something generic failed', async () => {
    const alert = await refuseWith('REWARD_OUT_OF_STOCK', 'Reward is out of stock');

    expect(alert.textContent).toContain('Nos quedamos sin stock');
    expect(alert.textContent).toContain('No se descontó ningún punto');
    expect(alert.textContent).not.toContain('No pudimos completar el canje');
  });

  it('an insufficient balance says so and carries the server own numbers', async () => {
    const alert = await refuseWith(
      'INSUFFICIENT_BALANCE',
      'Customer has 200 points but 400 are required',
    );

    expect(alert.textContent).toContain('No tenés puntos suficientes');
    expect(alert.textContent).toContain('200');
    expect(alert.textContent).toContain('400');
  });

  it('a cost the customer does not cover is named as such', async () => {
    // The worker sends this one when the requested points fall under the
    // reward's own cost, which is a different refusal from a short balance.
    const alert = await refuseWith('INSUFFICIENT_POINTS', 'This reward requires 400 points');

    expect(alert.textContent).toContain('No tenés puntos suficientes');
    expect(alert.textContent).toContain('This reward requires 400 points');
  });

  it('an inactive reward says so', async () => {
    const alert = await refuseWith('REWARD_INACTIVE', 'Reward has expired');

    expect(alert.textContent).toContain('Esta recompensa no está activa');
    expect(alert.textContent).toContain('Reward has expired');
  });

  it('a duplicated reference says the canje was already counted once', async () => {
    // The backstop behind the in-flight lock: if a request ever does arrive
    // twice, the customer is told it was charged once, not that it failed.
    const alert = await refuseWith(
      'DUPLICATE_REFERENCE',
      'A transaction with this reference_id already exists for this customer',
    );

    expect(alert.textContent).toContain('Este canje ya estaba registrado');
    expect(alert.textContent).toContain('una sola vez');
  });

  it('a reward the server cannot find says so', async () => {
    const alert = await refuseWith('REWARD_NOT_FOUND', 'Reward not found', 404);

    expect(alert.textContent).toContain('Esta recompensa ya no existe');
  });

  it('a session that cannot be identified is not reported as a stockout', async () => {
    const alert = await refuseWith('FORBIDDEN', 'Customer may only redeem for themselves', 403);

    expect(alert.textContent).toContain('No pudimos identificar tu cuenta');
    expect(alert.textContent).not.toContain('sin stock');
  });

  it('a gateway that cannot be reached says so without blaming the customer', async () => {
    const button = await renderConfirm();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });

    fireEvent.click(button);
    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain('No pudimos completar el canje');
    expect(alert.textContent).toContain('No se descontó ningún punto');
  });

  it('offers a retry after a refusal, and the retry can succeed', async () => {
    redeemReply = { status: 409, body: { error: { code: 'REWARD_OUT_OF_STOCK', message: 'Reward is out of stock' } } };

    const button = await renderConfirm();
    fireEvent.click(button);
    await screen.findByRole('alert');

    redeemReply = { status: 201, body: successBody() };
    fireEvent.click(await screen.findByRole('button', { name: 'Intentar de nuevo' }));

    expect(await screen.findByText(/Canjeaste/)).toBeTruthy();
    expect(redeemCalls).toHaveLength(2);
  });

  it('moves focus to the refusal as well as to a success', async () => {
    redeemReply = { status: 409, body: { error: { code: 'INSUFFICIENT_BALANCE', message: 'Customer has 0 points' } } };

    const button = await renderConfirm();
    button.focus();
    fireEvent.click(button);

    await screen.findByText('No tenés puntos suficientes');

    await waitFor(() => {
      expect(document.activeElement).toBe(document.querySelector('.confirm-outcome'));
    });
  });

  it('leaves the balance claim absent after a refusal', async () => {
    // Nothing was spent, so nothing may be shown as a new balance.
    redeemReply = { status: 409, body: { error: { code: 'INSUFFICIENT_BALANCE', message: 'Customer has 0 points' } } };

    const button = await renderConfirm();
    fireEvent.click(button);
    await screen.findByText('No tenés puntos suficientes');

    expect(screen.queryByText('Saldo restante')).toBeNull();
  });
});
