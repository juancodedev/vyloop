// @vitest-environment node

/**
 * Whether each refusal may offer the customer a retry.
 *
 * ## The defect this file exists for
 *
 * `wallet-card.tsx` rendered `<button>Reintentar</button>` for **every** code
 * `walletFailureFor` could return, and the map had nothing to say about whether
 * re-asking could help. So the button was offered on nine refusals, and seven of
 * them are answered identically however many times the customer taps:
 *
 * - Google's class review takes days, and the copy two lines above the button
 *   already says so — then the button asks the customer to tap anyway;
 * - the merchant has not finished onboarding, and a second tap does not finish it;
 * - `WALLET_NOT_CONFIGURED` means `WALLET_ALLOWED_ORIGINS` is empty or the
 *   member code could not be derived, and the worker's own comment on that code
 *   calls it "this deployment is broken and no pass will ever work".
 *
 * The button does not consult anything. It re-requests the same endpoint and
 * renders the same refusal, and a customer who does what it asks concludes their
 * own account is the problem — the exact inversion the rest of this module
 * exists to prevent.
 *
 * ## Why this is a table and not a boolean
 *
 * The property worth holding is not "is a retry honest". It is that the button
 * and the sentence above it **agree**. A boolean plus a separate note allows
 * `false` with no note, which is the bug itself; the union below makes that
 * unrepresentable, because `retry` cannot carry a note and the other three
 * cannot be written without one.
 *
 * ## What is deliberately not decided here
 *
 * The copy. `lib/wallet.ts` owns it, and `wallet.test.ts` snapshots it. This
 * file only asks the mapping a question, so a change of wording cannot quietly
 * change the verdict.
 */

import { describe, expect, it } from 'vitest';

import { WALLET_FAILURE_CODES, walletFailureFor } from './wallet';
import type { WalletFailure, WalletRemedy } from './wallet';

/**
 * Every code the map declares, with the remedy it may offer and the reason.
 *
 * The reason column is the point of this table: a verdict nobody can justify is
 * a guess, and a guess here is a button that does nothing. Each line cites where
 * in `workers/wallet/src/routes.ts` the behaviour comes from, because "this one
 * is permanent" is a claim about the worker and the worker is what can prove it.
 */
const CLASSIFIED: ReadonlyArray<{
  code: string;
  status: number;
  remedy: WalletRemedy['kind'];
  why: string;
}> = [
  {
    code: 'WALLET_CLASS_NOT_PROVISIONED',
    status: 409,
    remedy: 'tell-anyone',
    why:
      'The merchant never finished onboarding (routes.ts:964). Nothing this app does changes ' +
      'between two taps, so the next step belongs to the commerce.',
  },
  {
    code: 'WALLET_CLASS_NOT_APPROVED',
    status: 409,
    remedy: 'wait',
    why:
      "Google's own review, which takes days (routes.ts:1131, and the gate now refuses before " +
      'Google is asked). No tap shortens a queue at Google.',
  },
  {
    code: 'WALLET_CLASS_ID_MISMATCH',
    status: 409,
    remedy: 'ours',
    why:
      'The stored class id disagrees with the id derived from the business and issuer ids. It is ' +
      'a defect in our tables and it does not heal on its own.',
  },
  {
    code: 'WALLET_PASS_NOT_CREATABLE',
    status: 409,
    remedy: 'retry',
    why:
      "AMBIGUOUS, kept as retry. routes.ts:752 catches Google's API error *and* the auth error " +
      'from `mintAccessToken`, so one code covers both a bad minute at Google and an invalid ' +
      "token here. The first dominates (routes.ts:735's own comment calls it the most common " +
      "409 in production) and the copy already promises a retry, so removing the button would " +
      'change customer-facing words on an unproven guess.',
  },
  {
    code: 'WALLET_BALANCE_NOT_DISPLAYABLE',
    status: 409,
    remedy: 'tell-anyone',
    why:
      'The balance is above what the pass layout can show and `balance.ts` refuses to truncate. ' +
      'Choosing another presentation is the merchant decision (routes.ts:886).',
  },
  {
    code: 'WALLET_PASS_TERMINAL',
    status: 409,
    remedy: 'tell-anyone',
    why:
      'Google will not un-expire or un-complete an object, so a new insert would be refused under ' +
      'the same derived id (routes.ts:105, and the refusal at routes.ts:605). The card is ' +
      'finished, not missing.',
  },
  {
    code: 'LOYALTY_PROGRAM_NOT_CONFIGURED',
    status: 409,
    remedy: 'tell-anyone',
    why:
      'There is no points currency to label a balance with until the merchant configures the ' +
      'programme (routes.ts:861). A second request finds the same absent row.',
  },
  {
    code: 'WALLET_NOT_CONFIGURED',
    status: 500,
    remedy: 'ours',
    why:
      'Either `WALLET_ALLOWED_ORIGINS` is empty (routes.ts:524) or the member code could not be ' +
      "derived (routes.ts:906). The worker's own comment on the constant says this deployment is " +
      "broken and no pass will ever work — so the previous 'reintentá más tarde' was false.",
  },
  {
    code: 'WALLET_DEMO_MODE',
    status: 409,
    remedy: 'tell-anyone',
    why:
      'The issuer has no Google publishing access, and it stays that way after a class review ' +
      'finishes (routes.ts:76). Obtaining it is the merchant to do.',
  },
  {
    code: 'WALLET_MALFORMED_RESPONSE',
    status: 200,
    remedy: 'retry',
    why:
      'Thrown by `api.getWalletPass` for a 200 whose body carried no pass. The answer we got was ' +
      'bad, and asking again is the only thing that can produce a different one.',
  },
];

/**
 * The codes with no verdict of their own, and what they are allowed to say.
 *
 * Split on one fact: **did an answer arrive at all.** `status` 0 is set by the
 * card only when the rejection was not an `ApiError`, so no HTTP status was ever
 * parsed — the request did not reach the API. 502/503/504 are, by RFC 9110,
 * statements about the hop rather than about the application.
 *
 * Everything else is a server that answered with a stable code this build does
 * not know, and a stable code is a code that will answer with it again. Retry
 * there is provably useless, so the copy does not promise it.
 */
const UNCLASSIFIED: ReadonlyArray<{ code: string; status: number; remedy: WalletRemedy['kind'] }> = [
  { code: '', status: 0, remedy: 'retry' },
  { code: 'UNKNOWN_ERROR', status: 502, remedy: 'retry' },
  { code: 'UNKNOWN_ERROR', status: 503, remedy: 'retry' },
  { code: 'WALLET_SOMETHING_NEW', status: 409, remedy: 'ours' },
  { code: 'UNKNOWN_ERROR', status: 500, remedy: 'ours' },
  { code: 'WALLET_PASS_STATE_UNKNOWN', status: 500, remedy: 'ours' },
];

const ALL: ReadonlyArray<{ code: string; status: number; remedy: WalletRemedy['kind'] }> = [
  ...CLASSIFIED,
  ...UNCLASSIFIED,
];

/** Every phrasing a customer can read as "ask again and it will work". */
const PROMISES_RETRY = /reintent|intenta(?:r|do)? (?:de nuevo|otra vez)|vuelve? a (?:intentar|pedir)/i;

function failureOf(code: string, status: number): WalletFailure {
  return walletFailureFor(code, status);
}

describe('the retry a refusal may offer', () => {
  it.each(CLASSIFIED.map(({ code, status, remedy }) => [code, status, remedy] as const))(
    '%s offers remedy %s',
    (code, status, remedy) => {
      expect(failureOf(code, status).remedy.kind, code).toBe(remedy);
    },
  );

  it.each(UNCLASSIFIED.map(({ code, status, remedy }) => [`${code || '(none)'}/${status}`, code, status, remedy] as const))(
    'falls back to %s offering remedy %s',
    (_label, code, status, remedy) => {
      expect(failureOf(code, status).remedy.kind, `${code}/${status}`).toBe(remedy);
    },
  );

  it('gives every non-retry remedy something to show where the button was', () => {
    // The reason this is a union rather than a flag. A refusal that cannot be
    // retried leaves a hole where the button was, and a hole is what sends a
    // customer to the counter with nothing to do. So every non-retry verdict
    // carries the sentence that occupies the slot — and it is a sentence, not a
    // second control, because a control here would have to be a support channel
    // this app does not have.
    for (const { code, status } of ALL) {
      const { remedy } = failureOf(code, status);

      if (remedy.kind === 'retry') {
        expect(remedy, `${code}/${status}`).not.toHaveProperty('note');
        continue;
      }

      expect(remedy, `${code}/${status}`).toHaveProperty('note');
      expect(remedy.note, `${code}/${status}`).toMatch(/\S/);
    }
  });

  it('never says the customer has to do anything in the retry slot', () => {
    // The note answers "and what do I do now?", and the answer for every
    // non-retry branch is that the tap they were offered does nothing. If a note
    // asks the customer for anything, the slot is a lie wearing a sentence.
    for (const { code, status } of ALL) {
      const { remedy } = failureOf(code, status);

      if (remedy.kind === 'retry') continue;

      expect(remedy.kind, `${code}/${status}`).not.toBe('retry');
      expect(remedy.note, `${code}/${status}`).not.toMatch(
        /\b(reintent|volv[ée] a intentar|esper[aá])\b/i,
      );
    }
  });
});

/**
 * The whole defect, as one property: the button and the sentence agree.
 *
 * Asserted in both directions on purpose. A promise without a button is the bug
 * this file fixes, and a button without a promise teaches a customer that the
 * control is decoration — which is the same defect wearing the other hat.
 */
describe('the copy and the retry verdict never disagree', () => {
  it.each(ALL.map(({ code, status }) => [`${code || '(no code)'}/${status}`, code, status] as const))(
    '%s promises a retry exactly when a retry can help',
    (_label, code, status) => {
      const failure = failureOf(code, status);
      const text = `${failure.title} ${failure.message}`;

      expect(PROMISES_RETRY.test(text), `${code}/${status}: "${text}"`).toBe(
        failure.remedy.kind === 'retry',
      );
    },
  );

  it('never offers a retry for a refusal whose cause cannot change', () => {
    // Restated as the negative, because this is the way it breaks: somebody adds
    // a code, copies a neighbour's remedy, and a merchant's unfinished setup
    // gets a button that re-runs the same failing query.
    for (const { code, status } of ALL) {
      if (failureOf(code, status).remedy.kind === 'retry') continue;

      expect(
        PROMISES_RETRY.test(`${failureOf(code, status).title} ${failureOf(code, status).message}`),
        code,
      ).toBe(false);
    }
  });
});

/**
 * The fallback cannot know, and must stop saying that it does.
 *
 * One constant used to answer every unrecognised code, and it promised
 * "podés reintentar en un momento" for all of them. A 500 of network is
 * transient; a 500 of a bug here is not and will be produced forever. The
 * constant could not tell those apart, so it promised the transient case on
 * behalf of the permanent one.
 *
 * Now it does tell them apart — on whether an answer arrived — so the promise is
 * made only where there is something to promise.
 */
describe('the fallback does not promise what it cannot know', () => {
  it('offers no retry to a server that answered with a code we do not know', () => {
    const failure = failureOf('WALLET_PASS_STATE_UNKNOWN', 500);

    expect(failure.remedy.kind).not.toBe('retry');
    expect(`${failure.title} ${failure.message}`).not.toMatch(PROMISES_RETRY);
  });

  it('still offers a retry when no answer ever arrived', () => {
    // The case that would have regressed without thought. A dropped connection
    // is exactly what re-asking fixes, so removing the button everywhere would
    // have traded a lie for a worse answer.
    const failure = failureOf('', 0);

    expect(failure.remedy.kind).toBe('retry');
    expect(`${failure.title} ${failure.message}`).toMatch(PROMISES_RETRY);
  });

  it('still offers a retry when the hop in between failed', () => {
    // 502/503/504 describe the proxy or the edge, not this application, so a
    // second request is a reasonable thing to offer rather than a promise.
    for (const status of [502, 503, 504]) {
      expect(failureOf('UNKNOWN_ERROR', status).remedy.kind, String(status)).toBe('retry');
    }
  });

  it('keeps naming us, on every fallback, so nobody is told their account is the problem', () => {
    for (const { code, status } of UNCLASSIFIED) {
      const { title, message } = failureOf(code, status);

      expect(`${title} ${message}`, `${code}/${status}`).toMatch(
        /tu cuenta (y tus puntos )?est[áa]n? bien/i,
      );
    }
  });

  it('gives each fallback verdict its own sentence, so the branches stay distinct', () => {
    // Two branches, two sentences. Grouped by verdict rather than by entry,
    // because several unrecognised codes deliberately land on the same one — a
    // support reader tells those apart by `data-wallet-code`, and writing six
    // paragraphs to separate them would be copy for a distinction no customer can
    // act on.
    const sentences = new Set(
      UNCLASSIFIED.map(({ code, status }) => {
        const { title, message } = failureOf(code, status);

        return `${title} ${message}`;
      }),
    );

    // `''/0` and `UNKNOWN_ERROR/502` share the "we never got an answer" wording on
    // purpose; the other three all land on the "we have to fix it" one. So two
    // distinct sentences across six entries, not six.
    expect(sentences.size).toBe(2);
  });

  it('says something different about the retryable and the permanent fallback', () => {
    // The pair itself, asserted directly so the count above cannot be satisfied by
    // six identical strings.
    const retryable = failureOf('', 0);
    const permanent = failureOf('WALLET_SOMETHING_NEW', 409);

    expect(`${retryable.title} ${retryable.message}`).not.toBe(
      `${permanent.title} ${permanent.message}`,
    );
    expect(`${permanent.title} ${permanent.message}`).toMatch(/nuestro lado/i);
  });
});

/**
 * A code added to the map without a verdict is how this bug comes back.
 *
 * Two guards, and they catch different mistakes:
 *
 *   - **By structure.** `remedy` is a required property of what a map entry
 *     holds, so an entry that omits it does not compile. `pnpm -r typecheck`
 *     fails before a reviewer ever reads the diff.
 *   - **This file.** Every code the map declares must appear in the table above,
 *     with a reason. An entry that compiles but was never reasoned about shows
 *     up here as a code nobody wrote a line for.
 */
describe('every code the map declares is classified', () => {
  it('exposes the codes it holds, so a new one cannot be added silently', () => {
    expect(Array.isArray(WALLET_FAILURE_CODES)).toBe(true);
  });

  it('has a verdict and a written reason for each of them', () => {
    const declared = new Set(WALLET_FAILURE_CODES);
    const reasoned = new Set(CLASSIFIED.map(({ code }) => code));

    expect([...declared].filter((code) => !reasoned.has(code))).toEqual([]);
  });

  it('asserts one line per code the map holds, and no lines for codes it does not', () => {
    // The other direction: a table that invents a code is a table that will
    // happily pass while the real code goes unclassified.
    expect(new Set(CLASSIFIED.map(({ code }) => code))).toEqual(new Set(WALLET_FAILURE_CODES));
  });

  it('classifies every known code exactly once', () => {
    const codes = CLASSIFIED.map(({ code }) => code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('covers the nine worker codes and the malformed response, which is ten', () => {
    // Stated as a count so that adding an eleventh entry is a deliberate edit to
    // this assertion rather than an accident.
    expect(CLASSIFIED).toHaveLength(10);
  });
});