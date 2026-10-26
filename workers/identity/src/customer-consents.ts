import { consents, customers } from '@vyloop/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * The id space a consent row lives in.
 *
 * The rest of the platform reads consents with `customers.id` — the internal
 * primary key — while a customer token carries `customers.global_id`. The
 * identity routes used to write `claims.sub` directly into `customer_id`,
 * which the foreign key did not catch because the migration omitted it, so the
 * rows landed under a key nobody reads. Resolving here, on every read and write,
 * is the one place that fixes both sides at once.
 */

export async function resolveCustomerId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  globalId: string,
  businessId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(eq(customers.globalId, globalId), eq(customers.businessId, businessId), isNull(customers.deletedAt)),
    )
    .limit(1);

  return (row as { id: string } | undefined)?.id ?? null;
}

export async function readCustomerConsents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  globalId: string,
  businessId: string,
): Promise<Record<string, boolean>> {
  const customerId = await resolveCustomerId(db, globalId, businessId);
  if (customerId === null) return {};

  const rows = await db
    .select()
    .from(consents)
    .where(and(eq(consents.businessId, businessId), eq(consents.customerId, customerId)));

  return (rows as Array<{ consentType: string; granted: boolean }>).reduce(
    (acc, row) => {
      acc[row.consentType] = row.granted;
      return acc;
    },
    {} as Record<string, boolean>,
  );
}

export async function recordCustomerConsent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: {
    globalId: string;
    businessId: string;
    consentType: string;
    granted: boolean;
    ipAddress: string | null;
  },
): Promise<boolean> {
  const customerId = await resolveCustomerId(db, input.globalId, input.businessId);
  if (customerId === null) return false;

  const target = [consents.businessId, consents.customerId, consents.consentType];

  if (input.granted) {
    await db
      .insert(consents)
      .values({
        businessId: input.businessId,
        customerId,
        consentType: input.consentType,
        granted: true,
        grantedAt: sql`now()`,
        revokedAt: null,
        ipAddress: input.ipAddress ?? null,
      })
      .onConflictDoUpdate({
        target,
        set: {
          granted: true,
          grantedAt: sql`now()`,
          revokedAt: null,
          ipAddress: input.ipAddress ?? null,
        },
      });
  } else {
    await db
      .insert(consents)
      .values({
        businessId: input.businessId,
        customerId,
        consentType: input.consentType,
        granted: false,
        grantedAt: null,
        revokedAt: sql`now()`,
        ipAddress: input.ipAddress ?? null,
      })
      .onConflictDoUpdate({
        target,
        set: {
          granted: false,
          revokedAt: sql`now()`,
          ipAddress: input.ipAddress ?? null,
        },
      });
  }

  return true;
}
