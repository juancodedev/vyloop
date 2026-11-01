/**
 * "Tu próximo canje", as the customer reads it.
 *
 * The card renders what the server decided — `nextReward`, `affordableReward`
 * and the counts — and never picks a reward itself. Every quantity is counted
 * in the program's own unit; a reward name never becomes a unit.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CustomerProfile } from '../lib/api';

import { NextRedemptionCard } from './next-redemption-card';
import { PurchaseTimeline } from './purchase-timeline';

function makeProfile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    id: 'cust_1',
    globalId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    fullName: 'Ada Lovelace',
    phone: '+56912345678',
    points: 30,
    totalPointsEarned: 30,
    currentTier: null,
    business: { id: 'b1', name: 'Café del Barrio', slug: 'cafe-del-barrio' },
    program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'puntos' },
    tiers: [],
    nextTier: null,
    recent_transactions: [],
    createdAt: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

const PROGRESS = {
  nextReward: { id: 'r-burger', name: 'Burger gratis', pointsCost: 100, pointsMissing: 70 },
  affordableReward: null,
  affordableRewardsCount: 0,
  activeRewardsCount: 4,
};

afterEach(cleanup);

describe('the next redemption card', () => {
  it('shows progress toward the next reward', () => {
    render(<NextRedemptionCard profile={makeProfile(PROGRESS)} />);

    expect(screen.getByRole('region', { name: 'Tu próximo canje' })).toBeTruthy();
    expect(screen.getByText('Burger gratis')).toBeTruthy();
    expect(screen.getByText('Te faltan 70 puntos')).toBeTruthy();

    const bar = screen.getByRole('progressbar', { name: '30 de 100 puntos' });
    expect(bar.getAttribute('value')).toBe('30');
    expect(bar.getAttribute('max')).toBe('100');

    expect(screen.getByText('100 puntos')).toBeTruthy();

    const all = screen.getByRole('link', { name: 'Ver los 4' });
    expect(all.getAttribute('href')).toBe('/profile/rewards');
  });

  it('writes point amounts the way they are read in Chile', () => {
    // Every other balance on the profile uses `es-CL`; a raw 1240 next to a
    // formatted 1.240 reads as two different numbers.
    render(
      <NextRedemptionCard
        profile={makeProfile({
          ...PROGRESS,
          nextReward: { id: 'r-big', name: 'Cena para dos', pointsCost: 2500, pointsMissing: 1240 },
        })}
      />,
    );

    expect(screen.getByText('Te faltan 1.240 puntos')).toBeTruthy();
    expect(screen.getByText('2.500 puntos')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: '1.260 de 2.500 puntos' })).toBeTruthy();
  });

  it('writes the cost of an affordable reward the same way', () => {
    render(
      <NextRedemptionCard
        profile={makeProfile({
          ...PROGRESS,
          affordableReward: { id: 'r2', name: 'Torta', pointsCost: 1500, pointsMissing: 0 },
          affordableRewardsCount: 1,
        })}
      />,
    );

    expect(screen.getByText('1.500 puntos')).toBeTruthy();
  });

  it('counts in the program unit, never in the reward name', () => {
    render(
      <NextRedemptionCard
        profile={makeProfile({ ...PROGRESS, program: { id: 'p1', name: 'Club', pointsCurrency: 'estrellas' } })}
      />,
    );

    expect(screen.getByText('Te faltan 70 estrellas')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: '30 de 100 estrellas' })).toBeTruthy();
    expect(screen.getByText('100 estrellas')).toBeTruthy();
  });

  it('offers the redemption when a reward is already affordable', () => {
    render(
      <NextRedemptionCard
        profile={makeProfile({
          ...PROGRESS,
          affordableRewardsCount: 1,
          affordableReward: { id: 'r1', name: 'Papas medianas', pointsCost: 20, pointsMissing: 0 },
        })}
      />,
    );

    expect(screen.getByText('Ya puedes canjear Papas medianas')).toBeTruthy();
    const redeem = screen.getByRole('link', { name: 'Canjear' });
    expect(redeem.getAttribute('href')).toBe('/profile/rewards/confirm?reward=r1');
    // The affordable state takes priority over the progress bar.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('is not rendered when there are no rewards', () => {
    const { container } = render(
      <NextRedemptionCard
        profile={makeProfile({
          nextReward: null,
          affordableReward: null,
          affordableRewardsCount: 0,
          activeRewardsCount: 0,
        })}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('is not rendered, and shows no error, when the API sends no reward fields', () => {
    const { container } = render(<NextRedemptionCard profile={makeProfile()} />);

    expect(container.innerHTML).toBe('');
  });

  it('is not rendered without a program, because there is no unit to count in', () => {
    const { container } = render(<NextRedemptionCard profile={makeProfile({ ...PROGRESS, program: null })} />);

    expect(container.innerHTML).toBe('');
  });
});

describe('the recent purchases closing line', () => {
  it('ties the list to the next reward', () => {
    render(<PurchaseTimeline profile={makeProfile(PROGRESS)} />);

    expect(screen.getByText('Con 70 puntos más, tu canje Burger gratis es tuyo')).toBeTruthy();
  });

  it('is absent when there is no next reward', () => {
    render(<PurchaseTimeline profile={makeProfile()} />);

    expect(screen.queryByText(/tu canje .* es tuyo/)).toBeNull();
  });
});
