import { importSPKI, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { BALANCE_DISPLAY_MAX } from './balance';
import { buildLoyaltyClass, reviewStatusBlocksObjects } from './class';
import { GOOGLE_QUALIFIED_ID_PATTERN } from './ids';
import { SAVE_TO_WALLET_URL_PREFIX, createSaveToWalletUrl } from './jwt';
import { findAvailableMemberCode, generateMemberCode } from './member-code';
import { buildLoyaltyObject, objectStateFor } from './object';

/**
 * End-to-end over the pure model: tenant onboarding creates a class, a member
 * enrolment issues an object, and a save token carries both. No network, no
 * credentials, no database — which is the whole point of T7 putting the client
 * behind an interface.
 */

const PEPPER = crypto.randomUUID();

const ISSUER = '338800013922057609515';
const TENANT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_TENANT_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CUSTOMER_ID = 'b3f1c0d2-5e6a-4a7b-9c8d-1e2f3a4b5c6d';
const CUSTOMER_GLOBAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ORIGIN = 'https://app.vyloop.app';

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

function toPem(der: ArrayBuffer, label: string): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

describe('tenant onboarding to save-to-wallet', () => {
  it('produces a coherent class, object and save token', async () => {
    // 1. Onboarding: the class is created here, not on a first redemption, so
    //    Google's per-class review overlaps merchant setup.
    const loyaltyClass = buildLoyaltyClass({
      issuerId: ISSUER,
      tenantId: TENANT_ID,
      issuerName: 'Café Origen',
      programName: 'Puntos Café Origen',
      countryCode: 'CL',
      reviewStatus: 'DRAFT',
    });

    expect(loyaltyClass.id).toBe(`${ISSUER}.tenant-${TENANT_ID}`);
    expect(reviewStatusBlocksObjects(loyaltyClass.reviewStatus)).toBe(true);

    // 2. Enrolment: a code is derived, checked for collision and stored.
    const memberCode = await findAvailableMemberCode({
      tenantId: TENANT_ID,
      customerGlobalId: CUSTOMER_GLOBAL_ID,
      pepper: PEPPER,
      isTaken: () => false,
    });
    expect(memberCode).toHaveLength(6);

    // 3. The pass object, built against the stored code and the ledger balance.
    const loyaltyObject = buildLoyaltyObject({
      issuerId: ISSUER,
      classId: loyaltyClass.id,
      customerId: CUSTOMER_ID,
      customerGlobalId: CUSTOMER_GLOBAL_ID,
      customerFullName: 'María Fernández',
      memberCode,
      balancePoints: 96942,
      pointsCurrency: 'puntos',
      tierName: 'Oro',
      tierHeader: 'Nivel',
      passState: 'issued',
    });

    expect(loyaltyObject.classId).toBe(loyaltyClass.id);
    expect(loyaltyObject.state).toBe('ACTIVE');
    expect(loyaltyObject.accountId).toBe(memberCode);
    expect(loyaltyObject.barcode.value).toBe(CUSTOMER_GLOBAL_ID);
    expect(loyaltyObject.loyaltyPoints.balance.string).toBe('96942');

    // 4. A rebrand is one class patch. The object is untouched, and the class id
    //    has not moved because it is derived from the UUID, not the slug.
    const rebranded = buildLoyaltyClass({
      issuerId: ISSUER,
      tenantId: TENANT_ID,
      issuerName: 'Café Origen Esquina',
      programName: 'Puntos Esquina',
      countryCode: 'CL',
      reviewStatus: 'APPROVED',
    });
    expect(rebranded.id).toBe(loyaltyClass.id);
    expect(rebranded.reviewStatus).toBe('APPROVED');
    expect(reviewStatusBlocksObjects(rebranded.reviewStatus)).toBe(false);
    expect(loyaltyObject.classId).toBe(rebranded.id);

    // 5. The save token carries both, signed with the service account key.
    const url = await createSaveToWalletUrl({
      serviceAccountEmail: 'wallet@vyloop-demo.iam.gserviceaccount.com',
      privateKeyPem,
      origins: [ORIGIN],
      loyaltyClasses: [rebranded],
      loyaltyObjects: [loyaltyObject],
      now: new Date('2026-09-28T12:00:00.000Z'),
    });

    expect(url.startsWith(SAVE_TO_WALLET_URL_PREFIX)).toBe(true);

    const token = url.slice(SAVE_TO_WALLET_URL_PREFIX.length);
    const { payload } = await jwtVerify(token, await importSPKI(publicKeyPem, 'RS256'));
    const signed = payload.payload as {
      loyaltyClasses: typeof rebranded[];
      loyaltyObjects: typeof loyaltyObject[];
    };

    expect(signed.loyaltyClasses[0]).toEqual(rebranded);
    expect(signed.loyaltyObjects[0]).toEqual(loyaltyObject);
    expect(payload.iss).toBe('wallet@vyloop-demo.iam.gserviceaccount.com');
    expect(payload.aud).toBe('google');
    expect(payload.typ).toBe('savetowallet');
    expect(payload.origins).toEqual([ORIGIN]);
    expect(payload.iat).toBe(1790596800);
  });

  it('gives one person two different codes across two merchants', async () => {
    // Non-correlationality end to end: the same globalId at two tenants yields
    // two codes, so the two merchants cannot link the customer.
    const atFirst = await generateMemberCode({
      tenantId: TENANT_ID,
      customerGlobalId: CUSTOMER_GLOBAL_ID,
      pepper: PEPPER,
    });
    const atSecond = await generateMemberCode({
      tenantId: OTHER_TENANT_ID,
      customerGlobalId: CUSTOMER_GLOBAL_ID,
      pepper: PEPPER,
    });

    expect(atFirst).not.toBe(atSecond);

    const firstObject = buildLoyaltyObject({
      issuerId: ISSUER,
      classId: `${ISSUER}.tenant-${TENANT_ID}`,
      customerId: CUSTOMER_ID,
      customerGlobalId: CUSTOMER_GLOBAL_ID,
      memberCode: atFirst,
      balancePoints: 0,
      pointsCurrency: 'puntos',
      passState: 'issued',
    });
    const secondObject = buildLoyaltyObject({
      issuerId: ISSUER,
      classId: `${ISSUER}.tenant-${OTHER_TENANT_ID}`,
      customerId: CUSTOMER_ID,
      customerGlobalId: CUSTOMER_GLOBAL_ID,
      memberCode: atSecond,
      balancePoints: 0,
      pointsCurrency: 'puntos',
      passState: 'issued',
    });

    // The barcodes match, because the POS only ever resolves by globalId. The
    // accountIds do not, and that is the privacy property.
    expect(firstObject.barcode.value).toBe(secondObject.barcode.value);
    expect(firstObject.accountId).not.toBe(secondObject.accountId);
    expect(firstObject.classId).not.toBe(secondObject.classId);
  });

  it('holds end to end for every Google-valid value it produces', async () => {
    const loyaltyClass = buildLoyaltyClass({
      issuerId: ISSUER,
      tenantId: TENANT_ID,
      issuerName: 'Café Origen',
      programName: 'Puntos Café Origen',
      countryCode: 'CL',
      reviewStatus: 'APPROVED',
    });
    const loyaltyObject = buildLoyaltyObject({
      issuerId: ISSUER,
      classId: loyaltyClass.id,
      customerId: CUSTOMER_ID,
      customerGlobalId: CUSTOMER_GLOBAL_ID,
      memberCode: await generateMemberCode({
        tenantId: TENANT_ID,
        customerGlobalId: CUSTOMER_GLOBAL_ID,
        pepper: PEPPER,
      }),
      balancePoints: BALANCE_DISPLAY_MAX,
      pointsCurrency: 'puntos',
      passState: 'issued',
    });

    expect(GOOGLE_QUALIFIED_ID_PATTERN.test(loyaltyClass.id)).toBe(true);
    expect(GOOGLE_QUALIFIED_ID_PATTERN.test(loyaltyObject.id)).toBe(true);
    expect(loyaltyObject.loyaltyPoints.balance.string).toHaveLength(7);
    expect(objectStateFor('issued', CUSTOMER_ID)).toBe(loyaltyObject.state);
  });
});
