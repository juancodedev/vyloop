import { describe, expect, it, vi } from 'vitest';

import { attemptDelivery } from './push-delivery';

// ---------------------------------------------------------------------------
// What the push service says, and what it means.
//
// The classification is the part that matters: a service that says "slow down"
// and one that says "this browser is gone" call for opposite things, and
// getting them backwards means either a message that is never retried or a
// subscription that is retried forever.
// ---------------------------------------------------------------------------

function response(status: number): Response {
  return new Response(null, { status });
}

describe('attemptDelivery', () => {
  it('reports a delivery the service accepted', async () => {
    const fetcher = vi.fn(async () => response(201));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1, 2, 3]),
      { Authorization: 'vapid t=x, k=y' },
      fetcher as unknown as typeof fetch,
    );

    expect(attempt).toEqual({ kind: 'delivered' });
  });

  it('reports a registration the service no longer holds', async () => {
    const fetcher = vi.fn(async () => response(410));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt).toEqual({ kind: 'dead' });
  });

  it('reports a request to slow down as retryable', async () => {
    const fetcher = vi.fn(async () => response(429));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt).toEqual({ kind: 'retry' });
  });

  it('reports a rejected VAPID key as terminal', async () => {
    // No number of retries fixes a key that is wrong, so this must not be
    // retried — otherwise the queue retries a message that can never succeed.
    const fetcher = vi.fn(async () => response(401));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt.kind).toBe('terminal');
  });

  it('reports a rejected body as terminal', async () => {
    const fetcher = vi.fn(async () => response(400));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt.kind).toBe('terminal');
  });

  it('sends the encryption headers the push service expects', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response(201));

    await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1, 2, 3]),
      {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '3',
      },
      fetcher as unknown as typeof fetch,
    );

    const [, init] = fetcher.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['Content-Length']).toBe('3');
  });

  it('lets a network failure through, so the queue retries it', async () => {
    // A network error is not the service saying no, and it must not be
    // classified as one.
    const fetcher = vi.fn(async () => {
      throw new Error('connection reset');
    });

    await expect(
      attemptDelivery(
        'https://fcm.googleapis.com/fcm/send/abc',
        new Uint8Array([1]),
        {},
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toThrow('connection reset');
  });
});
