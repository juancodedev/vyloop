// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./register/page.tsx', import.meta.url), 'utf8');
const consentList = readFileSync(new URL('./components/consent-list.tsx', import.meta.url), 'utf8');

describe('Stage 2 club-barrio registration contract', () => {
  it('keeps the required identity fields and optional disclosure explicit', () => {
    expect(page).not.toMatch(/autoFocus/);
    expect(page).toMatch(/name="fullName"[\s\S]*?required/);
    expect(page).toMatch(/name="phone"[\s\S]*?required/);
    expect(page).toMatch(/<details/);
    expect(page).toMatch(/<summary/);
    expect(page).toMatch(/name="email"/);
    expect(page).toMatch(/name="birthDate"/);
  });

  it('offers the email in the main field group, not inside the disclosure', () => {
    // The email field always existed and was always optional. What was wrong was
    // that it lived in a collapsed `<details>`, so a business asking for a way to
    // reach its customer had to go looking for it.
    //
    // Asserted on the markup rather than only in the behaviour suite because the
    // behaviour suite answers "can the DOM reach it" and this answers "where was
    // it put" — a future refactor can move the field back into the disclosure and
    // leave `getByLabelText` passing.
    const fieldsGroup = /<div className="club-register__fields">([\s\S]*?)<\/div>/.exec(page);

    expect(fieldsGroup?.[1]).toBeDefined();
    expect(fieldsGroup?.[1]).toMatch(/name="fullName"/);
    expect(fieldsGroup?.[1]).toMatch(/name="phone"/);
    expect(fieldsGroup?.[1]).toMatch(/name="email"/);

    // And the birth date is the one that stayed behind the disclosure.
    //
    // Anchored to the real element rather than to a bare `<details` tag: this
    // file's own comments discuss the disclosure and would otherwise match first,
    // which is the failure the `images` rule in `a11y-hygiene.contract.test.ts`
    // already documents for `<img`.
    //
    // The attribute is spelled out in full rather than abbreviated, because
    // `globals.contract.test.ts` extracts class names by scanning for the literal
    // sequence `className` followed by `=` anywhere in a file — comments included
    // — so writing that pair here, inside backticks, made the prose in this very
    // comment look like a class list and failed the stylesheet contract with the
    // words "a", "bare" and "to".
    const optional = /<details className="club-register__optional">([\s\S]*?)<\/details>/.exec(page);

    expect(optional?.[1]).toBeDefined();
    expect(optional?.[1]).toMatch(/name="birthDate"/);
    expect(optional?.[1]).not.toMatch(/name="email"/);
  });

  it('states why the email is optional instead of leaving it as a bare choice', () => {
    // A field that is optional without a stated reason reads as an oversight, and
    // the next person to touch it either makes it required for no reason or
    // removes it. The reason is here: nothing verifies an email, so it is a
    // channel for the business and not a recovery address.
    expect(page).toMatch(/nothing verifies it/i);
    expect(page).toMatch(/demo mode, no OTP/i);
    expect(page).toMatch(/recovery channel/i);
  });

  it('does not present the email as a way to get back into the account', () => {
    // The copy a customer reads is the promise. An email offered as a
    // password-reset address that cannot reset anything is worse than none.
    expect(page).not.toMatch(/recuperar|restablecer|contraseña|olvid/i);
  });

  it('preserves the business context and existing API flow', () => {
    expect(page).toMatch(/useSearchParams\(\)/);
    expect(page).toMatch(/searchParams\.get\('biz'\)/);
    expect(page).toMatch(/businessSlug/);
    expect(page).toMatch(/\/v1\/customers/);
    expect(page).toMatch(/method: 'PUT'/);
    expect(page).toMatch(/api\.loginCustomer\(phone, businessSlug\)/);
    expect(page).toMatch(/localStorage\.setItem\('vyloop_jwt'/);
    expect(page).toMatch(/router\.push\('\/profile'\)/);
  });

  it('normalizes identity values once so creation and login agree', () => {
    expect(page).toMatch(/const phone = form\.phone\.trim\(\);/);
    expect(page).toMatch(/const fullName = form\.fullName\.trim\(\);/);
    expect(page).toMatch(/const email = form\.email\.trim\(\);/);
    expect(page).toMatch(/const payload: Record<string, string> = \{\s*fullName,\s*phone,\s*businessSlug,/);
    expect(page).toMatch(/if \(email\) payload\.email = email;/);
    expect(page).not.toMatch(/fullName: form\.fullName,/);
    expect(page).not.toMatch(/phone: form\.phone,/);
    expect(page).not.toMatch(/payload\.email = form\.email/);
  });

  it('never reports an HTTP response as a local gateway outage', () => {
    expect(page).toMatch(
      /function isNetworkError\(error: unknown\) \{[\s\S]*?if \(error instanceof CustomerCreationError\) return false;/,
    );
    expect(page).toMatch(
      /} else if \(\s*error instanceof CustomerCreationError &&[\s\S]*?setServerError\(error\.message\);[\s\S]*?\} else if \(isNetworkError\(error\)\) \{/,
    );
  });

  it('renders consent controls as interactive and includes them in the payload', () => {
    // Consent checkboxes are now interactive (not disabled by default) and the
    // registration payload includes the consent values when submitted.
    // The fieldset is not disabled.
    expect(consentList).not.toMatch(/<fieldset[^>]*disabled/);
    // Checkboxes are not disabled by default (only during save)
    expect(consentList).not.toMatch(/<input[^>]*type="checkbox"[^>]*disabled(?![^>]*saving)/);
    // The old "unavailable" state text is gone
    expect(consentList).not.toMatch(/No disponible todavía.*Desactivado/);
    // "Desactivado" is now a valid state for unchecked checkboxes, not an
    // "unavailable" marker. The old combined state "No disponible todavía · Desactivado" is gone.
    expect(consentList).not.toMatch(/No disponible todavía · Desactivado/);
    // The registration payload includes consents when the form is submitted.
    // This is verified in the behavior tests.
  });

  it('contains actionable network and partial-success paths', () => {
    expect(page).toMatch(/Failed to fetch|failed to fetch|networkerror|load failed/);
    expect(page).toMatch(/gateway local/);
    expect(page).toMatch(/Tu cuenta fue creada/);
    expect(page).toMatch(/Ingresá con tu teléfono para continuar/);
  });
});
