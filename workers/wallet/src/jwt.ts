/**
 * Save-to-wallet JWT signing (T5).
 *
 * ## This is not the identity worker's JWT
 *
 * The gateway's internal auth token is HS256: a shared secret, symmetric, and
 * meaningless to anyone outside vyloop. The Google Wallet save token is RS256:
 * asymmetric, signed with the **private key of a Google Cloud service account**,
 * and verified by Google against the public key already registered for that
 * service account. Copying the identity signer's shape here would produce a
 * token Google rejects with an opaque 400.
 *
 * ## Where the key comes from
 *
 * The PEM private key is read from a worker secret binding. It is never present
 * in the repository, in `.dev.vars`, in a test fixture, or in a commit. Tests
 * generate their own key pair with `node:crypto` at runtime and throw it away.
 *
 * ## Claim shape
 *
 * `iss`, `aud`, `typ`, `iat`, `payload` and `origins` are all required by
 * Google's `Jwt` resource. Two of them are routinely missed:
 *
 * - `iat` is required. Without it the token is rejected.
 * - `origins` is required, and Google's own documentation notes the Add to
 *   Wallet button will not render when it is absent. An empty array is
 *   therefore rejected here rather than passed through: it is the shape that
 *   produces a button which silently fails in the browser.
 *
 * There is deliberately **no `exp` claim**. Google's `Jwt` resource does not
 * define one, and adding an expiry would narrow the window in which a member
 * can tap "Add to Wallet" for no benefit.
 *
 * @see https://developers.google.com/wallet/reference/rest/v1/Jwt
 */

import { SignJWT, importPKCS8 } from 'jose';

import type { LoyaltyClass } from './class';
import type { LoyaltyObject } from './object';

/** Google's fixed audience for a save-to-wallet token. */
export const SAVE_TO_WALLET_AUDIENCE = 'google';

/** Google's fixed token type. */
export const SAVE_TO_WALLET_TYPE = 'savetowallet';

/** The URL prefix Google's save button uses to redeem the signed token. */
export const SAVE_TO_WALLET_URL_PREFIX = 'https://pay.google.com/gp/v/save/';

/** The payload Google reads, with only the loyalty arrays populated. */
export interface SaveToWalletPayload {
  loyaltyClasses?: LoyaltyClass[];
  loyaltyObjects?: LoyaltyObject[];
}

export interface SignSaveToWalletJwtInput {
  /** The service account email, `client_email` from the JSON key. `iss`. */
  serviceAccountEmail: string;
  /** The PEM-encoded RSA private key. `RS256` signing key. */
  privateKeyPem: string;
  /** `private_key_id` from the JSON key, when available. Becomes the `kid`. */
  privateKeyId?: string;
  /** At least one origin. See the module comment. */
  origins: readonly string[];
  /** Classes to create or update as part of this save. */
  loyaltyClasses?: readonly LoyaltyClass[] | undefined;
  /** Objects to create or update as part of this save. */
  loyaltyObjects?: readonly LoyaltyObject[] | undefined;
  /** Clock injection point, so `iat` is assertable. Defaults to `Date.now`. */
  now?: Date;
}

/**
 * Import a PEM RSA private key for RS256 signing.
 *
 * jose reads the PEM through WebCrypto, so this works on Workers and in Node
 * with no Node-only signing path. Google service-account keys are PKCS#8 PEM
 * (`BEGIN PRIVATE KEY`), never the SEC1 form (`BEGIN RSA PRIVATE KEY`).
 */
async function signingKey(privateKeyPem: string): Promise<CryptoKey> {
  return importPKCS8(privateKeyPem, 'RS256');
}

/** Thrown when the inputs cannot produce a token Google would accept. */
export class SaveToWalletJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveToWalletJwtError';
  }
}

/**
 * Sign a save-to-wallet JWT and return the full Add to Wallet URL.
 *
 * The URL is returned rather than the bare token because that is what the
 * customer-facing surface needs, and a caller that assembles the prefix itself
 * is one typo away from a dead link.
 */
export async function createSaveToWalletUrl(
  input: SignSaveToWalletJwtInput,
): Promise<string> {
  if (input.serviceAccountEmail.trim().length === 0) {
    throw new SaveToWalletJwtError(
      'The service account email is empty. It is the `iss` claim and Google rejects the token without it.',
    );
  }
  if (input.privateKeyPem.trim().length === 0) {
    throw new SaveToWalletJwtError(
      'The RSA private key is empty. It must come from a worker secret binding, never from the repository.',
    );
  }
  if (input.origins.length === 0) {
    throw new SaveToWalletJwtError(
      '`origins` is empty. Google does not render the Add to Wallet button when `origins` is ' +
        'absent, so an empty list produces a control that silently fails in the browser. ' +
        'Pass the origins the button will be rendered on.',
    );
  }

  const classes = input.loyaltyClasses ?? [];
  const objects = input.loyaltyObjects ?? [];
  if (classes.length === 0 && objects.length === 0) {
    throw new SaveToWalletJwtError(
      'A save token with no classes and no objects would create nothing. Google rejects it, and ' +
        'an Add to Wallet button that adds nothing is the exact failure T9 exists to avoid.',
    );
  }

  // An absent array means "no classes in this token". A present-but-empty array
  // is an instruction to do nothing with an empty set, which is a different
  // thing to say. Google's own create-objects-only examples send just the
  // objects.
  const payload: SaveToWalletPayload = {};
  if (classes.length > 0) payload.loyaltyClasses = [...classes];
  if (objects.length > 0) payload.loyaltyObjects = [...objects];

  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);

  const header: { alg: string; typ: string; kid?: string } = { alg: 'RS256', typ: 'JWT' };
  if (input.privateKeyId !== undefined) header.kid = input.privateKeyId;

  const token = await new SignJWT({
    aud: SAVE_TO_WALLET_AUDIENCE,
    typ: SAVE_TO_WALLET_TYPE,
    origins: [...input.origins],
    payload,
  })
    .setProtectedHeader(header)
    .setIssuer(input.serviceAccountEmail)
    // Google requires `iat`; jose serialises it from this value.
    .setIssuedAt(issuedAt)
    .sign(await signingKey(input.privateKeyPem));

  return `${SAVE_TO_WALLET_URL_PREFIX}${token}`;
}
