// @vitest-environment node

/**
 * The public privacy policy at `/privacy`.
 *
 * Registration collects a name and a phone number, and optionally an email and
 * a birth date; Google's publishing review reads the business pages around the
 * pass. The policy has to exist, be served at the clean URL the same way
 * `/program` is (see `program-route.contract.test.ts`), render without
 * scripting, and say who is responsible, what is collected, who receives it and
 * how to delete it.
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const publicDir = new URL('../public/', import.meta.url).pathname;
const page = existsSync(`${publicDir}privacy.html`)
  ? readFileSync(`${publicDir}privacy.html`, 'utf8')
  : '';

const visible = page
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

describe('public privacy policy', () => {
  it('ships in the form the assets layer serves at /privacy', () => {
    expect(existsSync(`${publicDir}privacy.html`)).toBe(true);
    expect(existsSync(`${publicDir}privacy/index.html`)).toBe(false);
  });

  it('names the party responsible for the data and how to reach it', () => {
    expect(visible).toMatch(/Lawen Tech Solutions SpA/);
    expect(visible).toMatch(/77\.936\.149-7/);
    expect(page).toMatch(/href="mailto:cl\.jmunoz@gmail\.com"/);
  });

  it('lists the data the registration form collects', () => {
    for (const field of [/teléfono/i, /nombre/i, /correo/i, /fecha de nacimiento/i]) {
      expect(visible).toMatch(field);
    }
  });

  it('says who receives the data, including Google for a saved pass', () => {
    expect(visible).toMatch(/Google Wallet/);
    expect(visible).toMatch(/no vendemos/i);
  });

  it('explains how to delete the account', () => {
    expect(visible).toMatch(/Eliminar mi cuenta/);
  });

  it('offers both languages and renders without scripting', () => {
    expect(page).toMatch(/data-lang="en"/);
    expect(page).toMatch(/data-lang="es"/);
    expect(page).toMatch(/<html[^>]*\sdata-lang="es"/);
    expect(page).toMatch(/\[data-lang\]:not\(html\)\s*\{\s*display:\s*none/);
  });

  it('renders without external requests', () => {
    const remote = page.match(/(?:src|href)="https?:\/\/[^"]+"/g) ?? [];
    expect(remote).toEqual([]);
  });

  it('links back to the program page', () => {
    expect(page).toMatch(/href="\/program"/);
  });
});
