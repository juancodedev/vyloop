/**
 * Google Wallet resource identifiers (T2).
 *
 * Google requires every `LoyaltyClass.id` and `LoyaltyObject.id` to be
 * `<ISSUER_ID>.<IDENTIFIER>`, where the identifier part may contain only
 * alphanumerics, `.`, `_` and `-`.
 *
 * Two design decisions that are easy to get wrong:
 *
 * 1. The class suffix is derived from the **tenant UUID**, never from
 *    `tenants.slug`. `slug` is a `text` column with a unique index and no
 *    format validation anywhere in the repo, so a merchant can set a slug
 *    containing spaces, accents or slashes. The UUID is already restricted to
 *    `[0-9a-f-]`, which makes the id valid by construction and stable under a
 *    slug rename.
 *
 * 2. The object suffix is derived from `customers.globalId`, never from
 *    `customers.id`. `global_id` is a `uuid` with `defaultRandom()` that is
 *    minted once and carried across environments, so the pass id survives a
 *    database restore or a clone into staging. `customers.id` does not.
 *
 * `sanitizeIdPart` is applied to the issuer id and to the suffix anyway. A
 * function that cannot emit an invalid id is worth more than a validator some
 * future caller might forget to invoke, so the builders sanitise *and* assert.
 */

/**
 * The character set Google accepts in a resource identifier. Lowercased input
 * is matched against this, so the builders only ever emit lowercase ids.
 */
export const GOOGLE_ID_PATTERN = /^[a-z0-9._-]+$/;

/**
 * A full Google id must be an issuer part and a suffix part joined by a single
 * dot. The issuer part itself is numeric in practice, but the API only
 * documents it as an identifier, so it is not narrowed further.
 */
export const GOOGLE_QUALIFIED_ID_PATTERN = /^[a-z0-9._-]+\.[a-z0-9._-]+$/;

/** Thrown when an id cannot be made valid, which means a caller is wrong. */
export class InvalidGoogleIdError extends Error {
  readonly value: string;

  constructor(value: string, detail: string) {
    super(`Cannot build a Google Wallet id from ${JSON.stringify(value)}: ${detail}`);
    this.name = 'InvalidGoogleIdError';
    this.value = value;
  }
}

/**
 * Reduce an arbitrary string to the character set Google accepts.
 *
 * Every disallowed character becomes a single `-` so the mapping stays
 * length-bounded and two different inputs cannot collapse onto the same output
 * just by run length. Leading and trailing `.`, `_` and `-` are stripped: an
 * id that starts or ends with a separator is legal per the character set but
 * invites a mistake when the id is split on `.`, and the value is never a
 * meaningful prefix or suffix.
 *
 * @throws {InvalidGoogleIdError} when nothing survives, e.g. an emoji-only
 * value. An empty id is never correct, so failing loudly beats emitting one.
 */
export function sanitizeIdPart(value: string): string {
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');

  if (collapsed.length === 0) {
    throw new InvalidGoogleIdError(value, 'no characters allowed by Google remain');
  }

  return collapsed;
}

/**
 * True when `value` is already a valid single Google identifier part, with no
 * sanitising applied. Exported so callers that receive an id from Google (a
 * class read back after a patch, for example) can assert on it without the
 * assertion silently repairing the value.
 */
export function isValidIdPart(value: string): boolean {
  return GOOGLE_ID_PATTERN.test(value);
}

/** True when `value` is a valid qualified `<ISSUER_ID>.<IDENTIFIER>` id. */
export function isValidGoogleId(value: string): boolean {
  return GOOGLE_QUALIFIED_ID_PATTERN.test(value);
}

/**
 * Assemble and verify a qualified id. The assertion is a backstop for the
 * sanitiser, not the primary mechanism: if the two ever disagree the sanitiser
 * has a bug and failing here is far better than sending Google a 400.
 */
function qualify(issuerId: string, suffix: string): string {
  const id = `${sanitizeIdPart(issuerId)}.${suffix}`;

  if (!isValidGoogleId(id)) {
    throw new InvalidGoogleIdError(id, 'the assembled id failed Google identifier validation');
  }

  return id;
}

/**
 * `<issuerId>.tenant-<tenantId>` — one pass class per tenant.
 *
 * A class is the merchant's program branding (logo, program name, colours), so
 * a rename or a rebrand is a single class patch that propagates immediately to
 * every object referencing it.
 */
export function classIdFor(issuerId: string, tenantId: string): string {
  return qualify(issuerId, `tenant-${sanitizeIdPart(tenantId)}`);
}

/**
 * `<issuerId>.member-<customerGlobalId>` — one pass object per customer.
 *
 * @param customerGlobalId `customers.global_id`, never `customers.id`.
 */
export function objectIdFor(issuerId: string, customerGlobalId: string): string {
  return qualify(issuerId, `member-${sanitizeIdPart(customerGlobalId)}`);
}

/**
 * The prefix Google uses when a pass is still in Demo Mode. Demo passes only
 * reach the issuer's own Admin/Developer/test accounts; publishing access is a
 * single approval for the whole issuer, and until it lands this prefix is
 * correct. Removing it is an operational step, not a code change.
 */
export const DEMO_MODE_NAME_PREFIX = '[TEST ONLY] ';
