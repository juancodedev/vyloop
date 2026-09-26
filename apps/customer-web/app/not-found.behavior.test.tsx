/**
 * The 404.
 *
 * This page had a class and no rule, which the CSS contract was forced to
 * exempt by name — its own comment called the class "a hook waiting for a design
 * pass". Stage 6 is that pass, so what is asserted here is that the page is now
 * an ordinary card on an ordinary page: a landmark, one heading, one action
 * that clears the 44px target through the shared button primitive.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import NotFound from './not-found';

afterEach(cleanup);

function renderNotFound() {
  render(<NotFound />);
}

describe('the 404 page', () => {
  it('is a page with a main landmark, like every other route', () => {
    renderNotFound();

    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('has exactly one heading, and it is the h1', () => {
    renderNotFound();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Página no encontrada');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('says what happened and offers one way out', () => {
    renderNotFound();

    expect(screen.getByText('Lo sentimos, la página que buscas no existe.')).toBeTruthy();

    const links = screen.getAllByRole('link');

    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/');
    expect(links[0].textContent).toBe('Volver al inicio');
  });

  it('uses the button primitive, so the action inherits the target and the focus ring', () => {
    // Before Stage 6 this was a bare inline link: no minimum height, no focus
    // treatment of its own, and a 44px target nobody had measured.
    renderNotFound();

    const action = screen.getByRole('link', { name: 'Volver al inicio' });

    expect(action.className).toContain('btn');
    expect(action.className).toContain('btn--primary');
    expect(action.className).toContain('not-found__action');
  });

  it('carries no inline style, and no style attribute at all', () => {
    renderNotFound();

    expect(document.querySelectorAll('[style]')).toHaveLength(0);
  });
});
