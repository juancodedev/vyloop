import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock — thenable query chain (Drizzle-style)
// ---------------------------------------------------------------------------

function chain<T>(resolveValue?: T) {
  const val: unknown = resolveValue !== undefined ? resolveValue : [];
  const c = {
    from: () => c,
    where: () => c,
    limit: () => c,
    orderBy: () => c,
    offset: () => c,
    select: () => c,
    values: () => c,
    set: vi.fn(() => c),
    returning: vi.fn().mockResolvedValue([]),
    then: (fn: (v: unknown) => unknown) => Promise.resolve(val).then(fn),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return c;
}

// ---------------------------------------------------------------------------
// DB Mock
// ---------------------------------------------------------------------------

const dbMock = {
  insert: vi.fn(() => chain()),
  select: vi.fn(() => chain()),
  update: vi.fn(() => chain()),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', () => ({
  createDb: vi.fn(() => dbMock),
  setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
  messageLog: 'message_log',
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
  DOMAIN_EVENTS_QUEUE: {} as unknown,
  SCHEMA_REGISTRY: {} as unknown,
  WHATSAPP_PHONE_ID: 'test-phone-id',
  WHATSAPP_TOKEN: 'test-token',
  WHATSAPP_API_VERSION: 'v21.0',
  WHATSAPP_VERIFY_TOKEN: 'test-token',
};

function mockMsg() {
  return { ack: vi.fn(), retry: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Queue cycle: published event → queue → handler → Meta API → status update', () => {
  it('processes a full message queue cycle end-to-end', async () => {
    const eventEnvelope = {
      id: 'evt-queue-1',
      type: 'WhatsAppOutboundRequested',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: {
        customer_id: 'cust-1',
        business_id: 'biz-1',
        template_name: 'welcome',
        parameters: { name: 'Juan' },
        idempotency_key: 'msg-001',
        phone: '56912345678',
      },
    };

    // Mock select to find queued message
    dbMock.select.mockReturnValue(
      chain([{ id: 'msg-001', status: 'queued', businessId: 'biz-1', metadata: {} }]),
    );

    // Mock Meta API
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: 'wamid-abc123' }] }),
    } as Response);

    const { handleEvent } = await import('./event-handler');
    await handleEvent(eventEnvelope, mockMsg() as never, mockEnv as never);

    // Verify the full chain
    expect(dbMock.select).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalled();

    const fetchUrl = vi.mocked(global.fetch).mock.calls[0]?.[0];
    expect(fetchUrl).toContain('graph.facebook.com');

    // Verify DB update with status='sent'
    expect(dbMock.update).toHaveBeenCalled();
    const updater = dbMock.update.mock.results[0]?.value;
    expect(updater?.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent' }),
    );
  });

  it('handles rate limiting (429) by rejecting so queue retries', async () => {
    const eventEnvelope = {
      id: 'evt-queue-2',
      type: 'WhatsAppOutboundRequested',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: {
        customer_id: 'cust-1',
        business_id: 'biz-1',
        template_name: 'welcome',
        parameters: {},
        idempotency_key: 'msg-002',
        phone: '56912345678',
      },
    };

    dbMock.select.mockReturnValue(
      chain([{ id: 'msg-002', status: 'queued', businessId: 'biz-1', metadata: {} }]),
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: { code: 429, message: 'Too many requests' } }),
    } as Response);

    const { handleEvent } = await import('./event-handler');
    await expect(
      handleEvent(eventEnvelope, mockMsg() as never, mockEnv as never),
    ).rejects.toThrow();
  });
});
