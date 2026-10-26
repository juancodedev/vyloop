/**
 * The positions a pass may carry for nearby notifications.
 *
 * Google evaluates proximity on the device: the object carries up to ten
 * positions and the phone decides which one is near. So the only decisions here
 * are which venues are eligible and which of those a customer's pass may carry.
 */

import type { MerchantLocation } from './object';

/** Google's ceiling for `merchantLocations`, declared once. */
export const MERCHANT_LOCATION_LIMIT = 10;

/** The consent that makes a pass eligible for nearby notifications. */
export const NEARBY_CONSENT_TYPE = 'nearby_notifications';

/** A venue as the selector needs it. */
export interface LocatedVenue {
  latitude: number;
  longitude: number;
  /** `branches.located_at`; null for a row whose position predates the stamp. */
  locatedAt: Date | null;
}

/**
 * Turn eligible venues into what a loyalty object carries.
 *
 * Ordered by the most recently asserted position, then capped at Google's
 * limit. That is the decided order (Q1): no per-customer visit history,
 * because past visits say nothing about where the holder is now.
 */
export function selectMerchantLocations(
  venues: readonly LocatedVenue[],
): MerchantLocation[] {
  return [...venues]
    .filter((venue) => Number.isFinite(venue.latitude) && Number.isFinite(venue.longitude))
    .sort((a, b) => (b.locatedAt?.getTime() ?? 0) - (a.locatedAt?.getTime() ?? 0))
    .slice(0, MERCHANT_LOCATION_LIMIT)
    .map((venue) => ({ latitude: venue.latitude, longitude: venue.longitude }));
}
