import { PgDialect } from 'drizzle-orm/pg-core';
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

/**
 * Two handles, the way the cron sees the database under row-level security.
 *
 * The outer `db` enumerates `tenants` (exempt from RLS) and nothing else; the
 * transaction handle `txMock` carries every tenant query. `txTenant` is what
 * `set_config` last set on it and `txOpen` says whether a transaction is open,
 * so each query can record the tenant it ran for and each publish can prove it
 * did not happen inside a transaction.
 */
let txTenant: string | null = null;
let txOpen = false;
const tenantQueries: Array<string | null> = [];
let tenantRows: Array<{ id: string }> = [];

const txMock = {
  select: vi.fn(() => chain()),
  execute: vi.fn(),
};

const dbMock = {
  select: vi.fn(),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    txOpen = true;
    txTenant = null;
    try {
      return await fn(txMock);
    } finally {
      txOpen = false;
      txTenant = null;
    }
  }),
  execute: vi.fn(() => {
    throw new Error('a statement reached the outer db instead of a tenant transaction');
  }),
};

/** A keyset page of `tenants`: the rows after the cursor, up to the limit. */
function tenantPage() {
  let after: string | null = null;
  let limit = Infinity;
  const c = {
    from: () => c,
    where: (clause: unknown) => {
      if (clause !== undefined) {
        const params = new PgDialect().sqlToQuery(clause as never).params;
        after = String(params.find((p) => typeof p === 'string'));
      }
      return c;
    },
    orderBy: () => c,
    limit: (n: number) => {
      limit = n;
      return c;
    },
    then: (fn: (v: unknown) => unknown) =>
      Promise.resolve(
        tenantRows.filter((row) => after === null || row.id > after).slice(0, limit),
      ).then(fn),
  };
  return c;
}

const mockPublish = vi.fn((..._args: unknown[]) => {
  if (txOpen) throw new Error('a queue publish ran inside a tenant transaction');
});
const mockCreateEnvelope = vi.fn((type, header, payload) => ({
  id: 'mock-event-id',
  type,
  header,
  payload,
  source: 'test',
  specversion: '1.0',
  time: new Date().toISOString(),
}));

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid } = await import('drizzle-orm/pg-core');
  const actual = await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db');
  return {
    createDb: vi.fn(() => dbMock),
    withTenantTransaction: actual.withTenantTransaction,
    tenants: pgTable('tenants', { id: uuid('id').primaryKey() }),
    // The authoritative consent store. The gate reads the customer's consents from
    // here, so the mock is what decides whether a workflow may dispatch. It must
    // be read on the tenant transaction, like every other tenant query.
    readConsentMap: vi.fn(async (handle: unknown) => {
      if (handle !== txMock) throw new Error('consents were read outside the tenant transaction');
      tenantQueries.push(txTenant);
      return { whatsapp: true };
    }),
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
  };
});

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

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const TENANT_C = '00000000-0000-4000-8000-00000000000c';

const ENV = {
  DATABASE_URL: 'postgres://test',
  SCHEMA_REGISTRY: {} as never,
  DOMAIN_EVENTS_QUEUE: {} as never,
  DELIVERY_QUEUE: {} as never,
} as never;

function birthdayWorkflow(businessId: string) {
  return {
    id: `wf-${businessId}`,
    businessId,
    name: 'Birthday wishes',
    triggerEvent: 'birthday',
    conditions: [],
    actions: [{ type: 'send_whatsapp', config: { template_name: 'birthday_greeting' } }],
    isActive: true,
  };
}

function inactivityWorkflow(businessId: string) {
  return {
    id: `wf-${businessId}`,
    businessId,
    name: 'Re-engagement',
    triggerEvent: 'inactivity',
    conditions: [],
    actions: [{ type: 'send_whatsapp', config: { template_name: 'come_back', inactivity_days: 30 } }],
    isActive: true,
  };
}

function customer(id: string) {
  return { id, globalId: `global-${id}`, fullName: 'Test User', phone: '56912345678' };
}

/** The tenant each published WhatsApp request was for, in order. */
function publishedTenants(): string[] {
  return mockPublish.mock.calls
    .map((call) => call[1] as { type?: string; payload?: { business_id?: string } })
    .filter((event) => event.type === 'WhatsAppOutboundRequested')
    .map((event) => String(event.payload?.business_id));
}

beforeEach(() => {
  vi.clearAllMocks();
  txTenant = null;
  txOpen = false;
  tenantQueries.length = 0;
  tenantRows = [{ id: TENANT_A }];
  dbMock.select.mockImplementation(() => tenantPage());
  txMock.execute.mockImplementation(async (statement: unknown) => {
    const { sql, params } = new PgDialect().sqlToQuery(statement as never);
    if (sql.includes("set_config('app.current_business_id'")) txTenant = String(params[0]);
    return { rows: [] };
  });
  txMock.select.mockImplementation(() => {
    tenantQueries.push(txTenant);
    return chain();
  });
});

/** Queue what the next tenant-transaction selects answer, recording their tenant. */
function queueTenantSelects(...results: unknown[][]) {
  for (const result of results) {
    txMock.select.mockImplementationOnce(() => {
      tenantQueries.push(txTenant);
      return chain(result);
    });
  }
}

describe('Birthday cron handler', () => {
  it('does nothing when no customers have birthday today', async () => {
    const { handleBirthdayCron } = await import('./cron-handler');

    await handleBirthdayCron({
      DATABASE_URL: 'postgres://test',
      SCHEMA_REGISTRY: {} as never,
      DOMAIN_EVENTS_QUEUE: {} as never,
      DELIVERY_QUEUE: {} as never,
    } as never);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('triggers workflows for customers with birthday today', async () => {
    const todayMonth = String(new Date().getMonth() + 1).padStart(2, '0');
    const todayDay = String(new Date().getDate()).padStart(2, '0');

    // The tenant's active birthday workflows, then its customers, both read on
    // the tenant transaction.
    txMock.select
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
      DELIVERY_QUEUE: {} as never,
    } as never);

    expect(mockPublish).toHaveBeenCalled();
  });
});

describe('Inactivity cron handler', () => {
  it('does nothing when no inactive customers exist', async () => {
    const { handleInactivityCron } = await import('./cron-handler');

    await handleInactivityCron({
      DATABASE_URL: 'postgres://test',
      SCHEMA_REGISTRY: {} as never,
      DOMAIN_EVENTS_QUEUE: {} as never,
      DELIVERY_QUEUE: {} as never,
    } as never);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('triggers re-engagement for inactive customers with consent', async () => {
    // The tenant's active inactivity workflows, then its customers, both read on
    // the tenant transaction.
    txMock.select
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
      DELIVERY_QUEUE: {} as never,
    } as never);

    expect(mockPublish).toHaveBeenCalled();
  });
});

describe.each([
  ['handleBirthdayCron', birthdayWorkflow],
  ['handleInactivityCron', inactivityWorkflow],
] as const)('%s, one tenant at a time', (handler, workflow) => {
  async function run() {
    const module = await import('./cron-handler');
    await module[handler](ENV);
  }

  it('enumerates tenants, not workflows, and reads each tenant on a transaction that set it', async () => {
    tenantRows = [{ id: TENANT_A }, { id: TENANT_B }];
    queueTenantSelects([workflow(TENANT_A)], [customer('cust-a')], [workflow(TENANT_B)], [customer('cust-b')]);

    await run();

    // Workflows, customers and consents of each tenant, under that tenant.
    expect(tenantQueries).toEqual([TENANT_A, TENANT_A, TENANT_A, TENANT_B, TENANT_B, TENANT_B]);
    expect(dbMock.transaction).toHaveBeenCalledTimes(2);
    // Nothing ran on the outer handle but the `tenants` page.
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(publishedTenants()).toEqual([TENANT_A, TENANT_B]);
  });

  it('publishes after the tenant transaction has closed, never inside it', async () => {
    queueTenantSelects([workflow(TENANT_A)], [customer('cust-a')]);

    await run();

    // `mockPublish` throws if a transaction is open, so a publish inside one
    // would have been caught and reported instead of sent.
    expect(publishedTenants()).toEqual([TENANT_A]);
  });

  it('reports a failing tenant by id and still processes the next one', async () => {
    tenantRows = [{ id: TENANT_A }, { id: TENANT_B }, { id: TENANT_C }];
    queueTenantSelects([workflow(TENANT_A)], [customer('cust-a')]);
    txMock.select.mockImplementationOnce(() => {
      throw new Error('B is broken');
    });
    queueTenantSelects([workflow(TENANT_C)], [customer('cust-c')]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(run()).resolves.toBeUndefined();
      expect(publishedTenants()).toEqual([TENANT_A, TENANT_C]);
      const errorLines = errors.mock.calls.map((call) => call.map(String).join(' '));
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toContain(TENANT_B);
      const summary = logs.mock.calls.map((call) => call.map(String).join(' ')).at(-1);
      expect(summary).toContain(`failed_tenants=${TENANT_B}`);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it('pages over tenants with a cursor until a short page', async () => {
    tenantRows = Array.from({ length: 101 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }));

    await run();

    expect(dbMock.select).toHaveBeenCalledTimes(2);
    expect(dbMock.transaction).toHaveBeenCalledTimes(101);
  });
});
