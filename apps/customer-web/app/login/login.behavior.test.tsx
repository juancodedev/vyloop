import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from './page';

const mocks = vi.hoisted(() => ({
  businessSlug: 'barber' as string | null,
  login: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () =>
    new URLSearchParams(mocks.businessSlug === null ? [] : [['biz', mocks.businessSlug]]),
}));

// The auth layer is mocked here on purpose: this suite is about the page
// branching on the typed result. The real login implementation is covered
// against a real `apiFetch` in ../lib/auth.behavior.test.tsx.
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ login: mocks.login }),
}));

const NOT_REGISTERED = /Número no registrado\. ¿Ya te registraste\?/;
const CONNECTIVITY = /No pudimos conectar con el servidor\./;

function getPhoneInput(): HTMLInputElement {
  return screen.getByLabelText(/^Teléfono/) as HTMLInputElement;
}

function getSubmitButton(name: RegExp = /^Ingresar$/): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

function renderPage() {
  render(<LoginPage />);
}

async function submitForm() {
  await act(async () => {
    fireEvent.click(getSubmitButton());
  });
}

function typePhone(value: string) {
  fireEvent.change(getPhoneInput(), { target: { value } });
}

describe('login page behavior', () => {
  beforeEach(() => {
    mocks.businessSlug = 'barber';
    mocks.push.mockReset();
    mocks.login.mockReset();
    mocks.login.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();
    renderPage();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('rejects an empty phone locally, focuses the field and makes zero network calls', async () => {
    typePhone('   ');

    await submitForm();

    expect(await screen.findByText('Ingresá tu número de teléfono.')).toBeTruthy();
    expect(document.activeElement).toBe(getPhoneInput());
    expect(mocks.login).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(0);
  });

  it('rejects a phone made only of separators without making a network call', async () => {
    typePhone(' - - ');

    await submitForm();

    expect(await screen.findByText('Ingresá tu número de teléfono.')).toBeTruthy();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('clears the inline field error as soon as the user types again', async () => {
    typePhone('   ');
    await submitForm();
    expect(await screen.findByText('Ingresá tu número de teléfono.')).toBeTruthy();

    typePhone('+56912345678');

    expect(screen.queryByText('Ingresá tu número de teléfono.')).toBeNull();
  });

  it('normalizes every accepted phone shape to the same +56 value', async () => {
    const shapes = ['+56 9 1234 5678', '56912345678', '+56-9-1234-5678', '9 1234 5678'];

    for (const shape of shapes) {
      cleanup();
      mocks.login.mockClear();
      renderPage();
      typePhone(shape);

      await submitForm();

      expect(mocks.login).toHaveBeenCalledTimes(1);
      expect(mocks.login).toHaveBeenCalledWith('+56912345678', 'barber');
    }
  });

  it('forwards the business context to login without rendering the raw slug', async () => {
    expect(screen.getByText('Este programa')).toBeTruthy();
    expect(screen.queryByText('barber')).toBeNull();

    typePhone('+56912345678');
    await submitForm();

    expect(mocks.login).toHaveBeenCalledWith('+56912345678', 'barber');
  });

  it('refuses to log in without a biz, because the phone alone names no business', async () => {
    // A phone number is not unique across businesses: the same person holds a
    // separate customer record at every café they joined, so `limit 1` over the
    // phone column returned whichever tenant the database happened to yield, and
    // the same number could land in a different café on a different request.
    //
    // The previous version of this test asserted the opposite — that the form
    // "still works" without a business — which is the behaviour that made the
    // choice invisible.
    cleanup();
    mocks.businessSlug = null;
    renderPage();

    expect(screen.queryByLabelText('Contexto del programa')).toBeNull();

    // The person is told what is missing before being asked for a number that
    // could not identify anything.
    expect(screen.getByRole('alert').textContent || '').toMatch(/contexto del comercio/i);

    // And the form is not usable, so the refusal cannot be stepped past by typing.
    // A `<fieldset disabled>` is what disables the controls inside it; that is a
    // behaviour of the fieldset rather than an attribute copied onto each control,
    // so the assertion is on the fieldset itself.
    const fieldset = document.querySelector('fieldset.club-login__fieldset') as HTMLFieldSetElement;
    expect(fieldset).not.toBeNull();
    expect(fieldset.disabled).toBe(true);

    await submitForm();

    // No request at all: the server refuses this too, with `AUTH_BUSINESS_REQUIRED`.
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('carries the biz onto the profile after a successful login', async () => {
    // The token is scoped to the business that was asked for. Dropping `biz` from
    // the navigation would put the customer on a profile that no longer knows which
    // café it belongs to.
    typePhone('+56912345678');
    await submitForm();

    expect(mocks.login).toHaveBeenCalledWith('+56912345678', 'barber');
    expect(mocks.push).toHaveBeenCalledWith('/profile?biz=barber');
  });

  it('keeps the biz parameter on the register and back links', () => {
    expect(screen.getByRole('link', { name: 'Registrate aquí' }).getAttribute('href')).toBe(
      '/register?biz=barber',
    );
    expect(screen.getByRole('link', { name: /Volver al inicio/ }).getAttribute('href')).toBe(
      '/?biz=barber',
    );
  });

  it('drops the biz parameter from every link when there is no context', () => {
    cleanup();
    mocks.businessSlug = null;
    renderPage();

expect(screen.getByRole('link', { name: 'Registrate aquí' }).getAttribute('href')).toBe(
      '/register',
    );
    // Two links back to the home page now exist — the shell's and the one inside the
    // missing-context notice — and neither may carry a `biz`, because there is none.
    for (const link of screen.getAllByRole('link', { name: /Volver al inicio/ })) {
      expect(link.getAttribute('href')).toBe('/');
    }
  });

  it('reports a 401 as an unregistered phone with a working register link', async () => {
    mocks.login.mockResolvedValue({ ok: false, reason: 'not_registered' });
    typePhone('+56912345678');

    await submitForm();

    expect(await screen.findByText(NOT_REGISTERED)).toBeTruthy();
    expect(screen.queryByText(CONNECTIVITY)).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Registrarme ahora' }).getAttribute('href'),
    ).toBe('/register?biz=barber');
  });

  it('reports a 5xx as a connectivity problem, not as an unregistered phone', async () => {
    mocks.login.mockResolvedValue({ ok: false, reason: 'unavailable' });
    typePhone('+56912345678');

    await submitForm();

    expect(await screen.findByText(CONNECTIVITY)).toBeTruthy();
    expect(screen.queryByText(NOT_REGISTERED)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Registrarme ahora' })).toBeNull();
  });

  it('reports a thrown network error as a connectivity problem', async () => {
    mocks.login.mockRejectedValue(new TypeError('Failed to fetch'));
    typePhone('+56912345678');

    await submitForm();

    expect(await screen.findByText(CONNECTIVITY)).toBeTruthy();
    expect(screen.queryByText(NOT_REGISTERED)).toBeNull();
  });

  it('treats an unclassified failure as a neutral, retryable error', async () => {
    mocks.login.mockResolvedValue({ ok: false, reason: 'unknown' });
    typePhone('+56912345678');

    await submitForm();

    expect(
      await screen.findByText(/No pudimos completar el ingreso\. Revisá los datos/),
    ).toBeTruthy();
    expect(screen.getByText('Algo salió mal al ingresar.')).toBeTruthy();
    expect(screen.queryByText(NOT_REGISTERED)).toBeNull();
    expect(screen.queryByText(CONNECTIVITY)).toBeNull();
  });

  it('disables the submit button with an ellipsis label while submitting, then re-enables it', async () => {
    let resolveLogin: ((value: { ok: true }) => void) | undefined;
    mocks.login.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    typePhone('+56912345678');

    fireEvent.click(getSubmitButton());
    await act(async () => {});

    const submittingButton = getSubmitButton(/^Entrando…$/);
    expect(submittingButton.disabled).toBe(true);
    expect(getPhoneInput().form?.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      resolveLogin?.({ ok: true });
    });

    const settledButton = getSubmitButton(/^Ingresar$/);
    expect(settledButton.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Entrando/ })).toBeNull();
    expect(mocks.push).toHaveBeenCalledWith('/profile?biz=barber');
  });

  it('re-enables the submit button after a failed attempt so the user can retry', async () => {
    mocks.login.mockResolvedValue({ ok: false, reason: 'unavailable' });
    typePhone('+56912345678');

    await submitForm();

    expect(await screen.findByText(CONNECTIVITY)).toBeTruthy();
    expect(getSubmitButton(/^Ingresar$/).disabled).toBe(false);

    mocks.login.mockResolvedValue({ ok: true });
    await submitForm();

    expect(mocks.login).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledWith('/profile?biz=barber');
  });

  it('replaces the failure with a fresh attempt instead of stacking messages', async () => {
    mocks.login.mockResolvedValue({ ok: false, reason: 'unavailable' });
    typePhone('+56912345678');
    await submitForm();
    expect(await screen.findByText(CONNECTIVITY)).toBeTruthy();

    mocks.login.mockResolvedValue({ ok: false, reason: 'not_registered' });
    await submitForm();

    expect(await screen.findByText(NOT_REGISTERED)).toBeTruthy();
    expect(screen.queryByText(CONNECTIVITY)).toBeNull();
  });
});
