// @vitest-environment jsdom

/**
 * The branch list, as a merchant uses it: the search finds a branch, the
 * address column shows the address, and "Incluir inactivas" decides whether
 * deactivated branches appear.
 *
 * The identity worker returns every branch, active or not, in one list, so
 * the page filters and searches what it already has.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getVenues: vi.fn(), reactivateVenue: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getVenues: mocks.getVenues, reactivateVenue: mocks.reactivateVenue },
}));

import VenuesPage from '../app/dashboard/settings/venues/page';

function branch(overrides: Record<string, unknown>) {
  return {
    id: 'b1',
    name: 'Providencia',
    address: 'Av. Providencia 1234',
    city: 'Santiago',
    country: 'CL',
    timezone: 'America/Santiago',
    latitude: null,
    longitude: null,
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getVenues.mockResolvedValue({
    branches: [
      branch({}),
      branch({ id: 'b2', name: 'Ñuñoa', address: 'Irarrázaval 3000' }),
      branch({ id: 'b3', name: 'Las Condes', address: 'Apoquindo 5000', is_active: false }),
    ],
    total: 3,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the branch list', () => {
  it('hides deactivated branches until asked to include them', async () => {
    render(<VenuesPage />);
    await screen.findByText('Providencia');

    expect(screen.queryByText('Las Condes')).toBeNull();

    fireEvent.click(screen.getByLabelText('Incluir inactivas'));

    expect(await screen.findByText('Las Condes')).toBeTruthy();
  });

  it('finds a branch by name or address', async () => {
    render(<VenuesPage />);
    await screen.findByText('Providencia');

    const search = screen.getByPlaceholderText('Buscar por nombre o dirección…');
    fireEvent.change(search, { target: { value: 'irarra' } });

    expect(screen.getByText('Ñuñoa')).toBeTruthy();
    expect(screen.queryByText('Providencia')).toBeNull();

    fireEvent.change(search, { target: { value: 'nunoa' } });
    expect(screen.getByText('Ñuñoa')).toBeTruthy();
  });

  it('shows the street address in the address column', async () => {
    render(<VenuesPage />);
    await screen.findByText('Providencia');

    expect(screen.getByText('Av. Providencia 1234, Santiago')).toBeTruthy();
  });

  it('says so when no branch matches the search', async () => {
    render(<VenuesPage />);
    await screen.findByText('Providencia');

    fireEvent.change(screen.getByPlaceholderText('Buscar por nombre o dirección…'), {
      target: { value: 'valparaíso' },
    });

    expect(screen.getByText('Ninguna sede coincide con la búsqueda.')).toBeTruthy();
  });

  it('reactivates a deactivated branch', async () => {
    mocks.reactivateVenue.mockResolvedValue(undefined);
    render(<VenuesPage />);
    await screen.findByText('Providencia');
    fireEvent.click(screen.getByLabelText('Incluir inactivas'));
    await screen.findByText('Las Condes');

    fireEvent.click(screen.getByRole('button', { name: 'Reactivar Las Condes' }));

    await waitFor(() => expect(mocks.reactivateVenue).toHaveBeenCalledWith('b3'));
    await waitFor(() => expect(mocks.getVenues).toHaveBeenCalledTimes(2));
  });
});
