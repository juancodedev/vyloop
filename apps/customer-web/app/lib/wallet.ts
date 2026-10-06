/**
 * What a Google Wallet refusal is allowed to say to a comensal.
 *
 * ## Why this is a module and not a switch inside a component
 *
 * Because the interesting property is not any single string. It is that **no
 * branch can tell a customer their account is at fault**. That is a statement
 * about a set, and it cannot be asserted from the DOM — a renderer can render
 * the right copy today and the wrong copy after a one-word edit. Keeping the
 * mapping here, as data with no JSX in it, is what makes `wallet.test.ts` able
 * to walk every code and assert the property across all of them at once.
 *
 * ## Why a refusal is never "you don't have a pass"
 *
 * `GET /v1/wallet/pass` answering non-2xx means one of a handful of real things,
 * and **none of them is about the customer**:
 *
 * - the merchant has not finished Google Wallet onboarding,
 * - Google's class review has not finished,
 * - Google's own API refused to create the object,
 * - this deployment is missing configuration it cannot invent,
 * - the issuer is still in demo mode, so a pass only reaches test accounts.
 *
 * Collapsing those into "no tenés tarjeta" is the specific failure this file
 * exists to make impossible. It tells a customer with a perfectly good account
 * that their account is the problem, and it sends them to support instead of to
 * the merchant who has to finish configuring something — while making the
 * platform's own state invisible, which is the information they actually need.
 *
 * Each code therefore gets its own title and its own message, because each has a
 * different remedy and a different audience: the merchant, Google, or us.
 *
 * And each one also declares **what it is allowed to offer**, because a refusal
 * has two halves and the second half used to be invented by the renderer: seven
 * of these ten codes are answered identically however many times the customer
 * taps, and the page was offering a retry on all of them. See `WalletRemedy` for
 * why that is a union rather than a flag, and for what stands in the button's
 * place when re-asking cannot help.
 *
 * ## What is deliberately not here
 *
 * The server's own `error.message`. Those are written for an operator or a log
 * reader — one of them quotes Google's raw error text verbatim, another names
 * an internal condition — and neither belongs on a page read on a phone. The
 * `code` is read; the prose is ours.
 */

/**
 * `customer_wallet_passes.state`, as `GET /v1/wallet/pass` and
 * `GET /v1/wallet/status` both report it.
 *
 * Narrow, and the wire is untyped: nothing stops the worker from adding a
 * seventh value, and this union cannot be checked against it because the two
 * packages do not share types. So the copy below is written so that a value this
 * union does not know falls to the first-add wording — the branch that claims
 * least — rather than to a claim about a card that may not be in a phone.
 *
 * `expired` and `completed` are listed for the vocabulary's sake. The route
 * refuses a terminal pass rather than returning one, so they cannot arrive on a
 * 200; they are what makes the list the schema's six states rather than the four
 * a 200 can carry.
 */
export type WalletPassState =
  | 'not_issued'
  | 'not_saved'
  | 'issued'
  | 'inactive'
  | 'expired'
  | 'completed';

/**
 * The `data` body of `GET /v1/wallet/pass`.
 *
 * Field names are the wire names: the handler answers a bare object literal with
 * snake_case keys. `points_currency` is nullable because it is copied from the
 * tenant's programme row and a pass cannot be built without one — so by the time
 * this arrives it is always set, and the type says so rather than claiming it.
 */
export interface WalletPass {
  /** Google's signed add-to-wallet link. Opened as-is; never rebuilt. */
  save_url: string;
  object_id: string;
  class_id: string;
  member_code: string;
  balance_points: number;
  points_currency: string;

  /**
   * Whether **this request** created the pass, as opposed to handing back one
   * that already existed.
   *
   * ## Why this field has to exist
   *
   * The worker stopped minting on every visit: a customer who already has a pass
   * is handed a freshly signed link for the object their row already records, and
   * nothing is created at Google. That is the right behaviour and it made the
   * response indistinguishable from a new issuance — same link, same fields, same
   * `200`.
   *
   * So the page cannot tell the two apart from anything else in this body.
   * `object_id` is identical by design: making it the same is what makes a
   * repeated request idempotent. And `save_url` differs only in its `iat` claim,
   * so comparing two of them tells you a request happened, not what it did.
   *
   * Without this field the page says "Agregala una vez" to a customer whose card
   * has been in their phone for a year, which is a small lie that a merchant
   * support question is built on top of.
   */
  already_existed: boolean;

  /**
   * `customer_wallet_passes.state` after the request, under the same vocabulary
   * `GET /v1/wallet/status` reports.
   *
   * ## Why `already_existed` is not enough on its own
   *
   * Because the three reused states need three different sentences. A pass in
   * `issued` is in the customer's phone and this page may say so. A pass in
   * `not_saved` is genuinely not there — we asked Google and it has no object — so
   * saying "you already have it" would be the same lie pointed the other way. A
   * pass in `inactive` is the same card with the customer's finger off the
   * switch.
   *
   * One boolean over those three would force a choice between lying to a
   * returning customer and lying to a first-time one.
   */
  pass_state: WalletPassState;
}

/**
 * What this refusal may offer the customer, having been asked to explain itself.
 *
 * ## Why this is a union and not a boolean
 *
 * Because the property worth holding is not "is a retry honest". It is that **the
 * control and the sentence above it agree** — and two independent fields cannot
 * hold that, because `can_retry: false` with no note is perfectly legal and is
 * exactly the defect: a refusal that cannot be retried, rendered with nothing to
 * do instead. A union deletes that state. `retry` cannot carry a note, and the
 * other three cannot be written without one.
 *
 * ## Why there are three answers that are not `retry`
 *
 * Because they are three different audiences, and the sentence that occupies the
 * slot has to be different for each: somebody is waiting on Google, somebody in
 * the commerce has to act, or we have to fix it. Collapsing them into one "no
 * retry" would have made the note a fourth thing to keep honest — and the note is
 * what stops a dead control from becoming a dead end.
 *
 * ## Why the note is a sentence and not a second control
 *
 * Because the only control that would make sense there is a way to reach a human,
 * and **this app has no support channel**. Inventing one — a `mailto:`, a
 * WhatsApp link, a phone number — would be inventing the destination as well as
 * the control, and a link to nowhere is worse than an honest absence. What the
 * customer can always do is tell the person standing next to them, so the note
 * says who has to act.
 */
export type WalletRemedy =
  /** Asking again can plausibly produce a different answer. */
  | { kind: 'retry' }
  /** Nobody has to act: a process outside this app is already under way. */
  | { kind: 'wait'; note: string }
  /** Somebody in the commerce has to do something about it. */
  | { kind: 'tell-anyone'; note: string }
  /** We have to fix it, and the customer has nothing to do. */
  | { kind: 'ours'; note: string };

/**
 * The three notes, stated once each.
 *
 * Shared because they are shared: six codes are waiting on the commerce to
 * configure something, and writing six sentences to say that would be six chances
 * to disagree. Kept short because they sit under a message that already carries
 * the explanation — their whole job is to answer "and what do I do now?", which
 * is what the button used to answer with a tap.
 *
 * ## Why none of them names a time
 *
 * "Pronto", "en un rato" and "más tarde" are promises about when something will
 * change, and nobody in this system knows. `WALLET_CLASS_NOT_APPROVED` is the case
 * that makes it concrete: the review may not have been submitted at all, so there
 * may be no queue to wait in. So these say what is true instead — that the tap
 * would not have helped, and who the next step belongs to.
 */
const WAIT_NOTE = 'No hace falta que hagas nada mientras tanto.';
const TELL_ANYONE_NOTE = 'Contale al comercio y lo resuelven.';
const OURS_NOTE = 'Esto lo tenemos que corregir nosotros.';

/** One refusal, rendered. Both halves are customer-facing copy. */
export interface WalletFailure {
  /** The server's stable code, echoed for the DOM and for a future support read. */
  code: string;
  /**
   * The HTTP status, or `0` when no response arrived.
   *
   * Carried rather than read, because the status cannot tell a merchant's
   * unfinished onboarding from a 500 in this deployment — both are `409` and
   * `500` respectively with nothing else to separate them — and the copy must
   * not be chosen from it.
   *
   * It is on the failure rather than discarded so a support reader can tell a
   * 409 apart from a 500 without a second lookup. A 409 is the merchant's
   * onboarding; a 500 is ours to fix; both are read on the phone by somebody who
   * has no way to tell them apart from the message alone.
   */
  status: number;
  title: string;
  message: string;
  /**
   * Whether this refusal may offer a retry, and what stands in its place when it
   * may not.
   *
   * Carried rather than re-derived in the component, for the same reason the copy
   * is: the decision belongs with the reasoning, and a component that asked
   * "should I show a button?" about a code it does not understand would be
   * guessing at exactly the thing this module exists to get right.
   */
  remedy: WalletRemedy;
}

/** What an entry in the map holds: the copy, and the verdict, both required. */
type WalletFailureCopy = Omit<WalletFailure, 'code' | 'status'>;

/**
 * The code `api.getWalletPass` throws for a 200 with no pass in it.
 *
 * Not a server state — the server has no such code — but a real one for a client,
 * and it lives in this module rather than in the caller for the reason the
 * delivery guard exists: a code is customer-facing copy the moment it decides a
 * message, so where codes are written is where copy is written. It is exported
 * rather than spelled at the throw site so a second spelling cannot drift away
 * from the one this file maps.
 *
 * Declared above `FAILURES` because the map below keys on it, and a computed key
 * reading a `const` that has not been initialised yet is a `ReferenceError` on
 * every import of this module.
 */
export const WALLET_RESPONSE_MALFORMED = 'WALLET_MALFORMED_RESPONSE';

/**
 * Every code this UI knows how to explain, what it is allowed to say, and what
 * it is allowed to offer.
 *
 * `order` is irrelevant; the exhaustiveness is the point. A code missing from
 * here does not fall through to a blank — it lands on the fallback below, which
 * is still an honest message and still refuses a retry it cannot promise.
 *
 * ## Why `remedy` is required and not optional
 *
 * Because that is the whole fix, expressed as a type. An entry that omits it does
 * not compile, so a new code cannot arrive without somebody deciding whether a
 * retry could help — and that decision cannot be deferred to whoever renders the
 * card, who would be guessing about a refusal they do not understand. This is the
 * structural guard; `wallet-remedy.test.ts` holds the same line at runtime by
 * demanding a written reason per code.
 *
 * ## How each verdict was reached
 *
 * From `workers/wallet/src/routes.ts`, not from how the code reads. "This one is
 * permanent" is a claim about the worker, and the worker is the only thing that
 * can settle it — the reason travels with each verdict for that reason.
 */
const FAILURES: Readonly<Record<string, WalletFailureCopy>> = {
  /**
   * The merchant never finished onboarding, so there is no class to build a pass
   * against. `issuance.ts` is explicit that this endpoint will not create one:
   * creating it here would start a human review from a customer's tap and still
   * fail, because a `draft` class cannot create an object. So the remedy is the
   * merchant's, and saying so is what lets a comensal escalate usefully.
   *
   * No retry. `routes.ts:964` refuses before a pass is ever built, and nothing
   * this app does between two taps finishes the commerce's onboarding.
   */
  WALLET_CLASS_NOT_PROVISIONED: {
    title: 'Este comercio todavía no tiene tarjeta',
    message:
      'Google Wallet todavía no está configurado para este comercio. Tu cuenta está bien y no tenés ' +
      'que hacer nada: es algo que el comercio tiene que terminar de configurar.',
    remedy: { kind: 'tell-anyone', note: TELL_ANYONE_NOTE },
  },

  /**
   * The class exists and Google has not approved it.
   *
   * ## Who this is for, and what they can actually do
   *
   * The action is the commerce's. The class is the merchant's Google resource and
   * submitting it for review is their step; nothing a comensal can do moves it.
   * Saying so is what makes this message useful rather than merely honest — they
   * can walk into the shop and say "your Google Wallet class is not submitted",
   * which is a fact the merchant may not know.
   *
   * ## Why it does not say a review is underway
   *
   * The previous wording was "Google está revisando la clase", and that is a
   * second lie rather than a first. `reviewStatus: 'draft'` means the class was
   * created and **not submitted**: there is no review running at Google, because
   * nobody has asked for one. Telling a comensal to wait for a queue that does
   * not exist wastes their time and hides the state worth relaying.
   *
   * ## Why it does not mention retrying
   *
   * The review is Google's and takes days. No number of retries from a phone
   * changes that, so "reintentá en un rato" is advice that cannot work — and a
   * comensal who follows it comes back to the same answer and concludes their own
   * account is the problem, which is the inversion this whole module refuses.
   *
   * What this branch changed is that it is now *reached*. The gate used to wave a
   * `draft` class through on `demo_mode` alone, so these tenants got a
   * `WALLET_PASS_NOT_CREATABLE` from Google's 404 with a retry promise attached.
   *
   * The verdict follows the wording, and it is the case that made the rest of this
   * file exist: `wait`, because the review is Google's and a comensal tapping a
   * button cannot move it. The note says they have nothing to do, which is true
   * whether the class was never submitted or is sitting in Google's queue.
   */
  WALLET_CLASS_NOT_APPROVED: {
    title: 'Google todavía no aprobó la tarjeta',
    message:
      'La clase del pase de este comercio todavía no fue aprobada por Google, y sin esa aprobación no ' +
      'se puede crear ninguna tarjeta. Es el comercio quien tiene que enviarla a revisión: esa revisión ' +
      'la hace Google, demora días y no depende de vos. Tu cuenta está bien y seguís acumulando y ' +
      'usando tus puntos en el local.',
    remedy: { kind: 'wait', note: WAIT_NOTE },
  },

  /**
   * The stored class id disagrees with the id derived from the business and
   * issuer ids. A data defect in our own tables; the customer cannot resolve it
   * and neither can the merchant, so the message names us.
   *
   * No retry: a defect in our own tables does not heal between two taps, and the
   * customer has nothing to do about it either way.
   */
  WALLET_CLASS_ID_MISMATCH: {
    title: 'No pudimos preparar la tarjeta',
    message:
      'Hay una inconsistencia en la configuración del comercio que tenemos que corregir. Tu cuenta ' +
      'está bien y tus puntos no cambian.',
    remedy: { kind: 'ours', note: OURS_NOTE },
  },

  /**
   * Google could not create the object, so there is no working link to produce.
   * The single most common 409 in production, and the one a customer is most
   * likely to hit on a good connection: Google's API having a bad minute.
   *
   * ## The one genuinely ambiguous verdict, and why it keeps the retry
   *
   * `routes.ts:763` is the `catch` around `client.insertObject`, and the comment
   * above it says so itself: the branch also catches `GoogleWalletAuthError` from
   * `mintAccessToken`, so **an invalid Google token here lands on this same
   * code**. One code therefore covers Google's API having a bad minute and a
   * deployment whose token has expired, and those want opposite answers.
   *
   * It keeps the retry for three reasons, none of them a claim to know:
   *
   * - the transient cause dominates. The comment at `routes.ts:235` calls this
   *   the most common 409 in production, and the bad-minute case is the one a
   *   customer on a good connection actually hits;
   * - the copy has always promised a retry, and this file exists so that copy and
   *   control agree. Changing the sentence would be a product decision made on a
   *   guess;
   * - when the cause is the token, a customer who taps once more sees the same
   *   sentence and escalates — which is what happens today, and is not made worse
   *   by the button.
   *
   * The honest move is to record the ambiguity where somebody adding the next code
   * will read it, which is what this paragraph and `wallet-remedy.test.ts` do.
   */
  WALLET_PASS_NOT_CREATABLE: {
    title: 'Google no pudo crear la tarjeta ahora',
    message:
      'Google no pudo generar el pase en este momento. Tu cuenta está bien y podés reintentar en un ' +
      'rato.',
    remedy: { kind: 'retry' },
  },

  /**
   * The balance is above what a pass can display. The one branch that is about
   * something about the customer's own record, so it is also the one that does
   * not say "your account is fine" — there is something real here, and the
   * remedy is a layout decision the merchant has to make. Saying otherwise would
   * be the same lie in the other direction.
   *
   * No retry: the remedy is a layout choice the commerce makes about its pass —
   * `balance.ts` refuses to truncate rather than display a rounded lie — and the
   * next request reads the same balance.
   */
  WALLET_BALANCE_NOT_DISPLAYABLE: {
    title: 'Tu saldo es más grande de lo que la tarjeta puede mostrar',
    message:
      'Este programa todavía no tiene una forma de mostrar saldos tan grandes en Google Wallet. Tus ' +
      'puntos están intactos y los podés usar en el local; el comercio necesita configurar otra ' +
      'presentación.',
    remedy: { kind: 'tell-anyone', note: TELL_ANYONE_NOTE },
  },

  /**
   * The pass reached a state Google does not undo, so it cannot be reissued.
   *
   * A different audience from every other branch and a different remedy. This one
   * is about **the customer's own card**, and the thing to be said plainly is
   * that the card is finished rather than that the card is missing: the first
   * would send them looking for something in their phone, the second would tell
   * them to add a card Google is not going to accept. Both are ways of being
   * wrong about a real person's wallet.
   *
   * So: what happened, that their account and points are untouched, and that the
   * business is the one who can resolve it. Not a promise that a new one is
   * coming — this worker refuses to mint over a terminal pass precisely because
   * Google cannot bring it back, and copy that implied otherwise would be the
   * retired "ya va a estar" mistake in new words.
   *
   * No retry, and this is the one where a retry would be most tempting and most
   * useless: `routes.ts:105` records that Google will not un-expire an object, and
   * that `object_id` is derived from the customer's `global_id`, so a fresh
   * request would be refused under **the same id**. There is nothing to ask again
   * for.
   */
  WALLET_PASS_TERMINAL: {
    title: 'Esta tarjeta ya no se puede volver a usar',
    message:
      'Google ya no permite reutilizar esta tarjeta porque su vigencia terminó. Tu cuenta y tus ' +
      'puntos están bien y los podés seguir usando en el local. Contale al comercio para que lo ' +
      'resuelvan.',
    remedy: { kind: 'tell-anyone', note: TELL_ANYONE_NOTE },
  },

  /**
   * A Google class with no programme to name a points currency in.
   *
   * No retry: `routes.ts:861` refuses because there is no points currency, and
   * the next request finds the same absent programme row.
   */
  LOYALTY_PROGRAM_NOT_CONFIGURED: {
    title: 'Este comercio todavía no configuró su programa',
    message:
      'El comercio tiene una tarjeta de Google Wallet pero todavía no configuró el programa de ' +
      'puntos que la tarjeta muestra. Tu cuenta está bien.',
    remedy: { kind: 'tell-anyone', note: TELL_ANYONE_NOTE },
  },

  /**
   * The worker is missing a value it cannot invent: an empty origins list, or a
   * member code that could not be obtained. A deployment fault with no customer
   * trigger.
   *
   * ## The verdict here used to be the opposite, and the reason was wrong
   *
   * This entry said "reintentá" on the grounds that the cause could be
   * transient. The worker says otherwise about its own code: `routes.ts:57` —
   * "this means this deployment is broken and no pass will ever work".
   *
   * And the two places that raise it are both permanent. `routes.ts:524` is
   * `WALLET_ALLOWED_ORIGINS` being empty, which is an environment variable. And
   * `routes.ts:906` is `MemberCodeUnavailableError`, whose own comment at
   * `routes.ts:897` says reaching it "means something is wrong with the pepper or
   * the row, not that the customer is unready".
   *
   * So the sentence lost its "podés reintentar más tarde" too, and that is the
   * only copy in this map that moved. It had to: with the button gone, keeping the
   * sentence would have left the page promising exactly what it now refuses to
   * offer, which is the same defect in the other layer.
   */
  WALLET_NOT_CONFIGURED: {
    title: 'La tarjeta no está disponible en este momento',
    message:
      'La integración con Google Wallet no está completa en este entorno. Tu cuenta está bien y tus ' +
      'puntos no cambian: es algo que tenemos que corregir nosotros.',
    remedy: { kind: 'ours', note: OURS_NOTE },
  },

  /**
   * The issuer still has no Google publishing access, so a pass reaches only the
   * issuer's own test accounts.
   *
   * This code does not currently reach `/v1/wallet/pass` — the route stopped
   * treating demo mode as a refusal — but it is a real state of this system and
   * it is the one a customer must never be left to discover from their own phone.
   * Handling it here means that if the worker ever returns it again, the page
   * already tells the truth instead of showing a link to a card the phone will
   * never display.
   */
  WALLET_DEMO_MODE: {
    title: 'Sólo funciona en cuentas de prueba',
    message:
      'Este comercio todavía no tiene acceso de publicación en Google Wallet, así que una tarjeta ' +
      'sólo llega a cuentas de prueba de Google. Tu cuenta está bien.',
    // No retry. `routes.ts:76` says it better than a comment here can: publishing
    // access "stays true *after* the class is approved", so neither waiting nor
    // asking again gets a real customer a real card.
    remedy: { kind: 'tell-anyone', note: TELL_ANYONE_NOTE },
  },

  [WALLET_RESPONSE_MALFORMED]: {
    title: 'La tarjeta llegó incompleta',
    message:
      'La respuesta que nos llegó no traía una tarjeta. Tu cuenta está bien y podés reintentar en un ' +
      'momento.',
    // Retry, and the strongest case for it in the file. This is not a server
    // state at all: `api.getWalletPass` throws it when a 200 arrived carrying no
    // `data`. Nothing is misconfigured and nothing is refused — the answer we got
    // was unusable, and asking again is the only remedy that exists.
    remedy: { kind: 'retry' },
  },
};

/**
 * Every code the map above holds.
 *
 * Exported for one reason: so a test can ask whether each one has been reasoned
 * about. `wallet-remedy.test.ts` compares this list against a table of verdicts
 * with a reason each, so an entry that compiles without anybody deciding whether
 * a retry could help is a failure rather than a silent default. The structural
 * half of the same guard is that `remedy` is required above, which fails
 * `pnpm -r typecheck` before the runtime guard is ever reached.
 */
export const WALLET_FAILURE_CODES: readonly string[] = Object.freeze(Object.keys(FAILURES));

/**
 * What to do about a code this file does not know.
 *
 * ## Why this was one branch and is now three
 *
 * It was one constant, and it promised "podés reintentar en un momento" for
 * everything: a code added after this file was written, a gateway that answered
 * with a body this system does not produce, and a request that never arrived at
 * all. Those are not one condition. A 500 of a dropped connection is transient. A
 * 500 of a bug here is not, and it will be produced again on every tap for as
 * long as the bug lives — so the promise was kept only in the case it was about,
 * and paid for by the other two.
 *
 * The split is on one fact, and it is the only fact available: **did an answer
 * arrive at all.** Nothing here guesses whether the cause is transient, because
 * nothing here can know.
 *
 * ## The verdicts, and why each is supportable
 *
 * - **No answer (`status` 0).** `wallet-card.tsx` substitutes 0 only when the
 *   rejection was not an `ApiError`, so no HTTP status was ever parsed: the
 *   request did not reach the API. Re-asking is not a hope here, it is the correct
 *   response to a question that was never delivered. Retry.
* - **The hop in between failed (502 / 503 / 504).** RFC 9110 defines these as
 *   statements about a gateway or an upstream — a bad response, a temporarily
 *   unavailable service, a gateway timeout — not about this application. A second
 *   request is a reasonable thing to offer rather than a promise about the card.
 *   Retry.
 * - **Anything else with an HTTP status.** A server answered, with a stable code
 *   this build does not know. A stable code is a code that will answer the same
 *   way next time, so retrying is provably useless. No retry, and no sentence
 *   asking the customer to.
 *
 * The first two share one sentence on purpose. Both are "we never got an answer
 * we could use", and inventing two near-identical paragraphs to separate them
 * would be copy written for a distinction the customer cannot act on — a support
 * reader has it anyway, in `data-wallet-status`.
 *
 * Both still name us, because the alternative — treating an unrecognised refusal
 * as evidence about the customer's account — is the exact inversion this module
 * refuses to make.
 */
const NO_ANSWER: WalletFailureCopy = {
  title: 'No pudimos preparar tu tarjeta',
  message:
    'No pudimos comunicarnos con el servicio al preparar tu tarjeta. Tu cuenta y tus puntos están ' +
    'bien; podés reintentar en un momento.',
  remedy: { kind: 'retry' },
};

const OURS: WalletFailureCopy = {
  title: 'No pudimos preparar tu tarjeta',
  message:
    'Hubo un problema de nuestro lado al preparar la tarjeta. Tu cuenta y tus puntos están bien; ' +
    'esto lo tenemos que corregir nosotros.',
  remedy: { kind: 'ours', note: OURS_NOTE },
};

/**
 * Statuses that describe the hop rather than this application.
 *
 * Named as a set rather than a bare `status >= 500`, because "5xx" is not the
 * claim: a 500 is this application saying it is broken, and that is precisely the
 * case the promise must not cover. Only the three statuses the HTTP spec defines
 * in terms of a gateway get the retry.
 */
const HOP_FAILURES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Explain one refusal, in the customer's language.
 *
 * Branches on `code` and never on `status` alone to pick the copy. The status
 * cannot tell a merchant's unfinished onboarding from a 500 in this deployment,
 * so it rides along on the result for a support reader.
 *
 * The one place `status` is read is the fallback, and only to ask whether an
 * answer arrived — see the two constants above.
 *
 * @param code   `error.code` from the gateway. May be absent or unrecognised.
 * @param status the HTTP status, or `0` for a request that never got one.
 */
export function walletFailureFor(code: string, status: number): WalletFailure {
  const known = FAILURES[code];

  if (known !== undefined) return { code, status, ...known };

  const unreachable = status === 0 || HOP_FAILURES.has(status);

  return { code: code || 'NO_RESPONSE', status, ...(unreachable ? NO_ANSWER : OURS) };
}

// ---------------------------------------------------------------------------
// A pass that came back — not a refusal
// ---------------------------------------------------------------------------

/** What the card says about a pass the API returned. Both halves are customer-facing. */
export interface WalletPassCopy {
  /** The sentence above the button. */
  note: string;
  /** The button's own label. */
  label: string;
}

/**
 * The one wording every state of a returned pass shares.
 *
 * Stated once so a copy change cannot land in one branch and miss the others, and
 * so the branches below are readable as differences rather than as three
 * paragraphs that happen to agree.
 */
const FIRST_ADD: WalletPassCopy = {
  note:
    'Tu tarjeta vive en Google Wallet. Agregala una vez y después usala en el local junto con tu ' +
    'código de socio.',
  label: 'Agregar a Google Wallet',
};

/**
 * The sentence for a pass that was already there.
 *
 * ## Why this is a function and not three branches inside the component
 *
 * For the same reason `walletFailureFor` is a module: the property worth holding
 * is not any one string, it is that no branch claims a card the customer does not
 * have. A renderer picks the branch; the wording is data, so a test can walk
 * every state and assert the property across all of them at once. A component
 * cannot do that without a DOM.
 *
 * ## The three cases, and what each is allowed to say
 *
 * - `already_existed: false` — this request created the pass. The plain
 *   first-add wording is the truth here.
 * - `issued` — Google has the object and the customer saved it, so the card
 *   really is on their phone. Saying so is the whole point of returning the
 *   field; the alternative is telling someone to add a card they added a year
 *   ago. The button stays, because the useful cases remain: they deleted it, or
 *   they are moving to a new phone.
 * - `inactive` — the same card, switched off. Not a new card and not a missing
 *   one, so the wording is about putting the existing one back.
 * - `not_saved`, `not_issued`, and any value this build does not know — we have
 *   no evidence the card is on their phone, so the least-claiming branch is the
 *   correct one. `not_saved` is the case that makes this a decision rather than a
 *   default: we asked Google and it has no object, so claiming they already have
 *   it would be the same lie pointed the other way.
 */
export function walletPassCopyFor(pass: WalletPass): WalletPassCopy {
  if (pass.already_existed && pass.pass_state === 'issued') {
    return {
      note:
        'Esta tarjeta ya está en tu Google Wallet. Usala en el local junto con tu código de socio; ' +
        'si la borraste, podés agregarla de nuevo.',
      label: 'Volver a agregar a Google Wallet',
    };
  }

  if (pass.already_existed && pass.pass_state === 'inactive') {
    return {
      note:
        'Esta tarjeta está desactivada en tu Google Wallet. Volvé a agregarla para usarla en el ' +
        'local junto con tu código de socio.',
      label: 'Volver a agregar a Google Wallet',
    };
  }

  return FIRST_ADD;
}
