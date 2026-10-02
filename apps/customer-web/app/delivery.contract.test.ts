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

/**
 * The same scan with comments removed.
 *
 * Rules about **copy** need this and rules about **identifiers** must not use it.
 * A rule about the words a page can say to a customer should be about what the
 * customer can be shown, so a comment explaining why a phrase was retired must
 * be able to quote that phrase — otherwise the documentation of the failure
 * becomes the failure. A rule about a `WALLET_*` constant is the opposite: it is
 * about where an identifier is *written*, and a comment naming one is harmless,
 * so that scan stays raw.
 *
 * Block comments and line comments, both. Not a parser, and it does not need to
 * be: it only has to make prose invisible to a prose rule, and a `//` inside a
 * string literal is rarer than the false positives this removes.
 */
function copyOffenders(pattern: RegExp, files: string[] = production): string[] {
  const found: string[] = [];

  for (const path of files) {
    const withoutComments = readFileSync(path, 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ' '))
      .replaceAll(/\/\/[^\n]*/g, (line) => line.replaceAll(/[^\n]/g, ' '));

    withoutComments
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
  it('offers the wallet pass, and routes its copy through one module', () => {
    // This rule used to be the opposite: "never presents a wallet call to
    // action", because the issuer was unapproved and a button would have been a
    // promise the product could not keep. The issuer is approved and a pass
    // works on a real phone, so that premise is retired — and the replacement is
    // deliberately not "the button is allowed".
    //
    // What replaces it is a rule about **where the copy lives and what it may
    // say**, which is checkable where a word-ban was not. Two halves:
    //
    //   a) the UI exists — asserted positively, so this cannot pass on an app
    //      that quietly dropped the feature again;
    //   b) every `WALLET_*` code and every refusal message lives in
    //      `lib/wallet.ts` alone. A component cannot grow its own "no tenés
    //      tarjeta" branch, and cannot add a code the mapping does not know,
    //      because both would put a code somewhere but there.
    //
    // So this is tighter than what it replaces: the old guard forbade a
    // capability, this one constrains how the capability is allowed to speak.
    const profile = readFileSync(join(appDir, 'profile/page.tsx'), 'utf8');

    expect(profile).toMatch(/<WalletCard\b/);
    expect(profile).not.toMatch(/WALLET_[A-Z_]+/);

    // The API method has to exist and the client has to have one.
    const apiClient = readFileSync(join(appDir, 'lib/api.ts'), 'utf8');
    expect(apiClient).toMatch(/getWalletPass/);
    expect(apiClient).toMatch(/'\/v1\/wallet\/pass'/);

    // The codes, and only there.
    const wallet = readFileSync(join(appDir, 'lib/wallet.ts'), 'utf8');
    expect(wallet).toMatch(/WALLET_CLASS_NOT_PROVISIONED/);
    expect(wallet).toMatch(/WALLET_CLASS_NOT_APPROVED/);
    expect(wallet).toMatch(/WALLET_NOT_CONFIGURED/);
    expect(wallet).toMatch(/WALLET_PASS_NOT_CREATABLE/);

    // Spelled as a **string literal**, not merely mentioned. An identifier imported
    // from this module is the guard working: it is the one way a caller may name
    // a code without owning its wording. What must not exist anywhere else is a
    // code someone typed, because that is a new branch with no reason attached.
    const spelledElsewhere = copyOffenders(
      /['"`][^'"`\n]*WALLET_[A-Z_]+/,
      production.filter((p) => !p.endsWith('lib/wallet.ts')),
    );

    expect(spelledElsewhere).toEqual([]);
  });

  it('never tells a customer their account is why there is no pass', () => {
    // The precise failure the retired guard was reaching for, stated as the
    // thing it was actually afraid of. A ban on the words "Google Wallet" could
    // never have caught a 409 rendered as "no tenés tarjeta" — it caught the
    // feature instead. These are the phrasings that do the damage, enumerated
    // because each one is a specific way of blaming the customer.
    const blaming = [
      /no ten[eé]s (una |tu )?(tarjeta|pase|pass)/i,
      /no tienes (una |tu )?(tarjeta|pase|pass)/i,
      /tu cuenta no (tiene|posee|alcanza)/i,
      /tu cuenta (est[áa] mal|est[áa] rota|no existe|est[áa] incompleta)/i,
      /no sos (un |una )?(cliente|socio|miembro)/i,
    ];

    for (const pattern of blaming) {
      expect(copyOffenders(pattern), pattern.source).toEqual([]);
    }
  });

  it('never promises a pass that a refusal cannot back', () => {
    // A 409 is not a queued success. For a merchant whose class was never
    // submitted, the card may never arrive at all, so "ya va a estar
    // disponible" is a promise nobody can keep — which is the claim the old
    // word-ban was really about, and which a word-ban could not express.
    const wallet = readFileSync(join(appDir, 'lib/wallet.ts'), 'utf8');

    expect(copyOffenders(/pr[óo]ximamente|very soon|en breve|coming soon|m[áa]s pronto/i)).toEqual(
      [],
    );
    expect(wallet).not.toMatch(/pr[óo]ximamente|en breve|coming soon/i);
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
