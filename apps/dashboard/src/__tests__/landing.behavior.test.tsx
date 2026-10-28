// @vitest-environment jsdom

/**
 * The landing page as a merchant reads it.
 *
 * `navigation.contract.test.ts` lets every `#anchor` through, because a hash is
 * not a route. That is how "Precios" pointed at a `#pricing` section and "Ver demo
 * en vivo" at a `#demo` that never existed. This renders the page and follows
 * each in-page link to its target.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import LandingPage from '../app/page';

afterEach(cleanup);

describe('the landing page', () => {
  it('points every in-page link at a section that exists', () => {
    const { container } = render(<LandingPage />);

    const anchors = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      const id = anchor.getAttribute('href')!.slice(1);
      expect(
        container.querySelector(`[id="${id}"]`),
        `#${id} from "${anchor.textContent}"`,
      ).not.toBeNull();
    }
  });

  it('claims no figure the product cannot back', () => {
    render(<LandingPage />);

    expect(screen.queryByText(/\+500/)).toBeNull();
    expect(screen.queryByText(/negocios en Latinoamérica/i)).toBeNull();
  });

  it('says what the product does: Google Wallet and points by purchase amount', () => {
    render(<LandingPage />);

    expect(screen.getAllByText(/Google Wallet/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/según lo que compra/).length).toBeGreaterThan(0);
  });

  it('sends both sign-up buttons to the sign-up form and the login link to the login', () => {
    render(<LandingPage />);

    for (const link of screen.getAllByRole('link', { name: 'Crear mi comercio' })) {
      expect(link.getAttribute('href')).toBe('/login?signup=true');
    }
    expect(screen.getAllByRole('link', { name: 'Iniciar sesión' })[0]!.getAttribute('href')).toBe(
      '/login',
    );
  });
});
