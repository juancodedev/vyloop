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

import { WALLET_RESPONSE_MALFORMED, walletFailureFor, walletPassCopyFor } from './wallet';
import type { WalletFailure, WalletPass, WalletPassState } from './wallet';

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
  { code: 'WALLET_PASS_TERMINAL', status: 409 },
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
    //
    // **The no-answer case is no longer one of them**, and this assertion is the
    // record of why. It used to read
    // `expect(render('', 0)).toBe(render('WALLET_SOMETHING_NEW', 409))`, holding a
    // single fallback that promised "podés reintentar en un momento" for a request
    // that never arrived *and* for a server that answered with a stable code this
    // build does not know. Those want opposite answers, and the constant could not
    // tell them apart, so it made the promise on behalf of the permanent case too.
    //
    // What holds now is narrower and is the property that matters: every
    // unrecognised code that **got an answer** shares one sentence. The split is
    // on whether an answer arrived at all — see `wallet-remedy.test.ts`.
    expect(render('WALLET_SOMETHING_NEW', 409)).toBe(render('UNKNOWN_ERROR', 500));
    expect(render('WALLET_PASS_STATE_UNKNOWN', 500)).toBe(render('WALLET_SOMETHING_NEW', 409));
    expect(render('', 0)).not.toBe(render('WALLET_SOMETHING_NEW', 409));
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

  it('treats a configuration fault as ours, and asks the customer for nothing', () => {
    // 500 from `WALLET_NOT_CONFIGURED` is the worker missing a value it cannot
    // invent. Nothing the comensal did causes it and nothing they can do fixes
    // it, so the message has to say both.
    //
    // **This assertion used to require `/reintent/` and that requirement was
    // wrong.** The old reasoning was that the cause "really can be transient",
    // which is not what the worker says about its own code: `routes.ts:57` calls
    // this "this deployment is broken and no pass will ever work", and the two
    // places that raise it are an empty `WALLET_ALLOWED_ORIGINS`
    // (`routes.ts:524`) and a member code that could not be derived
    // (`routes.ts:906`) — neither of which a second request changes.
    //
    // So the sentence lost "podés reintentar más tarde" with the button. The
    // negative is the assertion now: a deployment fault must not send a customer
    // away to do something that cannot work.
    const failure = walletFailureFor('WALLET_NOT_CONFIGURED', 500);

    expect(`${failure.title} ${failure.message}`).not.toMatch(/reintent|m[áa]s tarde/i);
    expect(`${failure.title} ${failure.message}`).toMatch(/nosotros/i);
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

  it('says a terminal pass is finished, rather than that it is missing', () => {
    // The one refusal that is about the customer's own card, so it is the one
    // where the difference between "finished" and "not there yet" is the whole
    // message. Saying it is missing sends someone looking in their phone for a
    // card that is there and will never work again; saying it is finished tells
    // them what actually happened, and names the business as the one who acts.
    const failure = walletFailureFor('WALLET_PASS_TERMINAL', 409);

    expect(failure.title).toMatch(/no se puede volver a usar|no se puede reutilizar/i);
    expect(failure.message).toMatch(/comercio/i);
    expect(`${failure.title} ${failure.message}`).not.toMatch(/agreg[áa] la (tarjeta|pase)/i);
  });

  it('lands an unrecognised pass state on the "our side" copy, on purpose', () => {
    // `WALLET_PASS_STATE_UNKNOWN` is a real code the worker sends, with no entry
    // here — deliberately, and this is what holds that decision in place.
    //
    // The worker refuses rather than minting when `customer_wallet_passes.state`
    // holds a value no code has reasoned about, and it says so with a 500. That
    // is *our* fault and *our* fix, so the honest thing a phone can show is the
    // generic "hubo un problema de nuestro lado" copy with its retry. Writing
    // bespoke copy here would have to guess whether the customer holds a working
    // card, which is precisely the state nobody in this system knows.
    const failure = walletFailureFor('WALLET_PASS_STATE_UNKNOWN', 500);

    expect(`${failure.title} ${failure.message}`).toBe(render('WALLET_SOMETHING_NEW', 409));
    expect(failure.message).toMatch(/tu cuenta (y tus puntos )?est[áa]n? bien/i);
  });
});

// ============================================================================
// The wording for a pass that came back
//
// The same argument as the section above, applied to the other direction: the
// worker reuses a pass that already exists, and the response is otherwise
// identical, so the page has to be able to tell a card it just created from one
// that has been in the customer's phone for a year. Getting that wrong does not
// throw — it says "Agregala una vez" to somebody who did it a year ago.
// ============================================================================

/**
 * Every state a pass can arrive in, crossed with both values of the flag.
 *
 * `expired` and `completed` cannot reach a 200 — the route refuses a terminal
 * pass rather than returning one — and a value this build has never heard of
 * cannot be ruled out either, since the wire is untyped and the packages share no
 * types. Both are walked, because a branch that is dead in production is still a
 * branch that can be written wrong.
 */
const PASS_STATES: ReadonlyArray<string> = [
  ...(['not_issued', 'not_saved', 'issued', 'inactive', 'expired', 'completed'] satisfies
    WalletPassState[]),
  'archived',
];

function returnedPass(already_existed: boolean, pass_state: string): WalletPass {
  return {
    save_url: 'https://pay.google.com/gp/v/save/ABC',
    object_id: '3388.member-3f8a',
    class_id: '3388.tenant-1',
    member_code: 'K7M2QX',
    balance_points: 1200,
    points_currency: 'puntos',
    already_existed,
    // Cast on purpose: the string set above deliberately includes a value the
    // union does not declare, and the behaviour for that value is under test.
    pass_state: pass_state as WalletPassState,
  };
}

describe('the wording for a returned pass never claims a card the customer lacks', () => {
  /**
   * Where we actually have evidence the card is on the customer's phone.
   *
   * `issued` means Google has the object and the customer saved it. `inactive`
   * means the same card with their finger off the switch — still on their phone,
   * still the same object. Nothing else qualifies, and `not_saved` is what makes
   * this a decision rather than a default: we asked Google and it has no object,
   * so "you already have it" would be the same lie pointed the other way.
   */
  function knowsTheCardIsThere(already_existed: boolean, pass_state: string): boolean {
    return already_existed && (pass_state === 'issued' || pass_state === 'inactive');
  }

  it('falls back to the first-add sentence everywhere except those two states', () => {
    // The load-bearing property, stated in the negative because that is the way
    // it gets broken: a branch added for a state nobody reasoned about that
    // reaches for the reassuring sentence. `walletPassCopyFor` returns one shared
    // constant for everything it has no specific wording for, so "did it fall
    // back" is a fact about the mapping rather than a guess about the prose.
    for (const already_existed of [false, true]) {
      for (const pass_state of PASS_STATES) {
        const copy = walletPassCopyFor(returnedPass(already_existed, pass_state));
        const saysFirstAdd = /agreg[áa]la una vez/i.test(copy.note);

        expect(saysFirstAdd, `${already_existed}/${pass_state}`).toBe(
          !knowsTheCardIsThere(already_existed, pass_state),
        );
      }
    }
  });

  it('and says the card is there in exactly those two states', () => {
    // The other direction, so the previous test cannot be satisfied by a mapping
    // that never mentions the card at all. The claim is permitted *and* made:
    // a returning customer is the one who most needs to be told their card
    // exists, and it is the one thing this field exists to let the page say.
    for (const already_existed of [false, true]) {
      for (const pass_state of PASS_STATES) {
        const copy = walletPassCopyFor(returnedPass(already_existed, pass_state));

        expect(/en tu google wallet/i.test(copy.note), `${already_existed}/${pass_state}`).toBe(
          knowsTheCardIsThere(already_existed, pass_state),
        );
      }
    }
  });

  it('never blames the customer on any branch, as the refusals do not either', () => {
    for (const already_existed of [false, true]) {
      for (const pass_state of PASS_STATES) {
        const copy = walletPassCopyFor(returnedPass(already_existed, pass_state));
        const text = `${copy.note} ${copy.label}`;

        for (const blame of CUSTOMER_BLAMING) {
          expect(text, `${blame.source} @ ${already_existed}/${pass_state}`).not.toMatch(blame);
        }
      }
    }
  });

  it('never promises a card, and never promises one will arrive', () => {
    for (const already_existed of [false, true]) {
      for (const pass_state of PASS_STATES) {
        const text = walletPassCopyFor(returnedPass(already_existed, pass_state)).note;

        expect(text, `${already_existed}/${pass_state}`).not.toMatch(
          /pr[óo]ximamente|m[áa]s pronto|coming soon|en breve/i,
        );
        expect(text, `${already_existed}/${pass_state}`).not.toMatch(/[\r\n]/);
      }
    }
  });

  it('always leaves a link the customer can follow, whatever it says', () => {
    // The flag changes the sentence, never the affordance. A customer who deleted
    // the pass needs the link back, and one whose balance went stale has it
    // refreshed by opening it.
    const labels = new Set(
      PASS_STATES.flatMap((pass_state) =>
        [false, true].map((already_existed) =>
          walletPassCopyFor(returnedPass(already_existed, pass_state)).label,
        ),
      ),
    );

    for (const label of labels) {
      expect(label).toMatch(/google wallet/i);
    }
  });
});

// ============================================================================
// The retry promise
//
// A comensal of `cafe-prueba-0117` or `sonda-a2-1116` was told: "Google no pudo
// generar el pase en este momento. Tu cuenta está bien y podés reintentar en un
// rato." That sentence was wrong twice over.
//
// Once, because the cause was not a bad minute at Google. The class had never
// been approved, so `loyaltyObject.insert` answered 404
// `not approved` — a permanent answer, not a transient one.
//
// Twice because the advice cannot work. The review is Google's, it takes days,
// and no number of retries from a phone changes it. So the customer came back,
// was refused identically, and eventually concluded something was wrong with
// their own account — the exact inversion this module refuses to make.
//
// The gate now refuses before Google is asked, which is the real fix. This block
// pins the copy, because copy is the half a customer actually reads and it can
// drift back independently of the gate.
// ============================================================================

describe('the class_not_approved copy', () => {
  function notApproved(): WalletFailure {
    return walletFailureFor('WALLET_CLASS_NOT_APPROVED', 409);
  }

  it('never tells the customer a retry would help, because it cannot', () => {
    // The load-bearing assertion, and the one that fails the day somebody
    // "softens" the wording. Every phrasing a customer could read as "ask again
    // and it will work" is listed, because a single word is what makes the
    // promise: "reintentá", "probá de nuevo", "en un rato", "vuelve a intentar".
    //
    // A comensal who retries gets the same 409, reads the same sentence, and
    // concludes the problem is them.
    const { title, message } = notApproved();

    for (const text of [title, message, `${title} ${message}`]) {
      expect(text, text).not.toMatch(/reintent/i);
      expect(text, text).not.toMatch(/intenta(?:r|do)? (de nuevo|otra vez|mas|nuevamente)/i);
      expect(text, text).not.toMatch(/vuelve? a (intentar|pedir|probar)/i);
      expect(text, text).not.toMatch(/en un rato|m[aá]s tarde|pronto|otro momento/i);
      expect(text, text).not.toMatch(/ya (va a estar|estar[aá])/i);
    }
  });

  it('names the commerce as the one who has to act, not the customer', () => {
    // The remedy, and the audience. `WALLET_CLASS_NOT_APPROVED` means the
    // business's class is sitting at Google unapproved — so what moves it is the
    // business submitting it. Telling the comensal to do anything is both
    // impossible and corrosive: it turns a merchant's unfinished setup into a
    // stream of customers contacting support about their own accounts.
    //
    // Asserted as **the commerce being the subject of an obligation**, not merely
    // as the word "comercio" appearing. The previous wording named the commerce
    // only as the owner of the class ("la clase del pase de este comercio") and
    // handed the sentence to Google, which is why it could sit here claiming the
    // audience while describing nobody's next step.
    const { message } = notApproved();

    expect(message).toMatch(/(comercio|negocio|tienda)[^.]*\b(tiene que|debe|necesita|hay que)\b/i);
    // And the customer's own remedy is explicitly nil.
    expect(message).toMatch(/tu cuenta (y tus puntos )?est[áa]n? bien/i);
  });

  it('does not claim a review is already under way when the class may never have been submitted', () => {
    // The subtler half of the same sentence, and the reason "Google está
    // revisando la clase" is a second lie rather than a first.
    //
    // The two production tenants this copy now reaches are `draft`. `draft` means
    // the class was created and **not submitted** — there is no review running at
    // Google, because nobody has asked for one. Telling a comensal that Google is
    // reviewing their shop's class sends them to wait for a queue that does not
    // exist, and it hides the actual state, which is the one thing they can relay
    // to the merchant.
    //
    // So the copy names what is true in both cases — Google has not approved it —
    // rather than claiming a process is in flight that may not have started.
    const { title, message } = notApproved();

    for (const text of [title, message]) {
      expect(text, text).not.toMatch(/google est[aá] revisando/i);
      expect(text, text).not.toMatch(/est[aá] en revisi[óo]n/i);
    }
  });

  it('keeps the distinctness the other branches rely on', () => {
    // `WALLET_CLASS_NOT_PROVISIONED` also names the commerce, so "names the
    // commerce" alone would collapse the two. They are different states with
    // different remedies: no class at all versus a class Google has not looked
    // at yet. Every branch must stay distinguishable, or the page is guessing.
    const notApprovedText = (() => {
      const { title, message } = notApproved();
      return `${title} ${message}`;
    })();

    for (const { code, status } of CASES) {
      if (code === 'WALLET_CLASS_NOT_APPROVED') continue;

      expect(render(code, status), code).not.toBe(notApprovedText);
    }
  });

  it('does not promise the card is on its way, because nobody here knows that', () => {
    // The class has not been submitted, or was submitted and is waiting. We do
    // not know which, and "ya va a estar" is the retired delivery-guard mistake
    // in new words — the promise is not ours to make and it is the sentence a
    // customer builds a plan around.
    const { title, message } = notApproved();
    const text = `${title} ${message}`;

    expect(text).not.toMatch(/ya (va a estar|est[aá])/i);
    expect(text).not.toMatch(/pr[óo]ximamente|en breve|coming soon/i);
    expect(text).not.toMatch(/agreg[áa] la (tarjeta|pase)/i);
  });
});

/**
 * Every other branch, pinned.
 *
 * ## Why this exists
 *
 * The copy for `WALLET_CLASS_NOT_APPROVED` had to change, and while changing one
 * entry in a map of eleven it is very easy to change a neighbour without
 * noticing — and a neighbour here is a sentence a real customer reads about
 * their own account.
 *
 * So the whole map is written out, exactly as it stood before this fix, and
 * compared. Deliberately a literal snapshot rather than a shape assertion: a
 * shape assertion would pass for copy that has been rewritten into something
 * equally wrong, and the point is that *these* words did not move.
 *
 * ## One entry did move, on purpose, and this is the record of it
 *
 * `WALLET_NOT_CONFIGURED` lost "podés reintentar más tarde". Not a reword: the
 * retry button was removed from every refusal whose cause does not change
 * between two taps, and this one was in that set — `routes.ts:524` (an empty
 * `WALLET_ALLOWED_ORIGINS`) and `routes.ts:906` (a member code that could not be
 * derived) are both permanent, and the worker says so about its own constant at
 * `routes.ts:57`.
 *
 * Keeping the sentence after taking the button would have left the page promising
 * precisely what it now refuses to offer. The snapshot's job is catching drift, and
 * a promise removed against the worker's evidence is the opposite of drift.
 */
describe('the rest of the refusal copy did not change', () => {
  const UNCHANGED: ReadonlyArray<readonly [string, number, string, string]> = [
    [
      'WALLET_CLASS_NOT_PROVISIONED',
      409,
      'Este comercio todav\u00eda no tiene tarjeta',
      'Google Wallet todav\u00eda no est\u00e1 configurado para este comercio. Tu cuenta est\u00e1 bien y no ten\u00e9s ' +
        'que hacer nada: es algo que el comercio tiene que terminar de configurar.',
    ],
    [
      'WALLET_CLASS_ID_MISMATCH',
      409,
      'No pudimos preparar la tarjeta',
      'Hay una inconsistencia en la configuraci\u00f3n del comercio que tenemos que corregir. Tu cuenta ' +
        'est\u00e1 bien y tus puntos no cambian.',
    ],
    [
      'WALLET_PASS_NOT_CREATABLE',
      409,
      'Google no pudo crear la tarjeta ahora',
      'Google no pudo generar el pase en este momento. Tu cuenta est\u00e1 bien y pod\u00e9s reintentar en un ' +
        'rato.',
    ],
    [
      'WALLET_BALANCE_NOT_DISPLAYABLE',
      409,
      'Tu saldo es m\u00e1s grande de lo que la tarjeta puede mostrar',
      'Este programa todav\u00eda no tiene una forma de mostrar saldos tan grandes en Google Wallet. Tus ' +
        'puntos est\u00e1n intactos y los pod\u00e9s usar en el local; el comercio necesita configurar otra ' +
        'presentaci\u00f3n.',
    ],
    [
      'WALLET_PASS_TERMINAL',
      409,
      'Esta tarjeta ya no se puede volver a usar',
      'Google ya no permite reutilizar esta tarjeta porque su vigencia termin\u00f3. Tu cuenta y tus ' +
        'puntos est\u00e1n bien y los pod\u00e9s seguir usando en el local. Contale al comercio para que lo ' +
        'resuelvan.',
    ],
    [
      'LOYALTY_PROGRAM_NOT_CONFIGURED',
      409,
      'Este comercio todav\u00eda no configur\u00f3 su programa',
      'El comercio tiene una tarjeta de Google Wallet pero todav\u00eda no configur\u00f3 el programa de ' +
        'puntos que la tarjeta muestra. Tu cuenta est\u00e1 bien.',
    ],
    [
      'WALLET_NOT_CONFIGURED',
      500,
      'La tarjeta no est\u00e1 disponible en este momento',
      'La integraci\u00f3n con Google Wallet no est\u00e1 completa en este entorno. Tu cuenta est\u00e1 bien y tus ' +
        'puntos no cambian: es algo que tenemos que corregir nosotros.',
    ],
    [
      'WALLET_DEMO_MODE',
      409,
      'S\u00f3lo funciona en cuentas de prueba',
      'Este comercio todav\u00eda no tiene acceso de publicaci\u00f3n en Google Wallet, as\u00ed que una tarjeta ' +
        's\u00f3lo llega a cuentas de prueba de Google. Tu cuenta est\u00e1 bien.',
    ],
    [
      WALLET_RESPONSE_MALFORMED,
      200,
      'La tarjeta lleg\u00f3 incompleta',
      'La respuesta que nos lleg\u00f3 no tra\u00eda una tarjeta. Tu cuenta est\u00e1 bien y pod\u00e9s reintentar en un ' +
        'momento.',
    ],
  ];

  it.each(UNCHANGED)('%s is exactly what it was', (code, status, title, message) => {
    const failure = walletFailureFor(code, status);

    expect(failure.title).toBe(title);
    expect(failure.message).toBe(message);
  });

  it('covers every code the map knows, so a new branch cannot slip past the snapshot', () => {
    // Without this the table could silently fall behind the map, and a code added
    // after this fix would land with no assertion on its words at all.
    const known = CASES.map(({ code }) => code).filter(
      (code) =>
        code !== 'WALLET_CLASS_NOT_APPROVED' &&
        code !== 'WALLET_SOMETHING_NEW' &&
        code !== 'UNKNOWN_ERROR',
    );

    expect(new Set(known)).toEqual(new Set(UNCHANGED.map(([code]) => code)));
  });
});

