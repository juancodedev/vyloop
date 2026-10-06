/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = __dirname;
const configPath = join(here, '..', 'wrangler.jsonc');
const registrySource = readFileSync(
  join(here, '..', '..', '..', 'packages', 'schema-registry', 'src', 'index.ts'),
  'utf8',
);

/**
 * Parse the JSONC config.
 *
 * String-aware for the same reason the gateway's own copy is: this file's values
 * include URLs and its comments discuss the flag by name, so a stripper that drops
 * everything from `//` onward takes the whole document with it.
 */
function parseJsonc(source: string): { compatibility_flags?: unknown } {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = ch === '\\' && !escaped;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString && ch === '/' && source[i + 1] === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }

  return JSON.parse(out) as { compatibility_flags?: unknown };
}

const flags = parseJsonc(readFileSync(configPath, 'utf8')).compatibility_flags;

describe('customer worker compatibility flags', () => {
  /**
   * The one assertion that matters.
   *
   * `ajv.compile()` builds a validator with `new Function()`. Node permits that and
   * Workers does not, so this flag is the difference between a passing test suite and
   * a production worker that throws `EvalError: Code generation from strings
   * disallowed for this context` on every single new customer registration.
   *
   * It cannot be caught by a behavioural test, because the behaviour being asserted
   * is produced by the *runtime*, not by this repository. Vitest runs under Node,
   * where the same call succeeds. A guard that only watched the tests would stay
   * green through the entire outage.
   *
   * The failure is also silent in the worst direction: the customer row commits
   * before the compile is reached, so the client is registered while the response
   * says `500`. Removing this flag does not make the endpoint return an error — it
   * makes it lie about a write that already happened.
   */
  it('enables unsafe-eval so the schema registry can compile validators', () => {
    expect(
      Array.isArray(flags) && flags.includes('unsafe-eval'),
      'workers/customer/wrangler.jsonc must keep "unsafe-eval" in compatibility_flags. ' +
        'Removing it makes ajv.compile() throw in Workers while every test stays green, ' +
        'and PUT /v1/customers answers 500 for a customer that was in fact inserted.',
    ).toBe(true);
  });

  /**
   * The other direction.
   *
   * A flag that opens runtime code generation on a worker holding customer PII is a
   * security cost, and a cost nobody is tracking stops being a cost. If the registry
   * ever stops compiling at runtime — precompiled validators, or no runtime validation
   * at all — this test fails on purpose, so the flag is reconsidered instead of
   * outliving the reason it was added.
   */
  it('has a reason to exist: the schema registry still compiles at runtime', () => {
    expect(
      /ajv\.compile\(|\.compile\(schema/.test(registrySource),
      'workers/customer/wrangler.jsonc enables unsafe-eval only because ' +
        'packages/schema-registry compiles validators at runtime. That dependency has ' +
        'changed, so revisit whether this worker still needs runtime code generation.',
    ).toBe(true);
  });
});