import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomePage from './page';

const mocks = vi.hoisted(() => ({
  businessSlug: null as string | null,
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
  useAuth: () => ({ customer: null, isLoading: false }),
}));

function renderEntry() {
  render(<HomePage />);
}

describe('entry actions', () => {
  beforeEach(() => {
    mocks.businessSlug = null;
    mocks.replace.mockReset();
  });

  afterEach(() => {
    cleanup();
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

  it('keeps the business context on the login link too', () => {
    mocks.businessSlug = 'cafe-central';
    renderEntry();

    expect(screen.getByRole('link', { name: /Ingresar/ }).getAttribute('href')).toBe(
      '/login?biz=cafe-central',
    );
  });

  it('explains the QR flow in text, with the icon marked decorative', () => {
    renderEntry();

    expect(screen.getByText('Escaneá el QR')).toBeTruthy();
    expect(screen.getByText('Creá tu cuenta')).toBeTruthy();
    expect(screen.getByText('Mostrá tu código')).toBeTruthy();

    // The stamp pairs a lucide icon with the words "En el mostrador". The icon
    // is decoration and must stay out of the accessibility tree, otherwise a
    // screen reader announces an unlabelled graphic before the text that
    // actually carries the meaning.
    const stamp = document.querySelector('.club-qr-explainer__stamp');
    expect(stamp).toBeTruthy();
    expect(stamp?.getAttribute('aria-hidden')).toBe('true');
  });
});
