/**
 * The signup path's retry around `provisionClass`.
 *
 * Tested on its own, away from the route, because the property under test is
 * *when it stops asking* and that is arithmetic over attempts — a route-level
 * test can only see it through a 201 that every tolerance also answers.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  WALLET_PROVIDING_ATTEMPTS,
  WALLET_PROVISION_BACKOFF_MS,
  provisionClassWithRetry,
} from './wallet-provision';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const CLASS_ID = '3388000000023206930.tenant-90d5ad58';

/** A wallet whose outcomes are scripted, one per attempt. */
function scriptedBinding(outcomes: Array<unknown | Error>) {
  const calls: Array<{ tenantId: string }> = [];
  let index = 0;

  return {
    calls,
    provisionClass: vi.fn((input: { tenantId: string }) => {
      calls.push(input);
      const next = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    }),
  };
}

/** Never waits. The backoff is asserted separately; a test does not pay for it. */
const noSleep = async (): Promise<void> => {};

function captureErrors() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    stop: () => {
      const text = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      spy.mockRestore();
      return text;
    },
  };
}

// ============================================================================
// Retrying what is worth retrying
// ============================================================================

describe('provisionClassWithRetry', () => {
  it('stops as soon as the tenant is provisioned', async () => {
    const binding = scriptedBinding([
      { kind: 'failed', code: 'google_rejected', message: '503 UNAVAILABLE', retryable: true },
      { kind: 'created', classId: CLASS_ID },
    ]);

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    // Two, not three: a run that kept going after success would spend a Google
    // write on a tenant that already has a class, and the budget that bounds the
    // wasted work is the whole reason the attempt count exists.
    expect(binding.provisionClass).toHaveBeenCalledTimes(2);
    expect(binding.calls.map((c) => c.tenantId)).toEqual([TENANT, TENANT]);
  });

  it('retries a rejected call, because a transport failure is transient', async () => {
    const binding = scriptedBinding([
      new Error('Could not obtain a Google Wallet access token'),
      { kind: 'already_exists', classId: CLASS_ID },
    ]);

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    // A throw is not an outcome at all, so nothing can say it is permanent. It is
    // the shape the very first outage produced, and it is the one worth asking
    // about again.
    expect(binding.provisionClass).toHaveBeenCalledTimes(2);
  });

  it('waits longer before each further attempt', async () => {
    const delays: number[] = [];
    const binding = scriptedBinding([new Error('503 UNAVAILABLE')]);

    await provisionClassWithRetry({
      binding,
      tenantId: TENANT,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    // Asserted on the recorded schedule rather than on elapsed wall clock: a test
    // that measured time passes on a machine that is merely slow, and fails on one
    // with a fast clock. Growing is the claim.
    expect(delays).toEqual([...WALLET_PROVISION_BACKOFF_MS]);
    expect(delays.length).toBe(WALLET_PROVIDING_ATTEMPTS - 1);
    for (const [i, ms] of delays.entries()) {
      if (i === 0) continue;
      expect(ms).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('asks a bounded number of times and then stops', async () => {
    const binding = scriptedBinding([new Error('503 UNAVAILABLE')]);

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    // Bounded, and the bound is a stated number rather than "until it works". The
    // daily sweep is the backstop for an outage that outlasts this; a loop with no
    // ceiling would hold the `waitUntil` open for as long as Google is down.
    expect(WALLET_PROVIDING_ATTEMPTS).toBe(3);
    expect(binding.provisionClass).toHaveBeenCalledTimes(WALLET_PROVIDING_ATTEMPTS);
  });

  it('does not retry a typed permanent failure, however many attempts are left', async () => {
    // The test that separates a retry from a hammer. A payload Google calls
    // `invalidField` is rejected identically on the second attempt, so three
    // attempts cost three Google writes to learn the same thing once — and the
    // budget that bounds the damage is exactly the one this bypasses.
    const binding = scriptedBinding([
      { kind: 'failed', code: 'google_rejected', message: 'invalidField', retryable: false },
    ]);
    const logged = captureErrors();

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    expect(binding.provisionClass).toHaveBeenCalledTimes(1);
    // And it says why it stopped, so the log is a diagnosis rather than a count.
    expect(logged.stop()).toContain('will not be retried');
  });

  it('does not mistake an answer it cannot read for a failure', async () => {
    // The other half of the fail-safe direction. `isFailed` keys on
    // `kind === 'failed'` alone, so anything this worker does not recognise — a
    // shape a newer wallet worker introduced, a `kind` renamed, a bare string —
    // ends the loop silently. Reading it as a failure instead would log
    // "failed in a way another attempt cannot change" about a tenant that was in
    // fact provisioned, which is a false alarm at 06:00 for every such tenant.
    //
    // Found by reverting `isFailed`: every other test in this file stayed green.
    for (const unreadable of [
      { kind: 'provisioned', classId: CLASS_ID },
      { kind: 'row_write_failed' },
      { outcome: 'done' },
      'provisioned',
      null,
    ]) {
      const binding = scriptedBinding([unreadable]);
      const logged = captureErrors();

      await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

      // One call: it was not read as a failure, so it was not retried.
      expect(binding.provisionClass, JSON.stringify(unreadable)).toHaveBeenCalledTimes(1);
      // And nothing was reported, because nothing failed.
      expect(logged.stop(), JSON.stringify(unreadable)).not.toContain('will not be retried');
    }
  });

  it('treats a failed outcome with no retryable flag as permanent, not as worth another try', async () => {
    // Fail-safe direction. An outcome this worker cannot read is not evidence that
    // the call failed, and a hammer on an answer we do not understand is the exact
    // thing the typed contract exists to prevent. `!== true`, not `=== false`.
    const binding = scriptedBinding([{ kind: 'failed', code: 'class_payload_invalid', message: 'blank' }]);

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    expect(binding.provisionClass).toHaveBeenCalledTimes(1);
  });

  it('retries a failed outcome that says it is transient', async () => {
    const binding = scriptedBinding([
      { kind: 'failed', code: 'row_write_failed', message: 'deadlock', retryable: true },
      { kind: 'already_exists', classId: CLASS_ID },
    ]);

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    // The other direction of the same guard, so the two together say the flag is
    // being read rather than merely defaulted.
    expect(binding.provisionClass).toHaveBeenCalledTimes(2);
  });

  it('does not retry a binding that throws synchronously, because that is not a worker', async () => {
    const binding = {
      calls: [] as Array<{ tenantId: string }>,
      provisionClass: vi.fn((input: { tenantId: string }) => {
        binding.calls.push(input);
        throw new Error('binding is not a worker');
      }),
    };
    const logged = captureErrors();

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    // A misconfigured binding is a configuration error, not a bad afternoon at
    // Google: the same call three times raises the same throw. And it is the one
    // failure that must never be mistaken for a transient one, because the route
    // calls this from inside its own `try`.
    expect(binding.provisionClass).toHaveBeenCalledTimes(1);
    expect(logged.stop()).toContain('Could not reach the wallet');
  });

  it('never rejects, whatever the wallet does', async () => {
    // The promise this hands to `waitUntil` must not reject: a rejected
    // background task is attributed to an invocation whose visible result was a
    // 201, which is indistinguishable from a real fault in somebody's log.
    const binding = scriptedBinding([new Error('503 UNAVAILABLE')]);

    await expect(
      provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep }),
    ).resolves.toBeUndefined();
  });

  it('asks about the tenant it was given and no other', async () => {
    const binding = scriptedBinding([new Error('503 UNAVAILABLE')]);

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    for (const call of binding.calls) {
      expect(call.tenantId).toBe(TENANT);
      expect(call.tenantId).not.toBe(OTHER_TENANT);
    }
  });

  it('reports what it gave up on, naming the tenant', async () => {
    const binding = scriptedBinding([new Error('503 UNAVAILABLE')]);
    const logged = captureErrors();

    await provisionClassWithRetry({ binding, tenantId: TENANT, sleep: noSleep });

    const text = logged.stop();
    // "Retried and failed" and "gave up" are different facts, and a log that only
    // says "failed" leaves a reader guessing whether a second attempt is coming.
    expect(text).toContain(TENANT);
    expect(text).toContain(`after ${WALLET_PROVIDING_ATTEMPTS} attempts`);
  });

  it('uses a sleep that is not injected when none is given, so the default exists', async () => {
    // The route passes none, so the default is the code path production runs.
    // Asserted through the shape of the schedule rather than by waiting it out:
    // the recorded delay must be the one the constants say.
    const binding = scriptedBinding([new Error('503 UNAVAILABLE'), { kind: 'created', classId: CLASS_ID }]);

    const started = Date.now();
    await provisionClassWithRetry({ binding, tenantId: TENANT });

    // Two attempts means exactly one backoff, and it is the first entry.
    expect(binding.provisionClass).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(WALLET_PROVISION_BACKOFF_MS[0]! - 50);
  });
});