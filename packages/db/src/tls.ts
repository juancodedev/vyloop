// Transport-security policy for the worker connection string.
//
// The reason this exists: `pg-connection-string` currently treats `require`,
// `prefer` and `verify-ca` as aliases for `verify-full`, but it emits a
// deprecation warning saying v3 will adopt libpq's weaker semantics. A URL that
// verifies the server certificate today would accept any certificate after a
// dependency bump, and nothing in the repository would say so. `verify-full` is
// the only spelling whose meaning is not scheduled to change.
//
// This mirrors `scripts/lib/database-url.mjs`; the operational scripts run on
// plain Node and cannot import from this package, so the policy lives twice.
// If one side gains a new accepted mode, the other has to change too.
//
// Every error names the host and nothing else. A connection string carries a
// password, and a rejected connection is exactly the moment that password ends
// up in a terminal, a CI log, or a pasted report.

/**
 * Parse only to reach `host` and the query parameters. Never returns the URL,
 * because callers surface what they get here.
 */
function parse(url: string): URL {
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

/**
 * Require `sslmode=verify-full`.
 *
 * Everything else is refused, including a missing `sslmode`: without it the
 * driver falls back to its own default, and this guard exists because that
 * default is about to change. Loopback development databases go through the
 * same rule, so there is no host list to keep in sync and no way for a
 * copy-pasted production URL to slip through a local-only exemption.
 */
export function assertVerifiedTls(url: string): URL {
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
