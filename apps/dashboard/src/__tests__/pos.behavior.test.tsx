// @vitest-environment jsdom

/**
 * The till, as the cashier uses it: find the customer, type what the receipt
 * says, record the sale. There is no product list to keep up to date, and every
 * amount is in Chilean pesos.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLoyaltyConfig: vi.fn(),
  lookupCustomer: vi.fn(),
  assignPoints: vi.fn(),
  assignPurchasePoints: vi.fn(),
  redeemPoints: vi.fn(),
  getCustomerByGlobalId: vi.fn(),
  getCustomerByCardToken: vi.fn(),
  rotateCardToken: vi.fn(),
}));

/** What the fake camera decodes the moment the scanner starts. */
const scan = vi.hoisted(() => ({ decoded: '' }));

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

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class {
    async start(_camera: unknown, _config: unknown, onDecoded: (text: string) => unknown) {
      await onDecoded(scan.decoded);
    }
    async stop() {}
  },
}));

// The browser permission prompt is not what these tests are about.
vi.mock('@/lib/camera-permission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/camera-permission')>()),
  requestCameraAccess: vi.fn(async () => {}),
}));

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

// ─── Card token ─────────────────────────────────────────────────────

const TOKEN = `vyc1.${'Ab9_-'.repeat(8)}xYz`;
const UUID = '879e76de-1f50-4afe-8b93-11949e9a9ae4';

const SCANNED = {
  id: 'c2',
  globalId: UUID,
  fullName: 'Bruno Díaz',
  phone: '+56933334444',
  points: 300,
  currentTier: null,
  tier: null,
};

async function scanCode(decoded: string) {
  scan.decoded = decoded;
  fireEvent.click(screen.getByRole('button', { name: /Escanear tarjeta/ }));
}

describe('scanning a card', () => {
  it('resolves a scanned card token through the token route', async () => {
    mocks.getCustomerByCardToken.mockResolvedValue(SCANNED);
    render(<PosPage />);

    await scanCode(`/c/${TOKEN}`);

    expect(await screen.findByText('Bruno Díaz')).toBeTruthy();
    expect(screen.getByText('300 puntos')).toBeTruthy();
    expect(mocks.getCustomerByCardToken).toHaveBeenCalledWith(TOKEN);
    expect(mocks.getCustomerByGlobalId).not.toHaveBeenCalled();
  });

  it('shows an unknown or revoked token as a customer not found', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.getCustomerByCardToken.mockRejectedValue(
      new (ApiError as unknown as new (m: string, s: number, c?: string) => Error)(
        'Customer not found',
        404,
        'NOT_FOUND',
      ),
    );
    render(<PosPage />);

    await scanCode(TOKEN);

    expect((await screen.findByRole('alert')).textContent).toBe('Cliente no encontrado');
  });

  it('still resolves a uuid scan through the globalId route', async () => {
    mocks.getCustomerByGlobalId.mockResolvedValue(SCANNED);
    render(<PosPage />);

    await scanCode(`/c/${UUID}`);

    expect(await screen.findByText('Bruno Díaz')).toBeTruthy();
    expect(mocks.getCustomerByGlobalId).toHaveBeenCalledWith(UUID);
    expect(mocks.getCustomerByCardToken).not.toHaveBeenCalled();
  });

  it('resolves a pasted card token through the token route too', async () => {
    mocks.getCustomerByCardToken.mockResolvedValue(SCANNED);
    render(<PosPage />);

    fireEvent.change(screen.getByLabelText(/Buscar cliente/), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    expect(await screen.findByText('Bruno Díaz')).toBeTruthy();
    expect(mocks.getCustomerByCardToken).toHaveBeenCalledWith(TOKEN);
    expect(mocks.lookupCustomer).not.toHaveBeenCalled();
  });
});

describe('revoking the QR', () => {
  async function openRevoke() {
    render(<PosPage />);
    await identifyAna();
    fireEvent.click(screen.getByRole('button', { name: 'Revocar QR' }));
  }

  function typeReason(value: string) {
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value } });
  }

  function submit() {
    fireEvent.click(screen.getByRole('button', { name: 'Revocar este QR' }));
  }

  async function confirm() {
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revocar' }));
  }

  it('does not let the revocation go out without a reason of at least 3 characters', async () => {
    await openRevoke();

    const button = screen.getByRole('button', { name: 'Revocar este QR' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    typeReason('  ab  ');
    expect(button.disabled).toBe(true);

    typeReason('Tarjeta extraviada');
    expect(button.disabled).toBe(false);
    expect((screen.getByLabelText(/Motivo/) as HTMLTextAreaElement).maxLength).toBe(500);
    expect(mocks.rotateCardToken).not.toHaveBeenCalled();
  });

  it('asks for confirmation and does nothing when the operator cancels', async () => {
    await openRevoke();
    typeReason('Tarjeta extraviada');
    submit();

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.rotateCardToken).not.toHaveBeenCalled();
  });

  it('calls the rotate route with the trimmed reason and reports success', async () => {
    mocks.rotateCardToken.mockResolvedValue({ version: 2, pass: 'updated' });
    await openRevoke();
    typeReason('  Tarjeta extraviada  ');
    submit();
    await confirm();

    expect(await screen.findByText(/QR revocado/)).toBeTruthy();
    expect(mocks.rotateCardToken).toHaveBeenCalledWith('c1', 'Tarjeta extraviada');
    expect(mocks.rotateCardToken).toHaveBeenCalledTimes(1);
  });

  it('says the QR was revoked but the Wallet pass was not updated on PASS_UPDATE_FAILED', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.rotateCardToken.mockRejectedValue(
      new (ApiError as unknown as new (m: string, s: number, c?: string) => Error)(
        'Google did not confirm',
        502,
        'PASS_UPDATE_FAILED',
      ),
    );
    await openRevoke();
    typeReason('Tarjeta extraviada');
    submit();
    await confirm();

    const message = await screen.findByText(/no pudimos actualizar el pase de Wallet/);
    expect(message.textContent).toMatch(/El QR se revocó/);
    expect(message.textContent).toMatch(/Inténtalo de nuevo/);
    // The reason stays, so trying again is one click and not a retyped form.
    expect((screen.getByLabelText(/Motivo/) as HTMLTextAreaElement).value).toBe(
      'Tarjeta extraviada',
    );
  });
});
