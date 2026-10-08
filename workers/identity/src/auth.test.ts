/**
 * Two claims on the issuer's side: the tenant's `plan`, and the subject
 * namespace a counter lives in.
 *
 * ## Why `plan` is a parameter and not something `issueToken` looks up
 *
 * `issueToken` is a pure signing function: it takes the claims it is given and
 * it has no database. Reading `tenants.plan` here would put a query in the
 * middle of signing a JWT and would mean every caller had to remember to pass a
 * plan — and the failure mode of forgetting is silent, because a token without
 * a plan is still a perfectly valid token. The value is therefore required of
 * the *route*, which is the only place that knows which tenant it is issuing
 * for, and it is read from the tenant row that route has already loaded.
 *
 * ## Why the plan claim is optional in the type
 *
 * Because `validateToken` does not require it, and that is the decision the
 * gateway's limiter depends on: an absent plan resolves to a bounded
 * `UNKNOWN_PLAN_LIMIT_PER_WINDOW` rather than to nothing. Adding it to the
 * required set would 401 every token minted before the claim existed.
 */

import { describe, expect, it } from 'vitest';

import {
  POS_PLANS,
  counterSubject,
  isPosPlan,
  issueToken,
  validateToken,
} from './auth';

const SECRET = 'test-jwt-secret-key-for-claims-only';
const SUB = 'aaaa-1111';
const BUSINESS = 'tenant-a';
const SCOPES = ['rewards:read'];

describe('the plan claim', () => {
  it('travels in the token and comes back out', async () => {
    const token = await issueToken(SECRET, SUB, BUSINESS, 'customer', SCOPES, 'premium');
    const claims = await validateToken(SECRET, token);

    expect(claims.plan).toBe('premium');
  });

  it('is taken from the caller, so a route cannot pass one tenant\'s plan for another', async () => {
    // The customer token route is the interesting case: it looks a customer up by
    // phone, which is not unique across tenants, and then has to issue a token for
    // the tenant it actually found. Passing the plan next to the `businessId` it
    // was found under is what keeps the two from drifting apart.
    const free = await validateToken(
      SECRET,
      await issueToken(SECRET, SUB, BUSINESS, 'customer', SCOPES, 'free'),
    );
    const premium = await validateToken(
      SECRET,
      await issueToken(SECRET, SUB, BUSINESS, 'customer', SCOPES, 'premium'),
    );

    expect(free.plan).toBe('free');
    expect(premium.plan).toBe('premium');
  });

  it('is omitted entirely when the caller has none, rather than sent as null', async () => {
    // `null` would be a claim the gateway's lookup would miss just as an absent
    // one is, but it would also assert that "we looked and there is no plan",
    // which is a different statement from "this route did not look".
    const token = await issueToken(SECRET, SUB, BUSINESS, 'customer', SCOPES);
    const claims = await validateToken(SECRET, token);

    expect(claims.plan).toBeUndefined();
  });

  it('does not make a token without it invalid', async () => {
    // Every token issued before this claim existed is one of these, and they are
    // valid for an hour after the deploy. Rejecting them here is how a deploy
    // turns into an outage.
    const legacy = await issueToken(SECRET, SUB, BUSINESS, 'customer', SCOPES);

    await expect(validateToken(SECRET, legacy)).resolves.toMatchObject({ sub: SUB });
  });

  it('changes nothing about the claims that were already required', async () => {
    const claims = await validateToken(
      SECRET,
      await issueToken(SECRET, SUB, BUSINESS, 'customer', SCOPES, 'premium'),
    );

    expect(claims.sub).toBe(SUB);
    expect(claims.business_id).toBe(BUSINESS);
    expect(claims.role).toBe('customer');
    expect(claims.scopes).toEqual(SCOPES);
  });
});

describe('POS_PLANS', () => {
  it('is not empty, because an empty list makes the whole feature untestable', () => {
    expect(POS_PLANS.length).toBeGreaterThan(0);
  });

  it('names plans that exist rather than plans that were wished for', () => {
    // The plans in `tenants.plan` are `free` and `premium`. Naming a third tier
    // here would be a promise the schema cannot keep, and it is exactly the
    // mistake `DEFAULT_LIMITS` made with `pro` and `business`.
    expect(POS_PLANS).toEqual(['premium']);
  });

  it('does not include the free tier', () => {
    // The product decision as stated: an advanced plan could include POS, the
    // basic one could not. POS is what a merchant pays us for.
    expect(POS_PLANS).not.toContain('free');
  });

  it('answers the gate for exactly the plans it names', () => {
    expect(isPosPlan('premium')).toBe(true);
    expect(isPosPlan('free')).toBe(false);
    // An absent or unknown plan is not a POS plan. Never "unlimited", never
    // "allowed because we did not understand the question".
    expect(isPosPlan(undefined)).toBe(false);
    expect(isPosPlan('')).toBe(false);
    expect(isPosPlan('PREMIUM')).toBe(false);
  });
});

describe('counterSubject', () => {
  it('namespaces a terminal id the way growth reads it', () => {
    // `requireCounterSubject` in `workers/growth/src/helpers.ts` matches
    // `pos:` + a non-empty remainder on the JWT subject. These two strings have to
    // agree or a credential this worker mints is refused by the routes it exists
    // to serve.
    expect(counterSubject('0f9c1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')).toBe(
      'pos:0f9c1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
    );
  });

  it('is the only way to mint one, so no route has to remember the prefix', () => {
    expect(counterSubject('abc')).toBe('pos:abc');
    // The separator is what keeps `postmaster-3` from reading as a counter.
    expect(counterSubject('abc')).not.toContain('pos-');
  });
});
