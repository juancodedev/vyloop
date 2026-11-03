/**
 * The last answer `GET /v1/wallet/card` gave this browser, per customer.
 *
 * ## Why it exists
 *
 * Once a customer has a card token, the counter no longer accepts their uuid. If
 * the call that fetches the token fails (no connection at the till, a blip on our side),
 * falling back to the uuid QR would hand them a code that fails silently at the
 * counter. Remembering the last answer lets the QR keep showing the token they
 * already had.
 *
 * A remembered `null` is kept too: it means "legacy customer, the uuid is right",
 * which is what a failed call should then show.
 *
 * Keyed by `globalId`, which is per customer per business, so one browser used at
 * two businesses never mixes their credentials. It is a convenience, not a source
 * of truth: storage can be unavailable or cleared at any time, and every access
 * is wrapped so the QR still renders without it.
 */

const KEY_PREFIX = 'vyloop_card_credential:';

/** The remembered answer: a token, `null` for legacy, or `undefined` when nothing is known. */
export function readCachedCardToken(globalId: string): string | null | undefined {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + globalId);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed === 'string') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedCardToken(globalId: string, token: string | null): void {
  try {
    localStorage.setItem(KEY_PREFIX + globalId, JSON.stringify(token));
  } catch {
    // Storage blocked or full: the QR still works from the live answer.
  }
}
