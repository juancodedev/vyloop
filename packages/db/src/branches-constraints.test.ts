import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { branches } from './schema';

// ---------------------------------------------------------------------------
// The two constraints that make a position a position.
//
// They live in two places on purpose: in the Drizzle schema, which is what
// `drizzle-kit generate` reads, and in the migration, which is what a person
// applies by hand. Those two can disagree, and nothing in the database stops
// them: the schema is a description and the migration is a fact.
//
// So both are asserted here, and — the part that matters — they are asserted
// **against each other**. A constraint that exists in one and not the other is
// the failure this file exists to catch: a migration that writes a constraint
// the schema does not declare, or a schema that declares one no migration
// creates. The second one is the quieter of the two, because the next
// `drizzle-kit generate` would read the schema, decide the constraint is
// already there, and never emit it.
//
// The assertions are on the rendered SQL rather than on the shape of the
// builder, because the rendered SQL is what the database is asked to enforce.
// ---------------------------------------------------------------------------

const DRIZZLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const MIGRATION = readFileSync(path.join(DRIZZLE_DIR, '0014_branch_geolocation.sql'), 'utf8');

const PAIR_CONSTRAINT = 'branches_coordinates_pair_chk';
const RANGE_CONSTRAINT = 'branches_coordinates_range_chk';

describe('the branches coordinate constraints', () => {
  const declared = new Map(
    getTableConfig(branches).checks.map((check) => [check.name, check]),
  );
  const dialect = new PgDialect();

  /** The SQL the database would be asked to enforce for one constraint. */
  function rendered(name: string): string {
    const check = declared.get(name);
    expect(check, `${name} is not declared on the branches table`).toBeDefined();
    return dialect.sqlToQuery(check!.value).sql;
  }

  describe('in the schema', () => {
    it('declares the pair constraint', () => {
      expect(declared.has(PAIR_CONSTRAINT)).toBe(true);
    });

    it('declares the range constraint', () => {
      expect(declared.has(RANGE_CONSTRAINT)).toBe(true);
    });

    it('makes the pair constraint "both or neither"', () => {
      // A half-written position is not a position. The equality of the two
      // "is null" tests is what says it: a row with a latitude and no
      // longitude has one true and one false, which the constraint rejects.
      expect(rendered(PAIR_CONSTRAINT)).toBe(
        '("branches"."latitude" is null) = ("branches"."longitude" is null)',
      );
    });

    it('makes the range constraint the globe', () => {
      expect(rendered(RANGE_CONSTRAINT)).toBe(
        '"branches"."latitude" between -90 and 90 and "branches"."longitude" between -180 and 180',
      );
    });

    it('declares no constraint on the columns it does not guard', () => {
      // A third constraint here would be a rule nobody wrote down, enforced on
      // every write. The count is the assertion.
      expect(declared.size).toBe(2);
    });
  });

  describe('in the migration', () => {
    it('applies the same two constraints', () => {
      expect(MIGRATION).toContain(`ADD CONSTRAINT "${PAIR_CONSTRAINT}"`);
      expect(MIGRATION).toContain(`ADD CONSTRAINT "${RANGE_CONSTRAINT}"`);
    });

    it('agrees with the schema, statement for statement', () => {
      // The agreement, not the presence. A constraint the schema declares and
      // the migration does not create is a rule that exists in the description
      // and not in the database.
      for (const name of [PAIR_CONSTRAINT, RANGE_CONSTRAINT]) {
        const declaredInMigration = new RegExp(
          `ADD CONSTRAINT "${name}" CHECK \\((.+)\\);`,
        ).exec(MIGRATION);

        expect(declaredInMigration, `${name} is not in the migration file`).not.toBeNull();
        expect(declaredInMigration![1]).toBe(rendered(name));
      }
    });
  });
});
