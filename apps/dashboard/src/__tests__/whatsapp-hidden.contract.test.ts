/**
 * WhatsApp is hidden for now: the platform does not use it, so the merchant
 * app must not offer it anywhere. Its pages stay in the tree, redirected, so
 * the work behind them can come back without being rewritten.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOTTOM_ITEMS, getPageTitle, NAV_SECTIONS } from '../lib/navigation';

const SRC = new URL('..', import.meta.url).pathname;
const HIDDEN = ['/dashboard/communication/templates', '/dashboard/communication/send'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

/** JSX text and string literals, without comments. */
function visibleText(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('WhatsApp, while it is hidden', () => {
  it('has no entry in the sidebar', () => {
    const hrefs = [...NAV_SECTIONS.flatMap((s) => s.items), ...BOTTOM_ITEMS].map((i) => i.href);
    for (const path of HIDDEN) expect(hrefs).not.toContain(path);
  });

  it('has no page title of its own', () => {
    expect(getPageTitle('/dashboard/communication/templates')).not.toBe('Plantillas');
    expect(getPageTitle('/dashboard/communication/send')).not.toBe('Enviar mensaje');
  });

  it('is linked from nowhere and named nowhere on screen', () => {
    for (const file of sourceFiles(join(SRC, 'app')).concat(sourceFiles(join(SRC, 'components')))) {
      const text = visibleText(readFileSync(file, 'utf8'));
      for (const path of HIDDEN) expect(text, file).not.toContain(`href=${JSON.stringify(path)}`);
      expect(text, file).not.toMatch(/whatsapp/i);
    }
  });

  it('redirects its old pages to the campaigns', () => {
    for (const path of HIDDEN) {
      const page = readFileSync(join(SRC, 'app', path, 'page.tsx'), 'utf8');
      expect(page).toMatch(/redirect\('\/dashboard\/communication\/campaigns'\)/);
    }
  });
});
