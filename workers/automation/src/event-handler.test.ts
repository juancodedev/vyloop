import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock — thenable query chain (Drizzle-style)
// ---------------------------------------------------------------------------

function chain<T>(resolveValue?: T) {
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
    then: (fn: (v: unknown) => unknown) =>
      resolveValue !== undefined
        ? Promise.resolve(resolveValue).then(fn)
        : Promise.resolve([]).then(fn),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return c;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const dbMock = {
  select: vi.fn(() => chain()),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  insert: vi.fn(() => chain()),
};

const mockPublish = vi.fn();
const mockCreateEnvelope = vi.fn((type, header, payload) => ({
  id: 'mock-event-id',
  type,
  header,
  payload,
  source: 'test',
  specversion: '1.0',
  time: new Date().toISOString(),
}));

/** The mocked consent store, so a test can decide what the customer agreed to. */
const { readConsentMap } = (await import('@vyloop/db')) as unknown as {
  readConsentMap: ReturnType<typeof vi.fn>;
};

vi.mock('@vyloop/db', () => ({
  createDb: vi.fn(() => dbMock),
  setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
  // The authoritative consent store. The gate reads the customer's consents from
  // here, so the mock is what decides whether a workflow may dispatch.
  readConsentMap: vi.fn(async () => ({ whatsapp: true })),
  customers: {
    id: 'customers',
    businessId: 'business_id',
    globalId: 'global_id',
    phone: 'phone',
    metadata: 'metadata',
    email: 'email',
    fullName: 'full_name',
    birthDate: 'birth_date',
    lastVisitAt: 'last_visit_at',
  },
  workflows: {
    id: 'workflows',
    businessId: 'business_id',
    name: 'name',
    triggerEvent: 'trigger_event',
    conditions: 'conditions',
    actions: 'actions',
    isActive: 'is_active',
  },
}));

vi.mock('@vyloop/event-bus', () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
  createEnvelope: (...args: Parameters<typeof mockCreateEnvelope>) => mockCreateEnvelope(...args),
  WHATSAPP_OUTBOUND_REQUESTED: 'WhatsAppOutboundRequested',
  WORKFLOW_TRIGGERED: 'WorkflowTriggered',
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReturnValue(chain());
});

describe('CustomerRegistered — no matching workflows', () => {
  it('does nothing when no active workflows exist', async () => {
    // No customer found — returns empty
    dbMock.select.mockReturnValue(
      chain({ then: (fn: (v: unknown[]) => unknown) => Promise.resolve([]).then(fn) }),
    );

    const { handleEvent } = await import('./event-handler');
    const event = {
      id: 'evt-1',
      type: 'CustomerRegistered',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: { customer_id: 'global-1', full_name: 'Test User', business_id: 'biz-1' },
    };

    await handleEvent(
      event,
      { ack: vi.fn(), retry: vi.fn() } as never,
      {
        DATABASE_URL: 'postgres://test',
        DOMAIN_EVENTS_QUEUE: {} as never,
        DELIVERY_QUEUE: {} as never,
        SCHEMA_REGISTRY: {} as never,
      } as never,
    );

    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('CustomerRegistered — matching workflow', () => {
  it('calls publish when workflow conditions pass', async () => {
    // Mock customer found
    dbMock.select
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
          id: 'cust-1',
          globalId: 'global-1',
          phone: '56912345678',
          email: 'test@test.com',
          fullName: 'Test User',
          birthDate: '1990-01-01',
          lastVisitAt: null,
              },
            ]).then(fn),
        }),
      )
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
          id: 'wf-1',
          businessId: 'biz-1',
          name: 'Welcome workflow',
          triggerEvent: 'customer_registered',
          conditions: [],
                actions: [
                  { type: 'send_whatsapp', config: { template_name: 'welcome', parameters: [] } },
                ],
          isActive: true,
              },
            ]).then(fn),
        }),
      );

    const { handleEvent } = await import('./event-handler');
    const event = {
      id: 'evt-2',
      type: 'CustomerRegistered',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: { customer_id: 'global-1', full_name: 'Test User', business_id: 'biz-1' },
    };

    await handleEvent(
      event,
      { ack: vi.fn(), retry: vi.fn() } as never,
      {
        DATABASE_URL: 'postgres://test',
        DOMAIN_EVENTS_QUEUE: {} as never,
        DELIVERY_QUEUE: {} as never,
        SCHEMA_REGISTRY: {} as never,
      } as never,
    );

    expect(mockPublish).toHaveBeenCalled();
  });
});

describe('CustomerRegistered — consent', () => {
  /**
   * The gate, and the reason it exists.
   *
   * The registration flow is where a customer says whether they agree to be
   * contacted, and the workflow it usually triggers is the welcome message. A
   * welcome sent to someone who declined is the failure the consent is there to
   * prevent, and this path had no gate at all.
   */
  it('does not publish when the customer has not consented', async () => {
    readConsentMap.mockResolvedValueOnce({});

    dbMock.select
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
                id: 'cust-1',
                globalId: 'global-1',
                phone: '56912345678',
                email: 'test@test.com',
                fullName: 'Test User',
                birthDate: '1990-01-01',
                lastVisitAt: null,
              },
            ]).then(fn),
        }),
      )
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
                id: 'wf-1',
                businessId: 'biz-1',
                name: 'Welcome workflow',
                triggerEvent: 'customer_registered',
                conditions: [],
                actions: [
                  { type: 'send_whatsapp', config: { template_name: 'welcome', parameters: [] } },
                ],
                isActive: true,
              },
            ]).then(fn),
        }),
      );

    const { handleEvent } = await import('./event-handler');
    const event = {
      id: 'evt-3',
      type: 'CustomerRegistered',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: { customer_id: 'global-1', full_name: 'Test User', business_id: 'biz-1' },
    };

    await handleEvent(
      event,
      { ack: vi.fn(), retry: vi.fn() } as never,
      {
        DATABASE_URL: 'postgres://test',
        DOMAIN_EVENTS_QUEUE: {} as never,
        DELIVERY_QUEUE: {} as never,
        SCHEMA_REGISTRY: {} as never,
      } as never,
    );

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not publish when the consent was withdrawn', async () => {
    // A withdrawn consent is not a granted one.
    readConsentMap.mockResolvedValueOnce({ whatsapp: false });

    dbMock.select
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
                id: 'cust-1',
                globalId: 'global-1',
                phone: '56912345678',
                fullName: 'Test User',
              },
            ]).then(fn),
        }),
      )
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
                id: 'wf-1',
                businessId: 'biz-1',
                name: 'Welcome workflow',
                triggerEvent: 'customer_registered',
                conditions: [],
                actions: [
                  { type: 'send_whatsapp', config: { template_name: 'welcome', parameters: [] } },
                ],
                isActive: true,
              },
            ]).then(fn),
        }),
      );

    const { handleEvent } = await import('./event-handler');
    const event = {
      id: 'evt-4',
      type: 'CustomerRegistered',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: { customer_id: 'global-1', full_name: 'Test User', business_id: 'biz-1' },
    };

    await handleEvent(
      event,
      { ack: vi.fn(), retry: vi.fn() } as never,
      {
        DATABASE_URL: 'postgres://test',
        DOMAIN_EVENTS_QUEUE: {} as never,
        DELIVERY_QUEUE: {} as never,
        SCHEMA_REGISTRY: {} as never,
      } as never,
    );

    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('A workflow condition that reads the consent', () => {
  /**
   * The condition field path a workflow author writes.
   *
   * `consent.whatsapp` is resolved against the context, and the context is
   * assembled from the authoritative store. The customer's metadata carries no
   * consent at all in this test, so a condition that still matches proves the
   * answer came from the table and not from the flag that used to live in the
   * metadata.
   */
  it('matches when the store says the customer consented', async () => {
    readConsentMap.mockResolvedValueOnce({ whatsapp: true });

    dbMock.select
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
                id: 'cust-1',
                globalId: 'global-1',
                phone: '56912345678',
                fullName: 'Test User',
                // No consent in the metadata: the store is the only source.
              },
            ]).then(fn),
        }),
      )
      .mockReturnValueOnce(
        chain({
          then: (fn: (v: unknown[]) => unknown) =>
            Promise.resolve([
              {
                id: 'wf-1',
                businessId: 'biz-1',
                name: 'Welcome workflow',
                triggerEvent: 'customer_registered',
                conditions: [{ field: 'consent.whatsapp', operator: 'eq', value: true }],
                actions: [
                  { type: 'send_whatsapp', config: { template_name: 'welcome', parameters: [] } },
                ],
                isActive: true,
              },
            ]).then(fn),
        }),
      );

    const { handleEvent } = await import('./event-handler');
    const event = {
      id: 'evt-5',
      type: 'CustomerRegistered',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: { customer_id: 'global-1', full_name: 'Test User', business_id: 'biz-1' },
    };

    await handleEvent(
      event,
      { ack: vi.fn(), retry: vi.fn() } as never,
      {
        DATABASE_URL: 'postgres://test',
        DOMAIN_EVENTS_QUEUE: {} as never,
        DELIVERY_QUEUE: {} as never,
        SCHEMA_REGISTRY: {} as never,
      } as never,
    );

    expect(mockPublish).toHaveBeenCalled();
  });
});

describe('Unknown event type', () => {
  it('logs and skips unknown events', async () => {
    const { handleEvent } = await import('./event-handler');
    const event = {
      id: 'evt-unknown',
      type: 'UnknownEventType',
      source: 'test',
      specversion: '1.0',
      time: new Date().toISOString(),
      header: { business_id: 'biz-1', timestamp: new Date().toISOString() },
      payload: {},
    };

    await handleEvent(
      event,
      { ack: vi.fn(), retry: vi.fn() } as never,
      {
        DATABASE_URL: 'postgres://test',
        DOMAIN_EVENTS_QUEUE: {} as never,
        DELIVERY_QUEUE: {} as never,
        SCHEMA_REGISTRY: {} as never,
      } as never,
    );

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
