import type { ConsentType } from '@vyloop/types';
import { and, eq } from 'drizzle-orm';

import { consents } from './schema';

// ---------------------------------------------------------------------------
// The authoritative store for a customer's consent.
//
// This table was read by two surfaces and written by none. The gates that
// decide whether a message may be sent consulted a jsonb flag on the customer
// row instead, and that flag had no writer either — so the answer was always
// "no", and the two stories could not be reconciled.
//
// These helpers are the only sanctioned way to read and write it. One
// implementation of "what has this customer agreed to" is worth more than
// three copies of the query.
//
// ## The shape of a consent
//
// One row per `(business_id, customer_id, consent_type)`. A row describes the
// **current** state and when that state began:
//
//   - `granted = true`, `granted_at` set, `revoked_at` null — agreed, and
//     agreed since `granted_at`.
//   - `granted = false`, `revoked_at` set — withdrawn. `granted_at` still
//     records the original grant, and it is null when the customer declined
//     something they were never granted.
//
// A revocation never deletes the row. What a customer agreed to, and when
// they withdrew it, is the record the table exists to keep.
// ---------------------------------------------------------------------------

/** The state of one consent. */
export interface ConsentState {
  consentType: string;
  granted: boolean;
  grantedAt: Date | null;
  revokedAt: Date | null;
}

/** Which customer, in which business. */
export interface ConsentScope {
  businessId: string;
  customerId: string;
}

/**
 * Every consent recorded for a customer, in this business.
 *
 * Scoped by both the business and the customer, because the same person is a
 * different customer at a different merchant and a consent given to one of them
 * says nothing about the other.
 */
export async function readConsents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  scope: ConsentScope,
): Promise<ConsentState[]> {
  const rows = await db
    .select({
      consentType: consents.consentType,
      granted: consents.granted,
      grantedAt: consents.grantedAt,
      revokedAt: consents.revokedAt,
    })
    .from(consents)
    .where(
      and(eq(consents.businessId, scope.businessId), eq(consents.customerId, scope.customerId)),
    );

  return rows as ConsentState[];
}

/**
 * The customer's consents as a map of type to whether it is currently granted.
 *
 * A type that was never recorded is **absent** from the map, which is not the
 * same as being present and false: absent means nobody asked, and a caller
 * that wants to know whether to ask can tell the two apart.
 */
export async function readConsentMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  scope: ConsentScope,
): Promise<Record<string, boolean>> {
  const states = await readConsents(db, scope);

  const map: Record<string, boolean> = {};
  for (const state of states) {
    map[state.consentType] = state.granted;
  }
  return map;
}

/**
 * Record a consent, or withdraw it.
 *
 * Granting sets `granted` and stamps `granted_at` with the moment the current
 * agreement began, clearing any earlier withdrawal. Withdrawing sets
 * `granted = false` and stamps `revoked_at`, keeping `granted_at` as the
 * original grant.
 *
 * Granting a consent that was already granted does not move `granted_at` back
 * to the first time: the timestamp answers "since when has this customer been
 * opted in", and a customer who withdraws and agrees again has been opted in
 * since the second time.
 */
export async function upsertConsent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: ConsentScope & {
    consentType: ConsentType;
    granted: boolean;
    ipAddress?: string | null;
  },
): Promise<void> {
  const now = new Date();
  const target = [consents.businessId, consents.customerId, consents.consentType];

  if (input.granted) {
    await db
      .insert(consents)
      .values({
        businessId: input.businessId,
        customerId: input.customerId,
        consentType: input.consentType,
        granted: true,
        grantedAt: now,
        revokedAt: null,
        ipAddress: input.ipAddress ?? null,
      })
      .onConflictDoUpdate({
        target,
        set: { granted: true, grantedAt: now, revokedAt: null, ipAddress: input.ipAddress ?? null },
      });
    return;
  }

  await db
    .insert(consents)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      consentType: input.consentType,
      granted: false,
      // Null on a first withdrawal: the customer never had it. A row that was
      // granted and then withdrawn keeps its original `granted_at`, and the
      // update below leaves it alone.
      grantedAt: null,
      revokedAt: now,
      ipAddress: input.ipAddress ?? null,
    })
    .onConflictDoUpdate({
      target,
      // `grantedAt` is deliberately absent: a withdrawal must not erase the
      // record of the original grant.
      set: { granted: false, revokedAt: now, ipAddress: input.ipAddress ?? null },
    });
}
