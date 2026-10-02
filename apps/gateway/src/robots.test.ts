import { describe, expect, it } from 'vitest';

import {
  isPathAllowedFor,
  parseRobotsTxt,
  ROBOTS_CONTENT_TYPE,
  ROBOTS_PATH,
  WALLET_CALLBACK_PATH,
} from './robots';

import app from './index';

// Vite's build-time glob is used to read the real `public/robots.txt` and the
// real `wrangler.jsonc`, and its type is declared here rather than pulled in from
// `vite/client`.
//
// The reasoning is worth the four lines. The alternative is `node:fs`, which
// means adding `"node"` to this package's `types` in `tsconfig.json` — and that
// would hand Node's globals to `src/**`, including worker source, where a
// `node:` import typechecks cleanly and then fails at runtime in the Worker.
// This package is `@cloudflare/workers-types` only on purpose, and a test file
// is not a good reason to give that up. The glob reads the same bytes from the
// same path, and cannot be used to smuggle a Node API into a worker.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options?: { query?: string; import?: string; eager?: boolean },
    ): Record<string, string>;
  }
}

/**
 * The real files, inlined from disk at test time.
 *
 * These tests read the file that ships rather than a copy pasted beside them. A
 * test asserting against a hardcoded copy passes while the shipped file says the
 * opposite, and a test that only checks the file exists passes while wrangler
 * never uploads it — which is exactly the state this repo was in.
 *
 * The options object is a literal at each call site because Vite's glob transform
 * requires it: passing an identifier throws "Invalid glob import syntax" at build
 * time rather than silently globbing nothing.
 */
const RAW_ASSETS = import.meta.glob('../public/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const RAW_WRANGLER = import.meta.glob('../wrangler.jsonc', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const robotsTxt = RAW_ASSETS['../public/robots.txt'];
const groups = parseRobotsTxt(robotsTxt);

/**
 * `wrangler.jsonc` is JSONC, so comments are stripped before parsing rather than
 * handed to a parser that would reject the ones explaining the config.
 */
const wranglerJson = JSON.parse(
  RAW_WRANGLER['../wrangler.jsonc'].replace(/^\s*\/\/.*$/gm, ''),
);

/**
 * The user-agent strings Google actually sends, not bare tokens.
 *
 * Google's crawlers identify with a full UA string, so a matcher comparing for
 * equality would find no `Googlebot` group and fall through to `*` — quietly
 * re-blocking the callback. Testing the real strings is what stops that being
 * reintroduced unnoticed.
 */
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const GOOGLE_VALUABLES_UA = 'Mozilla/5.0 (compatible; Google-valuables/1.0)';

/**
 * A stand-in for the Cloudflare `ASSETS` binding, backed by the real files.
 *
 * `directory` mirrors the one in `wrangler.jsonc`, so pointing that block
 * somewhere the file is not — or deleting the file — shows up here as a 404
 * rather than in production. Only the edge's MIME table is simulated; the bytes
 * are the bytes that ship.
 */
function assetsBinding(directory = '../public') {
  return {
    fetch: async (req: Request): Promise<Response> => {
      const { pathname } = new URL(req.url);
      const body = RAW_ASSETS[`${directory}${pathname}`];
      if (body === undefined) return new Response('Not found', { status: 404 });
      return new Response(body);
    },
  };
}

function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    RATE_LIMITER: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    ASSETS: assetsBinding(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The file is served
// ---------------------------------------------------------------------------

describe('GET /robots.txt', () => {
  it('answers with 200 and a plain-text Content-Type', async () => {
    const res = await app.fetch(
      new Request(`https://api.test${ROBOTS_PATH}`),
      mockEnv() as never,
    );

    expect(res.status).toBe(200);
    // The literal, not `ROBOTS_CONTENT_TYPE`. Comparing the response against the
    // same constant the route uses is a tautology: editing the constant changes
    // both sides and the test stays green while the real value drifts. A crawler
    // handed `application/octet-stream` may refuse the document, which would
    // reintroduce the failure this file exists to prevent.
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('declares that same Content-Type as the constant it serves', () => {
    // So the literal above is not a duplicate that can drift from the export.
    expect(ROBOTS_CONTENT_TYPE).toBe('text/plain; charset=utf-8');
  });

  it('serves the bytes that are actually in public/robots.txt', async () => {
    const res = await app.fetch(
      new Request(`https://api.test${ROBOTS_PATH}`),
      mockEnv() as never,
    );

    // Against the file, not against a constant: this is the assertion that "what
    // we serve" and "what we reviewed" are the same document.
    expect(await res.text()).toBe(robotsTxt);
  });

  it('needs no credentials, like every other route a crawler must reach', async () => {
    const res = await app.fetch(
      new Request(`https://api.test${ROBOTS_PATH}`),
      mockEnv() as never,
    );

    expect(res.status).toBe(200);
  });

  it('fails loudly with a named cause when the ASSETS binding is absent', async () => {
    // The silent version of this bug is a bare 404, which a crawler cannot tell
    // from "this host has no policy" — so a dropped `assets` block has to be an
    // error naming the block rather than a shrug.
    const res = await app.fetch(
      new Request(`https://api.test${ROBOTS_PATH}`),
      mockEnv({ ASSETS: undefined }) as never,
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('ASSETS');
  });

  it('reports 404 when the file is not in the configured directory', async () => {
    // Guards `assets.directory` pointing somewhere the file is not, which is a
    // passing deploy and a 404 for every crawler.
    const res = await app.fetch(
      new Request(`https://api.test${ROBOTS_PATH}`),
      mockEnv({ ASSETS: assetsBinding('../dist') }) as never,
    );

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// wrangler.jsonc actually publishes the file
// ---------------------------------------------------------------------------

describe('wrangler.jsonc serves public/', () => {
  it('declares an assets block pointing at ./public/', () => {
    // Without this, wrangler never uploads the directory, and the file exists in
    // the repo while answering 404 in production.
    expect(wranglerJson.assets).toBeDefined();
    expect(wranglerJson.assets.directory).toBe('./public/');
    expect(wranglerJson.assets.binding).toBe('ASSETS');
  });

  it('routes /robots.txt through the Worker so the route above is live', () => {
    // The route is dead code if assets are served first, which would make the
    // Content-Type assertion above meaningless.
    expect(wranglerJson.assets.run_worker_first).toContain(ROBOTS_PATH);
  });

  it('leaves unmatched requests reaching the Worker, so no route is shadowed', () => {
    // `single-page-application` here would answer every unmatched gateway route
    // with a 200 instead of the 404 the app returns.
    expect(wranglerJson.assets.not_found_handling).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The callback stays reachable
// ---------------------------------------------------------------------------

describe('the Wallet pass callback is not blocked', () => {
  it('for Googlebot, on the real user-agent string', () => {
    expect(isPathAllowedFor(groups, GOOGLEBOT_UA, WALLET_CALLBACK_PATH)).toBe(true);
  });

  it('for Google-Valuables, on the real user-agent string', () => {
    expect(isPathAllowedFor(groups, GOOGLE_VALUABLES_UA, WALLET_CALLBACK_PATH)).toBe(true);
  });

  it('for no other crawler, because the callback must not depend on one', () => {
    // Googlebot is not the only agent Google routes pass traffic through. If the
    // rule only worked for one UA, the callback would break again the next time
    // Google used another.
    expect(isPathAllowedFor(groups, 'SomeOtherBot/1.0', WALLET_CALLBACK_PATH)).toBe(false);
  });

  it('resolves through the specific group, not the wildcard', () => {
    // Googlebot's own group carries `Disallow: /`. Only the `Allow` winning on
    // longest-match keeps the path open, so this asserts the tie-breaking rather
    // than the presence of a line.
    const googlebotGroup = groups.find((g) => g.agents.includes('googlebot'));
    expect(googlebotGroup).toBeDefined();
    expect(
      googlebotGroup?.rules.some((r) => r.allow && r.pattern === WALLET_CALLBACK_PATH),
    ).toBe(true);
    expect(isPathAllowedFor(groups, GOOGLEBOT_UA, '/')).toBe(false);
  });

  it('reaches the callback only through a Google-specific rule, never the wildcard', () => {
    // The structural guarantee: the callback is fetchable because two Google
    // groups say so, not because anything open it up. An `Allow` ever landing in
    // the `*` group would advertise an unauthenticated endpoint to every crawler,
    // and this is what would catch it.
    const wildcardGroup = groups.find((g) => g.agents.includes('*'));
    expect(wildcardGroup).toBeDefined();
    expect(wildcardGroup?.rules.some((r) => r.allow)).toBe(false);
  });

  it('allows a trailing slash on the callback, because the Allow rule is a prefix', () => {
    // A deliberate choice, asserted so a future reader does not "fix" it. `Allow`
    // is anchored only by `$`, so the rule covers the callback and anything under
    // it. Left unanchored on purpose: `$` would be stricter and would block a
    // trailing-slash delivery, and nothing under the path is routable — the worker
    // matches the exact path and 404s the rest.
    expect(isPathAllowedFor(groups, GOOGLEBOT_UA, `${WALLET_CALLBACK_PATH}/`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Everything else stays out
// ---------------------------------------------------------------------------

describe('everything else is blocked', () => {
  it('blocks merchant pages for Googlebot', () => {
    // The decision under test: a merchant's public page is not index content.
    expect(isPathAllowedFor(groups, GOOGLEBOT_UA, '/p/cafe-central')).toBe(false);
  });

  it('blocks merchant pages with an explicit rule, not only by inheriting', () => {
    // `Disallow: /p/` is redundant with `Disallow: /` — the path is blocked either
    // way, which is exactly why it needs this assertion. The behavioural test
    // above passes with the line deleted, so it cannot protect the *decision*.
    //
    // What the explicit line buys is that the rule survives someone later
    // relaxing the wildcard block to open some unrelated path: merchant pages
    // stay out of the index because they were named, not because they happened to
    // sit under a rule written for other reasons.
    expect(robotsTxt).toMatch(/^Disallow:\s*\/p\/$/m);
  });

  it('blocks merchant pages for an ordinary crawler', () => {
    expect(isPathAllowedFor(groups, 'SomeOtherBot/1.0', '/p/cafe-central')).toBe(false);
  });

  it('blocks the root and the authenticated API surface', () => {
    for (const p of ['/', '/v1/customers', '/v1/me', '/brand/tenant.jpg', '/health']) {
      expect(isPathAllowedFor(groups, GOOGLEBOT_UA, p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// No invented sitemap
// ---------------------------------------------------------------------------

describe('Sitemap', () => {
  it('is not advertised, because no route serves one', () => {
    // A `Sitemap:` directive must name a URL that returns a real sitemap. None
    // exists, so this would point crawlers at a 404 and teach them to distrust
    // the rest of the file — including the callback rule.
    expect(robotsTxt).not.toMatch(/^\s*Sitemap:/im);
  });
});

// ---------------------------------------------------------------------------
// Parser unit coverage
// ---------------------------------------------------------------------------

describe('parseRobotsTxt', () => {
  it('groups consecutive user-agent lines under one rule set', () => {
    const parsed = parseRobotsTxt('User-agent: A\nUser-agent: B\nDisallow: /x\n');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agents).toEqual(['a', 'b']);
  });

  it('starts a new group once a rule has been seen', () => {
    const parsed = parseRobotsTxt('User-agent: A\nDisallow: /x\nUser-agent: B\nDisallow: /y\n');
    expect(parsed).toHaveLength(2);
  });

  it('ignores comments, blank lines and unknown directives', () => {
    const parsed = parseRobotsTxt(
      '# a comment\n\nUser-agent: A\nCrawl-delay: 5\nDisallow: /y\nDisallow: /x # trailing\n',
    );
    expect(parsed[0].rules).toEqual([
      { pattern: '/y', allow: false },
      { pattern: '/x', allow: false },
    ]);
  });

  it('prefers Allow over Disallow when both match at the same length', () => {
    const parsed = parseRobotsTxt('User-agent: A\nDisallow: /p\nAllow: /p\n');
    expect(isPathAllowedFor(parsed, 'A', '/p')).toBe(true);
  });

  it('honours * and $ in a pattern', () => {
    const parsed = parseRobotsTxt('User-agent: A\nDisallow: /*.json$\n');
    expect(isPathAllowedFor(parsed, 'A', '/secrets.json')).toBe(false);
    // Not an exact end, so the `$` anchor leaves this one allowed.
    expect(isPathAllowedFor(parsed, 'A', '/secrets.json.bak')).toBe(true);
  });

  it('allows everything when a file has no matching group', () => {
    expect(isPathAllowedFor(parseRobotsTxt('User-agent: B\nDisallow: /\n'), 'A', '/x')).toBe(
      true,
    );
  });

  it('allows a path no rule matches, which is the standard default', () => {
    expect(isPathAllowedFor(parseRobotsTxt('User-agent: A\nDisallow: /x\n'), 'A', '/y')).toBe(
      true,
    );
  });
});