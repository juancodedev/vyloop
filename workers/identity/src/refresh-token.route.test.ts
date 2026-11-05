import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { issueRefreshToken, validateToken } from './auth';

// A dedicated mock, because the shared one in `index.test.ts` returns the same
// user for every query and has no `is_active`: it cannot show that the route
// refuses a deactivated user, or a row that is not the one the token names.
const state = vi.hoisted(() => ({
  users: [] as Record<string, unknown>[],
  events: [] as string[],
}));

vi.mock('@vyloop/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vyloop/db')>();
  const dialect = new PgDialect();
  const db: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            state.events.push('select users');
            return Promise.resolve(state.users);
          },
        }),
      }),
    }),
    transaction: (work: (tx: unknown) => unknown) => work(db),
    execute: (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const { params } = dialect.sqlToQuery(query);
      state.events.push(`set_config ${params.join(' ')}`);
      return Promise.resolve();
    },
  };
  return { ...actual, createDb: () => db };
});

const SECRET = 'refresh-route-test-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const row = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  businessId: TENANT_ID,
  email: 'owner@example.com',
  role: 'staff',
  isActive: true,
  ...overrides,
});

describe('POST /v1/auth/refresh against the user row', () => {
  let app: typeof import('./index').default;
  const refresh = async (token: string) =>
    app.fetch(
      new Request('http://localhost/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: token, email: 'owner@example.com' }),
      }),
      { JWT_SECRET: SECRET, DATABASE_URL: 'postgres://mock' },
    );

  beforeAll(async () => {
    app = (await import('./index')).default;
  });

  beforeEach(() => {
    state.users = [];
    state.events = [];
  });

  it('reads the user inside the tenant named by the token, and takes the role from the row', async () => {
    state.users = [row()];
    const res = await refresh(await issueRefreshToken(SECRET, USER_ID, TENANT_ID));

    expect(res.status).toBe(200);
    const claims = await validateToken(
      SECRET,
      ((await res.json()) as { access_token: string }).access_token,
    );
    expect(claims.role).toBe('staff');
    expect(state.events[0]).toContain(TENANT_ID);
    expect(state.events.at(-1)).toBe('select users');
  });

  it('refuses a deactivated user', async () => {
    state.users = [row({ isActive: false })];
    expect((await refresh(await issueRefreshToken(SECRET, USER_ID, TENANT_ID))).status).toBe(401);
  });

  it('refuses when the row found is not the user or the tenant the token names', async () => {
    for (const other of [
      row({ id: '33333333-3333-4333-8333-333333333333' }),
      row({ businessId: '44444444-4444-4444-8444-444444444444' }),
    ]) {
      state.users = [other];
      const res = await refresh(await issueRefreshToken(SECRET, USER_ID, TENANT_ID));
      expect(res.status).toBe(401);
      expect(await res.json()).not.toHaveProperty('access_token');
    }
  });

  it('refuses a token whose user no longer exists', async () => {
    expect((await refresh(await issueRefreshToken(SECRET, USER_ID, TENANT_ID))).status).toBe(401);
  });
});
