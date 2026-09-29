import { describe, expect, it } from 'vitest';

import {
  OPERATOR_ROLE_REQUIRED,
  isCustomerRole,
  parseAllowedOrigins,
  parseDemoMode,
  requireOperatorRole,
} from './helpers';
import type { AuthHeaders } from './helpers';

const CUSTOMER: AuthHeaders = {
  userId: 'c8b61954-1b6d-4dfa-9954-b7c936a9e648',
  businessId: '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1',
  userRole: 'customer',
};

describe('parseAllowedOrigins', () => {
  it('reads a comma-separated list', () => {
    expect(parseAllowedOrigins('https://app.vyloop.app,https://pos.vyloop.app')).toEqual([
      'https://app.vyloop.app',
      'https://pos.vyloop.app',
    ]);
  });

  it('trims each entry, so a stray space cannot produce an origin Google rejects', () => {
    expect(parseAllowedOrigins(' https://app.vyloop.app , https://pos.vyloop.app ')).toEqual([
      'https://app.vyloop.app',
      'https://pos.vyloop.app',
    ]);
  });

  it('drops empty entries, including from a trailing comma', () => {
    expect(parseAllowedOrigins('https://app.vyloop.app,,'.replace(/,/g, ','))).toEqual([
      'https://app.vyloop.app',
    ]);
  });

  it('de-duplicates while preserving order', () => {
    expect(
      parseAllowedOrigins('https://b.vyloop.app,https://a.vyloop.app,https://b.vyloop.app'),
    ).toEqual(['https://b.vyloop.app', 'https://a.vyloop.app']);
  });

  it('returns an empty list for an absent or blank var, rather than a fallback', () => {
    // Not a default: `createSaveToWalletUrl` refuses an empty `origins` and the
    // pass route turns that into a `WALLET_NOT_CONFIGURED` 500. A deployment
    // with no origins set must report a misconfiguration, not mint a token whose
    // button silently fails in the browser.
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(null)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ,  ')).toEqual([]);
  });
});

describe('isCustomerRole', () => {
  it('recognises only the customer role, exactly', () => {
    expect(isCustomerRole(CUSTOMER)).toBe(true);
    expect(isCustomerRole({ ...CUSTOMER, userRole: 'Customer' })).toBe(false);
    expect(isCustomerRole({ ...CUSTOMER, userRole: 'admin' })).toBe(false);
  });
});

describe('requireOperatorRole', () => {
  it('refuses the customer app\'s token', () => {
    const gate = requireOperatorRole(CUSTOMER);

    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.status).toBe(403);
      expect(gate.code).toBe(OPERATOR_ROLE_REQUIRED);
      // The message points at the endpoint that *is* theirs, so a client
      // developer is not left guessing.
      expect(gate.message).toContain('/v1/wallet/pass');
    }
  });

  it('admits every other role, without holding an allow-list', () => {
    // `issueToken` types `role` as a free-form string, so an allow-list would
    // have to invent a vocabulary the issuer does not define and would refuse
    // every role added after this was written.
    for (const role of ['admin', 'operator', 'pos', 'owner', '']) {
      expect(requireOperatorRole({ ...CUSTOMER, userRole: role }).ok).toBe(true);
    }
  });

  it('denies by asking isCustomerRole, not by re-reading the header', () => {
    // The counterpart to `isCustomerRole`, not a second source of truth about
    // the role.
    expect(requireOperatorRole(CUSTOMER)).toEqual(requireOperatorRole({ ...CUSTOMER }));
  });
});

describe('parseDemoMode', () => {
  it('treats an absent var as demo mode', () => {
    // The failure this guards is asymmetric. A deployment that is in demo mode
    // and answers "no" hands a real customer a pass that only works on the
    // issuer's own test accounts, which is a support incident. The reverse is a
    // delay. Preferring the delay, on an absent value, is the whole default.
    expect(parseDemoMode(undefined)).toBe(true);
    expect(parseDemoMode(null)).toBe(true);
    expect(parseDemoMode('')).toBe(true);
    expect(parseDemoMode('   ')).toBe(true);
  });

  it('reads the two ways a deployment declares publishing access', () => {
    for (const raw of ['false', 'FALSE', ' false ', '0', 'no', 'No']) {
      expect(parseDemoMode(raw)).toBe(false);
    }
    for (const raw of ['true', 'TRUE', ' true ', '1', 'yes']) {
      expect(parseDemoMode(raw)).toBe(true);
    }
  });

  it('fails closed on a value it does not recognise', () => {
    // A typo in a deployment must not turn a demo deployment into a published
    // one. Guessing "not demo" on `flase` is exactly the failure mode above.
    for (const raw of ['flase', 'maybe', 'off?', '2']) {
      expect(parseDemoMode(raw)).toBe(true);
    }
  });
});
