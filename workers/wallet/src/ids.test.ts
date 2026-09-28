import { describe, expect, it } from 'vitest';

import {
  GOOGLE_ID_PATTERN,
  GOOGLE_QUALIFIED_ID_PATTERN,
  InvalidGoogleIdError,
  classIdFor,
  isValidGoogleId,
  isValidIdPart,
  objectIdFor,
  sanitizeIdPart,
} from './ids';

/**
 * A Google-issued issuer id is numeric in practice, but the API only documents
 * it as an identifier, so both spellings are exercised.
 */
const ISSUER = '338800013922057609515';

const TENANT_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_TENANT_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const CUSTOMER_GLOBAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Slugs a merchant can actually set today: `tenants.slug` is `text` with a
 * unique index and no format validation anywhere in the repo, so nothing stops
 * any of these.
 */
const HOSTILE_SLUGS = [
  'Café Ñoño',
  'panaderia don tomas',
  'a/b/c',
  'slash\\back',
  'emoji 🍞 bakery',
  'UPPER CASE',
  '...leading and trailing...',
  'tab\tand\nnewline',
  'quote"and\'quote',
  'semi;colon--and__underscore',
  'ñ' + 'a'.repeat(200),
];

describe('sanitizeIdPart', () => {
  it('keeps a value that is already valid, unchanged', () => {
    expect(sanitizeIdPart(TENANT_UUID)).toBe(TENANT_UUID);
    expect(sanitizeIdPart('already-valid_1.2')).toBe('already-valid_1.2');
  });

  it('lowercases, so ids are canonical regardless of input case', () => {
    expect(sanitizeIdPart('ABCDEF')).toBe('abcdef');
    expect(sanitizeIdPart(TENANT_UUID.toUpperCase())).toBe(TENANT_UUID);
  });

  it('replaces every disallowed character with a single dash', () => {
    expect(sanitizeIdPart('a b c')).toBe('a-b-c');
    // The accent becomes a dash, which is then stripped as a trailing separator.
    expect(sanitizeIdPart('café')).toBe('caf');
    expect(sanitizeIdPart('café-au-lait')).toBe('caf-au-lait');
  });

  it('collapses a run of disallowed characters into one dash', () => {
    // A run must not produce one dash per character, or the id would grow with
    // the length of the noise.
    expect(sanitizeIdPart('a     b')).toBe('a-b');
    expect(sanitizeIdPart('a---b')).toBe('a-b');
  });

  it('strips leading and trailing separators', () => {
    expect(sanitizeIdPart('  -abc-  ')).toBe('abc');
    expect(sanitizeIdPart('._abc_.')).toBe('abc');
    expect(sanitizeIdPart('---a---b---')).toBe('a-b');
  });

  it('throws rather than returning an empty id', () => {
    // An empty id is never correct, and a caller that receives one will build
    // `issuer.` — which Google rejects with an opaque 400.
    expect(() => sanitizeIdPart('')).toThrow(InvalidGoogleIdError);
    expect(() => sanitizeIdPart('   ')).toThrow(InvalidGoogleIdError);
    expect(() => sanitizeIdPart('🍕')).toThrow(InvalidGoogleIdError);
  });

  it('cannot emit a value outside Google character set, for any input', () => {
    for (const slug of HOSTILE_SLUGS) {
      const result = sanitizeIdPart(slug);
      expect(GOOGLE_ID_PATTERN.test(result), `failed for ${JSON.stringify(slug)}`).toBe(true);
    }
  });
});

describe('isValidIdPart', () => {
  it('accepts only lowercase alphanumerics, dot, underscore and dash', () => {
    expect(isValidIdPart('abc123')).toBe(true);
    expect(isValidIdPart('a.b_c-d')).toBe(true);
    expect(isValidIdPart('ABC')).toBe(false);
    expect(isValidIdPart('a b')).toBe(false);
    expect(isValidIdPart('café')).toBe(false);
    expect(isValidIdPart('')).toBe(false);
  });

  it('does not silently repair: it reports, it does not sanitise', () => {
    // The point of exporting a validator is to assert on a value that came
    // from Google, not to make a bad value look good.
    expect(isValidIdPart('Café')).toBe(false);
  });
});

describe('classIdFor', () => {
  it('produces <issuerId>.tenant-<tenantId>', () => {
    expect(classIdFor(ISSUER, TENANT_UUID)).toBe(`${ISSUER}.tenant-${TENANT_UUID}`);
  });

  it('is stable across calls', () => {
    const first = classIdFor(ISSUER, TENANT_UUID);
    for (let i = 0; i < 50; i += 1) {
      expect(classIdFor(ISSUER, TENANT_UUID)).toBe(first);
    }
  });

  it('never collides for distinct tenants', () => {
    const ids = new Set(
      Array.from({ length: 2000 }, (_unused, i) =>
        classIdFor(ISSUER, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
      ),
    );
    expect(ids.size).toBe(2000);
  });

  it('is unaffected by a merchant renaming their slug', () => {
    // The class id is derived from the UUID, not the slug, so a rename is a
    // data change with no pass invalidation. Nothing here even receives a slug:
    // that is the guarantee.
    expect(classIdFor(ISSUER, TENANT_UUID)).toBe(classIdFor(ISSUER, TENANT_UUID));
    expect(classIdFor(ISSUER, TENANT_UUID)).not.toBe(classIdFor(ISSUER, OTHER_TENANT_UUID));
  });

  it('stays inside Google character set even for a hostile identifier', () => {
    for (const slug of HOSTILE_SLUGS) {
      const id = classIdFor(ISSUER, slug);
      expect(GOOGLE_QUALIFIED_ID_PATTERN.test(id), `failed for ${JSON.stringify(slug)}`).toBe(
        true,
      );
      expect(id.startsWith(`${ISSUER}.tenant-`)).toBe(true);
    }
  });

  it('sanitises a hostile issuer id too', () => {
    const id = classIdFor('Issuer Account (3388)', TENANT_UUID);
    expect(GOOGLE_QUALIFIED_ID_PATTERN.test(id)).toBe(true);
    expect(id.startsWith('issuer-account-3388.tenant-')).toBe(true);
  });

  it('throws when the issuer id has nothing left after sanitising', () => {
    expect(() => classIdFor('***', TENANT_UUID)).toThrow(InvalidGoogleIdError);
  });
});

describe('objectIdFor', () => {
  it('produces <issuerId>.member-<customerGlobalId>', () => {
    expect(objectIdFor(ISSUER, CUSTOMER_GLOBAL_ID)).toBe(`${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`);
  });

  it('is stable across calls', () => {
    const first = objectIdFor(ISSUER, CUSTOMER_GLOBAL_ID);
    for (let i = 0; i < 50; i += 1) {
      expect(objectIdFor(ISSUER, CUSTOMER_GLOBAL_ID)).toBe(first);
    }
  });

  it('never collides for distinct customers', () => {
    const ids = new Set(
      Array.from({ length: 2000 }, (_unused, i) =>
        objectIdFor(ISSUER, `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}`),
      ),
    );
    expect(ids.size).toBe(2000);
  });

  it('is derived from global_id, so a database restore keeps the same pass id', () => {
    // A restore mints new `customers.id` values. `global_id` is carried across,
    // which is exactly why the pass id derives from it. Two customers with
    // different internal ids but the same global id must produce the same pass.
    const afterRestore = objectIdFor(ISSUER, CUSTOMER_GLOBAL_ID);
    expect(afterRestore).toBe(`${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`);
  });

  it('stays inside Google character set even for a hostile identifier', () => {
    for (const value of HOSTILE_SLUGS) {
      const id = objectIdFor(ISSUER, value);
      expect(GOOGLE_QUALIFIED_ID_PATTERN.test(id), `failed for ${JSON.stringify(value)}`).toBe(
        true,
      );
      expect(id.startsWith(`${ISSUER}.member-`)).toBe(true);
    }
  });

  it('produces a distinct id from the class id for the same input', () => {
    expect(objectIdFor(ISSUER, TENANT_UUID)).not.toBe(classIdFor(ISSUER, TENANT_UUID));
  });
});

describe('isValidGoogleId', () => {
  it('requires an issuer part and a suffix part', () => {
    expect(isValidGoogleId(`${ISSUER}.tenant-${TENANT_UUID}`)).toBe(true);
    expect(isValidGoogleId('nodots')).toBe(false);
    expect(isValidGoogleId('trailing.')).toBe(false);
    expect(isValidGoogleId('.leading')).toBe(false);
  });
});
