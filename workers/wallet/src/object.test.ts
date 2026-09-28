import { describe, expect, it } from 'vitest';

import { isValidGoogleId } from './ids';
import {
  PassNotIssuedError,
  REWARDS_TIER_MODULE_ID,
  buildLoyaltyObject,
  objectStateFor,
} from './object';

const ISSUER = '338800013922057609515';
const TENANT_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const CLASS_ID = `${ISSUER}.tenant-${TENANT_UUID}`;
const CUSTOMER_GLOBAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CUSTOMER_ID = 'b3f1c0d2-5e6a-4a7b-9c8d-1e2f3a4b5c6d';
const MEMBER_CODE = 'H4KM7Q';

const baseInput = {
  issuerId: ISSUER,
  classId: CLASS_ID,
  customerId: CUSTOMER_ID,
  customerGlobalId: CUSTOMER_GLOBAL_ID,
  customerFullName: 'María Fernández',
  memberCode: MEMBER_CODE,
  balancePoints: 96942,
  pointsCurrency: 'puntos',
  tierName: 'Oro',
  tierHeader: 'Nivel',
  passState: 'issued' as const,
};

describe('buildLoyaltyObject', () => {
  it('carries only the documented fields when given nothing optional', () => {
    const loyaltyObject = buildLoyaltyObject({
      ...baseInput,
      customerFullName: null,
      tierName: null,
    });
    expect(loyaltyObject).toEqual({
      id: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
      classId: CLASS_ID,
      state: 'ACTIVE',
      accountId: MEMBER_CODE,
      loyaltyPoints: { label: 'puntos', balance: { string: '96942' } },
      barcode: { type: 'QR_CODE', value: CUSTOMER_GLOBAL_ID },
    });
  });

  it('produces a Google-valid object id', () => {
    expect(isValidGoogleId(buildLoyaltyObject(baseInput).id)).toBe(true);
  });

  it('references the tenant class', () => {
    expect(buildLoyaltyObject(baseInput).classId).toBe(CLASS_ID);
  });

  it('carries the short member code as accountId', () => {
    // Google's recommended maximum for accountId is 20 characters and
    // `globalId` is 36. The code is what fits and what a person reads aloud.
    const loyaltyObject = buildLoyaltyObject(baseInput);
    expect(loyaltyObject.accountId).toBe(MEMBER_CODE);
    expect(loyaltyObject.accountId).toBe(loyaltyObject.accountId.toUpperCase());
    expect(loyaltyObject.accountId).toHaveLength(6);
    expect(loyaltyObject.accountId).not.toContain('I');
    expect(loyaltyObject.accountId).not.toContain('L');
    expect(loyaltyObject.accountId).not.toContain('O');
    expect(loyaltyObject.accountId).not.toContain('U');
  });

  it('carries the full globalId in the barcode, not the member code', () => {
    // The POS resolves customers only by globalId
    // (`GET /v1/customers/n/:globalId`). Putting the short code in the barcode
    // would have forced a POS contract change for no gain; this way the barcode
    // contract is untouched.
    const loyaltyObject = buildLoyaltyObject(baseInput);
    expect(loyaltyObject.barcode).toEqual({ type: 'QR_CODE', value: CUSTOMER_GLOBAL_ID });
    expect(loyaltyObject.barcode.value).toBe(CUSTOMER_GLOBAL_ID);
    expect(loyaltyObject.barcode.value).toHaveLength(36);
    expect(loyaltyObject.barcode.value).not.toBe(loyaltyObject.accountId);
  });

  it('uses QR_CODE, the only format that holds a 36-character payload at a counter', () => {
    // The narrow symbologies (CODE_128, EAN_13, ...) cannot carry a UUID at a
    // scannable width.
    expect(buildLoyaltyObject(baseInput).barcode.type).toBe('QR_CODE');
  });

  it('renders the balance as a separator-free string', () => {
    expect(buildLoyaltyObject(baseInput).loyaltyPoints).toEqual({
      label: 'puntos',
      balance: { string: '96942' },
    });
    const balance = buildLoyaltyObject({ ...baseInput, balancePoints: 1234567 }).loyaltyPoints
      .balance.string;
    expect(balance).toBe('1234567');
    expect(balance).not.toMatch(/[.,]/);
  });

  it('renders zero rather than omitting the balance', () => {
    // A brand new member holds zero. Omitting the field would make Google
    // reject the object, since `balance` is required inside `loyaltyPoints`.
    expect(buildLoyaltyObject({ ...baseInput, balancePoints: 0 }).loyaltyPoints.balance.string).toBe(
      '0',
    );
  });

  it('rejects a balance past the documented ceiling rather than truncating', () => {
    expect(() => buildLoyaltyObject({ ...baseInput, balancePoints: 10_000_000 })).toThrow(
      /9999999/,
    );
  });

  it('includes the account name when the customer has one', () => {
    expect(buildLoyaltyObject(baseInput).accountName).toBe('María Fernández');
  });

  it('omits the account name when the customer has none, without substituting', () => {
    // No "Member", no empty string. A blank row is worse than an absent one.
    expect(buildLoyaltyObject({ ...baseInput, customerFullName: null })).not.toHaveProperty(
      'accountName',
    );
    expect(buildLoyaltyObject({ ...baseInput, customerFullName: undefined })).not.toHaveProperty(
      'accountName',
    );
  });

  it('carries the tier in a text module with a stable id', () => {
    const loyaltyObject = buildLoyaltyObject(baseInput);
    expect(loyaltyObject.textModulesData).toEqual([
      { header: 'Nivel', body: 'Oro', id: REWARDS_TIER_MODULE_ID },
    ]);
  });

  it('omits the tier module when the customer has no tier', () => {
    expect(buildLoyaltyObject({ ...baseInput, tierName: null })).not.toHaveProperty(
      'textModulesData',
    );
    expect(buildLoyaltyObject({ ...baseInput, tierName: '' })).not.toHaveProperty('textModulesData');
  });

  it('refuses to invent a tier header', () => {
    // A hardcoded header would put English chrome on a Spanish-language pass.
    expect(() => buildLoyaltyObject({ ...baseInput, tierHeader: undefined })).toThrow(
      /tierHeader/,
    );
    expect(() => buildLoyaltyObject({ ...baseInput, tierHeader: '  ' })).toThrow(/tierHeader/);
  });

  it('rejects a missing or malformed member code', () => {
    // A pass with a blank accountId looks perfectly valid in the wallet and is
    // useless at the counter, so this fails rather than degrading.
    for (const memberCode of ['', 'abc', 'ABC', 'ABC123I', 'ABCDEFG', null, undefined]) {
      expect(() => buildLoyaltyObject({ ...baseInput, memberCode: memberCode as string })).toThrow(
        /member_code/,
      );
    }
  });

  it('refuses to build a pass that has not been issued', () => {
    // `not_issued` means no Google object exists. Building one anyway would
    // assert a pass the customer does not have.
    expect(() => buildLoyaltyObject({ ...baseInput, passState: 'not_issued' })).toThrow(
      PassNotIssuedError,
    );
  });

  it('never emits the deprecated camelCase state spellings', () => {
    for (const passState of ['issued', 'inactive', 'expired', 'completed'] as const) {
      const state = buildLoyaltyObject({ ...baseInput, passState }).state;
      expect(state).toMatch(/^[A-Z_]+$/);
      expect(state).not.toBe('active');
      expect(state).not.toBe('inactive');
      expect(state).not.toBe('expired');
      expect(state).not.toBe('completed');
    }
  });

  it('does not compute the balance: it reflects the one it is given', () => {
    // The backend owns the balance and there is one source of truth. A builder
    // that derived a balance from a tier table would be a second ledger.
    expect(buildLoyaltyObject({ ...baseInput, balancePoints: 7 }).loyaltyPoints.balance.string).toBe(
      '7',
    );
    expect(buildLoyaltyObject({ ...baseInput, balancePoints: 7 }).loyaltyPoints.balance.string).not
      .toBe('1000');
  });
});

describe('objectStateFor', () => {
  it('maps every issued tracking state onto a current Google state', () => {
    expect(objectStateFor('issued', CUSTOMER_ID)).toBe('ACTIVE');
    expect(objectStateFor('inactive', CUSTOMER_ID)).toBe('INACTIVE');
    expect(objectStateFor('expired', CUSTOMER_ID)).toBe('EXPIRED');
    expect(objectStateFor('completed', CUSTOMER_ID)).toBe('COMPLETED');
  });

  it('refuses to map `not_issued`, which has no Google counterpart', () => {
    // `PENDING` means the platform holds an object the user has not activated.
    // That is a different claim from "vyloop has not issued this pass yet", so
    // it is never produced.
    expect(() => objectStateFor('not_issued', CUSTOMER_ID)).toThrow(PassNotIssuedError);
    expect(objectStateFor('issued', CUSTOMER_ID)).not.toBe('PENDING');
  });

  it('names the customer in the error, so the row can be found', () => {
    expect(() => objectStateFor('not_issued', CUSTOMER_ID)).toThrow(
      new RegExp(CUSTOMER_ID),
    );
  });
});
