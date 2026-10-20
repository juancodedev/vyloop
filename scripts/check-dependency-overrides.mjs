// Dependency override gate.
//
// Fails when the dependency graph resolved in `pnpm-lock.yaml` contradicts a
// security override declared in the root `package.json`.
//
// Read-only, always. It opens no network connection, resolves nothing, writes
// nothing, and never runs `pnpm install`. The two files it reads are the same
// two files pnpm itself reads when it decides a resolution, which is the only
// reason it can say anything about the graph without installing it.
//
// Not part of the shipped test suite: an operational script kept out of `src` so
// it is neither linted nor typechecked as product code. Its test is run by the
// `Test operational scripts` step in `.github/workflows/ci.yml`, because
// `pnpm -r test` skips this repository's root and a test nothing runs reads as
// coverage in review and is not.
//
// ---------------------------------------------------------------------------
// The gap this closes
// ---------------------------------------------------------------------------
//
// `pnpm.overrides` in the root `package.json` carries 46 entries, 45 of which
// were added in response to a security advisory. Nothing asserted that the graph
// actually respected them. A lockfile regenerated against a changed registry, a
// newly added pin, or a bad resolution could put a version back below an
// advisory floor and every existing check would stay green.
//
// This repository has shipped a value nothing consumed before: the rate limiter
// keyed on `jwt.role` against a table of plan names, so no authenticated request
// resolved its own bucket and every one fell through to a default. The shape is
// the same — a declaration and nothing that reads it back.
//
// The threshold is already written in the override, on the right-hand side of
// `postcss@<=8.5.22: ">=8.5.23"`. No advisory database is consulted, and none
// can drift out of date, because the thing being enforced is the file that
// declares the requirement.
//
// ---------------------------------------------------------------------------
// Inert is not the violation
// ---------------------------------------------------------------------------
//
// As of this commit all 45 version rewrites and pins are inert: every resolution
// in the lockfile has already moved past every selector that could constrain it.
// That is the normal, healthy state. An override whose selector no longer
// contains any resolution does nothing, and a gate that reported it as a finding
// would have asked for 45 removals on day one, would re-fire after the next
// `postcss` bump, and would be switched off within a month — which is how a gate
// stops being one.
//
// **Inert is not the violation; below-threshold is.** A violation is exactly one
// thing: a resolution that falls *inside* an override's selector range while
// sitting *below* the floor that same override names. Nothing else in this file
// is a finding.
//
// ---------------------------------------------------------------------------
// How a requirement is derived — why this is not "the highest override"
// ---------------------------------------------------------------------------
//
// A pnpm override is conditional. `undici@>=8.0.0 <8.10.2: ">=8.10.2"` means:
// *if a resolution of undici falls in `>=8.0.0 <8.10.2`, rewrite it to at least
// 8.10.2*. It says nothing about undici 7.30.0, which is outside the selector and
// is never rewritten. So the requirement is scoped to the resolutions its own
// selector selects, and among those the **highest** floor wins.
//
// Scoping matters, and the repository's own lockfile is the proof. `undici`
// resolves at both 7.30.0 and 8.11.2, and the highest undici floor in the table
// is `>=8.10.2`. Read as a per-package maximum — every undici resolution must
// be at or above 8.10.2 — the 7.30.0 copy fails. That copy is jsdom's, pinned to
// the 7.x line on purpose by the `jsdom>undici` dependency override, and the
// 8.x-line advisories do not apply to a 7.x resolution. A gate that flagged it
// could only be satisfied by editing an advisory or editing a dependency version,
// neither of which is in this repository's gift. And every other rewrite in the
// table is inert for the same reason: pnpm has already applied them all.
//
// The "highest wins" rule still bites, within the selector that selects. Given
// `fixture@<2.0.0: ">=1.0.0"`, `fixture@<1.5.0: ">=1.1.0"` and
// `fixture@<2.0.0 <3.0.0: ">=1.4.0"`, a resolution of 1.2.5 matches all three and
// is held to 1.4.0 — not to the first, and not to whichever was written last.
//
// ---------------------------------------------------------------------------
// The three override shapes
// ---------------------------------------------------------------------------
//
// 1. **Version rewrite** — `postcss@<=8.5.22: ">=8.5.23"`. The package's own
//    version, conditional on the selector. This is the case the gate exists for.
//
// 2. **Exact pin** — `react: "19.2.7"`. No selector, so it applies
//    unconditionally and can never be inert; pnpm will not resolve any other
//    version. Compared for equality, because an exact pin means an exact
//    version: 19.3.0 is a violation of a pin to 19.2.7 as surely as 19.2.6 is.
//    (There are two in this repository and neither has ever needed defending —
//    still, "cannot be inert" is a reason to check, not a reason to skip.)
//
// 3. **Dependency override** — `jsdom>undici: "^7.25.0"`. This rewrites the
//    copy of undici that jsdom resolves, not undici's own version. It is out of
//    scope and is reported as skipped, never as a threshold. Reading `^7.25.0` as
//    a floor would be reading a caret range as a version, and reading the key's
//    left side as a package name would invent a requirement against jsdom.
//
// ---------------------------------------------------------------------------
// What this gate deliberately does NOT catch
// ---------------------------------------------------------------------------
//
// Three open dependency PRs in this repository move packages *past* these
// thresholds — `postcss`, `nanoid` and `undici` among them — and they will pass
// this gate unchanged, because moving up is not a violation and this file says so
// above. What changes when they land is that the corresponding overrides stop
// being load-bearing, which is housekeeping rather than risk.
//
// A second, separate check for that would be defensible: report overrides whose
// selector no longer selects any resolution, so a human can decide whether to
// delete them. It is deliberately NOT built here, for the reason in "inert is not
// the violation" — such a report is noise on day one and a deletion prompt on
// every bump. It is worth having as an informational report nobody gates on, if
// the override table is ever cleaned up.
//
// Also not caught, and not claimed to be: a *new* advisory that nobody has added
// an override for yet. This gate enforces the overrides that exist; it is not an
// advisory scanner and does not pretend to be one. That is `pnpm audit`'s job,
// and the two answer different questions.
//
// ---------------------------------------------------------------------------
// Failure is the only failure
// ---------------------------------------------------------------------------
//
// There is no third state and no `unknown`. An unreadable lockfile, a missing
// `pnpm.overrides`, an empty override table, an override this file cannot
// evaluate — all of them exit 1. A gate that could report "I could not check" is
// a gate that passes whenever the check is inconvenient, which is to say it
// passes whenever it is most convenient to pass. The counter to that pressure is
// the same one the migration drift gate uses: if this blocks, the fix is to make
// the check work, not to make it quieter.
//
// The vacuity guards are the load-bearing part of that. An override table that
// parses to nothing satisfies every requirement by finding nothing to compare, and
// would report green forever while asserting nothing at all.

import { readFileSync } from 'node:fs';

export const PACKAGE_JSON_PATH = 'package.json';
export const LOCKFILE_PATH = 'pnpm-lock.yaml';

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------
//
// Written here rather than imported. `semver` is in the store, but it is not a
// declared dependency of this repository and does not resolve from the root;
// reaching it means relying on a hoisting accident that a future install can
// change. Adding a dependency to a security gate is its own supply-chain risk,
// and a *pinned* one at that. `packages/db/src/migration-sql.test.ts` hand-writes
// its version comparison for the same reason, and the test file checks this
// arithmetic against the real `semver` on every selector in the real table — so
// the oracle exists, it just does not become a runtime dependency.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * A version as its comparable parts, or `null` for text that is not one.
 *
 * `null` rather than a thrown error at the call sites, so callers can decide
 * whether unreadable input is fatal — and everywhere it is, it is.
 */
export function parseVersion(text) {
  const match = VERSION.exec(String(text ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
    build: match[5] ?? '',
  };
}

/**
 * Order two parsed versions: -1, 0 or 1.
 *
 * Numeric fields first, numerically. `1.10.0` is above `1.9.0`; a lexical
 * comparison says otherwise and would clear a real advisory.
 *
 * Then prerelease identifiers, per semver: a version with no prerelease outranks
 * one that has it, and among prereleases the identifiers are compared left to
 * right, numerically where both are numeric and lexically otherwise, with a
 * numeric identifier outranking an alphanumeric one.
 *
 * Build metadata is read and never compared, because semver does not order it.
 * `@cloudflare/workerd-*` resolves with build metadata in this repository.
 *
 * Throws rather than returning `undefined` for a version it could not parse. A
 * comparison that quietly orders malformed input produces a confident wrong
 * answer from unreadable data, which is the exact failure this gate exists to
 * catch.
 */
export function compareVersions(a, b) {
  if (!a || !b) {
    throw new Error(`cannot compare unparsed versions: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }

  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }

  if (a.prerelease === b.prerelease) return 0;
  // A release outranks its own prereleases.
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;

  const left = a.prerelease.split('.');
  const right = b.prerelease.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    // A numeric identifier always has lower precedence than an alphanumeric one.
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }

  return 0;
}

const COMPARATOR = /^(<=|>=|<|>|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/**
 * Whether `version` satisfies one comparator: `>=8.5.23`, `<=8.5.22`, `<8.10.2`,
 * `8.5.23` (equality), or `*` (anything).
 *
 * A bare upper bound is strict. That is what `<8.21.0` means, and it is load-
 * bearing here: `ws` resolves at exactly 8.21.0 against the selector
 * `ws@>=8.0.0 <8.21.0`, and reading it inclusively would make the override appear
 * to apply to a version it cannot rewrite and demand a version above itself.
 *
 * Throws on a comparator it does not understand. Skipping one would mean a
 * selector silently constraining nothing.
 */
export function satisfiesComparator(version, comparator) {
  const text = String(comparator ?? '').trim();
  if (text === '' || text === '*' || text === 'x') return true;

  const match = COMPARATOR.exec(text);
  if (!match) throw new Error(`Unsupported semver comparator: ${JSON.stringify(comparator)}`);

  const target = parseVersion(match[2]);
  if (!target) throw new Error(`Unsupported semver comparator: ${JSON.stringify(comparator)}`);

  const order = compareVersions(version, target);
  switch (match[1] ?? '=') {
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '<':
      return order < 0;
    default:
      return order === 0;
  }
}

/**
 * Whether `version` satisfies a selector: several space-separated comparators,
 * all of which must hold.
 *
 * `>=8.0.0 <8.10.2` is the shape the whole advisory table uses.
 */
export function satisfiesRange(version, comparator) {
  if (!version) throw new Error('satisfiesRange was given an unparsed version');
  return String(comparator)
    .trim()
    .split(/\s+/)
    .filter((term) => term !== '')
    .every((term) => satisfiesComparator(version, term));
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * The rewrite value read as a requirement, or `null` when it constrains nothing.
 *
 * Split into an operator and a bare version rather than left as one string, so
 * the comparison reads the version it was given instead of re-parsing it out of
 * its own rendering — which is how `floor.slice(1)` on `>=1.5.0` produces
 * `=1.5.0` and a null version.
 */
function readRequirement(value) {
  const text = String(value ?? '').trim();
  if (text === '*' || text === '') return null;
  if (/^[\^~]/.test(text)) {
    throw new Error(
      `Unsupported override value ${JSON.stringify(value)}: a caret or tilde range is not a ` +
        `floor, so there is nothing to hold a resolved version to.`,
    );
  }

  if (/^\d/.test(text)) {
    const version = parseVersion(text);
    if (!version) throw new Error(`Unsupported override value ${JSON.stringify(value)}`);
    // An exact pin is equality, whatever its value looks like: `react: "19.2.7"`
    // is unconditional, so it must hold exactly — and a version *below* a pin is
    // as much a violation as one above it.
    return { operator: '=', version: text, text: `=${text}` };
  }

  if (/^[<>=]/.test(text)) {
    // Validated here rather than at the selector, so an unreadable rewrite value
    // is reported against the override that carries it.
    const match = /^([<>=]+)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(text);
    if (!match) {
      throw new Error(
        `Unsupported override value ${JSON.stringify(value)}: expected a comparator such as ` +
          `">=8.5.23"`,
      );
    }
    satisfiesComparator(parseVersion('0.0.0'), text);
    return { operator: match[1], version: match[2], text };
  }

  throw new Error(`Unsupported override value ${JSON.stringify(value)}`);
}

/**
 * The `>` that separates the two sides of a dependency override.
 *
 * Not simply `indexOf('>')`: `undici@>=8.0.0 <8.9.0` contains a `>` that is part
 * of `>=` and means nothing of the sort. A separator is a `>` whose neighbours are
 * neither part of a comparator.
 */
function findDependencySeparator(key) {
  for (let i = 1; i < key.length - 1; i += 1) {
    if (key[i] !== '>') continue;
    const before = key[i - 1];
    const after = key[i + 1];
    if ('<>='.includes(before)) continue;
    if (after === '=') continue;
    return i;
  }
  return -1;
}

/** Read one override key, reporting anything unreadable against the key itself. */
function readOverrideKey(key, value) {
  const separator = findDependencySeparator(key);
  if (separator !== -1) {
    return {
      kind: 'dependency',
      parent: key.slice(0, separator),
      name: key.slice(separator + 1),
      selector: null,
      value: String(value),
      key,
    };
  }

  const at = key.lastIndexOf('@');
  const hasSelector = at > 0;
  const name = hasSelector ? key.slice(0, at) : key;
  const selector = hasSelector ? key.slice(at + 1) : null;

  // Validated through `satisfiesRange`, not `satisfiesComparator`: a selector is
  // space-separated (`>=8.0.0 <8.10.2`) and every term in it has to be readable
  // or the override silently constrains less than it appears to.
  if (hasSelector) satisfiesRange(parseVersion('0.0.0'), selector);

  const requirement = readRequirement(value);
  const kind = hasSelector ? 'range' : 'exact';

  return {
    kind,
    name,
    selector,
    value: String(value),
    threshold: requirement?.text ?? null,
    operator: requirement?.operator ?? null,
    thresholdVersion: requirement?.version ?? null,
    key,
  };
}

/**
 * Split an override key into its three possible shapes.
 *
 * The `name`/selector split is on the **last** `@` at an index greater than zero,
 * which is what keeps `@vitest/mocker` from being read as the package
 * `/mocker` with a selector of `@vitest/mocker`.
 *
 * Errors carry the key, because an error naming `Unsupported semver comparator:
 * "^1.0.0"` tells the reader nothing about which of 46 overrides to go and look
 * at.
 */
export function classifyOverride(key, value) {
  try {
    return readOverrideKey(key, value);
  } catch (error) {
    throw new Error(`${key}: ${error.message}`);
  }
}

/**
 * The override table, split into what the gate judges and what it does not.
 *
 * An override this file cannot read is an *error*, not a skip. `extractAssertions`
 * in the drift gate refuses a `DROP` for the same reason: a requirement that
 * cannot be evaluated must be visible, because otherwise the table can grow
 * without this gate knowing it stopped covering something.
 */
export function readOverrideTable(overrides) {
  const requirements = [];
  const skipped = [];
  const errors = [];

  if (overrides === undefined || overrides === null || typeof overrides !== 'object') {
    return {
      requirements,
      skipped,
      errors: ['package.json has no `pnpm.overrides` object, so there is nothing to enforce'],
    };
  }

  for (const [key, value] of Object.entries(overrides)) {
    let parsed;
    try {
      parsed = classifyOverride(key, value);
    } catch (error) {
      errors.push(`${key}: ${error.message}`);
      continue;
    }
    if (parsed.kind === 'dependency') {
      skipped.push({ key, parent: parsed.parent, name: parsed.name, value: parsed.value });
    } else {
      requirements.push(parsed);
    }
  }

  return { requirements, skipped, errors };
}

// ---------------------------------------------------------------------------
// The lockfile
// ---------------------------------------------------------------------------

/**
 * Every package and every version the lockfile resolves, keyed by package name.
 *
 * Read from the `packages:` block only, and only from keys at exactly two
 * spaces of indentation. Both restrictions are earned:
 *
 * - the `overrides:` block is *also* a list of `name@range` keys and would read
 *   as 46 more "packages" if it were not excluded;
 * - the `snapshots:` block is a list of the same keys with peer suffixes
 *   appended (`react-dom@19.2.7(react@19.2.7)`), so a version parsed from it
 *   would not compare equal to `19.2.7`;
 * - a key indented deeper is a field of a package, not a package. `ws`'s
 *   `peerDependenciesMeta` holds `bufferutil:` at six spaces, and a parser
 *   anchoring on "two spaces, then a non-space" reads it as a package called
 *   `bufferuti`. Anchoring the whole indent is what stops that.
 *
 * A `Map` of `Set`s rather than a flat list, because a package can resolve at
 * several versions and every one of them is a separate resolution to judge.
 * `postcss`, `nanoid`, `esbuild`, `cookie` and `undici` all do.
 */
export function parseLockfilePackages(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => line === 'packages:');
  if (start === -1) {
    throw new Error('pnpm-lock.yaml has no `packages:` section, so nothing could be resolved');
  }

  const resolved = new Map();
  let entries = 0;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // Anything flush to the left ends the block — which is how the loop stops at
    // `snapshots:` instead of reading the peer-suffixed keys below it.
    if (line.trim() !== '' && !line.startsWith('  ')) break;

    // Exactly two spaces, then a non-space, then a key, then `:` at end of line.
    const match = /^ {2}(\S.*?):\s*$/.exec(line);
    if (!match) continue;
    // A key with a body is a package; a nested field never is.
    if (!/^ {4}\S/.test(lines[i + 1] ?? '')) continue;

    const key = match[1].replace(/^'(.*)'$/, '$1');
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;

    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!parseVersion(version)) continue;

    if (!resolved.has(name)) resolved.set(name, new Set());
    resolved.get(name).add(version);
    entries += 1;
  }

  if (entries === 0) {
    throw new Error('pnpm-lock.yaml has a `packages:` section but resolved nothing from it');
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * The resolutions of `name` that `requirement`'s own selector selects.
 *
 * Empty means the override is inert, which is a fact about the graph and not a
 * finding — see the header.
 */
function selectedResolutions(requirement, resolved) {
  return resolved.filter((version) => satisfiesRange(parseVersion(version), requirement.selector));
}

/**
 * Decide whether the resolved graph respects the declared overrides.
 *
 * Takes the two file bodies as arguments rather than opening them, so every
 * branch below — including the unreadable ones — is reachable from a test with no
 * repository anywhere near it.
 */
export function checkOverrides({ overrides, lockfileText } = {}) {
  const table = readOverrideTable(overrides);
  const errors = [...table.errors];

  let resolved = new Map();
  try {
    resolved = parseLockfilePackages(lockfileText);
  } catch (error) {
    errors.push(error.message);
  }

  // The vacuity guards, before anything else. An empty table with a readable
  // lockfile satisfies every requirement by having none, and would report green
  // forever while asserting nothing.
  if (Object.keys(overrides ?? {}).length === 0) {
    errors.push('`pnpm.overrides` is empty, so this run would assert nothing');
  }

  const violations = [];
  const enforced = [];
  const inert = [];
  const unresolved = [];
  const unresolvedOverrides = [];

  for (const requirement of table.requirements) {
    const versions = [...(resolved.get(requirement.name) ?? [])].sort();

    if (versions.length === 0) {
      // Reported, never failed. A package outside this graph cannot be below a
      // threshold; asserting otherwise would be asserting nothing, and failing on
      // it would break the moment a platform-specific package drops out.
      unresolved.push(requirement.name);
      unresolvedOverrides.push({ name: requirement.name, overrideKey: requirement.key });
      continue;
    }

    if (requirement.kind === 'exact') {
      const pin = requirement.thresholdVersion;
      for (const version of versions) {
        const finding = {
          name: requirement.name,
          resolved: version,
          required: requirement.threshold,
          overrideKey: requirement.key,
          selector: null,
          rule: 'exact',
          message:
            `${requirement.name} is pinned to ${pin} but resolves at ${version}. ` +
            `An exact pin applies unconditionally, so any other resolution contradicts it.`,
        };
        // An exact pin cannot be inert: it selects every version.
        enforced.push(finding);
        if (version !== pin) violations.push(finding);
      }
      continue;
    }

    // A rewrite whose selector selects nothing constrains nothing. Recorded as
    // inert, which is a fact about the graph and not a finding — see the header.
    const candidates = selectedResolutions(requirement, versions);
    if (candidates.length === 0) {
      inert.push({ name: requirement.name, overrideKey: requirement.key, selector: requirement.selector });
      continue;
    }

    for (const version of candidates) {
      const ordered = compareVersions(
        parseVersion(version),
        parseVersion(requirement.thresholdVersion),
      );
      const finding = {
        name: requirement.name,
        resolved: version,
        required: requirement.threshold,
        overrideKey: requirement.key,
        selector: requirement.selector,
        rule: 'minimum',
        message:
          `${requirement.name} resolves at ${version}, which is inside the override's selector ` +
          `"${requirement.selector}" but below the ${requirement.threshold} it requires. ` +
          `Declared as "${requirement.key}": "${requirement.value}" in the root package.json.`,
      };
      enforced.push(finding);
      // `>=`, not `>`: a resolution exactly at the advisory floor is the fix, not
      // a failure. `postcss` at 8.5.23, `drizzle-orm` at 0.45.2, `source-map-js`
      // at 1.2.2, `js-yaml` at 4.3.2 and `vitest` at 4.1.11 all sit exactly there.
      if (ordered < 0) violations.push(finding);
    }
  }

  const findings = [];
  if (errors.length > 0) findings.push('the check could not be carried out');
  if (violations.length > 0) {
    findings.push(
      `${violations.length} resolution(s) below the threshold an override requires`,
    );
  }

  return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    blockedReason: findings.length === 0 ? null : `Dependencies blocked: ${findings.join(', ')}.`,
    errors,
    violations,
    enforced,
    inert,
    unresolved,
    unresolvedOverrides,
    skippedDependencies: table.skipped,
    packagesChecked: new Set(enforced.map((e) => e.name)).size,
  };
}

/**
 * The report.
 *
 * A red build that says only "dependency check failed" is the version of this
 * gate that would get deleted, so every violation names the package, the
 * threshold, the resolved version and the override line the threshold came from:
 * the four things the reader needs to look up the advisory.
 */
export function formatReport(gate) {
  const lines = ['', '  Vyloop dependency override gate', '  ' + '-'.repeat(60)];

  if (gate.errors.length > 0) {
    lines.push('  [FAIL] the check could not be carried out');
    lines.push('         A gate that cannot see the graph cannot say the graph is safe:');
    for (const error of gate.errors) lines.push(`    - ${error}`);
    lines.push('  ' + '-'.repeat(60));
    lines.push('  BLOCKED — nothing was verified.');
    lines.push('');
    return lines.join('\n');
  }

  if (gate.ok) {
    lines.push('  [PASS] every resolution respects the security overrides it falls under');
    lines.push(
      `         ${gate.enforced.length} requirement(s) enforced across ${gate.packagesChecked} package(s).`,
    );
    lines.push(
      `         ${gate.inert.length} override(s) are inert: their selectors no longer select a resolution.`,
    );
    lines.push('         Inert is not a violation — an override that no longer applies is not a finding.');
    lines.push(`         ${gate.skippedDependencies.length} dependency override(s) skipped (out of scope).`);
    lines.push('  ' + '-'.repeat(60));
    lines.push('  PASS.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  [FAIL] ${gate.blockedReason}`);
  lines.push('');
  lines.push('  below the threshold a security override requires:');
  for (const violation of gate.violations) {
    lines.push(`    - ${violation.name}: ${violation.message}`);
  }
  lines.push('');
  lines.push('    Each line names the package, the floor and the override that declares it, so the');
  lines.push('    advisory can be looked up without reading package.json first.');
  lines.push('');
  if (gate.inert.length > 0) {
    lines.push(
      `  note: ${gate.inert.length} override(s) are inert and are not counted as findings.`,
    );
  }
  if (gate.unresolved.length > 0) {
    lines.push(
      `  note: ${gate.unresolved.length} overridden package(s) resolve nowhere in this graph: ${gate.unresolved.join(', ')}.`,
    );
  }
  lines.push('  ' + '-'.repeat(60));
  lines.push('  BLOCKED — the graph contradicts an override it declares.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------

/**
 * `pnpm.overrides` from a package.json body, or `undefined` when it is absent.
 *
 * `undefined` rather than `{}` on purpose: an absent table and an empty one are
 * the same finding, and both are a failure, so the distinction is not one any
 * caller needs.
 */
export function readOverrides(packageJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error.message}`);
  }
  return parsed?.pnpm?.overrides;
}

/**
 * The `--list-inert` output: one entry per line, `overrideKey` and, when it has
 * one, the selector. The exit code is the gate's, so a caller can list the
 * candidates and still fail the build for the real violations.
 */
export function formatInertList(inert) {
  return inert
    .map(({ overrideKey, selector }) => (selector ? `${overrideKey}\t${selector}` : overrideKey))
    .join('\n');
}

/** A flag's value, or the default. Enough for the two paths this gate needs. */
function flagValue(argv, flag, fallback) {
  const at = argv.indexOf(flag);
  if (at === -1 || argv[at + 1] === undefined) return fallback;
  return argv[at + 1];
}

/**
 * `--package-json` and `--lockfile` exist so the gate can be pointed at a copy.
 *
 * That is not a convenience: it is how the gate is shown to be load-bearing
 * without editing the repository's lockfile to make a point. Defaults are the
 * repository's own files.
 */
export async function main(argv = []) {
  const packageJsonPath = flagValue(argv, '--package-json', PACKAGE_JSON_PATH);
  const lockfilePath = flagValue(argv, '--lockfile', LOCKFILE_PATH);

  let overrides;
  let lockfileText;
  try {
    overrides = readOverrides(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    overrides = undefined;
    lockfileText = null;
    process.stdout.write(
      `\n  Vyloop dependency override gate\n  ${'-'.repeat(60)}\n` +
        `  [FAIL] could not read ${packageJsonPath}: ${error.message}\n` +
        `  ${'-'.repeat(60)}\n  BLOCKED — nothing was verified.\n\n`,
    );
    return 1;
  }

  try {
    lockfileText = readFileSync(lockfilePath, 'utf8');
  } catch (error) {
    process.stdout.write(
      `\n  Vyloop dependency override gate\n  ${'-'.repeat(60)}\n` +
        `  [FAIL] could not read ${lockfilePath}: ${error.message}\n` +
        `  ${'-'.repeat(60)}\n  BLOCKED — nothing was verified.\n\n`,
    );
    return 1;
  }

  const gate = checkOverrides({ overrides, lockfileText });

  // `--list-inert` is a report, not a second mode: the exit code stays the
  // gate's. It exists so the one-off cleanup can name its candidates without
  // parsing the human report.
  if (argv.includes('--list-inert')) {
    process.stdout.write(`${formatInertList(gate.inert)}\n`);
    return gate.exitCode;
  }

  process.stdout.write(formatReport(gate));
  process.stdout.write(`  read overrides from ${packageJsonPath}\n`);
  process.stdout.write(`  read resolutions from ${lockfilePath}\n\n`);
  return gate.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error('dependency override gate failed:', error);
      process.exitCode = 1;
    });
}