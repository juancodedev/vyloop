import { defineConfig } from 'drizzle-kit';

// `schema` must stay a single entry pointing at `src/schema.ts`, and every
// index must stay declared inside a table's extra-config callback in that file.
//
// Do not "fix" a missing-index problem by adding `./src/indexes.ts` here as a
// second entry. That was measured against drizzle-kit 0.31.10 and it is a
// no-op: drizzle-kit reports every table with `0 indexes` and emits no
// `CREATE INDEX`, because an index builder exported at module scope is never
// claimed by a table, so the introspector discards it. The reason is recorded
// at the top of `src/schema.ts`, and `src/migration-sql.test.ts` fails if a
// `CREATE INDEX` ever goes missing from a generated migration again.
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
