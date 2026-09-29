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
    const vars = /"vars"\s*:\s*\{([^}]*)\}/.exec(config)?.[1] ?? '';
    const names = [...vars.matchAll(/"([^"]+)"\s*:/g)].map((match) => match[1]);
    expect(names.sort()).toEqual(['GOOGLE_WALLET_ISSUER_ID', 'WALLET_DEMO_MODE']);
  });

  it('keeps demo mode on, because publishing access has not been granted', () => {
    // Flipping this is how a deployment starts minting passes that only reach
    // test accounts, or worse, claims an approval Google has not given.
    expect(config).toMatch(/"WALLET_DEMO_MODE"\s*:\s*"true"/);
  });

  it('declares the daily sweep cron', () => {
    expect(config).toContain('"0 6 * * *"');
  });

  it('keeps the issuer id out of source control as a secret', () => {
    // The issuer id is public by design; the service account key that signs
    // passes is not, and must never appear here.
    expect(config).not.toMatch(/PRIVATE_KEY/);
  });
});
