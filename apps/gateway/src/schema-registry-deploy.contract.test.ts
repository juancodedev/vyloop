/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The deploy-time guard on the schema registry
// ---------------------------------------------------------------------------
//
// ## What this file is for
//
// Declaring the `SCHEMA_REGISTRY` binding fixes a 500 and creates a quieter
// problem: the gateway would resolve against a namespace with no keys, so every
// `POST /v1/events/{type}` would answer **404 EVENT_TYPE_UNKNOWN** for event
// types the system defines. Better failure, still a broken route.
//
// The registry was empty because nothing ever filled it. `register-schemas` was
// exported from `packages/schema-registry/package.json` and no workflow step
// called it, which means the defect returns after any reset of the namespace and
// nothing in the build would notice: the deploy publishes, the gateway reads,
// the registry is empty, and every signal is green.
//
// So the guarantee this file holds is not "a step exists" — a step can exist and
// be skipped, non-blocking, pointed at local storage, or ordered after the thing
// it is supposed to precede. It is the four properties that together make a
// failed registration visible:
//
// 1. the step runs in the deploy workflow,
// 2. it runs **before** both deploy jobs that publish a reader,
// 3. it is **blocking** — no `continue-on-error`,
// 4. it targets the **remote** namespace resolved from the gateway's own config.
//
// ## Why the workflow is read as text
//
// `wrangler-config.contract.test.ts` reads `wrangler.jsonc` rather than
// importing it, and `wallet-callback-path.contract.test.ts` reads
// `workers/wallet/src/routes.ts` rather than importing `@vyloop/wallet`. This is
// the third instance of the same rule: a deploy pipeline is not a module, and the
// assertions that matter are about text a YAML parser would normalise away —
// whether a step says `continue-on-error`, whether `--remote` is present, which
// job a `needs:` names.

const REPO_ROOT = join(__dirname, '..', '..', '..');
const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

/** The body of one job block, by name. */
function job(name: string): string {
  return (
    new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z-]+:|\\n\\z)`).exec(workflow)?.[1] ?? ''
  );
}

/**
 * The same block with its `#` comment lines removed.
 *
 * Every assertion below is about a command or a key, and the reasoning in this
 * workflow is deliberately long — a comment that *names* a flag it is explaining
 * why not to use would otherwise be read as the flag being present. Stripping
 * comments first keeps the two apart, so a flag mentioned in prose cannot
 * satisfy the assertion that it is not used.
 */
function jobCommands(name: string): string {
  return job(name)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The `needs:` list of one job, as declared. */
function needsOf(name: string): string[] {
  return (
    /needs:\s*\[([^\]]*)\]/
      .exec(job(name))?.[1]
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

describe('the deploy populates the schema registry', () => {
  it('runs a step that publishes the schemas from the registry source', () => {
    // Generated, not committed. A checked-in snapshot of the schemas would be a
    // second copy that drifts silently, producing a registry that looks
    // populated and validates nothing — a failure with no symptom at all until
    // a real event was rejected.
    const step = jobCommands('register-schemas');

    expect(step).toContain('packages/schema-registry/scripts/publish-registry-payload.ts');
    expect(step).toContain('wrangler kv bulk put');
  });

  it('writes to the remote namespace, because local KV is a green no-op', () => {
    // The quietest way to ship this step wrong. `wrangler kv bulk put` defaults
    // to local storage: it prints `Success!`, exits 0, leaves production exactly
    // as empty as before, and the deploy goes green. Every other assertion in
    // this file passes in that world.
    const step = jobCommands('register-schemas');
    const upload = /wrangler kv bulk put[\s\S]*?--remote/.test(step);

    expect(upload, 'the bulk put must pass --remote').toBe(true);
  });

  it('resolves the namespace from the gateway config rather than repeating the id', () => {
    // `--namespace-id` in this workflow would be a sixth copy of the id, in the
    // one file nothing asserts against. Reading it from the config that
    // publishes the binding means the write target and the read target cannot
    // disagree, and `schema-registry-namespace.contract.test.ts` holds the other
    // four configs to that one.
    const step = jobCommands('register-schemas');

    expect(step).toContain('--binding SCHEMA_REGISTRY');
    expect(step).toContain('--config apps/gateway/wrangler.jsonc');
    expect(step).not.toContain('--namespace-id');
  });

  it('reuses the token the deploys already use, and asks for nothing new', () => {
    // One secret to rotate and one blast radius. A second token scoped to KV
    // would be tighter, and it would also be a new thing to provision before any
    // deploy can succeed — so it has to be a deliberate decision, made
    // explicitly, rather than something a missing scope discovers at 03:00.
    const step = jobCommands('register-schemas');

    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
  });

  it('runs before both deploy jobs, so no Worker is published against an empty registry', () => {
    // The ordering, asserted as a dependency edge rather than as a step index,
    // because jobs are what actually express ordering in this file — and because
    // `register-schemas` is a job of its own precisely so that both deploy jobs
    // can depend on it. `deploy-workers` matters as much as `deploy-gateway`:
    // `workers/customer` calls `validate` on its customer-creation route, so it
    // reads the same namespace and would break the same way.
    expect(needsOf('deploy-workers')).toContain('register-schemas');
    expect(needsOf('deploy-gateway')).toContain('register-schemas');
    expect(needsOf('register-schemas')).toContain('quality');
  });

  it('blocks the deploy when it fails, because a green deploy is what hid this', () => {
    // The failure policy, and the reason it is the opposite of the wallet
    // readiness report two jobs up. That report answers a question about an
    // external service and is deliberately non-blocking. This step is not a
    // report: skipping it reproduces the defect, and the reason this bug survived
    // a deploy in the first place is that nothing failed. An empty registry has
    // to be impossible to produce quietly.
    const step = jobCommands('register-schemas');

    expect(step).not.toContain('continue-on-error');
    expect(step).not.toContain('|| true');
    expect(step).not.toContain('if: always');
  });
});
