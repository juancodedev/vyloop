// @vitest-environment node

/**
 * `api.updateCustomer` sends the patch and nothing else.
 *
 * The dashboard had no method for `PATCH /v1/customers/:id` at all — the route
 * predated the only caller that would have noticed anything wrong with it. That
 * is the same gap that kept a hardcoded QR slug alive until a merchant outside
 * the issuing tenant saw it, so the method comes with a guard attached.
 *
 * The guard is on the wire format, because that is where the silent failure
 * lives. A client that sent `full_name` would get a 200 and a customer whose
 * name never changed; nothing here can catch that by looking at the return value
 * alone, so it reads the serialised body.
 */

import { CUSTOMER_PATCH_ERROR, CUSTOMER_PATCHABLE_FIELDS } from '@vyloop/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '../lib/api';

const UPDATABLE = 'a0000000-0000-4000-8000-000000000001';

const ORIGINAL_FETCH = globalThis.fetch;

/** The parsed request body of the single call that was made. */
function sentBody(): Record<string, unknown> {
  const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

describe('api.updateCustomer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ id: UPDATABLE, fullName: 'Ana Ruiz Soto' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
  });

  afterEach(() => {
    vi.stubGlobal('fetch', ORIGINAL_FETCH);
  });

  it('PATCHes the customer resource', async () => {
    await api.updateCustomer(UPDATABLE, { fullName: 'Ana Ruiz Soto' });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain(`/v1/customers/${UPDATABLE}`);
    expect(init?.method).toBe('PATCH');
  });

  it('sends exactly the fields it was given', async () => {
    await api.updateCustomer(UPDATABLE, { fullName: 'Ana Ruiz Soto', phone: '+56999998888' });

    expect(Object.keys(sentBody()).sort()).toEqual(['fullName', 'phone']);
  });

  it('adds no field of its own, so the payload is exactly the allowlist subset', async () => {
    await api.updateCustomer(UPDATABLE, { email: 'ana.soto@test.com' });

    const body = sentBody();
    expect(Object.keys(body)).toEqual(['email']);
    for (const key of Object.keys(body)) {
      expect(CUSTOMER_PATCHABLE_FIELDS as readonly string[]).toContain(key);
    }
  });

  it('never turns an absent field into null', async () => {
    // The whole point of a partial PATCH: editing the phone must not empty the
    // email, and a client that filled the gaps in would do exactly that.
    await api.updateCustomer(UPDATABLE, { phone: '+56999998888' });

    expect(sentBody()).not.toHaveProperty('email');
    expect(sentBody()).not.toHaveProperty('birthDate');
  });

  it('carries a cleared field as null', async () => {
    await api.updateCustomer(UPDATABLE, { email: null });

    expect(sentBody()).toEqual({ email: null });
  });

  it('sends the tenant nowhere: it comes from the token', async () => {
    await api.updateCustomer(UPDATABLE, { fullName: 'Ana' });

    expect(sentBody()).not.toHaveProperty('businessId');
    expect(sentBody()).not.toHaveProperty('business_id');
  });

  it('hands the caller the code, so a conflict can be shown beside its input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: CUSTOMER_PATCH_ERROR.PHONE_TAKEN,
            message: 'Another customer in this business already uses this phone number.',
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    ));

    // Not a rejected promise with the server's prose attached: the form has to be
    // able to tell a taken phone from a taken email, and the message alone
    // cannot.
    await expect(api.updateCustomer(UPDATABLE, { phone: '+56999998888' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(
      api.updateCustomer(UPDATABLE, { phone: '+56999998888' }).catch((e: ApiError) => e.code),
    ).resolves.toBe(CUSTOMER_PATCH_ERROR.PHONE_TAKEN);
  });

  it('does not retry a rejected edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: CUSTOMER_PATCH_ERROR.EMAIL_TAKEN, message: 'taken' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    ));

    await api.updateCustomer(UPDATABLE, { email: 'taken@elsewhere.com' }).catch(() => undefined);

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('refuses a field it is not allowed to send, instead of dropping it', async () => {
    // The type forbids this and a caller will find a way. Silently filtering it
    // out is the exact behaviour the server just stopped having.
    await expect(
      api.updateCustomer(UPDATABLE, { globalId: 'x' } as unknown as Record<string, never>),
    ).rejects.toBeInstanceOf(ApiError);

    // Nothing went out, so nothing is left half-saved.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
