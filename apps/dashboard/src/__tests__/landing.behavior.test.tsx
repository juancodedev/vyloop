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

  it('answers the iPhone question without promising an Apple Wallet pass', () => {
    render(<LandingPage />);

    expect(screen.getByText('¿Y si mi cliente tiene iPhone?')).toBeTruthy();
    expect(screen.queryByText(/Apple Wallet/)).toBeNull();
  });

  it('compares the paper card with vyloop, row by row', () => {
    render(<LandingPage />);

    const section = screen.getByRole('region', { name: 'La tarjeta de papel contra vyloop' });
    expect(section.querySelectorAll('[data-row]').length).toBeGreaterThanOrEqual(4);
  });

  it('shows the three plans in CLP, with Pro as the recommended one', () => {
    render(<LandingPage />);

    const section = screen.getByRole('region', { name: 'Precios' });
    expect(section.textContent).toContain('$19.990');
    expect(section.textContent).toContain('$34.990');
    expect(section.textContent).toContain('$39.990');

    const recommended = screen.getByText('Recomendado').closest('article');
    expect(recommended?.querySelector('h3')?.textContent).toBe('Pro');
    expect(screen.getByRole('link', { name: 'Precios' }).getAttribute('href')).toBe('#precios');
  });

  it('links the FAQ from the header', () => {
    render(<LandingPage />);

    expect(screen.getByRole('link', { name: 'Preguntas' }).getAttribute('href')).toBe('#preguntas');
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
