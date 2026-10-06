// @vitest-environment node

/**
 * The public support channel: `POST /v1/support`.
 *
 * ## Why this file exists
 *
 * `apps/customer-web` had no way to reach a human at all. PR #180 removed the
 * "Reintentar" button from the seven refusals where re-asking provably cannot
 * help, and put a sentence in its place — which is correct copy and a dead end.
 * The person reading it is, in the motivating case, someone whose registration
 * is exactly what failed, so requiring a session would exclude the only person
 * who needs the channel.
 *
 * ## The nine properties, and why each is worth a test that fails when removed
 *
 *   1. Rate limited, and *registered* as such. The gateway's limiter skips any
 *      route absent from `anonymousLimits` (`middleware/rate-limit.ts:81`), so a
 *      new public route with no number is not "unthrottled by default" — it is
 *      invisible. The coverage guard in `support-limits.contract.test.ts` exists
 *      because that hole was papered over with an exemption once already, and the
 *      exemption was the bug.
 *   2. Honeypot filled sends nothing and answers exactly as success.
 *   3. Turnstile invalid or absent sends nothing.
 *   4. The code and the status reach the mail, and an unknown code does not break it.
 *   5. The free text reaches no log — not `console.log`, not `console.error`, and
 *      not the exception path.
 *   6. A field over its maximum is refused **on the server**.
 *   7. A Resend failure answers honestly.
 *   8. Sender and recipient come from configuration.
 *   9. The response echoes none of the body.
 *
 * ## Why Resend and Turnstile are both faked
 *
 * This file never reaches either service. `RESEND_API_KEY` does not exist in this
 * environment, the end-to-end send is therefore UNVERIFIED, and a test that
 * quietly depended on the network would be a test that passes in CI and says
 * nothing about the thing that breaks. Both dependencies are injected through
 * `SupportDeps.fetch` so every assertion here is about our code and nothing else.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  SUPPORT_LIMITS,
  SUPPORT_LIMIT_PER_WINDOW,
  SUPPORT_PATH,
  buildSupportEmail,
  parseSupportSubmission,
  supportRoute,
  type SupportDeps,
  type SupportEnv,
} from './support';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A string that must never appear in a log, a response, or an email subject.
 *
 * Deliberately shaped like something a person would type, and deliberately not a
 * word: a scan for `lorem` would pass on an implementation that echoed the body.
 */
const PII = 'me llamo Ada y no puedo usar la app desde marzo 9f3a2c';

const TURNSTILE_TOKEN = 'a-valid-turnstile-token-value';

/** Every config the route reads. Overriding one is how a test removes it. */
function env(overrides: Partial<SupportEnv> = {}): SupportEnv {
  return {
    RESEND_API_KEY: 're_test_key',
    SUPPORT_EMAIL_FROM: 'Vyloop <soporte@vyloop.test>',
    SUPPORT_EMAIL_TO: 'jmunoz@juancode.dev',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    ...overrides,
  };
}

/** What `apps/customer-web` sends, as the form builds it. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    wallet_code: 'WALLET_CLASS_NOT_APPROVED',
    wallet_status: 409,
    message: 'No me aparece la tarjeta y ya me registre dos veces.',
    company_website: '',
    'cf-turnstile-response': TURNSTILE_TOKEN,
    ...overrides,
  };
}

interface Captured {
  turnstile: Array<{ secret: string; response: string; remoteip?: string | undefined }>;
  emails: Array<{ from: string; to: string[]; subject: string; text: string }>;
}

/**
 * A `fetch` that answers both dependencies from a script, and records what it was
 * asked for.
 *
 * Dispatching on the URL is what keeps the two services distinguishable: without
 * it a test asserting "no email was sent" could be satisfied by a stub that
 * failed before reaching Resend, which would pass for the wrong reason.
 */
/** A `fetch` that also records what it was asked for. */
type FetchSpy = SupportDeps['fetch'] & { captured: Captured };

function fakeFetch(
  options: {
    turnstile?: { success: boolean; errorCodes?: string[] };
    resend?: { status?: number; throws?: boolean };
  } = {},
): FetchSpy {
  const captured: Captured = { turnstile: [], emails: [] };

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('siteverify')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      captured.turnstile.push({
        secret: body.get('secret') ?? '',
        response: body.get('response') ?? '',
        remoteip: body.get('remoteip') ?? undefined,
      });

      return Response.json({
        success: options.turnstile?.success ?? true,
        'error-codes': options.turnstile?.errorCodes ?? [],
        hostname: 'vyloop.pages.dev',
      });
    }

    if (url.includes('resend')) {
      if (options.resend?.throws) throw new TypeError('fetch failed');

      const sent = JSON.parse(String(init?.body)) as {
        from: string;
        to: string[];
        subject: string;
        text: string;
      };
      captured.emails.push(sent);

      const status = options.resend?.status ?? 200;
      // A real Resend error echoes the submitted payload back in its body. The
      // stub reproduces that, because that echo is the leak this file exists to
      // prove does not happen.
      return new Response(
        status === 200
          ? JSON.stringify({ id: 'email_123' })
          : JSON.stringify({ name: 'validation_error', message: `rejected: ${JSON.stringify(sent)}` }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as FetchSpy;

  impl.captured = captured;
  return impl;
}

function deps(fetchImpl = fakeFetch()): SupportDeps {
  let counter = 0;
  return {
    fetch: fetchImpl,
    now: () => new Date('2026-10-06T12:00:00.000Z'),
    newId: () => `req-${++counter}`,
  };
}

/**
 * POST a submission through the route, over a real Hono app.
 *
 * A real `Hono` instance rather than a hand-built context object: `c.json` is part
 * of the contract this route is written against, and a stub that lacked it would
 * have let every response assertion pass for the wrong reason.
 */
async function post(
  body: unknown,
  options: { env?: Partial<SupportEnv>; fetch?: FetchSpy } = {},
) {
  const fetchImpl = options.fetch ?? fakeFetch();
  const app = new Hono().post(SUPPORT_PATH, supportRoute(deps(fetchImpl)));

  const response = await app.fetch(
    new Request(`https://api.test${SUPPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
      body: JSON.stringify(body),
    }),
    env(options.env) as never,
  );

  return { response, fetchImpl };
}

/** The `{ error: { code, message } }` envelope every failure on this route uses. */
async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error?: { code?: string; message?: string } };

  return { code: body.error?.code ?? '', message: body.error?.message ?? '' };
}

/**
 * The whole gateway, for the two assertions that need the real middleware chain.
 *
 * Imported once in `beforeAll` rather than inside each test. The two tests that use
 * it are the PII ones, and an `await import('./index')` in a test body pulls the
 * entire gateway — Hono, `jose`, `@vyloop/db` — into that test's own 5s budget.
 * Under the parallel load of `pnpm -r test` that tipped them over and produced a
 * timeout that looked like a failure of the thing under test. `index.test.ts`
 * already does this for the same reason.
 */
let gatewayApp: typeof import('./index').default;

beforeAll(async () => {
  gatewayApp = (await import('./index')).default;
});

// ---------------------------------------------------------------------------
// 1. The rate limit
// ---------------------------------------------------------------------------

describe('the support route is rate limited', () => {
  it('names a per-window limit, because the gateway skips any route without one', () => {
    // The number is asserted end to end in `index.test.ts` through `app.fetch`,
    // which is the only place the middleware chain is real. This assertion is
    // here so the constant cannot be deleted along with the entry that uses it.
    expect(SUPPORT_LIMIT_PER_WINDOW).toBeGreaterThan(0);
  });

  it('is tight enough that a relay is a rate-limit problem, not a quota one', () => {
    // A person writes one message when something is wrong with their card. Three
    // a minute from one address leaves room for a second attempt after a
    // validation slip and none for a script; signup, which costs a 100k-iteration
    // key derivation, is allowed five.
    expect(SUPPORT_LIMIT_PER_WINDOW).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 2. The honeypot
// ---------------------------------------------------------------------------

describe('the honeypot', () => {
  it('sends nothing when it is filled', async () => {
    const { response, fetchImpl } = await post(payload({ company_website: 'http://spam.example' }));

    expect(response.status).toBe(202);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('answers exactly as a real success, so the bot learns nothing', async () => {
    // Byte-identical, not merely "also a success". A honeypot that answers 202
    // for the bot and 202 with a different body teaches the bot which branch it
    // hit, and the next version of it will stop filling the field.
    const bot = await post(payload({ company_website: 'http://spam.example' }));
    const human = await post(payload());

    expect(bot.response.status).toBe(202);
    expect(await bot.response.text()).toBe(await human.response.text());
  });

  it('is checked before Turnstile, so a bot cannot make us pay for a verification', async () => {
    // Also before validation: a bot that filled the honeypot *and* sent a
    // nine-kilobyte message must not learn that its message was too long.
    const { fetchImpl } = await post(
      payload({ company_website: 'http://spam.example', message: 'x'.repeat(99_999) }),
    );

    expect(fetchImpl.captured.turnstile).toEqual([]);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('never reaches the mail, so a filled honeypot costs nothing to answer', async () => {
    const { fetchImpl } = await post(payload({ company_website: 'x' }));

    expect(fetchImpl.captured.emails).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Turnstile
// ---------------------------------------------------------------------------

describe('Turnstile', () => {
  it('refuses to send when the token is rejected', async () => {
    const fetchImpl = fakeFetch({ turnstile: { success: false, errorCodes: ['invalid-input-response'] } });
    const { response } = await post(payload(), { fetch: fetchImpl });

    expect(response.status).toBe(403);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses to send when no token was sent at all', async () => {
    // The client-side widget alone protects nothing: an attacker posts any string.
    const fetchImpl = fakeFetch();
    const { response } = await post(payload({ 'cf-turnstile-response': '' }), { fetch: fetchImpl });

    expect(response.status).toBe(403);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses to send when the secret is not configured, rather than skipping the check', async () => {
    // This is the whole reason the verification is not wrapped in
    // `if (secret)`. A deployment without the var would otherwise accept every
    // submission unprotected and look identical to a protected one — the form
    // would work, the inbox would fill up, and nothing anywhere would say why.
    const { response } = await post(payload(), { env: { TURNSTILE_SECRET_KEY: '' } });

    expect(response.status).toBe(503);
  });

  it('sends the secret and the token, and never the free text, to siteverify', async () => {
    const { fetchImpl } = await post(payload({ message: PII }));

    expect(fetchImpl.captured.turnstile).toEqual([
      { secret: 'turnstile-secret', response: TURNSTILE_TOKEN, remoteip: '203.0.113.7' },
    ]);
  });

  it('forwards the client address, which is the one thing siteverify can use', async () => {
    const fetchImpl = fakeFetch();
    const app = new Hono().post(SUPPORT_PATH, supportRoute(deps(fetchImpl)));

    await app.fetch(
      new Request(`https://api.test${SUPPORT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.4' },
        body: JSON.stringify(payload()),
      }),
      env() as never,
    );

    expect(fetchImpl.captured.turnstile[0]?.remoteip).toBe('198.51.100.4');
  });
});

// ---------------------------------------------------------------------------
// 4. The context travels
// ---------------------------------------------------------------------------

describe('the wallet context reaches the mail', () => {
  it('carries the code and the status', async () => {
    const { fetchImpl } = await post(payload());

    expect(fetchImpl.captured.emails).toHaveLength(1);
    expect(fetchImpl.captured.emails[0]?.text).toContain('WALLET_CLASS_NOT_APPROVED');
    expect(fetchImpl.captured.emails[0]?.text).toContain('409');
  });

  it('carries an unknown code without breaking', async () => {
    // The server cannot validate the code against the closed set — that set is
    // the customer web's, and it changes whenever a refusal is added. A code this
    // build has never heard of is still the truth about what the person saw, and
    // refusing the message over it would throw away the only report we get.
    const { response, fetchImpl } = await post(payload({ wallet_code: 'WALLET_FROM_THE_FUTURE' }));

    expect(response.status).toBe(202);
    expect(fetchImpl.captured.emails[0]?.text).toContain('WALLET_FROM_THE_FUTURE');
  });

  it('accepts the client-side pseudo-code for a request that never got a status', async () => {
    // `wallet-card.tsx` substitutes 0 when the rejection was not an `ApiError`,
    // so 0 is a real value this route has to carry rather than reject.
    const { response, fetchImpl } = await post(payload({ wallet_code: 'NO_RESPONSE', wallet_status: 0 }));

    expect(response.status).toBe(202);
    expect(fetchImpl.captured.emails[0]?.text).toContain('NO_RESPONSE');
  });

  it('keeps the free text out of the subject', async () => {
    // Subjects appear in list views, notification previews and search results —
    // three places the message does not need to be. The body is where a message
    // written by a person belongs.
    const { fetchImpl } = await post(payload({ message: PII }));

    expect(fetchImpl.captured.emails[0]?.subject).not.toContain(PII);
    expect(fetchImpl.captured.emails[0]?.text).toContain(PII);
  });

  it('reports the request id in the mail, so a log line can be tied to it', async () => {
    const { fetchImpl } = await post(payload());

    expect(fetchImpl.captured.emails[0]?.text).toContain('req-1');
  });

  it('strips control characters out of the code before it is used', async () => {
    // The subject is built from the code, and the code is attacker-controlled. The
    // Resend API is JSON so there is no header-injection primitive here, but a
    // subject carrying CRLF is a support reader's problem and a log reader's.
    const { fetchImpl } = await post(payload({ wallet_code: 'A\r\nBcc: victim@example.com' }));

    const sent = fetchImpl.captured.emails[0];
    expect(sent?.subject).not.toContain('\r');
    expect(sent?.subject).not.toContain('\n');
    expect(sent?.text).toContain('ABcc');
  });
});

// ---------------------------------------------------------------------------
// 5. The free text reaches no log
// ---------------------------------------------------------------------------

describe('the free text never reaches a log', () => {
  it('is absent from every console call on the success path', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await post(payload({ message: PII }));

      for (const captured of [spy, errorSpy, warnSpy]) {
        expect(JSON.stringify(captured.mock.calls)).not.toContain(PII);
      }
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('is absent when Turnstile is refused', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const fetchImpl = fakeFetch({ turnstile: { success: false } });
      await post(payload({ message: PII }), { fetch: fetchImpl });

      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PII);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(PII);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('is absent when Resend throws — the exception path', async () => {
    // The path where a `console.error('…', err)` is most tempting, and the one
    // that matters: an unhandled rejection here would be logged with whatever
    // the error happened to carry.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const fetchImpl = fakeFetch({ resend: { throws: true } });
      const { response } = await post(payload({ message: PII }), { fetch: fetchImpl });

      expect(response.status).toBe(502);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PII);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(PII);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('is absent from the gateway onError handler, which logs the error object', async () => {
    // `index.ts`'s `onError` calls `console.error('…', err)`. A route that threw
    // an error carrying the body would therefore be logged, once, by machinery
    // that predates this route and is not going to be changed for it. So the route
    // must not throw such an error — which is only provable by driving the real
    // app and reading every console call.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      vi.stubGlobal('fetch', fakeFetch({ resend: { throws: true } }));

      const res = await gatewayApp.fetch(
        new Request(`https://api.test${SUPPORT_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
          body: JSON.stringify(payload({ message: PII })),
        }),
        {
          ...env(),
          RATE_LIMITER: { get: async () => null, put: async () => {}, delete: async () => {} },
        } as never,
      );

      // The send failed, and it is still the customer's fault to hear about it.
      expect(res.status).toBe(502);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PII);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(PII);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('is absent when the body is not JSON at all', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await gatewayApp.fetch(
        new Request(`https://api.test${SUPPORT_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json at all',
        }),
        {
          ...env(),
          RATE_LIMITER: { get: async () => null, put: async () => {}, delete: async () => {} },
        } as never,
      );

      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('not json at all');
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Server-side length limits
// ---------------------------------------------------------------------------

describe('field lengths are refused on the server', () => {
  it('refuses a message over the maximum', async () => {
    const fetchImpl = fakeFetch();
    const { response } = await post(
      payload({ message: 'a'.repeat(SUPPORT_LIMITS.messageMax + 1) }),
      { fetch: fetchImpl },
    );

    expect(response.status).toBe(400);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('accepts a message exactly at the maximum', async () => {
    const { response } = await post(payload({ message: 'a'.repeat(SUPPORT_LIMITS.messageMax) }));

    expect(response.status).toBe(202);
  });

  it('refuses a message under the minimum', async () => {
    // The `min`. A one-word message is what a relay sends: it costs the same as a
    // real one and carries nothing a human would have written. Ten characters is
    // below what anybody types to describe a problem and above "hi".
    const fetchImpl = fakeFetch();
    const { response } = await post(payload({ message: 'hola' }), { fetch: fetchImpl });

    expect(response.status).toBe(400);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses an over-long code', async () => {
    const fetchImpl = fakeFetch();
    const { response } = await post(payload({ wallet_code: 'X'.repeat(SUPPORT_LIMITS.code + 1) }), {
      fetch: fetchImpl,
    });

    expect(response.status).toBe(400);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses a code that is not a string', async () => {
    const fetchImpl = fakeFetch();
    const { response } = await post(payload({ wallet_code: { toString: () => 'WALLET_X' } }), {
      fetch: fetchImpl,
    });

    expect(response.status).toBe(400);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses a status that is not a number', async () => {
    const fetchImpl = fakeFetch();
    const { response } = await post(payload({ wallet_status: '409' }), { fetch: fetchImpl });

    expect(response.status).toBe(400);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses an absent message', async () => {
    const fetchImpl = fakeFetch();
    const { response } = await post(payload({ message: undefined }), { fetch: fetchImpl });

    expect(response.status).toBe(400);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses a Turnstile token longer than the API will accept', async () => {
    // Documented maximum is 2048. A longer one is either a bug or an attempt to
    // push a large body through, and either way it is not worth a round trip.
    //
    // **403, not 400.** A 400 would distinguish "your token is the wrong length"
    // from "your token is not valid", which hands a prober the cap for free and
    // teaches it the boundary it has to stay under. 403 says only that the
    // challenge was not proven, which is the truth and is the same answer an
    // invalid token gets.
    const fetchImpl = fakeFetch();
    const { response } = await post(
      payload({ 'cf-turnstile-response': 't'.repeat(SUPPORT_LIMITS.turnstileTokenMax + 1) }),
      { fetch: fetchImpl },
    );

    expect(response.status).toBe(403);
    expect(fetchImpl.captured.turnstile).toEqual([]);
  });

  it('does not describe which field was wrong', async () => {
    // A 400 that names the offending field is a map of the validation for
    // whoever is trying to get past it.
    const { response } = await post(payload({ message: 'x' }));
    const { message } = await errorOf(response);

    expect(message).not.toContain('message');
    expect(message).not.toContain('wallet_code');
    expect(message).not.toContain('código');
    expect(message).not.toContain('code');
  });
});

// ---------------------------------------------------------------------------
// 7. An honest answer when the mail did not go
// ---------------------------------------------------------------------------

describe('a failed send answers honestly', () => {
  it('does not claim success when Resend refused', async () => {
    const { response, fetchImpl } = await post(payload(), {
      fetch: fakeFetch({ resend: { status: 422 } }),
    });

    expect(response.status).toBe(502);
    expect(fetchImpl.captured.emails).toHaveLength(1);
    expect(await response.text()).not.toContain('accepted');
  });

  it('does not claim success when Resend is unreachable', async () => {
    const { response } = await post(payload(), { fetch: fakeFetch({ resend: { throws: true } }) });

    expect(response.status).toBe(502);
  });

  it('never reads the Resend response body, which echoes the submitted payload', async () => {
    // This is the leak a naive implementation has: `await res.text()` on a 422
    // hands back the message the customer wrote, and putting that in the response
    // or a log puts it in two more places. The stub above reproduces the echo, so
    // a body that reached the response would be visible here.
    const { response } = await post(payload({ message: PII }), {
      fetch: fakeFetch({ resend: { status: 422 } }),
    });

    expect(await response.text()).not.toContain(PII);
  });

  it('stores nothing, so a failed send loses the message rather than keeping it', async () => {
    // There is no ticket store in this design and adding one is a different
    // product with retention and deletion obligations. The consequence is stated
    // rather than engineered around: the person is told it did not arrive.
    const { response } = await post(payload({ message: PII }), {
      fetch: fakeFetch({ resend: { throws: true } }),
    });
    const body = (await response.json()) as { error?: { code?: string; message?: string } };

    expect(body.error?.code).toBe('SUPPORT_SEND_FAILED');
    // "It did not arrive", not "we received it". The two differ only here, and
    // the difference is the entire honesty of the route: nobody else can check
    // whether an inbox got the message.
    expect(body.error?.message?.toLowerCase()).toContain('no llegó');
  });

  it('refuses to send at all when the sender is not configured', async () => {
    // No verified Resend domain exists in this project yet, so this is the state
    // a deployment is actually in. It must fail closed and say so, rather than
    // guessing a domain and bouncing.
    const fetchImpl = fakeFetch();
    const { response } = await post(payload(), { env: { SUPPORT_EMAIL_FROM: '' }, fetch: fetchImpl });

    expect(response.status).toBe(503);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses to send when the API key is not configured', async () => {
    const fetchImpl = fakeFetch();
    const { response } = await post(payload(), { env: { RESEND_API_KEY: '' }, fetch: fetchImpl });

    expect(response.status).toBe(503);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('refuses to send when the recipient is not configured', async () => {
    const fetchImpl = fakeFetch();
    const { response } = await post(payload(), { env: { SUPPORT_EMAIL_TO: '' }, fetch: fetchImpl });

    expect(response.status).toBe(503);
    expect(fetchImpl.captured.emails).toEqual([]);
  });

  it('does not say which variable is missing', async () => {
    const { response } = await post(payload(), { env: { RESEND_API_KEY: '' } });
    const text = await response.text();

    expect(text).not.toContain('RESEND_API_KEY');
    expect(text).not.toContain('SUPPORT_EMAIL_FROM');
    expect(text).not.toContain('SUPPORT_EMAIL_TO');
  });
});

// ---------------------------------------------------------------------------
// 8. Addresses come from configuration
// ---------------------------------------------------------------------------

describe('the addresses come from configuration', async () => {
  it('sends to the configured recipient, from the configured sender', async () => {
    const { fetchImpl } = await post(payload(), {
      env: {
        SUPPORT_EMAIL_FROM: 'Another <from@elsewhere.test>',
        SUPPORT_EMAIL_TO: 'someone@else.test',
      },
    });

    expect(fetchImpl.captured.emails[0]?.from).toBe('Another <from@elsewhere.test>');
    expect(fetchImpl.captured.emails[0]?.to).toEqual(['someone@else.test']);
  });

  it('holds no address literal of its own', async () => {
    // By source, not by behaviour: a default baked into the module would answer
    // every behavioural assertion above correctly while still shipping a hardcoded
    // destination, which is the thing that is actually forbidden.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./support.ts', import.meta.url), 'utf8');
    const withoutComments = source
      .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ' '))
      .replaceAll(/\/\/[^\n]*/g, (line) => line.replaceAll(/[^\n]/g, ' '));

    expect(withoutComments).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it('sets no Reply-To, because nothing here knows the sender', async () => {
    // The consequence of not asking for an address, stated so it is a decision:
    // the operator can read the message and cannot write back to it.
    const { fetchImpl } = await post(payload());

    expect(JSON.stringify(fetchImpl.captured.emails[0])).not.toContain('reply_to');
  });
});

// ---------------------------------------------------------------------------
// 9. The response leaks nothing
// ---------------------------------------------------------------------------

describe('the response leaks none of the body', async () => {
  it('echoes no part of the submission', async () => {
    const { response } = await post(payload({ message: PII }));
    const text = await response.text();

    expect(text).not.toContain(PII);
    expect(text).not.toContain('WALLET_CLASS_NOT_APPROVED');
    expect(text).not.toContain('409');
  });

  it('echoes nothing on the refusal paths either', async () => {
    const responses = await Promise.all([
      post(payload({ message: PII }), { fetch: fakeFetch({ resend: { status: 500 } }) }),
      post(payload({ message: PII }), { fetch: fakeFetch({ resend: { throws: true } }) }),
      post(payload({ message: PII }), { fetch: fakeFetch({ turnstile: { success: false } }) }),
      post(payload({ message: PII, company_website: 'http://spam.example' })),
      post(payload({ message: 'x' })),
    ]);

    for (const { response } of responses) {
      expect(await response.text()).not.toContain(PII);
    }
  });

  it('answers the same body to a bot as to a person, which is why it is safe', async () => {
    const bot = await post(payload({ message: PII, company_website: 'http://spam.example' }));
    const human = await post(payload({ message: PII }));

    expect(await bot.response.text()).toBe(await human.response.text());
  });
});

// ---------------------------------------------------------------------------
// The parser, on its own
// ---------------------------------------------------------------------------

describe('parseSupportSubmission', () => {
  it('reports which rule was broken, without echoing the value', async () => {
    const result = parseSupportSubmission(payload({ message: 'x' }));

    expect(result).toEqual({ kind: 'invalid', reason: 'message-too-short' });
    expect(JSON.stringify(result)).not.toContain(PII);
  });

  it('accepts a well-formed submission', async () => {
    const result = parseSupportSubmission(payload());

    expect(result.kind).toBe('accepted');
  });

  it('rejects a body that is not an object', async () => {
    expect(parseSupportSubmission('a string')).toEqual({ kind: 'invalid', reason: 'body-not-object' });
    expect(parseSupportSubmission(null)).toEqual({ kind: 'invalid', reason: 'body-not-object' });
  });
});

describe('buildSupportEmail', () => {
  it('labels every field, because the reader is a person at an inbox', async () => {
    const email = buildSupportEmail({
      code: 'WALLET_CLASS_NOT_APPROVED',
      status: 409,
      message: PII,
      requestId: 'req-9',
      receivedAt: new Date('2026-10-06T12:00:00.000Z'),
    });

    expect(email.text).toContain('Wallet code');
    expect(email.text).toContain('HTTP status');
    expect(email.text).toContain('req-9');
    expect(email.subject).toContain('WALLET_CLASS_NOT_APPROVED');
  });
});
