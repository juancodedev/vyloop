/**
 * Every write to `message_log` names the business, and no log line carries a
 * customer's phone number.
 *
 * Postgres RLS is not in force yet, so the `business_id` in each query is the
 * only tenant boundary. The rows updated here were created moments earlier in
 * the same flow, but a query should not depend on that to stay in-tenant.
 *
 * Read from source because these statements live in queue consumers that
 * would each need their own database harness.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const files = ['push-delivery.ts', 'event-handler.ts', 'routes.ts'];
const sources = files.map((file) => ({
  file,
  text: readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'),
}));

describe('communication queries name the business', () => {
  it('never updates a message_log row by id alone', () => {
    for (const { file, text } of sources) {
      const byIdAlone = [...text.matchAll(/\.where\(\s*eq\(\s*messageLog\.id,[^()]*\)\s*\)/g)].map(
        (m) => m[0],
      );
      expect(byIdAlone, file).toEqual([]);
    }
  });
});

describe('logs carry no phone number', () => {
  it('does not interpolate a phone into a console line', () => {
    for (const { file, text } of sources) {
      const phoneLogs = [...text.matchAll(/console\.\w+\([^;]*\$\{[^}]*[Pp]hone[^}]*\}/g)].map(
        (m) => m[0],
      );
      expect(phoneLogs, file).toEqual([]);
    }
  });
});
