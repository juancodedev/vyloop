/**
 * "Tus datos", as the customer reads and edits it.
 *
 * The list shows only the values the profile has. "Editar" opens a form for
 * name, email and birth date; the phone is never editable here. Only the
 * fields that changed are sent, and the list moves only after the server
 * answers.
 *
 * `api` is mocked with `updateProfile` and nothing else; `ApiError` is the
 * real class, because the component branches on its `status` and `code`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type CustomerProfile } from '../lib/api';

import { PersonalData } from './personal-data';

const mocks = vi.hoisted(() => ({ updateProfile: vi.fn() }));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { updateProfile: mocks.updateProfile },
}));

function makeProfile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    id: 'cust_1',
    globalId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    fullName: 'Ada Lovelace',
    phone: '+56912345678',
    email: 'ada@example.com',
    birthDate: '1981-07-27',
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

function renderData(profile: CustomerProfile = makeProfile(), onSaved = vi.fn()) {
  render(<PersonalData profile={profile} onSaved={onSaved} />);
  return onSaved;
}

function rowValue(label: string): string | null {
  const term = screen.queryByText(label, { selector: 'dt' });
  return term?.nextElementSibling?.textContent ?? null;
}

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
}

beforeEach(() => {
  mocks.updateProfile.mockReset();
});

afterEach(cleanup);

describe('the personal data list', () => {
  it('lists name, phone, email and the birthday as day and month', () => {
    renderData();

    expect(rowValue('Nombre')).toBe('Ada Lovelace');
    expect(rowValue('Teléfono')).toBe('+56912345678');
    expect(rowValue('Correo')).toBe('ada@example.com');
    // The calendar date as stored, never shifted by the device time zone.
    expect(rowValue('Cumpleaños')).toBe('27 de julio');
  });

  it('omits a field without a value instead of showing a dash', () => {
    const profile = makeProfile();
    delete profile.email;
    renderData(profile);

    expect(screen.queryByText('Correo')).toBeNull();
    expect(screen.queryByText('-')).toBeNull();
  });
});

describe('editing personal data', () => {
  it('opens a form for name, email and birth date, and never the phone', () => {
    renderData();
    openEditor();

    expect((screen.getByLabelText('Nombre', { exact: false }) as HTMLInputElement).value).toBe('Ada Lovelace');
    expect((screen.getByLabelText('Correo', { exact: false }) as HTMLInputElement).value).toBe('ada@example.com');
    expect((screen.getByLabelText('Fecha de nacimiento', { exact: false }) as HTMLInputElement).value).toBe(
      '1981-07-27',
    );
    expect(screen.queryByLabelText('Teléfono', { exact: false })).toBeNull();
  });

  it('saves a new email, shows it, and confirms with a toast', async () => {
    mocks.updateProfile.mockResolvedValue({
      fullName: 'Ada Lovelace',
      email: 'nuevo@example.com',
      birthDate: '1981-07-27',
    });
    const onSaved = renderData();
    openEditor();

    type('Correo', 'nuevo@example.com');
    save();

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Cambios guardados'));
    // Only what changed is sent.
    expect(mocks.updateProfile).toHaveBeenCalledWith({ email: 'nuevo@example.com' });
    expect(onSaved).toHaveBeenCalledWith({
      fullName: 'Ada Lovelace',
      email: 'nuevo@example.com',
      birthDate: '1981-07-27',
    });
    expect(screen.queryByRole('button', { name: 'Guardar cambios' })).toBeNull();
  });

  it('refuses an invalid email without sending anything', () => {
    renderData();
    openEditor();

    type('Correo', 'nuevo@');
    save();

    expect(screen.getByText('Ingresá un email válido, por ejemplo nombre@dominio.cl')).toBeTruthy();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it('refuses an empty name without sending anything', () => {
    renderData();
    openEditor();

    type('Nombre', '   ');
    save();

    expect(screen.getByText('Ingresá tu nombre.')).toBeTruthy();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it('clears the email when the field is emptied', async () => {
    mocks.updateProfile.mockResolvedValue({ fullName: 'Ada Lovelace', email: null, birthDate: '1981-07-27' });
    renderData();
    openEditor();

    type('Correo', '');
    save();

    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith({ email: null }));
  });

  it('closes without a request when nothing changed', () => {
    renderData();
    openEditor();

    save();

    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Editar' })).toBeTruthy();
  });

  it('puts a taken email next to the email field and keeps the draft', async () => {
    mocks.updateProfile.mockRejectedValue(new ApiError(409, 'CUSTOMER_EMAIL_TAKEN', 'taken'));
    const onSaved = renderData();
    openEditor();

    type('Correo', 'otro@example.com');
    save();

    await waitFor(() => expect(screen.getByText('Ese email ya lo usa otra persona en este club.')).toBeTruthy());
    expect((screen.getByLabelText('Correo', { exact: false }) as HTMLInputElement).value).toBe('otro@example.com');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('asks to sign in again when the session cannot edit', async () => {
    mocks.updateProfile.mockRejectedValue(new ApiError(403, 'AUTH_SCOPE_MISSING', 'scope'));
    renderData();
    openEditor();

    type('Nombre', 'Ada King');
    save();

    await waitFor(() =>
      expect(screen.getByText('Para editar tus datos, cerrá sesión y volvé a entrar.')).toBeTruthy(),
    );
  });

  it('says the save failed on any other error', async () => {
    mocks.updateProfile.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    renderData();
    openEditor();

    type('Nombre', 'Ada King');
    save();

    await waitFor(() =>
      expect(screen.getByText('No pudimos guardar los cambios. Intentá de nuevo.')).toBeTruthy(),
    );
  });

  it('goes back to the list on Cancelar, unchanged', () => {
    renderData();
    openEditor();

    type('Nombre', 'Otra persona');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(rowValue('Nombre')).toBe('Ada Lovelace');
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });
});
