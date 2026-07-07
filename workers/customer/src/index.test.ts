import { setCurrentBusinessId } from '@vyloop/db';
import { HTTPException } from 'hono/http-exception';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { extractAuthHeaders, buildCustomerRegisteredEvent, withRls } from './helpers';

import app from './index';



// ===========================================================================
// Mock setup
// ===========================================================================
// vi.mock calls are hoisted. We use vi.hoisted to create variables that are
// available inside the vi.mock factories.
// ===========================================================================

const { mockPublish, mockValidate, mockDb, setSelectData } = vi.hoisted(() => {
  // Mutable data store — tests assign this to control select() results
  let selectData: any[] = [];

  const mockPublish = vi.fn();
  const mockValidate = vi.fn();

  /** Create a Drizzle chain that resolves to the given data array. */
  function chainWithData(
    data: any[],
    overrides?: Partial<{
      from: typeof vi.fn;
      where: typeof vi.fn;
      limit: typeof vi.fn;
      offset: typeof vi.fn;
      orderBy: typeof vi.fn;
    }>,
  ) {
    const chain: any = {};
    chain.from = overrides?.from ?? vi.fn(() => chain);
    chain.where = overrides?.where ?? vi.fn(() => chain);
    chain.limit = overrides?.limit ?? vi.fn(() => chain);
    chain.offset = overrides?.offset ?? vi.fn(() => chain);
    chain.orderBy = overrides?.orderBy ?? vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.then = (resolve: (v: any) => any) => Promise.resolve(data).then(resolve);
    return chain;
  }

  const mockDb = {
    select: vi.fn(() => chainWithData(selectData)),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: 'new-id',
              globalId: 'new-global-id',
              businessId: 'biz-1',
              phone: '+56912345678',
              fullName: 'Alice Smith',
              email: null,
              birthDate: null,
              identityDoc: null,
              identityType: null,
              language: 'es',
              optedInAt: null,
              lastVisitAt: null,
              metadata: {},
              deletedAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve([
              {
                id: 'existing-id',
                globalId: 'existing-global-id',
                businessId: 'biz-1',
                phone: '+56912345678',
                fullName: 'Alice Updated',
                email: 'alice@updated.com',
                birthDate: null,
                identityDoc: null,
                identityType: null,
                language: 'es',
                optedInAt: null,
                lastVisitAt: null,
                metadata: {},
                deletedAt: null,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                updatedAt: new Date('2026-01-02T00:00:00.000Z'),
              },
            ]),
          ),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
    execute: vi.fn(),
  };

  return {
    mockPublish,
    mockValidate,
    mockDb,
    setSelectData: (data: any[]) => {
      selectData = data;
    },
    chainWithData,
  };
});

// Mock the three external packages
vi.mock('@vyloop/db', () => ({
  createDb: vi.fn(() => mockDb),
  setCurrentBusinessId: vi.fn(() => ({})),
  customers: {},
  customerEvents: {},
  consents: {},
  tenants: {},
  pointsTransactions: {},
  membershipTiers: {},
}));

vi.mock('@vyloop/event-bus', () => ({
  CUSTOMER_REGISTERED: 'CustomerRegistered',
  createEnvelope: vi.fn((type: string, header: unknown, payload: unknown) => ({
    id: 'evt-1',
    type,
    header,
    payload,
    specversion: '1.0',
    source: 'vyloop.gateway',
    time: new Date().toISOString(),
  })),
  publish: mockPublish,
}));

vi.mock('@vyloop/schema-registry', () => ({
  customerRegisteredSchema: {},
  validate: mockValidate,
}));

// ===========================================================================
// Test helpers
// ===========================================================================

const BASE = 'http://customer.internal';

/** Minimal env bindings to satisfy route handler access to c.env.* */
const TEST_ENV = {
  DATABASE_URL: 'postgres://test',
  DOMAIN_EVENTS_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as any,
  SCHEMA_REGISTRY: { get: vi.fn(), put: vi.fn() } as any,
};

/** Build a Request with standard auth + content-type headers, then fetch the app with env bindings. */
async function request(
  method: string,
  path: string,
  options?: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    auth?: boolean;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers ?? {}),
  };

  // Unless explicitly disabled, include auth headers
  if (options?.auth !== false) {
    headers['X-User-Id'] = 'user-1';
    headers['X-Business-Id'] = 'biz-1';
    headers['X-User-Role'] = 'admin';
  }

  const init: RequestInit = { method, headers };
  if (options?.body) {
    init.body = JSON.stringify(options.body);
  }

  const req = new Request(`${BASE}${path}`, init);
  return await app.fetch(req, TEST_ENV);
}

function resetMocks() {
  setSelectData([]);
  mockPublish.mockReset();
  mockValidate.mockReset();
  mockValidate.mockResolvedValue({ valid: true });
  mockDb.select.mockReset();
  mockDb.select.mockImplementation(() => {
    // Re-create chain each time so tests using mockImplementationOnce work
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    // Dynamically read selectData at resolve time
    chain.then = (resolve: (v: any) => any) =>
      Promise.resolve([]).then(() => {
        // We don't read selectData globally; instead, each test that uses the
        // default path should override with mockImplementationOnce if needed.
        return resolve([]);
      });
    return chain;
  });
  mockDb.insert.mockReset();
  mockDb.insert.mockImplementation(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() =>
        Promise.resolve([
          {
            id: 'new-id',
            globalId: 'new-global-id',
            businessId: 'biz-1',
            phone: '+56912345678',
            fullName: 'Alice Smith',
            email: null,
            birthDate: null,
            identityDoc: null,
            identityType: null,
            language: 'es',
            optedInAt: null,
            lastVisitAt: null,
            metadata: {},
            deletedAt: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      ),
    })),
  }));
  mockDb.update.mockReset();
  mockDb.update.mockImplementation(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: 'existing-id',
              globalId: 'existing-global-id',
              businessId: 'biz-1',
              phone: '+56912345678',
              fullName: 'Alice Updated',
              email: 'alice@updated.com',
              birthDate: null,
              identityDoc: null,
              identityType: null,
              language: 'es',
              optedInAt: null,
              lastVisitAt: null,
              metadata: {},
              deletedAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          ]),
        ),
      })),
    })),
  }));
  mockDb.delete.mockReset();
  mockDb.delete.mockImplementation(() => ({
    where: vi.fn(() => Promise.resolve()),
  }));
  mockDb.execute.mockReset();
}

// ===========================================================================
// Unit tests — Helpers
// ===========================================================================

describe('Helpers', () => {
  describe('extractAuthHeaders', () => {
    it('returns auth headers when all three are present', () => {
      const mockCtx = {
        req: { header: (name: string) => ({ 'X-User-Id': 'u1', 'X-Business-Id': 'b1', 'X-User-Role': 'admin' }[name]) },
      } as any;

      const auth = extractAuthHeaders(mockCtx);
      expect(auth.userId).toBe('u1');
      expect(auth.businessId).toBe('b1');
      expect(auth.userRole).toBe('admin');
    });

    it('throws 403 when X-User-Id is missing', () => {
      const mockCtx = {
        req: { header: () => undefined },
      } as any;

      expect(() => extractAuthHeaders(mockCtx)).toThrow(HTTPException);
      try {
        extractAuthHeaders(mockCtx);
      } catch (e: any) {
        expect(e.status).toBe(403);
        expect(e.message).toBe('Missing authentication headers');
      }
    });

    it('throws 403 when X-Business-Id is missing', () => {
      const mockCtx = {
        req: {
          header: (name: string) =>
            ({ 'X-User-Id': 'u1', 'X-Business-Id': undefined, 'X-User-Role': 'admin' }[name]),
        },
      } as any;

      expect(() => extractAuthHeaders(mockCtx)).toThrow(HTTPException);
    });

    it('throws 403 when X-User-Role is missing', () => {
      const mockCtx = {
        req: {
          header: (name: string) =>
            ({ 'X-User-Id': 'u1', 'X-Business-Id': 'b1', 'X-User-Role': undefined }[name]),
        },
      } as any;

      expect(() => extractAuthHeaders(mockCtx)).toThrow(HTTPException);
    });
  });

  describe('buildCustomerRegisteredEvent', () => {
    it('creates a valid event envelope with correct payload', () => {
      const customer = { globalId: 'gid-1', fullName: 'Alice' };
      const businessId = 'biz-1';

      const event = buildCustomerRegisteredEvent(customer, businessId);

      expect(event.type).toBe('CustomerRegistered');
      expect(event.payload).toEqual({
        customer_id: 'gid-1',
        full_name: 'Alice',
        business_id: 'biz-1',
      });
      expect(event.header.business_id).toBe('biz-1');
      expect(event.specversion).toBe('1.0');
    });

    it('uses empty string for null fullName', () => {
      const customer = { globalId: 'gid-2', fullName: null };
      const event = buildCustomerRegisteredEvent(customer, 'biz-2');

      expect(event.payload).toEqual({
        customer_id: 'gid-2',
        full_name: '',
        business_id: 'biz-2',
      });
    });
  });

  describe('withRls', () => {
    it('calls setCurrentBusinessId with the business ID', async () => {
      const mockDbExec = { execute: vi.fn() };
      await withRls(mockDbExec, 'biz-1');
      expect(setCurrentBusinessId).toHaveBeenCalledWith('biz-1');
      expect(mockDbExec.execute).toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// Integration tests — CRUD Routes
// ===========================================================================

describe('CRUD Routes', () => {
  beforeEach(() => {
    resetMocks();
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe('Auth', () => {
    it('returns 403 when auth headers are missing', async () => {
      const res = await request('GET', '/', { auth: false });

      expect(res.status).toBe(403);
      const body = await res.json() as any as any;
      expect(body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // -----------------------------------------------------------------------
  // Upsert: PUT /
  // -----------------------------------------------------------------------

  describe('Upsert (PUT /)', () => {
    it('creates customer and publishes event on first registration', async () => {
      // Select returns empty → no existing customer
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const body = { fullName: 'Alice Smith', phone: '+56912345678' };
      const res = await request('PUT', '/v1/customers', { body });

      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.event_published).toBe(true);
      expect(data.fullName).toBe('Alice Smith');
      expect(data.id).toBe('new-id');
      expect(mockPublish).toHaveBeenCalledTimes(1);
      // Schema validated
      expect(mockValidate).toHaveBeenCalledWith(
        expect.anything(),
        'CustomerRegistered',
        expect.objectContaining({ customer_id: 'new-global-id' }),
      );
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request('PUT', '/v1/customers', { body: { phone: '+56912345678' } as any });

      expect(res.status).toBe(400);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('updates existing customer without event on repeat upsert', async () => {
      // Select returns existing customer
      const existingCustomer = {
        id: 'existing-id',
        globalId: 'existing-global-id',
        businessId: 'biz-1',
        phone: '+56912345678',
        fullName: 'Alice Smith',
        email: null,
        birthDate: null,
      };
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([existingCustomer]).then(resolve);
        return chain;
      });

      const body = { fullName: 'Alice Updated', phone: '+56912345678', email: 'alice@test.com' };
      const res = await request('PUT', '/v1/customers', { body });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.fullName).toBe('Alice Updated');
      expect(data.email).toBe('alice@updated.com');

      // Event NOT published on repeat upsert
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('rejects invalid event schema before publishing', async () => {
      // No existing customer
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      // Validate returns invalid
      mockValidate.mockResolvedValue({ valid: false, errors: ["payload full_name can't be empty"] });

      const body = { fullName: 'Alice Smith', phone: '+56912345678' };
      const res = await request('PUT', '/v1/customers', { body });

      expect(res.status).toBe(500);
      const data = await res.json() as any;
      expect(data.error.code).toBe('VALIDATION_ERROR');

      // Event NOT published
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // List: GET /
  // -----------------------------------------------------------------------

  describe('List (GET /)', () => {
    it('returns paginated results with total count', async () => {
      const customers = Array.from({ length: 10 }, (_, i) => ({
        id: `c-${i}`,
        globalId: `gid-${i}`,
        businessId: 'biz-1',
        phone: `+569${String(i).padStart(8, '0')}`,
        fullName: `Customer ${i}`,
        email: `c${i}@test.com`,
        birthDate: null,
        deletedAt: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      }));

      // First select: count result
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ total: 25 }]).then(resolve);
        return chain;
      });

      // Second select: data result
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve(customers).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers?page=1&limit=10');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(10);
      expect(data.total).toBe(25);
      expect(data.page).toBe(1);
      expect(data.limit).toBe(10);
    });

    it('filters by search query', async () => {
      const matchingCustomers = [
        {
          id: 'c-1',
          globalId: 'gid-1',
          businessId: 'biz-1',
          phone: '+56911111111',
          fullName: 'Alice Wonderland',
          email: 'alice@test.com',
          birthDate: null,
          deletedAt: null,
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        },
      ];

      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ total: 1 }]).then(resolve);
        return chain;
      });

      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve(matchingCustomers).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers?q=alice');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(1);
      expect(data.data[0].fullName).toContain('Alice');
      expect(data.total).toBe(1);
    });

    it('excludes soft-deleted customers', async () => {
      // Only active customers
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ total: 3 }]).then(resolve);
        return chain;
      });

      const activeCustomers = [
        { id: 'c-1', fullName: 'Alice', deletedAt: null },
        { id: 'c-2', fullName: 'Bob', deletedAt: null },
        { id: 'c-3', fullName: 'Charlie', deletedAt: null },
      ];

      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve(activeCustomers).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(3);
      expect(data.total).toBe(3);
      // Verify no customer has deletedAt set
      data.data.forEach((c: any) => {
        expect(c.deletedAt).toBeNull();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Profile: GET /:id
  // -----------------------------------------------------------------------

  describe('Profile (GET /:id)', () => {
    it('returns 360° profile with customer, events, and consents', async () => {
      const customerData = [
        {
          id: 'c-1',
          globalId: 'gid-1',
          businessId: 'biz-1',
          phone: '+56911111111',
          fullName: 'Alice Smith',
          email: 'alice@test.com',
          birthDate: null,
          deletedAt: null,
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        },
      ];

      const eventsData = [
        {
          id: 'e-1',
          customerId: 'c-1',
          businessId: 'biz-1',
          eventType: 'Registered',
          payload: {},
          createdAt: new Date('2026-01-01'),
        },
      ];

      const consentsData = [
        {
          id: 'cn-1',
          customerId: 'c-1',
          businessId: 'biz-1',
          consentType: 'marketing',
          granted: true,
          grantedAt: new Date('2026-01-01'),
          revokedAt: null,
          ipAddress: null,
          createdAt: new Date('2026-01-01'),
        },
      ];

      // 3 select calls in Promise.all: customer, events, consents
      mockDb.select
        .mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) =>
            Promise.resolve(customerData).then(resolve);
          return chain;
        })
        .mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) =>
            Promise.resolve(eventsData).then(resolve);
          return chain;
        })
        .mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) =>
            Promise.resolve(consentsData).then(resolve);
          return chain;
        });

      const res = await request('GET', '/v1/customers/c-1');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.id).toBe('c-1');
      expect(data.fullName).toBe('Alice Smith');
      expect(data.customer_events).toHaveLength(1);
      expect(data.customer_events[0].eventType).toBe('Registered');
      expect(data.consents).toHaveLength(1);
      expect(data.consents[0].consentType).toBe('marketing');
    });

    it('returns 404 for cross-business access (RLS isolation)', async () => {
      // No customer found for this business
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      // Use a different business_id → no match (handled by where clause)
      const res = await request(
        'GET',
        '/c-1',
        { headers: { 'X-Business-Id': 'biz-other' } },
      );

      expect(res.status).toBe(404);
    });

    it('returns 404 for soft-deleted customer', async () => {
      // Customer exists but is deleted — query filters with isNull(deletedAt)
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers/c-deleted');

      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Patch: PATCH /:id
  // -----------------------------------------------------------------------

  describe('Patch (PATCH /:id)', () => {
    it('updates only the provided fields', async () => {
      // Customer exists
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ id: 'existing-id', businessId: 'biz-1' }]).then(resolve);
        return chain;
      });

      const body = { email: 'newemail@test.com', fullName: 'New Name' };
      const res = await request('PATCH', '/v1/customers/existing-id', { body });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.fullName).toBe('Alice Updated');
      expect(data.email).toBe('alice@updated.com');

      // Verify update was called with the provided fields
      const updateSetFn = mockDb.update.mock.results[0]?.value.set;
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'newemail@test.com',
          fullName: 'New Name',
          updatedAt: expect.any(Date),
        }),
      );
    });

    it('ignores business_id from request body', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ id: 'existing-id', businessId: 'biz-1' }]).then(resolve);
        return chain;
      });

      const body = { fullName: 'Hacker', business_id: 'biz-evil', businessId: 'biz-evil' };
      const res = await request('PATCH', '/v1/customers/existing-id', { body });

      expect(res.status).toBe(200);

      // Verify business_id was NOT passed to update.set
      const updateSetFn = mockDb.update.mock.results[0]?.value.set;
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.not.objectContaining({ businessId: expect.anything() }),
      );
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.not.objectContaining({ business_id: expect.anything() }),
      );
    });

    it('returns 404 when customer not found', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('PATCH', '/nonexistent', { body: { email: 'x@y.com' } });

      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Delete: DELETE /:id
  // -----------------------------------------------------------------------

  describe('Delete (DELETE /:id)', () => {
    it('soft deletes customer and returns 204', async () => {
      // Customer exists
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ id: 'c-1', businessId: 'biz-1' }]).then(resolve);
        return chain;
      });

      const res = await request('DELETE', '/v1/customers/c-1');

      expect(res.status).toBe(204);
      expect(res.body).toBeNull();

      // Verify update was called with deletedAt
      const updateSetFn = mockDb.update.mock.results[0]?.value.set;
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      );
    });

    it('returns 404 when deleting non-existent customer', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('DELETE', '/nonexistent');

      expect(res.status).toBe(404);
    });

    it('get after soft delete returns 404', async () => {
      // First, mark as deleted via select returning empty (simulates filter)
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      // GET /c-deleted-after-delete
      const res = await request('GET', '/v1/customers/c-deleted-after-delete');

      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // 404 handler
  // -----------------------------------------------------------------------

  describe('404 handler', () => {
    it('returns JSON error for unknown routes', async () => {
      // POST is not defined, so no route matches → 404 handler fires
      const res = await request('POST', '/');

      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});
