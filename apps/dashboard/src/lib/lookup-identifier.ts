/**
 * Work out which of the three identifiers the cashier typed.
 *
 * ## Why this is a module and not three `onChange` handlers
 *
 * There is one input, so something has to decide whether what came out of it is
 * a phone number, an email or a pass id — and that decision decides which query
 * parameter the request carries. Left inside the component it would be untestable
 * (`vitest.config.ts` sets no `environment`, so the dashboard runs in `node` and
 * nothing renders), and a wrong answer here is a silent miss: the cashier typed
 * a perfectly good number and gets "not registered".
 *
 * `resolveLookupTarget` returns the identifier **and** the value together on
 * purpose. Two functions returning them separately is two functions that can
 * disagree, and a phone number sent as `email` fails as a 404 the cashier reads
 * as "this person is not a customer".
 *
 * ## What it will not do
 *
 * It does not guess between phone formats, and it does not normalise a number
 * into a different one. The stored value is the identity
 * (`uq_customers_business_phone`), so a number typed in another format is a miss
 * the cashier resolves by trying again — not a number this module quietly
 * rewrites into a lookup that hits the wrong person. Making phone search
 * format-tolerant needs a canonical format decision, and that belongs with the
 * data, not with a text box.
 */

export type LookupIdentifier = 'phone' | 'email' | 'globalId';

export interface LookupTarget {
  identifier: LookupIdentifier;
  /** The value to send — for a pasted QR link, the id and not the URL. */
  value: string;
}

/**
 * A uuid, and the qr-code payload format the POS scanner already accepts.
 *
 * The scanner pulls the id out of `/c/<uuid>`; a cashier pasting the same link
 * into the box should get the same customer, so the id is extracted here too.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_ANYWHERE = new RegExp(UUID, 'i');
const UUID_EXACT = new RegExp(`^${UUID}$`, 'i');

/**
 * Resolve one typed string to one identifier, or `null` when there is nothing
 * to search by.
 */
export function resolveLookupTarget(raw: string): LookupTarget | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Checked before the email test because a QR link can contain an `@`, and a
  // uuid is unambiguous: nothing else a cashier types looks like one.
  if (UUID_EXACT.test(trimmed)) {
    return { identifier: 'globalId', value: trimmed.toLowerCase() };
  }

  const embedded = trimmed.match(UUID_ANYWHERE);
  if (embedded) {
    return { identifier: 'globalId', value: embedded[0].toLowerCase() };
  }

  // An `@` with something after it and a dot in that something. Deliberately
  // loose: the server matches on equality, so a malformed address is a clean
  // miss rather than a wrong guess.
  const at = trimmed.indexOf('@');
  if (at > 0 && trimmed.indexOf('.', at) > at + 1) {
    return { identifier: 'email', value: trimmed };
  }

  return { identifier: 'phone', value: trimmed };
}
