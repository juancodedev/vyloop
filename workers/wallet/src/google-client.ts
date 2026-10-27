/**
 * The Google Wallet REST client (T7).
 *
 * The Google Wallet API is **not** a Cloudflare dependency. It runs on Google
 * Cloud at `walletobjects.googleapis.com` and is authenticated with a Google
 * Cloud service account, so there is no Workers binding to declare. Anything
 * that talks to it is an outbound HTTP call with an OAuth bearer token.
 *
 * ## Two implementations, one interface
 *
 * `createUnimplementedGoogleWalletClient` throws from every method and is kept:
 * it is the guard that stops a caller from mistaking a stub for a created pass,
 * and `google-client.test.ts` asserts it. `createGoogleWalletRestClient` is the
 * real one. Both satisfy `GoogleWalletClient`, so a test can substitute either.
 *
 * ## Nothing here is secret-adjacent at module scope
 *
 * The client is constructed from values handed to it, so no credential exists
 * in this file, in a fixture, or in a default. The two outbound calls — the
 * token exchange and the API request — both go through an injected `fetch`, so
 * a test drives the whole thing, including the bearer header and the token
 * cache, with a fake transport and a key pair it generated itself.
 *
 * @see https://developers.google.com/wallet/reference/rest/v1
 */

import { SignJWT, importPKCS8 } from 'jose';

import type { LoyaltyClass } from './class';
import type { LoyaltyObject, LoyaltyObjectMessage } from './object';

/** Fields Google accepts in a class `patch`. */
export type LoyaltyClassPatch = Partial<Omit<LoyaltyClass, 'id'>>;

/**
 * Fields Google accepts in an object `patch`.
 *
 * `accountName` alone also admits `null`, because Google's patch semantics
 * distinguish three things a field can be: absent (left alone), a value
 * (replaced), and JSON `null` (cleared). Expiring a deleted customer's pass is
 * the one caller that needs the third, and an empty string would not do: it is a
 * value, so Google would store and render a blank name rather than remove it.
 * See `EXPIRED_PASS_PATCH` in `expire.ts`. `JSON.stringify` keeps a `null`
 * property, so the client sends it as written.
 */
export type LoyaltyObjectPatch = Partial<Omit<LoyaltyObject, 'id' | 'classId' | 'accountName'>> & {
  accountName?: string | null;
};

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
  /**
   * `loyaltyobject.list`, one page.
   *
   * Scoped by `classId` rather than by `issuerId` on purpose, and this is the
   * load-bearing choice for tenant isolation: a vyloop tenant owns exactly one
   * class (`<issuerId>.tenant-<tenantId>`), so filtering by class is what makes
   * "this tenant's objects" expressible as a server-side predicate rather than
   * as a client-side `if` over every object the issuer holds. A sweep that
   * listed by issuer and filtered locally would hold every merchant's passes in
   * one worker's memory, which is the failure mode the tenant column exists to
   * prevent.
   *
   * @see https://developers.google.com/wallet/reference/rest/v1/loyaltyobject/list
   */
  listObjects(request: LoyaltyObjectListRequest): Promise<LoyaltyObjectListPage>;
  /** `jwt.insert`. */
  saveUriForJwt(jwt: string): Promise<string>;
  /** \`loyaltyobject.addMessage\`. Adds a push notification message to a loyalty object. */
  addMessage(objectId: string, classId: string, message: LoyaltyObjectMessage): Promise<LoyaltyObject>;
}

/**
 * One page of `loyaltyobject.list`.
 *
 * `nextPageToken` is `null` rather than an empty string for "no more pages",
 * because Google omits the field entirely on the last page and an absent field
 * read as `''` would produce a second request with `token=` and an unbounded
 * loop. The distinction is made unrepresentable at the type.
 */
export interface LoyaltyObjectListPage {
  objects: LoyaltyObject[];
  nextPageToken: string | null;
}

export interface LoyaltyObjectListRequest {
  /** The class whose objects are listed. Also the tenant boundary. */
  classId: string;
  /** Sent as `maxResults`. See `OBJECT_PAGE_SIZE` in `sweep.ts`. */
  maxResults: number;
  /** Sent as `token`. Omitted on the first page. */
  token?: string | undefined;
}

/** Google's `loyaltyobject.list` response envelope. */
interface LoyaltyObjectListResponse {
  resources?: LoyaltyObject[];
  pagination?: { nextPageToken?: string | null } | null;
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
    listObjects: () => Promise.reject(new GoogleWalletClientNotImplementedError('listObjects')),
    saveUriForJwt: () => Promise.reject(new GoogleWalletClientNotImplementedError('saveUriForJwt')),
    addMessage: () => Promise.reject(new GoogleWalletClientNotImplementedError('addMessage')),
};
}

// ---------------------------------------------------------------------------
// The real client
// ---------------------------------------------------------------------------

/** The Google Wallet API host. */
export const WALLETOBJECTS_BASE_URL = 'https://walletobjects.googleapis.com/walletobjects/v1';

/**
 * The OAuth scope a pass **issuer** needs.
 *
 * Singular `wallet_object.issuer`, not the plural host name. This is the one
 * detail worth writing down: the host is `walletobjects.googleapis.com` while
 * the scope is `wallet_object.issuer`, and transposing the two produces a
 * token exchange that succeeds and an API call that 403s, which is a miserable
 * thing to debug from a 403.
 *
 * @see https://developers.google.com/wallet/reference/rest/v1/loyaltyclass/insert
 */
export const WALLET_ISSUER_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

/** Google's OAuth 2.0 token endpoint, and the `aud` of the assertion. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The JWT-bearer grant a service account uses. */
export const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/**
 * Assertion lifetime. Google caps it at one hour; a shorter token would mean
 * more exchanges for no benefit, and the exchange is the only request here that
 * is not cacheable by `Cache-Control`.
 */
export const ASSERTION_LIFETIME_SECONDS = 3600;

/**
 * Renew the access token this many seconds before it actually expires.
 *
 * Without the margin, a token that expires one millisecond after a request
 * starts is a 401 that looks like a credential problem. Google rounds
 * `expires_in` down, so the honest margin is not decorative.
 */
export const TOKEN_EXPIRY_MARGIN_SECONDS = 60;

/** The `fetch` shape this client needs. Narrower than the global, on purpose. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface GoogleWalletRestClientOptions {
  /** `client_email` from the service account JSON key. */
  serviceAccountEmail: string;
  /** `private_key` from the JSON key, PEM PKCS#8. */
  privateKeyPem: string;
  /** `private_key_id` from the JSON key. Becomes the assertion's `kid`. */
  privateKeyId?: string | undefined;
  /**
   * Transport. Defaults to the global `fetch`, which is what Workers provides.
   *
   * Injectable so a test can drive every method — including the bearer header
   * and the token cache — without a socket.
   */
  fetchImpl?: FetchLike;
  /** Clock injection, so `iat` and the cache expiry are assertable. */
  now?: () => Date;
}

/** Thrown when the token exchange itself fails. Distinct from an API error. */
export class GoogleWalletAuthError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Could not obtain a Google Wallet access token (HTTP ${status}): ${detail}`);
    this.name = 'GoogleWalletAuthError';
    this.status = status;
  }
}

/** Thrown when a Google response is not the shape the client requires. */
export class GoogleWalletResponseError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Google Wallet API returned an unusable response (HTTP ${status}): ${detail}`);
    this.name = 'GoogleWalletResponseError';
    this.status = status;
  }
}

/**
 * Map vyloop's stored review status onto Google's enum.
 *
 * Stored values are `none` | `draft` | `under_review` | `approved` |
 * `rejected`; Google's are `DRAFT` | `UNDER_REVIEW` | `APPROVED` | `REJECTED`.
 *
 * `none` has no Google counterpart — it means vyloop has no class yet, so there
 * is nothing to read back. It maps to `null` rather than to `DRAFT`, because
 * calling Google's `DRAFT` for a class that does not exist would invent a
 * review state and write it over the row.
 */
export function googleReviewStatusFor(
  stored: string,
): 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | null {
  switch (stored) {
    case 'draft':
      return 'DRAFT';
    case 'under_review':
      return 'UNDER_REVIEW';
    case 'approved':
      return 'APPROVED';
    case 'rejected':
      return 'REJECTED';
    default:
      return null;
  }
}

/**
 * Google's reverse mapping, for writing a freshly read status back.
 *
 * Case-insensitive, because that is what the wire actually carries.
 *
 * The type spells the states in capitals — `DRAFT | UNDER_REVIEW | APPROVED |
 * REJECTED` — because that is how Google's documentation names them, and that
 * spelling is right for what we *send*. What Google *returns* from
 * `loyaltyclass.get` is lower case. So a switch written against the documented
 * spelling matched nothing, `storedReviewStatusFor` returned `null` for every
 * possible response, and `POST /v1/wallet/program/sync` answered `502` with
 * "Google reported a review status this system does not recognise" — for
 * `"approved"`, the one state it was supposed to recognise.
 *
 * The visible effect was that `review_status` could never be written from Google:
 * a class Google had approved kept saying `draft` here, and the customer kept
 * being told their card was awaiting review. The three merchants stuck in `draft`
 * are the same bug.
 *
 * Fail-closed is kept for values that are genuinely unknown. Normalising the case
 * accepts both spellings of a known state; it does not accept a new one.
 */
export function storedReviewStatusFor(
  google: string | null | undefined,
): 'draft' | 'under_review' | 'approved' | 'rejected' | null {
  if (typeof google !== 'string') return null;

  switch (google.trim().toUpperCase()) {
    case 'DRAFT':
      return 'draft';
    case 'UNDER_REVIEW':
      return 'under_review';
    case 'APPROVED':
      return 'approved';
    case 'REJECTED':
      return 'rejected';
    default:
      return null;
  }
}

/** Google's `Jwt` resource with a save URI. */
interface GoogleJwtResource {
  saveUri?: string;
}

/** Google's standard error envelope. */
interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ message?: string; reason?: string; location?: string }>;
  };
}

/**
 * Read a response as `GoogleWalletApiError` or throw.
 *
 * A `204` is not an error, so the check is on status rather than on having a
 * body. `patch` and `jwt.insert` both answer 200 with a resource, and a `get`
 * that misses answers 404 with a body — the one case where the body carries
 * nothing actionable, which is why `get` handles 404 before reaching here.
 */
async function orThrow(response: Response, context: string): Promise<void> {
  if (response.ok) return;

  let body: GoogleErrorBody = {};
  try {
    body = (await response.json()) as GoogleErrorBody;
  } catch {
    // A non-JSON error body is unusual but entirely possible from an edge
    // proxy. The status alone is still worth reporting.
  }

  const details: GoogleWalletErrorDetail[] = (body.error?.errors ?? []).map((detail) => ({
    message: detail.message ?? '',
    reason: detail.reason ?? null,
    location: detail.location ?? null,
  }));

  throw new GoogleWalletApiError(
    response.status,
    body.error?.status ?? null,
    details.length > 0
      ? details
      : [
          {
            message: body.error?.message ?? `${context} failed with no error body`,
            reason: null,
            location: null,
          },
        ],
  );
}

/**
 * Build the real Google Wallet REST client.
 *
 * The access token is cached in a closure for the client's lifetime. A Workers
 * isolate is reused across requests, so this is a real saving, and it is also
 * bounded: the cache is keyed on nothing and the assertion is re-signed at most
 * once an hour, which is the same thing Google allows.
 */
export function createGoogleWalletRestClient(
  options: GoogleWalletRestClientOptions,
): GoogleWalletClient {
  const { serviceAccountEmail, privateKeyPem, privateKeyId } = options;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit));
  const now = options.now ?? (() => new Date());

  let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

  /**
   * Mint a service-account assertion and exchange it for an access token.
   *
   * The assertion is the standard JWT-bearer grant: `iss` and `scope` and `aud`
   * exactly as Google documents, with `exp` one hour out. Signing it is pure
   * WebCrypto through jose, so it works on Workers with no `nodejs_compat`.
   */
  async function mintAccessToken(): Promise<string> {
    const issuedAtSeconds = Math.floor(now().getTime() / 1000);

    const header: { alg: string; typ: string; kid?: string } = { alg: 'RS256', typ: 'JWT' };
    if (privateKeyId !== undefined) header.kid = privateKeyId;

    const assertion = await new SignJWT({ scope: WALLET_ISSUER_SCOPE })
      .setProtectedHeader(header)
      .setIssuer(serviceAccountEmail)
      .setSubject(serviceAccountEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + ASSERTION_LIFETIME_SECONDS)
      .sign(await importPKCS8(privateKeyPem, 'RS256'));

    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      let detail = 'no error body';
      try {
        const body = (await response.json()) as { error?: string; error_description?: string };
        detail = body.error_description ?? body.error ?? detail;
      } catch {
        // Keep the status-only message.
      }
      throw new GoogleWalletAuthError(response.status, detail);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new GoogleWalletAuthError(response.status, 'the response carried no access_token');
    }

    const lifetimeSeconds =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in
        : ASSERTION_LIFETIME_SECONDS;

    cachedToken = {
      accessToken: body.access_token,
      expiresAtMs: now().getTime() + Math.max(0, lifetimeSeconds - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000,
    };

    return cachedToken.accessToken;
  }

  async function accessToken(): Promise<string> {
    if (cachedToken !== null && cachedToken.expiresAtMs > now().getTime()) {
      return cachedToken.accessToken;
    }
    return mintAccessToken();
  }

  /**
   * One authenticated call.
   *
   * `undefined` for `204`. `null` for a `404` on a `get`, because the interface
   * says a missing class is `null` and not an error: a tenant that has never
   * been provisioned is a normal state, not a failure.
   */
  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    context: string,
    body?: unknown,
  ): Promise<T | null> {
    const token = await accessToken();
    const url = `${WALLETOBJECTS_BASE_URL}${path}`;

    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (method === 'GET' && response.status === 404) {
      // Google's own body for a miss is `error.status = "RESOURCE_NOT_FOUND"`
      // and nothing actionable. Reported as absent, which is what it is.
      return null;
    }

    await orThrow(response, context);

    if (response.status === 204) return null;

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new GoogleWalletResponseError(response.status, 'the body was not JSON');
    }

    if (parsed === null || typeof parsed !== 'object') {
      throw new GoogleWalletResponseError(response.status, 'the body was not an object');
    }

    return parsed as T;
  }

  /**
   * The `insert` and `patch` half of the contract: those promise a resource
   * back, so a body-less success is a protocol violation rather than an absent
   * resource.
   *
   * Returning `null` for a successful `insertClass` is exactly the failure
   * `createUnimplementedGoogleWalletClient` exists to prevent at the other end
   * of this spectrum — the caller would believe the class was created and move
   * on. Failing here names it instead.
   */
  async function callForResource<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    context: string,
    body?: unknown,
  ): Promise<T> {
    const result = await call<T>(method, path, context, body);
    if (result === null) {
      throw new GoogleWalletResponseError(
        204,
        `${context} answered success with no resource, so the operation cannot be confirmed`,
      );
    }
    return result;
  }

  /**
   * Google requires the resource id both in the path and in the body for
   * `insert`, and the body copy wins if they disagree. Sending a path built
   * from a different id would create a class the caller did not ask for, so the
   * id is taken from the body in both places.
   */
  function requireId(id: string, method: string): string {
    if (id.trim() === '') {
      throw new Error(
        `GoogleWalletClient.${method}() was called with an empty resource id. A Google ` +
          'LoyaltyClass/LoyaltyObject id must be `<ISSUER_ID>.<IDENTIFIER>`.',
      );
    }
    return id;
  }

  return {
    async getClass(classId) {
      const id = requireId(classId, 'getClass');
      return call<LoyaltyClass>('GET', `/loyaltyClass/${encodeURIComponent(id)}`, 'loyaltyclass.get');
    },

    async insertClass(loyaltyClass) {
      const id = requireId(loyaltyClass.id, 'insertClass');
      return callForResource<LoyaltyClass>(
        'POST',
        `/loyaltyClass?class.id=${encodeURIComponent(id)}`,
        'loyaltyclass.insert',
        loyaltyClass,
      );
    },

    async patchClass(classId, patch) {
      const id = requireId(classId, 'patchClass');
      return callForResource<LoyaltyClass>(
        'PATCH',
        `/loyaltyClass/${encodeURIComponent(id)}`,
        'loyaltyclass.patch',
        patch,
      );
    },

    async getObject(objectId) {
      const id = requireId(objectId, 'getObject');
      return call<LoyaltyObject>(
        'GET',
        `/loyaltyObject/${encodeURIComponent(id)}`,
        'loyaltyobject.get',
      );
    },

/**
       * `insertObject`, which is the only call that makes a pass real.
       *
       * ## The path, and why the capital letter is load-bearing
       *
       * `POST /walletobjects/v1/loyaltyObject` — capital `O`. Verified against the
       * live API: the collection path is case-sensitive and the lowercase form
       * answers a routing `404` with an HTML body, never reaching the point
       * where it could create anything.
       *
       * The per-resource paths (`/loyaltyObject/{resourceId}` for `get` and
       * `patch`) are *not* case-sensitive, which is exactly what makes this
       * easy to get wrong: the neighbouring methods look identical and work.
       *
       * ## Why this matters more than the other methods
       *
       * `getObject` and `patchObject` act on a pass that already exists at
       * Google. This one creates it. A save link is a signed claim naming an
       * object id; if nothing was inserted under that id, the link is
       * well-formed and useless, and Google answers the customer's tap with a
       * generic error while our own endpoints report success.
       */
      async insertObject(loyaltyObject) {
        // Still validated even though the id now travels in the body: a call
        // without one would create an object Google could never link, and the
        // failure would surface as a broken save link rather than here.
        requireId(loyaltyObject.id, 'insertObject');
        return callForResource<LoyaltyObject>(
          'POST',
          `/loyaltyObject`,
          'loyaltyobject.insert',
          loyaltyObject,
        );
      },

    /**
     * `listObjects`, one page.
     *
     * ## Why the query is built by hand rather than with `URLSearchParams`
     *
     * Because `maxResults` is sent even when the caller passed a token, and
     * because an empty `token` must be absent rather than blank: `?token=` is a
     * distinct request from no token at all, and Google answers a blank token
     * as an error rather than as page one. A `URLSearchParams` builder given
     * `''` would emit the blank form.
     *
     * ## Why `resources` is validated rather than defaulted
     *
     * A `list` response whose `resources` is missing is a response this client
     * does not understand, and the two available readings are both unacceptable
     * for a sweep: "the tenant has no objects" would report a clean run having
     * verified nothing, and "some objects" would be a guess. So it throws, and
     * a scheduled job that threw here fails that tenant loudly instead of
     * quietly marking a stale pass as fresh.
     */
    async listObjects(request) {
      requireId(request.classId, 'listObjects');

      const query = [
        `classId=${encodeURIComponent(request.classId)}`,
        `maxResults=${encodeURIComponent(String(request.maxResults))}`,
      ];
      if (request.token !== undefined && request.token !== '') {
        query.push(`token=${encodeURIComponent(request.token)}`);
      }

      const resource = await call<LoyaltyObjectListResponse>(
        'GET',
        `/loyaltyObject?${query.join('&')}`,
        'loyaltyobject.list',
      );

      // `call` only resolves to `null` for a 404 on a GET, and a list for a
      // class that does not exist is a 200 with an empty page. Reaching `null`
      // therefore means the class is genuinely gone, which is reported as an
      // empty page rather than an error so a deleted class sweeps as "nothing
      // to do" instead of retrying forever.
      const resources = resource?.resources;
      if (!Array.isArray(resources)) {
        throw new GoogleWalletResponseError(
          200,
          'loyaltyobject.list answered success without a `resources` array, so the page cannot be ' +
            'interpreted. Treating it as an empty page would report a clean sweep having verified ' +
            'nothing.',
        );
      }

      const next = resource?.pagination?.nextPageToken;

      return {
        objects: resources,
        nextPageToken: typeof next === 'string' && next !== '' ? next : null,
      };
    },

    async patchObject(objectId, patch) {
      const id = requireId(objectId, 'patchObject');
      return callForResource<LoyaltyObject>(
        'PATCH',
        `/loyaltyObject/${encodeURIComponent(id)}`,
        'loyaltyobject.patch',
        patch,
      );
    },

    async saveUriForJwt(jwt) {
      if (jwt.trim() === '') {
        throw new Error(
          'GoogleWalletClient.saveUriForJwt() was called with an empty token. A save token with ' +
            'no payload creates nothing, and Google rejects it.',
        );
      }

      const resource = await call<GoogleJwtResource>(
        'POST',
        '/jwt',
        'jwt.insert',
        { jwt },
      );

      if (resource === null || typeof resource.saveUri !== 'string' || resource.saveUri === '') {
        throw new GoogleWalletResponseError(200, 'the response carried no saveUri');
      }

      return resource.saveUri;
    },

    async addMessage(objectId, classId, message) {
      const id = requireId(objectId, 'addMessage');
      return callForResource<LoyaltyObject>(
        'POST',
        "/loyaltyObject/" + encodeURIComponent(id) + "/addMessage",
        'loyaltyobject.addMessage',
        { classId, message },
      );
    },
  };
}
