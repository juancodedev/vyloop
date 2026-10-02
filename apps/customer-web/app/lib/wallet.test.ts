// @vitest-environment node

/**
 * What each Google Wallet refusal is allowed to say to a comensal.
 *
 * This module is the whole point of the wallet UI, and it is the part that is
 * easiest to get wrong in a way nobody notices. A 409 and a 500 are both "an
 * error", and the tempting rendering for both is "no tenés tarjeta" — which
 * tells a customer with a perfectly good account that their account is the
 * problem, and sends them to support instead of to the merchant who has to
 * finish configuring something.
 *
 * Every case below is a **different real condition** with a **different remedy**
 * and a **different audience**: the merchant, Google, or us. So each gets its
 * own message. A collapsed copy would be the bug.
 *
 * These assertions are about meaning, not about exact strings: the point is that
 * no branch can tell the customer their account is broken, and that the branches
 * cannot be merged.
 */

import { describe, expect, it } from 'vitest';

import { WALLET_RESPONSE_MALFORMED, walletFailureFor } from './wallet';
import type { WalletFailure } from './wallet';

/**
 * Every code `GET /v1/wallet/pass` can answer with.
 *
 * Read from `workers/wallet/src/routes.ts` and `issuance.ts`. `UNKNOWN` stands
 * for a code nobody has written yet, and the network failure for one with no
 * status at all — both must land on copy that names *us*, not the customer.
 */
const CASES: ReadonlyArray<{ code: string; status: number }> = [
  { code: 'WALLET_CLASS_NOT_PROVISIONED', status: 409 },
  { code: 'WALLET_CLASS_NOT_APPROVED', status: 409 },
  { code: 'WALLET_CLASS_ID_MISMATCH', status: 409 },
  { code: 'WALLET_PASS_NOT_CREATABLE', status: 409 },
  { code: 'WALLET_BALANCE_NOT_DISPLAYABLE', status: 409 },
  { code: 'LOYALTY_PROGRAM_NOT_CONFIGURED', status: 409 },
  { code: 'WALLET_NOT_CONFIGURED', status: 500 },
  { code: 'WALLET_DEMO_MODE', status: 409 },
  // Not a server code: this one is thrown by `api.getWalletPass` for a 200 with
  // no pass in it, and it is listed here because a code decides a message, so a
  // code with no message of its own would fall to the generic branch for no
  // reason.
  { code: WALLET_RESPONSE_MALFORMED, status: 200 },
  { code: 'WALLET_SOMETHING_NEW', status: 409 },
  { code: 'UNKNOWN_ERROR', status: 500 },
];

function render(code: string, status: number): string {
  const failure = walletFailureFor(code, status);

  return `${failure.title} ${failure.message}`;
}

function messages(): string[] {
  return CASES.map(({ code, status }) => render(code, status));
}

/**
 * Concrete phrasings that would blame the customer.
 *
 * Enumerated rather than pattern-guessed. A broad "does it say `no … tarjeta`?"
 * regex cannot tell "tu cuenta no tiene tarjeta" (a lie) from "este comercio
 * todavía no tiene tarjeta" (the truth, about somebody else), and a guard that
 * cannot tell those apart either fires on correct copy or has to be weakened
 * until it fires on nothing. Each entry below is one specific way to blame the
 * customer, so each is a statement worth making.
 */
const CUSTOMER_BLAMING = [
  /no ten[eé]s (una |tu )?(tarjeta|pase|pass)/i,
  /no tienes (una |tu )?(tarjeta|pase|pass)/i,
  /tu cuenta no (tiene|posee|alcanza)/i,
  /tu cuenta (est[áa] mal|est[áa] rota|no existe|est[áa] incompleta|est[áa] mal configurada)/i,
  /no sos (un |una )?(cliente|socio|miembro)/i,
  /no eres (un |una )?(cliente|socio|miembro)/i,
  /(no|sin) (una |tu )?(tarjeta|pase) para vos/i,
];

describe('wallet refusals never blame the customer', () => {
  it('never tells a comensal they have no pass', () => {
    // The one claim this UI must never make. `GET /v1/wallet/pass` refusing means
    // the *merchant's* Google class, Google itself, or this deployment is not
    // ready. In none of those cases is the customer's account at fault, and the
    // customer's account is the one thing a refusal is not evidence about.
    for (const text of messages()) {
      for (const blame of CUSTOMER_BLAMING) {
        expect(text, blame.source).not.toMatch(blame);
      }
    }
  });

  it('says the account is fine, on every branch that is not about the balance', () => {
    // The reassurance is the content. A customer who reads "the business has not
    // finished configuring Google Wallet" and stops there still believes
    // something is wrong with them unless the page says it is not.
    for (const { code, status } of CASES) {
      if (code === 'WALLET_BALANCE_NOT_DISPLAYABLE') continue;

      const failure = walletFailureFor(code, status);

      expect(`${failure.title} ${failure.message}`, code).toMatch(
        /tu cuenta (y tus puntos )?est[áa]n? bien/i,
      );
    }
  });

  it('gives every known condition a different message', () => {
    // Collapsing two of these into one "no disponible" is what turns a 409 into
    // "you have no pass". The known codes differ in who has to act, so the copy
    // must differ too.
    //
    // The two unknown codes are deliberately excluded: they are *supposed* to
    // share the fallback, because a code nobody has written copy for has no
    // honest way to guess its remedy. That is asserted separately, below.
    const known = CASES.filter(
      ({ code }) => code !== 'WALLET_SOMETHING_NEW' && code !== 'UNKNOWN_ERROR',
    );

    expect(new Set(known.map(({ code, status }) => render(code, status))).size).toBe(known.length);
  });

  it('shares one fallback for every code it does not recognise', () => {
    // The opposite property, and the one that stops someone "fixing" the
    // distinctness above by inventing copy per unknown code. An unrecognised
    // refusal is our problem by default, and every one of them says so the same
    // way.
    expect(render('WALLET_SOMETHING_NEW', 409)).toBe(render('UNKNOWN_ERROR', 500));
    expect(render('', 0)).toBe(render('WALLET_SOMETHING_NEW', 409));
  });

  it('never leaks the raw server message to a customer', () => {
    // The worker's messages are written for an operator or a log reader. One of
    // them quotes Google's own error text, and another names the internal
    // `WALLET_CLASS_ID_MISMATCH` condition. Neither belongs on a page a
    // comensal reads on their phone.
    for (const { code, status } of CASES) {
      const failure = walletFailureFor(code, status);

      expect(failure.message, code).not.toMatch(/google (reported|said):/i);
      expect(failure.message, code).not.toMatch(/WALLET_[A-Z_]+/);
      expect(failure.message, code).not.toMatch(/LOYALTY_PROGRAM/);
    }
  });

  it('carries no punctuation that could carry markup or a newline', () => {
    // Rendered as text by React, so this is belt-and-braces — but a message that
    // can hold a newline renders as two lines of prose on a phone for no reason.
    for (const text of messages()) {
      expect(text, text).not.toMatch(/[\r\n]/);
    }
  });
});

describe('the specific refusals worth naming', () => {
  it('names the merchant as the one who has to act when no class exists yet', () => {
    // `WALLET_CLASS_NOT_PROVISIONED` means the business never finished
    // onboarding. Telling the comensal that is what actually moves it: they can
    // say "the shop has not set this up", and that is true.
    const failure = walletFailureFor('WALLET_CLASS_NOT_PROVISIONED', 409);

    expect(`${failure.title} ${failure.message}`).toMatch(/comercio|negocio/i);
    expect(failure.message).not.toMatch(/revisi[óo]n|review/i);
  });

  it('names the Google review as the wait when the class is not approved', () => {
    // A different remedy and a different audience from the row above: this one is
    // Google's queue, nobody can hurry it, and saying so stops a comensal from
    // asking the merchant to fix something twice a day.
    const failure = walletFailureFor('WALLET_CLASS_NOT_APPROVED', 409);

    expect(`${failure.title} ${failure.message}`).toMatch(/revisi[óo]n/i);
    expect(`${failure.title} ${failure.message}`).toMatch(/google/i);
    expect(failure.message).not.toMatch(/comercio.*configurar/i);
  });

  it('does not promise a card will arrive', () => {
    // The precise failure the retired delivery guard was written to prevent,
    // stated as an assertion about meaning instead of a prohibition on a word. A
    // 409 is not a queued success: for an unprovisioned merchant the card may
    // never arrive at all, and a page that says "it will be ready" is making a
    // promise nobody can keep.
    //
    // Every branch is included, not only the two class states. The fallback and
    // the not-creatable branch are exactly where a reassuring-sounding sentence
    // creeps in, because "Google no pudo crearla ahora" reads like a temporary
    // thing that resolves — and only this merchant's configuration decides
    // whether it ever will.
    for (const { code, status } of CASES) {
      const failure = walletFailureFor(code, status);
      const text = `${failure.title} ${failure.message}`;

      expect(text, code).not.toMatch(/ya (va a estar|está|la tenés|tenés la)/i);
      expect(text, code).not.toMatch(/pr[óo]ximamente|very soon|en breve|coming soon/i);
      expect(text, code).not.toMatch(/agreg[áa] la (tarjeta|pase)/i);
      // "más pronto" is a promise about the card; "reintentá más tarde" is an
      // instruction to the customer and says nothing about when the card lands.
      expect(text, code).not.toMatch(/m[áa]s pronto/i);
    }
  });

  it('treats a configuration fault as ours and the merchant problem, not the customer one', () => {
    // 500 from `WALLET_NOT_CONFIGURED` is the worker missing a value it cannot
    // invent. Nothing the comensal did causes it and nothing they can do fixes
    // it, so the message has to say both.
    const failure = walletFailureFor('WALLET_NOT_CONFIGURED', 500);

    expect(`${failure.title} ${failure.message}`).toMatch(/reintent/i);
    expect(failure.message).toMatch(/tu cuenta est[áa] bien/i);
  });

  it('keeps the demo-mode caveat honest rather than silent', () => {
    // A pass minted against a demo issuer reaches only Google's test accounts.
    // Saying nothing is how a customer is told "it is in your wallet" by a
    // version of the wallet their phone will never show a real customer.
    const failure = walletFailureFor('WALLET_DEMO_MODE', 409);

    expect(`${failure.title} ${failure.message}`).toMatch(/prueba|test/i);
    expect(failure.message).toMatch(/tu cuenta est[áa] bien/i);
  });

  it('falls back to naming us for a status it does not recognise', () => {
    // Including a status with no code at all: a fetch that never reached the
    // gateway. The copy still must not blame the account.
    for (const { code, status } of [
      { code: 'WALLET_SOMETHING_NEW', status: 409 },
      { code: 'UNKNOWN_ERROR', status: 500 },
      { code: '', status: 0 },
    ]) {
      const failure: WalletFailure = walletFailureFor(code, status);

      expect(failure.code, `${code}/${status}`).not.toBe('');
      expect(`${failure.title} ${failure.message}`).toMatch(/tu cuenta (y tus puntos )?est[áa]n? bien/i);
    }
  });
});