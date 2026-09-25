// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../lib/auth.tsx', import.meta.url), 'utf8');
const apiClient = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

describe('Stage 3 club-barrio login contract', () => {
  it('keeps the mobile-friendly phone input attributes and drops autoFocus', () => {
    expect(page).toMatch(/type="tel"/);
    expect(page).toMatch(/inputMode="tel"/);
    expect(page).toMatch(/autoComplete="tel"/);
    expect(page).toMatch(/name="phone"/);
    expect(page).not.toMatch(/autoFocus/);
  });

  it('focuses the phone input only to report a validation error, never on load', () => {
    // The one focus call is guarded by an error flag that only local
    // validation sets, so the mobile keyboard is never forced open on mount.
    expect(page).toMatch(/if \(!shouldFocusPhone\.current\) return;/);
    expect(page).toMatch(/shouldFocusPhone\.current = true;/);
    expect(page).toMatch(/phoneRef\.current\?\.focus\(\);/);
    expect(page.match(/\.focus\(\)/g)).toHaveLength(1);
  });

  it('does not lock browser zoom or depend on a 100vh layout', () => {
    expect(page).not.toMatch(/maximum-scale/);
    expect(page).not.toMatch(/user-scalable/);
    expect(page).not.toMatch(/100vh/);
  });

  it('uses the real ellipsis character in every visible state', () => {
    expect(page).not.toMatch(/\.\.\./);
    expect(page).toMatch(/'Entrando…'/);
    expect(page).toMatch(/label="Preparando tu ingreso…"/);
  });

  it('preserves the business context without ever rendering the raw slug', () => {
    expect(page).toMatch(/useSearchParams\(\)/);
    expect(page).toMatch(/searchParams\.get\('biz'\)/);
    expect(page).toMatch(/function buildBusinessHref\(/);
    expect(page).toMatch(/buildBusinessHref\('\/register', businessSlug\)/);
    // The context card is a static pattern, not a rendering of the slug value.
    expect(page).toMatch(/<h2 className="club-login__context-title">Este programa<\/h2>/);
    expect(page).not.toMatch(/\{businessSlug\}/);
  });

  it('keeps login usable without a business context', () => {
    expect(page).not.toMatch(/disabled=\{!hasBusinessContext\}/);
    expect(page).not.toMatch(/Falta el contexto del comercio/);
  });

  it('normalizes the phone once and branches on the typed login result', () => {
    expect(page).toMatch(/function parsePhone\(rawPhone: string\): string \| null \{/);
    expect(page).toMatch(/const cleaned = rawPhone\.replace\(\/\[\\s-\]\/g, ''\);/);
    expect(page).toMatch(/if \(!cleaned\) return null;/);
    expect(page).toMatch(/const fullPhone = parsePhone\(phone\);/);
    expect(page).toMatch(/const result = await login\(fullPhone, businessSlug \?\? undefined\);/);
    expect(page).toMatch(/if \(result\.ok\) \{\s*router\.push\('\/profile'\);/);
    // A single parse means the separators are stripped exactly once.
    expect(page.match(/\.replace\(\/\[\\s-\]\/g/g)).toHaveLength(1);
  });

  it('separates the not-registered outcome from the connectivity outcome', () => {
    expect(page).toMatch(/not_registered: 'Número no registrado\. ¿Ya te registraste\?'/);
    expect(page).toMatch(/unavailable: 'No pudimos conectar con el servidor\./);
    expect(page).toMatch(/unknown: 'No pudimos completar el ingreso\./);
    // Every title must differ from its own message so a screen reader never
    // announces the same sentence twice.
    expect(page).toMatch(/not_registered: 'No encontramos ese número\.'/);
    expect(page).toMatch(/unavailable: 'No pudimos ingresarte ahora\.'/);
    expect(page).toMatch(/unknown: 'Algo salió mal al ingresar\.'/);
    expect(page).toMatch(/failure === 'not_registered' \? \(/);
    expect(page).toMatch(/Registrarme ahora/);
  });

  it('surfaces a typed API error and a discriminated login result at the root', () => {
    expect(apiClient).toMatch(/export class ApiError extends Error \{/);
    expect(apiClient).toMatch(/readonly status: number;/);
    expect(apiClient).toMatch(/readonly code: string;/);
    expect(apiClient).toMatch(/throw new ApiError\(\s*res\.status,/);
    // The human-readable message must be byte-identical to the previous one.
    expect(apiClient).toMatch(/data\?\.error\?\.message \|\| `Error \$\{res\.status\}`/);

    expect(auth).toMatch(/export type LoginResult = \{ ok: true \} \| \{ ok: false; reason: LoginFailureReason \};/);
    expect(auth).toMatch(/login: \(phone: string, businessSlug\?: string\) => Promise<LoginResult>;/);
    expect(auth).toMatch(/return \{ ok: true \};/);
    expect(auth).toMatch(/return \{ ok: false, reason: classifyLoginFailure\(error\) \};/);
    expect(auth).toMatch(/if \(error\.status === 401\) return 'not_registered';/);
    expect(auth).toMatch(/if \(error\.status >= 500\) return 'unavailable';/);
  });

  it('keeps the success side effects of the previous login implementation', () => {
    expect(auth).toMatch(/localStorage\.setItem\(JWT_KEY, result\.token\);/);
    expect(auth).toMatch(/localStorage\.setItem\(CUSTOMER_KEY, JSON\.stringify\(info\)\);/);
    expect(auth).toMatch(/setCustomer\(info\);/);
  });
});
