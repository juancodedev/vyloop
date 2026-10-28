// @vitest-environment jsdom

/**
 * The till, as the cashier uses it: find the customer, type what the receipt
 * says, record the sale. There is no product list to keep up to date, and every
 * amount is in Chilean pesos.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLoyaltyConfig: vi.fn(),
  lookupCustomer: vi.fn(),
  assignPoints: vi.fn(),
  assignPurchasePoints: vi.fn(),
  redeemPoints: vi.fn(),
  getCustomerByGlobalId: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
    ) {
      super(message);
    }
  },
  api: mocks,
}));

vi.mock('html5-qrcode', () => ({ Html5Qrcode: vi.fn() }));

import PosPage from '../app/dashboard/loyalty/pos/page';

function programOf(earnBy: 'visit' | 'purchase') {
  return { earnBy, earnRate: 1, earnUnitAmount: 100 };
}

beforeEach(() => {
  mocks.getLoyaltyConfig.mockResolvedValue(programOf('purchase'));
  mocks.lookupCustomer.mockResolvedValue({
    id: 'c1',
    globalId: 'g1',
    fullName: 'Ana Rojas',
    points: 1240,
    currentTier: 'Plata',
    tier: { multiplier: 1 },
    pass: { state: 'active', lastSyncedAt: null },
  });
  mocks.assignPurchasePoints.mockResolvedValue({ points: 45 });
  mocks.assignPoints.mockResolvedValue({ points: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function identifyAna() {
  fireEvent.change(screen.getByLabelText(/Buscar cliente/), {
    target: { value: '+56911112222' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
  await screen.findByText('Ana Rojas');
}

function typeAmount(value: string) {
  fireEvent.change(screen.getByLabelText('Monto de la boleta'), { target: { value } });
}

describe('the till', () => {
  it('asks for the receipt amount instead of offering a product menu', () => {
    render(<PosPage />);

    expect(screen.getByLabelText('Monto de la boleta')).toBeTruthy();
    expect(screen.queryByText('Menú')).toBeNull();
    expect(screen.queryByText(/Carrito/)).toBeNull();
    expect(screen.queryByText('Café Latte')).toBeNull();
  });

  it('reads an amount typed with thousands dots as whole pesos and shows it in CLP', async () => {
    render(<PosPage />);
    await identifyAna();

    typeAmount('4.500');

    expect(screen.getByRole('button', { name: 'Registrar venta de $4.500' })).toBeTruthy();
    expect(screen.queryByText(/4500\.00|4\.500,00/)).toBeNull();
  });

  it('records a purchase program sale with the amount in pesos and shows what the server credited', async () => {
    render(<PosPage />);
    await identifyAna();
    typeAmount('4500');

    fireEvent.click(screen.getByRole('button', { name: 'Registrar venta de $4.500' }));

    expect(await screen.findByText('Venta registrada')).toBeTruthy();
    expect(mocks.assignPurchasePoints).toHaveBeenCalledWith('c1', 4500, expect.any(String));
    expect(mocks.assignPoints).not.toHaveBeenCalled();
    expect(screen.getByText('+45 puntos')).toBeTruthy();
    expect(screen.getByText('$4.500')).toBeTruthy();
  });

  it('records one visit under a visit program, whatever the amount', async () => {
    mocks.getLoyaltyConfig.mockResolvedValue(programOf('visit'));
    render(<PosPage />);
    await identifyAna();
    typeAmount('12990');

    fireEvent.click(screen.getByRole('button', { name: 'Registrar venta de $12.990' }));

    await screen.findByText('Venta registrada');
    expect(mocks.assignPoints).toHaveBeenCalledWith('c1', 1, expect.any(String));
    expect(mocks.assignPurchasePoints).not.toHaveBeenCalled();
  });

  it('does not record a sale without an amount', async () => {
    render(<PosPage />);
    await identifyAna();

    expect(screen.queryByRole('button', { name: /Registrar venta/ })).toBeNull();
  });
});
