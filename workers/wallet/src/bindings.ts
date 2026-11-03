/**
 * Confirmation that a `LoyaltyObject` write landed as sent.
 *
 * ## Why this module exists
 *
 * `insertObject` and `patchObject` both answer with the resource Google stored,
 * and the issuance route used to discard it. Nothing else in the worker reads
 * those fields back: `reconcile.ts` looks at `state` and
 * `loyaltyPoints.balance.string` and nothing more. So if Google normalised,
 * truncated or dropped `accountId`, `barcode.value` or the object's own id, the
 * pass would be recorded as `issued`, the customer would save it, and the
 * counter would answer "customer not found" with no error on either side.
 *
 * That failure class is already familiar in this worker: `object.ts` carries a
 * long comment about Google answering `state` in lower case, where every signal
 * said the system was working while the balance never moved. This module is the
 * same lesson applied to the fields nobody was comparing.
 *
 * ## What it is not
 *
 * This is not a general-purpose diff of the object. It compares only the five
 * fields whose disagreement makes the pass unusable: the object's identity, the
 * class it belongs to, the short code the counter types, and the barcode. A
 * balance that arrives stale is cosmetic and is `reconcile.ts`'s business; a
 * barcode that arrives changed is a dead card.
 */

import { hashCardToken } from './card-token';
import type { LoyaltyObject } from './object';

/**
 * The five values a confirmation compares, as the writer intended them. A full
 * `LoyaltyObject` satisfies it; a barcode-only patch (card-token rotation)
 * builds just these from the recorded pass rather than inventing the rest.
 */
export type ExpectedObjectBindings = Pick<LoyaltyObject, 'id' | 'classId' | 'accountId' | 'barcode'>;

/**
 * The fields whose value the pass cannot survive changing.
 *
 * `barcode.type` is in the list even though this build only ever writes
 * `QR_CODE`: the type is what decides whether a scanner can read the payload at
 * all, and a silent switch to a narrow symbology is the same dead card as a
 * changed value.
 */
export type BindingField = 'id' | 'classId' | 'accountId' | 'barcode.type' | 'barcode.value';

export const BINDING_FIELDS: readonly BindingField[] = [
  'id',
  'classId',
  'accountId',
  'barcode.type',
  'barcode.value',
];

/**
 * How a binding failed to match.
 *
 * - `different` — Google answered a value, and it is not the one sent.
 * - `missing` — the resource did not carry the field at all. This is the only
 *   kind worth a second read, because a partial response body is not a partial
 *   object: the object exists, the description of it was short.
 * - `invalid` — the field was present with the wrong shape (a number where a
 *   string belongs, a string where the barcode object belongs). Google's answer
 *   is not something this build can interpret, so it is neither of the above.
 */
export type BindingDefectKind = 'different' | 'invalid' | 'missing';

export interface BindingDefect {
  readonly field: BindingField;
  readonly kind: BindingDefectKind;
}

type ReadBinding =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly kind: 'invalid' | 'missing' };

/**
 * Collapse Google's barcode-type spellings onto one value.
 *
 * Google's enum is `QR_CODE`, and its legacy JSON spelling is `qrCode`. A raw
 * string comparison would report a perfectly correct pass as broken — the exact
 * shape of the `state` bug this worker already paid for. Anything else keeps its
 * own identity through the normalisation, so `CODE_128` compares unequal to
 * `QR_CODE` instead of being coerced into a match.
 */
function normaliseBarcodeType(raw: string): string {
  const collapsed = raw.trim().toLowerCase().replace(/[_\s-]/g, '');
  return collapsed === 'qrcode' ? 'QR_CODE' : raw.trim();
}

function readBarcodePart(resource: Record<string, unknown>, part: 'type' | 'value'): ReadBinding {
  const barcode = resource.barcode;

  if (barcode === undefined || barcode === null) return { ok: false, kind: 'missing' };
  if (typeof barcode !== 'object') return { ok: false, kind: 'invalid' };

  const raw = (barcode as Record<string, unknown>)[part];
  if (raw === undefined || raw === null) return { ok: false, kind: 'missing' };
  if (typeof raw !== 'string') return { ok: false, kind: 'invalid' };

  return { ok: true, value: part === 'type' ? normaliseBarcodeType(raw) : raw };
}

function readBinding(resource: unknown, field: BindingField): ReadBinding {
  if (resource === null || typeof resource !== 'object') return { ok: false, kind: 'invalid' };

  const record = resource as Record<string, unknown>;

  if (field === 'barcode.type' || field === 'barcode.value') {
    return readBarcodePart(record, field === 'barcode.type' ? 'type' : 'value');
  }

  const raw = record[field];
  if (raw === undefined || raw === null) return { ok: false, kind: 'missing' };
  if (typeof raw !== 'string') return { ok: false, kind: 'invalid' };

  return { ok: true, value: raw };
}

/** The value this build sent, in the form the comparison uses. */
function expectedBindingValue(expected: ExpectedObjectBindings, field: BindingField): string {
  switch (field) {
    case 'id':
      return expected.id;
    case 'classId':
      return expected.classId;
    case 'accountId':
      return expected.accountId;
    case 'barcode.type':
      return normaliseBarcodeType(expected.barcode.type);
    case 'barcode.value':
      return expected.barcode.value;
  }
}

/**
 * Compare the five bindings of a resource Google answered against what was sent.
 *
 * Returns an empty list when every field is present and equal. The caller
 * decides what an empty list means; this function never throws and never logs,
 * because a value it might print is exactly what must not reach a log line.
 */
export function findBindingDefects(expected: ExpectedObjectBindings, actual: unknown): BindingDefect[] {
  const defects: BindingDefect[] = [];

  for (const field of BINDING_FIELDS) {
    const read = readBinding(actual, field);
    if (!read.ok) {
      defects.push({ field, kind: read.kind });
      continue;
    }
    if (read.value !== expectedBindingValue(expected, field)) {
      defects.push({ field, kind: 'different' });
    }
  }

  return defects;
}

/**
 * Render defects for a log line or an operator-facing message.
 *
 * Only the field name and the category. Never the value that was sent and never
 * the value that came back: `barcode.value` is the customer's card token (a
 * revocable credential) or, for a legacy pass, `customers.global_id`, and the
 * callback route already documents the rule that neither belongs in a log.
 */
export function describeBindingDefects(defects: readonly BindingDefect[]): string {
  return defects.map((defect) => `${defect.field} (${defect.kind})`).join(', ');
}

/** The one dependency the retry needs, narrowed so a whole client is not required. */
export interface BindingsReadDeps {
  getObject(objectId: string): Promise<unknown>;
}

export type BindingsConfirmation =
  | { readonly kind: 'confirmed'; readonly source: 'write' | 'read' }
  | {
      readonly kind: 'unconfirmed';
      readonly source: 'write' | 'read';
      readonly defects: readonly BindingDefect[];
      readonly readFailed: boolean;
    };

/** Narrowing helper, so callers do not repeat the discriminant dance. */
export function isUnconfirmed(
  confirmation: BindingsConfirmation,
): confirmation is Extract<BindingsConfirmation, { kind: 'unconfirmed' }> {
  return confirmation.kind === 'unconfirmed';
}

/**
 * Decide whether a write landed, reading the object at most once more.
 *
 * ## The three answers, and why they are three
 *
 * 1. **The echo matched.** Done, no extra call. This is the ordinary case and it
 *    must stay free: a confirmation that cost a read on every issuance would be
 *    a tax on the happy path to cover a failure that has never been observed.
 * 2. **The echo carried a different value.** Definitive. Google answered, and the
 *    answer disagrees. Reading again would only ask the same question twice.
 * 3. **The echo omitted something.** Worth exactly one `getObject`: Google is
 *    documented to answer a partial resource on some writes, and rejecting a
 *    pass over a short response body would break a card that works. One read, not
 *    a retry loop, and after it the question is settled either way.
 *
 * A read that throws, or that answers `null`, is **not** a confirmation. "Could
 * not confirm" and "confirmed wrong" are different answers for an operator, but
 * both mean no link, because a link is a promise the pass works.
 */
export async function confirmObjectBindings(
  expected: ExpectedObjectBindings,
  written: unknown,
  deps: BindingsReadDeps,
): Promise<BindingsConfirmation> {
  const defects = findBindingDefects(expected, written);

  if (defects.length === 0) return { kind: 'confirmed', source: 'write' };

  if (!defects.some((defect) => defect.kind === 'missing')) {
    return { kind: 'unconfirmed', source: 'write', defects, readFailed: false };
  }

  let reread: unknown;
  try {
    reread = await deps.getObject(expected.id);
  } catch {
    return { kind: 'unconfirmed', source: 'read', defects, readFailed: true };
  }

  const afterRead = findBindingDefects(expected, reread);
  if (afterRead.length === 0) return { kind: 'confirmed', source: 'read' };

  return { kind: 'unconfirmed', source: 'read', defects: afterRead, readFailed: false };
}

/**
 * What the database says a pass's object should carry, without the card token
 * itself, which is never stored.
 */
export interface StoredObjectBindings {
  objectId: string;
  classId: string;
  /** NULL when the customer has no member code yet; then `accountId` is not compared. */
  memberCode: string | null;
  globalId: string;
  /** NULL for a legacy customer, whose barcode is expected to be `globalId`. */
  cardTokenHash: string | null;
}

/**
 * The binding fields on which Google's copy of an object disagrees with the
 * database.
 *
 * The card token is never stored, so a tokened customer's barcode is checked by
 * hashing what Google holds and comparing it with `card_token_hash`. That needs
 * no secret, which is what lets the reconcile path and the sweep check it.
 */
export async function findStoredBindingDrift(
  stored: StoredObjectBindings,
  actual: unknown,
): Promise<BindingField[]> {
  const remoteBarcode = readBinding(actual, 'barcode.value');
  const tokenMatches =
    stored.cardTokenHash !== null &&
    remoteBarcode.ok &&
    (await hashCardToken(remoteBarcode.value)) === stored.cardTokenHash;

  // For a tokened customer the expected value is "whatever Google holds" when its
  // hash matches, and something it can never hold when it does not, so the one
  // comparison below covers both cases.
  const expectedBarcode =
    stored.cardTokenHash === null
      ? stored.globalId
      : tokenMatches && remoteBarcode.ok
        ? remoteBarcode.value
        : '\u0000card-token-mismatch';

  const expected: ExpectedObjectBindings = {
    id: stored.objectId,
    classId: stored.classId,
    accountId: stored.memberCode ?? '',
    barcode: { type: 'QR_CODE', value: expectedBarcode },
  };

  return findBindingDefects(expected, actual)
    .map((defect) => defect.field)
    .filter((field) => !(field === 'accountId' && stored.memberCode === null));
}
