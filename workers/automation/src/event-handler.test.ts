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
      resolveValue !== undefined ? Promise.resolve(resolveValue).then(fn) : Promise.resolve([]).then(fn),
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

vi.mock('@vyloop/db', () => ({
  createDb: vi.fn(() => dbMock),
  setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
  customers: { id: 'customers', businessId: 'business_id', globalId: 'global_id', phone: 'phone', metadata: 'metadata', email: 'email', fullName: 'full_name', birthDate: 'birth_date', lastVisitAt: 'last_visit_at' },
  workflows: { id: 'workflows', businessId: 'business_id', name: 'name', triggerEvent: 'trigger_event', conditions: 'conditions', actions: 'actions', isActive: 'is_active' },
}));

vi.mock('@vyloop/event-bus', () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
  createEnvelope: (...args: unknown[]) => mockCreateEnvelope(...args),
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
      { DATABASE_URL: 'postgres://test', DOMAIN_EVENTS_QUEUE: {} as never, SCHEMA_REGISTRY: {} as never } as never,
    );

    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('CustomerRegistered — matching workflow', () => {
  it('calls publish when workflow conditions pass', async () => {
    // Mock customer found
    dbMock.select
      .mockReturnValueOnce(
        chain({ then: (fn: (v: unknown[]) => unknown) => Promise.resolve([{
          id: 'cust-1',
          globalId: 'global-1',
          phone: '56912345678',
          email: 'test@test.com',
          fullName: 'Test User',
          birthDate: '1990-01-01',
          lastVisitAt: null,
          metadata: { consent: { whatsapp: true } },
        }]).then(fn) }),
      )
      .mockReturnValueOnce(
        chain({ then: (fn: (v: unknown[]) => unknown) => Promise.resolve([{
          id: 'wf-1',
          businessId: 'biz-1',
          name: 'Welcome workflow',
          triggerEvent: 'customer_registered',
          conditions: [],
          actions: [{ type: 'send_whatsapp', config: { template_name: 'welcome', parameters: [] } }],
          isActive: true,
        }]).then(fn) }),
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
      { DATABASE_URL: 'postgres://test', DOMAIN_EVENTS_QUEUE: {} as never, SCHEMA_REGISTRY: {} as never } as never,
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
      { DATABASE_URL: 'postgres://test', DOMAIN_EVENTS_QUEUE: {} as never, SCHEMA_REGISTRY: {} as never } as never,
    );

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
