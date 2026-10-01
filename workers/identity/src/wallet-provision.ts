/**
 * The retry around `provisionClass` that the signup path runs.
 *
 * ## What this closes, and what it does not
 *
 * `scheduleWalletProvisioning` asks the wallet to create a tenant's Google class
 * exactly once, under `waitUntil`. If Google is having a bad minute, the business
 * is registered and no card ever appears for it — and nothing re-runs that call,
 * because the sweep only enumerates tenants that already have a program row, and
 * a tenant whose provisioning failed has none.
 *
 * So this asks again, a bounded number of times, inside the lifetime `waitUntil`
 * guarantees to us.
 *
 * ## The ceiling is real and this does not remove it
 *
 * `waitUntil` is not durable. The runtime keeps the request's event loop alive for
 * a bounded window after the response, and a task that has not finished when that
 * window closes is gone — with no error, no log line, and no record that it ran.
 * That is why `scheduleWalletProvisioning` describes the honest consequence of a
 * loss as "this tenant needs provisioning re-run" rather than "the card will catch
 * up".
 *
 * What a retry changes is the size of the window, not whether it exists: a
 * transient failure has to outlast three attempts spread over about a second and
 * a quarter to be missed here, and the daily sweep picks up whatever this misses.
 * A retry is a cheap first line of defence, and it is described as one on purpose.
 */

/**
 * How many times the signup path asks Google for a class.
 *
 * Three, and the reasoning is about the two failure populations rather than about
 * a round number:
 *
 * - **The blip.** A failed token exchange, a 502 from an edge, a connection reset
 *   on the way out. These clear between one attempt and the next, so the second
 *   attempt is where most of the value is.
 * - **The outage.** Google being unreachable for minutes. No number of attempts
 *   inside one `waitUntil` window fixes that, and a loop without a ceiling would
 *   spend the whole window hammering the dependency it is waiting on — which is
 *   also what turns a slow dependency into an exceeded one.
 *
 * The third attempt is there because the first two are cheap and the window is
 * generous. Past three the marginal attempt is competing for the same budget the
 * sweep needs, and the sweep is the thing that actually closes the gap.
 */
export const WALLET_PROVIDING_ATTEMPTS = 3;

/**
 * Milliseconds to wait before attempt 2 and attempt 3.
 *
 * Growing rather than fixed, for the reason that matters here: the two
 * populations above want opposite treatment. A blip wants a short gap, because the
 * dependency is already back. An outage wants a long one, because asking sooner
 * only adds load to something that is already unwell.
 *
 * Two entries, not `WALLET_PROVIDING_ATTEMPTS - 1` computed at runtime, so the
 * schedule is readable as a number rather than as an expression — and an array
 * that is shorter than the attempt count simply means "no further wait", which
 * costs nothing because the last attempt has nowhere to go.
 *
 * The total is 1250ms. `waitUntil` keeps the invocation alive for roughly 30
 * seconds after the response, so this is a small fraction of the window it runs
 * in, and none of it is on the merchant's response.
 */
export const WALLET_PROVISION_BACKOFF_MS: readonly number[] = [250, 1000];

/**
 * The part of the wallet binding this module uses.
 *
 * Declared here rather than imported so that the leaf that owns the retry does
 * not depend on the app entry that calls it. `WalletWorker` in `index.ts`
 * satisfies it structurally, so there is still one call signature.
 */
export interface ProvisioningBinding {
  provisionClass(input: { tenantId: string }): Promise<unknown>;
}

export interface ProvisionWithRetryDeps {
  binding: ProvisioningBinding;
  /** `tenants.id` — the only tenant this may ever ask about. */
  tenantId: string;
  /**
   * How to wait between attempts. Injected so the backoff can be asserted without
   * a test paying for it in wall clock; the default is the real timer.
   */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Is this outcome a typed failure?
 *
 * `kind` only, so an answer this worker cannot read is not mistaken for one. The
 * distinction matters because the two are handled oppositely: an unreadable answer
 * ends the retry loop, and a read one is judged on `retryable`.
 */
function isFailed(outcome: unknown): outcome is { retryable?: unknown } {
  return isRecord(outcome) && outcome.kind === 'failed';
}

/**
 * Is a typed failure one that asking again cannot change?
 *
 * ## Only an explicit `retryable: true` earns another attempt
 *
 * The wallet knows why it failed; this worker does not. `provisionTenantClass`
 * classifies Google's answer where the answer is — a 4xx says the request is
 * wrong, and the retry sends a byte-identical request — and reports that as
 * `retryable`, so the judgement is made once, next to the error, instead of being
 * re-derived here from a status code this worker does not receive.
 *
 * `!== true` rather than `=== false`, which fails safe. A `failed` outcome that
 * carries no flag — a wallet worker older than it, a shape that changed — is not
 * evidence that the call is worth repeating, and spending Google's write budget on
 * an answer we do not understand is the failure mode a typed contract exists to
 * prevent.
 */
function isPermanentFailure(outcome: { retryable?: unknown }): boolean {
  return outcome.retryable !== true;
}

function describeOutcome(outcome: unknown): string {
  if (isRecord(outcome) && typeof outcome.message === 'string') return outcome.message;
  return String(outcome);
}

/**
 * Ask the wallet to provision this tenant until it succeeds, gives up, or says
 * the answer will not change.
 *
 * Never rejects. The promise this produces is handed to `waitUntil`, where a
 * rejection is attributed to an invocation whose visible result was a 201, and is
 * indistinguishable from a real fault in a log somebody has to triage at 06:00.
 */
export async function provisionClassWithRetry(deps: ProvisionWithRetryDeps): Promise<void> {
  const { binding, tenantId } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= WALLET_PROVIDING_ATTEMPTS; attempt += 1) {
    // Dispatch is guarded separately from the promise it returns. A binding that
    // is present but is not a worker throws here rather than rejecting, and this
    // is called from inside the signup route's own `try` — so an unguarded throw
    // would be reported as a 500 for a request that has already been written.
    //
    // It is not retried either. A throw from the dispatch is a configuration
    // error, and the same call made again raises the same throw.
    let pending: Promise<unknown>;
    try {
      pending = binding.provisionClass({ tenantId });
    } catch (err: unknown) {
      console.error(
        `[identity] Could not reach the wallet to provision tenant ${tenantId}:`,
        err,
      );
      return;
    }

    let outcome: unknown;
    try {
      outcome = await pending;
    } catch (err: unknown) {
      // A rejected call is not an outcome, so nothing can call it permanent. This
      // is the shape a failed token exchange arrives in, and it is the one worth
      // asking about again.
      console.error(
        `[identity] Google Wallet provisioning attempt ${attempt} of ` +
          `${WALLET_PROVIDING_ATTEMPTS} failed for tenant ${tenantId}:`,
        err,
      );
      if (attempt === WALLET_PROVIDING_ATTEMPTS) {
        console.error(
          `[identity] Google Wallet provisioning gave up for tenant ${tenantId} after ` +
            `${WALLET_PROVIDING_ATTEMPTS} attempts; the business is registered and its class ` +
            'has to be re-run.',
        );
        return;
      }
      await sleep(WALLET_PROVISION_BACKOFF_MS[attempt - 1] ?? 0);
      continue;
    }

    // A typed failure, which is the only answer that carries a reason to be here
    // again. Anything else — `created`, `already_exists`, `already_provisioned`, or
    // a shape this worker cannot read — ends the loop, because the work is done or
    // because "we do not know" is not a reason to ask.
    if (isFailed(outcome)) {
      if (isPermanentFailure(outcome)) {
        console.error(
          `[identity] Google Wallet provisioning for tenant ${tenantId} failed in a way another ` +
            `attempt cannot change, so it will not be retried: ${describeOutcome(outcome)}`,
        );
        return;
      }

      console.error(
        `[identity] Google Wallet provisioning attempt ${attempt} of ` +
          `${WALLET_PROVIDING_ATTEMPTS} failed for tenant ${tenantId}: ` +
          `${describeOutcome(outcome)}`,
      );
      if (attempt === WALLET_PROVIDING_ATTEMPTS) {
        console.error(
          `[identity] Google Wallet provisioning gave up for tenant ${tenantId} after ` +
            `${WALLET_PROVIDING_ATTEMPTS} attempts; the business is registered and its class ` +
            'has to be re-run.',
        );
        return;
      }
      await sleep(WALLET_PROVISION_BACKOFF_MS[attempt - 1] ?? 0);
      continue;
    }

    return;
  }
}