/**
 * Password hashing, verification and admission policy.
 *
 * One module, one algorithm. `packages/db/scripts/seed.ts` and
 * `workers/identity/src/index.ts` each carried their own copy of the same
 * PBKDF2-HMAC-SHA-256 with the same parameters and the same `saltHex:hashHex`
 * storage format, neither exported. A public business signup needs a third
 * writer, and three copies of a credential hash is three places for an
 * iteration count to drift. The two existing implementations now import from
 * here instead.
 *
 * **The parameters below are frozen, not defaults.** `PBKDF2_ITERATIONS` and
 * the storage format are load-bearing for every credential already in the
 * database: `verifyPassword` has to keep accepting the strings the previous
 * code produced, or every existing user is locked out on deploy. Raising the
 * iteration count is a legitimate improvement and it is deliberately *not* done
 * here — it needs a rehash-on-next-login path, which is a different change with
 * a different risk profile. The only way to raise it is to add a second
 * `verify` that knows the old cost, the way every other scheme migration does.
 */

/** Cost factor. Frozen: see the module note above before changing. */
const PBKDF2_ITERATIONS = 100_000;

/** Derived key length in bits (512 = 64 bytes = 128 hex chars). */
const PBKDF2_KEY_BITS = 512;

/** Salt length in bytes, hex-encoded into the stored string. */
const SALT_BYTES = 16;

// ---------------------------------------------------------------------------
// Admission policy
// ---------------------------------------------------------------------------

/**
 * Minimum accepted password length.
 *
 * Twelve, and the reasoning is what the surrounding system does *not* have.
 * There is no second factor on this login path, no breached-password check, and
 * `/v1/auth/*` is exempt from the gateway's rate limiter — so a signup endpoint
 * reachable without a credential is also reachable without a throttle, and the
 * length of the secret is the only control standing between an attacker and an
 * offline guess against the hash this module writes. Twelve is the floor NIST
 * SP 800-63B names for passphrase-style single-factor secrets; eight, the value
 * most implementations still ship, is the one a commodity cracking rig
 * outpaces.
 *
 * What is deliberately absent is just as load-bearing:
 *
 * - **No composition rules.** Requiring an upper, a lower, a digit and a symbol
 *   is the single most reliable way to make a population's passwords weaker:
 *   the constraint is satisfiable by one predictable substitution, so the
 *   effective entropy stays near the length while the effort of *choosing*
 *   drops to nothing. NIST 800-63B and OWASP both recommend against them for
 *   exactly this reason.
 * - **No maximum length and no composition ceiling.** A `maxlength` of 64 or a
 *   ban on pastes locks out password managers, which generate the long random
 *   strings this policy is otherwise steering people towards.
 * - **No forced rotation.** Expiry prompts replacement, not a better secret.
 *
 * The one rule below the minimum is a whitespace-only rejection, and it exists
 * because the minimum would otherwise be vacuous: twelve spaces satisfies a
 * length check while carrying no entropy at all, and the resulting account is
 * unrecoverable by anyone who fat-fingers the field once. It is scoped to
 * passwords that are *entirely* whitespace, so it never costs a real passphrase
 * a single character.
 *
 * `demo123` in the seed is 7 characters and does not satisfy this. That is
 * intended: the seed is a one-off script for local demo data, it is not a
 * public write path, and the login route does not consult this function. Were
 * the policy applied at login instead, every credential already stored would
 * start failing — which is why this is an *admission* rule and not a
 * *verification* rule.
 */
export const PASSWORD_MIN_LENGTH = 12;

export type PasswordPolicyResult = { ok: true } | { ok: false; message: string };

/**
 * Check a password against the admission policy.
 *
 * Returns the reason rather than a bare boolean so a caller can put the
 * rejection straight into a response. Signup is the only caller today; nothing
 * on the login path calls it, which is what keeps existing users working.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, message: 'Password is required' };
  }
  if (password.trim().length === 0) {
    return {
      ok: false,
      message: 'Password must contain at least one non-whitespace character',
    };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Run PBKDF2 over `password` with `saltHex` and return the derived bits.
 *
 * The salt is the hex *string*, not the decoded bytes. That is what both
 * pre-existing implementations did, and `verifyPassword` re-derives from the
 * stored hex, so hashing over decoded bytes would verify against nothing
 * already in the database. Kept byte-for-byte on purpose.
 */
async function deriveBits(password: string, saltHex: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    PBKDF2_KEY_BITS,
  );

  return new Uint8Array(derived);
}

/**
 * Hash a password for storage.
 *
 * @returns `saltHex:hashHex`. The salt is 16 random bytes hex-encoded, and the
 *          hash is 512 bits hex-encoded. Never log the return value.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltHex = toHex(salt);
  const hashHex = toHex(await deriveBits(password, saltHex));
  return `${saltHex}:${hashHex}`;
}

/**
 * Verify a password against a stored `saltHex:hashHex` string.
 *
 * A malformed stored value is a `false`, never a throw: `users.password_hash`
 * is nullable and a user with no password must fail the check, not the request.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const computedHex = toHex(await deriveBits(password, saltHex));

  // Length-equal, then a running XOR of the character codes. Both halves of the
  // comparison have to stay non-short-circuiting: an early return on the first
  // differing byte leaks where two hashes stop matching.
  if (computedHex.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ hashHex.charCodeAt(i);
  }
  return diff === 0;
}
