// @vitest-environment node

/**
 * Every exact-match public path carries a rate limit.
 *
 * ## The hole this file exists to close
 *
 * `middleware/rate-limit.ts:81` does not default a missing limit — it **skips**
 * throttling for any endpoint absent from `anonymousLimits`:
 *
 * ```
 * const anonymousLimit = config.anonymousLimits?.[endpoint];
 * if (anonymousLimit === undefined) {
 *   await next();
 *   return;
 * }
 * ```
 *
 * So adding a public route and forgetting its number does not produce "no limit
 * configured, defaulting to something sensible". It produces **an unbounded
 * public endpoint**, and the only symptom is the thing you were trying to
 * prevent. For `POST /v1/support` that symptom is a mailbox full of mail nobody
 * sent on purpose.
 *
 * ## Why a guard and not just a number
 *
 * Because the number is easy to add and impossible to notice missing. This file
 * turns "remember to put a number here" into a build failure.
 *
 * ## Why there is no exemption list
 *
 * The precedent is bad and recent. `SCHEMA_REGISTRY` was absent from
 * `wrangler.jsonc`, which broke every event POST with a 500 nobody could trace —
 * and the guard that *would* have caught it was silenced by putting the name in
 * `KNOWN_UNDECLARED`. **The exemption was the bug.** So this file has no escape
 * hatch: every path in `EXACT_PUBLIC_PATHS` must have a number, and the fix for
 * a failure here is to write the number, not to explain its absence.
 *
 * ## Why prefixes are not covered, and that is not a gap
 *
 * `isPublicApiPath` also opens `/v1/auth/*`, `/v1/communication/webhook` and
 * `PUT /v1/customers`. Three of those are unbounded on purpose and for three
 * different documented reasons, and a rule that had to exempt them would be the
 * same mechanism as the one that hid the last bug. So the rule is scoped to what
 * is scoped: **paths the gateway names one by one**, which are exactly the ones
 * where a person chose a path and can be expected to choose a number for it.
 */

import { describe, expect, it } from 'vitest';

import { WALLET_CALLBACK_PATH } from './robots';
import { SUPPORT_PATH } from './support';

import { ANONYMOUS_LIMITS, EXACT_PUBLIC_PATHS } from './index';

describe('every exact-match public path is rate limited', () => {
  it('has a number in ANONYMOUS_LIMITS', () => {
    // The rule, stated once. `EXACT_PUBLIC_PATHS` is the set of paths
    // `isPublicApiPath` names individually; this is the set of numbers that
    // throttle an anonymous request to one of them. Neither can grow without the
    // other growing, or this fails.
    const unthrottled = EXACT_PUBLIC_PATHS.filter((path) => ANONYMOUS_LIMITS[path] === undefined);

    expect(unthrottled).toEqual([]);
  });

  it('has a number that is a positive integer, not zero or a placeholder', () => {
    // A zero limit would refuse every request, which reads as a broken route. A
    // negative one throws inside the limiter's comparison. Both pass a
    // `!== undefined` check, so the check has to be about the value.
    for (const path of EXACT_PUBLIC_PATHS) {
      const limit = ANONYMOUS_LIMITS[path];

      expect(Number.isInteger(limit), `${path} has no integer limit`).toBe(true);
      expect(limit as number, `${path} has a non-positive limit`).toBeGreaterThan(0);
    }
  });

  it('names the support form and the Google Wallet callback, and no one else', () => {
    // Both halves, so a rename cannot quietly empty the set. `[]` would satisfy
    // the rule above just as well as a correct list does, and a set that empties
    // is how a guard stops guarding.
    expect([...EXACT_PUBLIC_PATHS].sort()).toEqual([WALLET_CALLBACK_PATH, SUPPORT_PATH].sort());
  });

  it('holds no path that the anonymous limiter cannot see', () => {
    // A public path outside `/v1/*` never reaches the middleware that reads
    // `ANONYMOUS_LIMITS`, so a number for it would be a comment. This is the
    // mistake the wallet-capture route could have made and the reason the support
    // route is deliberately registered under the prefix.
    const outside = EXACT_PUBLIC_PATHS.filter((path) => !path.startsWith('/v1/'));

    expect(outside).toEqual([]);
  });

  it('keeps the two limits far apart, because the two costs are not alike', () => {
    // The callback is 600 on purpose: Google retries with backoff and a busy
    // merchant's saves all arrive from one address, so a tight limit would drop
    // real deliveries and leave a pass wrong with no error here to explain it.
    //
    // The support form is 3 because what it bounds is not CPU — it is whether a
    // human can still read their inbox. Tightening the callback number would break
    // Google; loosening the support number would end support silently. If these
    // ever converge, one of the two reasons above was given up.
    const callback = ANONYMOUS_LIMITS[WALLET_CALLBACK_PATH];
    const support = ANONYMOUS_LIMITS[SUPPORT_PATH];

    expect(callback).toBeGreaterThanOrEqual(600);
    expect(support).toBeLessThanOrEqual(5);
  });
});

describe('the limiter it depends on', () => {
  it('skips any endpoint absent from anonymousLimits, which is why the guard above exists', async () => {
    // Asserted against the real middleware, not described. If someone "fixes" the
    // limiter by defaulting absent endpoints to a generous number, this goes red
    // and they have to decide whether the rule above still means anything — which
    // is the decision that should be made out loud.
    const { rateLimitMiddleware } = await import('./middleware/rate-limit');

    const unlimited = new HonoProbe();

    await rateLimitMiddleware({
      kv: { get: async () => null, put: async () => {} } as never,
      limits: {},
      windowSeconds: 60,
      anonymousLimits: ANONYMOUS_LIMITS,
    })(unlimited.ctx as never, async () => {
      unlimited.passed = true;
    });

    // A path in no table at all is let through, which is the documented behaviour
    // this whole file works around.
    expect(unlimited.passed).toBe(true);

    // And a path in the table with a number is counted, not skipped.
    const counted = new HonoProbe('/v1/support');
    let puts = 0;

    await rateLimitMiddleware({
      kv: {
        get: async () => null,
        put: async () => {
          puts += 1;
        },
      } as never,
      limits: {},
      windowSeconds: 60,
      anonymousLimits: ANONYMOUS_LIMITS,
    })(counted.ctx as never, async () => {
      counted.passed = true;
    });

    expect(puts).toBe(1);
    expect(counted.passed).toBe(true);
  });
});

/** The two fields `rateLimitMiddleware` reads off a Hono context. */
class HonoProbe {
  passed = false;
  readonly ctx: unknown;

  constructor(pathname = '/v1/anything-not-listed') {
    this.ctx = {
      req: {
        url: `https://api.test${pathname}`,
        method: 'POST',
        header: () => undefined,
      },
      get: () => undefined,
      json: () => new Response('{}'),
    };
  }
}
