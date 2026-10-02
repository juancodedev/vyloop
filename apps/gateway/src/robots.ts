/**
 * `robots.txt` for the gateway.
 *
 * ## Why this is a Worker route and not just a file in `public/`
 *
 * The file alone is not enough. Without an `assets` block in `wrangler.jsonc`,
 * wrangler never uploads `public/`, so the file would exist in the repo and
 * answer 404 in production — and a crawler file that lies about being there is
 * worse than a missing one, because it converts "Google is not calling me" into
 * a bug nobody reproduces. The `assets` block and the route below are the two
 * halves of one fix, and `robots.test.ts` asserts both.
 *
 * ## Why the matcher is reimplemented here instead of asserted as text
 *
 * The test that matters is "Googlebot may fetch the callback". Asserting that
 * with `expect(robotsTxt).toContain('Allow: /v1/wallet/google/callback')` proves
 * a substring exists and nothing about whether the rules *combine* to allow it:
 * `Disallow: /` alone, or a `Sitemap:` line, or an agent group that never matches
 * `Googlebot/2.1`, all read as passing text checks.
 *
 * So this module parses robots.txt and applies the same resolution Google
 * documents — most specific (longest) matching rule wins, `Allow` beats
 * `Disallow` on a tie, and only the group for the exact user-agent applies when
 * one exists. The tests then drive the *real* bytes on disk through it.
 *
 * ## The one path that must stay reachable
 *
 * `/v1/wallet/google/callback`. Google POSTs pass save/delete events there, and
 * refuses to fetch a URL its own crawler is disallowed from reaching. This is
 * the single highest-consequence string in the file, which is why it is a
 * constant here rather than a literal repeated across the file and the tests.
 */

/** The path this worker serves the file on. Matched by `run_worker_first`. */
export const ROBOTS_PATH = '/robots.txt';

/**
 * The Google Wallet pass callback.
 *
 * Duplicated in `public/robots.txt` and in `index.ts`'s auth exemptions, and
 * exported from here so the route, the file and the tests cannot drift on a
 * rename: a callback the crawler cannot reach is exactly the silent failure
 * this file exists to prevent. `index.test.ts` asserts the auth exemption list
 * still matches, and `robots.test.ts` asserts this path is reachable.
 */
export const WALLET_CALLBACK_PATH = '/v1/wallet/google/callback';

/**
 * Sent explicitly rather than copied from the asset response.
 *
 * A crawler that receives `application/octet-stream` may refuse the document,
 * which would reintroduce the failure this route prevents. Being explicit also
 * means the Content-Type is a property of the code — asserted in the tests —
 * instead of a side effect of a file extension and an asset-store MIME table.
 */
export const ROBOTS_CONTENT_TYPE = 'text/plain; charset=utf-8';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One `Allow:` or `Disallow:` line. */
export interface RobotsRule {
  pattern: string;
  allow: boolean;
}

/** The rules that apply to one `User-agent:` line's group. */
export interface RobotsGroup {
  /** The tokens on the `User-agent:` lines, lowercased on read. */
  agents: string[];
  rules: RobotsRule[];
}

/**
 * Parse robots.txt into groups.
 *
 * Consecutive `User-agent:` lines share one rule set, which is why this tracks
 * whether a group already has rules: the first rule after a `User-agent:` line
 * closes any group still collecting agents. Comments are stripped to end of
 * line and blank lines ignored, so the prose at the top of the file — which
 * carries the reasoning — costs nothing.
 */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup = { agents: [], rules: [] };
  let open = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;

    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      // A rule already seen means this agent line starts a new group.
      if (open && current.rules.length > 0) {
        groups.push(current);
        current = { agents: [], rules: [] };
      }
      current.agents.push(value.toLowerCase());
      open = true;
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (!open) continue;

    current.rules.push({ pattern: value, allow: field === 'allow' });
  }

  if (open) groups.push(current);
  return groups;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Compile a robots.txt pattern: `*` is any sequence, a trailing `$` anchors the
 * end, everything else is literal.
 *
 * Both are in the spec and neither is used by the current file — but a matcher
 * that silently mis-reads them would let a future edit believe it had excluded
 * something it had not, which is the exact failure this file is guarding
 * against. So they are implemented rather than assumed away.
 */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  let out = '';
  for (const ch of body) {
    out += ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${out}${anchored ? '$' : ''}`);
}

/**
 * True when `userAgent` falls in the named group.
 *
 * Substring, not equality: the crawlers send
 * `Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`,
 * and requiring an exact token match would find no group and fall through to
 * `*` — quietly re-blocking the callback. The one risk of substring matching
 * would be an agent name that is a substring of another (`Google` vs `Googlebot`),
 * so the `*` token is excluded here: it is the fallback group, never a match.
 */
function agentMatches(agent: string, userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return agent !== '*' && ua.includes(agent);
}

/**
 * Whether a crawler may fetch `path`, per the standard Google's documentation
 * describes.
 *
 * The specific group wins outright: when a `Googlebot` group exists, the `*`
 * group is not consulted at all. Within the chosen group, the longest matching
 * pattern wins, and `Allow` breaks a tie — which is how `Allow:` alongside
 * `Disallow: /` produces a reachable callback.
 *
 * Specificity is measured as pattern length rather than matched-path length.
 * That matches Google's own wording of the rule and is exact for every pattern
 * without `*`; a pattern containing `*` is ranked slightly differently than
 * Google's implementation would rank it. No such pattern exists in this file,
 * and a wrong rank here would have to be compensated by a test that asserts
 * the rank, so the approximation is stated rather than hidden.
 */
export function isPathAllowedFor(
  groups: RobotsGroup[],
  userAgent: string,
  path: string,
): boolean {
  const group =
    groups.find((g) => g.agents.some((a) => agentMatches(a, userAgent))) ??
    groups.find((g) => g.agents.includes('*'));

  if (!group) return true;

  let winner: RobotsRule | undefined;
  for (const rule of group.rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;

    if (
      winner === undefined ||
      rule.pattern.length > winner.pattern.length ||
      (rule.pattern.length === winner.pattern.length && rule.allow && !winner.allow)
    ) {
      winner = rule;
    }
  }

  // No rule matched: the default is allowed.
  if (winner === undefined) return true;
  return winner.allow;
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** The subset of `GatewayEnv` this route needs, declared locally. */
interface RobotsEnv {
  ASSETS?: Fetcher;
}

/**
 * Serve `robots.txt` through the `ASSETS` binding.
 *
 * The binding is checked rather than assumed. A missing one means `wrangler.jsonc`
 * lost its `assets` block or the deploy ran against a different config, and the
 * route answers 500 with a named cause instead of letting crawlers get a bare
 * 404 they cannot distinguish from "this host has no policy" — which is how a
 * callback silently stops arriving in the first place.
 */
export function robotsRoute() {
  return async (c: {
    env: RobotsEnv;
    req: { url: string };
  }): Promise<Response> => {
    const assets = c.env?.ASSETS;
    if (!assets) {
      return new Response('robots.txt is not configured: the ASSETS binding is missing.', {
        status: 500,
        headers: { 'Content-Type': ROBOTS_CONTENT_TYPE },
      });
    }

    const res = await assets.fetch(new Request(new URL(ROBOTS_PATH, c.req.url).toString()));
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': ROBOTS_CONTENT_TYPE,
        // Crawlers re-fetch robots.txt about once a day. A month is safely past
        // any rate that matters and keeps a rule change from taking a week to
        // reach the crawler that has to obey it.
        'Cache-Control': 'public, max-age=2592000',
      },
    });
  };
}