// @vitest-environment node

/**
 * The POS must not tell a merchant that a customer has no pass when we simply
 * never checked.
 *
 * ## The two states that look alike
 *
 * `packages/db/src/schema.ts` documents the vocabulary, and three other places
 * agree with it:
 *
 * - `not_issued` — "a save link was issued and no Google object has been
 *   observed". `workers/wallet/src/routes.ts` puts it plainly: "`not_issued`
 *   means we have never checked".
 * - `not_saved` — "Google was asked and has no object".
 *   `workers/wallet/src/callbacks.ts` calls it "the most definite answer this
 *   system can ever receive about a pass".
 *
 * So `not_issued` is a gap in OUR knowledge and `not_saved` is a fact about the
 * customer. Rendering both as "no tiene tarjeta" is the same sentence for a
 * question we did not answer, and it is the sentence that makes a merchant stop
 * trusting the screen.
 *
 * A third state is not a pass state at all: `null`, meaning no row exists, so no
 * save link was ever issued. That is a different fact again and it gets its own
 * copy rather than borrowing one of the other two.
 *
 * ## Why the copy is a module and these tests call it
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs
 * in `node`: no jsdom, no testing-library, no React rendering. Wording left
 * inside a component would therefore be untestable wording, so it lives in
 * `lib/pass-state.ts` and is imported and called for real here.
 * `pos-pass-badge.contract.test.ts` covers the other half — that the POS page
 * actually renders this copy instead of writing its own.
 */

import { describe, expect, it } from 'vitest';

import {
  ABSENCE_CLAIMS,
  claimsAbsence,
  presentPass,
  type PassState,
} from '../lib/pass-state';

// ─── The states the database can hold ──────────────────────────────────

const ALL_STATES: PassState[] = [
  'not_issued',
  'not_saved',
  'issued',
  'inactive',
  'expired',
  'completed',
  null,
];

/** States where we have NOT asked Google, so absence must not be asserted. */
const UNVERIFIED: PassState[] = ['not_issued', null];

// ─── The copy ─────────────────────────────────────────────────────────

describe('pass state presentation', () => {
  it('has copy for every state the database can hold', () => {
    for (const state of ALL_STATES) {
      const shown = presentPass(state);
      expect(shown.label.length).toBeGreaterThan(0);
      expect(shown.detail.length).toBeGreaterThan(0);
    }
  });

  it('never collapses two states into the same words', () => {
    // The whole point: if `not_issued` and `not_saved` render identically, the
    // distinction the schema insists on is gone by the time a human reads it.
    const labels = new Set(ALL_STATES.map((s) => presentPass(s).label));
    expect(labels.size).toBe(ALL_STATES.length);
  });

  it('says not_issued is our gap, not the customer’s state', () => {
    const shown = presentPass('not_issued');

    expect(shown.unverified).toBe(true);
    expect(shown.tone).toBe('unknown');
    // It must read as work still to do, never as a fact about the phone.
    // Stem, so the wording can move between "comprobamos"/"comprobado".
    expect(shown.detail.toLowerCase()).toContain('comproba');
  });

  it('says not_saved as something Google confirmed', () => {
    const shown = presentPass('not_saved');

    // Firm: we asked and got an answer, so this one is not a gap.
    expect(shown.unverified).toBe(false);
    expect(shown.tone).toBe('warn');
    expect(shown.detail.toLowerCase()).toContain('google');
  });

  it('treats a missing pass row as a third fact, not as not_saved', () => {
    const shown = presentPass(null);

    expect(shown.unverified).toBe(true);
    expect(shown.label).not.toBe(presentPass('not_saved').label);
    expect(shown.label).not.toBe(presentPass('not_issued').label);
  });

  it('reports issued as the one state we know is good', () => {
    const shown = presentPass('issued');

    expect(shown.tone).toBe('ok');
    expect(shown.unverified).toBe(false);
  });

  it('fails closed on a state it does not recognise', () => {
    // `customer_wallet_passes.state` is `text` with no CHECK constraint, on
    // purpose: "readers must fail closed on an unrecognised value rather than
    // the database refusing to store one" (schema.ts). A new state added by
    // another deploy must read as unknown here, not as "has a pass".
    //
    // Passed uncast on purpose: the signature accepts an unknown string, so a
    // future state needs no edit here to be handled honestly.
    const shown = presentPass('some_future_state');

    expect(shown.tone).toBe('unknown');
    expect(shown.unverified).toBe(true);
  });

  it('carries the day we last had a definite answer', () => {
    expect(presentPass('issued', '2026-02-01T10:00:00.000Z').checkedOn).toBe(
      '2026-02-01T10:00:00.000Z',
    );
    // Nothing to date an unverified state from, so nothing is invented.
    expect(presentPass('not_issued', null).checkedOn).toBeNull();
  });
});

// ─── The rule, stated as a rule ────────────────────────────────────────

describe('absence claims', () => {
  it('recognises the sentences that assert a customer has no pass', () => {
    expect(claimsAbsence('No tiene tarjeta')).toBe(true);
    expect(claimsAbsence('Este cliente no tiene el pase')).toBe(true);
    expect(claimsAbsence('Sin tarjeta loyalty')).toBe(true);
    expect(claimsAbsence('Todavía no lo comprobamos')).toBe(false);
    expect(claimsAbsence('Comprobado con Google: no lo guardó')).toBe(false);
  });

  it('forbids every unverified state from claiming absence', () => {
    // This is the test the brief asks for: nothing we have not checked may be
    // rendered as "no tiene".
    for (const state of UNVERIFIED) {
      const shown = presentPass(state);
      const sentence = `${shown.label} ${shown.detail}`;

      for (const claim of ABSENCE_CLAIMS) {
        expect(
          sentence.toLowerCase().includes(claim),
          `${String(state)} renders "${sentence}", which claims absence via "${claim}"`,
        ).toBe(false);
      }
    }
  });

  it('allows a verified state to state the absence Google confirmed', () => {
    // The rule is not "never say no". `not_saved` is a real answer and hiding it
    // would be its own kind of dishonesty.
    const shown = presentPass('not_saved');
    expect(shown.unverified).toBe(false);
    expect(shown.label.toLowerCase()).toContain('no guardado');
  });
});
