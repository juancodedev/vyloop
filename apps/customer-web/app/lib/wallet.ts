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
}

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
 * Every code this UI knows how to explain, and what it is allowed to say.
 *
 * `order` is irrelevant; the exhaustiveness is the point. A code missing from
 * here does not fall through to a blank — it lands on the "our side" branch
 * below, which is still an honest message.
 */
const FAILURES: Readonly<Record<string, Omit<WalletFailure, 'code' | 'status'>>> = {
  /**
   * The merchant never finished onboarding, so there is no class to build a pass
   * against. `issuance.ts` is explicit that this endpoint will not create one:
   * creating it here would start a human review from a customer's tap and still
   * fail, because a `draft` class cannot create an object. So the remedy is the
   * merchant's, and saying so is what lets a comensal escalate usefully.
   */
  WALLET_CLASS_NOT_PROVISIONED: {
    title: 'Este comercio todavía no tiene tarjeta',
    message:
      'Google Wallet todavía no está configurado para este comercio. Tu cuenta está bien y no tenés ' +
      'que hacer nada: es algo que el comercio tiene que terminar de configurar.',
  },

  /**
   * The class exists and Google's review has not finished it. A different
   * audience from the row above and a different remedy: this one is Google's
   * queue, nobody can hurry it, and saying so stops a comensal from asking the
   * merchant to fix something twice a day.
   *
   * Deliberately does not say the card is on its way. For a merchant whose class
   * never gets submitted at all, that is a promise nobody can keep — which is
   * exactly the claim the retired delivery guard used to be about, and this
   * message has to not make it.
   */
  WALLET_CLASS_NOT_APPROVED: {
    title: 'La tarjeta todavía está en revisión',
    message:
      'Google está revisando la clase del pase de este comercio y no se puede usar hasta que la ' +
      'apruebe. Tu cuenta está bien. Mientras tanto seguís acumulando y usando tus puntos en el local.',
  },

  /**
   * The stored class id disagrees with the id derived from the business and
   * issuer ids. A data defect in our own tables; the customer cannot resolve it
   * and neither can the merchant, so the message names us.
   */
  WALLET_CLASS_ID_MISMATCH: {
    title: 'No pudimos preparar la tarjeta',
    message:
      'Hay una inconsistencia en la configuración del comercio que tenemos que corregir. Tu cuenta ' +
      'está bien y tus puntos no cambian.',
  },

  /**
   * Google could not create the object, so there is no working link to produce.
   * The single most common 409 in production, and the one a customer is most
   * likely to hit on a good connection: Google's API having a bad minute.
   */
  WALLET_PASS_NOT_CREATABLE: {
    title: 'Google no pudo crear la tarjeta ahora',
    message:
      'Google no pudo generar el pase en este momento. Tu cuenta está bien y podés reintentar en un ' +
      'rato.',
  },

  /**
   * The balance is above what a pass can display. The one branch that is about
   * something about the customer's own record, so it is also the one that does
   * not say "your account is fine" — there is something real here, and the
   * remedy is a layout decision the merchant has to make. Saying otherwise would
   * be the same lie in the other direction.
   */
  WALLET_BALANCE_NOT_DISPLAYABLE: {
    title: 'Tu saldo es más grande de lo que la tarjeta puede mostrar',
    message:
      'Este programa todavía no tiene una forma de mostrar saldos tan grandes en Google Wallet. Tus ' +
      'puntos están intactos y los podés usar en el local; el comercio necesita configurar otra ' +
      'presentación.',
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
   */
  WALLET_PASS_TERMINAL: {
    title: 'Esta tarjeta ya no se puede volver a usar',
    message:
      'Google ya no permite reutilizar esta tarjeta porque su vigencia terminó. Tu cuenta y tus ' +
      'puntos están bien y los podés seguir usando en el local. Contale al comercio para que lo ' +
      'resuelvan.',
  },

  /** A Google class with no programme to name a points currency in. */
  LOYALTY_PROGRAM_NOT_CONFIGURED: {
    title: 'Este comercio todavía no configuró su programa',
    message:
      'El comercio tiene una tarjeta de Google Wallet pero todavía no configuró el programa de ' +
      'puntos que la tarjeta muestra. Tu cuenta está bien.',
  },

  /**
   * The worker is missing a value it cannot invent: an empty origins list, or a
   * member code that could not be obtained. A deployment fault with no customer
   * trigger, and the one branch where "reintentá" is honest because the cause
   * really can be transient.
   */
  WALLET_NOT_CONFIGURED: {
    title: 'La tarjeta no está disponible en este momento',
    message:
      'La integración con Google Wallet no está completa en este entorno. Tu cuenta está bien y podés ' +
      'reintentar más tarde.',
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
  },

  [WALLET_RESPONSE_MALFORMED]: {
    title: 'La tarjeta llegó incompleta',
    message:
      'La respuesta que nos llegó no traía una tarjeta. Tu cuenta está bien y podés reintentar en un ' +
      'momento.',
  },
};

/**
 * The branch for anything this file does not know: a code added after it was
 * written, a gateway that answered with a body this system does not produce, or
 * a request that never arrived at all (`status` 0).
 *
 * All three are *our* problem by default, because the alternative — treating an
 * unrecognised refusal as evidence about the customer's account — is the exact
 * inversion this module refuses to make. So the copy names us, and it says the
 * account is fine, which is the one claim every branch here can support.
 */
const OURS: Omit<WalletFailure, 'code' | 'status'> = {
  title: 'No pudimos preparar tu tarjeta',
  message:
    'Hubo un problema de nuestro lado al preparar la tarjeta. Tu cuenta y tus puntos están bien; ' +
    'podés reintentar en un momento.',
};

/**
 * Explain one refusal, in the customer's language.
 *
 * Branches on `code` and never on `status` alone. The status cannot tell a
 * merchant's unfinished onboarding from a 500 in this deployment, so it rides
 * along on the result for a support reader and never picks the copy.
 *
 * @param code   `error.code` from the gateway. May be absent or unrecognised.
 * @param status the HTTP status, or `0` for a request that never got one.
 */
export function walletFailureFor(code: string, status: number): WalletFailure {
  const known = FAILURES[code];

  return known === undefined
    ? { code: code || 'NO_RESPONSE', status, ...OURS }
    : { code, status, ...known };
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
