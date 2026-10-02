/**
 * The Drizzle read behind `/p/{slug}`.
 *
 * ## Why the gateway talks to the database at all
 *
 * The alternative was a service binding to one of the four workers that already
 * hold `DATABASE_URL`, reached through the gateway's router. That was rejected
 * for one reason: every `/v1/*` binding requires a JWT, and this page is public
 * by requirement — it is the URL Google opens while reviewing a class, with no
 * credentials of any kind. Routing it through `/v1/*` would mean inventing a
 * bypass, and the auth chain in this worker is exactly the kind of thing that
 * should not grow a public door.
 *
 * So the gateway takes `DATABASE_URL` itself, the same plain var `identity`,
 * `wallet` and `growth` already receive through `wrangler deploy --var`. It is
 * a Neon connection string in an environment variable, not a secret, and it is
 * how every other worker in this repository gets one.
 *
 * ## RLS, and why this read is shaped the way it is
 *
 * `tenants` is deliberately absent from `BUSINESS_ID_TABLES` — it is the table
 * every other table's `business_id` points at, and scoping it by itself would be
 * circular. So the slug lookup needs no session variable and works with RLS
 * either way.
 *
 * `loyalty_programs` *is* in `BUSINESS_ID_TABLES`, and once that policy is
 * enabled a read with no `app.current_business_id` set returns **no rows at
 * all** — silently, which is the failure mode that turns into "the page is
 * empty" and gets blamed on the merchant. So the tenant is resolved first, and
 * `setCurrentBusinessId` is issued with the id that lookup returned *before* the
 * program row is read.
 *
 * The ordering is load-bearing and not an optimisation: resolving the tenant is
 * what supplies the value the RLS session variable needs. Resolving it in one
 * statement joined against `loyalty_programs` would be fewer round trips and
 * would break the moment the policy is switched on.
 *
 * ## Tenant scoping
 *
 * The slug is already the tenant — `tenants.slug` is `unique`, so it names
 * exactly one row — and the program row is fetched by that row's own
 * `business_id`. Two different predicates on two different tables, neither of
 * which trusts the caller's value for anything but the lookup itself.
 */

import { createDb, loyaltyPrograms, setCurrentBusinessId, tenants } from '@vyloop/db';
import { eq } from 'drizzle-orm';

import type { MerchantPageData, MerchantPageReader } from './merchant-page';

/** The gateway's own binding, so this file states what it needs rather than importing the app's env. */
export type MerchantPageDbEnv = { DATABASE_URL: string };

/**
 * Build the reader the route depends on.
 *
 * Takes the env rather than closing over a module-level pool on purpose: a
 * Worker isolate can be reused across requests, and a pool captured at module
 * scope is exactly the kind of global state that behaves differently in a test
 * than in production. `createDb` per request is what every other worker here
 * does.
 */
export function createMerchantPageReader(env: MerchantPageDbEnv): MerchantPageReader {
  return {
    async findBySlug(slug: string): Promise<MerchantPageData | null> {
      const db = createDb(env.DATABASE_URL);

      // Step one: the tenant. `tenants` carries no RLS policy, so this is the one
      // query that works unchanged whether or not the policies are enabled.
      const [tenant] = await db
        .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);

      if (tenant === undefined) return null;

      // Step two: arm the RLS session variable with the tenant we just resolved.
      // Before the program read, always — the alternative is a query that returns
      // zero rows with no error once the policy is live.
      await db.execute(setCurrentBusinessId(tenant.id));

      const [program] = await db
        .select({
          name: loyaltyPrograms.name,
          promoCopy: loyaltyPrograms.promoCopy,
          pointsCurrency: loyaltyPrograms.pointsCurrency,
          earnRate: loyaltyPrograms.earnRate,
          minRedeemPoints: loyaltyPrograms.minRedeemPoints,
        })
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.businessId, tenant.id))
        .limit(1);

      // Every optional field is normalised to `null` rather than passed through,
      // matching `findPromoCopy` and `findProgramName` in the wallet store: the
      // page omits a block it has no data for, so `''` must not reach it as a
      // value that renders as an empty section.
      return {
        tenantId: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        programName: blankToNull(program?.name),
        promoCopy: blankToNull(program?.promoCopy),
        pointsCurrency: blankToNull(program?.pointsCurrency),
        // `numeric` arrives as a string and is rendered verbatim. Formatting it
        // here would mean inventing a locale rule for a value that has none.
        earnRate: program?.earnRate ?? null,
        minRedeemPoints: program?.minRedeemPoints ?? null,
      };
    },
  };
}

/** `undefined`, `null` and a blank string all mean "this merchant wrote nothing". */
function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  return value;
}