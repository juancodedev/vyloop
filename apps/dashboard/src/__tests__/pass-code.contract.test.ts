// @vitest-environment node

/**
 * The POS scanner turns a decoded code into a `globalId`, or refuses to.
 *
 * ## What was actually broken
 *
 * The premise when this was written was that the parser could not read the new
 * pass barcode. It could: a second fallback pattern matched any uuid anywhere in
 * the decoded text, and `<issuerId>.member-<uuid>` contains one. The real defect
 * was the line after it:
 *
 * ```ts
 * const globalId = match ? match[1] : decodedText.trim();
 * ```
 *
 * With no match, `decodedText` itself became the id. A restaurant menu QR longer
 * than ten characters was sent to `GET /v1/customers/by-global-id/<id>` and the
 * cashier was told "Cliente no encontrado" -- a statement about a person, made
 * because a camera decoded a poster. The id also lands in a URL path unencoded,
 * so a decoded string containing a space or a slash does not merely miss, it
 * asks about a different endpoint.
 *
 * So the fix is not "add the new format". The new format works by accident and
 * is pinned here deliberately, and what actually changes is that nothing is
 * invented.
 *
 * ## Both formats are load-bearing
 *
 * `/c/<globalId>` is what `apps/customer-web/app/components/member-qr.tsx`
 * encodes, and those QRs are printed on cards already in customers' hands.
 * Dropping that format would strand real cards, so it is a first-class case here
 * and not a deprecated one.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveLookupTarget } from '../lib/lookup-identifier';
import { parsePassCode, type PassCodeResult } from '../lib/pass-code';

const posSource = readFileSync(
  new URL('../app/dashboard/loyalty/pos/page.tsx', import.meta.url).pathname,
  'utf8',
);

/** The id, or a thrown expectation if the parse refused. */
function globalIdOf(decoded: string): string {
  const result: PassCodeResult = parsePassCode(decoded);
  expect(result.ok, `expected ${JSON.stringify(decoded)} to resolve`).toBe(true);
  return result.ok ? result.globalId : '';
}

const UUID = '879e76de-1f50-4afe-8b93-11949e9a9ae4';
/** Built the way `objectIdFor` in `workers/wallet/src/ids.ts` builds it. */
const ISSUER = '3388000000023206930';

describe('the barcode on the new pass', () => {
  it('resolves the globalId out of the object id', () => {
    // The literal from the failing scan. If this one stops resolving, a
    // production scanner has gone dark again.
    expect(globalIdOf(`${ISSUER}.member-${UUID}`)).toBe(UUID);
  });

  it('does not mistake the issuer for the id', () => {
    // The issuer is 19 digits and the id is a uuid after `.member-`. A pattern
    // loose enough to grab the wrong side sends a real lookup for a number that
    // is not a customer.
    const result = parsePassCode(`${ISSUER}.member-${UUID}`);

    expect(result.ok && result.globalId).not.toContain(ISSUER);
    expect(result.ok && result.globalId).toHaveLength(36);
  });

  it('survives a scanner that reads it in a different case', () => {
    // `sanitizeIdPart` lowercases on the way out, but a pass can be re-encoded
    // by hand and the barcode must not depend on that.
    expect(globalIdOf(`${ISSUER}.MEMBER-${UUID.toUpperCase()}`)).toBe(UUID);
  });
});

describe('the QR printed on cards that already exist', () => {
  it('still resolves the globalId from the /c/ link', () => {
    // This path cannot be broken. Those cards are in customers' hands today.
    expect(globalIdOf(`/c/${UUID}`)).toBe(UUID);
  });

  it('still resolves when the link was typed or re-encoded by hand', () => {
    expect(globalIdOf(`/C/${UUID.toUpperCase()}`)).toBe(UUID);
    expect(globalIdOf(`  /c/${UUID}  `)).toBe(UUID);
  });

  it('resolves a bare id, which is what a pasted link reduces to', () => {
    expect(globalIdOf(UUID)).toBe(UUID);
  });
});

describe('a code that is neither format', () => {
  // Every one of these is something a camera at a counter can realistically
  // decode. Each used to become a `globalId` and a lookup for a person who does
  // not exist.
  const notAPass = [
    ['a menu url', 'https://example.com/menu?table=12'],
    ['plain text', 'Menu del dia: empanadas'],
    ['a product code', 'SKU-998-ABCDEF-GHIJK'],
    ['a truncated scan', `${ISSUER}.member-879e76de-1f50-4afe`],
    ['a link with trailing junk', `/c/${UUID}/x`],
    ['an empty decode', ''],
    ['whitespace', '   '],
  ] as const;

  for (const [label, decoded] of notAPass) {
    it(`refuses ${label} instead of inventing an id`, () => {
      const result = parsePassCode(decoded);

      // The assertion that matters: no id comes back. A test that only checked
      // for an error field would still pass if the function returned one too.
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('globalId');
      if (!result.ok) expect(result.reason).toBe('unreadable');
    });
  }

  it('does not leak the decoded text back to the caller', () => {
    // Nothing in the refusal may contain what was scanned, or the next thing to
    // happen is that string being used as an id somewhere downstream.
    for (const [, decoded] of notAPass) {
      const result = parsePassCode(decoded);

      // Exactly these keys, so an invented id has nowhere to hide.
      expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
      if (decoded.trim() !== '') expect(JSON.stringify(result)).not.toContain(decoded.trim());
    }
  });
});

describe('the scanner and the search box agree', () => {
  // The two paths to the same customer are separate code. When they disagree,
  // a code works when scanned and misses when pasted, and nobody can tell which
  // one is lying.
  const codes: ReadonlyArray<readonly [string, string]> = [
    ['the new barcode', `${ISSUER}.member-${UUID}`],
    ['the old link', `/c/${UUID}`],
    ['a bare id', UUID],
  ];

  for (const [label, code] of codes) {
    it(`resolves ${label} to the same customer either way`, () => {
      const typed = resolveLookupTarget(code);

      expect(typed?.identifier).toBe('globalId');
      expect(typed?.value).toBe(globalIdOf(code));
    });
  }
});

describe('what the page does with a decoded code', () => {
  it('asks the module rather than parsing in place', () => {
    expect(posSource).toMatch(/from '@\/lib\/pass-code'/);
    expect(posSource).toContain('parsePassCode');

    // The two inline patterns this replaces. Left in place, one of them would
    // keep matching and the module would look like the only path while the old
    // behaviour was still reachable.
    expect(posSource).not.toMatch(/decodedText\.match/);
    expect(posSource).not.toMatch(/\\\/c\\\//);
  });

  it('never sends the decoded text as an id', () => {
    // `getCustomerByGlobalId(decodedText)` is the exact line that turned a menu
    // QR into "Cliente no encontrado".
    expect(posSource).not.toMatch(/getCustomerByGlobalId\(\s*decodedText/);
    expect(posSource).not.toMatch(/globalId\s*=\s*decodedText/);
  });

  it('sends the id the parser returned', () => {
    expect(posSource).toContain('parsed.globalId');
  });

  it('says the code could not be read when the parser refuses', () => {
    // The user has to be told what happened, in the words they can act on.
    expect(posSource).toContain('No se pudo leer el código QR');
    expect(posSource).toMatch(/if\s*\(\s*!parsed\.ok\s*\)/);
  });
});
