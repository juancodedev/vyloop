import type { Context } from 'hono';

/**
 * Brand assets, served from the platform's own domain.
 *
 * ## Why this route exists rather than an `r2.dev` URL
 *
 * Google Wallet fetches a class's images from a public HTTPS URL, and an R2
 * bucket's public dev URL is the quickest way to get one. It is also the wrong
 * door: `r2.dev` is a preview subdomain, so the moment it is disabled or
 * reconfigured every pass referencing it loses its logo — and a Google class
 * cannot be recreated under the same id, so the repair is a manual patch per
 * class rather than a config change.
 *
 * Serving from `vyloop.juancode.dev` means the bucket stays private, the URL is
 * one the platform controls, and the route is the single place that decides what
 * is allowed to be fetched and with what caching.
 *
 * ## Why a default, and why the key is the tenant id
 *
 * `brand/default.jpg` is the fallback a business gets when it has not uploaded
 * anything. Keying the rest by tenant id means the URL for a business never
 * changes when it rebrands: the object at `brand/{tenantId}.jpg` is replaced,
 * and Google re-reads it. A per-slug or per-name key would leave the old
 * object's URL inside a class that cannot be un-referenced.
 *
 * A business that has uploaded nothing therefore never appears in the bucket
 * and resolves to the default, which is the whole point: signup does not have to
 * ask about images for a tenant to have a card.
 */

const BRAND_PREFIX = '/brand/';

/** Only these extensions are served, so a stray upload cannot be turned into a URL that returns HTML or a script. */
const SERVABLE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export const DEFAULT_BRAND_KEY = 'default.jpg';

type BrandEnv = { BRAND_ASSETS: R2Bucket };

/**
 * Resolve a requested brand path to an object key.
 *
 * Returns `null` for anything that is not a plain file name under `brand/`. A
 * path is normalised before it is used, so `..` cannot climb out of the prefix
 * and read a key the caller did not name.
 */
export function brandKeyFor(pathname: string): string | null {
  if (!pathname.startsWith(BRAND_PREFIX)) return null;

  const requested = decodeURIComponent(pathname.slice(BRAND_PREFIX.length));
  if (requested === '' || requested.includes('/')) return null;

  // Defence in depth: the value ends up in an R2 key, and a key is a string the
  // caller must not be able to shape. Anything outside this shape is not a
  // filename we ever wrote.
  if (!/^[A-Za-z0-9._-]+$/.test(requested)) return null;
  if (requested.startsWith('.')) return null;

  return requested;
}

export function brandRoute() {
  return async (c: Context<{ Bindings: BrandEnv }>) => {
    const key = brandKeyFor(new URL(c.req.url).pathname);
    if (key === null) {
      return c.json({ error: { code: 'BRAND_ASSET_NOT_FOUND' } }, 404);
    }

    const object = await c.env.BRAND_ASSETS.get(key);

    // A tenant that uploaded nothing is not an error. The default is the answer,
    // and answering 404 here would make every new business look broken to a
    // caller that has no way to tell it apart from a bad URL.
    const served = object ?? (await c.env.BRAND_ASSETS.get(DEFAULT_BRAND_KEY));
    if (served === null) {
      return c.json(
        {
          error: {
            code: 'BRAND_ASSET_NOT_FOUND',
            message: 'No brand asset is stored under that key and no default is configured.',
          },
        },
        404,
      );
    }

    const extension = served.key.split('.').pop()?.toLowerCase() ?? '';
    const contentType = SERVABLE[extension];

    if (contentType === undefined) {
      // An object exists but is not an image we serve. A logo that renders as a
      // download or, worse, as something the browser will execute is worse than
      // no logo, so this is refused rather than guessed at.
      return c.json({ error: { code: 'BRAND_ASSET_NOT_SERVEABLE' } }, 404);
    }

    const body = await served.arrayBuffer();

    return c.body(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // The key is immutable per business: a rebrand replaces the object at
        // the same key, and a long TTL means a pass already rendered keeps
        // showing the old logo until it expires. Short enough to converge, long
        // enough not to re-fetch on every render.
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': String(body.byteLength),
      },
    });
  };
}
