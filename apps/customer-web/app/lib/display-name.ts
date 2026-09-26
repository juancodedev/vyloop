/**
 * A display name out of a query string.
 *
 * `/confirm` greets a customer by a name that arrives in the URL. That value is
 * under the control of whoever built the link, so it is treated as text to be
 * shaped rather than as an identity to be trusted. React already renders it as
 * text and never as markup, so the work here is not escaping — it is deciding
 * how much of it belongs in a heading, and making sure nothing in it can disturb
 * the line it sits in.
 *
 * It lives here rather than in the page because a Next.js route module may only
 * export its default and its route config, and because the rule is worth being
 * able to test on its own.
 */

/** Shown when there is no usable name at all. */
export const FALLBACK_NAME = 'Cliente';

/**
 * How much of a supplied name is kept.
 *
 * A display name is a greeting, not an identity. Forty characters is two long
 * names' worth of a first name, and short enough that the heading still fits on
 * one line at 320px — which is the width 400% browser zoom produces on a
 * desktop. Anything past this is dropped and marked, so a reader can tell a
 * shortened name from a complete one.
 */
export const MAX_NAME_LENGTH = 40;

/** Appended when the name has had to be cut. */
const ELLIPSIS = '…';

/**
 * Control characters, by code point rather than by pattern.
 *
 * A name arrives percent-encoded, so it can legitimately hold a space or an
 * accented letter, and it can hold whatever anybody put in the URL. The control
 * ranges are the one category with no use in a greeting and a real ability to
 * disturb a line box.
 *
 * Written as a loop instead of `/[\u0000-\u001F]/g` on purpose: an eslint-disable
 * on a control-character pattern is the kind of comment that outlives its
 * reason, and this is the same rule stated in a form a linter can read.
 */
function withoutControlCharacters(value: string): string {
  let result = '';

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    // C0 controls, DEL, and the C1 controls.
    result += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }

  return result;
}

/** Collapses every run of whitespace to a single space and trims the ends. */
function collapseWhitespace(value: string): string {
  return value
    .split(' ')
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * The name to greet someone by, or the fallback.
 *
 * Three steps, in this order, because each one depends on the previous: drop
 * the control characters, collapse the whitespace they may have separated, and
 * only then decide whether what is left is short enough to print.
 */
export function displayNameFrom(raw: string | null): string {
  if (!raw) return FALLBACK_NAME;

  const cleaned = collapseWhitespace(withoutControlCharacters(raw));
  if (!cleaned) return FALLBACK_NAME;

  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;

  // Cut, then re-trim: a cut that lands exactly on a space would otherwise keep
  // that space in front of the ellipsis.
  return `${cleaned.slice(0, MAX_NAME_LENGTH).trim()}${ELLIPSIS}`;
}
