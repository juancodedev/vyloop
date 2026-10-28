/**
 * The edit form's half of the customer PATCH contract.
 *
 * ## Why this is a module and not the page
 *
 * `apps/dashboard/vitest.config.ts` leaves the environment at `node`, and
 * `lib/pass-state.ts` states the reason for keeping decisions out of components:
 * a branch written inside a `.tsx` is a branch nothing can check. "Which fields
 * may be sent, and what does a refusal mean" is two such decisions, so both live
 * here and the page renders what they return.
 *
 * ## Why the body is assembled field by field
 *
 * The obvious implementation spreads the draft — `set(draft)`. That is the bug
 * this endpoint already had on the server, in the same shape: whoever builds the
 * body decides the set of columns that can be written, and a spread lets an
 * unrelated property become a column. A draft seeded from the whole customer
 * record would carry `globalId`, `id` and `deletedAt`, and the server now
 * refuses every one of them, so a save would fail over a field the operator never
 * saw. So this iterates `CUSTOMER_PATCHABLE_FIELDS` — the constant the route
 * reads — and copies nothing else into the body.
 *
 * ## Why absent is not the same as null
 *
 * `PATCH` is partial, and a partial update that sends `undefined` for the fields
 * it did not receive writes NULL over them: editing a phone would empty the
 * email. So a field the operator did not touch is **absent from the body**, and
 * clearing one is spelled `null`. `buildCustomerPatch` returns `{}` when nothing
 * changed, and the form does not send a request at all.
 */

import {
  CUSTOMER_PATCH_ERROR,
  CUSTOMER_PATCHABLE_FIELDS,
  type CustomerPatch,
  type CustomerPatchableField,
} from '@vyloop/types';

import { ApiError } from './api';

/** The four editable fields as plain strings, which is what an input holds. */
export type CustomerDraft = Record<CustomerPatchableField, string>;

/** What the form is shown before editing starts: the server's answer. */
export interface EditableCustomerFields {
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  birthDate?: string | Date | null;
}

/**
 * `YYYY-MM-DD`, or `''`.
 *
 * `GET /v1/customers/:id` returns `birth_date` from a Postgres `date` column, so
 * a `Date` can arrive. `<input type="date">` renders a `Date` as an empty box and
 * posts `''` back, which would save an empty value over a real birth date — a
 * value the operator never saw disappear.
 */
function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function toText(value: string | null | undefined): string {
  return value ?? '';
}

export function draftFromCustomer(customer: EditableCustomerFields): CustomerDraft {
  return {
    fullName: toText(customer.fullName),
    phone: toText(customer.phone),
    email: toText(customer.email),
    birthDate: toDateInput(customer.birthDate),
  };
}

/**
 * The request body for a save: only editable fields, only changed ones.
 *
 * `baseline` is the last value the **server** confirmed, not the last value
 * typed. Comparing against the server's copy is what stops a second save from
 * re-sending a field the server never accepted.
 */
export function buildCustomerPatch(baseline: CustomerDraft, draft: CustomerDraft): CustomerPatch {
  const patch: CustomerPatch = {};

  for (const field of CUSTOMER_PATCHABLE_FIELDS) {
    const before = baseline[field] ?? '';
    const after = draft[field] ?? '';

    if (after === before) continue;

    // An emptied input means "clear this", and `null` is how a nullable column
    // is cleared. `''` would store an empty string instead, leaving a customer
    // who is registered and unreachable at the counter.
    patch[field] = after === '' ? null : after;
  }

  return patch;
}

/** A refusal, resolved into where it belongs on screen. */
export interface PatchFailure {
  /** The input to blame, or `null` when no single one of them is at fault. */
  field: CustomerPatchableField | null;
  message: string;
}

/**
 * Which input a server code belongs beside.
 *
 * The two uniqueness codes are separate codes rather than one "already taken"
 * because the operator's next action is to change that one value: telling them
 * the email is taken when the phone is makes them fix the wrong thing.
 */
const FIELD_FOR_CODE: Record<string, CustomerPatchableField> = {
  [CUSTOMER_PATCH_ERROR.PHONE_TAKEN]: 'phone',
  [CUSTOMER_PATCH_ERROR.EMAIL_TAKEN]: 'email',
};

const FALLBACK_MESSAGE = 'No se pudo guardar. Revisa la conexión e inténtalo de nuevo.';

export function patchErrorFor(error: unknown): PatchFailure {
  if (error instanceof ApiError) {
    const field = FIELD_FOR_CODE[error.code] ?? null;
    return { field, message: error.message !== '' ? error.message : FALLBACK_MESSAGE };
  }
  if (error instanceof Error && error.message !== '') {
    return { field: null, message: error.message };
  }
  return { field: null, message: FALLBACK_MESSAGE };
}

/**
 * A stored calendar date (`YYYY-MM-DD`, or the date part of an ISO timestamp)
 * as Chile writes it: `05-03-1990`. Returns `—` for anything else.
 *
 * Read as a calendar day, not an instant. `new Date('1990-03-05')` is midnight
 * UTC, which is still the 4th in Santiago, so formatting it in local time shows
 * the day before.
 */
export function formatCalendarDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return '—';
  const [, year, month, day] = match.map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString('es-CL', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** A stored birth date, the way {@link formatCalendarDate} prints any day. */
export const formatBirthDate = formatCalendarDate;
