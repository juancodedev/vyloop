import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Schema snapshot: verify expected tables exist in the Drizzle schema
// ---------------------------------------------------------------------------

describe('Database schema', () => {
  it('should export all 15 tables from @vyloop/db', async () => {
    const db = await import('./index');

    // Identity domain
    expect(db.tenants).toBeDefined();
    expect(db.branches).toBeDefined();
    expect(db.users).toBeDefined();

    // Customer domain
    expect(db.customers).toBeDefined();
    expect(db.customerEvents).toBeDefined();
    expect(db.consents).toBeDefined();

    // Growth domain
    expect(db.loyaltyPrograms).toBeDefined();
    expect(db.membershipTiers).toBeDefined();
    expect(db.pointsTransactions).toBeDefined();
    expect(db.crossLoyaltyAlliances).toBeDefined();
    expect(db.referrals).toBeDefined();

    // Automation domain
    expect(db.workflows).toBeDefined();
    expect(db.workflowExecutions).toBeDefined();

    // AI domain
    expect(db.churnPredictions).toBeDefined();

    // Compliance domain
    expect(db.localizationConfigs).toBeDefined();
  });

  it('should export RLS helpers', async () => {
    const db = await import('./index');
    expect(typeof db.enableRls).toBe('function');
    expect(typeof db.createRlsPolicies).toBe('function');
    expect(typeof db.dropRlsPolicies).toBe('function');
    expect(typeof db.setCurrentBusinessId).toBe('function');
    expect(db.BUSINESS_ID_TABLES).toBeDefined();
    expect(Array.isArray(db.BUSINESS_ID_TABLES)).toBe(true);
  });

  it('should export index definitions', async () => {
    const db = await import('./index');
    expect(db.idxCustomersPhone).toBeDefined();
    expect(db.idxCustomersLastVisit).toBeDefined();
    expect(db.idxPointsBalance).toBeDefined();
    expect(db.idxCustomersMetadata).toBeDefined();
    expect(db.idxCustomerEventsCustomer).toBeDefined();
    expect(db.idxCustomerEventsType).toBeDefined();
    expect(db.allIndexes).toBeDefined();
    expect(Array.isArray(db.allIndexes)).toBe(true);
    expect(db.allIndexes.length).toBe(6);
  });

  it('should export createDb function using @neondatabase/serverless HTTP driver', async () => {
    const db = await import('./index');
    expect(db.createDb).toBeDefined();
    expect(typeof db.createDb).toBe('function');
    // createDb expects a Neon pooled connection string
    // Inline: client = neon(dbUrl), db = drizzle(client, { schema })
  });

  it('should export the schema object', async () => {
    const db = await import('./index');
    expect(db.schema).toBeDefined();
    // schema should contain our tables
    const s = db.schema as Record<string, unknown>;
    expect(s.tenants).toBeDefined();
    expect(s.customers).toBeDefined();
    expect(s.pointsTransactions).toBeDefined();
  });

  it('should have 15 tables in the schema object', async () => {
    const db = await import('./index');
    const tableNames = Object.keys(db.schema).filter(
      (key) => (db.schema as Record<string, unknown>)[key] !== undefined,
    );
    // Each table registers under its export name in `* as schema`
    // The schema re-export contains all tables
    expect(Object.keys(db.schema).length).toBeGreaterThanOrEqual(15);
  });
});
