/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const config = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

/**
 * `wrangler.jsonc` is JSONC, so a `//` line comment is the way to explain a
 * field. The `//field` *key* convention looks equivalent and is not: wrangler
 * strips `//keys` at the top level, tolerantly, but a `//key` nested inside
 * `vars` is published as a real environment variable carrying the comment text
 * as its value. A dry run showed `env.//WALLET_DEMO_MODE ("Not a secret and not
 * a fact we re...")`, which is how an explanation becomes deployed state.
 */
describe('wrangler.jsonc', () => {
  it('carries no // keys, which publish as environment variables', () => {
    const jsoncKeys = [...config.matchAll(/"(\/\/[^"]*)"\s*:/g)].map((match) => match[1]);
    expect(jsoncKeys).toEqual([]);
  });

  it('declares exactly the intended vars', () => {
    // An exact list, on purpose: this file is the only place that notices a var
    // added for a one-off debug, or a `vars` entry whose value is a secret. A
    // subset assertion would let both through and the test would keep passing,
    // which is the reason this asserts with `toEqual` rather than
    // `toContain`.
    const vars = /"vars"\s*:\s*\{([^}]*)\}/.exec(config)?.[1] ?? '';
    const names = [...vars.matchAll(/"([^"]+)"\s*:/g)].map((match) => match[1]);
    expect(names.sort()).toEqual([
      'GOOGLE_WALLET_ISSUER_ID',
      'WALLET_ALLOWED_ORIGINS',
      'WALLET_CALLBACK_BASE_URL',
      'WALLET_CUSTOMER_WEB_BASE_URL',
      'WALLET_DEMO_MODE',
      'WALLET_MEDIA_BASE_URL',
      'WALLET_WEB_BASE_URL',
    ]);
  });

  it('declares three separate base URLs, because a logo, a homepage and a link are not the same URL', () => {
    // One var for all was the bug: `media.juancode.dev` serves the gateway's
    // brand route and answers 404 on the customer web's `/profile`, so a single
    // shared var produced both a `homepageUri` Google opens during review and
    // links that 404 in a customer's hand (docs/11 records the homepage as the
    // most common rejection reason). Declaring one var again would have to also
    // pass the exact-list assertion above, so the two guards together refuse the
    // merge rather than merely documenting it.
    expect(config).toContain('"WALLET_MEDIA_BASE_URL"');
    expect(config).toContain('"WALLET_WEB_BASE_URL"');
    expect(config).toContain('"WALLET_CUSTOMER_WEB_BASE_URL"');
    expect(config).not.toContain('"WALLET_PUBLIC_BASE_URL"');
  });

  it('declares all three origins with no trailing slash', () => {
    // Google fetches `programLogo` from a public HTTPS URL and a customer taps
    // `homepageUri`, so a wrong host is not a config nit: it is a class that
    // cannot be reviewed and a link that 404s. Both values must be an origin,
    // with no trailing slash — the parsers strip one, but a var that carries it
    // is a sign it was pasted rather than written.
    for (const name of [
      'WALLET_MEDIA_BASE_URL',
      'WALLET_WEB_BASE_URL',
      'WALLET_CUSTOMER_WEB_BASE_URL',
    ]) {
      const base = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config)?.[1];
      expect(base, name).toBeDefined();
      expect(base, name).toMatch(/^https:\/\/[^/\s]+\/?$/);
    }
  });

  it('points the two gateway base URLs at the same host, because the gateway serves both routes', () => {
    // This inverts the invariant the same file used to assert, and the reason is
    // worth stating because it looks like a regression otherwise.
    //
    // `WALLET_WEB_BASE_URL` used to be the customer web, because the program page
    // lived there. It now points at the gateway, where `/p/{slug}` is rendered
    // server-side — the customer web's own pages are fine, but a review page has
    // to have its content in the bytes Google's reviewer receives, and the
    // dashboard's static export serves 18 characters of text.
    //
    // So MEDIA and WEB are the same host today: one origin serving `/brand/*`
    // and `/p/*`. They stay separate vars because they are separate consumers
    // with independent histories, and either may have to move without the other.
    const read = (name: string) =>
      new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config)?.[1];

    expect(read('WALLET_MEDIA_BASE_URL')).toBeDefined();
    expect(read('WALLET_WEB_BASE_URL')).toBeDefined();
    expect(read('WALLET_MEDIA_BASE_URL')).toBe(read('WALLET_WEB_BASE_URL'));
  });

  it('keeps the links host separate from the two gateway hosts', () => {
    // The half that actually has to differ. `/profile` and `/profile/history` are
    // `apps/customer-web` routes, and `provision.test.ts` asserts the pass links
    // resolve against that app's filesystem. Pointing them at the gateway makes
    // every link on every pass a 404 while the class itself looks healthy.
    const read = (name: string) =>
      new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config)?.[1];

    expect(read('WALLET_CUSTOMER_WEB_BASE_URL')).toBeDefined();
    expect(read('WALLET_CUSTOMER_WEB_BASE_URL')).not.toBe(read('WALLET_WEB_BASE_URL'));
  });

  it('declares the callback origin separately, because it fails silently when wrong', () => {
    // The three base URLs above fail *visibly*: a wrong media host is an empty
    // logo, a wrong web host is a class Google rejects at review. A wrong
    // callback host fails silently — Google simply never reports that a customer
    // saved or deleted a pass, and `customer_wallet_passes.state` goes on
    // reporting whatever the last reconcile inferred. Nothing anywhere errors,
    // because a missing callback is indistinguishable from a customer who has not
    // opened the app.
    //
    // So it is asserted to exist, to be a real https origin, and to be the
    // gateway — the same host that actually serves the route. A `localhost` or
    // `.pages.dev` value here would mint classes that report to nowhere for
    // life, since a class cannot be recreated under the same id.
    expect(config).toContain('"WALLET_CALLBACK_BASE_URL"');

    const callbackBase = /"WALLET_CALLBACK_BASE_URL"\s*:\s*"([^"]*)"/.exec(config)?.[1];
    expect(callbackBase).toBeDefined();
    expect(callbackBase).toMatch(/^https:\/\/[^/\s]+\/?$/);
    expect(callbackBase).not.toMatch(/localhost|127\.0\.0\.1|pages\.dev/);

    // It is the gateway, so it must be the same origin MEDIA and WEB already
    // point at. If it ever diverges it must be a deliberate act with its own
    // reason, which is what this equality forces someone to confront.
    const read = (name: string) => new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config)?.[1];
    expect(read('WALLET_CALLBACK_BASE_URL')).toBe(read('WALLET_WEB_BASE_URL'));
  });

  it('declares the origins Google requires before it will issue a save link', () => {
    // Google refuses to mint without this and names it in the error, not the
    // docs, so a fresh environment fails its first pass with
    // `WALLET_NOT_CONFIGURED`. The value is compared against the request's own
    // `Origin`, which is why a trailing slash would silently never match.
    const origins = /"WALLET_ALLOWED_ORIGINS"\s*:\s*"([^"]*)"/.exec(config)?.[1];
    expect(origins).toBeDefined();
    expect(origins).not.toBe('');

    for (const origin of origins!.split(',')) {
      expect(origin).toMatch(/^https:\/\/[^/\s]+$/);
    }
  });

  it('keeps demo mode on, because publishing access has not been granted', () => {
    // Flipping this is how a deployment starts minting passes that only reach
    // test accounts, or worse, claims an approval Google has not given.
    expect(config).toMatch(/"WALLET_DEMO_MODE"\s*:\s*"true"/);
  });

  it('declares no cron trigger, because the account has no room for one', () => {
    // The account allows five cron triggers and already uses all five, so a
    // sixth is rejected with error 10072 and fails the deploy. The sweep runs
    // from `workers/automation`, which holds the shared `0 6 * * *` trigger and
    // calls the `scheduled` export here over a service binding.
    //
    // A cron reappearing in this file is a plan upgrade that has not happened,
    // or a merge that reverted the handoff. Either way it should stop CI rather
    // than fail a deploy the user has to read a Cloudflare error to understand.
    expect(config).not.toContain('"triggers"');
  });

  it('keeps the issuer id out of source control as a secret', () => {
    // The issuer id is public by design; the service account key that signs
    // passes is not, and must never appear here.
    expect(config).not.toMatch(/PRIVATE_KEY/);
  });
});
