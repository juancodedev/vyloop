// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The `?signup=true` the page reads, set per render and cleared between tests. */
declare global {
  var __search: string;
}

const mocks = vi.hoisted(() => ({ signupBusiness: vi.fn(), login: vi.fn(), push: vi.fn() }));

vi.mock('@/lib/api', () => ({
  signupBusiness: mocks.signupBusiness,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(globalThis.__search ?? ''),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ login: mocks.login, isLoading: false }),
}));

import LoginPage from './page';

import { registrationPath } from '@/lib/merchant-qr';

function renderPage(signup: boolean) {
  globalThis.__search = signup ? 'signup=true' : '';
  return render(<LoginPage />);
}

beforeEach(() => {
  mocks.signupBusiness.mockReset();
  mocks.login.mockReset();
  mocks.push.mockReset();
  mocks.login.mockResolvedValue(undefined);
  mocks.signupBusiness.mockResolvedValue({
    businessId: 'biz-1',
    name: 'Café Nuevo',
    slug: 'cafe-nuevo',
    adminUserId: 'u-1',
    loyaltyProgramId: 'p-1',
    firstTierId: 't-1',
  });
  globalThis.__search = '';
});

describe('business signup', () => {
  /**
   * The landing page's "Comenzar gratis" button points at `/login?signup=true`, and
   * before this the page ignored the parameter entirely: it rendered the operator
   * login, which posts to `/v1/auth/token` and answers `401 Invalid email or
   * password` for a business that does not exist yet. A merchant who finds the
   * product alone has no `curl`, and an endpoint that only exists as an endpoint is
   * not self-service.
   */
  it('renders the signup form when signup=true, not the login form', () => {
    renderPage(true);

    expect(screen.getByLabelText(/nombre del comercio/i)).toBeTruthy();
    expect(screen.queryByLabelText(/correo electrónico/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /crear comercio/i })).toBeTruthy();
  });

  it('renders the login form otherwise, so a stray param cannot swap the two', () => {
    renderPage(false);

    expect(screen.queryByLabelText(/nombre del comercio/i)).toBeNull();
    expect(screen.getByRole('button', { name: /iniciar sesión/i })).toBeTruthy();
  });

  /**
   * The slug is the customer URL and the QR the merchant prints. A merchant who
   * cannot read it has onboarded nobody, so it is put on the screen.
   */
  it('shows the slug it created, because that is the customer link', async () => {
    renderPage(true);

    fireEvent.change(screen.getByLabelText(/nombre del comercio/i), {
      target: { value: 'Café Nuevo' },
    });
    fireEvent.change(screen.getByLabelText(/correo electrónico/i), {
      target: { value: 'hola@cafenuevo.com' },
    });
    fireEvent.change(screen.getByLabelText(/contraseña/i), {
      target: { value: 'unaClaveLarga' },
    });
    fireEvent.click(screen.getByRole('button', { name: /crear comercio/i }));

    await waitFor(() => expect(screen.getByText(/Comercio creado/i)).toBeTruthy());

    expect(mocks.signupBusiness).toHaveBeenCalledWith({
      name: 'Café Nuevo',
      email: 'hola@cafenuevo.com',
      password: 'unaClaveLarga',
      fullName: '',
    });
    // The slug travels with the message, not only inside the API call nobody sees.
    expect(screen.getByDisplayValue(registrationPath('cafe-nuevo'))).toBeTruthy();
  });

  /**
   * The account exists; a session is a separate request. Sending them back to the
   * login form to type the password a second time loses the signup to a blip.
   */
  it('signs the new operator in and lands them on the dashboard', async () => {
    renderPage(true);

    fireEvent.change(screen.getByLabelText(/nombre del comercio/i), {
      target: { value: 'Café Nuevo' },
    });
    fireEvent.change(screen.getByLabelText(/correo electrónico/i), {
      target: { value: 'hola@cafenuevo.com' },
    });
    fireEvent.change(screen.getByLabelText(/contraseña/i), {
      target: { value: 'unaClaveLarga' },
    });
    fireEvent.click(screen.getByRole('button', { name: /crear comercio/i }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/dashboard'));
    expect(mocks.login).toHaveBeenCalledWith('hola@cafenuevo.com', 'unaClaveLarga');
  });

  /**
   * `BUSINESS_SLUG_TAKEN` names the slug it collided on. That string is invisible
   * otherwise, so a generic "try again" leaves the merchant guessing at a name they
   * cannot see — and the server built that sentence for exactly this reason.
   */
  it('shows the server sentence when the slug is taken', async () => {
    mocks.signupBusiness.mockRejectedValue(
      new Error('A business with the slug "cafe-nuevo" already exists.'),
    );

    renderPage(true);

    fireEvent.change(screen.getByLabelText(/nombre del comercio/i), {
      target: { value: 'Café Nuevo' },
    });
    fireEvent.change(screen.getByLabelText(/correo electrónico/i), {
      target: { value: 'hola@cafenuevo.com' },
    });
    fireEvent.change(screen.getByLabelText(/contraseña/i), {
      target: { value: 'unaClaveLarga' },
    });
    fireEvent.click(screen.getByRole('button', { name: /crear comercio/i }));

    await waitFor(() =>
      expect(screen.getByText(/already exists/i)).toBeTruthy(),
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
describe('the login form', () => {
  it('links a first-time merchant to the signup form', () => {
    renderPage(false);

    expect(screen.getByRole('link', { name: 'Crea tu comercio' }).getAttribute('href')).toBe(
      '/login?signup=true',
    );
  });

  // The owner's own test account, kept on screen on purpose for now.
  it('keeps the test account hint visible', () => {
    renderPage(false);

    expect(screen.getByText('Demo: demo@cafecentral.com / demo123')).toBeTruthy();
  });
});
