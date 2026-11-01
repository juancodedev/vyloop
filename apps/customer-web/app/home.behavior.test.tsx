import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomePage from './page';

const mocks = vi.hoisted(() => ({
  businessSlug: null as string | null,
  isLoading: false,
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () =>
    new URLSearchParams(mocks.businessSlug === null ? [] : [['biz', mocks.businessSlug]]),
}));

// The auth layer is stubbed to the unauthenticated, finished-loading state.
// What matters here is which entry actions the page offers, not the redirect
// that a signed-in visitor would get.
vi.mock('./lib/auth', () => ({
  useAuth: () => ({ customer: null, isLoading: mocks.isLoading }),
}));

function renderEntry() {
  render(<HomePage />);
}

describe('entry actions', () => {
  beforeEach(() => {
    mocks.businessSlug = null;
    mocks.isLoading = false;
    mocks.replace.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('says what the customer gets before the session has loaded', () => {
    // The page used to be a full-screen "Cargando…" until the session check
    // finished, and the prerendered HTML held nothing else.
    mocks.isLoading = true;
    renderEntry();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/local de siempre/);
    expect(document.body.textContent).toMatch(/puntos según el monto de tus compras/);
    expect(document.body.textContent).toMatch(/recompensas/);
    expect(screen.getByRole('list')).toBeTruthy();
    // Only the actions wait, because they depend on the session.
    expect(screen.queryByRole('link', { name: /Ingresar/ })).toBeNull();
  });

  it('always offers login, which works without a business context', () => {
    renderEntry();

    expect(screen.getByRole('link', { name: /Ingresar/ }).getAttribute('href')).toBe('/login');
  });

  it('offers no registration action without a business context', () => {
    // Registration refuses to create a customer without a tenant. Sending a
    // visitor there anyway produced a screen whose only option was to go back
    // to this one, which is a dead end rather than a flow.
    renderEntry();

    expect(screen.queryByRole('link', { name: 'Registrarme' })).toBeNull();
  });

  it('offers registration carrying the business context when one exists', () => {
    mocks.businessSlug = 'cafe-central';
    renderEntry();

    expect(screen.getByRole('link', { name: 'Registrarme' }).getAttribute('href')).toBe(
      '/register?biz=cafe-central',
    );
  });

  it('offers registration for the last business when the link lost it', () => {
    localStorage.setItem('vyloop_business_slug', 'cafe-central');
    renderEntry();

    expect(screen.getByRole('link', { name: 'Registrarme' }).getAttribute('href')).toBe(
      '/register?biz=cafe-central',
    );
  });

  it('keeps the business context on the login link too', () => {
    mocks.businessSlug = 'cafe-central';
    renderEntry();

    expect(screen.getByRole('link', { name: /Ingresar/ }).getAttribute('href')).toBe(
      '/login?biz=cafe-central',
    );
  });

  it('explains the QR flow in text, with the icon marked decorative', () => {
    renderEntry();

    expect(screen.getByText('Escanea el QR')).toBeTruthy();
    expect(screen.getByText('Crea tu cuenta')).toBeTruthy();
    expect(screen.getByText('Muestra tu código')).toBeTruthy();

    // The stamp pairs a lucide icon with the words "En el mostrador". The icon
    // is decoration and must stay out of the accessibility tree, otherwise a
    // screen reader announces an unlabelled graphic before the text that
    // actually carries the meaning.
    const stamp = document.querySelector('.club-qr-explainer__stamp');
    expect(stamp).toBeTruthy();
    expect(stamp?.getAttribute('aria-hidden')).toBe('true');
  });
});
