// Shared formatting helpers for the customer profile.
//
// Kept in one module so the page, the timeline and the identity card agree on
// how a date or an amount reads. The competitor reference used English relative
// dates in a Spanish UI and all-caps labels; these helpers do neither.

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * A date as a customer reads it.
 *
 * Relative for the first six days (`Hoy`, `Ayer`, `Hace 3 días`), then a short
 * Spanish date (`28 sep`), with the year appended when it is not the current
 * one. `null`/empty/invalid input returns an empty string rather than a
 * placeholder, so an absent date never renders as "-".
 */
export function formatMovementDate(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000));

  if (days < 0) {
    // A future date is not "relative"; fall through to the short form below.
  } else if (days === 0) {
    return 'Hoy';
  } else if (days === 1) {
    return 'Ayer';
  } else if (days <= 6) {
    return `Hace ${days} días`;
  }

  const day = date.getDate();
  const month = MONTHS[date.getMonth()];
  if (date.getFullYear() === now.getFullYear()) {
    return `${day} ${month}`;
  }
  return `${day} ${month} ${date.getFullYear()}`;
}

/**
 * A Chilean-peso amount as a customer reads it: grouped thousands, no decimals,
 * with the `$` prefix. `null`/empty/invalid returns an empty string.
 */
export function formatClp(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(number)) return '';
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(number);
}

/**
 * The initials of a person's name: the first letter of the first two words,
 * uppercased. Returns an empty string for an empty input.
 */
export function initials(value: string | null | undefined): string {
  if (!value) return '';
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase());
  return letters.join('');
}

/**
 * A member code in groups of three ("K7F2QX" -> "K7F 2QX"), the way it is
 * dictated at the counter. Returns an empty string for an absent code.
 */
export function formatMemberCode(value: string | null | undefined): string {
  if (!value) return '';
  return value.match(/.{1,3}/g)?.join(' ') ?? '';
}

/**
 * The month and year a member joined, in Spanish ("diciembre de 2025").
 * Returns an empty string for a missing or invalid date.
 */
export function formatMemberSince(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
}
