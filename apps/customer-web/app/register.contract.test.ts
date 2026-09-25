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

  it('renders consent controls as unavailable and keeps them out of the payload', () => {
    expect(consentList).toMatch(/checked=\{false\}/);
    expect(consentList).toMatch(/disabled/);
    expect(consentList).toMatch(/No disponible todavía/);
    expect(consentList).toMatch(/Desactivado/);
    expect(page).not.toMatch(/consents\s*:/);
  });

  it('contains actionable network and partial-success paths', () => {
    expect(page).toMatch(/Failed to fetch|failed to fetch|networkerror|load failed/);
    expect(page).toMatch(/gateway local/);
    expect(page).toMatch(/Tu cuenta fue creada/);
    expect(page).toMatch(/Ingresá con tu teléfono para continuar/);
  });
});
