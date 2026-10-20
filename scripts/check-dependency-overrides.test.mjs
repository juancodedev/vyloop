// Dependency override gate — tests.
//
// Written before the implementation (RED first) and verified again by reverting
// each guard.
//
// ## Why the expectations here are hand-written
//
// A test that computes what to expect with the same comparison the gate uses is a
// tautology: it passes when the gate is wrong in exactly the way the test is
// wrong. Every fixture below is therefore a literal — an override table, a
// lockfile body, an expected verdict — written out by hand rather than derived
// from the code under test.
//
// The one place a real oracle is available is `semver`, which pnpm has in the
// store (`node_modules/.pnpm/semver@7.8.5`) but which is not a declared
// dependency of this repository and is not resolvable from the root. Reaching
// into that is relying on a hoisting accident, and a security gate is the last
// place to take a dependency that is not pinned in `package.json`. So the
// comparison is written here and, in "semver is the oracle" below, the written
// comparison is checked against the library on a spread of cases rather than
// being replaced by it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  classifyOverride,
  compareVersions,
  parseLockfilePackages,
  parseVersion,
  satisfiesRange,
  checkOverrides,
  formatReport,
  formatInertList,
  readOverrideTable,
  LOCKFILE_PATH,
  PACKAGE_JSON_PATH,
} from './check-dependency-overrides.mjs';

// ---------------------------------------------------------------------------
// Fixtures — literals, written by hand
// ---------------------------------------------------------------------------

/**
 * A lockfile body carrying `entries` as resolved packages.
 *
 * Shaped like `pnpm-lock.yaml` v9: an `overrides:` block, a `packages:` block
 * whose keys are `name@version` and whose bodies begin with `resolution:`, and a
 * `snapshots:` block whose keys carry peer suffixes. All three are there on
 * purpose — the first so a parser cannot be fooled by the override text, the
 * third so it cannot mistake `react-dom@19.2.7(react@19.2.7)` for a version.
 */
const lockfileWith = (entries, { overrides = [], snapshots = [] } = {}) =>
  [
    "lockfileVersion: '9.0'",
    '',
    'overrides:',
    ...overrides.map(([key, value]) => `  ${key}: ${value}`),
    '',
    'packages:',
    '',
    ...entries.flatMap(([name, version]) => [
      `  ${name}@${version}:`,
      `    resolution: {integrity: sha512-fixture}`,
      '',
    ]),
    'snapshots:',
    '',
    ...snapshots.flatMap(([key, version]) => [`  ${key}:`, '    dependencies:', `      self: ${version}`, '']),
    '',
  ].join('\n');

const REAL_OVERRIDES = readFileSync(PACKAGE_JSON_PATH, 'utf8');
const REAL_LOCKFILE = readFileSync(LOCKFILE_PATH, 'utf8');

const tableOf = (overrides) => ({ pnpm: { overrides } });

// ---------------------------------------------------------------------------
// parseVersion / compareVersions
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('reads a three-part version', () => {
    expect(parseVersion('8.5.23')).toMatchObject({ major: 8, minor: 5, patch: 23 });
  });

  it('reads a prerelease tag', () => {
    expect(parseVersion('1.2.3-beta.1')).toMatchObject({ prerelease: 'beta.1' });
  });

  it('records build metadata but does not let it change the version', () => {
    // `@cloudflare/workerd-darwin-arm64` resolves with build metadata in this
    // repository, so this is not a hypothetical shape.
    expect(parseVersion('1.0.0+abc.1')).toMatchObject({ build: 'abc.1', prerelease: '' });
  });

  it('returns null for text that is not a version', () => {
    expect(parseVersion('>=1.1.18')).toBe(null);
    expect(parseVersion('1.2')).toBe(null);
    expect(parseVersion('latest')).toBe(null);
    expect(parseVersion('')).toBe(null);
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    // The lexical reading puts "1.10.0" before "1.9.0" and would clear a real
    // advisory. `nanoid` resolves at both 3.3.20 and 6.0.1 here.
    expect(compareVersions(parseVersion('1.10.0'), parseVersion('1.9.0'))).toBe(1);
    expect(compareVersions(parseVersion('1.9.0'), parseVersion('1.10.0'))).toBe(-1);
  });

  it('is zero for equal versions', () => {
    expect(compareVersions(parseVersion('8.5.23'), parseVersion('8.5.23'))).toBe(0);
  });

  it('ignores build metadata, which does not order versions', () => {
    expect(compareVersions(parseVersion('1.0.0+one'), parseVersion('1.0.0+two'))).toBe(0);
  });

  it('orders a prerelease below its release', () => {
    expect(compareVersions(parseVersion('1.2.3-beta.1'), parseVersion('1.2.3'))).toBe(-1);
    expect(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3-beta.1'))).toBe(1);
  });

  it('orders prerelease identifiers the way semver does', () => {
    // beta < rc, and a numeric identifier sorts below an alphanumeric one.
    expect(compareVersions(parseVersion('1.0.0-beta'), parseVersion('1.0.0-rc'))).toBe(-1);
    expect(compareVersions(parseVersion('1.0.0-1'), parseVersion('1.0.0-beta'))).toBe(-1);
  });

  it('refuses to compare a version it could not parse', () => {
    // Silently ordering a malformed version would produce a confident wrong
    // answer from an unreadable input, which is the failure this whole gate
    // exists to prevent.
    expect(() => compareVersions(parseVersion('>=1.1.18'), parseVersion('1.0.0'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// satisfiesRange — the selector side
// ---------------------------------------------------------------------------

describe('satisfiesRange', () => {
  it('is true at the lower bound and false one patch below it', () => {
    expect(satisfiesRange(parseVersion('8.20.1'), '>=8.20.1')).toBe(true);
    expect(satisfiesRange(parseVersion('8.20.0'), '>=8.20.1')).toBe(false);
  });

  it('treats a bare upper bound as strict', () => {
    // This is the real shape in `pnpm-lock.yaml`: `ws@8.21.0` sits exactly on
    // `ws@>=8.0.0 <8.21.0`. Read inclusively, that override would appear to
    // apply to it and demand a version above itself.
    expect(satisfiesRange(parseVersion('8.21.0'), '>=8.0.0 <8.21.0')).toBe(false);
    expect(satisfiesRange(parseVersion('8.20.9'), '>=8.0.0 <8.21.0')).toBe(true);
  });

  it('treats a `<=` bound as inclusive', () => {
    expect(satisfiesRange(parseVersion('3.1.3'), '>=3.0.0 <=3.1.3')).toBe(true);
    expect(satisfiesRange(parseVersion('3.1.4'), '>=3.0.0 <=3.1.3')).toBe(false);
  });

  it('intersects space-separated terms', () => {
    expect(satisfiesRange(parseVersion('8.9.5'), '>=8.0.0 <8.10.2')).toBe(true);
    expect(satisfiesRange(parseVersion('7.30.0'), '>=8.0.0 <8.10.2')).toBe(false);
    expect(satisfiesRange(parseVersion('8.0.0'), '>=8.0.0 <8.10.2')).toBe(true);
  });

  it('reads a bare version as equality', () => {
    expect(satisfiesRange(parseVersion('1.2.3'), '1.2.3')).toBe(true);
    expect(satisfiesRange(parseVersion('1.2.4'), '1.2.3')).toBe(false);
  });

  it('matches everything on `*`', () => {
    expect(satisfiesRange(parseVersion('1.0.0'), '*')).toBe(true);
  });

  it('refuses a range it cannot read rather than skipping it', () => {
    expect(() => satisfiesRange(parseVersion('1.0.0'), 'nonsense')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// classifyOverride — the three shapes
// ---------------------------------------------------------------------------

describe('classifyOverride', () => {
  it('reads `pkg@<range>` as a version rewrite with a selector', () => {
    expect(classifyOverride('postcss@<=8.5.22', '>=8.5.23')).toMatchObject({
      kind: 'range',
      name: 'postcss',
      selector: '<=8.5.22',
      value: '>=8.5.23',
      threshold: '>=8.5.23',
      // Kept apart so the comparison reads the version instead of re-parsing it
      // out of its own rendering — see readRequirement.
      operator: '>=',
      thresholdVersion: '8.5.23',
      key: 'postcss@<=8.5.22',
    });
  });

  it('reads a bare `pkg` as an exact pin', () => {
    expect(classifyOverride('react', '19.2.7')).toMatchObject({
      kind: 'exact',
      name: 'react',
      selector: null,
      value: '19.2.7',
    });
  });

  it('reads a bare scoped `pkg` as an exact pin, not as a selector', () => {
    // The `@` of `@vitest/mocker` is the scope marker. Splitting there would
    // produce the package name `/mocker`.
    expect(classifyOverride('@vitest/mocker', '4.1.11')).toMatchObject({
      kind: 'exact',
      name: '@vitest/mocker',
      selector: null,
    });
  });

  it('splits a scoped package on the second `@` when a selector follows', () => {
    expect(classifyOverride('@vitest/mocker@>=2.1.0 <4.1.11', '>=4.1.11')).toMatchObject({
      kind: 'range',
      name: '@vitest/mocker',
      selector: '>=2.1.0 <4.1.11',
    });
  });

  it('reads `parent>child` as a dependency override', () => {
    expect(classifyOverride('jsdom>undici', '^7.25.0')).toMatchObject({
      kind: 'dependency',
      name: 'undici',
      parent: 'jsdom',
      selector: null,
    });
  });

  it('reads a dependency override whose parent carries a selector', () => {
    expect(classifyOverride('jsdom@>=25>undici', '^7.25.0')).toMatchObject({
      kind: 'dependency',
      name: 'undici',
      parent: 'jsdom@>=25',
    });
  });

  it('does not mistake the `>` of `>=` for a dependency separator', () => {
    // `undici@>=8.0.0 <8.9.0` contains a `>` and is not a dependency override.
    expect(classifyOverride('undici@>=8.0.0 <8.9.0', '>=8.9.0')).toMatchObject({
      kind: 'range',
      name: 'undici',
      selector: '>=8.0.0 <8.9.0',
    });
    expect(classifyOverride('undici@>=8.1.0 <8.10.2', '>=8.10.2').kind).toBe('range');
  });

  it('treats `*` as a rewrite with no threshold', () => {
    expect(classifyOverride('pkg@<1.0.0', '*')).toMatchObject({ threshold: null });
  });

  it('refuses a rewrite value it cannot read as a requirement', () => {
    // Not a skip. An override this gate cannot evaluate is an override nothing
    // is checking, and that has to be visible.
    expect(() => classifyOverride('pkg@<1.0.0', '^1.0.0')).toThrow(/pkg@<1.0.0/);
  });

  it('refuses a selector it cannot read', () => {
    expect(() => classifyOverride('pkg@nonsense', '>=1.0.0')).toThrow(/pkg@nonsense/);
  });
});

// ---------------------------------------------------------------------------
// parseLockfilePackages
// ---------------------------------------------------------------------------

describe('parseLockfilePackages', () => {
  it('reads plain and quoted keys alike', () => {
    const resolved = parseLockfilePackages(
      lockfileWith([
        ['postcss', '8.5.23'],
        ['@vitest/mocker', '4.1.11'],
      ]),
    );
    expect([...resolved.get('postcss')]).toEqual(['8.5.23']);
    expect([...resolved.get('@vitest/mocker')]).toEqual(['4.1.11']);
  });

  it('does not read the `overrides:` block as resolved packages', () => {
    const resolved = parseLockfilePackages(
      lockfileWith([['react', '19.2.7']], { overrides: [['postcss@<=8.5.22', "'>=8.5.23'"]] }),
    );
    expect(resolved.has('postcss@<=8.5.22')).toBe(false);
    expect(resolved.has('postcss')).toBe(false);
  });

  it('does not read the `snapshots:` block, whose keys carry peer suffixes', () => {
    const resolved = parseLockfilePackages(
      lockfileWith([['react-dom', '19.2.7']], { snapshots: [['react-dom@19.2.7(react@19.2.7)', '1']] }),
    );
    expect([...resolved.get('react-dom')]).toEqual(['19.2.7']);
    expect(resolved.has('react-dom@19.2.7(react@19.2.7)')).toBe(false);
  });

  it('ignores a nested metadata key that is indented deeper than a package', () => {
    // `peerDependenciesMeta:` holds `bufferutil:` at six spaces in the real
    // lockfile. A parser that anchors on "two spaces, then a non-space" without
    // anchoring the full indent reads it as a package called `bufferuti`.
    const text = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      '  ws@8.21.0:',
      '    resolution: {integrity: sha512-fixture}',
      '    peerDependenciesMeta:',
      '      bufferutil:',
      '        optional: true',
      '',
    ].join('\n');
    expect([...parseLockfilePackages(text).keys()]).toEqual(['ws']);
  });

  it('collects every version of a package that resolves more than once', () => {
    // `postcss`, `nanoid`, `esbuild`, `cookie` and `undici` all resolve at two
    // or more versions in this repository.
    const resolved = parseLockfilePackages(
      lockfileWith([
        ['nanoid', '3.3.20'],
        ['nanoid', '6.0.1'],
      ]),
    );
    expect([...resolved.get('nanoid')]).toEqual(['3.3.20', '6.0.1']);
  });

  it('refuses a lockfile with no `packages:` section', () => {
    expect(() => parseLockfilePackages("lockfileVersion: '9.0'\n")).toThrow(/packages/);
  });
});

// ---------------------------------------------------------------------------
// readOverrideTable
// ---------------------------------------------------------------------------

describe('readOverrideTable', () => {
  it('groups every version rewrite and pin, and separates the dependency overrides', () => {
    const { requirements, skipped, errors } = readOverrideTable({
      'postcss@<=8.5.22': '>=8.5.23',
      react: '19.2.7',
      'jsdom>undici': '^7.25.0',
    });
    expect(errors).toEqual([]);
    expect(requirements.map((r) => r.key).sort()).toEqual(['postcss@<=8.5.22', 'react']);
    expect(skipped).toEqual([
      { key: 'jsdom>undici', parent: 'jsdom', name: 'undici', value: '^7.25.0' },
    ]);
  });

  it('reports an override it cannot read instead of dropping it', () => {
    const { errors } = readOverrideTable({ 'pkg@<1.0.0': '^1.0.0' });
    expect(errors.join(' ')).toMatch(/pkg@<1.0.0/);
  });
});

// ---------------------------------------------------------------------------
// The gate, on fixtures
// ---------------------------------------------------------------------------

describe('checkOverrides', () => {
  it('fails a package resolved below the threshold its override names', () => {
    const gate = checkOverrides({
      overrides: tableOf({ 'postcss@<=8.5.22': '>=8.5.23' }).pnpm.overrides,
      lockfileText: lockfileWith([['postcss', '8.5.22']]),
    });
    expect(gate.ok).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0]).toMatchObject({
      name: 'postcss',
      resolved: '8.5.22',
      required: '>=8.5.23',
      overrideKey: 'postcss@<=8.5.22',
    });
  });

  it('names the package, the threshold, the resolved version and the override line', () => {
    // A red build that says only "dependency check failed" tells the reader
    // nothing they can act on. These four strings are the finding.
    const gate = checkOverrides({
      overrides: { 'postcss@<=8.5.22': '>=8.5.23' },
      lockfileText: lockfileWith([['postcss', '8.5.22']]),
    });
    const message = formatReport(gate);
    expect(message).toContain('postcss');
    expect(message).toContain('>=8.5.23');
    expect(message).toContain('8.5.22');
    expect(message).toContain('postcss@<=8.5.22');
  });

  it('passes a package resolved above the threshold', () => {
    const gate = checkOverrides({
      overrides: { 'postcss@<=8.5.22': '>=8.5.23' },
      lockfileText: lockfileWith([['postcss', '8.5.25']]),
    });
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  it('passes a package resolved exactly at the threshold', () => {
    // The `>` instead of `>=` version of this gate fails here, and the failure
    // would be on the packages that are exactly right: `postcss` resolves at
    // 8.5.23 for `>=8.5.23`, `drizzle-orm` at 0.45.2 for `>=0.45.2`,
    // `source-map-js` at 1.2.2, `js-yaml` at 4.3.2, `vitest` at 4.1.11.
    const gate = checkOverrides({
      overrides: { 'fixture@<8.5.24': '>=8.5.23' },
      lockfileText: lockfileWith([['fixture', '8.5.23']]),
    });
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it('uses the highest threshold among the overrides that match, not the first', () => {
    // All three selectors match 1.2.5, so first (>=1.0.0) and middle (>=1.1.0)
    // would both clear it. Only the last (>=1.4.0) catches it.
    const gate = checkOverrides({
      overrides: {
        'fixture@<2.0.0': '>=1.0.0',
        'fixture@<1.5.0': '>=1.1.0',
        'fixture@<2.0.0 <3.0.0': '>=1.4.0',
      },
      lockfileText: lockfileWith([['fixture', '1.2.5']]),
    });
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0].required).toBe('>=1.4.0');
    expect(gate.violations[0].overrideKey).toBe('fixture@<2.0.0 <3.0.0');
  });

  it('uses the highest threshold, not the last written, when order disagrees', () => {
    // Same three requirements, written in the other order. If the gate took the
    // last entry it would see >=1.1.0 and pass.
    const gate = checkOverrides({
      overrides: {
        'fixture@<2.0.0 <3.0.0': '>=1.4.0',
        'fixture@<1.5.0': '>=1.1.0',
        'fixture@<2.0.0': '>=1.0.0',
      },
      lockfileText: lockfileWith([['fixture', '1.2.5']]),
    });
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0].required).toBe('>=1.4.0');
  });

  it('does not let an override whose selector does not match set the bar', () => {
    // 8.5.24 is outside `<=8.5.22`, so that override is inert and the package
    // is judged only by the one that does match it. This is the difference
    // between "moved past the advisory" and "still below it".
    const gate = checkOverrides({
      overrides: { 'fixture@<=8.5.22': '>=9.9.9' },
      lockfileText: lockfileWith([['fixture', '8.5.24']]),
    });
    expect(gate.violations).toEqual([]);
    expect(gate.inert.map((i) => i.overrideKey)).toEqual(['fixture@<=8.5.22']);
  });

  it('reports every violation, not the first', () => {
    const gate = checkOverrides({
      overrides: { 'a@<2.0.0': '>=1.5.0', 'b@<2.0.0': '>=1.5.0' },
      lockfileText: lockfileWith([
        ['a', '1.0.0'],
        ['b', '1.0.0'],
      ]),
    });
    expect(gate.violations.map((v) => v.name).sort()).toEqual(['a', 'b']);
  });

  it('does not read a dependency override as a version threshold', () => {
    // `jsdom>undici: ^7.25.0` rewrites the copy of undici that jsdom gets; it
    // says nothing about undici's own version. Reading `^7.25.0` as a
    // requirement, or as a package named `jsdom`, would report a violation
    // against a lockfile that is behaving exactly as declared.
    const gate = checkOverrides({
      overrides: { 'jsdom>undici': '^7.25.0' },
      lockfileText: lockfileWith([
        ['jsdom', '30.1.2'],
        ['undici', '7.30.0'],
      ]),
    });
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(gate.skippedDependencies).toEqual([
      { key: 'jsdom>undici', parent: 'jsdom', name: 'undici', value: '^7.25.0' },
    ]);
  });

  it('does not create a requirement out of the parent side of a dependency override', () => {
    const gate = checkOverrides({
      overrides: { 'jsdom@>=25>undici': '^7.25.0' },
      lockfileText: lockfileWith([['jsdom', '30.1.2']]),
    });
    expect(gate.violations).toEqual([]);
    expect(gate.skippedDependencies[0]).toMatchObject({ parent: 'jsdom@>=25', name: 'undici' });
  });

  it('compares an exact pin for equality', () => {
    const gate = checkOverrides({
      overrides: { react: '19.2.7' },
      lockfileText: lockfileWith([['react', '19.2.7']]),
    });
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(gate.enforced[0]).toMatchObject({ rule: 'exact', required: '=19.2.7' });
  });

  it('fails an exact pin that does not match, in either direction', () => {
    const above = checkOverrides({
      overrides: { react: '19.2.7' },
      lockfileText: lockfileWith([['react', '19.3.0']]),
    });
    expect(above.violations).toHaveLength(1);
    expect(above.violations[0].required).toBe('=19.2.7');

    // Below the pin is a violation too: an exact pin means an exact version.
    const below = checkOverrides({
      overrides: { react: '19.2.7' },
      lockfileText: lockfileWith([['react', '19.2.6']]),
    });
    expect(below.violations).toHaveLength(1);
  });

  it('applies an exact pin to every resolution of the package', () => {
    const gate = checkOverrides({
      overrides: { fixture: '1.0.0' },
      lockfileText: lockfileWith([
        ['fixture', '1.0.0'],
        ['fixture', '1.0.1'],
      ]),
    });
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0].resolved).toBe('1.0.1');
  });

  it('judges every resolution of a package that resolves more than once', () => {
    const gate = checkOverrides({
      overrides: { 'undici@<6.27.0': '>=6.27.0' },
      lockfileText: lockfileWith([
        ['undici', '6.26.0'],
        ['undici', '7.30.0'],
      ]),
    });
    // 6.26.0 is inside the selector and below the floor; 7.30.0 is outside it.
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0].resolved).toBe('6.26.0');
  });
});

// ---------------------------------------------------------------------------
// It cannot pass vacuously
// ---------------------------------------------------------------------------

describe('checkOverrides cannot pass vacuously', () => {
  it('fails an empty override table rather than checking nothing successfully', () => {
    const gate = checkOverrides({
      overrides: {},
      lockfileText: lockfileWith([['postcss', '8.5.23']]),
    });
    expect(gate.ok).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.errors.join(' ')).toMatch(/override/i);
  });

  it('fails a package.json with no pnpm.overrides at all', () => {
    const gate = checkOverrides({ overrides: undefined, lockfileText: REAL_LOCKFILE });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/override/i);
  });

  it('fails an unreadable lockfile rather than reporting nothing wrong', () => {
    const gate = checkOverrides({
      overrides: { 'postcss@<=8.5.22': '>=8.5.23' },
      lockfileText: '',
    });
    expect(gate.ok).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.errors.join(' ')).toMatch(/lockfile|packages/i);
  });

  it('fails a lockfile that resolves nothing at all', () => {
    // A parse that returned an empty map would satisfy every requirement by
    // finding no version to check.
    const gate = checkOverrides({
      overrides: { 'postcss@<=8.5.22': '>=8.5.23' },
      lockfileText: "lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n",
    });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/packages/i);
  });

  it('fails an override it cannot evaluate rather than skipping it', () => {
    const gate = checkOverrides({
      overrides: { 'postcss@<=8.5.22': '>=8.5.23', 'weird@<1.0.0': '~1.0.0' },
      lockfileText: lockfileWith([['postcss', '8.5.23']]),
    });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/weird@<1.0.0/);
  });

  it('reports an override whose package resolves to nothing, without inventing a verdict', () => {
    const gate = checkOverrides({
      overrides: { 'ghost@<1.0.0': '>=0.9.0' },
      lockfileText: lockfileWith([['postcss', '8.5.23']]),
    });
    expect(gate.unresolved).toEqual(['ghost']);
    // Reported, not failed: a package outside this graph cannot be below a
    // threshold, and asserting otherwise would be asserting nothing.
    expect(gate.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The repository as it stands
// ---------------------------------------------------------------------------

describe('the repository as it stands', () => {
  const overrides = JSON.parse(REAL_OVERRIDES).pnpm.overrides;
  const gate = checkOverrides({ overrides, lockfileText: REAL_LOCKFILE });

  it('passes', () => {
    expect(gate.errors).toEqual([]);
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(gate.exitCode).toBe(0);
  });

  it('accounts for every version rewrite, enforced or inert', () => {
    // Every entry in the real table must land in exactly one of these lists, or
    // be one of the dependency overrides the gate skips on purpose. The total is
    // read from `package.json` rather than written here: the table shrinks (34
    // entries were removed on 2026-10-20) and a literal would turn every cleanup
    // into a red suite, which is how a guard teaches its reader to edit the
    // guard.
    const declared = Object.keys(JSON.parse(REAL_OVERRIDES).pnpm.overrides);
    const accounted = new Set([
      ...gate.enforced.map((e) => e.overrideKey),
      ...gate.inert.map((i) => i.overrideKey),
      ...gate.unresolvedOverrides.map((u) => u.overrideKey),
    ]);
    expect(accounted.size + gate.skippedDependencies.length).toBe(declared.length);
    expect(gate.skippedDependencies).toHaveLength(1);
  });

  it('judges every package the table still names', () => {
    // The 2026-10-20 cleanup removed 34 inert entries, including every
    // `next`, `postcss`, `js-yaml`, `vitest`, `drizzle-orm`, `source-map-js`
    // and `shell-quote` rewrite, so this list is what is left. It is asserted
    // against the real table on purpose: the gate must read the shapes that are
    // actually declared — scoped names, two exact pins and one dependency
    // override among them.
    const judged = new Set([...gate.enforced.map((e) => e.name), ...gate.inert.map((i) => i.name)]);
    for (const name of [
      'brace-expansion',
      'cookie',
      'esbuild',
      'fast-uri',
      'nanoid',
      'react',
      'react-dom',
      'sharp',
      'undici',
      'ws',
    ]) {
      expect(judged, `${name} was never judged`).toContain(name);
    }
  });

  it('enforces the exact pins, which are unconditional', () => {
    const pins = gate.enforced.filter((e) => e.rule === 'exact');
    expect(pins.map((p) => p.name).sort()).toEqual(['react', 'react-dom']);

    // Asserted against the declared pin, not a literal.
    //
    // What this test claims is that an exact pin resolves to exactly what it
    // declares. Hardcoding `19.2.7` asserted a second, different thing -- that
    // react happens to sit at some version today -- and the difference matters:
    // raising a security floor is the *intended* use of these two overrides, so a
    // literal turned every legitimate bump into a red suite. That is how a guard
    // starts teaching its reader to edit the guard.
    //
    // Reading the declaration keeps the teeth and drops the staleness. If either
    // pin stops being exact, `selector` stops being null; if a resolution drifts
    // off its pin, the comparison fails. Both are the failure this test exists to
    // catch, and neither is about a version number.
    for (const pin of pins) {
      const declared = overrides[pin.overrideKey];
      expect(declared, `${pin.name} has an enforced pin but declares no override`).toBeDefined();
      // No selector is what makes the pin unconditional.
      expect(pin.selector, `${pin.name} is pinned by a selector, so it is not unconditional`).toBeNull();
      expect(pin.resolved).toBe(declared);
    }
  });

  it('holds every resolution that lands inside a selector at or above that floor', () => {
    // Stated as the property, not as a count, so the next legitimate bump
    // cannot make it fail for a reason that has nothing to do with the gate.
    for (const finding of gate.enforced) {
      expect(
        finding.resolved === finding.required.replace(/^[<>=]+/, ''),
        `${finding.name} resolved ${finding.resolved} against ${finding.required}`,
      ).toBe(true);
    }
  });

  it('leaves `undici@7.30.0` alone, because its selectors are all 6.x or 8.x', () => {
    // The copy of undici that jsdom gets is pinned to the 7.x line by the
    // `jsdom>undici` override. Judged against the highest undici threshold in
    // the table (>=8.10.2) it would read as a violation, and the only fixes
    // available would be editing an advisory or editing a dependency version.
    // The 8.x advisories do not apply to a 7.x resolution, so it is not one.
    const undici = gate.enforced.filter((e) => e.name === 'undici');
    expect(undici).toEqual([]);
    expect(gate.violations.filter((v) => v.name === 'undici')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The written comparison is checked against the real semver
// ---------------------------------------------------------------------------

describe('semver is the oracle', () => {
  /**
   * The library, reached through the store rather than added as a dependency.
   *
   * This test only *checks* the comparison; the gate does not import semver. If
   * a future semver disagrees with the arithmetic here, this fails and the
   * arithmetic is what gets fixed — which is the direction that keeps a security
   * gate free of an unpinned dependency.
   */
  const loadSemver = () => {
    const require = createRequire(`${process.cwd()}/package.json`);
    const entry = require.resolve('semver', { paths: [require.resolve('vitest')] });
    return require(entry);
  };

  it('agrees with semver.satisfies on every selector in the real override table', () => {
    const semver = loadSemver();
    const overrides = JSON.parse(REAL_OVERRIDES).pnpm.overrides;
    const resolved = parseLockfilePackages(REAL_LOCKFILE);
    let compared = 0;

    for (const [key, value] of Object.entries(overrides)) {
      const parsed = classifyOverride(key, value);
      if (parsed.kind !== 'range') continue;
      for (const version of resolved.get(parsed.name) ?? []) {
        expect(
          satisfiesRange(parseVersion(version), parsed.selector),
          `${parsed.name}@${version} against ${key}`,
        ).toBe(semver.satisfies(version, parsed.selector));
        compared += 1;
      }
    }

    // If this is 0 the loop proved nothing, which is how a guard goes quiet.
    expect(compared).toBeGreaterThan(0);
  });

  it('agrees with semver.compareBuild on a spread of pairs, including prereleases', () => {
    const semver = loadSemver();
    const versions = [
      '0.0.1',
      '0.7.2',
      '1.1.18',
      '1.9.0',
      '1.10.0',
      '3.1.7',
      '4.0.0-beta.1',
      '4.0.0',
      '4.0.0-rc.2',
      '5.0.12',
      '8.5.23',
      '8.21.0',
      '1.0.0+build.1',
    ];
    for (const a of versions) {
      for (const b of versions) {
        const expected = Math.sign(semver.compareBuild(a, b));
        expect(
          Math.sign(compareVersions(parseVersion(a), parseVersion(b))),
          `${a} against ${b}`,
        ).toBe(expected);
      }
    }
  });
});

describe('formatInertList', () => {
  it('prints one line per entry with its key and, when present, its selector', () => {
    const text = formatInertList([
      { overrideKey: 'postcss@<=8.5.22', selector: 'postcss@<=8.5.22' },
      { overrideKey: 'react', selector: null },
    ]);

    expect(text.split('\n')).toEqual(['postcss@<=8.5.22\tpostcss@<=8.5.22', 'react']);
  });

  it('prints nothing for an empty list', () => {
    expect(formatInertList([])).toBe('');
  });
});