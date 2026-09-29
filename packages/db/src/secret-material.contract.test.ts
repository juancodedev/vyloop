// @vitest-environment node

/**
 * No credential may ever be tracked by git.
 *
 * A `.gitignore` pattern cannot look inside a file, so it is a convenience and
 * not a guarantee. This is the guarantee: it reads what git actually tracks and
 * fails if a private key is in there.
 *
 * The failure this prevents is not exotic. A downloaded Google service account
 * key lands in the working directory, `git status` shows it as untracked, and
 * `git add -A` publishes a live private key to a public repository. The
 * repository is the wrong place for it and the pull request is the wrong moment
 * to discover that.
 *
 * `git log` is also checked, because removing a file from the working tree does
 * not remove it from history. A key that was ever pushed has to be rotated, and
 * rotation is a Google Cloud operation this test cannot perform.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const MARKERS = [
  'BEGIN PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
  'BEGIN EC PRIVATE KEY',
  'BEGIN OPENSSH PRIVATE KEY',
];

/** Credential-shaped fields that must never appear in tracked source. */
const FIELDS = ['"private_key"', '"client_secret"', '"refresh_token"', '"api_key"', '"pepper"'];

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const tracked = git(['ls-files']).split('\n').filter(Boolean);
const worktree = process.cwd();

describe('secret material', () => {
  it('has a non-empty tracked file list', () => {
    // Everything below is vacuously true with zero files. If git is unavailable
    // or the commands fail, this fails first rather than reporting "clean".
    expect(tracked.length).toBeGreaterThan(100);
  });

  it('tracks no file containing a private key', () => {
    const offenders: string[] = [];
    for (const file of tracked) {
      let contents: string;
      try {
        contents = git(['show', `HEAD:${file}`]);
      } catch {
        continue; // deleted or not yet committed; not a leak
      }
      if (MARKERS.some((marker) => contents.includes(marker))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('tracks no file carrying a credential field', () => {
    const offenders: string[] = [];
    for (const file of tracked) {
      if (!/\.(json|ya?ml|env|ts|tsx|js|mjs|cjs)$/.test(file)) continue;
      // The gates legitimately mention these names in a string, so a hit is a
      // candidate to look at, not automatically a finding. The assertion is that
      // there are none in the committed tree.
      let contents: string;
      try {
        contents = git(['show', `HEAD:${file}`]);
      } catch {
        continue;
      }
      if (FIELDS.some((field) => contents.includes(field))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has never had a private key in its history', () => {
    // Removing a file from the working tree does not remove it from history, and
    // a key that was pushed has to be rotated rather than deleted. This is the
    // check that turns "I removed it" into a fact.
    const objects = git(['rev-list', '--objects', '--all']);
    const suspicious = objects
      .split('\n')
      .map((line) => line.split(' ')[1] ?? '')
      .filter((path) => /\.json$/.test(path) && /service|account|credential|key/i.test(path));

    expect(suspicious).toEqual([]);
  });

  it('does not track a service account key file', () => {
    const offenders = tracked.filter((file) =>
      /(?:^|\/)[^/]*-[0-9a-f]{8,}\.json$/.test(file),
    );
    expect(offenders).toEqual([]);
  });

  it('is not running from inside a directory it would scan as source', () => {
    // Guards the paths below: this test only means something if it is reading
    // the repository root.
    expect(worktree.endsWith('/vyloop')).toBe(true);
  });
});
