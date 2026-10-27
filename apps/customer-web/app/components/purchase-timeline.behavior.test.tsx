/**
 * Recent purchases, row by row.
 *
 * Direction is carried by the transaction type and by text, magnitude by
 * `Math.abs(points)`. A purchase is titled by its amount; anything without an
 * amount falls back to its note, and "$0" is never shown.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CustomerEvent, CustomerProfile, RecentTransaction } from '../lib/api';

import { buildTimeline, PurchaseTimeline } from './purchase-timeline';

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

function tx(overrides: Partial<RecentTransaction>): RecentTransaction {
  return {
    id: 'tx-1',
    type: 'earn',
    points: 20,
    balanceAfter: 30,
    purchaseAmount: null,
    note: null,
    createdAt: daysAgo(2),
    ...overrides,
  };
}

function event(overrides: Partial<CustomerEvent>): CustomerEvent {
  return { id: 'ev-1', eventType: 'customer.registered', payload: {}, createdAt: daysAgo(10), ...overrides };
}

function makeProfile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    id: 'cust_1',
    globalId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    fullName: 'Ada Lovelace',
    phone: '+56912345678',
    points: 30,
    totalPointsEarned: 30,
    currentTier: null,
    business: null,
    program: { id: 'p1', name: 'Club', pointsCurrency: 'puntos' },
    tiers: [],
    nextTier: null,
    recent_transactions: [],
    customer_events: [],
    createdAt: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

afterEach(cleanup);

describe('recent purchase rows', () => {
  it('titles a purchase by its amount, with date, points and resulting balance', () => {
    render(<PurchaseTimeline profile={makeProfile({ recent_transactions: [tx({ purchaseAmount: 11400 })] })} />);

    expect(screen.getByText('Compra de $11.400')).toBeTruthy();
    expect(screen.getByText('Hace 2 días')).toBeTruthy();
    expect(screen.getByText('+20 puntos')).toBeTruthy();
    expect(screen.getByText('saldo 30')).toBeTruthy();
  });

  it('titles an earn without amount by its note, and never shows $0', () => {
    render(
      <PurchaseTimeline
        profile={makeProfile({ recent_transactions: [tx({ purchaseAmount: null, note: 'Bono de bienvenida' })] })}
      />,
    );

    expect(screen.getByText('Bono de bienvenida')).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it('falls back to "Puntos ganados" for an earn with neither amount nor note', () => {
    render(<PurchaseTimeline profile={makeProfile({ recent_transactions: [tx({})] })} />);

    expect(screen.getByText('Puntos ganados')).toBeTruthy();
  });

  it('titles a redemption by its reward and shows the points going out', () => {
    render(
      <PurchaseTimeline
        profile={makeProfile({
          recent_transactions: [tx({ type: 'redeem', points: 100, balanceAfter: 0, note: 'Burger gratis' })],
        })}
      />,
    );

    expect(screen.getByText('Canjeaste Burger gratis')).toBeTruthy();
    expect(screen.getByText('−100 puntos')).toBeTruthy();
    expect(screen.getByText('saldo 0')).toBeTruthy();
  });

  it('names an unnamed redemption honestly', () => {
    render(
      <PurchaseTimeline
        profile={makeProfile({ recent_transactions: [tx({ type: 'redeem', points: -50, note: null })] })}
      />,
    );

    expect(screen.getByText('Canjeaste un premio')).toBeTruthy();
    expect(screen.getByText('−50 puntos')).toBeTruthy();
  });

  it('counts in the program unit', () => {
    render(
      <PurchaseTimeline
        profile={makeProfile({
          program: { id: 'p1', name: 'Club', pointsCurrency: 'estrellas' },
          recent_transactions: [tx({ purchaseAmount: 5900, points: 10, balanceAfter: 10 })],
        })}
      />,
    );

    expect(screen.getByText('+10 estrellas')).toBeTruthy();
  });

  it('shows joining the club as its own row, without points', () => {
    render(<PurchaseTimeline profile={makeProfile({ customer_events: [event({})] })} />);

    expect(screen.getByText('Te uniste al club')).toBeTruthy();
    expect(screen.queryByText(/puntos/)).toBeNull();
  });

  it('shows an old movement with its short date', () => {
    const now = new Date();
    const old = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 12);
    // Keep the case inside the current year so the year is not appended.
    if (old.getFullYear() !== now.getFullYear()) return;

    render(<PurchaseTimeline profile={makeProfile({ recent_transactions: [tx({ createdAt: old.toISOString() })] })} />);

    expect(screen.queryByText(/sem/)).toBeNull();
    expect(screen.getByText(/^\d{1,2} \w{3}\.?$/)).toBeTruthy();
  });

  it('says there are no movements yet when the list is empty', () => {
    render(<PurchaseTimeline profile={makeProfile()} />);

    expect(screen.getByText('Todavía no hay movimientos. Cuando sumes en el local, aparecen acá.')).toBeTruthy();
  });
});

describe('buildTimeline', () => {
  it('merges purchases and the registration, newest first, at most five, hiding internal events', () => {
    const profile = makeProfile({
      recent_transactions: [1, 2, 3, 4, 5].map((n) => tx({ id: `tx-${n}`, createdAt: daysAgo(n) })),
      customer_events: [
        event({ id: 'ev-reg', createdAt: daysAgo(0.5) }),
        event({ id: 'ev-view', eventType: 'customer.profile_viewed', createdAt: daysAgo(0.1) }),
      ],
    });

    expect(buildTimeline(profile).map((item) => item.id)).toEqual(['ev-reg', 'tx-1', 'tx-2', 'tx-3', 'tx-4']);
  });
});
