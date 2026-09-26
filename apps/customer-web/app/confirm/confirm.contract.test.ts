// @vitest-environment node

/**
 * What cannot be observed from the DOM.
 *
 * The behaviour suite beside this one asserts everything a person can see or
 * do. What is left is absences and byte strings: an inline style that renders
 * exactly like a token, a claim in a paragraph, a link that should not exist.
 * Those have no rendered trace once they are gone, so they are pinned here.
 *
 * It also records the reachability question, because "this route is dead code"
 * is a claim that needs evidence rather than an impression.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const displayName = readFileSync(new URL('../lib/display-name.ts', import.meta.url), 'utf8');
const appDir = new URL('../', import.meta.url).pathname;

/** Every `.tsx` under `app/`, so the reachability check follows new pages. */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (!entry.includes('.')) return tsxFiles(path);
    if (entry.includes('.test.')) return [];

    return entry.endsWith('.tsx') ? [path] : [];
  });
}

describe('the /confirm route, as a source contract', () => {
  it('carries no inline style, so every value on the page comes from a token', () => {
    // The page had `style={{ fontSize: 48, marginBottom: 16 }}`,
    // `style={{ display: 'block' }}` and `style={{ textAlign: 'center' }}`. All
    // three render identically to the token rules and all three are unreachable
    // from the design system.
    expect(page).not.toMatch(/style=\{/);
    expect(page).not.toMatch(/style:\s*\{/);
  });

  it('carries no emoji, which was the "success icon" before', () => {
    // A check mark is a glyph, not an icon: it has no accessible name, it is
    // read out as punctuation, and it renders differently on every platform.
    expect(page).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('makes no commercial claim about the programme', () => {
    // The one copy change Stage 6 is allowed here, because the old sentence
    // promised an outcome ("you can start accumulating points with your
    // purchases") that nothing in the system guarantees.
    expect(page).not.toMatch(/acumular puntos/i);
    expect(page).not.toMatch(/con tus compras/i);
    expect(page).not.toMatch(/en este local/i);
  });

  it('does not treat the name as trusted, and never renders it as markup', () => {
    // The rule lives outside the route module: a Next.js page may only export
    // its default and its route config, and the rule is worth testing alone.
    expect(page).toMatch(/import \{ displayNameFrom \} from '..\/lib\/display-name';/);
    expect(page).not.toMatch(/export function displayNameFrom/);
    expect(displayName).toMatch(
      /export function displayNameFrom\(raw: string \| null\): string \{/,
    );
    expect(displayName).toMatch(/export const MAX_NAME_LENGTH = 40;/);
    expect(displayName).toMatch(/if \(!raw\) return FALLBACK_NAME;/);
    // A plain text child, never `dangerouslySetInnerHTML`.
    expect(page).not.toMatch(/dangerouslySetInnerHTML/);
    expect(page).not.toMatch(/<img/);
  });

  it('uses the shared shell and the shared loading state', () => {
    expect(page).toMatch(/<ClubShell/);
    expect(page).toMatch(/<ClubLoading label="Cargando tu confirmación…"\s*\/>/);
    // The legacy `.loading` class went with the last page that used it.
    expect(page).not.toMatch(/className="loading"/);
    // The success indicator is the one shared with the redeem confirmation.
    expect(page).toMatch(/className="confirm-icon" aria-hidden="true"/);
  });
});

describe('the /confirm route is unreachable from inside the app', () => {
  const pages = tsxFiles(appDir);

  it('has no incoming link from any other page or component', () => {
    // Evidence for the reachability question the user asked to be reported, and
    // a standing check: the day somebody does link to this route, the suite says
    // so instead of the route quietly becoming load-bearing.
    const sources = pages
      .filter((file) => !file.endsWith('confirm/page.tsx'))
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }));

    const linking = sources
      .filter(({ source }) => /['"`]\/confirm(\?|['"`])/.test(source))
      .map(({ file }) => file.slice(appDir.length));

    expect(linking).toEqual([]);
  });

  it('is not the destination of any redirect or of the root page', () => {
    // Nothing in the app sends a customer here, and the registration flow that
    // would have ended here was disabled in Stage 2, so the route is a
    // destination nobody writes any more.
    const redirects = pages
      .filter((file) => !file.endsWith('confirm/page.tsx'))
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /router\.(push|replace)\(\s*['"`]\/confirm/.test(source))
      .map(({ file }) => file.slice(appDir.length));

    expect(redirects).toEqual([]);
  });
});
