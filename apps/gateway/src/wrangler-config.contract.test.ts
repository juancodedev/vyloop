/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL } from './merchant-page';

const here = __dirname;
const configPath = join(here, '..', 'wrangler.jsonc');
const rawConfig = readFileSync(configPath, 'utf8');
const workflow = readFileSync(
  join(here, '..', '..', '..', '.github', 'workflows', 'deploy.yml'),
  'utf8',
);

/**
 * Parse the JSONC config.
 *
 * String-aware on purpose, because the two things a naive stripper gets wrong
 * are both present in this file: every value is an `https://` URL, so dropping
 * everything from `//` onward mangles the whole document, and the comments
 * discuss routes like `/p/{slug}`, whose braces defeat any regex that tries to
 * find the end of a block by counting or skipping them.
 */
function parseJsonc(source: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }

    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      continue;
    }

    out += char;
  }

  return JSON.parse(out) as Record<string, unknown>;
}

const config = parseJsonc(rawConfig);

/**
 * Read by a test in this file and genuinely absent from both the config and the
 * deploy job. Every entry is a bug someone has already found and not yet fixed;
 * deleting one without declaring the binding turns a visible failure back into
 * the silent one this file exists to prevent, which is why the exemption is a
 * named list with a reason rather than a filter on the shape of the name.
 */
const KNOWN_UNDECLARED: Record<string, string> = {
  SCHEMA_REGISTRY:
    'Read at POST /v1/events/:type in `ingestor.ts`, a mounted public route, and ' +
    'declared in neither `apps/gateway/wrangler.jsonc` nor the deploy job, so the ' +
    'read is `undefined` in production. Declared in `workers/customer` and ' +
    '`workers/communication`, which is almost certainly where this was missed. ' +
    'Unfixed: it needs the namespace id, and a guessed id fails closed against ' +
    'the real registry rather than resolving it.',
};

function declaredVars(): string[] {
  const vars = config['vars'] as Record<string, string> | undefined;
  return Object.keys(vars ?? {});
}

/**
 * Every binding the non-`vars` blocks publish.
 *
 * Collected by walking the parsed document for `binding` properties rather than
 * by pattern, so a binding block added later — D1, Durable Objects, an analytics
 * engine — is covered by this the moment it exists, with no edit here.
 */
function declaredBindings(): string[] {
  const names: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'binding' && typeof value === 'string') names.push(value);
      else walk(value);
    }
  };

  walk(config);
  return names;
}

/**
 * Var names the gateway's deploy step passes as `--var`.
 *
 * Scoped to the `deploy-gateway` job rather than the whole file, so a var the
 * `identity` or `communication` step passes cannot make a gateway read look
 * satisfied by accident.
 */
function injectedVars(): string[] {
  const job = /deploy-gateway:(.*?)\n {2}[a-z-]+:/s.exec(workflow)?.[1] ?? '';
  return [...job.matchAll(/--var\s+([A-Z0-9_]+):/g)].map((match) => match[1]);
}

/**
 * Every binding the gateway reads off the environment at runtime.
 *
 * `c.env.X` and `env.X` in non-test sources. Deliberately reads rather than the
 * `Env` interface in `router.ts`: a name declared as a type but never read is
 * not a dependency, and `SCHEDULER` is exactly that today.
 */
function readBindings(): string[] {
  const files = readdirSync(here).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'),
  );

  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(here, file), 'utf8');
    for (const match of source.matchAll(/\b(?:c\.env|env)\.([A-Z][A-Z0-9_]+)/g)) {
      names.add(match[1]);
    }
  }

  return [...names].sort();
}

describe('gateway wrangler.jsonc', () => {
  it('publishes every binding the worker reads at runtime', () => {
    // The drift guard, and the point of this file. Because `wrangler deploy
    // --var` MERGES into `vars` rather than replacing it — verified with
    // `wrangler deploy --var DATABASE_URL:… --dry-run` in `workers/wallet`, which
    // published all seven declared vars alongside the flag on 4.107.0 and again on
    // 4.147.0 — a var declared in neither place is invisible from both sides.
    // Nothing errors at deploy, the binding is simply absent, and the only symptom
    // is whatever the code does with `undefined`.
    //
    // This is not hypothetical. It is how `WALLET_CUSTOMER_WEB_BASE_URL` reached
    // the CTA on `/p/{slug}`: read in `index.ts`, declared in neither place, and
    // the link silently falling back to the default in `merchant-page.ts`.
    //
    // The reverse error — declared here, read nowhere — is dead config rather
    // than an outage, so it is left to the assertions below rather than folded
    // into this one, which would make a real drift harder to read.
    const reachable = new Set([...declaredVars(), ...declaredBindings(), ...injectedVars()]);
    const undeclared = readBindings().filter(
      (name) => !reachable.has(name) && !(name in KNOWN_UNDECLARED),
    );

    expect(readBindings().length).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });

  it('does not exempt a binding that has since been declared', () => {
    // Keeps the exemption list from rotting into a blanket. Declaring
    // `SCHEMA_REGISTRY` should not silently keep its excuse, and a typo in a
    // name here would otherwise leave a real drift unguarded while this file
    // still reported green.
    const declared = new Set([...declaredVars(), ...declaredBindings(), ...injectedVars()]);

    for (const name of Object.keys(KNOWN_UNDECLARED)) {
      expect(declared.has(name), `${name} is exempt but is now declared`).toBe(false);
    }
  });

  it('keeps the deploy job flags and the vars map from claiming the same value', () => {
    // One source of truth. Because `--var` merges, a name in both places is not
    // caught by the merge itself: it deploys cleanly, the workflow's literal
    // silently wins every time, and the config's literal rots. Nothing about that
    // is visible from outside until the two have drifted and someone edits the
    // one nobody reads.
    //
    // The split is by sensitivity and nothing else — secrets are flags because
    // they cannot be committed, and everything else is declared in the config.
    expect(declaredVars().filter((name) => injectedVars().includes(name))).toEqual([]);
  });

  it('declares the customer-web origin the CTA on /p/{slug} is built from', () => {
    // By value as well as by presence. The var and
    // `DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL` are two records of one deployment
    // fact, and the var is what a staging deployment actually reads — so a
    // divergence has to fail here rather than leave the code default describing a
    // host this deployment never serves.
    const value = (config['vars'] as Record<string, string>)['WALLET_CUSTOMER_WEB_BASE_URL'];

    expect(value).toBeDefined();
    expect(value).toBe(DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL);
    // An origin, and not a root: it is concatenated with `/register?biz=<slug>`,
    // so a trailing slash is a different URL to the route.
    expect(value).toMatch(/^https:\/\/[^/\s]+$/);
  });

  it('carries no // keys, which publish as environment variables', () => {
    // Mirrors the guard in `workers/wallet`. wrangler strips `//keys` at the top
    // level but publishes a `//key` nested inside `vars` as a real environment
    // variable carrying the comment text as its value, which is how an
    // explanation becomes deployed state. Read off the raw text, because the
    // comment stripper above would remove the evidence.
    expect([...rawConfig.matchAll(/"(\/\/[^"]*)"\s*:/g)].map((match) => match[1])).toEqual([]);
  });
});