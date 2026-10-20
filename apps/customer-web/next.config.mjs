/** @type {import('next').NextConfig} */
const nextConfig = {
  // `/program` must open the programme page on its own. Next.js serves files in
  // `public/` at the root but does not resolve a directory index, so
  // `public/program/index.html` is reachable at `/program/index.html` and nowhere
  // else. That URL is what went to Google's publishing review, and a link that
  // has to carry `.html` reads as an unfinished deployment.
  //
  // This lives here rather than in a `public/_redirects` file because
  // `@cloudflare/next-on-pages` emits a `_worker.js`, which puts the project in
  // Cloudflare's advanced mode — and in advanced mode Pages ignores
  // `_redirects` entirely. The file was deployed, it was in the upload, and it
  // did nothing: `/program` kept returning 404 from a build that looked correct
  // on disk. Only the Worker's own routing is consulted.
  async rewrites() {
    return [{ source: '/program', destination: '/program/index.html' }];
  },
  eslint: {
    // ESLint false positives on relative imports — webpack resolves correctly
    ignoreDuringBuilds: true,
  },
};

// A production build with no gateway URL ships a bundle that calls the visitor's
// own machine. It builds cleanly, passes every test, and only fails in someone's
// browser. The only place that can still catch it is here, before deploy.
//
// A `localhost` value is refused outright rather than only warned about: it is
// never a correct production gateway, and warning about it is how it shipped once.
if (process.env.NODE_ENV === 'production') {
  const gatewayUrl = process.env.NEXT_PUBLIC_API_URL;
  if (typeof gatewayUrl !== 'string' || gatewayUrl.trim() === '') {
    throw new Error(
      'NEXT_PUBLIC_API_URL is required for a production build. Without it ' +
        'the client falls back to http://localhost:8787 and the deployed app ' +
        'calls the visitor\'s own machine.',
    );
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(gatewayUrl.trim())) {
    throw new Error(
      `NEXT_PUBLIC_API_URL points at localhost (${gatewayUrl}). That is a ` +
        'development address and cannot work in a deployed browser.',
    );
  }
}

// A production build with no VAPID public key ships a bundle that cannot
// subscribe anybody to push messages. It builds cleanly and passes every test;
// the failure appears in a browser, as a button that does nothing.
//
// The key is public by design — the browser subscribes with it — so this is a
// missing-configuration check and not a secret check. The private half is the
// secret, and it never reaches this bundle.
if (process.env.NODE_ENV === 'production') {
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (typeof vapidPublicKey !== 'string' || vapidPublicKey.trim() === '') {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY is required for a production build. ' +
        'Without it the client cannot subscribe to push messages, and the ' +
        'failure only shows up in a browser.',
    );
  }
}

export default nextConfig;
