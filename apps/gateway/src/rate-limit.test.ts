// @vitest-environment node

/**
 * The limiter keys on the tenant's plan, and a counter gets its own bucket.
 *
 * ## What was actually wrong
 *
 * `rate-limit.ts:100` read
 *
 * ```
 * const limit = config.limits[jwt.role] ?? config.limits.free ?? 60;
 * ```
 *
 * — keyed on **role**, not plan. And `DEFAULT_LIMITS` was
 * `{ free: 60, pro: 300, business: 1000 }`, of which only `free` matched
 * anything at all: the plans that exist in `tenants.plan` in production are
 * `free` (5 tenants) and `premium` (1 tenant). So `pro` and `business` were dead
 * keys, and the one paying tenant in the system resolved through the `??` to
 * `free`'s 60 — identical to a tenant that has never paid anybody anything.
 *
 * The regression this file exists to catch is that last sentence. It is easy to
 * write a change that renames the keys, keeps keying on `role`, and passes every
 * other test in the repository, because nothing else reads a limit.
 *
 * ## Why an absent `plan` is bounded *below* `free`
 *
 * `plan` is an optional claim, deliberately (see `middleware/auth.ts`). A token
 * issued before this change carries none, and a token issued by a path that
 * forgot to pass one carries none. If absence resolved to `free`'s number, then
 * omitting the claim would be worth exactly as much as being the lowest paying
 * tier — which makes omission a free choice for whoever holds the token. So
 * absence gets its own constant, and it is *stricter* than `free`, never looser.
 * What it must never be is unlimited.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { COUNTER_SUBJECT_PREFIX, isCounterSubject } from '@vyloop/types';
import { describe, expect, it } from 'vitest';

import type { JwtClaims } from './middleware/auth';
import { DEFAULT_LIMITS, rateLimitMiddleware } from './middleware/rate-limit';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUSINESS = 'biz-1';
const ENDPOINT = '/v1/loyalty/checkins';

/**
 * The plans that exist, measured against `tenants.plan` rather than guessed.
 *
 * Hard-coded here on purpose. If this imported the real plan list the assertion
 * would be `Object.keys(DEFAULT_LIMITS) === Object.keys(REAL_PLANS)`, which a
 * dead key on *both* sides passes. Spelling the two values out is the only
 * version of this test that can fail.
 */
const REAL_PLANS = ['free', 'premium'];

function claims(overrides: Partial<JwtClaims> = {}): JwtClaims {
  return {
    sub: 'user_1',
    business_id: BUSINESS,
    role: 'admin',
    scopes: ['read:customers'],
    ...overrides,
  };
}

/** A KV namespace backed by a Map, counting the keys it was asked about. */
function memoryKv() {
  const store = new Map<string, string>();
  const keys: string[] = [];

  return {
    keys,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      keys.push(key);
      store.set(key, value);
    },
  };
}

/** The two fields `rateLimitMiddleware` reads off a Hono context, plus its 429. */
function probe(pathname = ENDPOINT) {
  return {
    passed: false,
    status: 0,
    ctx: {
      req: { url: `https://api.test${pathname}`, method: 'POST', header: () => undefined },
      get: (key: string) => (key === 'jwt' ? currentJwt : undefined),
      json: () => ({ status: 429 }),
    },
  };
}

let currentJwt: JwtClaims | undefined;

/**
 * Drive one authenticated request through the real middleware.
 *
 * Returns the counter key the limiter chose and whether it let the request
 * through, which is the only two things any test below needs to distinguish.
 */
async function request(jwt: JwtClaims, kv: ReturnType<typeof memoryKv>, pathname = ENDPOINT) {
  currentJwt = jwt;
  const context = probe(pathname);
  const before = kv.keys.length;

  const result = await rateLimitMiddleware({
    kv: kv as never,
    limits: DEFAULT_LIMITS,
    windowSeconds: 60,
  })(context.ctx as never, async () => {
    context.passed = true;
  });

  return {
    passed: context.passed && result === undefined,
    limited: result !== undefined,
    key: kv.keys.length > before ? kv.keys[before] : undefined,
  };
}

// ---------------------------------------------------------------------------
// The limit table itself
// ---------------------------------------------------------------------------

describe('DEFAULT_LIMITS is keyed by plans that exist', () => {
  it('has exactly the plans that exist, so no key can be dead', () => {
    // The whole defect in one assertion: `pro` and `business` matched nothing in
    // `tenants.plan`, so nobody was ever limited by them and everybody believed
    // they were.
    expect(Object.keys(DEFAULT_LIMITS).sort()).toEqual(REAL_PLANS);
  });

  it('carries no key that no tenant could ever hold', () => {
    // Named one by one rather than derived, so the failure says which dead key
    // came back instead of printing two arrays.
    expect(Object.keys(DEFAULT_LIMITS)).not.toContain('pro');
    expect(Object.keys(DEFAULT_LIMITS)).not.toContain('business');
  });

  it('keeps free where it was, because raising it would weaken a live limit', () => {
    // 60 is what every free tenant has been getting since the limiter shipped.
    expect(DEFAULT_LIMITS.free).toBe(60);
  });

  it('gives premium its own number, higher than free', () => {
    expect(DEFAULT_LIMITS.premium).toBeGreaterThan(DEFAULT_LIMITS.free);
  });
});

// ---------------------------------------------------------------------------
// premium is not free — the regression this change exists for
// ---------------------------------------------------------------------------

describe('a premium tenant is not throttled as a free one', () => {
  it("serves a premium caller past free's ceiling", async () => {
    const kv = memoryKv();
    const jwt = claims({ plan: 'premium' });

    // One request past `free`'s limit. Under the old code this 429'd, because
    // the paying tenant resolved through `?? config.limits.free`.
    for (let i = 0; i < DEFAULT_LIMITS.free + 1; i += 1) {
      const attempt = await request(jwt, kv);
      expect(attempt.limited, `premium was refused at request ${i + 1}`).toBe(false);
    }
  });

  it('still refuses a premium caller at its own ceiling', async () => {
    // A ceiling nobody tested is a ceiling nobody has, so the other direction is
    // asserted too: the limit is real, not a limit that stopped existing.
    const kv = memoryKv();
    const jwt = claims({ plan: 'premium' });

    for (let i = 0; i < DEFAULT_LIMITS.premium; i += 1) {
      await request(jwt, kv);
    }

    const attempt = await request(jwt, kv);
    expect(attempt.limited).toBe(true);
  });

  it('reads the plan claim, not the role', async () => {
    // `admin` was never a key in the table, so the old lookup fell through for
    // every operator. Two callers, identical role, different plans, must not get
    // the same answer.
    const premium = await request(claims({ role: 'admin', plan: 'premium' }), memoryKv());
    const free = await request(claims({ role: 'admin', plan: 'free' }), memoryKv());

    expect(premium.key).toBe(free.key);
    expect(premium.passed).toBe(true);

    const premiumKv = memoryKv();
    for (let i = 0; i < DEFAULT_LIMITS.free; i += 1) {
      await request(claims({ role: 'admin', plan: 'premium' }), premiumKv);
    }
    const beyondFree = await request(claims({ role: 'admin', plan: 'premium' }), premiumKv);
    const atFree = await request(claims({ role: 'admin', plan: 'free' }), memoryKv());

    expect(beyondFree.limited).toBe(false);
    expect(atFree.limited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A token with no plan
// ---------------------------------------------------------------------------

describe('a token with no plan claim', () => {
  it('is bounded', async () => {
    const kv = memoryKv();
    const jwt = claims();

    for (let i = 0; i < 5_000; i += 1) {
      const attempt = await request(jwt, kv);
      if (attempt.limited) {
        expect(i).toBeGreaterThan(0);
        return;
      }
    }

    throw new Error('a token with no plan claim was never throttled');
  });

  it('is bounded below free, so omitting the claim is never worth as much as paying', async () => {
    const kv = memoryKv();
    const jwt = claims();
    let served = 0;

    while (!(await request(jwt, kv)).limited) {
      served += 1;
    }

    // Not free's number...
    expect(served).not.toBe(DEFAULT_LIMITS.free);
    // ...and never the paid tier's.
    expect(served).toBeLessThan(DEFAULT_LIMITS.free);
    expect(served).toBeLessThan(DEFAULT_LIMITS.premium);
  });

  it('does not become unlimited when the limits table has no matching key', async () => {
    // `limits: {}` is the shape a caller passes when it has no table at all. The
    // old `?? ... ?? 60` chain ended in a literal; the new one ends in the named
    // constant, and neither may be missing.
    const kv = memoryKv();
    let served = 0;

    while (served < 1_000) {
      const attempt = await rateLimitMiddleware({
        kv: { get: kv.get, put: kv.put } as never,
        limits: {},
        windowSeconds: 60,
      })(probeFor(claims()) as never, async () => undefined);

      if (attempt !== undefined) break;
      served += 1;
    }

    expect(served).toBeGreaterThan(0);
    expect(served).toBeLessThan(DEFAULT_LIMITS.free);
  });

  it('treats an unrecognised plan the same as no plan at all', async () => {
    // A plan from a future release of this codebase, read by a gateway that has
    // not shipped it. It must not fall through to a paid tier's number.
    const kv = memoryKv();
    const jwt = claims({ plan: 'platinum' });
    let served = 0;

    while (!(await request(jwt, kv)).limited) {
      served += 1;
    }

    expect(served).toBeLessThan(DEFAULT_LIMITS.free);
  });
});

// ---------------------------------------------------------------------------
// A counter at the till gets its own counter
// ---------------------------------------------------------------------------

describe('counter subjects are counted apart from humans at the same merchant', () => {
  const POS_A = claims({ sub: 'pos:0f9c1d2e', role: 'pos', plan: 'premium' });
  const POS_B = claims({ sub: 'pos:4b7e0a11', role: 'pos', plan: 'premium' });

  it('gives two terminals at one business two different keys', async () => {
    const kv = memoryKv();

    const a = await request(POS_A, kv);
    const b = await request(POS_B, kv);

    expect(a.key).toBeDefined();
    expect(b.key).toBeDefined();
    expect(a.key).not.toBe(b.key);
    // Both name the same merchant: the split is the subject, not the tenant.
    expect(a.key).toContain(BUSINESS);
    expect(b.key).toContain(BUSINESS);
  });

  it('gives the same terminal one key on every request', async () => {
    const kv = memoryKv();

    const first = await request(POS_A, kv);
    const second = await request(POS_A, kv);

    expect(first.key).toBe(second.key);
  });

  it("does not let one terminal spend the other's bucket", async () => {
    const kv = memoryKv();

    // Exhaust A completely.
    while (!(await request(POS_A, kv)).limited) {
      // stop when A is refused
    }

    const exhausted = await request(POS_A, kv);
    expect(exhausted.limited).toBe(true);

    // B, same business, same endpoint, same plan: untouched.
    const b = await request(POS_B, kv);
    expect(b.limited).toBe(false);
  });

  it("does not let a terminal spend the operator's bucket, or the reverse", async () => {
    const kv = memoryKv();
    const operator = claims({ sub: 'user_1', role: 'admin', plan: 'premium' });

    const operatorKey = (await request(operator, kv)).key;
    const posKey = (await request(POS_A, kv)).key;

    expect(operatorKey).not.toBe(posKey);
  });
});

// ---------------------------------------------------------------------------
// Everyone else is counted exactly as before
// ---------------------------------------------------------------------------

describe('a non-counter subject is counted exactly as it was', () => {
  it('uses the key it used before this change, byte for byte', async () => {
    // `ratelimit:${businessId}:${endpoint}` — unchanged, for every subject that
    // is not a counter. Nothing about an operator's, a staff member's or a
    // customer's accounting shifts: not their key, not their window, not the
    // counter they are sitting in right now.
    const expected = `ratelimit:${BUSINESS}:${ENDPOINT}`;

    for (const jwt of [
      claims(),
      claims({ role: 'customer', sub: 'cust-1' }),
      claims({ role: 'cashier', sub: 'user_9', plan: 'free' }),
      claims({ role: 'admin', plan: 'premium' }),
    ]) {
      const kv = memoryKv();
      const attempt = await request(jwt, kv);
      expect(attempt.key).toBe(expected);
    }
  });

  it('counts every operator at a merchant in one bucket, as it always has', async () => {
    // Two different humans, one business. They shared a bucket before this change
    // and they still do: the per-tenant ceiling is a tenant-wide ceiling, and
    // splitting it per user would multiply the number of counters a single tenant
    // can spend by the size of its staff.
    const kv = memoryKv();

    const admin = await request(claims({ sub: 'user_1', role: 'admin' }), kv);
    const cashier = await request(claims({ sub: 'user_2', role: 'cashier' }), kv);

    expect(admin.key).toBe(cashier.key);
  });

  it('does not treat a subject that merely looks like a counter as one', async () => {
    // The marker is `pos:` and the prefix must be exact, for the reason
    // `isCounterSubject` in `workers/growth/src/helpers.ts` spells out: a bare
    // `pos` is matched by `postmaster-3`. A uuid cannot begin with `pos:` at all,
    // so this is the same narrowing on this side of the wire.
    const kv = memoryKv();
    const impostor = claims({ sub: 'POS:0f9c1d2e' });

    const attempt = await request(impostor, kv);

    expect(attempt.key).toBe(`ratelimit:${BUSINESS}:${ENDPOINT}`);
  });

  it('gives a counter a key that spells the marker out in full', async () => {
    // The distinctness tests above pass with the colon dropped — `pos` still
    // prefixes `pos:0f9c1d2e`, so two terminals still get two buckets and the
    // tests stay green. What changes is that `postmaster-3` also becomes a
    // "counter", splitting a human's accounting off from the rest of the
    // merchant's. So the key format itself is asserted, not just its uniqueness.
    const kv = memoryKv();

    const counter = await request(claims({ sub: 'pos:0f9c1d2e' }), kv);

    expect(counter.key).toBe(`ratelimit:${BUSINESS}:pos:pos:0f9c1d2e:${ENDPOINT}`);

    const lookalike = await request(claims({ sub: 'postmaster-3' }), kv);
    expect(lookalike.key).toBe(`ratelimit:${BUSINESS}:${ENDPOINT}`);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A probe bound to a fixed JWT, for the one test that drives the middleware directly. */
function probeFor(jwt: JwtClaims) {
  currentJwt = jwt;
  return {
    req: { url: `https://api.test${ENDPOINT}`, method: 'POST', header: () => undefined },
    get: (key: string) => (key === 'jwt' ? jwt : undefined),
    json: () => ({ status: 429 }),
  };
}

// ---------------------------------------------------------------------------
// The two `pos:` spellings agree
// ---------------------------------------------------------------------------

describe('the counter prefix agrees with the reader that gates the routes', () => {
  // `requireCounterSubject` in `workers/growth/src/helpers.ts` decides which
  // requests may report a merchant's completed sale, and this gateway has to
  // build the same string to give a counter its own bucket.
  //
  // The two used to declare the prefix **twice** — once in each file — and the
  // only thing keeping the spellings together was this test, reading the other
  // file's source. It worked, because a test can read a file it may not import.
  // But it was a test holding together two definitions, which is the shape of
  // problem that a test is the wrong tool for: the dependency runs the wrong way
  // (growth reads the value, it does not own it) and neither package could
  // enforce the agreement on its own.
  //
  // The prefix now lives in `@vyloop/types`, which both sides import. The
  // assertions below therefore check two different things: that the shared
  // definition behaves the way both sides need, and that **neither side kept a
  // private copy** — because a copy is how the two would drift apart again,
  // and a copy is invisible to a test that only reads the shared value.
  const GROWTH_SRC = join(__dirname, '..', '..', '..', 'workers', 'growth', 'src');
  const growthSource = readFileSync(join(GROWTH_SRC, 'helpers.ts'), 'utf8');
  const gatewaySource = readFileSync(join(__dirname, 'middleware', 'rate-limit.ts'), 'utf8');

  it('is the prefix growth refuses everything else for', () => {
    expect(COUNTER_SUBJECT_PREFIX).toBe('pos:');
  });

  it('is the prefix growth requires a non-empty remainder behind', () => {
    // A gateway that treated a bare `pos:` as a counter would hand a bucket to a
    // token with no terminal in it — and growth would refuse that same token on
    // the routes it exists for. The two halves have to agree about the remainder,
    // not only about the letters.
    expect(isCounterSubject('pos:')).toBe(false);
    expect(isCounterSubject('pos:0f9c1d2e')).toBe(true);
    // And a subject that merely starts with the letters is not a counter: `pos`
    // on its own would be matched by `postmaster-3` and `POS-2`.
    expect(isCounterSubject('postmaster-3')).toBe(false);
    expect(isCounterSubject('POS-2')).toBe(false);
  });

  it('is not copied into the gateway', () => {
    // The gateway needs the literal — it builds the bucket key out of it — so
    // it imports it rather than declaring it.
    expect(gatewaySource).toContain('COUNTER_SUBJECT_PREFIX');
    expect(gatewaySource).not.toContain("'pos:'");
  });

  it('is not copied into growth either', () => {
    // Growth does not need the literal at all: it delegates the whole
    // question to the shared predicate, so a private copy here would be a
    // second answer to a question that now has one owner. Growth's own suite
    // covers what its exported predicate does with these inputs.
    expect(growthSource).not.toContain("'pos:'");
    expect(growthSource).toContain('isCounterSubjectValue');
  });
});
