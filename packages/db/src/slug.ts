/**
 * Slug derivation for `tenants.slug`.
 *
 * `slug` is a `text` column with a unique index and, until this module existed,
 * no format contract anywhere in the repo — `workers/wallet/src/ids.ts:11-15`
 * documents that absence as the reason the Google Wallet class id is derived
 * from the tenant UUID instead of the slug. That reasoning still holds: the
 * slug stays *renameable* without breaking a pass. What changes here is that
 * the only writer of the column now emits a constrained form, so a slug read
 * back from the database can be treated as `[a-z0-9-]` even though the column
 * itself still says `text`.
 *
 * There is no `assertSlug` companion, and that is intentional. `ids.ts` makes
 * the same argument for Google resource identifiers: a function that cannot emit
 * an invalid value is worth more than a validator some future writer might
 * forget to call. A tenant *rename* path added later has to route through
 * `slugify` for the guarantee to hold — that is the one gap, and it is closed
 * by the rename path's tests, not by a function nothing invokes today.
 *
 * **Collision handling is not this module's job.** Two businesses called
 * `Café Central` derive the same slug, and the unique index is what settles it.
 * Silently appending a counter here would mint a tenant URL the merchant never
 * chose and never sees again; the caller turns the rejection into a legible 409
 * instead. See `signupBusiness` in the identity worker.
 */

/** Maximum slug length. Long enough for a legal business name, short enough for a URL. */
const SLUG_MAX_LENGTH = 60;

/**
 * Latin letters that NFD does **not** decompose.
 *
 * `Café` is a precomposed character with a canonical decomposition, so
 * `normalize('NFD')` hands back `e` + U+0301 and the diacritic-stripping pass
 * removes it. `ø`, `ß`, `æ` and friends are not precomposed forms of a base
 * letter plus a mark — they have no canonical decomposition at all, so the same
 * pass leaves them intact and they get hyphenated away as if they were
 * punctuation. `Ørsted` would derive `rsted`, which is a wrong slug rather than
 * a lossy one, and a wrong slug is the one outcome a merchant would report as a
 * bug in the product. The list is bounded to letters common in Latin-script
 * business names; it is not an attempt at full transliteration.
 */
const NON_DECOMPOSING: ReadonlyMap<string, string> = new Map([
  ['ø', 'o'],
  ['Ø', 'o'],
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['Æ', 'ae'],
  ['œ', 'oe'],
  ['Œ', 'oe'],
  ['đ', 'd'],
  ['Đ', 'd'],
  ['ł', 'l'],
  ['Ł', 'l'],
  ['þ', 'th'],
  ['Þ', 'th'],
  ['ð', 'd'],
  ['Ð', 'd'],
]);

/** Combining diacritical marks, i.e. what NFD leaves behind after decomposing. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Cut to `max` without leaving a partial word.
 *
 * Slicing at the character limit would turn a long name into `cafe-central-de-la`
 * — plausible-looking, wrong, and stable enough to become someone's permanent
 * address. Breaking at the last hyphen keeps the result a prefix of the input
 * that a human would have written. A slug with no hyphen in range is one long
 * unbroken token, and that is cut hard: it is a name with no word boundaries, so
 * there is nothing meaningful to preserve.
 */
function truncateAtBoundary(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  const lastHyphen = head.lastIndexOf('-');
  return (lastHyphen > 0 ? head.slice(0, lastHyphen) : head).replace(/-+$/, '');
}

/**
 * Derive a slug from a business name.
 *
 * Lowercase, fold accents, replace every run of non-`[a-z0-9]` characters with a
 * single hyphen, trim hyphens from both ends, and cut to a reasonable length.
 *
 * @returns the slug, or `''` when the name contains nothing that survives
 *          normalisation (a business named `???` or `!!!`). The empty string is
 *          returned rather than thrown so the caller can decide; a signup that
 *          inserted it would create a tenant whose slug is `''`, and the second
 *          such signup would collide with the first.
 */
export function slugify(name: string): string {
  const withMappedLetters = Array.from(name)
    .map((char) => NON_DECOMPOSING.get(char) ?? char)
    .join('');

  const folded = withMappedLetters.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

  const hyphenated = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return truncateAtBoundary(hyphenated, SLUG_MAX_LENGTH);
}
