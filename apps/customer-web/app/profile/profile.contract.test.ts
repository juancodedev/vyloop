// @vitest-environment node

/**
 * Minimal source contract for the things that CANNOT be observed from the DOM.
 *
 * Everything a person can see or do is asserted in `profile.behavior.test.tsx`.
 * What is left here are absences and literals: a deleted symbol has no rendered
 * trace, and the QR payload is a byte string that only the scanner ever sees.
 * This file must stay small — it is a safety net, not a substitute for the
 * behaviour suite.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const pass = readFileSync(new URL('../components/member-pass.tsx', import.meta.url), 'utf8');
const qr = readFileSync(new URL('../components/member-qr.tsx', import.meta.url), 'utf8');
const apiClient = readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8');

describe('Stage 4 club-barrio pass contract', () => {
  it('no longer carries a client-side tier rule', () => {
    // The thresholds lived in the frontend and contradicted the seed. The rule
    // now belongs to the server alone, so the table must be gone for good.
    expect(page).not.toMatch(/TIER_CONFIG/);
    expect(page).not.toMatch(/getTierConfig/);
    expect(page).not.toMatch(/Bronce|Plata|Oro/);
    expect(pass).not.toMatch(/Bronce|Plata|Oro/);
  });

  it('no longer invents a status claim about the customer', () => {
    expect(page).not.toMatch(/getTierEmoji/);
    expect(page).not.toMatch(/más valioso/);
    expect(page).not.toMatch(/beneficios exclusivos/);
    expect(page).not.toMatch(/nivel máximo/);
    // The stamp ring had no backing rule anywhere in the system.
    expect(page).not.toMatch(/stampsCompleted|stampsTotal|\b8\/10\b/);
  });

  it('cannot call a consent endpoint that does not exist', () => {
    expect(apiClient).not.toMatch(/updateConsent/);
    expect(apiClient).not.toMatch(/me\/consent/);
    // The profile still RENDERS the read-only, disabled consent list, so the
    // guarantee is narrower than "no consent anywhere": nothing here may write,
    // and no control may present itself as a toggle that stores a choice.
    expect(page).not.toMatch(/updateConsent/);
    expect(page).not.toMatch(/me\/consent/);
    expect(page).not.toMatch(/handleConsentToggle|setConsentWhatsapp|savingConsent/);
    expect(page).not.toMatch(/role="switch"/);
  });

  it('does not read a metadata field the backend never sends', () => {
    expect(apiClient).not.toMatch(/metadata\?:/);
    expect(page).not.toMatch(/\.metadata/);
  });

  it('keeps the QR payload the POS scanner can actually read', () => {
    // The dashboard matches /\/\c\/([a-f0-9-]+)\/i and resolves the captured
    // id through /v1/customers/by-global-id/:globalId. A full URL or a
    // custom scheme would scan as something and fail silently at the counter.
    expect(qr).toMatch(/return `\/c\/\$\{globalId\}`;/);
    expect(qr).not.toMatch(/https?:\/\/[^`]*\$\{globalId\}/);
  });

  it('names the truth of the wallet state instead of staying silent about it', () => {
    // Replaces `offers no wallet pass`, which asserted that the profile must not
    // mention a wallet at all. That was a delivery gate on an unapproved issuer,
    // and it kept passing long after the reason for it stopped being true — so it
    // held a page silent about a working feature instead of holding it honest.
    //
    // What replaces it is the rule that guard was reaching for, asserted on this
    // file: the page renders the card, and it carries **no wallet copy of its
    // own**. Every refusal message lives in `lib/wallet.ts`, which is where
    // `delivery.contract.test.ts` asserts it stays. A branch invented inline here
    // is exactly how a 409 would end up rendered as "no tenés tarjeta".
    expect(page).toMatch(/<WalletCard\b/);

    // No code and no refusal prose: this page delegates the wording.
    expect(page).not.toMatch(/WALLET_[A-Z_]+/);
    expect(page).not.toMatch(/no ten[eé]s (una |tu )?(tarjeta|pase)/i);
    expect(page).not.toMatch(/tu cuenta (est[áa] mal|no tiene)/i);

    // And the member code is shown, with the reason it only appears here. A
    // customer who sees a profile without one has to be told it is normal, or
    // they conclude their account is broken — see `issuance.ts` for why the
    // code is minted lazily rather than at registration.
    expect(page).toMatch(/MEMBER_CODE_PEPPER/);
  });

  it('leaves the save link to the API rather than building one', () => {
    // `save_url` is a signed claim naming an object created at Google. A second
    // construction of it in this file would be a second thing to keep in
    // agreement with Google's signing, and it would be wrong silently.
    const walletCard = readFileSync(new URL('../components/wallet-card.tsx', import.meta.url), 'utf8');

    expect(page).not.toMatch(/save_url|saveUrl/);
    expect(walletCard).toMatch(/href=\{state\.pass\.save_url\}/);
    expect(walletCard).not.toMatch(/new URL\(|encodeURIComponent/);
  });
});
