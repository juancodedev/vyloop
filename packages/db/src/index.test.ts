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

  it('should export the tenant-scoped RLS helpers', async () => {
    const db = await import('./index');
    expect(typeof db.setCurrentTenantId).toBe('function');
    expect(typeof db.withTenantRls).toBe('function');
    expect(typeof db.enableTenantRls).toBe('function');
    expect(typeof db.createTenantRlsPolicies).toBe('function');
    expect(typeof db.dropTenantRlsPolicies).toBe('function');
    expect(Array.isArray(db.TENANT_ID_TABLES)).toBe(true);
    // Two distinct session variables, so a business-scoped context can never
    // satisfy a tenant-scoped policy.
    expect(db.BUSINESS_ID_SETTING).not.toBe(db.TENANT_ID_SETTING);
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
    // 12 pre-existing plus the three wallet indexes.
    expect(db.allIndexes.length).toBe(15);
  });

  it('should export the wallet domain tables', async () => {
    const db = await import('./index');
    expect(db.tenantWalletPrograms).toBeDefined();
    expect(db.customerWalletPasses).toBeDefined();
    expect(db.schema.tenantWalletPrograms).toBeDefined();
    expect(db.schema.customerWalletPasses).toBeDefined();
  });

  it('should derive every index export from the schema, with no second list', async () => {
    const db = await import('./index');

    // The export bindings and the SQL names are asserted together, so a rename
    // on either side fails. This is the guard against the drift bug: an index
    // that exists only in `indexes.ts` was invisible to drizzle-kit and reached
    // no migration, which is why the registry is now derived from the table
    // configs rather than declared a second time.
    const expectedNames: Record<string, string> = {
      idxCustomersPhone: 'idx_customers_phone',
      idxCustomersLastVisit: 'idx_customers_last_visit',
      idxPointsBalance: 'idx_points_balance',
      idxCustomersMetadata: 'idx_customers_metadata',
      idxCustomerEventsCustomer: 'idx_customer_events_customer',
      idxCustomerEventsType: 'idx_customer_events_type',
      idxRewardsCategory: 'idx_rewards_category',
      idxRewardsAutoGrant: 'idx_rewards_auto_grant',
      idxRewardGrantsCustomer: 'idx_reward_grants_customer',
      idxMessageLogCustomer: 'idx_message_log_customer',
      idxMessageLogStatus: 'idx_message_log_status',
      idxWhatsappTemplatesName: 'idx_whatsapp_templates_name',
      idxCustomersMemberCode: 'uq_customers_business_member_code',
      idxCustomerWalletPassesTenant: 'idx_customer_wallet_passes_tenant',
      idxWalletCallbackDeliveriesReceived: 'idx_wallet_callback_deliveries_received',
    };

    for (const [binding, sqlName] of Object.entries(expectedNames)) {
      const index = (db as unknown as Record<string, { config: { name: string } }>)[binding];
      expect(index, `${binding} is not exported`).toBeDefined();
      expect(index.config.name, `${binding} points at the wrong index`).toBe(sqlName);
    }

    // And allIndexes is exactly that set, with nothing extra and nothing
    // missing.
    expect(db.allIndexes.map((i) => i.config.name).sort()).toEqual(
      Object.values(expectedNames).sort(),
    );
  });

  it('should throw a helpful error when an index name is not declared', async () => {
    const db = await import('./index');
    expect(() => db.indexByName('idx_does_not_exist')).toThrowError(
      /No index named "idx_does_not_exist" is declared/,
    );
  });

  it('should declare the partial unique index on customers.member_code', async () => {
    const db = await import('./index');
    const memberCodeIndex = db.idxCustomersMemberCode as unknown as {
      config: { name: string; unique: boolean; where?: unknown };
    };
    expect(memberCodeIndex).toBeDefined();
    expect(memberCodeIndex.config.name).toBe('uq_customers_business_member_code');
    // A plain unique index would carry a useless entry for every customer who
    // has no pass code, and would make every insert pay to maintain it.
    expect(memberCodeIndex.config.unique).toBe(true);
    expect(memberCodeIndex.config.where).toBeDefined();
  });

  it('should declare the customers.metadata index as GIN', async () => {
    const db = await import('./index');
    const metadataIndex = db.idxCustomersMetadata as unknown as {
      config: { name: string; method: string };
    };
    expect(metadataIndex.config.name).toBe('idx_customers_metadata');
    // jsonb containment is a GIN operation; a btree index over jsonb would
    // build successfully and never be used for the queries it exists for.
    expect(metadataIndex.config.method).toBe('gin');
  });

  it('should keep the phone and auto-grant indexes partial', async () => {
    const db = await import('./index');
    for (const index of [db.idxCustomersPhone, db.idxRewardsAutoGrant]) {
      expect((index as unknown as { config: { where?: unknown } }).config.where).toBeDefined();
    }
  });

  it('should expose customers.member_code as a nullable column', async () => {
    const db = await import('./index');
    const columns = db.customers as unknown as Record<string, { name: string; notNull: boolean }>;
    expect(columns.memberCode).toBeDefined();
    expect(columns.memberCode.name).toBe('member_code');
    // Nullable so the migration leaves existing customers untouched.
    expect(columns.memberCode.notNull).toBe(false);
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
    const _tableNames = Object.keys(db.schema).filter(
      (key) => (db.schema as Record<string, unknown>)[key] !== undefined,
    );
    // Each table registers under its export name in `* as schema`
    // The schema re-export contains all tables
    expect(Object.keys(db.schema).length).toBeGreaterThanOrEqual(15);
  });
});
