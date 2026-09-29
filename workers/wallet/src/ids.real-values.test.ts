import { describe, expect, it } from 'vitest';

import { classIdFor, isValidGoogleId, objectIdFor } from './ids';

/**
 * The real Google values, not placeholders.
 *
 * These are the identifiers the demo tenant's class already has in the Google
 * Pay & Wallet console. If the derivation rules ever drift, a pass built
 * against a class id that does not exist in Google's database fails at the
 * customer's tap rather than in a test, and the class review that produced that
 * id would have to be redone. So the round trip is asserted against the real
 * values.
 */

/** The real issuer id from the Google Pay & Wallet console. */
const ISSUER_ID = '3388000000023206930';

/** The class id the demo tenant's class already has, created by hand. */
const DEMO_CLASS_ID = '3388000000023206930.tenant-90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';

const DEMO_TENANT_ID = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const DEMO_CUSTOMER_GLOBAL_ID = 'c8b61954-1b6d-4dfa-9954-b7c936a9e648';

describe('the real issuer and demo tenant identifiers round-trip', () => {
  it('derives the class id the demo tenant class already has in Google', () => {
    // The class was created in Google's console before this code existed, so
    // the derivation has to reproduce that id exactly. If it does not, every
    // object would reference a class that does not exist.
    expect(classIdFor(ISSUER_ID, DEMO_TENANT_ID)).toBe(DEMO_CLASS_ID);
  });

  it('derives a valid object id for the demo customer', () => {
    const objectId = objectIdFor(ISSUER_ID, DEMO_CUSTOMER_GLOBAL_ID);

    expect(objectId).toBe(
      '3388000000023206930.member-c8b61954-1b6d-4dfa-9954-b7c936a9e648',
    );
    expect(isValidGoogleId(objectId)).toBe(true);
  });

  it('keeps the internal customer id out of the pass id', () => {
    // `customers.id` is a per-database uuid; `customers.global_id` is carried
    // across environments. Using the internal id would make the pass id change
    // on a restore, orphaning a pass a customer already holds in their wallet.
    const INTERNAL_CUSTOMER_ID = 'd185c973-c976-46b5-b3bf-06185739a941';

    expect(objectIdFor(ISSUER_ID, DEMO_CUSTOMER_GLOBAL_ID)).not.toContain(INTERNAL_CUSTOMER_ID);
    expect(objectIdFor(ISSUER_ID, INTERNAL_CUSTOMER_ID)).not.toBe(
      objectIdFor(ISSUER_ID, DEMO_CUSTOMER_GLOBAL_ID),
    );
  });

  it('derives the same class id for a slug rename, because slugs are never used', () => {
    // The tenant's slug is `cafe-central` today and may be anything tomorrow.
    // It appears nowhere in the derivation, which is the property that makes
    // the id stable.
    expect(classIdFor(ISSUER_ID, DEMO_TENANT_ID)).not.toContain('cafe-central');
  });
});
