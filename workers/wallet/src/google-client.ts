/**
 * The Google Wallet REST client boundary (T7).
 *
 * The Google Wallet API is **not** a Cloudflare dependency. It runs on Google
 * Cloud at `walletobjects.googleapis.com` and is authenticated with a Google
 * Cloud service account, so there is no Workers binding to declare. Anything
 * that talks to it is an outbound HTTP call with an OAuth bearer token, and
 * that is deliberately absent from this unit.
 *
 * The interface exists so the payload builders, the id derivation and the JWT
 * signer are all exercisable offline, with no network and no credential. The
 * real implementation belongs in a later unit, when an issuer account, a
 * Google Cloud project and a service account exist.
 *
 * ## The failure mode this file exists to prevent
 *
 * A stub that returns a resolved promise, or an empty object, is worse than no
 * stub at all: the caller believes the class was created and moves on. So the
 * unimplemented client throws. It is a real, tested guard, not a placeholder
 * that hides a missing integration.
 */

import type { LoyaltyClass } from './class';
import type { LoyaltyObject } from './object';

/** Fields Google accepts in a class `patch`. */
export type LoyaltyClassPatch = Partial<Omit<LoyaltyClass, 'id'>>;

/** Fields Google accepts in an object `patch`. */
export type LoyaltyObjectPatch = Partial<Omit<LoyaltyObject, 'id' | 'classId'>>;

/**
 * An error carrying Google's HTTP status and its structured error body.
 *
 * The body matters: Google's 4xx responses name the offending field
 * (`wallet_object.invalidId`, `loyaltyClass.notApproved`, …), and swallowing it
 * turns every integration bug into the same opaque 400.
 */
export class GoogleWalletApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly errors: readonly GoogleWalletErrorDetail[];

  constructor(status: number, code: string | null, errors: readonly GoogleWalletErrorDetail[]) {
    const reasons = errors.map((detail) => detail.message).filter(Boolean).join('; ');
    super(
      `Google Wallet API responded ${status}${code ? ` (${code})` : ''}` +
        `${reasons ? `: ${reasons}` : ''}`,
    );
    this.name = 'GoogleWalletApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export interface GoogleWalletErrorDetail {
  message: string;
  reason: string | null;
  location: string | null;
}

/**
 * The subset of `walletobjects.googleapis.com/walletobjects/v1` this system
 * needs.
 *
 * `saveUriForJwt` is the `jwt.insert` endpoint: it accepts a signed save token
 * and returns the `saveUri` the customer is redirected to. The alternative is
 * to build `https://pay.google.com/gp/v/save/<jwt>` locally, which this system
 * does, but Google's own resolution is the authority on whether a token is
 * valid and should be preferred once an implementation exists.
 */
export interface GoogleWalletClient {
  /** `loyaltyclass.get`. */
  getClass(classId: string): Promise<LoyaltyClass | null>;
  /** `loyaltyclass.insert`. */
  insertClass(loyaltyClass: LoyaltyClass): Promise<LoyaltyClass>;
  /** `loyaltyclass.patch`. */
  patchClass(classId: string, patch: LoyaltyClassPatch): Promise<LoyaltyClass>;
  /** `loyaltyobject.get`. */
  getObject(objectId: string): Promise<LoyaltyObject | null>;
  /** `loyaltyobject.insert`. */
  insertObject(loyaltyObject: LoyaltyObject): Promise<LoyaltyObject>;
  /** `loyaltyobject.patch`. */
  patchObject(objectId: string, patch: LoyaltyObjectPatch): Promise<LoyaltyObject>;
  /** `jwt.insert`. */
  saveUriForJwt(jwt: string): Promise<string>;
}

/** Thrown by every method of the unimplemented client. */
export class GoogleWalletClientNotImplementedError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(
      `GoogleWalletClient.${method}() is not implemented. The Google Wallet REST client lands ` +
        'with the issuer account, the Google Cloud project and the service account invitation; ' +
        'until then this worker builds payloads and signs tokens only. It throws rather than ' +
        'resolving so a caller cannot mistake a stub for a created pass.',
    );
    this.name = 'GoogleWalletClientNotImplementedError';
    this.method = method;
  }
}

/**
 * The unimplemented client.
 *
 * Exists so the interface is provably implementable — every method is present
 * with the right signature — and so an integration that reaches for the client
 * before it exists fails loudly instead of silently doing nothing.
 */
export function createUnimplementedGoogleWalletClient(): GoogleWalletClient {
  return {
    getClass: () => Promise.reject(new GoogleWalletClientNotImplementedError('getClass')),
    insertClass: () => Promise.reject(new GoogleWalletClientNotImplementedError('insertClass')),
    patchClass: () => Promise.reject(new GoogleWalletClientNotImplementedError('patchClass')),
    getObject: () => Promise.reject(new GoogleWalletClientNotImplementedError('getObject')),
    insertObject: () => Promise.reject(new GoogleWalletClientNotImplementedError('insertObject')),
    patchObject: () => Promise.reject(new GoogleWalletClientNotImplementedError('patchObject')),
    saveUriForJwt: () => Promise.reject(new GoogleWalletClientNotImplementedError('saveUriForJwt')),
  };
}
