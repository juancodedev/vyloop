/**
 * What the POS says about a customer's Google Wallet pass.
 *
 * ## Why this lives outside the page
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs
 * in `node`: a component cannot be rendered, so wording left inside one is
 * untestable wording. This is a pure module for the same reason
 * `lib/loyalty-points.ts` is one — the decision is worth more than the
 * rendering, and the decision has to be checkable.
 *
 * ## The distinction this exists to preserve
 *
 * `not_issued` and `not_saved` look like two labels for one fact. They are not,
 * and three places in the codebase say so independently:
 *
 * - `packages/db/src/schema.ts`: `not_issued` is "a save link was issued and no
 *   Google object has been observed"; `not_saved` is "Google was asked and has no
 *   object".
 * - `workers/wallet/src/routes.ts`: "`not_issued` means we have never checked".
 * - `workers/wallet/src/callbacks.ts`: `not_saved` is "the most definite answer
 *   this system can ever receive about a pass".
 *
 * So `not_issued` is a gap in **our** knowledge and `not_saved` is a fact about
 * **the customer's** phone. Rendering them with the same words tells a merchant
 * we checked when we did not — which is the one thing this screen must not do.
 *
 * `null` is a third thing again and is not a pass state: no row exists, so no
 * save link was ever issued. It gets its own copy rather than borrowing the
 * vocabulary of the other two.
 */

/**
 * Every pass state the `customer_wallet_passes.state` column can hold, plus
 * `null` for "no row at all".
 *
 * The column is `text` with no CHECK constraint on purpose — the schema's own
 * note is that "readers must fail closed on an unrecognised value rather than
 * the database refusing to store one". `presentPass` honours that.
 */
export type PassState =
  | 'not_issued'
  | 'not_saved'
  | 'issued'
  | 'inactive'
  | 'expired'
  | 'completed'
  | null;

/**
 * What the wire can actually carry: a known state, or a string some other deploy
 * added after this one shipped.
 *
 * The column has no CHECK constraint precisely so a new state does not need a
 * migration, which means readers must survive one. Typing the wire value as
 * `PassState` would force a cast at the boundary and invite someone to narrow it
 * with a default — turning "we added a state" into "everything is fine".
 * `string & {}` keeps editor completion for the known values while still
 * accepting the unknown ones.
 */
export type WirePassState = PassState | (string & {});

export type PassTone = 'ok' | 'warn' | 'unknown';

export interface PassPresentation {
  /** Short enough for a badge. */
  label: string;
  /** One sentence saying what is actually known, and who does not know it yet. */
  detail: string;
  tone: PassTone;
  /**
   * True when Google has never given us a definite answer.
   *
   * The UI must not describe the customer as having no pass while this is true,
   * whatever else it renders.
   */
  unverified: boolean;
  /** ISO timestamp of the last definite answer, or `null` if there is none. */
  checkedOn: string | null;
}

/**
 * Sentences that assert the customer has no pass.
 *
 * Illegal for any state where `unverified` is true. Exported so the guard is one
 * shared list rather than a phrase repeated in a test and forgotten in the copy.
 */
export const ABSENCE_CLAIMS: readonly string[] = [
  'no tiene',
  'no lo tiene',
  'no posee',
  'no cuenta con',
  'sin tarjeta',
];

/** Whether `text` tells the reader the customer has no pass. */
export function claimsAbsence(text: string): boolean {
  const lower = text.toLowerCase();
  return ABSENCE_CLAIMS.some((claim) => lower.includes(claim));
}

/** Shared fallback: we do not know, and we say so. */
const UNVERIFIED: PassPresentation = {
  label: 'Pase sin comprobar',
  detail:
    'Todavía no lo comprobamos con Google. Si el cliente lo guardó, lo vamos a saber en la próxima sincronización.',
  tone: 'unknown',
  unverified: true,
  checkedOn: null,
};

const COPY: Record<
  Exclude<PassState, null>,
  { label: string; detail: string; tone: PassTone; unverified: boolean }
> = {
  // Google says the object exists. The one state we know is good.
  issued: {
    label: 'Pase activo',
    detail: 'Google confirma que el cliente tiene el pase en su teléfono.',
    tone: 'ok',
    unverified: false,
  },

  // We asked, and there is no object. A fact about the customer — so it is
  // stated plainly rather than softened into "we don't know".
  not_saved: {
    label: 'Pase no guardado',
    detail: 'Comprobado con Google: el cliente todavía no guardó el pase.',
    tone: 'warn',
    unverified: false,
  },

  // OUR gap. A link went out and we have never seen an object. The copy has to
  // put the uncertainty on our side of the counter, where it belongs.
  not_issued: {
    label: 'Pase sin comprobar',
    detail:
      'Todavía no lo comprobamos: le enviamos el enlace para guardar el pase y aún no tenemos respuesta de Google.',
    tone: 'unknown',
    unverified: true,
  },

  inactive: {
    label: 'Pase inactivo',
    detail: 'El pase existe, pero Google no lo reporta como activo.',
    tone: 'warn',
    unverified: false,
  },

  expired: {
    label: 'Pase vencido',
    detail: 'El pase ya no está vigente.',
    tone: 'warn',
    unverified: false,
  },

  completed: {
    label: 'Pase completado',
    detail: 'Google marcó el pase como completado.',
    tone: 'warn',
    unverified: false,
  },
};

/** No row: no save link was ever issued. Not the same as a link that was ignored. */
const NEVER_ISSUED: PassPresentation = {
  label: 'Nunca se emitió el pase',
  detail: 'No le enviamos nunca el enlace para guardar el pase, así que no hay nada que comprobar.',
  tone: 'unknown',
  unverified: true,
  checkedOn: null,
};

/**
 * Turn a stored pass state into copy a cashier can act on.
 *
 * Fails closed on an unrecognised state: an added state reads as "not checked"
 * rather than as "fine", because `unknown` costs a follow-up and a wrong `ok`
 * costs a merchant's trust.
 */
export function presentPass(
  state: WirePassState,
  lastSyncedAt?: string | null,
): PassPresentation {
  const checkedOn = lastSynced(lastSyncedAt);

  // Narrowed rather than indexed directly: `WirePassState` includes strings
  // this build has never heard of, and the whole point is that one of those
  // falls through to the fail-closed copy instead of reading as `undefined`.
  const base =
    state === null
      ? NEVER_ISSUED
      : Object.prototype.hasOwnProperty.call(COPY, state)
        ? COPY[state as Exclude<PassState, null>]
        : undefined;

  if (base === undefined) {
    // Fail closed — see the doc comment. The value is named so a support ticket
    // can quote it, and the copy still claims nothing about the customer's phone.
    return {
      ...UNVERIFIED,
      detail: `No reconocemos el estado guardado del pase ("${String(state)}"), así que no afirmamos nada sobre él.`,
      checkedOn,
    };
  }

  return { ...base, checkedOn };
}

/** Normalise the timestamp the API sends, tolerating a missing or unusable one. */
function lastSynced(value?: string | null): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : value;
}
