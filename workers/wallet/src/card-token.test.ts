import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CARD_TOKEN_PATTERN, deriveCardToken, hashCardToken, isCardToken } from './card-token';

/** Generated for this run and discarded with it. Never a real secret. */
const SECRET = crypto.randomUUID() + crypto.randomUUID();
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const GLOBAL_ID = 'c8b61954-1b6d-4dfa-9954-b7c936a9e648';

/**
 * An independent implementation of the L6 contract on `node:crypto`, so the
 * WebCrypto module is checked against the written formula rather than itself.
 */
function referenceToken(secret: string, tenantId: string, globalId: string, version: number): string {
  const t = encodeURIComponent(tenantId);
  const g = encodeURIComponent(globalId);
  const message = `card|v1|${t.length}|${t}|${g.length}|${g}|${version}`;
  return `vyc1.${createHmac('sha256', secret).update(message, 'utf8').digest('base64url')}`;
}

describe('deriveCardToken', () => {
  it('matches the contract formula exactly', async () => {
    const token = await deriveCardToken({ secret: SECRET, tenantId: TENANT, customerGlobalId: GLOBAL_ID, version: 1 });

    expect(token).toBe(referenceToken(SECRET, TENANT, GLOBAL_ID, 1));
    expect(token).toMatch(/^vyc1\.[A-Za-z0-9_-]{43}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const input = { secret: SECRET, tenantId: TENANT, customerGlobalId: GLOBAL_ID, version: 3 };
    expect(await deriveCardToken(input)).toBe(await deriveCardToken(input));
  });

  it('changes when the version changes', async () => {
    const base = { secret: SECRET, tenantId: TENANT, customerGlobalId: GLOBAL_ID };
    const v1 = await deriveCardToken({ ...base, version: 1 });
    const v2 = await deriveCardToken({ ...base, version: 2 });
    expect(v1).not.toBe(v2);
  });

  it('changes with the tenant and with the secret', async () => {
    const base = { secret: SECRET, tenantId: TENANT, customerGlobalId: GLOBAL_ID, version: 1 };
    const original = await deriveCardToken(base);
    expect(await deriveCardToken({ ...base, tenantId: OTHER_TENANT })).not.toBe(original);
    expect(await deriveCardToken({ ...base, secret: `${SECRET}x` })).not.toBe(original);
  });

  it('refuses an empty secret', async () => {
    await expect(
      deriveCardToken({ secret: '', tenantId: TENANT, customerGlobalId: GLOBAL_ID, version: 1 }),
    ).rejects.toThrow(/CARD_TOKEN_SECRET is empty/);
  });

  it('refuses a version that is not a positive integer', async () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      await expect(
        deriveCardToken({ secret: SECRET, tenantId: TENANT, customerGlobalId: GLOBAL_ID, version }),
      ).rejects.toThrow(/version/);
    }
  });
});

describe('hashCardToken', () => {
  it('is the lowercase hex SHA-256 of the full token, prefix included', async () => {
    const token = referenceToken(SECRET, TENANT, GLOBAL_ID, 1);
    const expected = createHash('sha256').update(token, 'utf8').digest('hex');

    const hash = await hashCardToken(token);

    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Not the hash of the body alone: the prefix is part of what is hashed.
    expect(hash).not.toBe(createHash('sha256').update(token.slice(5), 'utf8').digest('hex'));
  });
});

describe('isCardToken', () => {
  it('accepts a derived token', async () => {
    expect(isCardToken(referenceToken(SECRET, TENANT, GLOBAL_ID, 7))).toBe(true);
  });

  it('rejects a uuid, a wrong prefix, a wrong length and padding', () => {
    expect(isCardToken(GLOBAL_ID)).toBe(false);
    expect(isCardToken(`vyc2.${'A'.repeat(43)}`)).toBe(false);
    expect(isCardToken(`vyc1.${'A'.repeat(42)}`)).toBe(false);
    expect(isCardToken(`vyc1.${'A'.repeat(42)}=`)).toBe(false);
    expect(isCardToken(`vyc1.${'A'.repeat(43)}\n`)).toBe(false);
    expect(isCardToken(null)).toBe(false);
    expect(isCardToken(undefined)).toBe(false);
  });

  it('exports the contract regex', () => {
    expect(CARD_TOKEN_PATTERN.source).toBe('^vyc1\\.[A-Za-z0-9_-]{43}$');
  });
});
