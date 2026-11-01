// @vitest-environment node

/**
 * The customer app speaks neutral Spanish with "tú", not voseo.
 *
 * Customers are in Chile, and the product decision (2026-11-01) is neutral
 * Spanish for every text the app shows. The list below is the voseo this app
 * used before that decision, written as whole words, plus the pronouns that
 * only voseo uses. The merchant app has the same rule in
 * `apps/dashboard/src/__tests__/dashboard-copy.contract.test.ts`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP = new URL('.', import.meta.url).pathname;
const PUBLIC = new URL('../public/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = [
  ...sourceFiles(APP),
  ...readdirSync(PUBLIC)
    .filter((name) => name.endsWith('.html'))
    .map((name) => join(PUBLIC, name)),
];

const VOSEO = [
  'Ingresá',
  'Volvé',
  'volvé',
  'intentá',
  'Intentá',
  'reintentá',
  'Revisá',
  'revisá',
  'cerrá',
  'abrí',
  'Incluí',
  'elegí',
  'dictá',
  'Probá',
  'Mostrá',
  'Escribí',
  'Escaneá',
  'Entrá',
  'Creá',
  'Acumulá',
  'Canjeá',
  'podés',
  'Podés',
  'tenés',
  'querés',
  'Querés',
  'necesitás',
  'pertenecés',
  'seguís',
  'entrás',
  'agregás',
  'Mostrale',
  'Registrate',
  'Contale',
  'contale',
  'Agregala',
  'usala',
  'Usala',
  'pedilo',
  'vos',
  'sos',
  'acá',
];

describe('the customer app', () => {
  it('reads the sources it is meant to check', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('speaks neutral Spanish with tú, not voseo', () => {
    for (const file of files) {
      // Comments may quote the old wording when they explain a change, and a
      // regular expression may list voseo on purpose to reject it; only the
      // strings a customer can read are checked.
      const strings = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && !/^\s*\/.*\/[a-z]*,?\s*$/.test(line))
        .join('\n');
      for (const word of VOSEO) {
        expect(strings, `${file} says "${word}"`).not.toMatch(
          new RegExp(`(?<![\\wáéíóúñ])${word}(?![\\wáéíóúñ])`),
        );
      }
    }
  });
});
