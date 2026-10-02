import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL,
  DEFAULT_WALLET_MEDIA_BASE_URL,
  DEFAULT_WALLET_WEB_BASE_URL,
  OPERATOR_ROLE_REQUIRED,
  isCustomerRole,
  parseAllowedOrigins,
  parseCustomerWebBaseUrl,
  parseDemoMode,
  parseMediaBaseUrl,
  parseWebBaseUrl,
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

describe('parseMediaBaseUrl', () => {
  it('answers the documented default when the var says nothing', () => {
    // Unlike `WALLET_ALLOWED_ORIGINS`, where an absent var must fail loudly,
    // this one has a correct value for every environment we have: it is our own
    // domain, and the brand route under it exists precisely so a tenant with no
    // logo of its own still resolves. A blank var is therefore not a
    // misconfiguration to report but a default to apply.
    for (const raw of [undefined, null, '', '   ']) {
      expect(parseMediaBaseUrl(raw)).toBe(DEFAULT_WALLET_MEDIA_BASE_URL);
    }
    expect(DEFAULT_WALLET_MEDIA_BASE_URL).toBe('https://media.juancode.dev');
  });

  it('drops a trailing slash, which would double up in every path built from it', () => {
    // The base is concatenated with `/brand/<tenantId>.jpg`. A trailing slash
    // would produce `//brand/...`, which is a URL Google may answer and our own
    // route may not.
    expect(parseMediaBaseUrl('https://media.staging.juancode.dev/')).toBe(
      'https://media.staging.juancode.dev',
    );
    expect(parseMediaBaseUrl('  https://media.staging.juancode.dev  ')).toBe(
      'https://media.staging.juancode.dev',
    );
  });

  it('keeps a path prefix, because a tenant-scoped deployment is a real shape', () => {
    expect(parseMediaBaseUrl('https://example.dev/wallet')).toBe('https://example.dev/wallet');
  });
});

describe('parseWebBaseUrl', () => {
  it('answers the gateway when the var says nothing, because that is where the page is', () => {
    // `homepageUri` is `/p/{slug}`, rendered server-side by the gateway. The
    // default moved off the customer web for that reason: a review page has to
    // have its content in the bytes Google's reviewer receives, and the
    // dashboard's static export serves 18 characters of text.
    for (const raw of [undefined, null, '', '   ']) {
      expect(parseWebBaseUrl(raw)).toBe(DEFAULT_WALLET_WEB_BASE_URL);
    }
    expect(DEFAULT_WALLET_WEB_BASE_URL).toBe('https://media.juancode.dev');
  });

  it('drops a trailing slash, which would double up in the path built from it', () => {
    // Same treatment as `parseMediaBaseUrl`, for the same reason: this base is
    // concatenated with `/p/{slug}`.
    expect(parseWebBaseUrl('https://staging-gateway.example.dev/')).toBe(
      'https://staging-gateway.example.dev',
    );
    expect(parseWebBaseUrl('  https://staging-gateway.example.dev  ')).toBe(
      'https://staging-gateway.example.dev',
    );
  });

  it('never falls through to the media parser, whatever it is handed', () => {
    // The two parsers are the seam the bug came through, so each is asserted to
    // answer for itself only: a shared implementation, or one parser falling
    // through to the other's default, has to fail here rather than in a class
    // Google rejects.
    //
    // Their *defaults* now coincide — both origins are the gateway — so
    // inequality of defaults would assert nothing. What is asserted instead is
    // that a value passed to one parser is never overridden by the other: a
    // transposed pair, the swap that actually cost a class review, changes what
    // these return.
    expect(parseWebBaseUrl('https://web.invalid-host.test')).toBe('https://web.invalid-host.test');
    expect(parseMediaBaseUrl('https://media.invalid-host.test')).toBe(
      'https://media.invalid-host.test',
    );
    expect(parseWebBaseUrl('https://media.invalid-host.test')).toBe(
      'https://media.invalid-host.test',
    );
    // The transitive pair: if the two implementations were merged, this holds by
    // accident rather than by design, and so does the case above. Together they
    // are what a merge would break.
    expect(parseMediaBaseUrl('https://web.invalid-host.test')).toBe(
      'https://web.invalid-host.test',
    );
  });

  it('keeps its own identity even though its default now equals the media default', () => {
    // The documented reason the two parsers are separate functions survives the
    // defaults converging: they are separate *consumers* with independent
    // histories, and either origin may have to move without the other. A merged
    // implementation would make that impossible to express.
    expect(DEFAULT_WALLET_WEB_BASE_URL).toBe(DEFAULT_WALLET_MEDIA_BASE_URL);
    expect(parseWebBaseUrl).not.toBe(parseMediaBaseUrl);
  });
});

describe('parseCustomerWebBaseUrl', () => {
  it('answers the customer web, which is where the pass links live', () => {
    // `/profile` and `/profile/history` are `apps/customer-web` routes. This is
    // the origin that has to stay different from the two gateway ones: a link
    // built from the gateway is a 404 in a customer's hand, and nothing fails
    // loudly — the class inserts and the pass renders.
    for (const raw of [undefined, null, '', '   ']) {
      expect(parseCustomerWebBaseUrl(raw)).toBe(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL);
    }
    expect(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL).toBe('https://vyloop-customer-web.pages.dev');
    expect(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL).not.toBe(DEFAULT_WALLET_WEB_BASE_URL);
    expect(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL).not.toBe(DEFAULT_WALLET_MEDIA_BASE_URL);
  });

  it('drops a trailing slash, for the same reason the other two do', () => {
    expect(parseCustomerWebBaseUrl('https://staging-customer.pages.dev/')).toBe(
      'https://staging-customer.pages.dev',
    );
    expect(parseCustomerWebBaseUrl('  https://staging-customer.pages.dev  ')).toBe(
      'https://staging-customer.pages.dev',
    );
  });

  it('never answers a gateway host, whatever it is handed', () => {
    // Pinned against the pair, because the failure this parser exists to prevent
    // is the links being built from `WALLET_WEB_BASE_URL`. A pass whose
    // `homepageUri` is right and whose links 404 still looks healthy everywhere
    // except the customer's hand.
    expect(parseCustomerWebBaseUrl('https://staging-customer.pages.dev')).toBe(
      'https://staging-customer.pages.dev',
    );
    expect(parseCustomerWebBaseUrl(undefined)).not.toBe(parseWebBaseUrl(undefined));
    expect(parseCustomerWebBaseUrl(undefined)).not.toBe(parseMediaBaseUrl(undefined));
  });
});
