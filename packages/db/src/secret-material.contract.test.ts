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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** PEM headers, matched only when followed by a real key body. */
const BEGIN_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

/**
 * True when the file holds an actual key rather than a mention of one.
 *
 * The naive version of this test reported three findings, all of them false:
 *
 * - `jwt.ts` contains the marker inside a comment explaining that a PEM must be
 *   PKCS8 and not SEC1
 * - `jwt.test.ts` contains a deliberately malformed fixture whose body is `nope`
 * - a path matching `service` that is a `package.json`
 *
 * A real PKCS8 key is base64 of substantial length wrapped between BEGIN and
 * END. Requiring that body is what separates a leak from a comment, and a stub
 * from a credential. Requiring it also keeps the guard honest in the other
 * direction: a genuine key pasted into a test file is still a leak, and it has a
 * real body.
 */
function holdsRealPrivateKey(contents: string): boolean {
  const match = BEGIN_MARKER.exec(contents);
  if (!match) return false;

  const after = contents.slice(match.index + match[0].length);
  const end = after.indexOf('-----END');
  if (end === -1) return false;

  const body = after.slice(0, end);
  // Real key material is base64 on its own lines. A comment or a stub is prose.
  const base64Lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line) && line.length >= 32);

  return base64Lines.length >= 2;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Tracked files whose contents match a pattern, in one git process.
 *
 * The first version of this test shelled out to `git show` once per tracked
 * file and timed out: a process per file does not scale to a repository this
 * size. `git grep` does the sweep in one call, and the precise check then runs
 * only over the handful of candidates it returns.
 */
function trackedFilesMatching(pattern: RegExp): string[] {
  let out = '';
  try {
    // `-e` is required, not optional: the pattern starts with `-----`, and
    // without it git reads the pattern as an option list and exits 129. That
    // surfaced as a thrown error rather than a result, which is how a guard this
    // important can end up reporting nothing at all.
    out = git(['grep', '-lI', '-E', '-e', pattern.source, '--', '.']);
  } catch (error) {
    // `git grep` exits 1 when nothing matches, which is the good case.
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
  return out.split('\n').filter(Boolean);
}

const tracked = git(['ls-files']).split('\n').filter(Boolean);
const worktree = process.cwd();

describe('secret material', () => {
  it('has a non-empty tracked file list', () => {
    // Everything below is vacuously true with zero files. If git is unavailable
    // or the commands fail, this fails first rather than reporting "clean".
    expect(tracked.length).toBeGreaterThan(100);
  });

  it('tracks no file containing a real private key', () => {
    // One sweep for the marker, then the precise check over the few files that
    // mention it. A real key pasted into a test file still fails this, because it
    // still has a real body.
    const candidates = trackedFilesMatching(/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    const offenders = candidates.filter((file) => {
      const contents = readFileSync(join(worktree, file), 'utf8');
      return holdsRealPrivateKey(contents);
    });
    expect(offenders).toEqual([]);
  });

  it('recognises a real key rather than a mention of one', () => {
    // The guard above is worthless if it cannot tell the two apart, so the
    // detector is tested against both shapes. A real RS256 key body, and the
    // comment and stub that produced the three false findings.
    const real = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA7x8V7l2Q1n0p9r4s',
      't6y8u3v5w7x9z1a3b5c7d9e1f3g5h7j9k1l3m5n7o9q1s3u5w7y9z1a3b5c7d9e1f3g',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    expect(holdsRealPrivateKey(real)).toBe(true);

    const comment = ' * (`BEGIN PRIVATE KEY`), never the SEC1 form.';
    expect(holdsRealPrivateKey(comment)).toBe(false);

    const stub = '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----';
    expect(holdsRealPrivateKey(stub)).toBe(false);
  });

  it('tracks no file carrying a credential field', () => {
    const candidates = trackedFilesMatching(/"(private_key|client_secret|refresh_token)":\s*"[^"]{20,}/);
    expect(candidates).toEqual([]);
  });

  it('has never tracked a downloaded key file by name', () => {
    // Removing a file from the working tree does not remove it from history, and
    // a key that was pushed has to be rotated rather than deleted. Scoped to the
    // naming Google gives a downloaded key — `<project>-<hex>.json` — because a
    // path merely containing "service" or "key" matches half this repository.
    const suspicious = git(['rev-list', '--objects', '--all'])
      .split('\n')
      .map((line) => line.split(' ')[1] ?? '')
      .filter((path) => /^[A-Za-z0-9_-]+-[0-9a-f]{8,}\.json$/.test(path));

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
