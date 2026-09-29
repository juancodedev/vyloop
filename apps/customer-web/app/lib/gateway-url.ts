/**
 * Where the API gateway lives, resolved once.
 *
 * The name matters more than it looks. This used to read
 * `process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'`, but Cloudflare
 * Pages had the gateway URL configured as `NEXT_PUBLIC_API_URL` — the same name
 * `apps/dashboard` reads. So the variable existed, held the right value, and was
 * simply never consulted. The fallback took over, the deployed bundle inlined
 * `http://localhost:8787`, and every visitor's browser tried to reach their own
 * machine: `ERR_CONNECTION_REFUSED` on a perfectly healthy API.
 *
 * It reads `NEXT_PUBLIC_API_URL` to match the dashboard and the deployed
 * configuration. Adding a second name for one value would leave the next reader
 * guessing which one is real, which is how this happened.
 *
 * `NEXT_PUBLIC_*` is substituted at build time, so a missing value is `undefined`
 * in the shipped bundle. That makes a silent fallback possible, which is why the
 * production branch throws instead of guessing. `next.config.mjs` asserts the same
 * invariant at build time, so the mistake cannot reach a deploy in the first place.
 */

/** The gateway wrangler serves locally. Never a production value. */
const DEV_FALLBACK = 'http://localhost:8787';

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The gateway base URL, without a trailing slash.
 *
 * @param env        the configured value; injectable so the rules can be tested
 *                   without mutating the real environment.
 * @param production whether this is a production build. Defaults to the build's
 *                   own `NODE_ENV`, which Next.js substitutes at build time.
 * @throws if no value is configured for a production build. Guessing a URL that
 *         cannot work is how a broken login page ships; failing here is loud and
 *         immediate, and it names the variable to set.
 */
export function resolveGatewayUrl(
  env: string | undefined = process.env.NEXT_PUBLIC_API_URL,
  production: boolean = process.env.NODE_ENV === 'production',
): string {
  if (isSet(env)) {
    return env.trim().replace(/\/+$/, '');
  }

  if (production) {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not set. The gateway URL has no production ' +
        'default, because a development address cannot work in a deployed ' +
        "browser: the request would go to the visitor's own machine. Set " +
        'NEXT_PUBLIC_API_URL in the build environment to the public ' +
        'gateway URL.',
    );
  }

  return DEV_FALLBACK;
}

/**
 * The gateway base URL, for the common case of calling this directly.
 *
 * Resolved on each call rather than once at module load, so a misconfigured
 * production build fails where the request is made — with a message naming the
 * variable — instead of taking the whole page down at import time.
 *
 * The development address stays reachable in a production bundle, because the
 * bundler does not fold the `NODE_ENV` comparison away. That is acceptable
 * because `next.config.mjs` refuses the build outright unless a real gateway URL
 * is set, so the branch below is unreachable by the time a bundle ships. The
 * build-time guard is the real fence; this is the second one.
 */
export function gatewayUrl(): string {
  return resolveGatewayUrl();
}
