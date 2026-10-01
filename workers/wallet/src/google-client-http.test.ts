import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { LoyaltyClass } from './class';
import {
  ASSERTION_LIFETIME_SECONDS,
  GOOGLE_TOKEN_URL,
  JWT_BEARER_GRANT_TYPE,
  TOKEN_EXPIRY_MARGIN_SECONDS,
  WALLET_ISSUER_SCOPE,
  WALLETOBJECTS_BASE_URL,
  GoogleWalletApiError,
  GoogleWalletAuthError,
  GoogleWalletResponseError,
  createGoogleWalletRestClient,
  createUnimplementedGoogleWalletClient,
  googleReviewStatusFor,
  storedReviewStatusFor,
} from './google-client';
import type { FetchLike } from './google-client';
import type { LoyaltyObject } from './object';

// ---------------------------------------------------------------------------
// No network, no credential
//
// The key pair below is generated for this run with WebCrypto and discarded.
// `fetch` is injected, so the token exchange, the bearer header, the token
// cache and every error path are exercised without a socket and without a real
// service account existing anywhere.
// ---------------------------------------------------------------------------

const SERVICE_ACCOUNT = 'wallet@vyloop-demo.iam.gserviceaccount.com';
const KEY_ID = 'a1b2c3d4e5f6';
const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const CLASS_ID = `${ISSUER}.tenant-${TENANT}`;
const OBJECT_ID = `${ISSUER}.member-c8b61954-1b6d-4dfa-9954-b7c936a9e648`;

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  privateKeyPem = await toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY');
  publicKeyPem = await toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY');
});

async function toPem(der: ArrayBuffer, label: string): Promise<string> {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface Transport {
  fetch: FetchLike;
  calls: Recorded[];
  tokenCalls: () => Recorded[];
  apiCalls: () => Recorded[];
}

/**
 * A fake Google. `tokenResponses` are consumed in order, so a test can drive the
 * cache to expiry by returning a short-lived token and then advancing the clock.
 */
function fakeGoogle(options: {
  tokenResponses?: Array<{ status: number; body: unknown; accessToken?: string; expiresIn?: number }>;
  apiResponse?: { status: number; body: unknown };
  now?: () => Date;
} = {}): Transport {
  const calls: Recorded[] = [];
  const tokenResponses = options.tokenResponses ?? [
    { status: 200, body: { access_token: 'test-token-1', expires_in: 3600 } },
  ];
  let tokenIndex = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    const record: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(record);

    if (url === GOOGLE_TOKEN_URL) {
      const response = tokenResponses[Math.min(tokenIndex, tokenResponses.length - 1)]!;
      tokenIndex += 1;
      return new Response(JSON.stringify(response.body), { status: response.status });
    }

    const response = options.apiResponse ?? {
      status: 200,
      body: { id: CLASS_ID, reviewStatus: 'APPROVED' },
    };
    return new Response(JSON.stringify(response.body), { status: response.status });
  };

  return {
    fetch: fetchImpl,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === GOOGLE_TOKEN_URL),
    apiCalls: () => calls.filter((c) => c.url.startsWith(WALLETOBJECTS_BASE_URL)),
  };
}

function client(transport: Transport, now?: () => Date) {
  return createGoogleWalletRestClient({
    serviceAccountEmail: SERVICE_ACCOUNT,
    privateKeyPem,
    privateKeyId: KEY_ID,
    fetchImpl: transport.fetch,
    ...(now ? { now } : {}),
  });
}

/** Decode the assertion the client sent to the token endpoint. */
async function assertionClaims(body: string | undefined): Promise<Record<string, unknown>> {
  const params = new URLSearchParams(body ?? '');
  const assertion = params.get('assertion');
  expect(assertion).toBeTruthy();
  const { decodeJwt } = await import('jose');
  // `decodeJwt` returns the claims themselves, not a `{ header, payload }`
  // envelope. No signature is verified here on purpose: the assertion's whole
  // point is that Google verifies it, and the signature is asserted separately
  // against the generated public key below.
  return decodeJwt(assertion as string) as Record<string, unknown>;
}

// ============================================================================
// The scope and the token exchange
// ============================================================================

describe('access token exchange', () => {
  it('asks for the singular issuer scope, not the plural host name', async () => {
    // The one detail worth pinning: the host is `walletobjects.googleapis.com`
    // and the scope is `wallet_object.issuer`. Transposing the two produces a
    // token exchange that succeeds and an API call that 403s, which is a
    // miserable thing to debug.
    const transport = fakeGoogle();
    await client(transport).getClass(CLASS_ID);

    expect(WALLET_ISSUER_SCOPE).toBe('https://www.googleapis.com/auth/wallet_object.issuer');
    const claims = await assertionClaims(transport.tokenCalls()[0]!.body);
    expect(claims.scope).toBe(WALLET_ISSUER_SCOPE);
  });

  it('uses the JWT-bearer grant and the documented token endpoint', async () => {
    const transport = fakeGoogle();
    await client(transport).getClass(CLASS_ID);

    const call = transport.tokenCalls()[0]!;
    expect(call.url).toBe('https://oauth2.googleapis.com/token');
    expect(call.method).toBe('POST');
    const params = new URLSearchParams(call.body ?? '');
    expect(params.get('grant_type')).toBe(JWT_BEARER_GRANT_TYPE);
    expect(params.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    expect(params.get('assertion')).toBeTruthy();
  });

  it('signs the assertion with iss, sub, aud, scope and a one-hour exp', async () => {
    const transport = fakeGoogle();
    const now = new Date('2026-09-28T12:00:00.000Z');
    await client(transport, () => now).getClass(CLASS_ID);

    const claims = await assertionClaims(transport.tokenCalls()[0]!.body);

    expect(claims.iss).toBe(SERVICE_ACCOUNT);
    expect(claims.sub).toBe(SERVICE_ACCOUNT);
    expect(claims.aud).toBe(GOOGLE_TOKEN_URL);
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    // Google caps the assertion at one hour.
    expect(Number(claims.exp) - Number(claims.iat)).toBe(ASSERTION_LIFETIME_SECONDS);
  });

  it('carries the private key id so Google can identify the key', async () => {
    const transport = fakeGoogle();
    await client(transport).getClass(CLASS_ID);

    const { decodeProtectedHeader } = await import('jose');
    const assertion = new URLSearchParams(transport.tokenCalls()[0]!.body ?? '').get('assertion');
    const header = decodeProtectedHeader(assertion as string);

    expect(header.kid).toBe(KEY_ID);
    expect(header.alg).toBe('RS256');
  });

  it('produces an assertion Google can verify, against the generated public key', async () => {
    const transport = fakeGoogle();
    await client(transport).getClass(CLASS_ID);

    const { jwtVerify, importSPKI } = await import('jose');
    const assertion = new URLSearchParams(transport.tokenCalls()[0]!.body ?? '').get('assertion');

    const { payload } = await jwtVerify(assertion as string, await importSPKI(publicKeyPem, 'RS256'));
    expect(payload.iss).toBe(SERVICE_ACCOUNT);
  });

  it('sends the token as a bearer header on the API call', async () => {
    const transport = fakeGoogle();
    await client(transport).getClass(CLASS_ID);

    expect(transport.apiCalls()[0]!.headers.Authorization).toBe('Bearer test-token-1');
  });

  it('exchanges the token once and reuses it across calls', async () => {
    // A Workers isolate is reused across requests, so an uncached token would be
    // an extra outbound HTTPS round trip per request for no benefit.
    const transport = fakeGoogle();
    const google = client(transport);

    await google.getClass(CLASS_ID);
    await google.getObject(OBJECT_ID);
    await google.getClass(CLASS_ID);

    expect(transport.tokenCalls()).toHaveLength(1);
    expect(transport.apiCalls()).toHaveLength(3);
  });

  it('renews before the token actually expires', async () => {
    // Google rounds `expires_in` down. Without a margin, a token that expires one
    // millisecond after a request starts is a 401 that looks like a credential
    // problem.
    let now = new Date('2026-09-28T12:00:00.000Z');
    const transport = fakeGoogle({
      tokenResponses: [
        { status: 200, body: { access_token: 'short-1', expires_in: 3600 } },
        { status: 200, body: { access_token: 'short-2', expires_in: 3600 } },
      ],
    });
    const google = client(transport, () => now);

    await google.getClass(CLASS_ID);

    // One second before the margin expires: still cached.
    now = new Date(now.getTime() + (3600 - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000 - 1);
    await google.getClass(CLASS_ID);
    expect(transport.tokenCalls()).toHaveLength(1);

    // Past the margin: renewed.
    now = new Date(now.getTime() + 2);
    await google.getClass(CLASS_ID);
    expect(transport.tokenCalls()).toHaveLength(2);
  });

  it('reports a refused exchange as an auth error, distinct from an API error', async () => {
    // A 403 from the token endpoint almost always means the service account was
    // never invited to the issuer account, which is a setup problem and not a
    // bad payload. Collapsing the two into one error class would hide that.
    const transport = fakeGoogle({
      tokenResponses: [
        {
          status: 403,
          body: { error: 'unauthorized_client', error_description: 'Invalid JWT Signature.' },
        },
      ],
    });

    await expect(client(transport).getClass(CLASS_ID)).rejects.toBeInstanceOf(
      GoogleWalletAuthError,
    );
  });

  it('names the exchange failure detail, which is the diagnosis', async () => {
    const transport = fakeGoogle({
      tokenResponses: [
        { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } },
      ],
    });

    await expect(client(transport).getClass(CLASS_ID)).rejects.toThrow(/Invalid JWT Signature/);
  });

  it('refuses a token response that carries no access token', async () => {
    // A 200 with an empty body is the shape that would otherwise send
    // `Authorization: Bearer undefined` to Google.
    const transport = fakeGoogle({ tokenResponses: [{ status: 200, body: { expires_in: 3600 } }] });

    await expect(client(transport).getClass(CLASS_ID)).rejects.toBeInstanceOf(
      GoogleWalletAuthError,
    );
  });
});

// ============================================================================
// The operations
// ============================================================================

describe('class operations', () => {
  it('reads a class by id', async () => {
    const transport = fakeGoogle({
      apiResponse: { status: 200, body: { id: CLASS_ID, reviewStatus: 'APPROVED' } },
    });

    const found = await client(transport).getClass(CLASS_ID);

    expect(found?.id).toBe(CLASS_ID);
    expect(transport.apiCalls()[0]!.method).toBe('GET');
    expect(transport.apiCalls()[0]!.url).toBe(
      `${WALLETOBJECTS_BASE_URL}/loyaltyClass/${CLASS_ID}`,
    );
  });

  it('reports a class Google does not have as null, not as an error', async () => {
    // A tenant that has never been provisioned is a normal state, and the
    // interface says a missing class is `null`.
    const transport = fakeGoogle({
      apiResponse: { status: 404, body: { error: { status: 'RESOURCE_NOT_FOUND' } } },
    });

    expect(await client(transport).getClass(CLASS_ID)).toBeNull();
  });

  it('inserts a class with the id in both the path and the body', async () => {
    // Google takes the id from both, and the body copy wins. A path built from a
    // different id would create a class the caller did not ask for.
    const transport = fakeGoogle();
    const loyaltyClass: LoyaltyClass = {
      id: CLASS_ID,
      issuerName: 'Lawen Tech Solutions',
      localizedIssuerName: {
        defaultValue: { language: 'es-CL', value: 'Café Central' },
      },
      programName: 'Puntos Café Central',
      reviewStatus: 'DRAFT',
      countryCode: 'CL',
    };

    await client(transport).insertClass(loyaltyClass);

    const call = transport.apiCalls()[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${WALLETOBJECTS_BASE_URL}/loyaltyClass?class.id=${CLASS_ID}`);
    expect(JSON.parse(call.body!)).toEqual(loyaltyClass);
  });

  it('patches a class at its own path', async () => {
    const transport = fakeGoogle();

    await client(transport).patchClass(CLASS_ID, { programName: 'Puntos Renombrados' });

    const call = transport.apiCalls()[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe(`${WALLETOBJECTS_BASE_URL}/loyaltyClass/${CLASS_ID}`);
    expect(JSON.parse(call.body!)).toEqual({ programName: 'Puntos Renombrados' });
  });
});

describe('object operations', () => {
  it('reads an object by id and reports a missing one as null', async () => {
    const present = fakeGoogle({ apiResponse: { status: 200, body: { id: OBJECT_ID } } });
    expect((await client(present).getObject(OBJECT_ID))?.id).toBe(OBJECT_ID);

    const missing = fakeGoogle({ apiResponse: { status: 404, body: {} } });
    expect(await client(missing).getObject(OBJECT_ID)).toBeNull();
  });

  it('inserts an object with the id in both the path and the body', async () => {
    const transport = fakeGoogle();
    const loyaltyObject: LoyaltyObject = {
      id: OBJECT_ID,
      classId: CLASS_ID,
      state: 'ACTIVE',
      accountId: 'K7M2QX',
      loyaltyPoints: { label: 'puntos', balance: { string: '96942' } },
      barcode: { type: 'QR_CODE', value: 'c8b61954-1b6d-4dfa-9954-b7c936a9e648' },
    };

    await client(transport).insertObject(loyaltyObject);

    const call = transport.apiCalls()[0]!;
    // The collection path, with the id in the body. Capital `O`, and that is not a
    // style choice: the collection path is case-sensitive, and the lowercase form
    // answers a routing 404 with an HTML body. The per-resource paths for `get`
    // and `patch` are not case-sensitive, which is what makes the two look alike.
    expect(call.url).toBe(`${WALLETOBJECTS_BASE_URL}/loyaltyObject`);
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!)).toEqual(loyaltyObject);
  });

  it('spells every path the way Google does, because the URLs are case-sensitive', async () => {
    // The assertions above compare URL strings, and that is exactly why this
    // survived so long: the test asserted whatever the code was written with, so
    // a wrong path and a wrong test agreed. Google answers a wrongly-cased path
    // with a routing 404 and an HTML body, while a missing resource is a JSON
    // error from the API — and a fake transport cannot tell the two apart.
    //
    // So the spelling is pinned here instead, in one place, against the resource
    // names Google's own discovery document uses.
    const transport = fakeGoogle();
    const google = client(transport);

    await google.getClass(CLASS_ID);
    await google.patchClass(CLASS_ID, { programName: 'x' });
    await google.getObject(OBJECT_ID);
    await google.patchObject(OBJECT_ID, { state: 'ACTIVE' });

    for (const url of transport.apiCalls().map((c) => c.url)) {
      expect(url).not.toMatch(/\/loyaltyclass([/?]|$)/);
      expect(url).not.toMatch(/\/loyaltyobject([/?]|$)/);
      expect(url).toMatch(/\/loyalty(Class|Object)([/?]|$)/);
    }
  });

  it('patches an object, which is how a balance is projected onto a saved pass', async () => {
    const transport = fakeGoogle();

    await client(transport).patchObject(OBJECT_ID, {
      loyaltyPoints: { label: 'puntos', balance: { string: '100000' } },
    });

    const call = transport.apiCalls()[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe(`${WALLETOBJECTS_BASE_URL}/loyaltyObject/${OBJECT_ID}`);
  });

  it('sends a JSON content type only when there is a body', async () => {
    const transport = fakeGoogle();

    await client(transport).getObject(OBJECT_ID);
    expect(transport.apiCalls()[0]!.headers['Content-Type']).toBeUndefined();

    await client(transport).patchObject(OBJECT_ID, { state: 'INACTIVE' });
    expect(transport.apiCalls()[1]!.headers['Content-Type']).toBe('application/json');
  });
});

describe('saveUriForJwt', () => {
  it('posts the token and returns the save URI Google resolved', async () => {
    const transport = fakeGoogle({
      apiResponse: { status: 200, body: { saveUri: 'https://pay.google.com/gp/v/save/abc123' } },
    });

    const uri = await client(transport).saveUriForJwt('header.payload.signature');

    expect(uri).toBe('https://pay.google.com/gp/v/save/abc123');
    expect(transport.apiCalls()[0]!.url).toBe(`${WALLETOBJECTS_BASE_URL}/jwt`);
    expect(JSON.parse(transport.apiCalls()[0]!.body!)).toEqual({
      jwt: 'header.payload.signature',
    });
  });

  it('refuses a response with no save URI instead of returning undefined', async () => {
    const transport = fakeGoogle({ apiResponse: { status: 200, body: {} } });

    await expect(client(transport).saveUriForJwt('a.b.c')).rejects.toBeInstanceOf(
      GoogleWalletResponseError,
    );
  });

  it('refuses an empty token rather than posting one', async () => {
    // A save token with no payload creates nothing, and Google rejects it.
    const transport = fakeGoogle();

    await expect(client(transport).saveUriForJwt('   ')).rejects.toThrow(/empty token/i);
    expect(transport.apiCalls()).toHaveLength(0);
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe('error mapping', () => {
  it('carries Google\'s status, code and structured reasons', async () => {
    // Swallowing the body turns every integration bug into the same opaque 400.
    // Google's structured body names the offending field, and that name is the
    // whole diagnosis.
    const transport = fakeGoogle({
      apiResponse: {
        status: 400,
        body: {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'Request contains an invalid argument.',
            errors: [{ message: 'Object ID contains invalid characters.', reason: 'invalid' }],
          },
        },
      },
    });

    const failure = await client(transport)
      .getObject(OBJECT_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GoogleWalletApiError);
    const apiError = failure as GoogleWalletApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('INVALID_ARGUMENT');
    expect(apiError.errors[0]!.message).toBe('Object ID contains invalid characters.');
  });

  it('still reports a non-JSON error body by status alone', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url === GOOGLE_TOKEN_URL
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
        : new Response('<html>502 Bad Gateway</html>', { status: 502 });

    const failure = await createGoogleWalletRestClient({
      serviceAccountEmail: SERVICE_ACCOUNT,
      privateKeyPem,
      fetchImpl,
    })
      .getClass(CLASS_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GoogleWalletApiError);
    expect((failure as GoogleWalletApiError).status).toBe(502);
  });

  it('reports a non-JSON success body as an unusable response', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url === GOOGLE_TOKEN_URL
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
        : new Response('not json', { status: 200 });

    await expect(
      createGoogleWalletRestClient({
        serviceAccountEmail: SERVICE_ACCOUNT,
        privateKeyPem,
        fetchImpl,
      }).getClass(CLASS_ID),
    ).rejects.toBeInstanceOf(GoogleWalletResponseError);
  });

  it('refuses a body-less insert, rather than reporting an unconfirmed class', async () => {
    // `insert` and `patch` promise a resource back. A `204` leaves the caller
    // unable to tell whether the class was created, and a stub that resolves
    // anyway is the exact failure `createUnimplementedGoogleWalletClient` exists
    // to prevent at the other end of this spectrum.
    const fetchImpl: FetchLike = async (url) =>
      url === GOOGLE_TOKEN_URL
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
        : new Response(null, { status: 204 });

    const google = createGoogleWalletRestClient({
      serviceAccountEmail: SERVICE_ACCOUNT,
      privateKeyPem,
      fetchImpl,
    });

    const expected = /answered success with no resource/;
    await expect(
      google.insertClass({
        id: CLASS_ID,
        issuerName: 'Lawen Tech Solutions',
        localizedIssuerName: {
          defaultValue: { language: 'es-CL', value: 'Café Central' },
        },
        programName: 'Puntos Café Central',
        reviewStatus: 'DRAFT',
        countryCode: 'CL',
      }),
    ).rejects.toThrow(expected);
    await expect(google.patchClass(CLASS_ID, { programName: 'x' })).rejects.toThrow(expected);
    await expect(
      google.insertObject({
        id: OBJECT_ID,
        classId: CLASS_ID,
        state: 'ACTIVE',
        accountId: 'K7M2QX',
        loyaltyPoints: { label: 'puntos', balance: { string: '1' } },
        barcode: { type: 'QR_CODE', value: 'x' },
      }),
    ).rejects.toThrow(expected);
    await expect(google.patchObject(OBJECT_ID, { state: 'INACTIVE' })).rejects.toThrow(expected);
  });
});

describe('input validation', () => {
  it('refuses an empty resource id on every operation that needs one', async () => {
    const transport = fakeGoogle();
    const google = client(transport);

    await expect(google.getClass('  ')).rejects.toThrow(/empty resource id/i);
    await expect(google.getObject('')).rejects.toThrow(/empty resource id/i);
    await expect(google.patchClass(' ', {})).rejects.toThrow(/empty resource id/i);
    await expect(google.insertObject({ id: '' } as never)).rejects.toThrow(/empty resource id/i);
  });

  it('percent-encodes an id rather than splicing it into the path', async () => {
    // A raw id with a slash would change the request's path structure.
    const transport = fakeGoogle();

    await client(transport).getClass(`${ISSUER}.member-a/b`);

    expect(transport.apiCalls()[0]!.url).toContain('member-a%2Fb');
  });
});

// ============================================================================
// Review status translation
// ============================================================================

describe('review status translation', () => {
  it('maps vyloop\'s storage form onto Google\'s enum', () => {
    expect(googleReviewStatusFor('draft')).toBe('DRAFT');
    expect(googleReviewStatusFor('under_review')).toBe('UNDER_REVIEW');
    expect(googleReviewStatusFor('approved')).toBe('APPROVED');
    expect(googleReviewStatusFor('rejected')).toBe('REJECTED');
  });

  it('maps `none` to nothing, because no class exists to have a review state', () => {
    // `none` means vyloop has no class yet. Reporting Google's `DRAFT` for a
    // class that does not exist would invent a review state and write it over
    // the row.
    expect(googleReviewStatusFor('none')).toBeNull();
    expect(googleReviewStatusFor('anything-else')).toBeNull();
  });

  it('maps Google\'s enum back to storage, and refuses an unknown value', () => {
    expect(storedReviewStatusFor('APPROVED')).toBe('approved');
    expect(storedReviewStatusFor('UNDER_REVIEW')).toBe('under_review');
    // The reverse mapping must not invent a state, because the sync route writes
    // its result over a known one.
    expect(storedReviewStatusFor('SOMETHING_NEW')).toBeNull();
    expect(storedReviewStatusFor(undefined)).toBeNull();
  });

  it('round-trips every state it can represent', () => {
    for (const stored of ['draft', 'under_review', 'approved', 'rejected'] as const) {
      expect(storedReviewStatusFor(googleReviewStatusFor(stored))).toBe(stored);
    }
  });
});

// ============================================================================
// Both implementations satisfy the same interface
// ============================================================================

describe('the two implementations', () => {
  it('lets the unimplemented client be substituted wherever the real one is', async () => {
    // The boundary that keeps the pass model testable offline. If the real
    // client grew a method the interface did not declare, this would not
    // compile.
    const google = createUnimplementedGoogleWalletClient();
    await expect(google.getClass(CLASS_ID)).rejects.toThrow(/not implemented/i);
  });

  it('never reaches the network from the unimplemented client', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const google = createUnimplementedGoogleWalletClient();

    await google.getClass(CLASS_ID).catch(() => {});
    await google.saveUriForJwt('a.b.c').catch(() => {});

    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
