// @vitest-environment node

/**
 * Stage 7 delivery gate: the claims the customer web must never make.
 *
 * The Stage 7 checklist asks for confirmation that there is no Apple Wallet or
 * Google Wallet call to action, no PWA claim, no social proof, no reference to
 * a specific seeded business, and no hardcoded tier thresholds. Those are all
 * things that regress silently — nobody adds "Google Wallet" to a loyalty
 * product on purpose, and a threshold copy-pasted from the seed looks correct
 * right up until a merchant changes it.
 *
 * A one-time grep cannot hold that line. This file can.
 *
 * It also pins the data-provenance rule: no page may fall back to invented
 * content when the API returns nothing. An empty response must render an empty
 * state, not a plausible-looking placeholder.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appDir = new URL('./', import.meta.url).pathname;

/** This file and the other guards, so their own literals are never flagged. */
const GUARDS = [
  'delivery.contract.test.ts',
  'globals.contract.test.ts',
  'a11y-hygiene.contract.test.ts',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);

    return /\.tsx?$/.test(entry) ? [path] : [];
  }).flat() as string[];
}

const all = sourceFiles(appDir);
const isGuard = (path: string) => GUARDS.some((g) => path.endsWith(g));

/** Production sources only — behaviour tests are allowed to name real fixtures. */
const production = all.filter((p) => !isGuard(p) && !/\.test\.tsx?$/.test(p));

/** A file that trips a rule, reported with the offending line for a useful failure. */
function offenders(pattern: RegExp, files: string[] = production): string[] {
  const found: string[] = [];

  for (const path of files) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line)) {
          found.push(`${path.replace(appDir, 'app/')}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
  }

  return found;
}

describe('delivery gate: claims the customer web must never make', () => {
  it('never presents a wallet call to action', () => {
    // Google Wallet is a planned capability, not a shipped one. Until the
    // issuer is approved, a "Add to Google Wallet" button is a promise the
    // product cannot keep.
    expect(offenders(/apple\s*wallet|google\s*wallet|\bpass\s*to\s*wallet\b|add\s*to\s*wallet/i)).toEqual([]);
  });

  it('never claims to be installable or offline-capable', () => {
    // There is no manifest and no service worker; both were explicitly out of
    // scope. An install prompt would be a PWA claim the product does not honour.
    expect(offenders(/\binstal(?:a|able|ación|acion)\b|\boffline\b|\badd to home screen\b|\bdescarg(?:a|á|able)\b/i)).toEqual([]);
  });

  it('carries no social proof', () => {
    expect(offenders(/\b\d+\s*\+?\s*(?:clientes|socios|comercios|negocios|usuarios)\b|\btestimon|\breseñ|\bvalorad|\b4[.,]?\d\s*(?:\/\s*5|estrellas)\b|\bmejor valorad/i)).toEqual([]);
  });

  it('names no specific seeded business', () => {
    // `cafe-central` and `demo-shop` exist in the seed scripts. A customer must
    // never see a tenant that happens to be in the database.
    expect(offenders(/\bcafe-central\b|\bdemo-shop\b|\bbarro\b/i)).toEqual([]);
  });

  it('declares no threshold constant of its own', () => {
    // Threshold VALUES cannot be guarded by regex and this file does not
    // pretend otherwise: a hardcoded limit can be written as `1000`, as
    // `1000` in a comment, as `1_000`, or assembled from a token, and a
    // pattern that chased all of those would be both leaky and falsely
    // reassuring. A value-based guard is not enforceable here.
    //
    // What IS reliably enforceable is the shape. Thresholds are per-merchant
    // data in `membership_tiers.min_points`; the client must read them, which
    // is why `minPoints: number` legitimately appears as a field on the API
    // response type. The rule is therefore narrow on purpose: the client may
    // not *declare* a threshold constant of its own. The tier-coherence
    // contract test separately guarantees `nextTier` comes from the server
    // rather than being re-derived here.
    expect(
      offenders(/\b(?:MIN|MINIMUM|THRESHOLD|REQUIRED)_(?:POINTS|PUNTOS|BALANCE|SALDO|SCORE)\b/),
    ).toEqual([]);
  });

  it('falls back to no invented content when the API returns nothing', () => {
    // The dangerous pattern is `data?.x ?? 'Café'` — a hardcoded literal that
    // looks like real program data to a customer. Honest fallbacks are `?? null`
    // (drop the unit rather than guess it), `?? 0` (a real zero) and `?? ''`.
    // So the rule is specifically a fallback to a NON-EMPTY string literal on a
    // line that talks about program data.
    const invented = offenders(/(?:\?\?|\|\|)\s*(['"`])(?!\1*\1)[^'"`\n]+\1/).filter(
      (line) => /nombre|name|punto|point|saldo|balance|recompensa|reward|precio|price|costo|cost|moneda|currency/i.test(line),
    );

    expect(invented).toEqual([]);
  });
});

describe('delivery gate: runtime data provenance', () => {
  it('never names a real tenant slug in a production source', () => {
    // Behaviour tests legitimately mock a slug. Production code must receive
    // it from the URL or the API, so that a second merchant works unchanged.
    expect(offenders(/\bcafe-central\b|\bdemo-shop\b/i)).toEqual([]);
  });
});
