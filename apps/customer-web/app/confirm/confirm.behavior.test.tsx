/**
 * The registration confirmation.
 *
 * `/confirm` is the one route the design plan never described. It predates the
 * club-barrio redesign, it is not linked from anywhere inside the app, and
 * before Stage 6 it rendered a query parameter straight into a heading, a
 * 48px emoji with no accessible name, three inline styles with magic numbers,
 * and a promise about the loyalty programme that nothing in the system
 * establishes.
 *
 * This suite pins the hardened behaviour. Every case below is something a
 * stranger can do to this URL, so they are all things the page has to survive.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { displayNameFrom } from '../lib/display-name';

import ConfirmPage from './page';

const mocks = vi.hoisted(() => ({
  search: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => mocks.search,
}));

function visit(query: string) {
  mocks.search = new URLSearchParams(query);
  render(<ConfirmPage />);
}

describe('the greeting', () => {
  beforeEach(() => {
    mocks.search = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
  });

  it('greets a name it was given, verbatim', () => {
    visit('name=Ana');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('¡Gracias, Ana!');
  });

  it('falls back when there is no name at all', () => {
    // The normal case for a visitor who followed a link from an email or a
    // printed QR code and arrived without one. Not an error state.
    visit('');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('¡Gracias, Cliente!');
  });

  it('falls back when the name is only whitespace or control characters', () => {
    visit(`name=${encodeURIComponent('   \t\n  ')}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('¡Gracias, Cliente!');

    cleanup();
    visit(`name=${encodeURIComponent('')}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('¡Gracias, Cliente!');
  });

  it('collapses runs of whitespace, so a padded parameter cannot open a gap', () => {
    visit(`name=${encodeURIComponent('  Ana   María  ')}`);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('¡Gracias, Ana María!');
  });

  it('shortens an overlong name and says that it did', () => {
    const long = 'Bartholomew Wolfeschlegelsteinhausen the Third';
    visit(`name=${encodeURIComponent(long)}`);

    const heading = screen.getByRole('heading', { level: 1 }).textContent ?? '';

    // The ellipsis is what tells a reader the greeting is a shortened name
    // rather than the whole one.
    expect(heading).toContain('…');

    // Derived from the input rather than typed out, so a change to the limit
    // shows up here as a failing expectation and not as a silent pass.
    const expected = long.slice(0, 40).trim();

    expect(expected.length).toBeLessThan(long.length);
    expect(heading).toBe(`¡Gracias, ${expected}…!`);
    // And the page is not carrying the rest of the parameter anywhere.
    expect(document.body.textContent).not.toContain('the Third');
  });

  it('renders a name carrying markup as text, never as elements', () => {
    visit(`name=${encodeURIComponent('<img src=x onerror="alert(1)">')}`);

    // React escapes the value, so this is a string in a heading. Asserted by
    // structure rather than by the absence of a crash: the heading must contain
    // the literal characters, and no element may have been created from them.
    const heading = screen.getByRole('heading', { level: 1 });

    expect(heading.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(heading.querySelector('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('cannot be turned into a control by the parameter', () => {
    visit(`name=${encodeURIComponent('<button> hacked</button>')}`);

    const heading = screen.getByRole('heading', { level: 1 });

    expect(heading.textContent).toContain('<button> hacked</button>');
    expect(screen.queryByRole('button', { name: 'hacked' })).toBeNull();
  });

  it('exposes the same rule as a pure function, so the edges are testable directly', () => {
    expect(displayNameFrom(null)).toBe('Cliente');
    expect(displayNameFrom('')).toBe('Cliente');
    expect(displayNameFrom('   ')).toBe('Cliente');
    expect(displayNameFrom('Ana')).toBe('Ana');
    expect(displayNameFrom(' Ana  María ')).toBe('Ana María');
    // Exactly at the limit: kept whole, and NOT marked as shortened.
    expect(displayNameFrom('a'.repeat(40))).toBe('a'.repeat(40));
    expect(displayNameFrom('a'.repeat(41))).toBe(`${'a'.repeat(40)}…`);
    // A cut that lands exactly on the space at index 39 must not keep that space
    // in front of the ellipsis.
    const cutOnSpace = `${'a'.repeat(39)} ${'b'.repeat(5)}`;
    expect(displayNameFrom(cutOnSpace)).toBe(`${'a'.repeat(39)}…`);
    // An accented name is left exactly as the browser decoded it.
    expect(displayNameFrom('José Muñoz')).toBe('José Muñoz');
  });
});

describe('the success indicator', () => {
  afterEach(() => {
    cleanup();
  });

  it('is decorative, and the outcome is carried by the text beside it', () => {
    visit('name=Ana');

    const icon = document.querySelector('.confirm-icon');

    expect(icon).toBeTruthy();
    // Hidden from the accessibility tree: a screen reader is told what happened
    // by the heading and the sentence, not by the name of a glyph.
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    // And the whole page announces no image and no graphic at all.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('sits in a region the heading names', () => {
    visit('name=Ana');

    const region = screen.getByRole('region', { name: /Gracias/ });

    expect(within(region).getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('renders on a page with a main landmark, like every other route', () => {
    // Before Stage 6 this was a bare `<div className="page">`, the only route
    // in the app with no landmark.
    visit('name=Ana');

    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('makes no claim about what the programme will do for the customer', () => {
    visit('name=Ana');

    const text = document.body.textContent ?? '';

    // The old copy promised they could "start accumulating points with their
    // purchases at this store". Nothing on this route, or anywhere else in the
    // app, establishes that, and the rest of the customer web is careful not to.
    expect(text).not.toMatch(/acumular puntos/i);
    expect(text).not.toMatch(/con tus compras/i);
    expect(text).not.toMatch(/puntos/i);
    // What it says instead is a thing the customer can do next.
    expect(text).toContain('Ingresá con tu teléfono para ver tu pase.');
  });

  it('offers exactly one action, back to the entry page', () => {
    visit('name=Ana');

    const links = screen.getAllByRole('link');

    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/');
    expect(links[0].textContent).toBe('Volver al inicio');
    // The button primitive, so it inherits the 48px target and the focus ring.
    expect(links[0].className).toContain('btn');
    expect(links[0].className).toContain('btn--primary');
  });

  it('uses the shared shell and no inline style of its own', () => {
    visit('name=Ana');

    const main = screen.getByRole('main');

    expect(main.className).toContain('club-shell');
    expect(main.querySelectorAll('[style]')).toHaveLength(0);
  });
});
