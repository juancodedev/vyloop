// ---------------------------------------------------------------------------
// The business's venues.
//
// Four operations, one table, and one tenant boundary that is enforced twice:
// once by the `where` on every read and write, and once by the row-level
// security context that the same transaction arms.
//
// ## Why the tenant filter is the isolation, and the session context is the
// second line
//
// `branches` is listed in `BUSINESS_ID_TABLES`, so it receives a policy when
// the row-level security rollout runs. Until then that policy does not exist,
// and a query that filtered on nothing would return every venue in the
// platform.
//
// So the filter is written into every statement here, with a `business_id`
// that comes from the caller's signed token and not from the request path.
// The session context is armed in the same transaction, which is what makes
// the policy correct the day it is enabled — and it is armed *inside* the
// transaction rather than before it, because a pooled connection would not
// carry it to the next statement.
// ---------------------------------------------------------------------------

import type { createDb } from '@vyloop/db';
import { branches, setCurrentBusinessId } from '@vyloop/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

import type { BranchLocation } from './branch-location';

export type BranchesDb = ReturnType<typeof createDb>;

/**
 * The columns a caller is shown.
 *
 * Named explicitly rather than selected wholesale, so the shape of the
 * response is a decision that is written down here instead of a consequence of
 * whatever the table happens to carry. A column added to the table for an
 * internal purpose does not become part of the public surface by accident.
 */
const BRANCH_COLUMNS = {
  id: branches.id,
  name: branches.name,
  address: branches.address,
  city: branches.city,
  country: branches.country,
  timezone: branches.timezone,
  is_active: branches.isActive,
  latitude: branches.latitude,
  longitude: branches.longitude,
  geohash: branches.geohash,
  geohash_precision: branches.geohashPrecision,
  located_at: branches.locatedAt,
} as const;

/** A row as the database hands it back. */
interface BranchRow {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string;
  timezone: string | null;
  is_active: boolean;
  latitude: string | null;
  longitude: string | null;
  geohash: string | null;
  geohash_precision: number | null;
  located_at: Date | null;
}

/** A venue as the API returns it. */
export interface BranchView {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string;
  timezone: string | null;
  is_active: boolean;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  geohash_precision: number | null;
  located_at: string | null;
}

/**
 * Turn a row into the response shape.
 *
 * The coordinates are numeric in the database, so they arrive as strings —
 * `numeric(9,6)` is exact decimal and the driver hands it over as text
 * rather than as a double, because a double would carry the binary rounding
 * error the column type exists to avoid. They are converted here for the
 * response, and the conversion is the only place a double touches them.
 */
function toBranchView(row: BranchRow): BranchView {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    country: row.country,
    timezone: row.timezone,
    is_active: row.is_active,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    geohash: row.geohash,
    geohash_precision: row.geohash_precision,
    located_at: row.located_at === null ? null : row.located_at.toISOString(),
  };
}

/**
 * Every statement in here runs inside a transaction that arms the tenant
 * context first.
 *
 * The transaction is not decoration: `set_config(..., true)` is scoped to the
 * transaction, and the pool hands out connections per statement, so a context
 * set outside a transaction would not be there for the query that follows it.
 *
 * The transaction is opened inline in each operation rather than through a
 * shared helper, so that the transaction client keeps its own concrete type.
 * A helper would have to name that type, and the only way to name it is to
 * write out Drizzle's generics by hand — and a type written out by hand is one
 * that stops matching the moment Drizzle's shape changes.
 */

/**
 * Every venue this business owns.
 *
 * Ordered by name, because a list of places is read by name and an unordered
 * list of them is a list that moves between two consecutive requests.
 */
export async function listBranches(db: BranchesDb, businessId: string): Promise<BranchView[]> {
  return db.transaction(async (tx) => {
    await tx.execute(setCurrentBusinessId(businessId));

    const rows = (await tx
      .select(BRANCH_COLUMNS)
      .from(branches)
      .where(eq(branches.businessId, businessId))
      .orderBy(asc(branches.name))) as BranchRow[];

    return rows.map(toBranchView);
  });
}

/** What a caller may set when creating a venue. */
export interface CreateBranchInput {
  businessId: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string;
  timezone: string | null;
  /** `null` means the venue has not registered a position. */
  location: BranchLocation | null;
}

/**
 * Register a venue.
 *
 * The tenant is the caller's, not the caller's word for it: `businessId`
 * comes from the signed token and the route refuses a path that names a
 * different business before it gets here.
 */
export async function createBranch(db: BranchesDb, input: CreateBranchInput): Promise<BranchView> {
  return db.transaction(async (tx) => {
    await tx.execute(setCurrentBusinessId(input.businessId));

    const rows = (await tx
      .insert(branches)
      .values({
        businessId: input.businessId,
        name: input.name,
        address: input.address,
        city: input.city,
        country: input.country,
        timezone: input.timezone,
        isActive: true,
        // `numeric` is written as text on purpose. The column is an exact
        // decimal, and a decimal that went through a JavaScript number would
        // already have lost the precision the column type exists to keep —
        // `(-33.4489).toFixed(6)` is the exact decimal the column holds, and
        // passing the number would be passing something else.
        latitude: input.location ? input.location.latitude.toFixed(6) : null,
        longitude: input.location ? input.location.longitude.toFixed(6) : null,
        geohash: input.location?.geohash ?? null,
        geohashPrecision: input.location?.geohashPrecision ?? null,
        // Stamped by the database, not by this process, so the time a position
        // was recorded is the time the write happened.
        locatedAt: input.location ? sql`now()` : null,
      })
      .returning(BRANCH_COLUMNS)) as BranchRow[];

    const created = rows[0];
    if (!created) {
      throw new Error('The venue was not created.');
    }
    return toBranchView(created);
  });
}

/** What a caller may change about a venue. */
export interface UpdateBranchInput {
  businessId: string;
  branchId: string;
  /** Only the fields that were sent. `undefined` means "leave this alone". */
  fields: {
    name?: string | undefined;
    address?: string | null | undefined;
    city?: string | null | undefined;
    country?: string | undefined;
    timezone?: string | null | undefined;
  };
  /**
   * The position.
   *
   * `undefined` leaves it alone, `null` clears it, and an object sets it. The
   * three states are distinct because "do not touch it" and "remove it" are
   * different requests, and a partial update that could not express the
   * difference would clear a position nobody asked to clear.
   */
  location?: BranchLocation | null | undefined;
}

/**
 * Change a venue.
 *
 * Returns `null` when this business does not own a venue with that id. The
 * caller answers 404 with the same code and message it uses for a venue that
 * does not exist at all: a business that asks about a venue belonging to
 * another business should not be able to tell the two apart.
 */
export async function updateBranch(
  db: BranchesDb,
  input: UpdateBranchInput,
): Promise<BranchView | null> {
  return db.transaction(async (tx) => {
    await tx.execute(setCurrentBusinessId(input.businessId));

    // Typed against the table's own update shape, so a column written here is
    // checked against the column it names. An untyped bag of values would let
    // a misspelled or mistyped column through to the database.
    const values: PgUpdateSetSource<typeof branches> = {};

    if (input.fields.name !== undefined) values.name = input.fields.name;
    if (input.fields.address !== undefined) values.address = input.fields.address;
    if (input.fields.city !== undefined) values.city = input.fields.city;
    if (input.fields.country !== undefined) values.country = input.fields.country;
    if (input.fields.timezone !== undefined) values.timezone = input.fields.timezone;

    if (input.location !== undefined) {
      if (input.location === null) {
        values.latitude = null;
        values.longitude = null;
        values.geohash = null;
        values.geohashPrecision = null;
        values.locatedAt = null;
      } else {
        values.latitude = input.location.latitude.toFixed(6);
        values.longitude = input.location.longitude.toFixed(6);
        values.geohash = input.location.geohash;
        values.geohashPrecision = input.location.geohashPrecision;
        // Re-stamped on every write of a position, because "when the venue
        // asserted this position" has to mean the last time it asserted it.
        values.locatedAt = sql`now()`;
      }
    }

    if (Object.keys(values).length === 0) {
      // Nothing to write. The row is still read, so a request that changes
      // nothing answers with the venue as it is rather than with a 400.
      const existing = (await tx
        .select(BRANCH_COLUMNS)
        .from(branches)
        .where(and(eq(branches.businessId, input.businessId), eq(branches.id, input.branchId)))) as
        BranchRow[] | undefined;
      const row = existing?.[0];
      return row ? toBranchView(row) : null;
    }

    const rows = (await tx
      .update(branches)
      .set(values)
      .where(and(eq(branches.businessId, input.businessId), eq(branches.id, input.branchId)))
      .returning(BRANCH_COLUMNS)) as BranchRow[];

    const updated = rows[0];
    return updated ? toBranchView(updated) : null;
  });
}

/**
 * Deactivate a venue.
 *
 * It does not delete the row, and that is the whole point of the decision.
 * `users.branch_id` points at a venue, and so does the history of every
 * check-in and redemption that happened there. A hard delete would either
 * fail on those references or take the record of them with it; deactivating
 * takes the venue out of every list and leaves what it was.
 *
 * `is_active` is what the column has always been for.
 */
export async function deactivateBranch(
  db: BranchesDb,
  input: { businessId: string; branchId: string },
): Promise<BranchView | null> {
  return setBranchActive(db, input, false);
}

/**
 * Bring a deactivated venue back. Deactivation kept the row and its history,
 * so this only flips `is_active`; the position and the rest stay as they were.
 */
export async function reactivateBranch(
  db: BranchesDb,
  input: { businessId: string; branchId: string },
): Promise<BranchView | null> {
  return setBranchActive(db, input, true);
}

async function setBranchActive(
  db: BranchesDb,
  input: { businessId: string; branchId: string },
  isActive: boolean,
): Promise<BranchView | null> {
  return db.transaction(async (tx) => {
    await tx.execute(setCurrentBusinessId(input.businessId));

    const rows = (await tx
      .update(branches)
      .set({ isActive })
      .where(and(eq(branches.businessId, input.businessId), eq(branches.id, input.branchId)))
      .returning(BRANCH_COLUMNS)) as BranchRow[];

    const updated = rows[0];
    return updated ? toBranchView(updated) : null;
  });
}
