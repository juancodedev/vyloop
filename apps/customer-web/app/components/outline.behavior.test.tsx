/**
 * The document outline, and what a screen reader meets on arrival.
 *
 * Headings are the only navigation a screen reader user has inside a page, so a
 * skipped level is a hole in the map: `h1` then `h3` leaves nothing to descend
 * through, and there is no "where am I" answer. This asserts the outline of the
 * pass, which is the one page with more than one section on it.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CustomerProfile } from '../lib/api';

import { MemberPass } from './member-pass';
import { MovementList } from './movement-list';

const TIERS = [
  { id: 't1', name: 'Bronce', minPoints: 0 },
  { id: 't2', name: 'Plata', minPoints: 500 },
];

function makeProfile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    id: 'cust-1',
    globalId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    fullName: 'Ada Lovelace',
    phone: '+56912345678',
    points: 640,
    totalPointsEarned: 900,
    pointsLast30Days: 240,
    currentTierId: 't2',
    business: { id: 'b1', name: 'Café del Barrio', slug: 'cafe-del-barrio' },
    program: { id: 'p1', name: 'Club del Barrio', pointsCurrency: 'puntos' },
    tiers: TIERS,
    nextTier: null,
    createdAt: '2025-11-02T10:00:00.000Z',
    ...overrides,
  } as CustomerProfile;
}

afterEach(cleanup);

/** Every heading level in document order, as numbers. */
function headingLevels(container: HTMLElement): number[] {
  return [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) =>
    Number(heading.tagName.slice(1)),
  );
}

describe('the pass outline', () => {
  it('starts at h1 and never skips a level', () => {
    const { container } = render(<MemberPass profile={makeProfile()} />);

    const levels = headingLevels(container);

    expect(levels[0]).toBe(1);
    // The ladder was an h3 under the pass's h1, which jumped a level.
    expect(levels).toContain(2);
    expect(levels).not.toContain(3);

    levels.reduce((previous, level) => {
      expect(level).toBeLessThanOrEqual(previous + 1);
      return level;
    }, levels[0]);
  });

  it('names the ladder as a section the customer can jump to', () => {
    render(<MemberPass profile={makeProfile()} />);

    const ladder = screen.getByRole('heading', { level: 2, name: 'Tu nivel' });

    expect(ladder).toBeTruthy();
    expect(ladder.closest('section')?.getAttribute('aria-labelledby')).toBe(ladder.id);
  });

  it('keeps the visible treatment of the ladder title whatever the tag', () => {
    // The heading level is document structure; the size and weight come from
    // `club-ladder__title`, so this is not a visual change.
    render(<MemberPass profile={makeProfile()} />);

    expect(screen.getByRole('heading', { name: 'Tu nivel' }).className).toBe('club-ladder__title');
  });
});

describe('the movements list', () => {
  it('is a list with an accessible name, so it is reachable as a landmark', () => {
    render(
      <MovementList
        transactions={[
          {
            id: 'tx-1',
            customer_id: 'cust-1',
            type: 'earn',
            points: 500,
            balance_after: 1200,
            reference_id: 'ref-1',
            note: null,
            created_at: '2026-02-02T10:00:00.000Z',
          },
        ]}
        currency="puntos"
        label="Tus movimientos de puntos"
      />,
    );

    expect(screen.getByRole('list', { name: 'Tus movimientos de puntos' })).toBeTruthy();
  });
});
