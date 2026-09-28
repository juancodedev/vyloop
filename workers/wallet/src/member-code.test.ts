import { describe, expect, it } from 'vitest';

import {
  CROCKFORD_ALPHABET,
  CROCKFORD_EXCLUDED,
  MEMBER_CODE_LENGTH,
  MEMBER_CODE_MAX_ATTEMPTS,
  MemberCodeExhaustedError,
  findAvailableMemberCode,
  generateMemberCode,
  isValidMemberCode,
} from './member-code';

/**
 * A pepper generated for this test run and thrown away with it. It is not a
 * credential: it protects nothing, authenticates nothing, and no real value
 * ever lives in the repository, in `.dev.vars` or in a fixture.
 */
const PEPPER = crypto.randomUUID() + crypto.randomUUID();

const TENANT_A = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const TENANT_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TENANT_C = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const CUSTOMER_1 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CUSTOMER_2 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const CUSTOMER_3 = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';

describe('generateMemberCode', () => {
  it('produces exactly 6 characters', async () => {
    for (let i = 0; i < 200; i += 1) {
      const code = await generateMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: CUSTOMER_1,
        pepper: PEPPER,
      });
      expect(code).toHaveLength(MEMBER_CODE_LENGTH);
    }
  });

  it('produces uppercase characters only', async () => {
    for (let i = 0; i < 200; i += 1) {
      const code = await generateMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
        pepper: PEPPER,
      });
      expect(code).toBe(code.toUpperCase());
      expect(code).not.toMatch(/[a-z]/);
    }
  });

  it('never contains I, L, O or U', async () => {
    // The whole reason for Crockford Base32: these four are the letters a human
    // misreads or mis-hears over counter noise, and a code containing one is a
    // support call at the till.
    for (let i = 0; i < 500; i += 1) {
      const code = await generateMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`,
        pepper: PEPPER,
      });
      for (const excluded of CROCKFORD_EXCLUDED) {
        expect(code, `attempt ${i} produced ${code}`).not.toContain(excluded);
      }
    }
  });

  it('uses only the Crockford alphabet', async () => {
    const code = await generateMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
    });
    for (const character of code) {
      expect(CROCKFORD_ALPHABET).toContain(character);
    }
  });

  it('excludes exactly the four ambiguous letters from the alphabet', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    for (const excluded of CROCKFORD_EXCLUDED) {
      expect(CROCKFORD_ALPHABET).not.toContain(excluded);
    }
    // Crockford also folds these: 1 reads as I, 0 reads as O. The digits stay
    // in the alphabet because that is what makes the fold unambiguous.
    expect(CROCKFORD_ALPHABET).toContain('0');
    expect(CROCKFORD_ALPHABET).toContain('1');
  });

  it('is deterministic for the same tenant, customer and pepper', async () => {
    const first = await generateMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
    });
    for (let i = 0; i < 20; i += 1) {
      expect(
        await generateMemberCode({
          tenantId: TENANT_A,
          customerGlobalId: CUSTOMER_1,
          pepper: PEPPER,
        }),
      ).toBe(first);
    }
  });

  it('gives two customers in the same tenant different codes', async () => {
    const codes = await Promise.all(
      [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3].map((customerGlobalId) =>
        generateMemberCode({ tenantId: TENANT_A, customerGlobalId, pepper: PEPPER }),
      ),
    );
    expect(new Set(codes).size).toBe(3);
  });

  it('gives the same customer a different code at two different tenants', async () => {
    // Non-correlationality is a privacy requirement: if the code were the same
    // at every merchant, any two competitors holding one pass each could
    // confirm the customer is the same person.
    const atA = await generateMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
    });
    const atB = await generateMemberCode({
      tenantId: TENANT_B,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
    });
    const atC = await generateMemberCode({
      tenantId: TENANT_C,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
    });

    expect(atA).not.toBe(atB);
    expect(atB).not.toBe(atC);
    expect(atA).not.toBe(atC);
  });

  it('does not let a tenant id ending in a separator collide with another tenant', async () => {
    // A naive `${tenantId}:${globalId}` template would make tenant "a" with
    // customer "b:c" hash the same message as tenant "a:b" with customer "c".
    const naiveCollision = await generateMemberCode({
      tenantId: 'a',
      customerGlobalId: 'b:c',
      pepper: PEPPER,
    });
    const other = await generateMemberCode({
      tenantId: 'a:b',
      customerGlobalId: 'c',
      pepper: PEPPER,
    });
    expect(naiveCollision).not.toBe(other);
  });

  it('changes when the attempt counter changes, so a retry walks new space', async () => {
    const base = { tenantId: TENANT_A, customerGlobalId: CUSTOMER_1, pepper: PEPPER };
    const codes = await Promise.all(
      Array.from({ length: 6 }, (_unused, attempt) =>
        generateMemberCode({ ...base, attempt }),
      ),
    );
    expect(new Set(codes).size).toBe(6);
  });

  it('changes when the pepper changes, so codes cannot be recomputed offline', async () => {
    // `globalId` is printed in the barcode of every pass and `tenantId` is not
    // secret. Without a pepper, anyone who scanned one pass could recompute the
    // code and match it against a second pass to link the two.
    const withPepper = await generateMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
    });
    const withOtherPepper = await generateMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: `${PEPPER}-rotated`,
    });
    expect(withPepper).not.toBe(withOtherPepper);
  });

  it('rejects an empty pepper rather than emitting a derivable code', async () => {
    await expect(
      generateMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: CUSTOMER_1,
        pepper: '',
      }),
    ).rejects.toThrow(/pepper/i);
  });

  it('carries no ordering information', async () => {
    // A sequential code would let a competitor who saw one pass estimate a
    // merchant's customer count. This asserts the code is uncorrelated with the
    // order customers were issued in.
    //
    // 2000 codes, Spearman rank correlation between issuance order and code
    // value. For a random permutation of n items the sampling standard
    // deviation of rho is about 1/sqrt(n - 1) ~= 0.022, so a threshold of 0.15
    // sits about 6.6 sigma out: a genuinely uniform generator passes with
    // overwhelming probability, and any generator that leaks order (a counter, a
    // truncated ordered hash, a sequential id) fails hard.
    const sampleSize = 2000;
    const ranks: number[] = [];
    const values: number[] = [];

    for (let i = 0; i < sampleSize; i += 1) {
      const code = await generateMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`,
        pepper: PEPPER,
      });
      values.push(CROCKFORD_ALPHABET.indexOf(code[0] as string) * 1024 +
        CROCKFORD_ALPHABET.indexOf(code[1] as string));
    }

    // Rank `values` ascending, keeping the paired issuance order.
    const pairs = values
      .map((value, index) => ({ value, index }))
      .sort((left, right) => left.value - right.value);
    pairs.forEach((pair, rank) => {
      ranks[pair.index] = rank + 1;
    });

    const n = sampleSize;
    let dSquared = 0;
    for (let i = 0; i < n; i += 1) {
      const difference = (i + 1 - (ranks[i] as number)) as number;
      dSquared += difference * difference;
    }
    const rho = 1 - (6 * dSquared) / (n * (n * n - 1));

    expect(Math.abs(rho), `rank correlation was ${rho.toFixed(4)}`).toBeLessThan(0.15);
  });
});

describe('isValidMemberCode', () => {
  it('accepts a well formed code', async () => {
    const code = await generateMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
    });
    expect(isValidMemberCode(code)).toBe(true);
  });

  it('rejects the wrong length, lowercase, and the excluded letters', () => {
    expect(isValidMemberCode('ABC')).toBe(false);
    expect(isValidMemberCode('ABCDEFG')).toBe(false);
    expect(isValidMemberCode('abc123')).toBe(false);
    expect(isValidMemberCode('ABC12I')).toBe(false);
    expect(isValidMemberCode('ABC12L')).toBe(false);
    expect(isValidMemberCode('ABC12O')).toBe(false);
    expect(isValidMemberCode('ABC12U')).toBe(false);
    expect(isValidMemberCode('')).toBe(false);
  });
});

describe('findAvailableMemberCode', () => {
  it('returns the derived code when it is free', async () => {
    const code = await findAvailableMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
      isTaken: () => false,
    });
    expect(code).toBe(
      await generateMemberCode({ tenantId: TENANT_A, customerGlobalId: CUSTOMER_1, pepper: PEPPER }),
    );
  });

  it('retries when the first candidate is taken', async () => {
    const seen: string[] = [];
    const code = await findAvailableMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
      isTaken: (candidate) => {
        seen.push(candidate);
        return seen.length <= 2;
      },
    });
    expect(seen).toHaveLength(3);
    expect(code).toBe(seen[2]);
    // The retry must not degrade the code's shape.
    expect(isValidMemberCode(code)).toBe(true);
  });

  it('asks the tenant-scoped check, passing each candidate exactly once', async () => {
    const asked: string[] = [];
    await findAvailableMemberCode({
      tenantId: TENANT_A,
      customerGlobalId: CUSTOMER_1,
      pepper: PEPPER,
      isTaken: (candidate) => {
        asked.push(candidate);
        return false;
      },
    });
    expect(asked).toHaveLength(1);
    expect(isValidMemberCode(asked[0] as string)).toBe(true);
  });

  it('gives up loudly rather than looping forever', async () => {
    await expect(
      findAvailableMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: CUSTOMER_1,
        pepper: PEPPER,
        isTaken: () => true,
      }),
    ).rejects.toThrow(MemberCodeExhaustedError);
  });

  it('tries a bounded number of candidates before giving up', async () => {
    let calls = 0;
    await expect(
      findAvailableMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: CUSTOMER_1,
        pepper: PEPPER,
        isTaken: () => {
          calls += 1;
          return true;
        },
      }),
    ).rejects.toThrow(MemberCodeExhaustedError);
    expect(calls).toBe(MEMBER_CODE_MAX_ATTEMPTS);
  });

  it('stays collision-free across a realistic tenant population', async () => {
    // 30 bits of entropy: 2000 customers in one tenant, which is far beyond
    // what a single cafe or bakery accumulates. With a partial unique index
    // behind it, the application check is the friendly layer, not the guard.
    const taken = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = await findAvailableMemberCode({
        tenantId: TENANT_A,
        customerGlobalId: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`,
        pepper: PEPPER,
        isTaken: (candidate) => taken.has(candidate),
      });
      expect(taken.has(code)).toBe(false);
      taken.add(code);
    }
    expect(taken.size).toBe(2000);
  });
});
