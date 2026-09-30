import type { createDb } from '@vyloop/db';
import { setCurrentBusinessId, slugify } from '@vyloop/db';
import { sql } from 'drizzle-orm';

/**
 * Self-service business signup — slice A1 of the onboarding feature.
 *
 * Four writes, one transaction: the tenant, the administrator, the loyalty
 * program and the first membership tier. The fifth write the feature calls for
 * — the Google Wallet class plus its `tenant_wallet_programs` row — is
 * deliberately absent. It is the only write that can fail for a reason outside
 * our control, and it is the only one that decides whether a customer gets a
 * card today. Keeping it out is what lets this endpoint commit a usable
 * business now and a card later, instead of stranding a half-registered tenant
 * when Google's API is down. Slice A2 adds it, with the retry.
 *
 * **Raw SQL, not the Drizzle builder.** `db.transaction` appears in exactly one
 * production place in the repo (`workers/growth/src/routes.ts:1171`) and it
 * drives it with `tx.execute(sql\`...\`)` exclusively. Four separate tables with
 * four different column sets would otherwise mean four builder chains whose
 * result shapes each need unpacking, and the one transaction in the codebase
 * has nothing to recommend the alternative.
 *
 * **RLS ordering.** `tenants` is the root table and has no policy, so its
 * insert needs no session. The other three are in `BUSINESS_ID_TABLES` and
 * their policies read `app.current_business_id`, a value that does not exist
 * until the tenant insert returns the id it just minted. The `set_config` is
 * therefore *inside* the transaction and *after* the first insert — moving it
 * earlier is not a reordering, it makes the remaining three inserts write rows
 * no policy admits, which is a silent zero-row insert rather than an error.
 */

/**
 * The `db` handle shape this module needs. Structurally the real one, and
 * exported so a test can type its mock against the same contract the production
 * call site is checked against.
 */
export type SignupDb = ReturnType<typeof createDb>;

export interface BusinessSignupInput {
  /** Display name. Also the source of the derived slug. */
  name: string;
  /** Administrator email. Unique per tenant, not globally. */
  adminEmail: string;
  /** Administrator password, already checked against the admission policy. */
  adminPasswordHash: string;
  /** Optional display name for the administrator. `| undefined` because the
   *  repo compiles with `exactOptionalPropertyTypes`, so a caller that resolved
   *  the field to `undefined` has to be allowed to say so. */
  adminFullName?: string | undefined;
}

export interface BusinessSignupResult {
  businessId: string;
  name: string;
  slug: string;
  adminUserId: string;
  loyaltyProgramId: string;
  firstTierId: string;
}

export type SignupOutcome =
  | { ok: true; value: BusinessSignupResult }
  | { ok: false; code: 'SLUG_TAKEN'; slug: string };

/**
 * The first tier every new business starts on.
 *
 * Values mirror the `Bronce` row in `packages/db/scripts/seed.ts` so a business
 * created here and one created by hand sit in the same ladder. `benefits` is
 * passed as a real JSON array rather than left to the column default, which is
 * the *string* `'[]'` — a seed of `"[]"` that the dashboard would have to
 * tolerate as either a string or a list depending on which writer made the row.
 * One shape for every `membership_tiers.benefits` value in the database is worth
 * more here than a one-token shorter INSERT.
 */
const FIRST_TIER = {
  name: 'Bronce',
  minPoints: 0,
  multiplier: '1.0',
  displayOrder: 1,
  benefits: [{ title: 'Beneficios básicos', description: 'Acceso al programa y acumulación de puntos' }],
} as const;

/**
 * Postgres `unique_violation`. Every unique rejection in this flow is the slug,
 * because the other three writes are either unconstrained (`membership_tiers`
 * has no unique index at all) or constrained on values this function just
 * minted, so a violation there is a bug rather than user input.
 */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

function firstRow<T>(result: { rows?: T[] } | null | undefined): T | undefined {
  return result?.rows?.[0];
}

/**
 * Create a business: tenant, administrator, loyalty program, first tier.
 *
 * `plan` and `status` are left to their column defaults (`free`, `active`)
 * rather than written explicitly. A self-service tenant starts on the free plan,
 * and a signup that hardcoded `premium` would be a billing decision made in an
 * insert statement. Same reasoning for the locale columns: `CL` / `CLP` /
 * `America/Santiago` / `es-CL` are already the defaults, and a business outside
 * Chile is the slice that exposes them as input.
 *
 * @returns `SLUG_TAKEN` when the derived slug is already in use, or the ids of
 *          everything created. Anything else propagates, so the caller decides
 *          what a 500 looks like.
 */
export async function signupBusiness(
  db: SignupDb,
  input: BusinessSignupInput,
): Promise<SignupOutcome> {
  const slug = slugify(input.name);

  // The empty slug is a normalisation result, not a database error: a business
  // named `!!!` derives one, and inserting `''` would succeed and then collide
  // with the next business also named `!!!`. The caller turns this into a 400.
  if (!slug) {
    throw new SlugNotDerivableError(input.name);
  }

  // Pre-check, so the common duplicate gets a precise rejection rather than a
  // decoded driver error. `tenants` carries no RLS policy, so this reads without
  // a session. NOT sufficient on its own — two concurrent signups for the same
  // name both pass here, and the second is rejected by the index at insert time.
  // That is why the INSERT is also guarded below; this is an ergonomics layer,
  // the unique index is the actual arbiter.
  const existing = await db.execute(sql`SELECT id FROM tenants WHERE slug = ${slug} LIMIT 1`);
  if ((existing.rows?.length ?? 0) > 0) {
    return { ok: false, code: 'SLUG_TAKEN', slug };
  }

  try {
    const created = await db.transaction(async (tx) => {
      // 1. Tenant. No RLS session yet, and none needed.
      const tenant = firstRow(
        await tx.execute(
          sql`INSERT INTO tenants (name, slug) VALUES (${input.name}, ${slug}) RETURNING id`,
        ),
      );
      if (!tenant) throw new TenantInsertFailedError();

      const businessId = tenant.id as string;

      // 2..4 need a policy-visible business id. See the module note on ordering.
      await tx.execute(setCurrentBusinessId(businessId));

      const admin = firstRow(
        await tx.execute(
          sql`INSERT INTO users (business_id, email, full_name, role, password_hash, is_active)
              VALUES (${businessId}::uuid, ${input.adminEmail},
                      ${input.adminFullName ?? null}, 'admin', ${input.adminPasswordHash}, true)
              RETURNING id`,
        ),
      );
      if (!admin) throw new UserInsertFailedError();

      // `loyalty_programs.business_id` is `.unique()`, so "exactly one points
      // currency per tenant" is a database invariant rather than a convention
      // this route has to maintain. The name is derived from the business name
      // the way the seed does it, so a merchant sees their own name on their
      // own program.
      const program = firstRow(
        await tx.execute(
          sql`INSERT INTO loyalty_programs (business_id, name, points_currency, earn_rate, min_redeem_points, is_active)
              VALUES (${businessId}::uuid, ${`Programa de Lealtad ${input.name}`}, 'puntos', '1.0', 100, true)
              RETURNING id`,
        ),
      );
      if (!program) throw new LoyaltyProgramInsertFailedError();

      const tier = firstRow(
        await tx.execute(
          sql`INSERT INTO membership_tiers
                (business_id, program_id, name, min_points, multiplier, benefits, display_order)
              VALUES (
                ${businessId}::uuid,
                ${program.id as string}::uuid,
                ${FIRST_TIER.name},
                ${FIRST_TIER.minPoints},
                ${FIRST_TIER.multiplier},
                ${JSON.stringify(FIRST_TIER.benefits)}::jsonb,
                ${FIRST_TIER.displayOrder}
              )
              RETURNING id`,
        ),
      );
      if (!tier) throw new TierInsertFailedError();

      return {
        businessId,
        name: input.name,
        slug,
        adminUserId: admin.id as string,
        loyaltyProgramId: program.id as string,
        firstTierId: tier.id as string,
      };
    });

    return { ok: true, value: created };
  } catch (err) {
    // The race the pre-check cannot see. Mapped here rather than left to the
    // route so the caller never has to know which layer rejected the slug.
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'SLUG_TAKEN', slug };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Typed failures
//
// `RETURNING` on a successful INSERT always yields a row, so an empty result
// means the statement was accepted and produced nothing — the one case where a
// transaction is about to commit with a hole in it. Throwing rolls it back
// rather than letting the caller discover the missing tier when a customer's
// first purchase has nowhere to land. Each is distinct from the next because
// the messages are the only thing telling an on-call engineer which of the four
// writes broke.
// ---------------------------------------------------------------------------

export class SlugNotDerivableError extends Error {
  constructor(name: string) {
    super(
      `Cannot derive a slug from the business name "${name}": it contains no letters or digits.`,
    );
    this.name = 'SlugNotDerivableError';
  }
}

export class TenantInsertFailedError extends Error {
  constructor() {
    super('INSERT INTO tenants returned no row');
    this.name = 'TenantInsertFailedError';
  }
}

export class UserInsertFailedError extends Error {
  constructor() {
    super('INSERT INTO users returned no row');
    this.name = 'UserInsertFailedError';
  }
}

export class LoyaltyProgramInsertFailedError extends Error {
  constructor() {
    super('INSERT INTO loyalty_programs returned no row');
    this.name = 'LoyaltyProgramInsertFailedError';
  }
}

export class TierInsertFailedError extends Error {
  constructor() {
    super('INSERT INTO membership_tiers returned no row');
    this.name = 'TierInsertFailedError';
  }
}
