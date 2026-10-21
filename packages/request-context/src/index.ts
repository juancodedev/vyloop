import type { Context, Next } from 'hono';

/**
 * The header that carries the correlation id from the gateway to the workers,
 * to the queue handlers, and back to the client.
 *
 * `X-Request-Id` is the de-facto name for a correlation id and what an operator
 * will `wrangler tail --search` for. It is not a tracing standard: there is no
 * `traceparent` here, no spans and no sampler. The id is a key to correlate log
 * lines, and choosing a plain header leaves the door open to adopting
 * `traceparent` later without changing this one.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * The shape of a request id that is safe to propagate.
 *
 * The id lands in `console.*` output and in a response header, so a value with a
 * newline, a space or an `=` could reshape a log line or forge a `key=value`
 * pair. 8..128 characters of `[A-Za-z0-9._-]` accepts a UUID and a hex string,
 * and refuses everything that could inject structure into a log entry.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** True when `value` is a request id this package is willing to propagate. */
export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/**
 * The id to use for a request: the client's when it is well-formed, a new UUID
 * otherwise.
 *
 * A malformed id is replaced, never repaired. Trimming or escaping it would keep
 * a value the client chose while pretending it was accepted, and the result
 * would look like a valid id that no log line actually contains.
 */
export function resolveRequestId(value: string | null | undefined): string {
  return isValidRequestId(value) ? value : crypto.randomUUID();
}

/**
 * The log prefix every service writes: `[growth] request_id=<id>`.
 *
 * This is a prefix, not a log format. `console.error(`${logPrefix('growth', id)} failed`, err)`
 * produces both halves of the search an operator runs, and a service that has
 * not adopted it yet still writes a readable line.
 */
export function logPrefix(service: string, requestId: string): string {
  return `[${service}] request_id=${requestId}`;
}

/**
 * Read the id the middleware set on the context.
 *
 * The fallback exists for a route that is mounted without the middleware (a unit
 * test, or a new app that forgot it). It is a UUID rather than an empty string so
 * a missing middleware produces a log line that is still correlated with itself;
 * the contract test in this package fails a worker that forgets to register it.
 */
export function getRequestId(c: Context): string {
  return (c.get('requestId') as string | undefined) ?? crypto.randomUUID();
}

/**
 * Establish one id per inbound request, forward it and echo it.
 *
 * Register it **first**, before CORS and before auth: the id has to exist before
 * anything can fail, so that an error raised by any middleware below it already
 * has an id to answer with.
 *
 * The forwarded request is rewritten rather than appended to, so a malformed
 * client id cannot survive in the request the worker receives. That is the same
 * `new Request(req, { headers })` technique `auth-inject.ts` uses, for the same
 * reason: downstream code reads `c.req.raw`.
 *
 * The response header is set in a `finally`, so it is present on the success
 * path and on the path where a handler throws and `onError` composes the answer.
 */
export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set('requestId', requestId);

    const headers = new Headers(c.req.raw.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    c.req.raw = new Request(c.req.raw, { headers });

    try {
      await next();
    } finally {
      c.header(REQUEST_ID_HEADER, requestId);
    }
  };
}
