import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // This package's tsconfig sets `"jsx": "preserve"` for Next.js, which tells
  // esbuild not to transform JSX at all — correct for the build, and wrong for a
  // test file that contains JSX. `automatic` is the same setting the customer-web
  // test config uses, for the same reason.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
// Every page in this app imports through `@/`, per the `paths` entry in
    // tsconfig.json. Next resolves it from that config at build time; vitest has
    // no tsconfig awareness, so without this the first suite to import a page
    // component fails on the alias rather than on anything about the page.
    //
    // Until this existed, no test in this package could import a component, which
    // is why every one of them reads a page as source text instead: nothing
    // rendered, so nothing could be checked.
    alias: {
      '@': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  test: {
    globals: true,
    // Left as `node`, which is what the guard suite in `src/__tests__` runs in and
    // what every existing test in this package already declares for itself. The
    // suites that need a DOM — the customer edit form and the QR page's render
    // behaviour — each ask for `// @vitest-environment jsdom` in their own header,
    // so adding rendering support did not have to change the environment the eight
    // source-scanning guards run in.
  },
});