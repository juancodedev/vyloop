// The read-only session shared by the database checks.
//
// ## Enforcing read-only rather than promising it
//
// `SET default_transaction_read_only = on` puts the session itself in read-only
// mode, so any statement a script did not intend to send is refused by the
// server rather than by review. The setting is read back with `SHOW` and the
// connection is dropped if the server did not honour it: a check that claims to
// be read-only while silently holding a writable session is worse than one that
// cannot run.
//
// `sslmode=verify-full` is required before a connection is attempted, for the
// reason in `database-url.mjs`.

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { assertVerifiedTls } from './database-url.mjs';

export const READ_ONLY_REFUSED =
  'the database did not honour a read-only session; refusing to continue';

/**
 * A single-connection `pg` pool.
 *
 * `pg` is a dependency of packages/db, not of the repository root, so a plain
 * dynamic import from a script at the top level does not resolve it.
 */
function defaultCreatePool({ connectionString, connectionTimeoutMillis }) {
  const require = createRequire(join(process.cwd(), 'packages/db/package.json'));
  const { Pool } = require('pg');
  return new Pool({ connectionString, max: 1, connectionTimeoutMillis });
}

/**
 * Run `read(pool)` on a session confirmed read-only.
 *
 * Returns `{ reachable: true, ...result }`, or `{ reachable: false, error }` when
 * the database could not be read or refused read-only mode. There is no third
 * state. A URL without `sslmode=verify-full` throws before any connection.
 */
export async function withReadOnlySession(
  url,
  read,
  { connectTimeoutMs = 10_000, createPool = defaultCreatePool } = {},
) {
  if (!url) return { reachable: false, error: 'DATABASE_URL is not set' };

  assertVerifiedTls(url);

  const pool = createPool({ connectionString: url, connectionTimeoutMillis: connectTimeoutMs });

  try {
    await pool.query('SET default_transaction_read_only = on');
    const mode = await pool.query('SHOW default_transaction_read_only');
    if (mode.rows[0]?.default_transaction_read_only !== 'on') {
      return { reachable: false, error: READ_ONLY_REFUSED };
    }
    return { reachable: true, ...(await read(pool)) };
  } catch (error) {
    return { reachable: false, error: error.message };
  } finally {
    await pool.end();
  }
}
