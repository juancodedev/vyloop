import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Schema snapshot: verify expected tables exist in the Drizzle schema
// ---------------------------------------------------------------------------

describe('Database schema', () => {
  it('should export every table from @vyloop/db', async () => {
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

    // Counter domain — a sale that already happened
    expect(db.checkins).toBeDefined();

    // Counter domain — the credential that lets a terminal report one
    expect(db.posTerminals).toBeDefined();

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
    expect(db.idxCustomerEventsBranch).toBeDefined();
    expect(db.idxPushSubscriptionsLastSeen).toBeDefined();
    expect(db.allIndexes).toBeDefined();
    expect(Array.isArray(db.allIndexes)).toBe(true);
    // 12 pre-existing plus the three wallet indexes plus the venue geohash,
    // the consent uniqueness, the three push subscription indexes, the two
    // the proximity work added (the venue interaction index and the
    // subscription freshness index), the pos_terminals listing index, and the
    // reward_branches venue index.
    expect(db.allIndexes.length).toBe(25);
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
      idxBranchesGeohash: 'idx_branches_geohash',
      uqConsentsCustomerType: 'uq_consents_customer_type',
      uqPushSubscriptionsEndpoint: 'uq_push_subscriptions_endpoint',
      idxPushSubscriptionsBusiness: 'idx_push_subscriptions_business',
      idxPushSubscriptionsCustomer: 'idx_push_subscriptions_customer',
      idxPushSubscriptionsLastSeen: 'idx_push_subscriptions_last_seen',
      idxCustomersPhone: 'idx_customers_phone',
      idxCustomersLastVisit: 'idx_customers_last_visit',
      idxPointsBalance: 'idx_points_balance',
      idxCustomersMetadata: 'idx_customers_metadata',
      idxCustomerEventsCustomer: 'idx_customer_events_customer',
      idxCustomerEventsType: 'idx_customer_events_type',
      idxCustomerEventsBranch: 'idx_customer_events_branch',
      idxRewardsCategory: 'idx_rewards_category',
      idxRewardsAutoGrant: 'idx_rewards_auto_grant',
      idxRewardGrantsCustomer: 'idx_reward_grants_customer',
      idxRewardBranchesBranch: 'idx_reward_branches_branch',
      idxMessageLogCustomer: 'idx_message_log_customer',
      idxMessageLogStatus: 'idx_message_log_status',
      idxWhatsappTemplatesName: 'idx_whatsapp_templates_name',
      idxCustomersMemberCode: 'uq_customers_business_member_code',
      idxCustomerWalletPassesTenant: 'idx_customer_wallet_passes_tenant',
      idxWalletCallbackDeliveriesReceived: 'idx_wallet_callback_deliveries_received',
      idxPosTerminalsBusiness: 'idx_pos_terminals_business',
      idxPushCampaignsBusiness: 'idx_push_campaigns_business',
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

  it('should shape checkins so a pending credit is findable', async () => {
    // `points` nullable is the whole design of the table: `NULL` means "the sale
    // is recorded and the credit has not landed yet", which is a backlog somebody
    // can query. Asserted on nullability because `NOT NULL DEFAULT 0` would be the
    // tempting shape and it would make the failure state unrepresentable, and
    // therefore invisible.
    const db = await import('./index');
    const columns = db.checkins as unknown as Record<string, { name: string; notNull: boolean }>;

    expect(columns.points.name).toBe('points');
    expect(columns.points.notNull).toBe(false);

    // The sale's own facts are NOT NULL, so a NULL-`points` row still says what
    // was sold, to whom, and for how much. That is what makes it a *pending
    // credit* rather than an unrecorded sale.
    for (const column of ['businessId', 'customerId', 'memberCode', 'amountCents']) {
      expect(columns[column]!.notNull, `${column} must be NOT NULL`).toBe(true);
    }

    // The manual path's whole cost: `payment_id` is NULL there, and Postgres'
    // `NULL != NULL` is why the unique index does not collide on it.
    expect(columns.paymentId.name).toBe('payment_id');
    expect(columns.paymentId.notNull).toBe(false);
  });

  it('should shape pos_terminals so a secret is never readable back', async () => {
    // The table exists so a merchant's till can hold a credential that mints a
    // `pos:` token. Everything about its shape follows from one requirement: the
    // secret is shown once, at creation, and after that the database can only
    // answer whether a presented secret matches.
    const db = await import('./index');
    const columns = db.posTerminals as unknown as Record<
      string,
      { name: string; notNull: boolean }
    >;

    // A secret is never stored, so the column that exists is named for what it
    // holds. `key_hash`, not `key` and not `secret`.
    expect(columns.keyHash).toBeDefined();
    expect(columns.keyHash.name).toBe('key_hash');
    expect(columns.keyHash.notNull).toBe(true);

    // The terminal's own identity is what a merchant reads when something goes
    // wrong, so it cannot be nullable.
    expect(columns.name.name).toBe('name');
    expect(columns.name.notNull).toBe(true);

    // `revoked_at` NULL until revoked, and `last_seen_at` NULL until the terminal
    // has used it. Both are the same shape on purpose: NULL is the ordinary state
    // of a column whose whole content is "has this happened yet", and a sentinel
    // date would turn "never" into a value that has to be excluded everywhere.
    expect(columns.revokedAt.name).toBe('revoked_at');
    expect(columns.revokedAt.notNull).toBe(false);
    expect(columns.lastSeenAt.name).toBe('last_seen_at');
    expect(columns.lastSeenAt.notNull).toBe(false);

    expect(columns.createdAt.notNull).toBe(true);
  });

  it('should cascade pos_terminals from tenants, so deleting a merchant leaves no credential', async () => {
    const db = await import('./index');
    const config = getTableConfig(db.posTerminals);

    const foreignKey = config.foreignKeys.find(
      (entry) => entry.getName() === 'pos_terminals_business_id_tenants_id_fk',
    );
    expect(foreignKey, 'pos_terminals_business_id_tenants_id_fk is not declared').toBeDefined();

    // Cascade, like every other `business_id` in this schema. A credential for a
    // tenant that no longer exists is not a credential; it is a row that would
    // still answer `verifyPassword` for whoever kept the secret.
    expect(foreignKey!.onDelete).toBe('cascade');

    const referenced = foreignKey!.reference();
    expect(referenced.foreignColumns.map((column) => (column as { name: string }).name)).toEqual([
      'id',
    ]);
    expect(referenced.columns.map((column) => (column as { name: string }).name)).toEqual([
      'business_id',
    ]);
  });

  it('should declare the tenant constraint in the extra-config callback, where drizzle-kit can see it', async () => {
    const db = await import('./index');
    const config = getTableConfig(db.posTerminals);

    // A named foreign key has to be written in the callback: `.references()` on
    // the column mints an unnamed one, and a constraint nobody can name is a
    // constraint an operator cannot revoke against by name. Asserted on the built
    // config rather than on the source, where the declaration could live as a
    // comment and still pass.
    expect(config.foreignKeys.map((key) => key.getName())).toEqual([
      'pos_terminals_business_id_tenants_id_fk',
    ]);
  });

  it('should index pos_terminals exactly like GET /v1/loyalty/terminals reads it', async () => {
    const db = await import('./index');
    const config = getTableConfig(db.posTerminals);

    // The reader is `GET /v1/loyalty/terminals` in `workers/growth/src/routes.ts`:
    // `where business_id = ? order by created_at desc`. Asserted on the built
    // config rather than the Drizzle source, so a change to the column list or the
    // sort direction fails here instead of silently degrading the tenant scan.
    expect(config.indexes.map((entry) => entry.config.name)).toEqual(['idx_pos_terminals_business']);

    const index = config.indexes[0]!;
    expect(index.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      'business_id',
      'created_at',
    ]);

    // `posTerminals` is in `INDEXED_TABLES` in `indexes.ts`; `migration-sql.test.ts`
    // asserts the set of `CREATE INDEX` statements in the history is exactly the
    // set that registry reports, so declaring the index without registering it
    // fails the build rather than drifting.
    expect(db.allIndexes.map((entry) => entry.config.name)).toContain('idx_pos_terminals_business');
  });

  it('should dedupe checkins on (business_id, payment_id)', async () => {
    const db = await import('./index');
    const config = getTableConfig(db.checkins);

    const constraint = config.uniqueConstraints.find(
      (entry) => entry.name === 'uq_checkins_business_payment',
    );
    expect(constraint, 'uq_checkins_business_payment is not declared').toBeDefined();

    // Both columns, in this order, asserted on the *built* config rather than on
    // the Drizzle source. The column list is the whole idempotency guarantee: a
    // dedupe that ignored `business_id` would let one merchant's payment id
    // suppress another merchant's sale.
    expect(constraint!.columns.map((column) => (column as { name: string }).name)).toEqual([
      'business_id',
      'payment_id',
    ]);

    // A `unique` constraint rather than a `CREATE UNIQUE INDEX`, and that
    // distinction is load-bearing for `allIndexes`: `uniqueConstraints` is a
    // separate bucket from `indexes`, so this does not add an entry to the derived
    // index registry, and `index.test.ts`'s exact-set assertion stays honest
    // without a second list to update.
    expect(config.indexes).toEqual([]);
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

  it('should expose every pgTable in the schema object, and nothing else', async () => {
    const db = await import('./index');

    // Asserted by NAME rather than by a count. The previous form was
    // `toBeGreaterThanOrEqual(15)` against a schema that already had 22 tables:
    // a count that is simultaneously stale and unfalsifiable, so it could not fail
    // for the reason anyone would want it to. Naming every table makes a table
    // added without a matching assertion here fail, which is the only way a
    // counter earns its place.
    expect(Object.keys(db.schema).sort()).toEqual([
      'branches',
      'checkins',
      'churnPredictions',
      'consents',
      'crossLoyaltyAlliances',
      'customerEvents',
      'customerWalletPasses',
      'customers',
      'localizationConfigs',
      'loyaltyPrograms',
      'membershipTiers',
      'messageLog',
      'pointsTransactions',
      'posTerminals',
      'pushCampaigns',
      'pushSubscriptions',
      'referrals',
      'rewardBranches',
      'rewardGrants',
      'rewards',
      'settledPayments',
      'tenantWalletPrograms',
      'tenants',
      'users',
      'walletCallbackDeliveries',
      'whatsappTemplates',
      'workflowExecutions',
      'workflows',
    ]);
  });
});
