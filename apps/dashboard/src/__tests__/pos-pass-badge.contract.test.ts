// @vitest-environment node

/**
 * The POS renders what `lib/pass-state.ts` decided, and nothing else.
 *
 * `pass-state.contract.test.ts` proves the copy is honest. This proves the
 * cashier actually sees it, because those are different failures: a correct
 * module nobody renders is a screen that still says nothing, and a page that
 * renders its own wording is a screen that is wrong again the next time someone
 * edits the JSX.
 *
 * ## Why structure, not rendering
 *
 * `vitest.config.ts` sets no `environment`, so the dashboard runs in `node`: no
 * jsdom, no testing-library, no React. `navigation.contract.test.ts` established
 * this pattern -- read the component, assert the thing that cannot drift
 * silently.
 *
 * These assertions are deliberately narrow about *how* the page imports. An
 * earlier version only checked that the name `presentPass` appeared somewhere,
 * which a local `const presentPass = () => ({ label: 'Pase', ... })` satisfies
 * -- the exact regression this file exists to catch, verified by removing the
 * import and watching the suite stay green.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ABSENCE_CLAIMS, presentPass } from '../lib/pass-state';

const posSource = readFileSync(
  new URL('../app/dashboard/loyalty/pos/page.tsx', import.meta.url).pathname,
  'utf8',
);

describe('the POS renders the copy module', () => {
  it('imports the presentation from the module', () => {
    expect(posSource).toMatch(
      /import\s*\{[^}]*\bpresentPass\b[^}]*\}\s*from\s*'@\/lib\/pass-state'/,
    );
  });

  it('does not define a presentation of its own', () => {
    // A local definition, or an inline presentation object, both mean the page
    // has stopped asking the module what to say.
    expect(posSource).not.toMatch(/(const|function)\s+presentPass\b/);
    expect(posSource).not.toMatch(/\blabel:\s/);
    expect(posSource).not.toMatch(/\bdetail:\s/);
    expect(posSource).not.toMatch(/\btone:\s/);
  });

  it('renders the label and the detail, not just the badge', () => {
    // Both halves: a page showing only "Pase sin comprobar" leaves the cashier
    // with a mystery and nothing to do about it.
    expect(posSource).toContain('pass.label');
    expect(posSource).toContain('pass.detail');
  });

  it('hardcodes no absence sentence of its own', () => {
    for (const claim of ABSENCE_CLAIMS) {
      expect(
        posSource.toLowerCase().includes(claim),
        `the POS page contains the absence phrase "${claim}" outside the copy module`,
      ).toBe(false);
    }
  });

  it('does not decide the pass state from a boolean of its own', () => {
    // `pass.state === 'issued' ? ok : 'no tiene'` is the collapse the module
    // exists to prevent, in the shape it would actually take.
    expect(posSource).not.toMatch(/hasPass/);
  });

  it('shows the badge for a QR scan only when there is pass data', () => {
    // `getCustomerByGlobalId` does not report pass state, so the QR path stores
    // `pass: null` and renders no badge. A badge nobody asked Google for is how
    // the screen starts lying, so the guard is that the field exists at all.
    expect(posSource).toContain('customer.pass');
  });
});

describe('the search box identifies rather than lists', () => {
  it('uses the shared resolver', () => {
    expect(posSource).toMatch(/from '@\/lib\/lookup-identifier'/);
    expect(posSource).toContain('resolveLookupTarget');
  });

  it('sends the identifier and the value the resolver returned', () => {
    // Reading the raw input and picking its own parameter could disagree with
    // the resolver, and the disagreement is invisible until a lookup misses.
    expect(posSource).toContain('target.identifier');
    expect(posSource).toContain('target.value');
  });

  it('tells a missing customer from a broken system', () => {
    expect(posSource).toContain('CUSTOMER_NOT_REGISTERED');
    expect(posSource).toContain('ApiError');
    // The two other outcomes get their own branch rather than one catch-all.
    expect(posSource).toContain('409');
  });

  it('offers a route onward from a miss', () => {
    // The dashboard has no customer-registration screen -- the only one that
    // exists is the customer's own app. So the miss points at the list, and the
    // gap is recorded rather than papered over with a dead link.
    expect(posSource).toContain('/dashboard/customers');
  });
});

describe('what an unverified state looks like on screen', () => {
  it('is styled as our pending work, not as a customer failure', () => {
    // The badge carries `data-tone` and `data-unverified`, so the stylesheet can
    // treat "we have not checked" differently from "Google says it is not there"
    // even though both are neutral to a casual reader.
    expect(posSource).toContain('data-tone');
    expect(posSource).toContain('data-unverified');
  });

  it('has copy that survives being rendered', () => {
    // Guards the module against a future edit that reintroduces an absence
    // claim for an unverified state, at the point where it would matter.
    for (const state of ['not_issued', null] as const) {
      const shown = presentPass(state);
      const sentence = `${shown.label} ${shown.detail}`.toLowerCase();
      for (const claim of ABSENCE_CLAIMS) {
        expect(sentence.includes(claim)).toBe(false);
      }
    }
  });
});
