// Connection-string policy for the operational scripts.
//
// The reason this exists: `pg-connection-string` currently treats `require`,
// `prefer` and `verify-ca` as aliases for `verify-full`, but it emits a
// deprecation warning saying v3 will adopt libpq's weaker semantics. A URL that
// is safe today would become a URL that accepts any certificate after a
// dependency bump, and nothing in the repository would say so. Writing
// `verify-full` is the only spelling whose meaning is not scheduled to change.
//
// The other half is that every error here names the host and nothing else. A
// connection string carries a password; a rejected connection is exactly the
// moment that password ends up in a terminal, a CI log, or a pasted report.

import { readFileSync } from 'node:fs';

/**
 * Parse only to reach `host` and the query parameters. Never returns the URL,
 * because callers print what they get here.
 */
function parse(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('DATABASE_URL is not set');
  }
  try {
    return new URL(url);
  } catch {
    // `new URL` echoes its input in the error message, which may be the whole
    // connection string. Throw a message that cannot contain the password.
    throw new Error('DATABASE_URL is not a valid URL');
  }
}

/** The endpoint id of the production database. `-pooler` is the same instance. */
const PRODUCTION_ENDPOINT = 'ep-shiny-paper-aibbf0hk';

/**
 * Whether the URL points at the production Neon endpoint.
 *
 * Matched on the endpoint id, not the full host: the pooled and direct hosts
 * (`ep-…-pooler.c-4.…` and `ep-….c-4.…`) are the same database, and a region
 * change must not silently turn a production guard into a no-op.
 */
export function isProductionHost(url) {
  const { hostname } = parse(url);

  // The endpoint id is the first label, with `-pooler` appended on the pooled
  // host. Requiring Neon's own suffix as well means a lookalike domain that
  // happens to start with the id is not mistaken for production.
  if (!hostname.endsWith('.neon.tech')) return false;
  const label = hostname.split('.')[0].replace(/-pooler$/, '');
  return label === PRODUCTION_ENDPOINT;
}

/**
 * Require `sslmode=verify-full`.
 *
 * Everything else is refused, including a missing `sslmode`: without it the
 * driver's next move is its own default, and this guard exists because that
 * default is about to change.
 */
export function assertVerifiedTls(url) {
  const parsed = parse(url);
  const mode = parsed.searchParams.get('sslmode');

  if (mode !== 'verify-full') {
    throw new Error(
      `Refusing to connect to ${parsed.host}: sslmode must be verify-full (found ${mode ?? 'none'}). ` +
        'See docs/18-Verificacion-y-Seguridad-Operativa.md.',
    );
  }

  return parsed;
}

/**
 * `DATABASE_URL` from the environment, falling back to the local dev files.
 *
 * The fallback exists only so a check can be run against development by hand.
 * On CI the files are gitignored and absent, so the environment is the only
 * source — and a missing URL is a failure, not a skip.
 */
export function resolveDatabaseUrl({ env = process.env, readFile = readFileSync } = {}) {
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, source: 'DATABASE_URL' };
  for (const path of ['apps/gateway/.dev.vars', 'workers/wallet/.dev.vars']) {
    try {
      const url = /^DATABASE_URL=(.*)$/m.exec(readFile(path, 'utf8'))?.[1];
      if (url) return { url, source: path };
    } catch {
      // No local dev file. Expected on CI.
    }
  }
  return { url: null, source: null };
}
