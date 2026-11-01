/**
 * Which café the customer is using, when the URL no longer says.
 *
 * Login and registration need a business: a phone number alone names no
 * customer, because the same person has a separate record at every café they
 * joined. The business arrives as `?biz=` on the café's QR link, but several
 * routes drop it: a session that expires on /profile redirects to a bare
 * /login, and the confirmation page links back to a bare /. Each of those
 * used to end on "Falta el contexto del comercio", asking the customer to find
 * and scan the QR again.
 *
 * So the last business seen in a link is kept in this browser, and a page
 * without `?biz=` uses it. A link always wins and replaces it. Storage can be
 * blocked (private windows, cleared site data); then only the link counts.
 */

const STORAGE_KEY = 'vyloop_business_slug';

export function rememberBusinessSlug(slug: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    // Blocked storage only costs the fallback; the link still works.
  }
}

export function recallBusinessSlug(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** The business from the link if it has one (remembering it), else the last one seen. */
export function resolveBusinessSlug(fromLink: string | null): string | null {
  if (fromLink) {
    rememberBusinessSlug(fromLink);
    return fromLink;
  }
  return recallBusinessSlug();
}
