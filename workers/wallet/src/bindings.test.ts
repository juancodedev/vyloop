import { describe, expect, it, vi } from 'vitest';

import {
  confirmObjectBindings,
  describeBindingDefects,
  findBindingDefects,
} from './bindings';
import type { LoyaltyObject } from './object';

const ISSUER = '3388000000022000000';
const OBJECT_ID = `${ISSUER}.member-4d0d3a8e-2f0f-4f0e-9f39-1e6f0b7d4c11`;
const GLOBAL_ID = '4d0d3a8e-2f0f-4f0e-9f39-1e6f0b7d4c11';
const CLASS_ID = `${ISSUER}.panaderia-del-barrio`;

/** The projection the route sent. */
function expectedObject(overrides: Partial<LoyaltyObject> = {}): LoyaltyObject {
  return {
    id: OBJECT_ID,
    classId: CLASS_ID,
    state: 'ACTIVE',
    accountName: 'Camila Rojas',
    accountId: 'K7M2QX',
    loyaltyPoints: { label: 'puntos', balance: { string: '96942' } },
    barcode: { type: 'QR_CODE', value: GLOBAL_ID },
    ...overrides,
  };
}

/** What Google echoed back. Lower-case `state` on purpose: that is what it sends. */
function echoedResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OBJECT_ID,
    classId: CLASS_ID,
    state: 'active',
    accountName: 'Camila Rojas',
    accountId: 'K7M2QX',
    loyaltyPoints: { label: 'puntos', balance: { string: '96942' } },
    barcode: { type: 'QR_CODE', value: GLOBAL_ID },
    ...overrides,
  };
}

function readDeps(result: unknown = echoedResource()) {
  const getObject = vi.fn(async () => result);
  return { getObject };
}

describe('findBindingDefects', () => {
  it('finds nothing wrong with a faithful echo', () => {
    expect(findBindingDefects(expectedObject(), echoedResource())).toEqual([]);
  });

  it('names a differing accountId as different', () => {
    const defects = findBindingDefects(expectedObject(), echoedResource({ accountId: 'K7M2Q' }));

    // `accountId` is the short code the counter types by hand, so a truncated
    // echo is a pass whose manual lookup can never match.
    expect(defects).toEqual([{ field: 'accountId', kind: 'different' }]);
  });

  it('names a differing barcode value as different', () => {
    const defects = findBindingDefects(
      expectedObject(),
      echoedResource({ barcode: { type: 'QR_CODE', value: 'not-the-global-id' } }),
    );

    expect(defects).toEqual([{ field: 'barcode.value', kind: 'different' }]);
  });

  it('names a differing object id as different', () => {
    const defects = findBindingDefects(expectedObject(), echoedResource({ id: `${ISSUER}.member-x` }));

    expect(defects).toEqual([{ field: 'id', kind: 'different' }]);
  });

  it('names a differing classId as different', () => {
    const defects = findBindingDefects(expectedObject(), echoedResource({ classId: `${ISSUER}.other` }));

    expect(defects).toEqual([{ field: 'classId', kind: 'different' }]);
  });

  it('accepts the deprecated `qrCode` spelling of the barcode type', () => {
    // Google still answers `qrCode` in some responses; comparing the raw string
    // would report a correct pass as broken.
    const defects = findBindingDefects(
      expectedObject(),
      echoedResource({ barcode: { type: 'qrCode', value: GLOBAL_ID } }),
    );

    expect(defects).toEqual([]);
  });

  it('reports a different symbology rather than normalising it into a match', () => {
    const defects = findBindingDefects(
      expectedObject(),
      echoedResource({ barcode: { type: 'CODE_128', value: GLOBAL_ID } }),
    );

    expect(defects).toEqual([{ field: 'barcode.type', kind: 'different' }]);
  });

  it('reports an omitted field as missing, not as different', () => {
    const echoed = echoedResource();
    delete echoed.accountId;

    const defects = findBindingDefects(expectedObject(), echoed);

    // The distinction drives the retry: `missing` is worth one read, `different`
    // is a definitive answer and is not.
    expect(defects).toEqual([{ field: 'accountId', kind: 'missing' }]);
  });

  it('reports a barcode without a type as missing and a malformed one as invalid', () => {
    expect(findBindingDefects(expectedObject(), echoedResource({ barcode: { value: GLOBAL_ID } }))).toEqual([
      { field: 'barcode.type', kind: 'missing' },
    ]);

    expect(findBindingDefects(expectedObject(), echoedResource({ barcode: 'QR_CODE' }))).toEqual([
      { field: 'barcode.type', kind: 'invalid' },
      { field: 'barcode.value', kind: 'invalid' },
    ]);
  });

  it('reports a non-string value as invalid', () => {
    expect(findBindingDefects(expectedObject(), echoedResource({ accountId: 12345 }))).toEqual([
      { field: 'accountId', kind: 'invalid' },
    ]);
  });

  it('reports every field as invalid when the write answered with no resource', () => {
    expect(findBindingDefects(expectedObject(), null)).toHaveLength(5);
  });
});

describe('confirmObjectBindings', () => {
  it('confirms a faithful echo without reading the object again', async () => {
    const deps = readDeps();

    const confirmation = await confirmObjectBindings(expectedObject(), echoedResource(), deps);

    expect(confirmation).toEqual({ kind: 'confirmed', source: 'write' });
    // The acceptance criterion the route test cannot state: a correct insert
    // costs zero extra calls.
    expect(deps.getObject).not.toHaveBeenCalled();
  });

  it('refuses a differing accountId without reading again', async () => {
    const deps = readDeps();

    const confirmation = await confirmObjectBindings(
      expectedObject(),
      echoedResource({ accountId: 'K7M2Q' }),
      deps,
    );

    expect(confirmation).toEqual({
      kind: 'unconfirmed',
      source: 'write',
      defects: [{ field: 'accountId', kind: 'different' }],
      readFailed: false,
    });
    expect(deps.getObject).not.toHaveBeenCalled();
  });

  it('re-reads once when the echo omits a field, and confirms on a complete read', async () => {
    const echoed = echoedResource();
    delete echoed.barcode;
    const deps = readDeps(echoedResource());

    const confirmation = await confirmObjectBindings(expectedObject(), echoed, deps);

    // A partial insert response is not a partial object; the object is there and
    // one read says so. Rejecting here would cost the customer a working pass.
    expect(confirmation).toEqual({ kind: 'confirmed', source: 'read' });
    expect(deps.getObject).toHaveBeenCalledTimes(1);
    expect(deps.getObject).toHaveBeenCalledWith(OBJECT_ID);
  });

  it('stays unconfirmed when the read is missing the field too', async () => {
    const echoed = echoedResource();
    delete echoed.barcode;
    const incomplete = echoedResource();
    delete incomplete.barcode;
    const deps = readDeps(incomplete);

    const confirmation = await confirmObjectBindings(expectedObject(), echoed, deps);

    expect(confirmation).toEqual({
      kind: 'unconfirmed',
      source: 'read',
      defects: [
        { field: 'barcode.type', kind: 'missing' },
        { field: 'barcode.value', kind: 'missing' },
      ],
      readFailed: false,
    });
  });

  it('treats a failed read as unconfirmed rather than as success', async () => {
    const echoed = echoedResource();
    delete echoed.accountId;
    const getObject = vi.fn(async () => {
      throw new Error('Google is having a bad minute');
    });

    const confirmation = await confirmObjectBindings(expectedObject(), echoed, { getObject });

    expect(confirmation.kind).toBe('unconfirmed');
    expect(confirmation).toMatchObject({ readFailed: true });
  });

  it('treats an object Google denies having as unconfirmed', async () => {
    const echoed = echoedResource();
    delete echoed.accountId;

    const confirmation = await confirmObjectBindings(expectedObject(), echoed, readDeps(null));

    expect(confirmation.kind).toBe('unconfirmed');
    expect(confirmation).toMatchObject({ source: 'read' });
  });
});

describe('describeBindingDefects', () => {
  it('names the field and the category, never the value', () => {
    const defects = findBindingDefects(
      expectedObject(),
      echoedResource({ accountId: 'K7M2Q', barcode: { type: 'QR_CODE', value: 'leaked-value' } }),
    );

    const description = describeBindingDefects(defects);

    expect(description).toBe('accountId (different), barcode.value (different)');
    // The rule the callback route already states: a log line must never carry the
    // global id or the member code.
    expect(description).not.toContain('leaked-value');
    expect(description).not.toContain('K7M2Q');
    expect(description).not.toContain(GLOBAL_ID);
  });
});
