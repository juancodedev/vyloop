// @vitest-environment node

/**
 * `/brand/*` is the only public door to a private R2 bucket, and it is the URL
 * Google Wallet fetches when it renders a pass. Two things therefore have to be
 * true at once: a business that uploaded nothing still resolves to an image, and
 * a request cannot reach an object the caller did not name.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BRAND_KEY, brandKeyFor, brandRoute } from './brand';

/** A bucket that answers with a stored body, so the route can be exercised end to end. */
function bucketWith(entries: Record<string, string>) {
  const get = vi.fn(async (key: string) => {
    const body = entries[key];
    if (body === undefined) return null;
    return {
      key,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  });
  return { get } as unknown as R2Bucket;
}

async function serve(path: string, bucket: R2Bucket): Promise<Response> {
  const route = brandRoute();
  // The route only reads `c.env` and `c.req`, so a hand-built context is enough
  // and keeps the test off the gateway's middleware chain.
  const c = {
    env: { BRAND_ASSETS: bucket },
    req: { url: `https://vyloop.juancode.dev${path}` },
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    body: (data: ArrayBuffer, init: ResponseInit) => new Response(data, init),
  };
  return (route as unknown as (c: unknown) => Promise<Response>)(c);
}

describe('brandKeyFor', () => {
  it('accepts a plain file name under the prefix', () => {
    expect(brandKeyFor('/brand/default.jpg')).toBe('default.jpg');
    expect(brandKeyFor('/brand/90d5ad58-bc5c-46a3-b82a-9cebb47e00b1.jpg')).toBe(
      '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1.jpg',
    );
  });

  it('refuses a path that climbs out of the prefix', () => {
    // The value becomes an R2 key. A caller must not be able to shape it into
    // reading a key they did not name.
    expect(brandKeyFor('/brand/sub/default.jpg')).toBeNull();
  });

  it('refuses an encoded traversal, which is the one that survives the URL parser', () => {
    // The literal `/brand/../secrets.txt` is normalised to `/secrets.txt` by
    // `new URL().pathname` before this function ever sees it, so it proves
    // nothing about the guards below. Percent-encoded dots and slashes are NOT
    // decoded by the URL parser: they reach `pathname` intact, and only
    // `decodeURIComponent` here turns them back into a traversal. That is the
    // case these assertions exist for, and the previous version of this test
    // could not have detected either guard being deleted.
    expect(new URL('https://x/brand/../secrets.txt').pathname).toBe('/secrets.txt');
    expect(brandKeyFor('/brand/%2e%2e%2fsecrets.txt')).toBeNull();
    expect(brandKeyFor('/brand/%2E%2E%2Fsecrets.txt')).toBeNull();
    expect(brandKeyFor('/brand/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toBeNull();
  });

  it('refuses a hidden file and anything outside the safe character set', () => {
    expect(brandKeyFor('/brand/.env')).toBeNull();
    expect(brandKeyFor('/brand/a b.jpg')).toBeNull();
    expect(brandKeyFor('/brand/x.html')).not.toBeNull(); // shaped as a filename, refused later
  });

  it('refuses anything that is not under the prefix', () => {
    expect(brandKeyFor('/v1/brand/default.jpg')).toBeNull();
    expect(brandKeyFor('/brand')).toBeNull();
  });
});

describe('the brand route', () => {
  it('serves the stored object with the right content type', async () => {
    const bucket = bucketWith({ 'default.jpg': 'JPEGDATA' });

    const res = await serve('/brand/default.jpg', bucket);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('falls back to the default for a tenant that uploaded nothing', async () => {
    // The case the whole design exists for. A 404 here would make every new
    // business look broken to a caller — Google — with no way to tell a missing
    // upload from a bad URL.
    const bucket = bucketWith({ [DEFAULT_BRAND_KEY]: 'DEFAULT' });

    const res = await serve('/brand/90d5ad58-bc5c-46a3-b82a-9cebb47e00b1.jpg', bucket);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('prefers the tenant image over the default when it has one', async () => {
    const bucket = bucketWith({ [DEFAULT_BRAND_KEY]: 'DEFAULT', 'tenant.jpg': 'TENANT' });

    const res = await serve('/brand/tenant.jpg', bucket);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('TENANT');
  });

  it('404s when neither the key nor a default exists', async () => {
    const res = await serve('/brand/nothing.jpg', bucketWith({}));

    expect(res.status).toBe(404);
  });

  it('refuses to serve a stored object that is not an image', async () => {
    // A logo that renders as a download, or worse as something a browser will
    // execute, is worse than no logo.
    const res = await serve('/brand/evil.html', bucketWith({ 'evil.html': '<script>' }));

    expect(res.status).toBe(404);
  });

  it('404s a path that tries to climb out, without touching the bucket', async () => {
    const get = vi.fn();
    const res = await serve('/brand/../secret', { get } as unknown as R2Bucket);

    expect(res.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it('sets a cache lifetime, because a pass re-renders the image', async () => {
    const res = await serve('/brand/default.jpg', bucketWith({ 'default.jpg': 'X' }));

    expect(res.headers.get('Cache-Control')).toBeTruthy();
  });
});

