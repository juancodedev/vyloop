/**
 * The database-backed half of nearby locations.
 *
 * A port rather than methods on `WalletStore`: the store's contract is about
 * the pass lifecycle, and widening it for two reads would have made every
 * existing fake implement them. This is the only seam the issuance path needs.
 */

import { branches, readConsentMap } from '@vyloop/db';
import { and, desc, eq, isNotNull } from 'drizzle-orm';

import { NEARBY_CONSENT_TYPE, selectMerchantLocations } from './locations';
import type { LocatedVenue } from './locations';
import type { MerchantLocation } from './object';

/** What the object builder asks before it puts positions on a pass. */
export interface LocationsSource {
  merchantLocationsFor(customerId: string, tenantId: string): Promise<MerchantLocation[]>;
}

/** The row shape the venue query answers with. */
interface VenueRow {
  latitude: string | null;
  longitude: string | null;
  locatedAt: Date | null;
}

/**
 * Read the positions this customer's pass may carry.
 *
 * Consent first. A customer without `nearby_notifications` gets an empty list
 * even when every venue is located, because the pass is where that consent has
 * to be enforced: the class is shared by every holder.
 */
export function createLocationsSource(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): LocationsSource {
  return {
    async merchantLocationsFor(customerId: string, tenantId: string): Promise<MerchantLocation[]> {
      const consents = await readConsentMap(db, { businessId: tenantId, customerId });
      if (consents[NEARBY_CONSENT_TYPE] !== true) {
        return [];
      }

      const rows = (await db
        .select({
          latitude: branches.latitude,
          longitude: branches.longitude,
          locatedAt: branches.locatedAt,
        })
        .from(branches)
        .where(
          and(
            eq(branches.businessId, tenantId),
            eq(branches.isActive, true),
            isNotNull(branches.latitude),
            isNotNull(branches.longitude),
          ),
        )
        .orderBy(desc(branches.locatedAt))) as VenueRow[];

      const venues: LocatedVenue[] = rows
        .filter((row) => row.latitude !== null && row.longitude !== null)
        .map((row) => ({
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          locatedAt: row.locatedAt,
        }));

      return selectMerchantLocations(venues);
    },
  };
}
