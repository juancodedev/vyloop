// @vitest-environment node

/**
 * What the edit form is allowed to send.
 *
 * ## Why the decision is a module and not the page
 *
 * `apps/dashboard/vitest.config.ts` leaves the environment at `node`, and
 * `lib/pass-state.ts` already states the reason for keeping decisions out of
 * components: wording and branching written inside a `.tsx` are wording and
 * branching nothing can check. "Which fields may be sent" is exactly such a
 * decision — it is the client's half of the allowlist the server enforces — so it
 * lives here and the page renders what it returns.
 *
 * ## The two mistakes this is built to prevent
 *
 * A payload carrying a field the server refuses makes every save fail with a
 * message about a column the operator never saw. A payload carrying a field the
 * server *accepts* under a name it does not write makes the save succeed and
 * change nothing — a 200 and a lie. Both come from building the body by
 * spreading something, so the body here is assembled field by field from
 * `CUSTOMER_PATCHABLE_FIELDS`, the same constant the worker route reads.
 */

import { CUSTOMER_PATCH_ERROR, CUSTOMER_PATCHABLE_FIELDS } from '@vyloop/types';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../lib/api';
import { buildCustomerPatch, draftFromCustomer, patchErrorFor } from '../lib/customer-edit';

const BASELINE = {
  fullName: 'Ana Ruiz',
  phone: '+56911112222',
  email: 'ana@test.com',
  birthDate: '1990-05-04',
};

describe('draftFromCustomer', () => {
  it('renders every editable field as a text value', () => {
    const draft = draftFromCustomer({ fullName: 'Ana', phone: '+569', email: 'a@b.c' });

    // A missing email must be an empty string, not undefined: an uncontrolled
    // input holding undefined shows the word "undefined" and posts it back.
    expect(draft).toEqual({
      fullName: 'Ana',
      phone: '+569',
      email: 'a@b.c',
      birthDate: '',
    });
  });

  it('keeps a birthDate the API formatted as a Date readable', () => {
    // `GET /v1/customers/:id` returns `birth_date` as a date column, so a Date
    // can arrive. An `<input type="date">` needs `YYYY-MM-DD` or it renders
    // blank and the operator saves an empty value over a real birth date.
    const draft = draftFromCustomer({ fullName: 'Ana', birthDate: new Date('1990-05-04T00:00:00Z') });

    expect(draft.birthDate).toBe('1990-05-04');
  });
});

describe('buildCustomerPatch', () => {
  it('sends only the four editable fields, whatever the draft carries', () => {
    // The dangerous version of this spreads the draft. Someone will eventually
    // seed a draft from the whole customer record, and `globalId`, `id` and
    // `deletedAt` would go with it — to a server that now refuses them.
    const patch = buildCustomerPatch(BASELINE, {
      ...BASELINE,
      globalId: '11111111-2222-4333-8444-555555555555',
      deletedAt: '2026-01-01',
      id: 'other',
      memberCode: 'M-1',
      points: 9999,
      currentTier: 'Oro',
    } as never);

    expect(Object.keys(patch).sort()).toEqual([]);
  });

  it('sends only the field that changed', () => {
    const patch = buildCustomerPatch(BASELINE, { ...BASELINE, phone: '+56999998888' });

    expect(patch).toEqual({ phone: '+56999998888' });
  });

  it('sends every changed field when several are edited', () => {
    const patch = buildCustomerPatch(BASELINE, {
      ...BASELINE,
      fullName: 'Ana Ruiz Soto',
      email: 'ana.soto@test.com',
    });

    expect(patch).toEqual({ fullName: 'Ana Ruiz Soto', email: 'ana.soto@test.com' });
  });

  it('never sends a key for an untouched field', () => {
    // Absent, not `undefined`. JSON.stringify drops an undefined value but the
    // key would still be present in the object handed to fetch, and the test
    // below is about the object, not the string.
    const patch = buildCustomerPatch(BASELINE, { ...BASELINE, phone: '+56999998888' });

    for (const field of CUSTOMER_PATCHABLE_FIELDS) {
      if (field === 'phone') continue;
      expect(patch).not.toHaveProperty(field);
    }
  });

  it('clears a field by sending null, not an empty string', () => {
    // The route treats a missing key as "untouched" and a string as a value, so
    // `''` would store an empty string where the column was null — a customer who
    // looks registered to nobody at the POS.
    const patch = buildCustomerPatch(BASELINE, { ...BASELINE, email: '' });

    expect(patch).toEqual({ email: null });
  });

  it('returns nothing to send when the operator changed nothing', () => {
    // A no-op PATCH used to bump `updated_at` and answer 200, which reads as a
    // save. Not sending it is the honest answer.
    expect(buildCustomerPatch(BASELINE, { ...BASELINE })).toEqual({});
  });

  it('does not send a field cleared when it was already empty', () => {
    const baseline = { ...BASELINE, email: '' };

    expect(buildCustomerPatch(baseline, { ...baseline })).toEqual({});
  });

  it('reads its field list from the shared contract', () => {
    // If the server gains a fifth editable field, this has to pick it up without
    // a second list appearing here.
    expect(Object.keys(buildCustomerPatch(BASELINE, draftFromCustomer({}))))
      .toEqual(expect.arrayContaining(CUSTOMER_PATCHABLE_FIELDS.filter((f) => f !== 'phone')));
  });
});

describe('patchErrorFor', () => {
  it('points at the phone input when the phone is taken', () => {
    const result = patchErrorFor(
      new ApiError(409, CUSTOMER_PATCH_ERROR.PHONE_TAKEN, 'Another customer in this business already uses this phone number.'),
    );

    expect(result.field).toBe('phone');
    expect(result.message).toMatch(/phone/i);
  });

  it('points at the email input when the email is taken', () => {
    const result = patchErrorFor(
      new ApiError(409, CUSTOMER_PATCH_ERROR.EMAIL_TAKEN, 'Another customer in this business already uses this email address.'),
    );

    expect(result.field).toBe('email');
  });

  it('blames no single input for a refusal about the body', () => {
    // "You cannot change globalId" is not the fault of any of the four inputs,
    // so it belongs above the form rather than beside one of them.
    const result = patchErrorFor(
      new ApiError(400, CUSTOMER_PATCH_ERROR.NOT_PATCHABLE, 'This endpoint cannot change: globalId.'),
    );

    expect(result.field).toBeNull();
    expect(result.message).toContain('globalId');
  });

  it('keeps the server message for a conflict it has no field for', () => {
    const result = patchErrorFor(new ApiError(409, CUSTOMER_PATCH_ERROR.CONFLICT, 'Another record collides.'));

    expect(result.field).toBeNull();
    expect(result.message).toBe('Another record collides.');
  });

  it('has something to say about a failure that carries no code at all', () => {
    const result = patchErrorFor(new Error('Failed to fetch'));

    expect(result.message).not.toBe('');
    expect(result.field).toBeNull();
  });
});
