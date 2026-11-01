// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const explainer = readFileSync(
  new URL('./components/club-qr-explainer.tsx', import.meta.url),
  'utf8',
);

describe('Stage 1 club-barrio entry contract', () => {
  it('preserves auth loading and redirect behavior without business data', () => {
    expect(page).toMatch(/useAuth\(\)/);
    expect(page).toMatch(/router\.replace\('\/profile'\)/);
    expect(page).toMatch(/<ClubLoading \/>/);
    expect(page).not.toMatch(/from ['"]\.\/lib\/api['"]/);
  });

  it('keeps only the actions behind the Suspense boundary, so the HTML carries the copy', () => {
    // `useSearchParams` makes Next render the Suspense fallback into the static
    // HTML. When the whole page sat inside it, the prerendered page was only
    // "Cargando…".
    expect(page).toMatch(/<Suspense fallback=\{<ActionsLoading \/>\}>\s*<EntryActions \/>\s*<\/Suspense>/);
    const home = page.slice(page.indexOf('export default function Home'));
    expect(home).toMatch(/<h1 id="club-entry-title"/);
    expect(home).toMatch(/<ClubQrExplainer \/>/);
  });

  it('preserves business navigation context', () => {
    expect(page).toMatch(/useSearchParams\(\)/);
    expect(page).toMatch(/searchParams\.set\('biz', businessSlug\)/);
    expect(page).toMatch(/href=\{loginHref\}/);
    expect(page).toMatch(/href=\{registerHref\}/);
  });

  it('exposes only the two entry actions and a textual QR flow', () => {
    expect(page).toMatch(/>Ingresar</);
    expect(page).toMatch(/>\s*Registrarme\s*</);
    expect(explainer).toMatch(/Escanea el QR/);
    expect(explainer).toMatch(/Crea tu cuenta/);
    expect(explainer).toMatch(/Muestra tu código/);
    expect(explainer).toMatch(/No necesitas descargar una aplicación para empezar/);
    expect(page).not.toMatch(/<svg/);
    expect(explainer).not.toMatch(/<svg/);
  });

  it('only offers registration when a business context exists', () => {
    // Registration refuses to create a customer without a tenant, so the entry
    // page must not send anyone there without one. Login has no such
    // requirement and stays available either way.
    expect(page).toMatch(/const canRegister = businessSlug !== null;/);
    expect(page).toMatch(/\{canRegister \? \(\s*<Link href=\{registerHref\}/);
    expect(page).toMatch(/>\s*Registrarme\s*<\/Link>\s*\) : null\}/);
  });
});
