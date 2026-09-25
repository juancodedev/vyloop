import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from './api';
import { AuthProvider, useAuth, type LoginResult } from './auth';

// A minimal harness that exposes the real `login` from the real provider, so
// the status-to-reason mapping is proven against a real `apiFetch` throw rather
// than a stubbed auth module.
let latestLogin: ((phone: string, businessSlug?: string) => Promise<LoginResult>) | null = null;

function LoginProbe() {
  const { login } = useAuth();

  useEffect(() => {
    latestLogin = login;
  }, [login]);

  return null;
}

function renderProvider() {
  render(
    <AuthProvider>
      <LoginProbe />
    </AuthProvider>,
  );
}

function createResponse(status: number, body: unknown = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/** An error status whose body is not JSON, as a proxy or crash page returns. */
function createNonJsonResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON at position 0')),
  } as unknown as Response;
}

const TOKEN_RESPONSE = {
  token: 'customer-token',
  customer: { name: 'Ada Lovelace', globalId: 'customer-1' },
  expiresIn: 3600,
};

/** Runs a real `api.loginCustomer` and asserts it rejected with an `ApiError`. */
async function captureApiError(phone: string): Promise<ApiError> {
  const thrown = await api.loginCustomer(phone).then(
    () => null,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(ApiError);

  return thrown as ApiError;
}

async function runLogin(phone: string, businessSlug?: string): Promise<LoginResult> {
  let result: LoginResult | undefined;

  // Fail loudly instead of silently returning undefined. A missing provider is
  // a broken test setup, and letting it through would turn a real regression in
  // the status-to-reason mapping into a green suite.
  expect(latestLogin, 'the AuthProvider must be mounted before calling runLogin').not.toBeNull();

  await act(async () => {
    result = await latestLogin?.(phone, businessSlug);
  });

  return result as LoginResult;
}

describe('login failure classification (real auth + real api client)', () => {
  beforeEach(() => {
    latestLogin = null;
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();
    renderProvider();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('maps a 401 to not_registered', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(401, { error: { code: 'AUTH_TOKEN_INVALID', message: 'Número no registrado' } }),
    );

    await expect(runLogin('+56912345678')).resolves.toEqual({
      ok: false,
      reason: 'not_registered',
    });
    expect(localStorage.getItem('vyloop_jwt')).toBeNull();
    expect(localStorage.getItem('vyloop_customer')).toBeNull();
  });

  it('maps a 401 for a missing phone to not_registered as well', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(401, {
        error: { code: 'AUTH_TOKEN_INVALID', message: 'Missing phone number' },
      }),
    );

    await expect(runLogin('+56912345678')).resolves.toEqual({
      ok: false,
      reason: 'not_registered',
    });
  });

  it('maps a 500 misconfiguration to unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'JWT secret not configured' },
      }),
    );

    await expect(runLogin('+56912345678')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('maps a 503 to unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(503, { error: { code: 'INTERNAL_ERROR', message: 'upstream down' } }),
    );

    await expect(runLogin('+56912345678')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('maps a rejected fetch to unavailable', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(runLogin('+56912345678')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('maps an unexpected 4xx to unknown instead of blaming the user', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(403, { error: { code: 'FORBIDDEN', message: 'Nope' } }),
    );

    await expect(runLogin('+56912345678')).resolves.toEqual({ ok: false, reason: 'unknown' });
  });

  it('writes the session and resolves ok on success', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200, TOKEN_RESPONSE));

    await expect(runLogin('+56912345678', 'barber')).resolves.toEqual({ ok: true });
    expect(localStorage.getItem('vyloop_jwt')).toBe('customer-token');
    expect(JSON.parse(localStorage.getItem('vyloop_customer') as string)).toEqual({
      fullName: 'Ada Lovelace',
      globalId: 'customer-1',
    });

    const [url, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/auth\/customer\/token$/);
    expect(JSON.parse(options.body as string)).toEqual({
      phone: '+56912345678',
      businessSlug: 'barber',
    });
  });

  it('omits the business slug from the payload when there is no context', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(200, TOKEN_RESPONSE));

    await expect(runLogin('+56912345678')).resolves.toEqual({ ok: true });

    const [, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ phone: '+56912345678' });
  });
});

describe('apiFetch error typing', () => {
  beforeEach(() => {
    // This suite calls `runLogin`, so it needs its own provider. Relying on the
    // one mounted by the previous describe made the classification tests
    // order-dependent: a focused run of this block left `latestLogin` null and
    // they resolved undefined without ever exercising the real mapping.
    latestLogin = null;
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();
    renderProvider();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('throws an ApiError carrying the status, code and the unchanged message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      createResponse(401, {
        error: { code: 'AUTH_TOKEN_INVALID', message: 'Número no registrado' },
      }),
    );

    const error = await captureApiError('+56912345678');

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(401);
    expect(error.code).toBe('AUTH_TOKEN_INVALID');
    expect(error.message).toBe('Número no registrado');
  });

  it('falls back to a synthetic code and message when the body has no error shape', async () => {
    vi.mocked(fetch).mockResolvedValue(createResponse(503, {}));

    const error = await captureApiError('+56912345678');

    expect(error.status).toBe(503);
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toBe('Error 503');
  });

  it('keeps the status when an error response is not JSON at all', async () => {
    vi.mocked(fetch).mockResolvedValue(createNonJsonResponse(401));

    const error = await captureApiError('+56912345678');

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toBe('Error 401');
  });

  it('still classifies a non-JSON 401 as not_registered rather than unknown', async () => {
    vi.mocked(fetch).mockResolvedValue(createNonJsonResponse(401));

    await expect(runLogin('+56912345678')).resolves.toEqual({
      ok: false,
      reason: 'not_registered',
    });
  });

  it('still classifies a non-JSON 5xx as unavailable rather than unknown', async () => {
    vi.mocked(fetch).mockResolvedValue(createNonJsonResponse(503));

    await expect(runLogin('+56912345678')).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});
