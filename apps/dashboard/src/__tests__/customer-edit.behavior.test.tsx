// @vitest-environment jsdom

/**
 * What the operator sees while a save is refused.
 *
 * ## The failure this guards
 *
 * An optimistic edit that is never rolled back is the last way this system can
 * lie to a merchant. The customer record shows the phone the operator just typed,
 * the customer in front of them still has the old one, and nothing in the
 * interface says otherwise — the operator walks away believing a correction is
 * saved when it is not. The worse version of this bug is the opposite one: an
 * edit form that wipes the operator's typing when the server says no, so they
 * retype it, and the second attempt hits the same conflict.
 *
 * So both halves are pinned here. The read-only surface — the card above the
 * form — is the server's answer and only ever moves when the server answers. The
 * inputs keep the typing, because unsaved work belongs to the operator, and the
 * form says out loud that it is not saved.
 *
 * ## Why the inputs keep their value but the card does not
 *
 * Those are two different questions. "What did the server store?" is answered by
 * the server, and a client that answers it locally is guessing. "What was I in
 * the middle of typing?" is answered by the operator, and a client that discards
 * it is being careless. Keeping the second while refusing to invent the first is
 * the whole behaviour.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CUSTOMER_PATCH_ERROR } from '@vyloop/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CustomerDetailPage from '../app/dashboard/customers/[id]/page';
import { ApiError, type CustomerDetail } from '../lib/api';

const CUSTOMER_ID = 'a0000000-0000-4000-8000-000000000001';

const SERVER_CUSTOMER: CustomerDetail = {
  id: CUSTOMER_ID,
  fullName: 'Ana Ruiz',
  phone: '+56911112222',
  email: 'ana@test.com',
  birthDate: '1990-05-04',
  points: 320,
  totalPointsEarned: 900,
  currentTier: 'Bronce',
  createdAt: '2025-11-02',
  customer_events: [],
  recent_transactions: [],
  consents: [],
};

/**
 * The server's copy of the record, which only a successful save moves.
 *
 * Modelled as state rather than a fixed stub so the test can tell "the card
 * showed the new name" from "the card showed the name the mock was told to
 * return". With a constant stub those are indistinguishable, and an optimistic
 * UI would pass.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above the imports: the
 * page captures these references at import time, so a plain module-level `const`
 * would still be in its temporal dead zone when the factory ran.
 */
const mocks = vi.hoisted(() => ({
  updateCustomer: vi.fn(),
  serverCustomer: {} as { fullName?: string; phone?: string; email?: string | null; birthDate?: string },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'a0000000-0000-4000-8000-000000000001' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      getCustomer: vi.fn(async () => mocks.serverCustomer as CustomerDetail),
      getTiers: vi.fn(async () => []),
      getLoyaltyConfig: vi.fn(async () => ({ earnRate: 1, programName: 'Puntos' })),
      updateCustomer: mocks.updateCustomer,
    },
  };
});

/** Open the editor, type into a field, and press save. */
async function editAndSave(field: 'Nombre' | 'Teléfono' | 'Correo' | 'Fecha de nacimiento', value: string) {
  fireEvent.click(await screen.findByRole('button', { name: /editar datos/i }));
  fireEvent.change(await screen.findByLabelText(field), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: /^guardar$/i }));
}

describe('editing a customer', () => {
  beforeEach(() => {
    mocks.serverCustomer = { ...SERVER_CUSTOMER };
    mocks.updateCustomer.mockReset();
    // The default: the server accepts and stores.
    mocks.updateCustomer.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      mocks.serverCustomer = { ...mocks.serverCustomer, ...patch };
      return mocks.serverCustomer as CustomerDetail;
    });
  });

  afterEach(() => cleanup());

  it('offers the four editable fields and none of the locked ones', async () => {
    render(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /editar datos/i }));

    for (const label of ['Nombre', 'Teléfono', 'Correo', 'Fecha de nacimiento']) {
      expect(await screen.findByLabelText(label)).toBeDefined();
    }
    // Points, tier, member code and the customer id are shown, and there is no
    // way to type into them. An input that looks editable and is not teaches the
    // operator the wrong thing about what this screen can do.
    for (const label of ['Puntos', 'Nivel', 'ID de cliente']) {
      expect(screen.queryByLabelText(new RegExp(label, 'i'))).toBeNull();
    }
  });

  it('shows the server values when the editor opens', async () => {
    render(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /editar datos/i }));

    await waitFor(() =>
      expect((screen.getByLabelText('Teléfono') as HTMLInputElement).value).toBe('+56911112222'),
    );
    expect((screen.getByLabelText('Correo') as HTMLInputElement).value).toBe('ana@test.com');
  });

  it('sends only what changed', async () => {
    render(<CustomerDetailPage />);
    await editAndSave('Nombre', 'Ana Ruiz Soto');

    await waitFor(() => expect(mocks.updateCustomer).toHaveBeenCalledTimes(1));
    expect(mocks.updateCustomer.mock.calls[0]).toEqual([CUSTOMER_ID, { fullName: 'Ana Ruiz Soto' }]);
  });

  it('does not move the read-only card before the server answers', async () => {
    // The whole point of the test. A pending save is not a saved save.
    let release: () => void = () => {};
    mocks.updateCustomer.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ ...SERVER_CUSTOMER }); }),
    );

    render(<CustomerDetailPage />);
    await editAndSave('Nombre', 'Ana Ruiz Soto');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ana Ruiz');
    expect(screen.getByText('+56911112222')).toBeDefined();

    release();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ana Ruiz'));
  });

  it('does not show a rejected value as if the server had taken it', async () => {
    mocks.updateCustomer.mockRejectedValue(
      new ApiError(409, CUSTOMER_PATCH_ERROR.PHONE_TAKEN, 'Another customer in this business already uses this phone number.'),
    );

    render(<CustomerDetailPage />);
    await editAndSave('Teléfono', '+56999998888');

    await screen.findByText(/already uses this phone number/i);
    // The card above the form is still the server's answer.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ana Ruiz');
    expect(screen.getByText('+56911112222')).toBeDefined();
    expect(screen.queryByText('+56999998888')).toBeNull();
  });

  it('keeps the typing when the save is refused', async () => {
    // Undoing the operator's work is the other half of the same bug: they retype
    // it, and the second attempt fails identically.
    mocks.updateCustomer.mockRejectedValue(
      new ApiError(409, CUSTOMER_PATCH_ERROR.PHONE_TAKEN, 'Another customer in this business already uses this phone number.'),
    );

    render(<CustomerDetailPage />);
    await editAndSave('Teléfono', '+56999998888');

    await waitFor(() =>
      expect((screen.getByLabelText('Teléfono') as HTMLInputElement).value).toBe('+56999998888'),
    );
    // And it says the change is not saved, so keeping it is not a promise.
    expect(screen.getByText(/sin guardar/i)).toBeDefined();
  });

  it('shows a duplicate phone beside the phone input', async () => {
    mocks.updateCustomer.mockRejectedValue(
      new ApiError(409, CUSTOMER_PATCH_ERROR.PHONE_TAKEN, 'Another customer in this business already uses this phone number.'),
    );

    render(<CustomerDetailPage />);
    await editAndSave('Teléfono', '+56999998888');

    const message = await screen.findByText(/already uses this phone number/i);
    // Attached to the phone field, not floating at the top of the form: the
    // operator's next action is to change that one value.
    expect(message.closest('[data-field="phone"]')).not.toBeNull();
    expect(screen.queryByText(/already uses this email/i)).toBeNull();
  });

  it('shows a duplicate email beside the email input', async () => {
    mocks.updateCustomer.mockRejectedValue(
      new ApiError(409, CUSTOMER_PATCH_ERROR.EMAIL_TAKEN, 'Another customer in this business already uses this email address.'),
    );

    render(<CustomerDetailPage />);
    await editAndSave('Correo', 'taken@elsewhere.com');

    const message = await screen.findByText(/already uses this email/i);
    expect(message.closest('[data-field="email"]')).not.toBeNull();
  });

  it('closes the editor and shows the new value once the server confirms', async () => {
    render(<CustomerDetailPage />);
    await editAndSave('Nombre', 'Ana Ruiz Soto');

    await waitFor(() => expect(screen.queryByLabelText('Nombre')).toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ana Ruiz Soto');
    expect(screen.getByText('Ana Ruiz Soto')).toBeDefined();
  });

  it('sends nothing when the operator saved without changing anything', async () => {
    render(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /editar datos/i }));
    await screen.findByLabelText('Nombre');
    fireEvent.click(screen.getByRole('button', { name: /^guardar$/i }));

    await waitFor(() => expect(screen.getByText(/no hay cambios/i)).toBeDefined());
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });

  it('discards the draft when the editor is closed without saving', async () => {
    render(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /editar datos/i }));
    fireEvent.change(await screen.findByLabelText('Nombre'), { target: { value: 'Tipeado y olvidado' } });
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));

    fireEvent.click(await screen.findByRole('button', { name: /editar datos/i }));
    await waitFor(() =>
      expect((screen.getByLabelText('Nombre') as HTMLInputElement).value).toBe('Ana Ruiz'),
    );
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });

  it('does not offer the save button again while a save is in flight', async () => {
    let release: () => void = () => {};
    mocks.updateCustomer.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ ...SERVER_CUSTOMER }); }),
    );

    render(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /editar datos/i }));
    fireEvent.change(await screen.findByLabelText('Nombre'), { target: { value: 'Ana Ruiz Soto' } });
    fireEvent.click(screen.getByRole('button', { name: /^guardar$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /guardando/i })).toHaveProperty('disabled', true));
    release();
    await waitFor(() => expect(mocks.updateCustomer).toHaveBeenCalledTimes(1));
  });
});
