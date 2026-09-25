import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RegisterPage from './page';

const mocks = vi.hoisted(() => ({
  businessSlug: 'barber' as string | null,
  loginCustomer: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () =>
    new URLSearchParams(mocks.businessSlug === null ? [] : [['biz', mocks.businessSlug]]),
}));

vi.mock('../lib/api', () => ({
  api: {
    loginCustomer: mocks.loginCustomer,
  },
}));

const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:8787';

function createResponse(status: number, body: unknown = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function getInput(label: RegExp): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function getSubmitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Registrarme' }) as HTMLButtonElement;
}

async function submitForm(): Promise<void> {
  await act(async () => {
    fireEvent.click(getSubmitButton());
  });
}

function setRequiredFields(fullName: string, phone: string): void {
  fireEvent.change(getInput(/^Nombre completo/), { target: { value: fullName } });
  fireEvent.change(getInput(/^Teléfono/), { target: { value: phone } });
}

describe('registration behavior', () => {
  beforeEach(() => {
    mocks.businessSlug = 'barber';
    mocks.push.mockReset();
    mocks.loginCustomer.mockReset();
    mocks.loginCustomer.mockResolvedValue({
      token: 'customer-token',
      customer: { name: 'Ada Lovelace', globalId: 'customer-1' },
      expiresIn: 3600,
    });
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();
    render(<RegisterPage />);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the missing business context and disables the fieldset', () => {
    cleanup();
    mocks.businessSlug = null;

    render(<RegisterPage />);

    expect(screen.getByText('Falta el contexto del comercio.')).toBeTruthy();
    const fieldset = screen.getByRole('group', { name: /Datos para tu cuenta/ }) as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);
  });

  it('rejects an empty name without making a network request', async () => {
    setRequiredFields('', '+56 9 1234 5678');

    await submitForm();

    expect(await screen.findByText('Ingresá tu nombre completo.')).toBeTruthy();
    expect(document.activeElement).toBe(getInput(/^Nombre completo/));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(0);
  });

  it('rejects an empty phone without making a network request', async () => {
    setRequiredFields('Ada Lovelace', '   ');

    await submitForm();

    expect(await screen.findByText('Ingresá tu teléfono.')).toBeTruthy();
    expect(document.activeElement).toBe(getInput(/^Teléfono/));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(0);
  });

  it('creates a customer with one PUT request and excludes consent data', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200));
    setRequiredFields('Ada Lovelace', '+56 9 1234 5678');

    await submitForm();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${gatewayUrl}/v1/customers`);
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body as string)).toEqual({
      fullName: 'Ada Lovelace',
      phone: '+56 9 1234 5678',
      businessSlug: 'barber',
    });

    const payload = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('consents');
    expect(payload).not.toHaveProperty('serviceWhatsapp');
    expect(payload).not.toHaveProperty('promotions');
    expect(payload).not.toHaveProperty('nearbyNotifications');
    expect(mocks.loginCustomer).toHaveBeenCalledWith('+56 9 1234 5678', 'barber');
    expect(mocks.push).toHaveBeenCalledWith('/profile');
  });

  it('normalizes surrounding whitespace in the request payload', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200));
    setRequiredFields('  Ada Lovelace  ', '  +56 9 1234 5678  ');
    fireEvent.click(screen.getByText('¿Querés completar algo más ahora?'));
    fireEvent.change(getInput(/^Email/), { target: { value: '  ada@example.com  ' } });

    await submitForm();

    const [, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({
      fullName: 'Ada Lovelace',
      phone: '+56 9 1234 5678',
      businessSlug: 'barber',
      email: 'ada@example.com',
    });
    expect(mocks.loginCustomer).toHaveBeenCalledWith('+56 9 1234 5678', 'barber');
  });

  it('surfaces a 4xx server message without reporting a local gateway outage', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(409, { error: { message: 'Failed to fetch this customer record.' } }),
    );
    setRequiredFields('Ada Lovelace', '+56 9 1234 5678');

    await submitForm();

    expect(await screen.findByText('Failed to fetch this customer record.')).toBeTruthy();
    expect(screen.queryByText(/No pudimos conectar con el gateway local/)).toBeNull();
    expect(mocks.loginCustomer).not.toHaveBeenCalled();
  });

  it('shows the gateway connectivity message after a network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    setRequiredFields('Ada Lovelace', '+56 9 1234 5678');

    await submitForm();

    expect(
      await screen.findByText(
        'No pudimos conectar con el gateway local. Revisá que esté disponible e intentá de nuevo.',
      ),
    ).toBeTruthy();
    expect(mocks.loginCustomer).not.toHaveBeenCalled();
  });

  it('shows partial success and locks the form when login fails after customer creation', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200));
    mocks.loginCustomer.mockRejectedValue(new Error('Login service unavailable'));
    setRequiredFields('Ada Lovelace', '+56 9 1234 5678');

    await submitForm();

    expect(await screen.findByText('Tu cuenta fue creada.')).toBeTruthy();
    const loginLink = screen.getByRole('link', { name: 'Ir a ingresar' });
    expect(loginLink.getAttribute('href')).toBe('/login?biz=barber');
    const submitButton = screen.getByRole('button', { name: 'Cuenta creada' }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
