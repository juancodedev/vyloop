/**
 * Card token — the scannable member credential carried by the pass barcode
 * and the customer-web QR.
 *
 * ## Why a token and not `customers.global_id`
 *
 * `global_id` is the customer's identity: it derives the Google object id and
 * travels in events and payloads, and it can never change. A credential that
 * is shown to a counter has to be revocable, so the two are separate values
 * (docs/21 §2-3). Rotating the token bumps `customers.card_token_version`; the
 * identity and the Google `object_id` stay where they are.
 *
 * ## Derived, never stored
 *
 * The database keeps only `card_token_version` and `card_token_hash`. The raw
 * token is recomputed here whenever a pass or a QR is rendered, which is why
 * only this worker holds `CARD_TOKEN_SECRET`. Resolvers (the customer worker's
 * POS route) only ever hash what they scan and compare against the stored hash.
 *
 * ## Shape
 *
 * `vyc1.` + base64url (no padding) of HMAC-SHA256(key = `CARD_TOKEN_SECRET`,
 * message = `card|v1|${t.length}|${t}|${g.length}|${g}|${version}`), with
 * `t = encodeURIComponent(tenantId)` and `g = encodeURIComponent(globalId)`.
 * The message is length-prefixed for the same reason as `member-code.ts`: a
 * delimiter alone lets two different (tenant, customer) pairs collide.
 *
 * ## The secret is load-bearing
 *
 * `tenantId`, `global_id` and the version are all knowable. Without the secret
 * anyone who knows a customer's uuid could mint their current token, which is
 * the exact permanence the token exists to remove. It lives in a worker secret
 * and never in the repository, a `.dev.vars` file or a test fixture.
 */

/** The prefix every token starts with. The digit is the format version. */
export const CARD_TOKEN_PREFIX = 'vyc1.';

/** `vyc1.` plus 43 base64url characters, which is 32 bytes unpadded. */
export const CARD_TOKEN_PATTERN = /^vyc1\.[A-Za-z0-9_-]{43}$/;

export interface CardTokenInput {
  /** `CARD_TOKEN_SECRET`. Required — see the module comment. */
  secret: string;
  /** `tenants.id`, which is also `customers.business_id`. */
  tenantId: string;
  /** `customers.global_id`. Never `customers.id`. */
  customerGlobalId: string;
  /** `customers.card_token_version`. A positive integer. */
  version: number;
}

/**
 * Derive the token for one version of one customer's credential.
 *
 * Rejects an empty secret rather than deriving a token anybody could recompute.
 */
export async function deriveCardToken(input: CardTokenInput): Promise<string> {
  if (input.secret.length === 0) {
    throw new Error(
      'CARD_TOKEN_SECRET is empty. A card token without a secret is derivable by anyone who ' +
        "knows the customer's global id, which defeats revoking it.",
    );
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new Error(
      `card_token_version must be a positive integer, got ${String(input.version)}.`,
    );
  }

  const t = encodeURIComponent(input.tenantId);
  const g = encodeURIComponent(input.customerGlobalId);
  const message = `card|v1|${t.length}|${t}|${g.length}|${g}|${input.version}`;

  const digest = await hmacBytes(input.secret, message);
  return `${CARD_TOKEN_PREFIX}${base64UrlEncode(digest)}`;
}

/**
 * Lowercase hex SHA-256 of the full token string (prefix included), UTF-8.
 *
 * This is the only form the token takes in the database, and the only thing a
 * resolver computes from a scan.
 */
export async function hashCardToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether a value has the token's shape. Says nothing about whether it is current. */
export function isCardToken(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return CARD_TOKEN_PATTERN.test(value);
}

/** HMAC-SHA256 over WebCrypto, for the same reasons as `member-code.ts`. */
async function hmacBytes(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
