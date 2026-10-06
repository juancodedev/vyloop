/**
 * The client half of the support channel: the payload, the field names, and the
 * limits — everything that can be decided without React.
 *
 * ## Why the form asks for nothing but a message
 *
 * `wallet-card.tsx` documents that the code and the status it renders are "not
 * logged, not sent, and no PII in either". This channel **sends** them, plus a
 * message a person wrote, so that rule is broken on purpose — and a broken rule
 * that nobody restates is a rule nobody notices breaking twice.
 *
 * The restated rule, short:
 *
 * - **What is collected**: a free-text message, and the code and status the card
 *   is already displaying. Nothing else.
 * - **What is not collected, and there is no field for it**: a name, an email
 *   address, a phone number, a member code, an account. Not "collected but
 *   optional" — *absent*, so there is nothing to redact later and nothing to leak.
 * - **The cost of that, stated rather than discovered**: the operator can read the
 *   message and cannot reply to it, and the customer gets no confirmation. Both
 *   are real losses, and both are cheaper than turning a public mail relay into a
 *   customer database. `buildSupportPayload`'s test holds the exact key set, so
 *   adding a contact field "to be able to reply" fails a test rather than
 *   shipping.
 *
 * ## Why the field names are declared here and on the server
 *
 * `SUPPORT_FIELDS` on both sides is one wire contract stated twice, because the
 * browser and a Cloudflare Worker cannot share a module. The names are asserted
 * against each other by reading, and both suites hold their half.
 */

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * Field names, matching `apps/gateway/src/support.ts`.
 *
 * `honeypot` is `company_website` because that is the name a bot's form-filling
 * heuristics reach for and a person's never does — it looks like a field on a real
 * business contact form, which is the whole technique.
 *
 * `turnstile` is fixed by Cloudflare's widget and is not ours to choose.
 */
export const SUPPORT_FIELDS = {
  code: 'wallet_code',
  status: 'wallet_status',
  message: 'message',
  honeypot: 'company_website',
  turnstile: 'cf-turnstile-response',
} as const;

/**
 * The same limits the server enforces.
 *
 * Duplicated on purpose and **not** as a control: `maxLength` and `minLength` on
 * the field exist so a person is stopped while typing rather than after a round
 * trip. The server is the control, and it is the half asserted against behaviour
 * in `apps/gateway/src/support.test.ts`.
 */
export const SUPPORT_LIMITS = {
  messageMin: 10,
  messageMax: 2000,
} as const;

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

/**
 * The widget's public site key.
 *
 * `NEXT_PUBLIC_*` is substituted at build time, so an unset variable arrives as
 * `undefined` rather than as an error. **There is deliberately no default.**
 *
 * Cloudflare publishes testing keys — `1x00000000000000000000AA` always passes,
 * `2x00000000000000000000AB` always fails — so integration tests can be written
 * before a widget exists. That is exactly why one of them must never be a
 * fallback here: a testing key in a production bundle makes the form look
 * protected while proving nothing, and it is the single most likely way this
 * route ends up unprotected in production while every test is green.
 *
 * With no key the form still renders and still says what is true; see
 * `support-form.tsx`.
 */
export const SUPPORT_SITE_KEY: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

/**
 * Normalise a configured site key.
 *
 * `NEXT_PUBLIC_*` is text substituted into the bundle, so a var set to an empty
 * string or to whitespace arrives as one. Treated as absent, because rendering a
 * widget with an empty `data-sitekey` looks like a broken page rather than an
 * absent feature — and this form has an honest way to say "not available".
 */
export function resolveSiteKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  return value.trim();
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export interface SupportPayloadInput {
  /** `WalletFailure.code`, passed as a value. Never spelled as a literal here. */
  code: string;
  /** `WalletFailure.status`. */
  status: number;
  /** The free text. The only PII in this product, and it goes one place. */
  message: string;
  /** Always `''` for a person. See the honeypot note in `support-form.tsx`. */
  website: string;
  /** The challenge token, or `''` when no widget is configured. */
  token: string;
}

/**
 * The request body, and its whole key set.
 *
 * Returned as a plain object rather than serialised here so the behaviour suite
 * can assert on what was sent, and so nothing about the message can be attached
 * to the URL — a query string would end up in `wrangler tail`, in browser history
 * and in any proxy log on the way.
 */
export function buildSupportPayload(input: SupportPayloadInput): Record<string, unknown> {
  return {
    [SUPPORT_FIELDS.code]: input.code,
    [SUPPORT_FIELDS.status]: input.status,
    [SUPPORT_FIELDS.message]: input.message,
    [SUPPORT_FIELDS.honeypot]: input.website,
    [SUPPORT_FIELDS.turnstile]: input.token,
  };
}

// ---------------------------------------------------------------------------
// The challenge
// ---------------------------------------------------------------------------

/**
 * The minimal shape of the widget global we rely on.
 *
 * Declared rather than reached through `any` so that a Turnstile release which
 * renames or drops `reset` is a type error here instead of a runtime `undefined is
 * not a function` in the one path a customer reaches when they are already
 * frustrated.
 */
interface TurnstileApi {
  reset(widgetId?: string | HTMLElement): void;
}

/**
 * Read the token the widget has issued.
 *
 * Turnstile's implicit render writes the token into a hidden input named
 * `cf-turnstile-response` and keeps it current for five minutes. Reading that input
 * at submit time is the whole contract — there is no callback to wire and no
 * reactive state to keep in sync.
 *
 * This exists because the form used to hold a `useRef` that was written nowhere:
 * `token.current` was always `''`, so every submission sent an empty token and the
 * gateway answered `403` to every customer. The widget rendered, looked correct,
 * and the channel had never once succeeded.
 *
 * Returns `''` when the widget is absent or has not issued a token yet. That is not
 * an error here — the gateway is the control and decides what an empty token means.
 */
export function readChallengeToken(doc: Document | undefined = globalThis.document): string {
  if (!doc) return '';

  const field = doc.querySelector<HTMLInputElement>(
    `input[name="${SUPPORT_FIELDS.turnstile}"]`,
  );

  return field?.value ?? '';
}

/**
 * Clear a spent token so the widget can issue another one.
 *
 * **Required for a retry to be possible at all.** Turnstile tokens are single-use,
 * and Cloudflare documents `600*` — the generic "bot behaviour detected" family —
 * as retryable, which presupposes the widget is reset. Without this a customer who
 * trips bot detection once is stuck for good: the form re-sends the same empty or
 * consumed token on every further attempt and the gateway refuses each one.
 *
 * Silence on failure is deliberate and not laziness: if the script has not loaded
 * there is no widget and nothing to reset, and if the global is missing the widget
 * is already unsolvable — both are states the submit path reports honestly on its
 * own. Throwing here would replace a usable error message with an exception.
 */
export function resetChallenge(doc: Document | undefined = globalThis.document): void {
  const api = (globalThis as { turnstile?: TurnstileApi }).turnstile;

  if (!api || typeof api.reset !== 'function') return;

  const widget = doc?.querySelector<HTMLElement>('.cf-turnstile');

  try {
    if (widget) api.reset(widget);
    else api.reset();
  } catch {
    // See above: a widget that cannot be reset is a widget that cannot solve, and
    // the next submit says so.
  }
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** What a successful send answers with. */
export interface SupportAccepted {
  status: 'accepted';
  /** Correlates with the gateway's log line. Not an echo of anything personal. */
  request_id: string;
}
