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

const handlePushCampaignRequested = vi.hoisted(() =>
  vi.fn(async () => ({ audience: 2, delivered: 2, failed: 0, skipped: 0 })),
);

vi.mock('./push-campaigns', () => ({ handlePushCampaignRequested }));

// ---------------------------------------------------------------------------
// Mock queue message
// ---------------------------------------------------------------------------

function mockMsg() {
  return { ack: vi.fn(), retry: vi.fn() };
}

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  DATABASE_URL: 'postgres://test',
  DELIVERY_QUEUE: {} as unknown,
  SCHEMA_REGISTRY: {} as unknown,
  WHATSAPP_PHONE_ID: 'test-phone-id',
  WHATSAPP_TOKEN: 'test-token',
  WHATSAPP_API_VERSION: 'v21.0',
  WHATSAPP_VERIFY_TOKEN: 'test-token',
};

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
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
      idempotency_key: 'msg-1',
      phone: '56912345678',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleWhatsAppOutboundRequested', () => {
  it('updates status to sent on successful Meta API call', async () => {
    // Mock select to find queued message
    dbMock.select.mockReturnValue(
      chain([{ id: 'msg-1', status: 'queued', businessId: 'biz-1', metadata: {} }]),
    );

    // Mock successful Meta API response
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: 'wamid-123' }] }),
    } as Response);

    const { handleEvent } = await import('./event-handler');
    await handleEvent(makeEvent(), mockMsg() as never, mockEnv as never);

    // Should have updated status to sent
    expect(dbMock.update).toHaveBeenCalled();
    const updater = dbMock.update.mock.results[0]?.value;
    expect(updater?.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent' }),
    );
  });

  it('leaves status as queued on retryable error (429)', async () => {
    dbMock.select.mockReturnValue(
      chain([{ id: 'msg-1', status: 'queued', businessId: 'biz-1', metadata: {} }]),
    );

    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: { code: 429, message: 'Rate limited' } }),
    } as Response);

    const { handleEvent } = await import('./event-handler');

    await expect(
      handleEvent(makeEvent(), mockMsg() as never, mockEnv as never),
    ).rejects.toThrow();
  });

  it('marks as failed on non-retryable 4xx error', async () => {
    dbMock.select.mockReturnValue(
      chain([{ id: 'msg-1', status: 'queued', businessId: 'biz-1', metadata: {} }]),
    );

    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { code: 400, message: 'Invalid template' } }),
    } as Response);

    const { handleEvent } = await import('./event-handler');
    await handleEvent(makeEvent(), mockMsg() as never, mockEnv as never);

    // Should have set status to failed
    expect(dbMock.update).toHaveBeenCalled();
    const updater = dbMock.update.mock.results[0]?.value;
    expect(updater?.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('skips message that is already sent (idempotent)', async () => {
    dbMock.select.mockReturnValue(
      chain([{ id: 'msg-1', status: 'sent', businessId: 'biz-1', metadata: {} }]),
    );

    const { handleEvent } = await import('./event-handler');
    await handleEvent(makeEvent(), mockMsg() as never, mockEnv as never);

    // Should NOT have called update or fetch
    expect(dbMock.update).not.toHaveBeenCalled();
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });
});

describe('Unhandled event type', () => {
  it('acks unknown events without error', async () => {
    const { handleEvent } = await import('./event-handler');
    const event = makeEvent({ type: 'SomeUnknownEvent' });

    await handleEvent(event, mockMsg() as never, mockEnv as never);
  });
});

describe('PushCampaignRequested', () => {
  it('delivers the campaign for the tenant named in the envelope header', async () => {
    const { handleEvent } = await import('./event-handler');
    const payload = {
      business_id: 'biz-1',
      title: 'Hi',
      body: 'Come by',
      reference_id: 'camp-1',
      target: { branch_id: 'branch-1' },
    };
    const event = makeEvent({ type: 'PushCampaignRequested', payload });

    await handleEvent(event, mockMsg() as never, mockEnv as never);

    expect(handlePushCampaignRequested).toHaveBeenCalledTimes(1);
    expect(handlePushCampaignRequested).toHaveBeenCalledWith(payload, 'biz-1', mockEnv);
  });

  it('lets a delivery failure reach the queue, so the batch retries it', async () => {
    const { handleEvent } = await import('./event-handler');
    handlePushCampaignRequested.mockRejectedValueOnce(new Error('429'));
    const event = makeEvent({ type: 'PushCampaignRequested', payload: { target: { branch_id: 'b' } } });

    await expect(handleEvent(event, mockMsg() as never, mockEnv as never)).rejects.toThrow('429');
  });
});

describe('CustomerCheckedIn', () => {
  it('is acked without sending anything', async () => {
    const { handleEvent } = await import('./event-handler');
    const event = makeEvent({ type: 'CustomerCheckedIn', payload: { branch_id: 'branch-1' } });

    await handleEvent(event, mockMsg() as never, mockEnv as never);

    expect(handlePushCampaignRequested).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
