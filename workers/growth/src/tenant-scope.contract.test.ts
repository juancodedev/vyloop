/**
 * Every read and write of a tenant table here names the business.
 *
 * Postgres RLS is not in force yet (no policies are deployed, and the tenant
 * setting is issued outside a transaction), so the `business_id` in each
 * query is the only thing that keeps one business's rows away from another.
 * Most of the queries below only touch ids that were already looked up within
 * the business, but a query should not depend on an earlier one to stay
 * in-tenant: the next edit to the handler can drop that earlier lookup.
 *
 * Read from source, like the other contract tests, because these statements
 * are spread across handlers that would each need their own database harness.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sources = ['routes.ts', 'event-handler.ts'].map((file) => ({
  file,
  text: readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'),
}));

describe('growth queries name the business', () => {
  it('reads a balance from points_transactions within the business', () => {
    for (const { file, text } of sources) {
      const balanceReads = [
        ...text.matchAll(/FROM points_transactions WHERE customer_id = [^)]*?ORDER BY/g),
      ].map((m) => m[0]);

      expect(balanceReads.length, file).toBeGreaterThan(0);
      for (const read of balanceReads) {
        expect(read, `${file}: ${read}`).toMatch(/AND business_id = \$\{businessId\}::uuid/);
      }
    }
  });

  it('never selects, updates or deletes a tier, reward, program or check-in by id alone', () => {
    for (const { file, text } of sources) {
      const byIdAlone = [
        ...text.matchAll(
          /\.where\(\s*eq\(\s*(membershipTiers|rewards|loyaltyPrograms|rewardBranches|checkins)\.(id|rewardId),[^()]*\)\s*\)/g,
        ),
      ].map((m) => m[0]);

      expect(byIdAlone, file).toEqual([]);
    }
  });

  it('decrements a reward’s stock within the business', () => {
    const routes = sources.find((s) => s.file === 'routes.ts')!.text;
    const decrement = /UPDATE rewards SET stock = stock - 1 WHERE[^`]*/.exec(routes)?.[0];

    expect(decrement).toBeDefined();
    expect(decrement).toMatch(/business_id = \$\{businessId\}::uuid/);
  });
});
