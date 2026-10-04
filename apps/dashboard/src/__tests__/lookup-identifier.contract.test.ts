// @vitest-environment node

/**
 * One box, three identifiers.
 *
 * The counter search field accepts a phone number, an email or a scanned pass
 * id, and something has to decide which one was typed — that decision picks the
 * query parameter, so getting it wrong is a silent miss: a good number typed
 * correctly still comes back "not registered".
 *
 * `vitest.config.ts` sets no `environment`, so the dashboard runs in `node` and
 * nothing renders. The logic therefore lives in `lib/lookup-identifier.ts`,
 * imported and called here for real, with the POS page read as source to prove
 * it uses this module rather than deciding the identifier on its own.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveLookupTarget } from '../lib/lookup-identifier';

const posSource = readFileSync(
  new URL('../app/dashboard/loyalty/pos/page.tsx', import.meta.url).pathname,
  'utf8',
);

const UUID = 'a0000000-0000-4000-8000-000000000001';

describe('resolveLookupTarget', () => {
  it('reads a phone number as a phone', () => {
    expect(resolveLookupTarget('+56912345678')).toEqual({
      identifier: 'phone',
      value: '+56912345678',
    });
  });

  it('reads an email as an email', () => {
    expect(resolveLookupTarget('ana@test.com')).toEqual({
      identifier: 'email',
      value: 'ana@test.com',
    });
  });

  it('reads a bare uuid as a pass id', () => {
    expect(resolveLookupTarget(UUID)).toEqual({
      identifier: 'globalId',
      value: UUID,
    });
  });

  it('pulls the id out of a pasted pass link, like the scanner does', () => {
    // The POS scanner already accepts `/c/<uuid>`; a cashier pasting the same
    // thing into the box has to land on the same customer.
    expect(resolveLookupTarget(`https://vyloop.app/c/${UUID}`)).toEqual({
      identifier: 'globalId',
      value: UUID,
    });
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveLookupTarget('  +56912345678  ')?.value).toBe('+56912345678');
  });

  it('has nothing to search for on an empty box', () => {
    expect(resolveLookupTarget('')).toBeNull();
    expect(resolveLookupTarget('   ')).toBeNull();
  });

  it('never returns two identifiers at once', () => {
    // The server refuses more than one; returning a pair here would turn the
    // honest refusal into a confusing 400 at the counter.
    for (const input of ['+56912345678', 'ana@test.com', UUID, `x/c/${UUID}`]) {
      const target = resolveLookupTarget(input);
      expect(target === null || typeof target.identifier === 'string').toBe(true);
    }
  });

  it('prefers the pass id over the email when a link contains both', () => {
    // A link can carry an `@` in its host or query. The uuid is unambiguous, so
    // checking it first is what keeps a pasted link from being searched as an
    // email address and missing.
    expect(resolveLookupTarget(`https://ana@vyloop.app/c/${UUID}`)?.identifier).toBe(
      'globalId',
    );
  });

  it('treats a bare `@` as a phone number rather than an email', () => {
    // Falling through to `phone` is the honest miss: the server matches on
    // equality, so a malformed address is a miss either way.
    expect(resolveLookupTarget('@')?.identifier).toBe('phone');
  });
});

describe('the POS uses this module', () => {
  it('imports the resolver instead of branching on the input itself', () => {
    expect(posSource).toMatch(/from '@\/lib\/lookup-identifier'/);
    expect(posSource).toContain('resolveLookupTarget');
  });

  it('sends only the identifier and value the resolver returned', () => {
    // A page that reads the raw input and picks its own param could disagree
    // with the resolver, and the disagreement is invisible until a lookup misses.
    expect(posSource).toContain('target.identifier');
    expect(posSource).toContain('target.value');
  });
});
