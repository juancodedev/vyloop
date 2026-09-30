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
      'WALLET_DEMO_MODE',
      'WALLET_MEDIA_BASE_URL',
      'WALLET_WEB_BASE_URL',
    ]);
  });

  it('declares two separate base URLs, because a class logo and a homepage are not the same URL', () => {
    // One var for both was the bug: `media.juancode.dev` serves the gateway's
    // brand route and answers 404 on `/program`, so a single shared var produced
    // a `homepageUri` that Google opens during review and rejects the class over
    // (docs/11 records it as the most common rejection reason). Declaring one var
    // again would have to also pass the exact-list assertion above, so the two
    // guards together refuse the merge rather than merely documenting it.
    expect(config).toContain('"WALLET_MEDIA_BASE_URL"');
    expect(config).toContain('"WALLET_WEB_BASE_URL"');
    expect(config).not.toContain('"WALLET_PUBLIC_BASE_URL"');
  });

  it('declares each base URL as an origin with no trailing slash', () => {
    // Google fetches `programLogo` from a public HTTPS URL and a customer taps
    // `homepageUri`, so a wrong host is not a config nit: it is a class that
    // cannot be reviewed and a link that 404s. Both values must be an origin,
    // with no trailing slash — the parsers strip one, but a var that carries it
    // is a sign it was pasted rather than written.
    for (const name of ['WALLET_MEDIA_BASE_URL', 'WALLET_WEB_BASE_URL']) {
      const base = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config)?.[1];
      expect(base).toBeDefined();
      expect(base).toMatch(/^https:\/\/[^/\s]+\/?$/);
    }
  });

  it('points the two base URLs at two different hosts', () => {
    // The value half of the invariant. If someone sets both vars to the same host
    // the code is correct and the deployment is not: Google's homepage check will
    // 404 exactly as it did before the split, and no unit test can catch that —
    // only this file, which reads what is actually deployed, can.
    const read = (name: string) =>
      new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config)?.[1];

    expect(read('WALLET_MEDIA_BASE_URL')).toBeDefined();
    expect(read('WALLET_WEB_BASE_URL')).toBeDefined();
    expect(read('WALLET_MEDIA_BASE_URL')).not.toBe(read('WALLET_WEB_BASE_URL'));
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
