import { describe, expect, it } from 'vitest';

import {
  GoogleWalletApiError,
  GoogleWalletClientNotImplementedError,
  createUnimplementedGoogleWalletClient,
} from './google-client';
import type { GoogleWalletClient } from './google-client';

const METHODS = [
  'getClass',
  'insertClass',
  'patchClass',
  'getObject',
  'insertObject',
  'patchObject',
  'saveUriForJwt',
] as const;

describe('GoogleWalletClient', () => {
  it('declares every operation this system needs', () => {
    // The interface has to cover class lifecycle, object lifecycle and the
    // save-URI resolution. A missing method surfaces as a TypeError at the
    // first call, in production, once an issuer account exists.
    const client: GoogleWalletClient = createUnimplementedGoogleWalletClient();
    for (const method of METHODS) {
      expect(typeof client[method]).toBe('function');
    }
  });

  it('rejects every operation loudly rather than resolving', async () => {
    // The failure this file exists to prevent: a stub that returns a resolved
    // promise, so the caller believes the class was created and moves on. A
    // silent no-op is worse than no client at all.
    const client = createUnimplementedGoogleWalletClient();
    const outcomes: Record<string, string> = {};

    for (const method of METHODS) {
      // The methods have different arities, so the union of their signatures
      // cannot be called directly. Every implementation ignores its arguments
      // and must reject regardless.
      const call = client[method] as (...args: unknown[]) => Promise<unknown>;
      try {
        await call('irrelevant');
        outcomes[method] = 'resolved';
      } catch (error) {
        outcomes[method] =
          error instanceof GoogleWalletClientNotImplementedError ? 'rejected' : 'wrong error';
      }
    }

    const expected: Record<string, string> = {};
    for (const method of METHODS) expected[method] = 'rejected';

    expect(outcomes).toEqual(expected);
  });

  it('names the method that is missing, so the log line is actionable', async () => {
    const client = createUnimplementedGoogleWalletClient();
    await expect(client.insertClass({} as never)).rejects.toThrow(/insertClass/);
    await expect(client.saveUriForJwt('jwt')).rejects.toThrow(/saveUriForJwt/);
  });

  it('explains that this is not a Cloudflare binding', async () => {
    // The Google Wallet API runs on Google Cloud at
    // `walletobjects.googleapis.com`, so there is no Workers binding to
    // declare. That is a fact worth stating in the error, because "no binding"
    // is the first thing a reader will look for.
    const client = createUnimplementedGoogleWalletClient();
    await expect(client.getObject('x')).rejects.toThrow(/issuer account|Google Cloud/i);
  });
});

describe('GoogleWalletApiError', () => {
  it('carries the status, the code and the structured reasons', () => {
    // Swallowing the body turns every integration bug into the same opaque 400.
    // Google names the offending field, and that name is the whole diagnosis.
    const error = new GoogleWalletApiError(400, 'wallet_object.invalidId', [
      {
        message: 'Object ID contains invalid characters.',
        reason: 'invalid',
        location: 'id',
      },
    ]);

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(400);
    expect(error.code).toBe('wallet_object.invalidId');
    expect(error.errors).toHaveLength(1);
    expect(error.message).toContain('400');
    expect(error.message).toContain('wallet_object.invalidId');
    expect(error.message).toContain('Object ID contains invalid characters.');
  });

  it('stays readable when Google sends no structured body', () => {
    const error = new GoogleWalletApiError(503, null, []);
    expect(error.message).toBe('Google Wallet API responded 503');
    expect(error.code).toBeNull();
  });

  it('joins multiple reasons', () => {
    const error = new GoogleWalletApiError(400, 'invalid', [
      { message: 'first problem', reason: null, location: null },
      { message: 'second problem', reason: null, location: null },
    ]);
    expect(error.message).toContain('first problem; second problem');
  });
});
