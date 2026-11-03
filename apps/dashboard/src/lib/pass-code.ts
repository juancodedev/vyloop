/**
 * Read a customer credential out of whatever the scanner decoded: either a
 * `customers.global_id` (legacy cards and passes) or an opaque card token.
 *
 * ## Why this lives outside the page
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs
 * in `node`: a component cannot be rendered, so a regex left inside one is
 * untested text. This is the same split as `lib/lookup-identifier.ts`, and it is
 * the split that let a real barcode go unread for a release.
 *
 * ## The formats, and why each is load-bearing
 *
 * 1. `/c/<globalId>` — what `apps/customer-web/app/components/member-qr.tsx`
 *    encoded before card tokens. **These QRs are printed on cards that already
 *    exist in customers' hands.** Refusing to read them strands those cards.
 * 2. `<issuerId>.member-<globalId>` — the Google Wallet object id, shaped by
 *    `objectIdFor` in `workers/wallet/src/ids.ts` as
 *    ``member-${sanitizeIdPart(customerGlobalId)}``. Google does not derive the
 *    barcode from the object id: the barcode carries whatever value the wallet
 *    worker writes into the object's `barcode.value`. This form is accepted
 *    because a pass, or a support agent, can present the object id, not because
 *    it is what the barcode encodes.
 * 3. A bare `<globalId>` — the same id without anything around it.
 * 4. A card token, bare or as `/c/<token>` — `vyc1.` plus 43 base64url
 *    characters. New passes and the customer-web QR carry it instead of the
 *    uuid, so the scannable credential can be rotated without touching
 *    `global_id`. It is returned as its own `kind` because it resolves through a
 *    different route (`by-card-token`), and a token sent as a globalId, or the
 *    reverse, is a guaranteed miss.
 *
 * The `global_id` column is a `uuid`, and `sanitizeIdPart` only lowercases and
 * collapses characters that a uuid cannot contain, so the suffix is the uuid
 * verbatim in lower case. That is why these are matched as uuids rather than as
 * "whatever is after the dot".
 *
 * ## Why nothing is guessed
 *
 * The previous parser ended with `|| decodedText.trim()`, which meant any QR
 * longer than ten characters became a `globalId` and was sent to
 * `GET /v1/customers/by-global-id/<id>`. A restaurant menu QR became a customer
 * lookup, and the cashier was told "Cliente no encontrado" — which is a
 * statement about a person, made because a camera decoded a poster.
 *
 * The value is also dropped into a URL path unencoded, so a decoded string
 * containing a space or a slash does not merely miss, it asks about a different
 * endpoint. Refusing to invent the value is the fix for both.
 */

export type PassCodeFailure = 'unreadable';

export type PassCodeResult =
  | { ok: true; kind: 'global-id'; globalId: string }
  | { ok: true; kind: 'card-token'; token: string }
  | { ok: false; reason: PassCodeFailure };

/**
 * A uuid, anchored or not.
 *
 * The same shape as the pattern in `lib/lookup-identifier.ts`. They are written
 * out twice rather than shared because a scanner answer and a typed answer must
 * agree, and `pos-scan.contract.test.ts` checks that they do instead of trusting
 * two copies to stay equal.
 */
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** `/c/<uuid>`, anchored at both ends so trailing junk cannot extend the id. */
const LEGACY_LINK = new RegExp(`^/c/(${UUID_SOURCE})$`, 'i');

/** `<issuerId>.member-<uuid>`. */
const WALLET_OBJECT_ID = new RegExp(`^[0-9a-z._-]+\\.member-(${UUID_SOURCE})$`, 'i');

/** The uuid on its own. Capturing, so all three patterns hand back a `[1]`. */
const BARE_UUID = new RegExp(`^(${UUID_SOURCE})$`, 'i');

/**
 * A card token: `^vyc1\.[A-Za-z0-9_-]{43}$`, the shape fixed by the wallet
 * worker. Case-sensitive on purpose: base64url distinguishes `a` from `A`, so
 * this is never lower-cased. Same pattern as in `lib/lookup-identifier.ts`,
 * checked for agreement by `pass-code.contract.test.ts`.
 */
const CARD_TOKEN_SOURCE = 'vyc1\\.[A-Za-z0-9_-]{43}';

/** A bare token or `/c/<token>`; only the `/c/` prefix ignores case. */
const CARD_TOKEN = new RegExp(`^(?:/[cC]/)?(${CARD_TOKEN_SOURCE})$`);

/**
 * The credential in whichever of the formats this is.
 *
 * A uuid is lower-cased on the way out, matching `resolveLookupTarget`, so
 * scanning a card and pasting the same value into the search box identify the
 * same customer. A card token is returned exactly as scanned.
 *
 * @param decodedText whatever the camera decoded, untrimmed.
 * @returns the globalId or the card token, or `unreadable`. Never a guess.
 */
export function parsePassCode(decodedText: string): PassCodeResult {
  const text = decodedText.trim();

  // A token cannot look like any uuid form (no hyphenated hex groups after a
  // `vyc1.` prefix), so its order relative to them does not matter.
  const token = text.match(CARD_TOKEN);
  if (token) return { ok: true, kind: 'card-token', token: token[1]! };

  // The bare uuid first: it is the most specific thing that can match, and a
  // leading `/c/` can never be mistaken for one.
  const bare = text.match(BARE_UUID);
  if (bare) return { ok: true, kind: 'global-id', globalId: bare[1]!.toLowerCase() };

  const legacy = text.match(LEGACY_LINK);
  if (legacy) return { ok: true, kind: 'global-id', globalId: legacy[1]!.toLowerCase() };

  // Last, because it is the loosest: it accepts anything before `.member-`.
  // The uuid still has to be the whole suffix, so a truncated scan fails here
  // rather than returning half an id.
  const wallet = text.match(WALLET_OBJECT_ID);
  if (wallet) return { ok: true, kind: 'global-id', globalId: wallet[1]!.toLowerCase() };

  return { ok: false, reason: 'unreadable' };
}
