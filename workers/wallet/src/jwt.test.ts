import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import type { LoyaltyClass } from './class';
import {
  SAVE_TO_WALLET_AUDIENCE,
  SAVE_TO_WALLET_TYPE,
  SAVE_TO_WALLET_URL_PREFIX,
  SaveToWalletJwtError,
  createSaveToWalletUrl,
} from './jwt';
import type { LoyaltyObject } from './object';


/**
 * An RSA key pair generated at test time and discarded with the test run.
 *
 * This is deliberately not a fixture. Nothing in this repository, in
 * `.dev.vars`, in a test file or in a commit may contain a Google service
 * account key, and generating the key here means a real credential has no path
 * into the suite even by accident.
 */
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

  privateKeyPem = await exportPkcs8(pair.privateKey);
  publicKeyPem = await exportSpki(pair.publicKey);
});

function toPem(der: ArrayBuffer, label: string): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

async function exportPkcs8(key: CryptoKey): Promise<string> {
  return toPem(await crypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY');
}

async function exportSpki(key: CryptoKey): Promise<string> {
  return toPem(await crypto.subtle.exportKey('spki', key), 'PUBLIC KEY');
}

const SERVICE_ACCOUNT_EMAIL = 'wallet-test@vyloop-demo.iam.gserviceaccount.com';
const ISSUER = '338800013922057609515';
const TENANT_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const CUSTOMER_GLOBAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ORIGIN = 'https://app.vyloop.app';

const loyaltyClass: LoyaltyClass = {
  id: `${ISSUER}.tenant-${TENANT_UUID}`,
  issuerName: 'Café Origen',
  programName: 'Puntos Café Origen',
  reviewStatus: 'APPROVED',
  countryCode: 'CL',
};

const loyaltyObject: LoyaltyObject = {
  id: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
  classId: `${ISSUER}.tenant-${TENANT_UUID}`,
  state: 'ACTIVE',
  accountName: 'María Fernández',
  accountId: 'H4KM7Q',
  loyaltyPoints: { label: 'puntos', balance: { string: '96942' } },
  barcode: { type: 'QR_CODE', value: CUSTOMER_GLOBAL_ID },
};

const FIXED_NOW = new Date('2026-09-28T12:00:00.000Z');

async function sign(
  overrides: Partial<Parameters<typeof createSaveToWalletUrl>[0]> = {},
): Promise<{ url: string; token: string; claims: Record<string, unknown> }> {
  const url = await createSaveToWalletUrl({
    serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
    privateKeyPem,
    origins: [ORIGIN],
    loyaltyClasses: [loyaltyClass],
    loyaltyObjects: [loyaltyObject],
    now: FIXED_NOW,
    ...overrides,
  });
  const token = url.slice(SAVE_TO_WALLET_URL_PREFIX.length);
  const { payload } = await jwtVerify(token, await importSPKI(publicKeyPem, 'RS256'));
  return { url, token, claims: payload as Record<string, unknown> };
}

describe('createSaveToWalletUrl', () => {
  it('returns a Google save URL wrapping the signed token', async () => {
    const { url } = await sign();
    expect(url.startsWith(SAVE_TO_WALLET_URL_PREFIX)).toBe(true);
    expect(url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('signs with RS256, verified against the generated public key', async () => {
    // Not HS256: the identity worker's shared-secret scheme is a different
    // mechanism and Google rejects it. A symmetric token would not verify here,
    // which is the point of checking against an asymmetric public key.
    const { token } = await sign();
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('RS256');

    const publicKey = await importSPKI(publicKeyPem, 'RS256');
    await expect(jwtVerify(token, publicKey)).resolves.toBeDefined();
  });

  it('does not verify against a different key pair', async () => {
    const { token } = await sign();
    const otherPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const otherPublicKey = await importSPKI(await exportSpki(otherPair.publicKey), 'RS256');
    await expect(jwtVerify(token, otherPublicKey)).rejects.toThrow();
  });

  it('carries the kid only when the key id is supplied', async () => {
    const { token: withoutKid } = await sign();
    expect(decodeProtectedHeader(withoutKid).kid).toBeUndefined();

    const { token: withKid } = await sign({ privateKeyId: 'a1b2c3d4e5f6' });
    expect(decodeProtectedHeader(withKid).kid).toBe('a1b2c3d4e5f6');
  });

  it('sets iss to the service account email', async () => {
    const { claims } = await sign();
    expect(claims.iss).toBe(SERVICE_ACCOUNT_EMAIL);
  });

  it("sets aud to Google's fixed value", async () => {
    const { claims } = await sign();
    expect(claims.aud).toBe(SAVE_TO_WALLET_AUDIENCE);
    expect(claims.aud).toBe('google');
  });

  it("sets typ to Google's fixed value", async () => {
    const { claims } = await sign();
    expect(claims.typ).toBe(SAVE_TO_WALLET_TYPE);
    expect(claims.typ).toBe('savetowallet');
  });

  it('sets iat, which Google requires', async () => {
    // Routinely missed, and the token is rejected without it.
    const { claims } = await sign();
    expect(claims.iat).toBe(Math.floor(FIXED_NOW.getTime() / 1000));
    expect(typeof claims.iat).toBe('number');
  });

  it('sets no exp, because Google does not define one', async () => {
    // Adding an expiry would only narrow the window in which a member can tap
    // "Add to Wallet".
    const { claims } = await sign();
    expect(claims.exp).toBeUndefined();
  });

  it('sets origins, without which the button does not render', async () => {
    const { claims } = await sign({ origins: [ORIGIN, 'https://vyloop.app'] });
    expect(claims.origins).toEqual([ORIGIN, 'https://vyloop.app']);
  });

  it('rejects an empty origins list', async () => {
    // An empty list is the shape that produces a button which silently fails in
    // the browser, so it fails here instead.
    await expect(sign({ origins: [] })).rejects.toThrow(SaveToWalletJwtError);
    await expect(sign({ origins: [] })).rejects.toThrow(/origins/);
  });

  it('carries the class and the object in the loyalty payload', async () => {
    const { claims } = await sign();
    const payload = claims.payload as {
      loyaltyClasses: LoyaltyClass[];
      loyaltyObjects: LoyaltyObject[];
    };
    expect(payload.loyaltyClasses).toHaveLength(1);
    expect(payload.loyaltyObjects).toHaveLength(1);
    expect(payload.loyaltyClasses[0]?.id).toBe(loyaltyClass.id);
    expect(payload.loyaltyObjects[0]?.id).toBe(loyaltyObject.id);
  });

  it('carries no other pass-type arrays', async () => {
    // Google validates the payload shape; an unexpected key is a 400.
    const { claims } = await sign();
    expect(Object.keys(claims.payload as object)).toEqual(['loyaltyClasses', 'loyaltyObjects']);
  });

  it('preserves the object payload exactly, including the barcode globalId', async () => {
    const { claims } = await sign();
    const payload = claims.payload as { loyaltyObjects: LoyaltyObject[] };
    expect(payload.loyaltyObjects[0]).toEqual(loyaltyObject);
    expect(payload.loyaltyObjects[0]?.barcode.value).toBe(CUSTOMER_GLOBAL_ID);
    expect(payload.loyaltyObjects[0]?.accountId).toBe('H4KM7Q');
    expect(payload.loyaltyObjects[0]?.loyaltyPoints.balance.string).toBe('96942');
  });

  it('preserves the class payload exactly', async () => {
    const { claims } = await sign();
    const payload = claims.payload as { loyaltyClasses: LoyaltyClass[] };
    expect(payload.loyaltyClasses[0]).toEqual(loyaltyClass);
  });

  it('omits an array entirely rather than sending it empty', async () => {
    // An absent array means "no classes in this token". A present-but-empty
    // array is an instruction to do nothing with an empty set, which is a
    // different thing to say. The create-objects-only flow must not send an
    // empty class list.
    const { claims } = await sign({ loyaltyClasses: undefined });
    const payload = claims.payload as { loyaltyClasses?: unknown; loyaltyObjects: unknown[] };
    expect(payload).not.toHaveProperty('loyaltyClasses');
    expect(payload.loyaltyObjects).toHaveLength(1);
  });

  it('can sign a class-only token', async () => {
    const { claims } = await sign({ loyaltyObjects: undefined });
    const payload = claims.payload as { loyaltyClasses: unknown[]; loyaltyObjects?: unknown };
    expect(payload.loyaltyClasses).toHaveLength(1);
    expect(payload).not.toHaveProperty('loyaltyObjects');
  });

  it('rejects a token that would create nothing', async () => {
    // A button that adds nothing is the exact failure T9 exists to avoid.
    await expect(sign({ loyaltyClasses: [], loyaltyObjects: [] })).rejects.toThrow(
      SaveToWalletJwtError,
    );
  });

  it('rejects an empty service account email', async () => {
    await expect(sign({ serviceAccountEmail: '' })).rejects.toThrow(/iss/);
    await expect(sign({ serviceAccountEmail: '   ' })).rejects.toThrow(
      SaveToWalletJwtError,
    );
  });

  it('rejects an empty private key, and says where it should come from', async () => {
    await expect(sign({ privateKeyPem: '' })).rejects.toThrow(/secret/i);
  });

  it('rejects a malformed private key', async () => {
    await expect(
      sign({ privateKeyPem: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }),
    ).rejects.toThrow();
  });

  it('produces a distinct token per payload, and both verify', async () => {
    const withObjects = await sign();
    const classOnly = await sign({ loyaltyObjects: undefined });
    expect(withObjects.token).not.toBe(classOnly.token);

    const publicKey = await importSPKI(publicKeyPem, 'RS256');
    await expect(jwtVerify(withObjects.token, publicKey)).resolves.toBeDefined();
    await expect(jwtVerify(classOnly.token, publicKey)).resolves.toBeDefined();
  });

  it('never lets a caller mutate the arrays it passed in', async () => {
    const classes = [loyaltyClass];
    const { claims } = await sign({ loyaltyClasses: classes });
    classes.length = 0;
    const payload = claims.payload as { loyaltyClasses: LoyaltyClass[] };
    expect(payload.loyaltyClasses).toHaveLength(1);
  });
});
