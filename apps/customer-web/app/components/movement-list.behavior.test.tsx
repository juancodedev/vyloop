/**
 * Direction and magnitude are read from different columns, and these tests
 * exist to keep them that way.
 *
 * The growth worker writes a POSITIVE `points` for a redemption — the spend is
 * expressed by `balance_after` dropping — so a component that took the sign
 * from the number would print every canje as a gain. The redemption cases
 * below therefore use positive points on purpose, which is what the server
 * actually sends.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Transaction } from '../lib/api';

import { MovementList, MovementRow } from './movement-list';

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    customer_id: 'cust-1',
    type: 'earn',
    points: 500,
    balance_after: 1200,
    reference_id: 'ref-1',
    note: null,
    created_at: '2026-02-02T10:00:00.000Z',
    ...overrides,
  };
}

function renderRow(overrides: Partial<Transaction> = {}, currency: string | null = 'puntos') {
  return render(
    <ul>
      <MovementRow transaction={makeTransaction(overrides)} currency={currency} />
    </ul>,
  );
}

afterEach(cleanup);

describe('movement row, direction', () => {
  it('an earn reads as a gain', () => {
    renderRow({ type: 'earn', points: 500 });

    expect(screen.getByText('+500')).toBeTruthy();
    expect(screen.getByText('Ganaste 500 puntos')).toBeTruthy();
    expect(document.querySelector('.movement__points--earned')).toBeTruthy();
    expect(document.querySelector('.movement__icon--earned')).toBeTruthy();
  });

  it('a redeem reads as a spend even though its points value is positive', () => {
    // This is the real wire shape. The type column says 'redeem' and the
    // number is a magnitude, so only reading `type` gets this right.
    renderRow({ type: 'redeem', points: 400 });

    expect(screen.getByText('−400')).toBeTruthy();
    expect(screen.getByText('Canjeaste 400 puntos')).toBeTruthy();
    expect(document.querySelector('.movement__points--redeemed')).toBeTruthy();
    expect(document.querySelector('.movement__icon--redeemed')).toBeTruthy();
  });

  it('renders earned and spent rows distinctly in the same list', () => {
    render(
      <MovementList
        currency="puntos"
        label="Tus movimientos de puntos"
        transactions={[
          makeTransaction({ id: 'tx-1', type: 'earn', points: 500, balance_after: 1200 }),
          makeTransaction({ id: 'tx-2', type: 'redeem', points: 400, balance_after: 800 }),
        ]}
      />,
    );

    expect(screen.getByText('+500')).toBeTruthy();
    expect(screen.getByText('−400')).toBeTruthy();
    expect(screen.getByText('Ganaste 500 puntos')).toBeTruthy();
    expect(screen.getByText('Canjeaste 400 puntos')).toBeTruthy();
  });

  it('a redemption that arrived with a negative value still shows one magnitude', () => {
    // Defensive: if a writer ever does store the sign, the row must not render
    // "--400" or a double negative. The absolute value keeps it a single number.
    renderRow({ type: 'redeem', points: -400 });

    expect(screen.getByText('−400')).toBeTruthy();
    expect(screen.getByText('Canjeaste 400 puntos')).toBeTruthy();
    expect(screen.queryByText(/--/)).toBeNull();
  });

  it('never labels an earn as a spend, whatever the note says', () => {
    // The note is free text written by the earn path. It must not be able to
    // flip the direction, which is why the direction never reads from it.
    renderRow({ type: 'earn', points: 500, note: 'Canje de recompensa' });

    expect(screen.getByText('Ganaste 500 puntos')).toBeTruthy();
    expect(screen.queryByText('Canjeaste 500 puntos')).toBeNull();
  });
});

describe('movement row, the values it shows', () => {
  it('shows the balance the server recorded after the movement', () => {
    renderRow({ type: 'redeem', points: 400, balance_after: 800 });
    expect(screen.getByText('Saldo: 800 puntos')).toBeTruthy();
  });

  it('uses the note as the description when the row has one', () => {
    // The worker stores the reward name in `note` for a redemption.
    renderRow({ type: 'redeem', points: 400, note: 'Café chico' });
    expect(screen.getByText('Café chico')).toBeTruthy();
  });

  it('falls back to a plain label when the row has no note', () => {
    renderRow({ type: 'earn', points: 500, note: null });
    expect(screen.getByText('Puntos acumulados')).toBeTruthy();
  });

  it('formats a large magnitude for reading', () => {
    renderRow({ type: 'earn', points: 12345, balance_after: 12345 });
    expect(screen.getByText('+12.345')).toBeTruthy();
  });

  it('drops the unit when the tenant has no program to name one', () => {
    renderRow({ type: 'earn', points: 500, balance_after: 1200 }, null);
    expect(screen.getByText('Ganaste 500')).toBeTruthy();
    expect(screen.getByText('Saldo: 1.200')).toBeTruthy();
  });

  it('renders a real date and survives an unparseable one', () => {
    renderRow({ created_at: '2026-02-02T10:00:00.000Z' });
    expect(screen.getByText(/2026/)).toBeTruthy();

    cleanup();
    renderRow({ created_at: 'not-a-date' });
    // Shown as it arrived rather than as "Invalid Date".
    expect(screen.getByText('not-a-date')).toBeTruthy();
  });
});

describe('movement list', () => {
  it('is reachable as a named list so it can be found without a selector', () => {
    render(
      <MovementList
        currency="puntos"
        label="Tus movimientos de puntos"
        transactions={[makeTransaction()]}
      />,
    );

    const list = screen.getByRole('list', { name: 'Tus movimientos de puntos' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });
});
