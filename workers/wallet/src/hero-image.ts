/**
 * The hero image URL, composed but **not emitted**.
 *
 * ## What this file is
 *
 * A pure function that builds the URL a pass's `heroImage` would point at, plus
 * a deliberate decision not to call it. Everything structural about the feature
 * is here; nothing about it is wired.
 *
 * ## Why the URL is a function of the merchant and the stamp level
 *
 * Not of the customer. The product decision for the minimum viable pass is that
 * stamps are marked with an X on a grid and the hero is a function of *which*
 * merchant and *how many* stamps — so ten stamps are **eleven** images
 * (`0` through `10`, where `10` is the completed card), not one image per
 * customer.
 *
 * That is not only cheaper. A per-customer hero would need one generated image
 * per member, which turns a card a merchant can see before they save it into an
 * asset pipeline keyed on the customer table, and makes a rebrand an N-row
 * regeneration. Keyed by `(tenantId, stampLevel)` a rebrand is one set of eleven
 * files.
 *
 * The URL shape follows the same reasoning as the gateway's brand route: keyed
 * by **tenant id**, never by slug or name, because the object at a key is
 * *replaced* on a rebrand and the URL inside a Google class cannot be
 * un-referenced.
 *
 * ## Why the builder does not call it
 *
 * A placeholder filename would render as a broken asset in Google Wallet, and
 * Google fetches `heroImage` itself: the URL has to resolve, or the pass shows an
 * empty or broken band across the top of the card. That is worse than no hero at
 * all, which is a clean card with Google's own layout. There is no image
 * generation in this repository, so every URL this function could produce today
 * would 404.
 *
 * So the shape is settled and tested, the call site does not exist, and turning
 * it on is: generate the eleven images per merchant, add a route to serve them
 * (the gateway's `/brand/` only serves flat `brand/*` keys), and then call this
 * from the object builder. Two of those three are deliberately out of scope here.
 */

import type { GoogleImage } from './class';

/**
 * The number of stamps at which the card is complete.
 *
 * Ten, and this is the constant that makes the image count eleven rather than
 * ten: level `0` is a member who has earned nothing and level `10` is the
 * completed card, which is a different image from level `9`.
 */
export const STAMPS_FOR_REWARD = 10;

/** Inclusive bounds of the stamp levels a hero exists for: `0` through `10`. */
export const MIN_STAMP_LEVEL = 0;
export const MAX_STAMP_LEVEL = STAMPS_FOR_REWARD;

/**
 * How many images one merchant needs.
 *
 * `MAX - MIN + 1`, stated rather than derived at each call site because the
 * claim this file makes — eleven images for ten stamps, not one per customer —
 * is a cost decision, and a decision nobody can count is a decision that gets
 * revisited.
 */
export const STAMP_LEVEL_IMAGE_COUNT = MAX_STAMP_LEVEL - MIN_STAMP_LEVEL + 1;

export interface HeroImageInput {
  /** The gateway origin. `WALLET_MEDIA_BASE_URL`, never the web host. */
  mediaBaseUrl: string;
  /** `tenants.id`. Never the slug: a rebrand replaces the object at this key. */
  tenantId: string;
  /** Stamps earned so far, `0` through `STAMPS_FOR_REWARD`. */
  stampLevel: number;
}

/**
 * Compose the hero image reference for one merchant at one stamp level.
 *
 * @throws {Error} for a stamp level outside `0..STAMPS_FOR_REWARD`, or a blank
 *   base URL or tenant id. Each would produce a URL that either cannot exist or
 *   silently addresses the wrong merchant, and a hero that renders someone
 *   else's brand is the same class of defect as a `homepageUri` pointing at a
 *   404.
 */
export function heroImageFor(input: HeroImageInput): GoogleImage {
  const base = input.mediaBaseUrl.trim().replace(/\/+$/, '');
  if (base === '') {
    throw new Error(
      'mediaBaseUrl is blank. A hero image needs the gateway origin; there is no URL to build.',
    );
  }

  const tenantId = input.tenantId.trim();
  if (tenantId === '') {
    throw new Error('tenantId is blank. A hero image must be keyed by the merchant it belongs to.');
  }

  const level = input.stampLevel;
  if (!Number.isInteger(level) || level < MIN_STAMP_LEVEL || level > MAX_STAMP_LEVEL) {
    throw new Error(
      `stampLevel is ${JSON.stringify(level)}, outside the ${MIN_STAMP_LEVEL}..${MAX_STAMP_LEVEL} ` +
        `range a hero exists for. A member holding more than ${STAMPS_FOR_REWARD} stamps is on the ` +
        'completed card, which is the top level.',
    );
  }

  return { sourceUri: { uri: `${base}/hero/${tenantId}/${level}.jpg` } };
}