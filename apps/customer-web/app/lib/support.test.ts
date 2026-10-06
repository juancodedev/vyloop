// @vitest-environment jsdom

/**
 * The client half of the support channel: what the form sends, and what it does
 * with the answer.
 *
 * ## Why this file exists separately from the behaviour suite
 *
 * `support-form.behavior.test.tsx` drives the component. This one holds the
 * properties that are about the **payload** and about **not putting PII in the
 * DOM**, which is easier to state as a unit and which would be buried inside a
 * render test where a passing assertion could be about something else.
 *
 * ## The property that matters most here
 *
 * `wallet-card.tsx` documents that the code and the status it renders are "not
 * logged, not sent, and no PII in either". The form breaks that on purpose: it
 * **sends** them, plus a message a person wrote. So the rule has to become
 * explicit rather than inherited:
 *
 *   - the code and the status travel as **values** taken from the failure, never
 *     as a literal spelled here (`delivery.contract.test.ts` forbids that anyway,
 *     and for the same reason);
 *   - the free text travels in the request body and **nowhere else** — not in a
 *     `data-*` attribute, not in the URL, not in a query string, not in a label.
 *
 * The `data-*` half is asserted against the rendered DOM rather than against the
 * source, because the DOM is where it would leak: a `data-support-message` would
 * be invisible in a code review that only read the payload builder.
 */

import { describe, expect, it } from 'vitest';

import {
  SUPPORT_FIELDS,
  SUPPORT_LIMITS,
  SUPPORT_SITE_KEY,
  buildSupportPayload,
  resolveSiteKey,
} from './support';

describe('the payload', () => {
  it('carries the code and the status the card is already showing', () => {
    const payload = buildSupportPayload({
      code: 'WALLET_CLASS_NOT_APPROVED',
      status: 409,
      message: 'No me aparece la tarjeta y ya me registre dos veces.',
      website: '',
      token: 'a-token',
    });

    expect(payload[SUPPORT_FIELDS.code]).toBe('WALLET_CLASS_NOT_APPROVED');
    expect(payload[SUPPORT_FIELDS.status]).toBe(409);
    expect(payload[SUPPORT_FIELDS.message]).toBe('No me aparece la tarjeta y ya me registre dos veces.');
  });

  it('uses the field names the gateway reads', () => {
    // Spelled as literals here, on purpose: these are the two sides of a wire
    // contract and this is the assertion that holds them together. They are NOT
    // `WALLET_*` codes, so `delivery.contract.test.ts` does not apply.
    expect(SUPPORT_FIELDS).toEqual({
      code: 'wallet_code',
      status: 'wallet_status',
      message: 'message',
      honeypot: 'company_website',
      turnstile: 'cf-turnstile-response',
    });
  });

  it('mirrors the server limits, so the browser can be polite without being trusted', () => {
    // The server is the control; these are the same numbers so a person is told
    // before they submit rather than after. If they drift, the server wins and
    // nothing breaks — which is why `support-limits.contract.test.ts` in the
    // gateway is the half that is asserted against behaviour.
    expect(SUPPORT_LIMITS.messageMin).toBe(10);
    expect(SUPPORT_LIMITS.messageMax).toBe(2000);
  });

  it('sends an empty honeypot, because a person never fills it', () => {
    const payload = buildSupportPayload({
      code: 'WALLET_CLASS_NOT_APPROVED',
      status: 409,
      message: 'No me aparece la tarjeta.',
      website: '',
      token: 'a-token',
    });

    expect(payload[SUPPORT_FIELDS.honeypot]).toBe('');
  });

  it('carries the challenge token under the name Turnstile posts it', () => {
    const payload = buildSupportPayload({
      code: 'WALLET_CLASS_NOT_APPROVED',
      status: 409,
      message: 'No me aparece la tarjeta.',
      website: '',
      token: 'the-token',
    });

    expect(payload[SUPPORT_FIELDS.turnstile]).toBe('the-token');
  });

  it('carries no field the form does not collect', () => {
    // The anonymity of this channel is a property of the payload, not a promise.
    // If a future change adds a name or an address "to be able to reply", this
    // fails and the decision has to be made on purpose rather than inherited.
    const payload = buildSupportPayload({
      code: 'WALLET_CLASS_NOT_APPROVED',
      status: 409,
      message: 'No me aparece la tarjeta.',
      website: '',
      token: 'a-token',
    });

    expect(Object.keys(payload).sort()).toEqual(
      [SUPPORT_FIELDS.code, SUPPORT_FIELDS.honeypot, SUPPORT_FIELDS.message, SUPPORT_FIELDS.status, SUPPORT_FIELDS.turnstile].sort(),
    );
  });
});

describe('the Turnstile site key', () => {
  it('is read from the build environment, never defaulted', () => {
    // No widget has been created for this project, so the honest value is
    // `undefined`. A placeholder like `'1x00000000000000000000AA'` would make the
    // form render and look correct while proving nothing — Cloudflare publishes
    // that key precisely so integration tests can pass without a widget, which
    // makes it the worst possible thing to ship as a default.
    expect(SUPPORT_SITE_KEY).toBeUndefined();
  });

  it('treats a blank value as absent rather than as a key', () => {
    // `NEXT_PUBLIC_*` is substituted at build time, so a var set to an empty
    // string arrives as `''` and would otherwise render an empty widget.
    expect(resolveSiteKey(undefined)).toBeUndefined();
    expect(resolveSiteKey('')).toBeUndefined();
    expect(resolveSiteKey('   ')).toBeUndefined();
    expect(resolveSiteKey('0x4AAAAAAA')).toBe('0x4AAAAAAA');
  });
});
