/**
 * Member code (T2b) — the value carried by `LoyaltyObject.accountId`.
 *
 * ## Why a code at all
 *
 * Google's recommended maximum for `accountId` is 20 characters.
 * `customers.global_id` is a 36-character UUID and does not fit. So
 * `accountId` carries a 6-character member code instead.
 *
 * ## Why the barcode still carries the full `globalId`
 *
 * The POS resolves customers **only** by `globalId`, scanned from the barcode
 * (`workers/customer` → `GET /v1/customers/n/:globalId`). `accountId` is never
 * machine-read in this system. Keeping the full `globalId` in the barcode means
 * no POS contract changes, and `accountId` exists solely to be read aloud by a
 * person at a noisy counter — which is what a loyalty pass is for.
 *
 * ## Crockford Base32
 *
 * The alphabet excludes `I`, `L`, `O` and `U` and folds `1`→`I` and `0`→`O`.
 * Those four letters are the ones a human misreads or mis-hears over counter
 * noise, and the folds mean a customer who writes `1` gets read back as `I`
 * without anyone noticing the correction.
 *
 * ## Non-correlational is a privacy requirement
 *
 * A per-tenant sequential code (`000001`, `000002`, …) would leak a merchant's
 * customer count and join rate to any competitor who saw a customer's pass.
 * The code is therefore a keyed hash, not a counter: it carries no ordering
 * information at all.
 *
 * ## The pepper is load-bearing
 *
 * `globalId` is printed in the barcode of every pass, and `tenantId` is not
 * secret. A code derived as `HMAC(tenantId, globalId)` without a server-side
 * pepper could be recomputed by anyone who scanned one pass, then matched
 * against a second pass to confirm both belong to the same person. The pepper
 * lives in a worker secret and never enters the repository, a `.dev.vars` file
 * or a test fixture.
 *
 * ## Stored, not derived on read
 *
 * The code is persisted on `customers.member_code` rather than recomputed on
 * every render. That decouples the code from this algorithm, so the algorithm
 * can change later without invalidating codes customers have already
 * memorised, and it leaves room for a merchant-chosen code later. The database
 * enforces tenant-scoped uniqueness through a partial unique index on
 * `(business_id, member_code)`, not through application logic.
 */

/**
 * The 32 Crockford Base32 symbols in value order. `I`, `L`, `O` and `U` are
 * absent; a UUID rendered in this alphabet can therefore never produce one.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The characters excluded from the alphabet, asserted absent by tests. */
export const CROCKFORD_EXCLUDED = ['I', 'L', 'O', 'U'] as const;

/** Fixed width of a member code. Google's `accountId` budget is 20. */
export const MEMBER_CODE_LENGTH = 6;

/** Bits of entropy per character: log2(32). 6 characters therefore carry 30. */
export const MEMBER_CODE_BITS_PER_CHARACTER = 5;

/**
 * Maximum number of candidates tried before a free code is reported as
 * unavailable. 6 Crockford characters is 30 bits (about 1.07e9 codes); a
 * tenant would need roughly 32,000 customers before a collision reaches 50%,
 * so exhaustion means something is wrong with the pepper rather than bad luck.
 */
export const MEMBER_CODE_MAX_ATTEMPTS = 8;

/** Thrown when every candidate code is already taken within a tenant. */
export class MemberCodeExhaustedError extends Error {
  readonly tenantId: string;
  readonly customerGlobalId: string;

  constructor(tenantId: string, customerGlobalId: string) {
    super(
      `Could not find a free ${MEMBER_CODE_LENGTH}-character member code for customer ` +
        `${customerGlobalId} in tenant ${tenantId} after ${MEMBER_CODE_MAX_ATTEMPTS} attempts.`,
    );
    this.name = 'MemberCodeExhaustedError';
    this.tenantId = tenantId;
    this.customerGlobalId = customerGlobalId;
  }
}

export interface MemberCodeInput {
  /** `tenants.id`. The salt: the same person gets a different code per tenant. */
  tenantId: string;
  /** `customers.global_id`. Never `customers.id`. */
  customerGlobalId: string;
  /** Server-side secret. Required — see the module comment. */
  pepper: string;
  /**
   * Attempt counter, mixed into the digest. Zero for the first try. Retries
   * walk this space instead of falling back to a weaker generator, so a
   * collision never degrades the code's shape or privacy properties.
   */
  attempt?: number;
}

/**
 * Derive a member code.
 *
 * The digest is HMAC-SHA256 over a length-prefixed, unambiguously delimited
 * message. Length-prefixing matters: a naive `${tenantId}:${globalId}` lets a
 * tenant id ending in `:` and a shorter tenant id produce the same message for
 * two different customers.
 *
 * The first `MEMBER_CODE_LENGTH` symbols of the Base32 encoding of the digest
 * are taken, reading the digest as a most-significant-bit-first bit stream. The
 * output is a uniform random string over the alphabet, which is what makes it
 * carry no ordering information.
 */export function generateMemberCode(input: MemberCodeInput): Promise<string> {
  const attempt = input.attempt ?? 0;

  if (input.pepper.length === 0) {
    return Promise.reject(
      new Error(
        'MEMBER_CODE_PEPPER is empty. A member code without a pepper is derivable ' +
          'by anyone who has scanned one pass, because globalId is printed in the barcode.',
      ),
    );
  }

  const tenant = encodeURIComponent(input.tenantId);
  const customer = encodeURIComponent(input.customerGlobalId);
  const message = `v1|${tenant.length}|${tenant}|${customer.length}|${customer}|${attempt}`;

  return hmacBytes(input.pepper, message).then((digest) => {
    // Consume the digest MSB-first, five bits per character. `buffer` holds the
    // bits not yet turned into a character, left-aligned so
    // `buffer >>> (count - 5)` is the next character.
    let buffer = 0;
    let count = 0;
    let byteIndex = 0;
    let code = '';

    for (let i = 0; i < MEMBER_CODE_LENGTH; i += 1) {
      while (count < 5) {
        buffer = (buffer << 8) | (digest[byteIndex] as number);
        byteIndex += 1;
        count += 8;
      }
      const index = (buffer >>> (count - 5)) & 0b11111;
      code += CROCKFORD_ALPHABET[index] as string;
      count -= 5;
      buffer &= count === 0 ? 0 : (1 << count) - 1;
    }

    return code;
  });
}

/**
 * HMAC-SHA256 over WebCrypto rather than `node:crypto`.
 *
 * WebCrypto is the primitive guaranteed on Workers and it needs no
 * `nodejs_compat`, so the member-code algorithm does not depend on the
 * compat flag or on a Node polyfill staying available.
 */
async function hmacBytes(pepper: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

/**
 * Report whether a code is well formed. Useful for asserting on stored values
 * read back from the database, where there is no sanitiser to fall back on.
 *
 * `customers.member_code` is nullable, so `null` and `undefined` are accepted as
 * input and reported as invalid rather than crashing. A customer who has never
 * been issued a pass has no code, and that is a normal state — it just means the
 * pass cannot be built yet.
 */
export function isValidMemberCode(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (value.length !== MEMBER_CODE_LENGTH) return false;
  for (const character of value) {
    if (!CROCKFORD_ALPHABET.includes(character)) return false;
  }
  return true;
}

export interface AvailableMemberCodeInput extends MemberCodeInput {
  /**
   * Tenant-scoped existence check, normally
   * `SELECT 1 FROM customers WHERE business_id = $1 AND member_code = $2`.
   */
  isTaken: (code: string) => boolean | Promise<boolean>;
}

/**
 * Derive a code that is free within the tenant, retrying on collision.
 *
 * Uniqueness is ultimately the database's job — the partial unique index on
 * `(business_id, member_code)` is the real guard against a race between two
 * concurrent issuances. This function makes the common case clean and turns
 * the rare collision into one more round trip rather than a constraint error.
 */
export async function findAvailableMemberCode(
  input: AvailableMemberCodeInput,
): Promise<string> {
  for (let attempt = 0; attempt < MEMBER_CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = await generateMemberCode({ ...input, attempt });
    if (!(await input.isTaken(code))) {
      return code;
    }
  }
  throw new MemberCodeExhaustedError(input.tenantId, input.customerGlobalId);
}
