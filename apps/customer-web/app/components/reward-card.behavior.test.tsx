/**
 * The card is the only place a customer reads the three stock states, so these
 * tests are mostly about keeping them apart.
 *
 * `0` and `null` are asserted separately in both directions, because collapsing
 * them fails in two opposite ways and a single "renders the badge" assertion
 * would pass under either mistake.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Reward } from '../lib/api';

import { RewardCard } from './reward-card';

const CONFIRM_HREF = '/profile/rewards/confirm?reward=reward-1';

function makeReward(overrides: Partial<Reward> = {}): Reward {
  return {
    id: 'reward-1',
    name: 'Café chico',
    description: 'Un café chico de la casa',
    pointsCost: 400,
    category: 'Bebidas',
    stock: 12,
    imageUrl: 'https://example.test/cafe.jpg',
    ...overrides,
  };
}

function renderCard(overrides: Partial<Reward> = {}, currency: string | null = 'puntos') {
  return renderReward(makeReward(overrides), currency);
}

function renderReward(reward: Reward, currency: string | null = 'puntos') {
  return render(<RewardCard reward={reward} currency={currency} confirmHref={CONFIRM_HREF} />);
}

/**
 * Drops a key from the reward entirely.
 *
 * Distinct from setting it to `null`, and the distinction is the point of half
 * these tests: the server omits an optional column, and the card has to treat an
 * absent key and an explicit null the same way. Passing `undefined` would not
 * exercise that — it would be a different object shape again. This is also why
 * the stripped reward is rendered directly rather than passed as an override:
 * an override is merged onto a default, which would put the key straight back.
 */
function without(reward: Reward, key: 'imageUrl' | 'stock'): Reward {
  const { [key]: _omitted, ...rest } = reward;
  return rest as Reward;
}

afterEach(cleanup);

describe('reward card, real data only', () => {
  it('shows the name, the cost and the tenant own points label', () => {
    renderCard();

    expect(screen.getByRole('heading', { name: 'Café chico' })).toBeTruthy();
    expect(screen.getByText('400 puntos')).toBeTruthy();
  });

  it('uses the label the program supplies rather than a hardcoded unit', () => {
    // A tenant that calls them "estampitas" must see that on the card.
    renderCard({}, 'estampitas');
    expect(screen.getByText('400 estampitas')).toBeTruthy();

    cleanup();
    renderCard({}, 'pts');
    expect(screen.getByText('400 pts')).toBeTruthy();
  });

  it('shows a bare number when the tenant has no program to name a unit', () => {
    // No invented unit. "400" is the whole of what is known.
    renderCard({}, null);
    expect(screen.getByText('400')).toBeTruthy();
  });

  it('links to the confirmation step for this reward', () => {
    renderCard();
    expect(screen.getByRole('link', { name: 'Canjear Café chico' }).getAttribute('href')).toBe(
      CONFIRM_HREF,
    );
  });
});

describe('reward card, absent fields', () => {
  it('renders without an image and does not emit a broken one', () => {
    // `imageUrl` is optional on the row. The wrapper is omitted entirely rather
    // than rendered empty around a src that resolves to nothing.
    renderCard({ imageUrl: null });
    expect(screen.queryByRole('img')).toBeNull();

    cleanup();
    renderReward(without(makeReward(), 'imageUrl'));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders the image when the catalog supplies one', () => {
    renderCard();
    const image = screen.getByRole('presentation');
    expect(image.getAttribute('src')).toBe('https://example.test/cafe.jpg');
  });

  it('renders without a description and still shows the name and cost', () => {
    renderCard({ description: null });

    expect(screen.getByRole('heading', { name: 'Café chico' })).toBeTruthy();
    expect(screen.getByText('400 puntos')).toBeTruthy();
    expect(document.querySelector('.reward-card__desc')).toBeNull();
  });

  it('renders without a category rather than inventing one', () => {
    renderCard({ category: null });
    expect(document.querySelector('.reward-card__category')).toBeNull();
  });
});

describe('reward card, the three stock states', () => {
  it('stock of 0 is sold out: redeem is disabled and the reason is stated', () => {
    renderCard({ stock: 0 });

    const button = screen.getByRole('button', { name: 'Agotado' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The state is a word, not only the badge's colour, and it appears on both
    // the badge and the disabled control so neither is read in isolation.
    expect(document.querySelector('.reward-card__stock--empty')?.textContent).toBe('Agotado');
    // Nowhere to navigate to, so no link is offered at all.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('stock of null is untracked: it says so and does NOT disable redeem', () => {
    // The distinction that matters: null is the absence of a number, not a
    // number of zero. Blocking here would refuse a redemption the server
    // accepts, because it only rejects when stock is a number <= 0.
    renderCard({ stock: null });

    expect(screen.getByText('Stock no controlado')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Canjear Café chico' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an absent stock field is treated as untracked, not as sold out', () => {
    renderReward(without(makeReward(), 'stock'));

    expect(screen.getByText('Stock no controlado')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Canjear Café chico' })).toBeTruthy();
  });

  it('a positive stock states the real remaining count and stays redeemable', () => {
    renderCard({ stock: 3 });

    expect(screen.getByText('Quedan 3')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Canjear Café chico' })).toBeTruthy();
  });

  it('a single remaining unit still reads as available', () => {
    // 1 is not 0. An off-by-one here would strand the last reward in the shop.
    renderCard({ stock: 1 });

    expect(screen.getByText('Quedan 1')).toBeTruthy();
    expect(screen.queryByText('Agotado')).toBeNull();
    expect(screen.getByRole('link', { name: 'Canjear Café chico' })).toBeTruthy();
  });
});
