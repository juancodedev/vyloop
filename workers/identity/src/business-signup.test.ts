import { describe, expect, it } from 'vitest';

import { signupBusiness, SlugNotDerivableError, type SignupDb } from './business-signup';

// ---------------------------------------------------------------------------
// Test harness
//
// The mock records the SQL it is handed and models the one thing a plain spy
// cannot: a transaction that either commits every statement it ran or none of
// them. That distinction is the whole contract of this slice, so it is
// simulated rather than inferred — a mock that merely counts `execute` calls
// would pass a broken implementation that wrote the tenant outside the
// transaction and the other three inside.
// ---------------------------------------------------------------------------

/**
 * Flatten a Drizzle `SQL` object to text with its bound params inlined.
 *
 * The chunk encoding is mixed, and the distinctions matter here because the
 * assertions read the rendered text: a string bind arrives as a bare `string`
 * chunk merged into the surrounding SQL, a number as a bare `number` chunk, a
 * null as a bare `null`, and only a `Param` wrapper is an object with a `.value`.
 * Reading `.value` off a primitive yields `undefined` rather than throwing,
 * which turns a real bound `0` into a silent `undefined` in the log.
 */
function renderSql(query: unknown): string {
  const chunks = (query as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((chunk) => {
      if (typeof chunk !== 'object' || chunk === null) return String(chunk);
      const value = (chunk as { value: unknown }).value;
      if (Array.isArray(value)) return value.join('');
      return String(value);
    })
    .join('')
    // Whitespace is collapsed so a value can be asserted as `, Bronce,` rather
    // than as a comma, six spaces and a newline. The indentation inside the
    // template literals is for the humans reading the production file; it is
    // noise in a string comparison.
    .replace(/\s+/g, ' ');
}

/** Which table a statement writes to, or `'set_config'`, or `null`. */
function classify(statement: string): string | null {
  const insert = statement.match(/INSERT INTO (\w+)/);
  if (insert) return insert[1];
  if (statement.includes('set_config')) return 'set_config';
  return null;
}

const IDS = {
  tenant: '11111111-1111-1111-1111-111111111111',
  user: '22222222-2222-2222-2222-222222222222',
  program: '33333333-3333-3333-3333-333333333333',
  tier: '44444444-4444-4444-4444-444444444444',
};

interface RecordedTx {
  /** Statements that ran inside a transaction that committed. */
  committed: string[];
  /** Statements that ran inside a transaction that rolled back. */
  rolledBack: string[];
  /** Statements run on `db` outside any transaction. */
  outside: string[];
  /** How many transactions were opened. */
  transactions: number;
  /** Tables the pre-check found occupied. */
  existingSlugs: string[];
}

interface MockOptions {
  /** Reject the transaction at this table, to prove the rollback. */
  failAt?: string;
  /** Throw this instead of failing at a table, e.g. a unique violation. */
  throwFromTransaction?: unknown;
  /** Slugs the pre-check SELECT reports as taken. */
  existingSlugs?: string[];
  /** Make this table's `RETURNING` come back empty. */
  emptyResultFor?: string;
}

function createMockDb(options: MockOptions = {}): { db: SignupDb; log: RecordedTx } {
  const log: RecordedTx = {
    committed: [],
    rolledBack: [],
    outside: [],
    transactions: 0,
    existingSlugs: options.existingSlugs ?? [],
  };

  const rowsFor = (table: string): { id: string }[] => {
    switch (table) {
      case 'tenants':
        return [{ id: IDS.tenant }];
      case 'users':
        return [{ id: IDS.user }];
      case 'loyalty_programs':
        return [{ id: IDS.program }];
      case 'membership_tiers':
        return [{ id: IDS.tier }];
      default:
        return [];
    }
  };

  const runStatement = async (statement: string, bucket: string[]): Promise<unknown> => {
    bucket.push(statement);
    const table = classify(statement);

    if (options.failAt && table === options.failAt) {
      throw new Error(`mock failure at ${table}`);
    }
    if (options.throwFromTransaction && bucket.length === 2) {
      throw options.throwFromTransaction;
    }
    if (table && options.emptyResultFor === table) {
      return { rows: [] };
    }
    return { rows: table ? rowsFor(table) : [] };
  };

  const db = {
    execute: async (query: unknown) => {
      const statement = renderSql(query);
      log.outside.push(statement);
      // Drizzle inlines a string bind unquoted, so the rendered statement reads
      // `WHERE slug = cafe-central` — the slug is its own token, not a literal.
      const slugMatch = statement.match(/WHERE slug = (\S+)/);
      if (slugMatch && log.existingSlugs.includes(slugMatch[1])) {
        return { rows: [{ id: 'some-other-tenant' }] };
      }
      return { rows: [] };
    },

    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      log.transactions += 1;
      const staged: string[] = [];
      const tx = {
        execute: (query: unknown) => runStatement(renderSql(query), staged),
      };
      try {
        const value = await cb(tx);
        log.committed.push(...staged);
        return value;
      } catch (err) {
        // Nothing from `staged` reaches `committed`. That is the rollback the
        // tenant/user inserts would not get if the transaction were faked.
        log.rolledBack.push(...staged);
        throw err;
      }
    },
  };

  return { db: db as unknown as SignupDb, log };
}

const VALID_INPUT = {
  name: 'Café Central',
  adminEmail: 'owner@cafecentral.cl',
  adminPasswordHash: 'deadbeefdeadbeefdeadbeefdeadbeef:cafebabe',
};

function signup(db: SignupDb, overrides: Partial<typeof VALID_INPUT> = {}) {
  return signupBusiness(db, { ...VALID_INPUT, ...overrides });
}

// ---------------------------------------------------------------------------
// The four writes
// ---------------------------------------------------------------------------

describe('signupBusiness', () => {
  it('creates the tenant, the administrator, the program and the first tier', async () => {
    const { db, log } = createMockDb();

    const outcome = await signup(db);

    expect(outcome.ok).toBe(true);
    expect(log.committed.map(classify)).toEqual([
      'tenants',
      'set_config',
      'users',
      'loyalty_programs',
      'membership_tiers',
    ]);
  });

  it('returns the id of everything it created', async () => {
    const { db } = createMockDb();

    const outcome = await signup(db);

    expect(outcome).toEqual({
      ok: true,
      value: {
        businessId: IDS.tenant,
        name: 'Café Central',
        slug: 'cafe-central',
        adminUserId: IDS.user,
        loyaltyProgramId: IDS.program,
        firstTierId: IDS.tier,
      },
    });
  });

  it('opens exactly one transaction', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    expect(log.transactions).toBe(1);
  });

  it('writes the derived slug, not the raw name', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const tenantInsert = log.committed.find((s) => classify(s) === 'tenants') ?? '';
    expect(tenantInsert).toContain('(Café Central, cafe-central)');
  });

  it('creates the administrator with the admin role, not the cashier default', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const userInsert = log.committed.find((s) => classify(s) === 'users') ?? '';
    // `users.role` defaults to 'cashier'. A signup that omitted it would mint a
    // business whose only user cannot administer it. The role is a template
    // literal, so it is the one value here that renders quoted.
    expect(userInsert).toContain("'admin'");
    expect(userInsert).not.toContain('cashier');
  });

  it('stores the administrator email and the supplied password hash', async () => {
    const { db, log } = createMockDb();

    await signup(db, { adminEmail: 'owner@cafecentral.cl' });

    const userInsert = log.committed.find((s) => classify(s) === 'users') ?? '';
    expect(userInsert).toContain(', owner@cafecentral.cl,');
    expect(userInsert).toContain(VALID_INPUT.adminPasswordHash);
  });

  it('names the program after the business, the way the seed does', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const programInsert = log.committed.find((s) => classify(s) === 'loyalty_programs') ?? '';
    expect(programInsert).toContain(', Programa de Lealtad Café Central,');
  });

  // The column default is the *string* '[]', so a writer that omits `benefits`
  // leaves a value the dashboard has to read as either a string or a list
  // depending on which writer made the row.
  it('passes the first tier a real JSON array, not the string default', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const tierInsert = log.committed.find((s) => classify(s) === 'membership_tiers') ?? '';
    expect(tierInsert).toContain('::jsonb');
    expect(tierInsert).toContain('[{"title":"Beneficios básicos"');
  });

  it('creates the first tier at the bottom of the ladder', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const tierInsert = log.committed.find((s) => classify(s) === 'membership_tiers') ?? '';
    expect(tierInsert).toContain(', Bronce,');
    expect(tierInsert).toContain('display_order');
  });

  it('starts the first tier at zero points, so it is reachable from the first purchase', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const tierInsert = log.committed.find((s) => classify(s) === 'membership_tiers') ?? '';
    // The ladder the seed builds for Café Central: Bronce at 0, then Plata and
    // Oro. A signup that opened at 100 would put every new customer's first tier
    // out of reach of the balance they actually hold.
    expect(tierInsert).toContain(', Bronce, 0, 1.0,');
    expect(tierInsert).toMatch(/::jsonb, 1\b/);
  });

  it('points the tier at the program it just created', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const tierInsert = log.committed.find((s) => classify(s) === 'membership_tiers') ?? '';
    expect(tierInsert).toContain(IDS.program);
  });
});

// ---------------------------------------------------------------------------
// RLS ordering
// ---------------------------------------------------------------------------

describe('signupBusiness RLS session', () => {
  // `app.current_business_id` does not exist until the tenant insert returns the
  // id it minted, so the set_config has to land after it. Running it before
  // would set a value to nothing, and the three inserts that follow would match
  // no RLS policy — a silent zero-row write, not an error.
  it('sets the business id after the tenant insert, not before', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const order = log.committed.map(classify);
    expect(order.indexOf('tenants')).toBeLessThan(order.indexOf('set_config'));
  });

  it('sets the business id before every write that a policy covers', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const order = log.committed.map(classify);
    const setConfig = order.indexOf('set_config');
    for (const table of ['users', 'loyalty_programs', 'membership_tiers']) {
      expect(order.indexOf(table)).toBeGreaterThan(setConfig);
    }
  });

  it('sets the tenant id it actually got back, not a placeholder', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    const setConfig = log.committed.find((s) => classify(s) === 'set_config') ?? '';
    expect(setConfig).toContain(IDS.tenant);
  });

  it('reads the slug outside the transaction, because tenants has no policy', async () => {
    const { db, log } = createMockDb();

    await signup(db);

    expect(log.outside.join('\n')).toContain('SELECT id FROM tenants');
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe('signupBusiness rollback', () => {
  // The three ways the tail of the flow can fail after the business already
  // exists. All three have the same required outcome: no tenant row survives.
  it.each([['users'], ['loyalty_programs'], ['membership_tiers']])(
    'leaves nothing behind when the %s insert fails',
    async (table) => {
      const { db, log } = createMockDb({ failAt: table });

      await expect(signup(db)).rejects.toThrow(`mock failure at ${table}`);

      expect(log.committed).toEqual([]);
      // The tenant and administrator were attempted and discarded together with
      // the tier, not left in the database as an orphan.
      expect(log.rolledBack.map(classify)).toContain('tenants');
      // Exactly the statements that ran, and nothing beyond the failing one.
      expect(log.rolledBack).toHaveLength(
        ['tenants', 'set_config', 'users', 'loyalty_programs', 'membership_tiers'].indexOf(table) + 1,
      );
    },
  );

  it('reports the failure by naming the table that broke', async () => {
    const { db } = createMockDb({ failAt: 'loyalty_programs' });

    // Five distinct error classes exist so an on-call engineer reading a log
    // line knows which of the four writes failed without attaching a debugger.
    await expect(signup(db)).rejects.toThrow('mock failure at loyalty_programs');
  });

  // A `RETURNING` on a successful INSERT always yields a row. An empty result
  // means the transaction is about to commit with a hole in it — the tenant
  // exists with no loyalty program, or a program with no tier, and nothing
  // reports it until a customer's first purchase has nowhere to land.
  it.each([['tenants'], ['users'], ['loyalty_programs'], ['membership_tiers']])(
    'refuses to commit when the %s insert returns no row',
    async (table) => {
      const { db, log } = createMockDb({ emptyResultFor: table });

      await expect(signup(db)).rejects.toThrow(`INSERT INTO ${table} returned no row`);
      expect(log.committed).toEqual([]);
    },
  );

  it('does not report success when a RETURNING comes back empty', async () => {
    const { db, log } = createMockDb({ emptyResultFor: 'membership_tiers' });

    const outcome = await signup(db).catch((err: unknown) => err);

    expect(outcome).toBeInstanceOf(Error);
    expect(log.committed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Duplicate slug
// ---------------------------------------------------------------------------

describe('signupBusiness duplicate slug', () => {
  // The feature document's requirement: a legible error, never a 500. This is
  // the pre-check path, where the slug is known to be occupied before any write
  // is attempted.
  it('reports SLUG_TAKEN and names the slug when the slug is already in use', async () => {
    const { db } = createMockDb({ existingSlugs: ['cafe-central'] });

    const outcome = await signup(db);

    expect(outcome).toEqual({ ok: false, code: 'SLUG_TAKEN', slug: 'cafe-central' });
  });

  it('writes nothing at all when the slug is already in use', async () => {
    const { db, log } = createMockDb({ existingSlugs: ['cafe-central'] });

    await signup(db);

    expect(log.transactions).toBe(0);
    expect(log.committed).toEqual([]);
  });

  it('does not throw for a taken slug, so the caller can shape the response', async () => {
    const { db } = createMockDb({ existingSlugs: ['cafe-central'] });

    await expect(signup(db)).resolves.toBeDefined();
  });

  // Two businesses with the same name derive the same slug. This is the case the
  // document calls out by name.
  it('collides for two businesses registered under the same name', async () => {
    const { db } = createMockDb({ existingSlugs: ['cafe-central'] });

    const outcome = await signupBusiness(db, {
      name: 'Café Central',
      adminEmail: 'second@cafecentral.cl',
      adminPasswordHash: VALID_INPUT.adminPasswordHash,
    });

    expect(outcome.ok).toBe(false);
  });

  it('collides for names that differ only in accents or spacing', async () => {
    const { db } = createMockDb({ existingSlugs: ['cafe-central'] });

    const outcome = await signupBusiness(db, {
      name: '  CAFÉ   central ',
      adminEmail: 'second@cafecentral.cl',
      adminPasswordHash: VALID_INPUT.adminPasswordHash,
    });

    expect(outcome).toEqual({ ok: false, code: 'SLUG_TAKEN', slug: 'cafe-central' });
  });

  // The pre-check is an ergonomics layer, not the arbiter. Two concurrent
  // signups for the same name both read an empty table, and the second loses at
  // the index. The unique violation has to surface as the same legible answer
  // or the race becomes a 500.
  it('maps a unique violation raised at insert time to the same error', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const { db, log } = createMockDb({ throwFromTransaction: uniqueViolation });

    const outcome = await signup(db);

    expect(outcome).toEqual({ ok: false, code: 'SLUG_TAKEN', slug: 'cafe-central' });
    expect(log.committed).toEqual([]);
    expect(log.rolledBack.map(classify)).toContain('tenants');
  });

  it('propagates an unrelated database error rather than calling it a slug clash', async () => {
    const { db } = createMockDb({ throwFromTransaction: new Error('connection terminated') });

    await expect(signup(db)).rejects.toThrow('connection terminated');
  });
});

// ---------------------------------------------------------------------------
// Un-derivable slug
// ---------------------------------------------------------------------------

describe('signupBusiness un-derivable slug', () => {
  // A business named `!!!` normalises to `''`. Inserting that would create a
  // tenant whose slug is the empty string, and the second such signup would
  // collide with the first on an address no merchant chose. It is refused
  // before the transaction opens, so no write is attempted.
  it('refuses a name that contains nothing sluggable', async () => {
    const { db, log } = createMockDb();

    await expect(signup(db, { name: '!!!' })).rejects.toThrow(SlugNotDerivableError);
    expect(log.transactions).toBe(0);
  });

  it('names the offending name in the error', async () => {
    const { db } = createMockDb();

    await expect(signup(db, { name: '???' })).rejects.toThrow('"???"');
  });
});
