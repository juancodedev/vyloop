import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayUrl } from '../lib/gateway-url';

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
    expect(url).toBe(`${gatewayUrl()}/v1/customers`);
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

// ─── The email field ──────────────────────────────────────────────────
//
// It always existed and was always optional. What was wrong was that it was
// inside a collapsed `<details>` under "¿Querés completar algo más ahora?",
// with "Solo si te resulta cómodo" as its only justification — so a business
// asking for a way to reach its customer had to know to go looking for it.
//
// It is a visible field now, in the main group, and it stays optional: nothing
// verifies it, and nothing verifies the phone either.

describe('the email field', () => {
  // A sibling `describe`, so none of the outer suite's setup applies here — the
  // `fetch` stub included. Restated rather than extracted, because this block is
  // about one field and a shared helper for two fields is the wrong shape.
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
    vi.mocked(fetch).mockResolvedValue(createResponse(201));
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is a visible field, not something behind a disclosure', async () => {
    // The defect. `getByLabelText` does not care whether a field is collapsed, so
    // this would have passed before the change too — which is why the next
    // assertion is the one that carries the weight.
    render(<RegisterPage />);

    expect(screen.getByLabelText(/^Email/)).toBeTruthy();

    const field = screen.getByLabelText(/^Email/);
    const insideDisclosure = field.closest('details');

    expect(insideDisclosure).toBeNull();
  });

  it('is reachable without expanding anything', async () => {
    // Stated behaviourally on purpose: a screen reader and a keyboard user both
    // hit the collapsed `<details>` as a closed control, so "it is in the DOM" was
    // never the same claim as "the customer can get to it".
    render(<RegisterPage />);

    const email = screen.getByLabelText(/^Email/);
    const summaries = document.querySelectorAll('details > summary');

    for (const summary of summaries) {
      expect(summary.contains(email)).toBe(false);
    }

    expect(email.hasAttribute('disabled')).toBe(false);
  });

  it('is optional, because nothing verifies it', () => {
    render(<RegisterPage />);

    // Cast rather than `getByLabelText<HTMLInputElement>`: the helper above
    // already narrows, and a second narrowing in one expression reads like the
    // generic does nothing.
    expect((screen.getByLabelText(/^Email/) as HTMLInputElement).required).toBe(false);
  });

  it('says what it is for, and does not offer it as a recovery address', () => {
    // The copy matters as much as the field. An email a customer reads as a
    // password-reset address they cannot actually use is worse than no email.
    render(<RegisterPage />);

    const helper = screen.getByText(/negocio te pueda avisar/i);

    expect(helper).toBeTruthy();
    expect(helper.textContent?.toLowerCase()).not.toMatch(/recuper|restable|contrase|olvid/);
  });

  it('sends the email when it is filled in', async () => {
    render(<RegisterPage />);
    setRequiredFields('Ada Lovelace', '+56 9 1234 5678');
    fireEvent.change(getInput(/^Email/), { target: { value: 'ada@example.com' } });

    await submitForm();

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body.email).toBe('ada@example.com');
  });

  it('omits it entirely when it is left blank, rather than sending an empty string', async () => {
    // `PUT /v1/customers` writes `body.email` whenever the key is present, so an
    // empty string would overwrite an email the customer gave on an earlier
    // registration for the same phone. The key must be absent.
    render(<RegisterPage />);
    setRequiredFields('Ada Lovelace', '+56 9 1234 5678');

    await submitForm();

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect('email' in body).toBe(false);
    expect(body).toMatchObject({ fullName: 'Ada Lovelace', businessSlug: 'barber' });
  });

  it('trims the email before sending it', async () => {
    render(<RegisterPage />);
    setRequiredFields('Ada Lovelace', '+56 9 1234 5678');
    fireEvent.change(getInput(/^Email/), { target: { value: '  ada@example.com  ' } });

    await submitForm();

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));

    expect(body.email).toBe('ada@example.com');
  });
});
