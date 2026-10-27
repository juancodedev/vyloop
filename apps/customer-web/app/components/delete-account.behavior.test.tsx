/**
 * "Eliminar mi cuenta", as the customer meets it.
 *
 * Nothing is sent from the first click: it only opens an in-page confirm step
 * that says what is lost. Only the confirm button calls the API, and only a
 * successful answer hands control back to the page to sign out.
 *
 * `api` is mocked with `deleteAccount` and nothing else; `ApiError` is the real
 * class, because the component branches on its `code`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';

import { DeleteAccount } from './delete-account';

const mocks = vi.hoisted(() => ({ deleteAccount: vi.fn() }));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { deleteAccount: mocks.deleteAccount },
}));

function renderDelete(points = 120, currency: string | null = 'puntos', onDeleted = vi.fn()) {
  render(<DeleteAccount points={points} pointsCurrency={currency} onDeleted={onDeleted} />);
  return onDeleted;
}

function openConfirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Eliminar mi cuenta' }));
}

function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Sí, eliminar mi cuenta' }));
}

beforeEach(() => {
  mocks.deleteAccount.mockReset();
});

afterEach(cleanup);

describe('deleting the account', () => {
  it('asks first, says the points are lost, and sends nothing yet', () => {
    renderDelete();
    openConfirm();

    expect(screen.getByText(/Vas a perder tus 120 puntos/)).toBeTruthy();
    expect(screen.getByText(/no se puede deshacer/)).toBeTruthy();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes on confirm and hands back to the page', async () => {
    mocks.deleteAccount.mockResolvedValue(undefined);
    const onDeleted = renderDelete();
    openConfirm();

    confirm();

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
  });

  it('goes back without a request on Cancelar', () => {
    renderDelete();
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(screen.getByRole('button', { name: 'Eliminar mi cuenta' })).toBeTruthy();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('asks to sign in again when the session cannot delete', async () => {
    mocks.deleteAccount.mockRejectedValue(new ApiError(403, 'AUTH_SCOPE_MISSING', 'scope'));
    const onDeleted = renderDelete();
    openConfirm();

    confirm();

    await waitFor(() =>
      expect(screen.getByText('Para eliminar tu cuenta, cerrá sesión y volvé a entrar.')).toBeTruthy(),
    );
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('says the deletion failed on any other error, and keeps the account', async () => {
    mocks.deleteAccount.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    const onDeleted = renderDelete();
    openConfirm();

    confirm();

    await waitFor(() =>
      expect(screen.getByText('No pudimos eliminar tu cuenta. Intentá de nuevo.')).toBeTruthy(),
    );
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('still warns about the balance when the program names no currency', () => {
    renderDelete(80, null);
    openConfirm();

    expect(screen.getByText(/Vas a perder tu saldo de 80\./)).toBeTruthy();
  });

  it('does not name a balance it does not have', () => {
    renderDelete(0, null);
    openConfirm();

    expect(screen.queryByText(/Vas a perder/)).toBeNull();
    expect(screen.getByText(/no se puede deshacer/)).toBeTruthy();
  });
});
