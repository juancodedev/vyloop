/**
 * `POST /v1/support` — the channel `apps/customer-web` did not have.
 *
 * ## Why this exists
 *
 * PR #180 took the "Reintentar" button off the seven refusals where re-asking
 * provably cannot help, and replaced it with a sentence saying who has to act.
 * The copy is right and the situation is a dead end: the person reading it has
 * nowhere to write.
 *
 * The motivating case is `WALLET_CLASS_NOT_APPROVED` — "the loyalty class for this
 * merchant has not been approved yet". It is not the reader's fault, **they have
 * no account** (the registration is what failed), and there is no one to write
 * to. So this route cannot require a session: requiring one would exclude
 * precisely the person who needs it.
 *
 * ## Why it lives in the gateway and not in the wallet worker
 *
 * Three reasons, and the first one is the decisive one.
 *
 * 1. **The gateway is the only place that can enforce the two properties this
 *    route cannot do without.** `isPublicApiPath` is the auth exemption and
 *    `anonymousLimits` is the limit, both in `index.ts`. Putting the route in the
 *    wallet worker means naming the path in three packages — the worker's
 *    `PUBLIC_PATHS`, the gateway's `isPublicApiPath`, the gateway's
 *    `anonymousLimits` — and the gateway **cannot import `@vyloop/wallet`**, so
 *    that agreement is only assertable by reading source. PR #167 shipped a
 *    public route in the wallet worker that missed one of the two exemptions and
 *    answered 401 *invisibly*, because the request was unsigned exactly like a
 *    real Google delivery. PR #169 then deleted the only cross-package guard for
 *    it, and rebuilding one was a whole later change.
 * 2. **The path has to be under `/v1/*`, or the limiter never runs.** All five
 *    gateway middlewares are registered with `app.use('/v1/*', …)`. A route
 *    outside that prefix is public *and unthrottled*, structurally and invisibly.
 * 3. **It is not a wallet concept.** No tenant, no pass, no database. Every
 *    wallet route opens a tenant session, and the premise here is that the writer
 *    has no tenant to open one for.
 *
 * The argument that it belongs to the wallet worker — "the worker owns the
 * concept" — does not survive inspection. The server must accept a code it has
 * never heard of without breaking, so it does not need the closed set; and the
 * closed set lives in `apps/customer-web/app/lib/wallet.ts` anyway, which the
 * gateway cannot reach either.
 *
 * ## The three anti-spam layers, and how each one fails
 *
 * A public form that sends mail **is a relay**, and the cost is not the sends: it
 * is that the inbox becomes unreadable and the real customers stop being read.
 *
 *   1. **Rate limit** (`index.ts`, `anonymousLimits`). Fails open in exactly one
 *      way: the limiter *skips* any route absent from `anonymousLimits`, so a new
 *      public route with no number is not "defaulted" — it is unbounded, and
 *      nothing logs that. Hence `support-limits.contract.test.ts`, which asserts
 *      every exact-match public path carries a number. That guard exists because
 *      this hole was once papered over with an exemption and the exemption was
 *      the bug.
 *   2. **Honeypot.** Fails by being answered as a success: the response is
 *      byte-identical to a real one, so a bot cannot tell which branch it hit and
 *      has no gradient to learn from. Nothing is sent, nothing is stored, and
 *      nothing is logged about the message.
 *   3. **Turnstile**, verified server-side. Fails closed. A missing, invalid or
 *      expired token sends nothing — and so does a **missing secret**, because
 *      the check is not wrapped in `if (secret)`. Without the var this route
 *      answers 503 and sends nothing, rather than skipping verification and
 *      looking identical to a protected deployment.
 *
 * The order is honeypot, then Turnstile, then validation, and it is deliberate: a
 * bot that filled the honeypot must not be able to make us pay for a siteverify
 * round trip, and must not learn from a 400 that its message was too long.
 *
 * ## The PII rule this file breaks on purpose, and holds anyway
 *
 * `wallet-card.tsx` documents that nothing it renders is logged, sent, or PII —
 * "a code and a status are the whole payload and both are drawn from a closed
 * set". **This route breaks that rule**, because it carries a message a person
 * wrote. So the rule is restated here as an explicit, reviewable contract:
 *
 * - **What leaves this worker**: `wallet_code` (sanitised, bounded), `wallet_status`
 *   (a number), `message` (bounded), plus a server-generated `request_id` and
 *   timestamp for triage. That is the whole body of the mail.
 * - **What does not, and there is no field for it**: no name, no email address, no
 *   phone, no member code, no tenant, no JWT, no IP. The form has no such inputs,
 *   so there is nothing to redact later. The cost of that is real and stated: the
 *   operator can read the message and **cannot reply to it**, and the customer
 *   gets no confirmation. Anonymous-by-construction was preferred over a
 *   half-collected contact field.
 * - **The free text is unfiltered PII and goes nowhere but the mail body.** Not
 *   into a log, not into `console.error`, not into a `data-*` attribute, not into
 *   a response, not into an error object that `index.ts`'s `onError` would log.
 *   `support.test.ts` asserts this with a distinctive sentinel and reads every
 *   console call on the success, refusal and exception paths.
 * - **Resend's response body is never read.** On a 422 Resend echoes the
 *   submitted payload — the customer's message — back in the body. Only the HTTP
 *   status is used. This is the one place the leak would have happened by default.
 * - **Caught errors are logged by `name` only**, never by object and never by
 *   message. That costs a stack trace on the send path and is the trade made
 *   deliberately: the failure we care about is "Resend is unreachable or refused
 *   us", and the status or the error name says which. Anyone who later wants the
 *   stack has to redaction-check it deliberately rather than inherit it.
 * - **Lengths are enforced here, not in the client.** `SUPPORT_LIMITS`, below.
 * - **Nothing is stored.** There is no ticket table, and adding one is a different
 *   product with retention, deletion and access-control obligations. The
 *   consequence is stated rather than engineered around: when Resend fails the
 *   message is lost, and the customer is told so.
 *
 * ## What the customer sees when the send fails
 *
 * A 502 whose copy says the message did not arrive, and which asks them to tell
 * whoever is at the counter. Not "gracias, lo recibimos" — that would be a lie
 * about the one thing this route exists to do, told to the one person who cannot
 * check it.
 */

import type { Context } from 'hono';

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/**
 * Where the form posts.
 *
 * Under `/v1/*` on purpose: the gateway registers auth, auth-inject, business-id,
 * rate-limit and routing with `app.use('/v1/*', …)`, so a path outside that
 * prefix would be public *and* unthrottled without anybody writing an exemption.
 * `routerMiddleware` also 404s any `/v1/*` path that no `ROUTE_MAP` prefix
 * matches, so `index.ts` gives this one a `binding: 'gateway'` entry and the
 * ingestor's treatment — the middleware defers with `next()` and the handler here
 * runs.
 */
export const SUPPORT_PATH = '/v1/support';

/**
 * Messages allowed per window, per client address.
 *
 * Five a minute would do; **three** is chosen because the person who writes here
 * has already been told something went wrong and is writing once, and a second
 * attempt after a validation slip is the only legitimate repeat. `SIGNUP_LIMIT_PER_WINDOW`
 * is five and signup costs a 100k-iteration key derivation — this route costs an
 * outbound HTTP call and a mail, which is the cheaper thing to bound and the more
 * expensive thing to get wrong, because the damage lands in an inbox.
 *
 * Keyed by `CF-Connecting-IP`, which the edge sets and a caller cannot forge.
 */
export const SUPPORT_LIMIT_PER_WINDOW = 3;

// ---------------------------------------------------------------------------
// Field names and limits
// ---------------------------------------------------------------------------

/**
 * The wire names.
 *
 * Named here rather than at the call site so the customer-web form and this route
 * have one spelling each. `company_website` is the honeypot and `cf-turnstile-
 * response` is the name Turnstile's widget posts under, which is fixed by
 * Cloudflare and not ours to choose.
 */
export const SUPPORT_FIELDS = {
  code: 'wallet_code',
  status: 'wallet_status',
  message: 'message',
  honeypot: 'company_website',
  turnstile: 'cf-turnstile-response',
} as const;

/**
 * Maximums, enforced on the server because the client is not a control.
 *
 * `code` is 64: the longest code in `WALLET_FAILURE_CODES` is well under half of
 * that, so this bounds an unknown one without constraining a real future code.
 *
 * `messageMin` is the `min` half of the pair. A relay sends a one-word message
 * because it costs the same as a real one; ten characters is below what anybody
 * types to describe a problem and above "hola". It is the cheapest of the three
 * layers and the only one that costs a real person nothing.
 *
 * `turnstileTokenMax` is the documented siteverify maximum of 2048. A longer
 * token is either a bug or an attempt to push a large body through a request that
 * has no reason to carry one.
 */
export const SUPPORT_LIMITS = {
  code: 64,
  messageMin: 10,
  messageMax: 2000,
  turnstileTokenMax: 2048,
} as const;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything this route reaches outside itself.
 *
 * Injected so a test can run the real handler against a scripted Resend and a
 * scripted siteverify. `RESEND_API_KEY` does not exist in this environment, so
 * the end-to-end send is unverified and the only honest way to test any of it is
 * to refuse to depend on the network at all.
 */
export interface SupportDeps {
  fetch: typeof fetch;
  now: () => Date;
  newId: () => string;
}

/** The configuration this route reads. Every field is absent-tolerant. */
export interface SupportEnv {
  /** Resend bearer token. Absent means the route does not send; see the note above. */
  RESEND_API_KEY?: string | undefined;
  /** A Resend domain that has been verified. Never defaulted — see `wrangler.jsonc`. */
  SUPPORT_EMAIL_FROM?: string | undefined;
  /** The inbox a human reads. */
  SUPPORT_EMAIL_TO?: string | undefined;
  /** Turnstile widget secret. Absent means verification is refused, never skipped. */
  TURNSTILE_SECRET_KEY?: string | undefined;
}

/** Turnstile's siteverify endpoint. Fixed by Cloudflare. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Resend's send endpoint. Fixed by them; the key is ours. */
const RESEND_URL = 'https://api.resend.com/emails';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Why a submission was refused. Carries no part of the value that broke it. */
export type SupportRejection =
  | 'body-not-object'
  | 'code-not-a-string'
  | 'code-too-long'
  | 'status-not-a-number'
  | 'message-not-a-string'
  | 'message-too-short'
  | 'message-too-long';

export type ParsedSubmission =
  | { kind: 'accepted'; code: string; status: number; message: string }
  | { kind: 'invalid'; reason: SupportRejection };

/** Control characters, stripped from anything that will be shown or logged. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Strip control characters.
 *
 * Applied to the code before it is used, because the code is attacker-controlled
 * and reaches a mail **subject** and a **log line**. Resend takes JSON so there is
 * no header-injection primitive here — this is not fixing an exploit, it is
 * refusing to hand a support reader a subject containing CRLF and a log reader a
 * forged line.
 *
 * The free text is **not** stripped. Someone's message may legitimately contain a
 * line break, and it is never used as a subject or a log value.
 */
function sanitize(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate a submission, or say which rule it broke.
 *
 * The `wallet_code` is treated as **opaque**. It is not checked against
 * `WALLET_FAILURE_CODES`, deliberately, for two reasons: that set belongs to
 * `apps/customer-web/app/lib/wallet.ts` and this worker cannot reach it, and it
 * grows whenever a refusal is added — a check against a copy would reject real
 * reports the moment the two drifted. An unrecognised code is still the truth
 * about what the reader saw, and it is what makes this endpoint work for a
 * refusal added next month without a deploy.
 *
 * Never returns the value it rejected. The reason string is the whole output, so
 * nothing that reaches a log or a response can carry the message.
 */
export function parseSupportSubmission(body: unknown): ParsedSubmission {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'invalid', reason: 'body-not-object' };
  }

  const record = body as Record<string, unknown>;

  const rawCode = readString(record, SUPPORT_FIELDS.code);
  if (rawCode === undefined) return { kind: 'invalid', reason: 'code-not-a-string' };
  if (rawCode.length > SUPPORT_LIMITS.code) return { kind: 'invalid', reason: 'code-too-long' };

  const status = record[SUPPORT_FIELDS.status];
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return { kind: 'invalid', reason: 'status-not-a-number' };
  }

  const message = readString(record, SUPPORT_FIELDS.message);
  if (message === undefined) return { kind: 'invalid', reason: 'message-not-a-string' };
  if (message.length > SUPPORT_LIMITS.messageMax) return { kind: 'invalid', reason: 'message-too-long' };
  if (message.trim().length < SUPPORT_LIMITS.messageMin) {
    return { kind: 'invalid', reason: 'message-too-short' };
  }

  return { kind: 'accepted', code: sanitize(rawCode), status, message };
}

// ---------------------------------------------------------------------------
// The mail
// ---------------------------------------------------------------------------

export interface SupportEmailInput {
  code: string;
  status: number;
  message: string;
  requestId: string;
  receivedAt: Date;
}

/**
 * Build the mail.
 *
 * ## Why the subject carries no free text
 *
 * Subjects appear in list views, notification previews and search results — three
 * surfaces the message does not need to be on, each with a different reader and a
 * different retention. The code is the only client-supplied string in the subject
 * precisely because it is the one that has already been on screen, so it adds no
 * new exposure.
 *
 * ## What is in the body
 *
 * Every field is labelled. The reader is one person at an inbox who will
 * recognise `WALLET_CLASS_NOT_APPROVED` from the screenshot the customer is
 * holding, and the free text is fenced below a rule so a message that quotes the
 * labels cannot be mistaken for one.
 *
 * No `reply_to`: nothing here knows who sent it. See the module note — that is a
 * consequence of not collecting an address, chosen rather than overlooked.
 */
export function buildSupportEmail(input: SupportEmailInput): { subject: string; text: string } {
  const { code, status, message, requestId, receivedAt } = input;

  const text = [
    'A customer wrote from the card screen because it could not give them a card.',
    '',
    `Wallet code:    ${code}`,
    `HTTP status:    ${status}`,
    `Request id:     ${requestId}`,
    `Received at:    ${receivedAt.toISOString()}`,
    '',
    'Message from the customer:',
    '----------------------------------------',
    message,
    '----------------------------------------',
    '',
    'No account, email address or phone number was collected, so this cannot be',
    'replied to directly. If the person is at a counter, the merchant can act.',
    'The code and the status are also in the page they were looking at.',
  ].join('\n');

  return { subject: `[support] ${code} · ${status}`, text };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The one line this route logs, and the whole of it.
 *
 * `message` is not a parameter and cannot become one without changing this
 * signature, which is the point: the PII rule is enforced by the shape of the
 * function rather than by remembering not to use a variable that is in scope.
 *
 * The code is logged **after** `sanitize`, so a bot cannot forge a log line by
 * putting CRLF in it.
 */
function logOutcome(requestId: string, outcome: string, code?: string, status?: number): void {
  const codePart = code === undefined ? '' : ` code=${JSON.stringify(code)}`;
  const statusPart = status === undefined ? '' : ` status=${status}`;

  console.log(`[gateway] support request_id=${requestId} outcome=${outcome}${codePart}${statusPart}`);
}

/**
 * The failure envelope.
 *
 * The `message` strings are written for the person reading the screen, and they
 * never name a field, a variable, or a service. A 400 that said which field was
 * wrong would be a map of the validation; a 503 that said which var was unset
 * would be a configuration probe.
 */
function fail(
  c: Context,
  status: 400 | 403 | 502 | 503,
  code: string,
  message: string,
  requestId: string,
): Response {
  return c.json({ error: { code, message, request_id: requestId } }, status);
}

/**
 * The body a bot and a person receive alike.
 *
 * `202` rather than `200`: the request was accepted for delivery and we have not
 * promised an inbox. Used unchanged for a honeypot drop, which is the deception
 * layer working — a bot that could tell would stop filling the field.
 */
function accepted(c: Context, requestId: string): Response {
  return c.json({ status: 'accepted', request_id: requestId }, 202);
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

/**
 * Ask Cloudflare whether the token is genuine.
 *
 * **Server-side, always.** The widget is a UI convenience; a token is a string an
 * attacker can invent, so the only question worth asking is Cloudflare's.
 *
 * `remoteip` is forwarded because it is the one signal siteverify has that we
 * would otherwise throw away, and it comes from `CF-Connecting-IP`, which the
 * edge sets.
 *
 * Never throws and never returns a reason: a failure here is a refusal to send,
 * and the caller tells the customer only that. An exception would reach
 * `index.ts`'s `onError`, which logs the error object.
 */
async function verifyTurnstile(
  deps: SupportDeps,
  secret: string,
  token: string,
  remoteip: string | undefined,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteip !== undefined && remoteip !== '') body.set('remoteip', remoteip);

  try {
    const response = await deps.fetch(SITEVERIFY_URL, { method: 'POST', body });
    const result = (await response.json()) as { success?: unknown };

    return result?.success === true;
  } catch {
    // Network failure, a non-JSON answer, a proxy error. All of them mean the same
    // thing to us: the challenge was not proven, so nothing is sent.
    return false;
  }
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * The route handler.
 *
 * A factory rather than a bare handler so both dependencies are injectable, which
 * is the only reason any of the anti-spam behaviour below is testable without a
 * Resend account or a Turnstile widget — and neither of those exists here.
 *
 * ## Why it never throws
 *
 * `index.ts`'s `onError` logs the error object it is handed. A rejection
 * carrying the customer's message would be written to retained logs by machinery
 * that predates this route. Every branch here therefore returns, and the two
 * places that could throw — reading the body and calling Resend — are wrapped.
 */
export function supportRoute(deps: SupportDeps) {
  return async (c: Context): Promise<Response> => {
    const requestId = deps.newId();
    const env = c.env as SupportEnv;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, 'SUPPORT_INVALID', 'No pudimos leer el mensaje.', requestId);
    }

    // --- Layer 2: the honeypot, first and silently -------------------------
    //
    // Before Turnstile so a bot cannot make us pay for a verification, and before
    // validation so it cannot learn from a 400 that its payload was malformed.
    // The answer is the success answer, byte for byte.
    const honeypot =
      typeof body === 'object' && body !== null
        ? readString(body as Record<string, unknown>, SUPPORT_FIELDS.honeypot)
        : undefined;

    if (honeypot !== undefined && honeypot.trim() !== '') {
      logOutcome(requestId, 'dropped-honeypot');
      return accepted(c, requestId);
    }

    // --- Configuration, failing closed -------------------------------------
    //
    // Both halves, and neither is defaulted. There is no verified Resend domain
    // in this project yet and no Turnstile widget, so an unconfigured deployment
    // is the real state — and it must be a 503 that sends nothing, not a silent
    // skip. In particular the secret is **not** checked with `if (secret)`: that
    // one `if` is the difference between a protected form and an open one that
    // looks identical from the outside.
    const resendReady =
      isSet(env.RESEND_API_KEY) && isSet(env.SUPPORT_EMAIL_FROM) && isSet(env.SUPPORT_EMAIL_TO);

    if (!isSet(env.TURNSTILE_SECRET_KEY) || !resendReady) {
      logOutcome(requestId, 'unconfigured');
      return fail(
        c,
        503,
        'SUPPORT_UNAVAILABLE',
        'El canal de soporte no está disponible en este momento. Contale al comercio.',
        requestId,
      );
    }

    // --- Layer 3: Turnstile ------------------------------------------------
    const token =
      typeof body === 'object' && body !== null
        ? readString(body as Record<string, unknown>, SUPPORT_FIELDS.turnstile)
        : undefined;

    if (token === undefined || token === '' || token.length > SUPPORT_LIMITS.turnstileTokenMax) {
      logOutcome(requestId, 'refused-challenge');
      return fail(
        c,
        403,
        'SUPPORT_CHALLENGE_FAILED',
        'No pudimos verificar que sos una persona. Probá de nuevo.',
        requestId,
      );
    }

    const proven = await verifyTurnstile(
      deps,
      env.TURNSTILE_SECRET_KEY as string,
      token,
      c.req.header('CF-Connecting-IP') ?? undefined,
    );

    if (!proven) {
      logOutcome(requestId, 'refused-challenge');
      return fail(
        c,
        403,
        'SUPPORT_CHALLENGE_FAILED',
        'No pudimos verificar que sos una persona. Probá de nuevo.',
        requestId,
      );
    }

    // --- Validation --------------------------------------------------------
    const parsed = parseSupportSubmission(body);

    if (parsed.kind === 'invalid') {
      logOutcome(requestId, `refused-${parsed.reason}`);
      return fail(c, 400, 'SUPPORT_INVALID', 'El mensaje no se pudo enviar.', requestId);
    }

    // --- The send ----------------------------------------------------------
    //
    // From here on the message exists in memory and in exactly one more place.
    const email = buildSupportEmail({
      code: parsed.code,
      status: parsed.status,
      message: parsed.message,
      requestId,
      receivedAt: deps.now(),
    });

    try {
      const response = await deps.fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY as string}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.SUPPORT_EMAIL_FROM as string,
          to: [env.SUPPORT_EMAIL_TO as string],
          subject: email.subject,
          text: email.text,
        }),
      });

      // **The response body is never read.** On a 422 Resend echoes the
      // submitted payload — the customer's own message — back in the body.
      // Reading it for a better error message is how that text would end up in a
      // response and in a log. The status says everything worth saying.
      if (!response.ok) {
        logOutcome(requestId, `send-rejected-${response.status}`, parsed.code, parsed.status);
        return fail(
          c,
          502,
          'SUPPORT_SEND_FAILED',
          'No llegó tu mensaje: no pudimos enviarlo. Probá otra vez o contale al comercio.',
          requestId,
        );
      }
    } catch {
      // Logged as a bare outcome. The error object and its message are not
      // interpolated on purpose — see the module note. `name` is omitted too,
      // because the only thing we could learn from it is whether the failure came
      // from our own code or the network, and neither changes what the customer is
      // told or what the next person needs to do.
      logOutcome(requestId, 'send-unreachable', parsed.code, parsed.status);
      return fail(
        c,
        502,
        'SUPPORT_SEND_FAILED',
        'No llegó tu mensaje: no pudimos enviarlo. Probá otra vez o contale al comercio.',
        requestId,
      );
    }

    logOutcome(requestId, 'sent', parsed.code, parsed.status);
    return accepted(c, requestId);
  };
}

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
