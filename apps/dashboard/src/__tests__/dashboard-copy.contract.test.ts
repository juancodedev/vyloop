/**
 * App-wide copy rules from the redesign.
 *
 * - No browser `alert()` or `confirm()`: they look like a different program,
 *   block the tab, and cannot be styled or read the way the rest of the app is.
 *   Pages ask through `useConfirm` and report errors through toasts.
 * - The merchant app speaks Chilean "tú", not voseo.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatBirthDate } from '../lib/customer-edit';

const SRC = new URL('..', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = [
  ...sourceFiles(join(SRC, 'app')),
  ...sourceFiles(join(SRC, 'components')),
  ...sourceFiles(join(SRC, 'lib')),
];

/** The voseo forms this app used, written as whole words. */
const VOSEO = [
  'Configurá',
  'volvé',
  'acá',
  'Escaneá',
  'Gestioná',
  'Usá',
  'Componé',
  'enviá',
  'Enviá',
  'Seleccioná',
  'Revisá',
  'intentá',
  'Habilitalo',
  'Buscá',
  'Podés',
  'Identificá',
  'Registralo',
  'anotá',
  'escalalo',
  'Mostrale',
  'Cerrala',
];

describe('the merchant app', () => {
  it('never opens a browser alert or confirm', () => {
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/(?<![\w.])(window\.)?(alert|confirm)\(/);
    }
  });

  it('speaks tú, not voseo', () => {
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      for (const word of VOSEO) {
        expect(code, `${file} says "${word}"`).not.toMatch(
          new RegExp(`(?<![\\wáéíóúñ])${word}(?![\\wáéíóúñ])`),
        );
      }
    }
  });

  it('shows a birth date on the day it was entered, in the Chilean format', () => {
    // A bare `new Date('1990-03-05')` is midnight UTC, which is still the 4th in
    // Santiago, so the profile used to show the day before.
    expect(formatBirthDate('1990-03-05')).toBe('05-03-1990');
    expect(formatBirthDate('2001-12-31')).toBe('31-12-2001');
  });
});
