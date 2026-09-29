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
    WALLET: { scheduled: vi.fn(async () => undefined), ...wallet } as unknown as WalletWorker,
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
