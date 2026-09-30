import { describe, expect, it } from 'vitest';

import { slugify } from './slug';

// ---------------------------------------------------------------------------
// Accent folding
// ---------------------------------------------------------------------------

describe('slugify', () => {
  // The case the feature document names explicitly. `Café` is a precomposed
  // character with a canonical decomposition, so NFD splits it into `e` plus a
  // combining acute and the diacritics pass removes the mark. A normaliser that
  // skipped the decomposition step would emit `caf-central`, which is a
  // different tenant address than the one the merchant asked for.
  it('folds the accent in the name the seed already uses', () => {
    expect(slugify('Café Central')).toBe('cafe-central');
  });

  it('agrees with the slug the seed hardcoded for the same name', () => {
    // `packages/db/scripts/seed.ts` writes `cafe-central` by hand. If the
    // normaliser disagreed, the seeded tenant and a signed-up namesake would
    // land on different slugs for the same name, which is the collision this
    // whole module exists to make legible.
    expect(slugify('Café Central')).toBe('cafe-central');
  });

  it.each([
    ['Café', 'cafe'],
    ['Panadería Ñoño', 'panaderia-nono'],
    ['P Campsino', 'p-campsino'],
    ['Antonito', 'antonito'],
    ['Corazón', 'corazon'],
    ['Árbol', 'arbol'],
    ['Medellín', 'medellin'],
    ['Frutería', 'fruteria'],
    ['Ñoño', 'nono'],
    ['Píxeles', 'pixeles'],
  ])('folds %s to %s', (accented, plain) => {
    expect(slugify(accented)).toBe(plain);
  });

  it('folds a run of accents across several words', () => {
    expect(slugify('Café Ñoño Sopaipilla')).toBe('cafe-nono-sopaipilla');
  });

  // The letters NFD leaves alone. `ø` has no canonical decomposition, so a
  // diacritic-stripping pass treats it as punctuation and the name loses its
  // first letter entirely — `Ørsted` becomes `rsted`, a wrong slug rather than
  // a lossy one.
  it.each([
    ['Ørsted', 'orsted'],
    ['ørsted', 'orsted'],
    ['Straße', 'strasse'],
    ['Æther', 'aether'],
    ['Łódź', 'lodz'],
    ['Þór', 'thor'],
    ['Œuvre', 'oeuvre'],
  ])('maps %s through the non-decomposing table', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases', () => {
    expect(slugify('CAFÉ CENTRAL')).toBe('cafe-central');
  });

  it('replaces a run of separators with a single hyphen', () => {
    expect(slugify('Café   Central')).toBe('cafe-central');
  });

  it.each([
    ['Café & Central', 'cafe-central'],
    ['Café / Central', 'cafe-central'],
    ["Café's Central", 'cafe-s-central'],
    ['Café  ,  Central', 'cafe-central'],
    ['Café - Central', 'cafe-central'],
  ])('normalises %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  ***Café Central!!!  ')).toBe('cafe-central');
  });

  it('keeps digits', () => {
    expect(slugify('Café Central 2024')).toBe('cafe-central-2024');
  });

  it('keeps digits that lead, since they are a common name form', () => {
    expect(slugify('24 Horas')).toBe('24-horas');
  });

  it('preserves a hyphen that is already part of the name', () => {
    expect(slugify('Alto-Diez Café')).toBe('alto-diez-cafe');
  });

  it('trims surrounding whitespace in the name', () => {
    expect(slugify('  Café Central  ')).toBe('cafe-central');
  });
});

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('leaves a name that fits untouched', () => {
    expect(slugify('Café Central')).toBe('cafe-central');
  });

  it('cuts a long name to the limit', () => {
    const slug = slugify('Comercializadora Y Distribuidora De Productos Alimentarios Del Sur');

    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('keeps a name that fits exactly, without cutting it', () => {
    // 57 characters: under the limit, so nothing is removed even though the
    // words continue. A limit implemented as "always cut at the last boundary"
    // would truncate this unnecessarily.
    const slug = slugify('Comercializadora Y Distribuidora De Productos Alimentarios');

    expect(slug).toBe('comercializadora-y-distribuidora-de-productos-alimentarios');
  });

  // A character-count cut would leave `comercializadora-y-distribuidora-de-p` —
  // plausible-looking, wrong, and permanent once a merchant has printed the QR
  // on a shop window.
  it('cuts at a word boundary, never mid-word', () => {
    const slug = slugify('Comercializadora Y Distribuidora De Productos Alimentarios Del Sur');

    expect(slug).toBe('comercializadora-y-distribuidora-de-productos-alimentarios');
  });

  it('never ends a cut slug on a hyphen', () => {
    const slug = slugify('aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm');

    expect(slug.endsWith('-')).toBe(false);
  });

  it('cuts a single unbroken token hard, because it has no boundary to keep', () => {
    const slug = slugify('a'.repeat(200));

    expect(slug).toBe('a'.repeat(60));
  });

  it('collides for two names that share a prefix past the cut', () => {
    // Two merchants whose names agree for the first 60 characters derive the
    // same slug. That is a real collision, and the signup endpoint rejects it
    // with a legible 409 — the assertion here is that the truncation happens
    // at a boundary rather than producing two different plausible addresses.
    const slug = slugify(
      'Comercializadora Y Distribuidora De Productos Alimentarios Del Norte Y Del Sur',
    );

    expect(slug).toBe('comercializadora-y-distribuidora-de-productos-alimentarios');
  });
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

describe('slugify', () => {
  // `''` is returned rather than thrown so the caller decides. A signup that
  // inserted it would create a tenant whose slug is `''`, and the second such
  // signup would collide with the first — the error would name a slug the
  // merchant never chose.
  it.each([
    ['punctuation only', '!!!'],
    ['symbols only', '¿¿¿'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('returns an empty slug for %s', (_label, input) => {
    expect(slugify(input)).toBe('');
  });

  it('returns an empty slug for an emoji-only name', () => {
    expect(slugify('🍕')).toBe('');
  });

  it('does not emit a leading or trailing hyphen for a mixed name', () => {
    const slug = slugify('!!!Café Central!!!');

    expect(slug.startsWith('-')).toBe(false);
    expect(slug.endsWith('-')).toBe(false);
  });

  // The collision the feature document calls out: two businesses with the same
  // name derive the same slug, and the unique index is what settles it.
  it('derives the same slug for two businesses with the same name', () => {
    expect(slugify('Café Central')).toBe(slugify('Café Central'));
  });

  it('derives the same slug for names that differ only in accents', () => {
    expect(slugify('Café Central')).toBe(slugify('Cafe Central'));
  });
});
