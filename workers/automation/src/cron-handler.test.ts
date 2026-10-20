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
// Mocks
// ---------------------------------------------------------------------------

const dbMock = {
  select: vi.fn(() => chain()),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
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
  // The authoritative consent store. The gate reads the customer's consents from
  // here, so the mock is what decides whether a workflow may dispatch.
  readConsentMap: vi.fn(async () => ({ whatsapp: true })),
  customers: {
    id: 'customers',
    businessId: 'business_id',
    globalId: 'global_id',
    fullName: 'full_name',
    phone: 'phone',
    email: 'email',
    birthDate: 'birth_date',
    lastVisitAt: 'last_visit_at',
    metadata: 'metadata',
    createdAt: 'created_at',
  },
  workflows: {
    id: 'workflows',
    businessId: 'business_id',
    name: 'name',
    triggerEvent: 'trigger_event',
    conditions: 'conditions',
    actions: 'actions',
    isActive: 'is_active',
    config: 'config',
  },
}));

vi.mock('@vyloop/event-bus', () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
  createEnvelope: (...args: Parameters<typeof mockCreateEnvelope>) => mockCreateEnvelope(...args),
  WHATSAPP_OUTBOUND_REQUESTED: 'WhatsAppOutboundRequested',
  WORKFLOW_TRIGGERED: 'WorkflowTriggered',
  CUSTOMER_REGISTERED: 'CustomerRegistered',
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReturnValue(chain());
});

describe('Birthday cron handler', () => {
  it('does nothing when no customers have birthday today', async () => {
    dbMock.select.mockReturnValue(chain());

    const { handleBirthdayCron } = await import('./cron-handler');

    await handleBirthdayCron({
      DATABASE_URL: 'postgres://test',
      SCHEMA_REGISTRY: {} as never,
      DOMAIN_EVENTS_QUEUE: {} as never,
    } as never);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('triggers workflows for customers with birthday today', async () => {
    const todayMonth = String(new Date().getMonth() + 1).padStart(2, '0');
    const todayDay = String(new Date().getDate()).padStart(2, '0');

    // First call: db.execute() returns business IDs
    dbMock.execute.mockResolvedValue({
      rows: [{ business_id: 'biz-1' }],
    });

    // Second call: db.select().from(workflows) returns active birthday workflows
    dbMock.select
      .mockReturnValueOnce(
        chain([
          {
          id: 'wf-1',
          businessId: 'biz-1',
          name: 'Birthday wishes',
          triggerEvent: 'birthday',
          conditions: [],
          actions: [{ type: 'send_whatsapp', config: { template_name: 'birthday_greeting' } }],
          isActive: true,
          config: { timezone: 'America/Santiago' },
          },
        ]),
      )
      // Third call: db.select().from(customers) returns customer with birthday today
      .mockReturnValueOnce(
        chain([
          {
          id: 'cust-1',
          globalId: 'global-1',
          fullName: 'Test User',
          phone: '56912345678',
          email: 'test@test.com',
          birthDate: `${todayMonth}-${todayDay}`,

          createdAt: '2024-01-01',
          },
        ]),
      );

    const { handleBirthdayCron } = await import('./cron-handler');

    await handleBirthdayCron({
      DATABASE_URL: 'postgres://test',
      SCHEMA_REGISTRY: {} as never,
      DOMAIN_EVENTS_QUEUE: {} as never,
    } as never);

    expect(mockPublish).toHaveBeenCalled();
  });
});

describe('Inactivity cron handler', () => {
  it('does nothing when no inactive customers exist', async () => {
    dbMock.select.mockReturnValue(chain());

    const { handleInactivityCron } = await import('./cron-handler');

    await handleInactivityCron({
      DATABASE_URL: 'postgres://test',
      SCHEMA_REGISTRY: {} as never,
      DOMAIN_EVENTS_QUEUE: {} as never,
    } as never);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('triggers re-engagement for inactive customers with consent', async () => {
    // First call: db.execute() returns business IDs
    dbMock.execute.mockResolvedValue({
      rows: [{ business_id: 'biz-1' }],
    });

    // Second call: db.select().from(workflows) returns active inactivity workflows
    dbMock.select
      .mockReturnValueOnce(
        chain([
          {
          id: 'wf-2',
          businessId: 'biz-1',
          name: 'Re-engagement',
          triggerEvent: 'inactivity',
          conditions: [],
            actions: [
              {
                type: 'send_whatsapp',
                config: { template_name: 'come_back', inactivity_days: 30 },
              },
            ],
          isActive: true,
          },
        ]),
      )
      // Third call: db.select().from(customers) returns inactive customer
      .mockReturnValueOnce(
        chain([
          {
          id: 'cust-1',
          globalId: 'global-1',
          fullName: 'Inactive User',
          phone: '56912345678',
          email: 'inactive@test.com',
          lastVisitAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),

          createdAt: '2024-01-01',
          },
        ]),
      );

    const { handleInactivityCron } = await import('./cron-handler');

    await handleInactivityCron({
      DATABASE_URL: 'postgres://test',
      SCHEMA_REGISTRY: {} as never,
      DOMAIN_EVENTS_QUEUE: {} as never,
    } as never);

    expect(mockPublish).toHaveBeenCalled();
  });
});
