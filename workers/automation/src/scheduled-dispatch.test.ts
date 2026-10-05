import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WalletWorker } from './helpers';

import { scheduled } from './index';

/**
 * The wallet sweep is driven from this worker's daily cron.
 *
 * The account allows five cron triggers and is already using all five, so the
 * wallet cannot hold its own. This test pins the handoff and, more importantly,
 * its failure behaviour: a cron invocation that throws is retried in full by the
 * platform, which would re-run the birthday and inactivity jobs and can re-send
 * customer notifications.
 */

const handleBirthdayCron = vi.hoisted(() => vi.fn(async () => {}));
const handleInactivityCron = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./cron-handler', () => ({
  handleBirthdayCron,
  handleInactivityCron,
}));

function makeEnv(wallet: Partial<WalletWorker> = {}): { WALLET: WalletWorker; DATABASE_URL: string } {
  return {
    DATABASE_URL: 'postgres://test',
    WALLET: {
      scheduled: vi.fn(async () => undefined),
      deactivateInactivePasses: vi.fn(async () => undefined),
      ...wallet,
    } as unknown as WalletWorker,
  };
}

describe('scheduled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the wallet sweep over the service binding', async () => {
    // Over a binding rather than a fetch: the wallet's own `scheduled` export is
    // called over RPC, so the sweep runs with the wallet's bindings and secrets
    // instead of ones forwarded through this worker.
    const env = makeEnv();
    await scheduled(undefined, env as never);

    expect(env.WALLET.scheduled).toHaveBeenCalledTimes(1);
  });

  it('dispatches the pass-inactivity rule as its own call, not inside the sweep', async () => {
    // The sweep refuses to run in demo mode. Calling the inactivity rule through
    // `scheduled` would put it behind that refusal and it would never run in any
    // environment, so it has to be a separate method on the binding.
    const env = makeEnv();
    await scheduled(undefined, env as never);

    expect(env.WALLET.deactivateInactivePasses).toHaveBeenCalledTimes(1);
  });

  it('asks the inactivity rule to act, and says so explicitly', async () => {
    // This is the one production call site of a rule whose first run deactivates
    // real customers' cards. The wallet's own default is `dryRun: true`, so the
    // write has to be stated here, where it can be found and reviewed.
    const env = makeEnv();
    await scheduled(undefined, env as never);

    expect(env.WALLET.deactivateInactivePasses).toHaveBeenCalledWith({ dryRun: false });
  });

  it('runs the inactivity rule after the sweep, not before', async () => {
    // The sweep reads `last_synced_at` to decide what is due. Deactivating a pass
    // first would take it out of the sweep's reach for the day it was reconciled,
    // leaving a pass Google holds as INACTIVE with a stale number on it.
    //
    // The two cron handlers are armed here rather than relied upon from a
    // neighbouring test: `vi.clearAllMocks()` clears calls, not implementations,
    // so a test that reads another test's armed mock is a test that passes for
    // the wrong reason and fails when the file is reordered.
    const order: string[] = [];
    handleBirthdayCron.mockImplementation(async () => {
      order.push('birthday');
    });
    handleInactivityCron.mockImplementation(async () => {
      order.push('inactivity-cron');
    });
    const env = makeEnv({
      scheduled: vi.fn(async () => {
        order.push('sweep');
      }),
      deactivateInactivePasses: vi.fn(async () => {
        order.push('inactivity');
      }),
    } as Partial<WalletWorker>);

    await scheduled(undefined, env as never);

    expect(order).toEqual(['birthday', 'inactivity-cron', 'sweep', 'inactivity']);
  });

  it('does not re-run its own cron jobs when the inactivity rule throws', async () => {
    // A cron invocation that throws is retried in full by the platform, and those
    // two jobs can re-send customer notifications. The cost of a missed
    // deactivation day is one day; the cost of a retried daily WhatsApp is a
    // customer receiving it twice.
    //
    // So the handler must swallow it, and the notification jobs must have run
    // exactly once. `clearAllMocks` resets calls but keeps implementations, so
    // the assertion is on call counts rather than on a re-armed mock.
    handleBirthdayCron.mockImplementation(async () => {});
    handleInactivityCron.mockImplementation(async () => {});
    const env = makeEnv({
      deactivateInactivePasses: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as Partial<WalletWorker>);

    await expect(scheduled(undefined, env as never)).resolves.toBeUndefined();

    expect(handleBirthdayCron).toHaveBeenCalledTimes(1);
    expect(handleInactivityCron).toHaveBeenCalledTimes(1);
  });

  it('still dispatches the inactivity rule when the sweep itself fails', async () => {
    // Independent fates. A rule that shares the sweep's entry point inherits its
    // failures as well as its demo-mode refusal.
    const env = makeEnv({
      scheduled: vi.fn(async () => {
        throw new Error('sweep is down');
      }),
    } as Partial<WalletWorker>);

    await scheduled(undefined, env as never);

    expect(env.WALLET.deactivateInactivePasses).toHaveBeenCalledTimes(1);
  });

  it('runs its own cron jobs before dispatching', async () => {
    // The wallet must not be able to delay the birthday and inactivity checks.
    const order: string[] = [];
    handleBirthdayCron.mockImplementation(async () => {
      order.push('birthday');
    });
    handleInactivityCron.mockImplementation(async () => {
      order.push('inactivity');
    });
    const env = makeEnv({
      scheduled: vi.fn(async () => {
        order.push('wallet');
      }),
    } as Partial<WalletWorker>);

    await scheduled(undefined, env as never);

    expect(order).toEqual(['birthday', 'inactivity', 'wallet']);
  });

  it('does not throw when the wallet sweep fails', async () => {
    // A throw here would make the platform retry the whole invocation, re-running
    // the two jobs above. A missed sweep day costs one day; a re-sent customer
    // notification costs trust.
    const env = makeEnv({
      scheduled: vi.fn(async () => {
        throw new Error('binding is broken');
      }),
    } as Partial<WalletWorker>);

    await expect(scheduled(undefined, env as never)).resolves.toBeUndefined();
  });

  it('still runs its own jobs when the wallet binding is missing entirely', async () => {
    const env = { DATABASE_URL: 'postgres://test' } as never;
    await expect(scheduled(undefined, env)).resolves.toBeUndefined();
    expect(handleBirthdayCron).toHaveBeenCalled();
    expect(handleInactivityCron).toHaveBeenCalled();
  });
});
