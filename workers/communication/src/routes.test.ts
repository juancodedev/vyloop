import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queue, KVNamespace } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Mock query chain builder
// ---------------------------------------------------------------------------

function createQueryChain<T>(resolveValue: T) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    orderBy: () => chain,
    offset: () => chain,
    select: () => chain,
    values: () => chain,
    set: () => chain,
    returning: vi.fn().mockResolvedValue(
      Array.isArray(resolveValue) ? resolveValue : [resolveValue],
    ),
    then: (onfulfilled: (v: T) => unknown) =>
      Promise.resolve(resolveValue).then(onfulfilled),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return chain;
}

// ---------------------------------------------------------------------------
// DB Mock — include setCurrentBusinessId used by withRls
// ---------------------------------------------------------------------------

const dbMock = {
  insert: vi.fn(() => createQueryChain({ id: 'mock-id' })),
  select: vi.fn(() => createQueryChain([])),
  update: vi.fn(() => createQueryChain([])),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', () => ({
  createDb: vi.fn(() => dbMock),
  setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
  messageLog: 'message_log',
  whatsappTemplates: 'whatsapp_templates',
  customers: 'customers',
}));

vi.mock('@vyloop/event-bus', () => ({
  publish: vi.fn(),
  createEnvelope: vi.fn((type, header, payload) => ({
    id: 'mock-event-id',
    type,
    header,
    payload,
    source: 'test',
    specversion: '1.0',
    time: new Date().toISOString(),
  })),
  WHATSAPP_OUTBOUND_REQUESTED: 'WhatsAppOutboundRequested',
}));

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  DATABASE_URL: 'postgres://test',
  DOMAIN_EVENTS_QUEUE: {} as Queue,
  SCHEMA_REGISTRY: {} as KVNamespace,
  WHATSAPP_PHONE_ID: 'test-phone-id',
  WHATSAPP_TOKEN: 'test-token',
  WHATSAPP_API_VERSION: 'v21.0',
  WHATSAPP_VERIFY_TOKEN: 'test-token',
};

function authHeaders(): Record<string, string> {
  return {
    'X-User-Id': 'user-1',
    'X-Business-Id': 'biz-1',
    'X-User-Role': 'admin',
  };
}

function mockFetch(opts: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<Response> {
  const url = `http://localhost${opts.path}`;
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  return import('./routes').then(({ default: router }) =>
    router.fetch(new Request(url, init), mockEnv),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReturnValue(createQueryChain([]));
  dbMock.insert.mockReturnValue(createQueryChain({ id: 'mock-id' }));
  dbMock.update.mockReturnValue(createQueryChain([]));
  dbMock.execute.mockResolvedValue({ rows: [] });
});

// ============================================================================
// POST /v1/communication/send
// ============================================================================

describe('POST /v1/communication/send', () => {
  it('rejects missing customer_id and template_name with 400', async () => {
    const res = await mockFetch({
      path: '/v1/communication/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: {},
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('required');
  });

  it('rejects 409 if customer has no WhatsApp consent', async () => {
    dbMock.select.mockReturnValue(
      createQueryChain([{ id: 'cust-1', phone: '56912345678', metadata: {} }]),
    );

    const res = await mockFetch({
      path: '/v1/communication/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { customer_id: 'cust-1', template_name: 'welcome' },
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain('consent');
  });

  it('returns 202 on valid send request', async () => {
    dbMock.select
      .mockReturnValueOnce(
        createQueryChain([
          { id: 'cust-1', phone: '56912345678', metadata: { consent: { whatsapp: true } } },
        ]),
      )
      .mockReturnValueOnce(createQueryChain([]));
    dbMock.insert.mockReturnValue(
      createQueryChain([{ id: 'msg-1', status: 'queued', businessId: 'biz-1', customerId: 'cust-1' }]),
    );

    const res = await mockFetch({
      path: '/v1/communication/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { customer_id: 'cust-1', template_name: 'welcome' },
    });

    expect(res.status).toBe(202);
  });
});

// ============================================================================
// GET /v1/communication/templates
// ============================================================================

describe('GET /v1/communication/templates', () => {
  it('returns empty list', async () => {
    dbMock.select
      .mockReturnValueOnce(createQueryChain([{ total: 0 }]))
      .mockReturnValueOnce(createQueryChain([]));

    const res = await mockFetch({
      path: '/v1/communication/templates',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});

// ============================================================================
// POST /v1/communication/templates
// ============================================================================

describe('POST /v1/communication/templates', () => {
  it('creates template with valid input', async () => {
    dbMock.insert.mockReturnValue(
      createQueryChain([{ id: 'tpl-1', name: 'test', language: 'es', category: 'utility', body: 'test body', status: 'pending' }]),
    );

    const res = await mockFetch({
      path: '/v1/communication/templates',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { name: 'test', language: 'es', category: 'utility', body: 'test body' },
    });

    expect(res.status).toBe(201);
  });

  it('rejects missing fields with 400', async () => {
    const res = await mockFetch({
      path: '/v1/communication/templates',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { name: 'test' },
    });

    expect(res.status).toBe(400);
  });
});

// ============================================================================
// GET /v1/communication/history
// ============================================================================

describe('GET /v1/communication/history', () => {
  it('returns empty list', async () => {
    dbMock.select
      .mockReturnValueOnce(createQueryChain([{ total: 0 }]))
      .mockReturnValueOnce(createQueryChain([]));

    const res = await mockFetch({
      path: '/v1/communication/history',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});

// ============================================================================
// GET /webhook — Meta verification
// ============================================================================

describe('GET /webhook — Meta verification', () => {
  it('returns challenge when verify_token matches', async () => {
    const res = await mockFetch({
      path: '/webhook?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=12345',
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('12345');
  });

  it('returns 403 when verify_token does not match', async () => {
    const res = await mockFetch({
      path: '/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=12345',
    });

    expect(res.status).toBe(403);
  });
});

// ============================================================================
// POST /webhook — Meta callbacks
// ============================================================================

describe('POST /webhook — Meta callbacks', () => {
  it('returns 200 OK on empty webhook payload', async () => {
    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {},
    });

    expect(res.status).toBe(200);
  });

  it('returns 200 on status callback and updates message status', async () => {
    dbMock.select.mockReturnValue(
      createQueryChain([{ id: 'cust-1', businessId: 'biz-1' }]),
    );

    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: '123' },
              statuses: [{
                id: 'wamid-abc123',
                status: 'delivered',
                timestamp: String(Math.floor(Date.now() / 1000)),
              }],
            },
          }],
        }],
      },
    });

    expect(res.status).toBe(200);
    expect(dbMock.update).toHaveBeenCalled();
  });

  it('returns 200 on inbound message and inserts it', async () => {
    dbMock.select.mockReturnValue(
      createQueryChain([{ id: 'cust-1', businessId: 'biz-1' }]),
    );

    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: '123' },
              messages: [{
                from: '56912345678',
                id: 'wamid-incoming',
                text: { body: 'Hello!' },
                type: 'text',
                timestamp: String(Math.floor(Date.now() / 1000)),
              }],
            },
          }],
        }],
      },
    });

    expect(res.status).toBe(200);
    expect(dbMock.insert).toHaveBeenCalled();
  });

  it('skips inbound message from unknown phone', async () => {
    // No customer found for this phone
    dbMock.select.mockReturnValue(createQueryChain([]));

    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: '123' },
              messages: [{
                from: '56999999999',
                id: 'wamid-unknown',
                text: { body: 'Who dis?' },
                type: 'text',
                timestamp: String(Math.floor(Date.now() / 1000)),
              }],
            },
          }],
        }],
      },
    });

    expect(res.status).toBe(200);
    // Should NOT have inserted because customer not found
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
