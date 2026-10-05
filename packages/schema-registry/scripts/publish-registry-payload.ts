/**
 * Write the schema registry payload for `wrangler kv bulk put` to a file.
 *
 * Split from `build-registry-payload.ts` so that module stays a pure function
 * of the schema source: the CLI is the only part with a filesystem and an exit
 * code, and the deploy step is the only thing that should care about either.
 *
 * Usage:
 * ```
 * node --experimental-strip-types \
 *   packages/schema-registry/scripts/publish-registry-payload.ts <output.json>
 * ```
 *
 * Node 22 strips the types natively, which is why the imports in this directory
 * carry explicit `.ts` extensions: without them Node's resolver looks for
 * `register-schemas.js`, finds nothing, and the deploy step fails on a missing
 * module rather than on anything to do with the registry.
 */
import { writeFile } from 'node:fs/promises';

import { buildRegistryPayload, renderPayload } from './build-registry-payload.ts';

const outputPath = process.argv[2];

if (!outputPath) {
  // Exit non-zero rather than writing to stdout: a payload on stdout would be
  // indistinguishable from a payload on disk, and the caller redirects to a
  // file. Failing here means the workflow step fails, which blocks the deploy.
  console.error('usage: publish-registry-payload.ts <output.json>');
  process.exit(2);
}

const entries = await buildRegistryPayload();
await writeFile(outputPath, renderPayload(entries), 'utf8');

// On stdout, not stderr: this is the deploy log's record of what was published,
// and `wrangler` prints its own confirmation next to it.
console.log(`schema-registry payload: ${entries.length} keys -> ${outputPath}`);
