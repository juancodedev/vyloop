// @vitest-environment node

/**
 * The customer PATCH field names are declared once, and both consumers read that
 * one declaration.
 *
 * ## The failure this prevents
 *
 * The server accepting `fullName` while the form sends `full_name` is the worst
 * kind of bug in this repository: no error, no crash, a 200 — and nothing
 * written. The operator closes the form believing the name changed and finds out
 * from the customer. A shared constant is the only thing that cannot drift,
 * because there is only one string to be wrong about.
 *
 * So this test does two things. It runs the real constant through the real
 * request body to prove the round trip works end to end, and it reads the two
 * consumers as source to prove neither one holds a private copy.
 *
 * The source scan is the part that catches drift. An import can be correct today
 * and be replaced by an inline literal tomorrow, and nothing at runtime would
 * notice — the same blindness that let the sidebar keep a link to a route that
 * did not exist (`navigation.contract.test.ts`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CUSTOMER_PATCH_ERROR, CUSTOMER_PATCHABLE_FIELDS } from './index';

const repoRoot = new URL('../../../', import.meta.url).pathname;

/** Source roots that could plausibly grow a second copy of the list. */
const SCANNED_ROOTS = ['apps', 'workers', 'packages', 'services'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const allSource = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root)));

/** The one file allowed to declare the list, plus this guard, which quotes it. */
const declarationSite = join(repoRoot, 'packages/types/src/index.ts');
const thisFile = new URL(import.meta.url).pathname;

/**
 * True when the source declares the list again.
 *
 * ## Why "an array of exactly these four" and not "mentions all four"
   *
 * The first version of this test looked for a file containing all four names,
 * and it reported four files, every one of them innocent: the public
 * registration form in `apps/customer-web`, its own contract test, and this
 * guard's assertion. A guard that fires on a form which legitimately has a name,
 * a phone, an email and a birth date gets switched off, and then it is guarding
 * nothing.
 *
 * So it looks for the thing that would actually drift: a second *declaration* —
 * an array literal whose quoted entries are exactly these four fields and
 * nothing else. A form, a label, a test asserting that `email` is left alone has
 * no such literal, so it is not reported.
 */
function redeclaresTheFieldList(source: string): boolean {
  for (const literal of source.match(/\[[^\][]*\]/g) ?? []) {
    const entries = [...literal.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    if (entries.length !== CUSTOMER_PATCHABLE_FIELDS.length) continue;
    const asSet = new Set(entries);
    if (CUSTOMER_PATCHABLE_FIELDS.every((field) => asSet.has(field))) return true;
  }
  return false;
}

describe('the customer PATCH contract', () => {
  it('names exactly the four fields a counter can correct', () => {
    // Not an arbitrary list: these are the ones the edit form renders, and the
    // ones `PATCH /v1/customers/:id` accepts. If this changes, both the reason in
    // `@vyloop/types` and the reason in the route have to change with it.
    expect([...CUSTOMER_PATCHABLE_FIELDS]).toEqual(['fullName', 'phone', 'email', 'birthDate']);
  });

  it('declares that list in exactly one file', () => {
    const copies = allSource
      .filter((file) => file !== declarationSite && file !== thisFile)
      .filter((file) => redeclaresTheFieldList(readFileSync(file, 'utf8')))
      .map((file) => file.slice(repoRoot.length));

    expect(copies, `a second declaration of the allowlist in: ${copies.join(', ')}`).toEqual([]);
  });

  it('is what the worker route reads', () => {
    const route = readFileSync(join(repoRoot, 'workers/customer/src/routes.ts'), 'utf8');

    expect(route).toMatch(/import\s*{[^}]*CUSTOMER_PATCHABLE_FIELDS[^}]*}\s*from\s*'@vyloop\/types'/);
    // And the refusal names the same list, so an operator is told what they CAN
    // change rather than only what they cannot.
    expect(route).toContain('CUSTOMER_PATCHABLE_FIELDS.join');
    // A local `const EDITABLE = [...]` beside the import would satisfy the import
    // check and defeat everything above.
    expect(route).not.toMatch(/const\s+\w*(EDITABLE|ALLOWED|PATCHABLE|FIELDS)\w*\s*(:[^=]+)?=\s*\[/);
  });

  it('is what the dashboard client reads', () => {
    const client = readFileSync(join(repoRoot, 'apps/dashboard/src/lib/api.ts'), 'utf8');

    expect(client).toMatch(/from\s*'@vyloop\/types'/);
    expect(client).toContain('CUSTOMER_PATCHABLE_FIELDS');
  });

  it('shares the error codes, so the form branches on the same strings', () => {
    // A retyped code fails the same way a retyped field name does, only later:
    // the form falls through to a generic message and the operator is told the
    // save failed for no stated reason.
    const copies = allSource
      .filter((file) => file !== declarationSite)
      .filter((file) =>
        Object.values(CUSTOMER_PATCH_ERROR).some((code) =>
          readFileSync(file, 'utf8').includes(`'${code}'`),
        ),
      )
      .map((file) => file.slice(repoRoot.length));

    expect(copies, `the error codes retyped in: ${copies.join(', ')}`).toEqual([]);
  });

  it('names a different code for a phone conflict than for an email one', () => {
    // The form blames the offending input. One shared "already taken" code would
    // force it to blame both, or neither.
    expect(CUSTOMER_PATCH_ERROR.PHONE_TAKEN).not.toBe(CUSTOMER_PATCH_ERROR.EMAIL_TAKEN);
  });

  it('tells the four fields apart from the columns that stay locked', () => {
    for (const column of ['globalId', 'deletedAt', 'id', 'currentTierId', 'memberCode', 'metadata']) {
      expect(CUSTOMER_PATCHABLE_FIELDS as readonly string[]).not.toContain(column);
    }
  });

  it('names no field the customers table does not have', () => {
    // A typo in the shared constant would be refused by every request, forever,
    // with a message telling the operator the field does not exist. Cheap to
    // catch here.
    const schema = readFileSync(join(repoRoot, 'packages/db/src/schema.ts'), 'utf8');
    const customerTable = schema.slice(schema.indexOf("pgTable('customers'"), schema.indexOf('unique(\'uq_customers_business_phone\''));

    for (const field of CUSTOMER_PATCHABLE_FIELDS) {
      expect(customerTable, `${field} is not a column of customers`).toContain(`${field}:`);
    }
    expect(basename(declarationSite)).toBe('index.ts');
  });
});
