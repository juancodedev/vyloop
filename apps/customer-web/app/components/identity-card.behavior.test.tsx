/**
 * The identity card and the top bar, as the customer reads them.
 *
 * The card states who the customer is, their balance in the program's own
 * unit, and the honest distance to the next tier. It never claims a milestone
 * the tier list contradicts, and it never shows visit or purchase counts.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CustomerProfile, CustomerTier } from '../lib/api';

import { IdentityCard } from './identity-card';
import { ProfileTopBar } from './profile-top-bar';

const BRONCE: CustomerTier = { id: 't-bronce', name: 'Bronce', minPoints: 0, multiplier: 1, displayOrder: 1 };
const PLATA: CustomerTier = { id: 't-plata', name: 'Plata', minPoints: 20, multiplier: 1.25, displayOrder: 2 };
const ORO: CustomerTier = { id: 't-oro', name: 'Oro', minPoints: 150, multiplier: 1.5, displayOrder: 3 };

function makeProfile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    id: 'cust_1',
    globalId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    fullName: 'Juan Muñoz Castillo',
    phone: '+56912345678',
    points: 30,
    totalPointsEarned: 30,
    currentTierId: 't-plata',
    currentTier: 'Plata',
    business: { id: 'b1', name: 'Burger Club', slug: 'burger-club' },
    program: { id: 'p1', name: 'Club', pointsCurrency: 'puntos' },
    tiers: [BRONCE, PLATA, ORO],
    nextTier: ORO,
    recent_transactions: [],
    createdAt: '2025-12-10T12:00:00.000Z',
    ...overrides,
  };
}

afterEach(cleanup);

describe('the profile top bar', () => {
  it('names the club', () => {
    render(<ProfileTopBar business={{ id: 'b1', name: 'Burger Club', slug: 'burger-club' }} />);

    expect(screen.getByText('Burger Club')).toBeTruthy();
  });

  it('falls back to a neutral name when the business cannot be resolved', () => {
    render(<ProfileTopBar business={null} />);

    expect(screen.getByText('Club del barrio')).toBeTruthy();
  });
});

describe('the identity card', () => {
  it('shows the initials of the first two words of the name', () => {
    render(<IdentityCard profile={makeProfile()} />);

    expect(screen.getByText('JM')).toBeTruthy();
  });

  it('shows one initial for a single-word name', () => {
    render(<IdentityCard profile={makeProfile({ fullName: 'Juan' })} />);

    expect(screen.getByText('J')).toBeTruthy();
  });

  it('names the customer as the page heading, with the month and year they joined', () => {
    render(<IdentityCard profile={makeProfile()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Juan Muñoz Castillo' })).toBeTruthy();
    expect(screen.getByText('Miembro desde diciembre de 2025')).toBeTruthy();
  });

  it('shows the balance in the program unit', () => {
    render(<IdentityCard profile={makeProfile()} />);

    const card = screen.getByRole('region', { name: 'Tu identidad' });
    expect(card.textContent).toContain('30');
    expect(card.textContent).toContain('puntos');
    expect(card.textContent).not.toMatch(/visita|compras/i);
  });

  it('shows the tier chip and the progress to the next tier', () => {
    render(<IdentityCard profile={makeProfile()} />);

    expect(screen.getByText('Nivel Plata')).toBeTruthy();
    expect(screen.getByText('Te faltan 120 puntos para el nivel Oro')).toBeTruthy();

    const bar = screen.getByRole('progressbar', { name: '20% hacia Oro' });
    expect(bar.getAttribute('value')).toBe('30');
    expect(bar.getAttribute('max')).toBe('150');
  });

  it('says the customer is on the top tier, with no bar, only on the last rung', () => {
    render(<IdentityCard profile={makeProfile({ currentTierId: 't-oro', currentTier: 'Oro', points: 900, nextTier: null })} />);

    expect(screen.getByText('Estás en el nivel más alto')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('withholds the top-tier claim when a rung sits above the assigned one', () => {
    render(<IdentityCard profile={makeProfile({ nextTier: null, points: 900 })} />);

    expect(screen.queryByText('Estás en el nivel más alto')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('claims no tier when none is assigned', () => {
    const profile = makeProfile({ currentTier: null, nextTier: null, points: 0 });
    delete profile.currentTierId;
    render(<IdentityCard profile={profile} />);

    expect(screen.queryByText(/^Nivel /)).toBeNull();
    expect(screen.queryByText('Estás en el nivel más alto')).toBeNull();
  });

  it('shows the setup status and no tier line when there is no program', () => {
    render(<IdentityCard profile={makeProfile({ program: null })} />);

    expect(screen.getByText('Tu programa se está configurando')).toBeTruthy();
    expect(screen.queryByText('Nivel Plata')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows the setup status when the tenant defined no tiers', () => {
    render(<IdentityCard profile={makeProfile({ tiers: [], nextTier: null })} />);

    expect(screen.getByText('Tu programa se está configurando')).toBeTruthy();
    expect(screen.queryByText('Nivel Plata')).toBeNull();
  });
});
