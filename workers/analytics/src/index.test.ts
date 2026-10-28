import { describe, expect, it, vi } from 'vitest';

/**
 * Both routes read tenant tables, so both must run their queries inside a
 * transaction that names the business first. `set_config(..., true)` only
 * lasts for the transaction it runs in: issued on the outer database it would
 * be gone before the next query.
 */

const handles = vi.hoisted(() => {
  const statements: Array<{ on: 'db' | 'tx'; sql: string }> = [];
  const render = (query: unknown) => JSON.stringify(query);
  const tx = {
    execute: async (query: unknown) => {
      statements.push({ on: 'tx', sql: render(query) });
      return { rows: [] };
    },
  };
  const db = {
    execute: async (query: unknown) => {
      statements.push({ on: 'db', sql: render(query) });
      return { rows: [] };
    },
    transaction: async <T>(fn: (handle: typeof tx) => Promise<T>) => fn(tx),
  };
  return { db, statements };
});

vi.mock('@vyloop/db', async () => ({
  ...(await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db')),
  createDb: () => handles.db,
}));

const { default: worker } = await import('./index');

const AUTH = { 'X-User-Id': 'user-1', 'X-Business-Id': 'biz-1', 'X-User-Role': 'admin' };

describe('tenant scope', () => {
  it.each(['/v1/analytics/kpis', '/v1/analytics/timeline'])(
    '%s runs every query on a transaction scoped to the business',
    async (path) => {
      handles.statements.length = 0;

      const res = await worker.fetch(new Request(`http://analytics${path}`, { headers: AUTH }), {
        DATABASE_URL: 'postgres://test',
      } as never);

      expect(res.status).toBe(200);
      expect(handles.statements.length).toBeGreaterThan(1);
      expect(handles.statements.every((s) => s.on === 'tx')).toBe(true);
      expect(handles.statements[0]!.sql).toContain("set_config('app.current_business_id'");
    },
  );
});
