import { describe, expect, it, vi } from 'vitest';

import type { GoogleWalletClient } from './google-client';
import type { LocationsSource } from './locations-source';
import { LocationsPatchNotAppliedError, syncBusinessLocations, syncCustomerLocations } from './locations-sync';
import type { LocationsSyncDeps } from './locations-sync';
import type { WalletStore, WalletPassRow } from './store';

function makePass(customerId: string, objectId: string): WalletPassRow {
  return {
    customerId,
    tenantId: 'tenant-1',
    objectId,
    state: 'issued',
    lastSyncedAt: null,
  };
}

function makeDeps(overrides: {
  findPass?: (customerId: string, tenantId: string) => Promise<WalletPassRow | null>;
  listConsentingPasses?: (input: {
    tenantId: string;
    after: string | null;
    limit: number;
  }) => Promise<WalletPassRow[]>;
  merchantLocationsFor?: (customerId: string, tenantId: string) => Promise<{ latitude: number; longitude: number }[]>;
  patchObject?: (objectId: string, patch: unknown) => Promise<{ merchantLocations?: unknown }>;
}): LocationsSyncDeps {
  const store: WalletStore = {
    findPass: overrides.findPass ?? (async () => null),
    listConsentingPasses: overrides.listConsentingPasses ?? (async () => []),
  } as unknown as WalletStore;

  const locations: LocationsSource = {
    merchantLocationsFor: overrides.merchantLocationsFor ?? (async () => []),
  } as unknown as LocationsSource;

  const client: GoogleWalletClient = {
    patchObject: overrides.patchObject ?? (async (_id, _patch) => ({})),
  } as unknown as GoogleWalletClient;

  return { store, client, locations };
}

describe('syncCustomerLocations', () => {
  it('patches the positions when the customer has a pass and consents', async () => {
    const positions = [
      { latitude: -12.0464, longitude: -77.0428 },
      { latitude: -12.05, longitude: -77.04 },
    ];
    const patchSpy = vi.fn(async () => ({ merchantLocations: positions }));
    const deps = makeDeps({
      findPass: async () => makePass('cust-1', 'obj-1'),
      merchantLocationsFor: async () => positions,
      patchObject: patchSpy,
    });

    const outcome = await syncCustomerLocations(deps, { tenantId: 'tenant-1', customerId: 'cust-1' });

    expect(outcome).toEqual({ kind: 'synced', objectId: 'obj-1', count: 2 });
    expect(patchSpy).toHaveBeenCalledWith('obj-1', { merchantLocations: positions });
    // No notifyPreference on the patch — that would be a push.
    expect((patchSpy.mock.calls[0] as unknown[])?.[1]).not.toHaveProperty('notifyPreference');
  });

  it('returns no_pass and touches Google when there is no tracking row', async () => {
    const patchSpy = vi.fn();
    const deps = makeDeps({
      findPass: async () => null,
      patchObject: patchSpy,
    });

    const outcome = await syncCustomerLocations(deps, { tenantId: 'tenant-1', customerId: 'cust-1' });

    expect(outcome).toEqual({ kind: 'no_pass' });
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('sends an empty list when consent was withdrawn, so the position is cleared', async () => {
    const patchSpy = vi.fn(async () => ({ merchantLocations: [] }));
    const deps = makeDeps({
      findPass: async () => makePass('cust-1', 'obj-1'),
      merchantLocationsFor: async () => [],
      patchObject: patchSpy,
    });

    const outcome = await syncCustomerLocations(deps, { tenantId: 'tenant-1', customerId: 'cust-1' });

    expect(outcome).toEqual({ kind: 'synced', objectId: 'obj-1', count: 0 });
    expect(patchSpy).toHaveBeenCalledWith('obj-1', { merchantLocations: [] });
  });

  it('throws when Google does not echo the positions', async () => {
    const deps = makeDeps({
      findPass: async () => makePass('cust-1', 'obj-1'),
      merchantLocationsFor: async () => [{ latitude: 1, longitude: 2 }],
      patchObject: async () => ({ merchantLocations: [] }),
    });

    await expect(
      syncCustomerLocations(deps, { tenantId: 'tenant-1', customerId: 'cust-1' }),
    ).rejects.toBeInstanceOf(LocationsPatchNotAppliedError);
  });
});

describe('syncBusinessLocations', () => {
  it('patches every consenting pass and reports the count', async () => {
    const patched: string[] = [];
    const _deps = makeDeps({
      listConsentingPasses: async () => [
        makePass('cust-1', 'obj-1'),
        makePass('cust-2', 'obj-2'),
      ],
      merchantLocationsFor: async (customerId) => [{ latitude: Number(customerId.length), longitude: 0 }],
      patchObject: async (objectId) => {
        patched.push(objectId);
        return { merchantLocations: [{ latitude: 0, longitude: 0 }] };
      },
    });

    // The post-condition compares positions; the fake echoes a placeholder, which
    // would fail the tolerance check. Use a tolerating echo instead.
    const positions = [{ latitude: 0, longitude: 0 }];
    const deps2 = makeDeps({
      listConsentingPasses: async () => [makePass('cust-1', 'obj-1'), makePass('cust-2', 'obj-2')],
      merchantLocationsFor: async () => positions,
      patchObject: async (objectId) => {
        patched.push(objectId);
        return { merchantLocations: positions };
      },
    });

    const outcome = await syncBusinessLocations(deps2, { tenantId: 'tenant-1' });

    expect(outcome.synced).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.nextCursor).toBeNull();
    expect(patched).toEqual(['obj-1', 'obj-2']);
  });

  it('records a failure without abandoning the remaining passes', async () => {
    const positions = [{ latitude: 1, longitude: 2 }];
    const deps = makeDeps({
      listConsentingPasses: async () => [makePass('cust-1', 'obj-1'), makePass('cust-2', 'obj-2')],
      merchantLocationsFor: async () => positions,
      patchObject: async (objectId) => {
        if (objectId === 'obj-1') throw new Error('boom');
        return { merchantLocations: positions };
      },
    });

    const outcome = await syncBusinessLocations(deps, { tenantId: 'tenant-1' });

    expect(outcome.synced).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.customerId).toBe('cust-1');
  });

  it('returns a cursor when there is another page', async () => {
    const positions = [{ latitude: 1, longitude: 2 }];
    const deps = makeDeps({
      listConsentingPasses: async (input) => {
        // Three rows for a limit of 2, so the third becomes the next page.
        if (input.after === null) return [makePass('cust-1', 'obj-1'), makePass('cust-2', 'obj-2'), makePass('cust-3', 'obj-3')];
        return [];
      },
      merchantLocationsFor: async () => positions,
      patchObject: async () => ({ merchantLocations: positions }),
    });

    const outcome = await syncBusinessLocations(deps, { tenantId: 'tenant-1', limit: 2 });

    expect(outcome.synced).toBe(2);
    expect(outcome.nextCursor).toBe('cust-2');
  });
});
