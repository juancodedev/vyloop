// @vitest-environment node

/**
 * Cross-cutting hygiene, across every route at once.
 *
 * Each rule here is a mistake that has no visible symptom: a page still looks
 * right, so nothing else in the suite would notice. They are collected in one
 * place because that is where a reviewer looks for them, and because the value
 * of each one is that the next component cannot quietly reintroduce it.
 *
 * The behavioural suites assert what a customer can see and do. This file
 * asserts the absences, and the few places where a correct decision is
 * recorded so it is not mistaken for an oversight.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appDir = new URL('./', import.meta.url).pathname;

/** Every `.ts`/`.tsx` under `app/`, so the checks follow new components. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (!entry.includes('.')) return sourceFiles(path);

    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const sources = sourceFiles(appDir)
  .map((file) => ({ file: file.slice(appDir.length), source: readFileSync(file, 'utf8') }))
  // Test files assert on these patterns on purpose; a guard that matched its own
  // fixtures would be a guard that could never fail.
  .filter(({ file }) => !file.includes('.test.'));

/** The tag each `aria-hidden` is attached to, across the whole app. */
function ariaHiddenTags(): string[] {
  const tags: string[] = [];

  for (const { source } of sources) {
    for (const match of source.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*aria-hidden/g)) {
      tags.push(match[1]);
    }
  }

  return tags;
}

describe('no route hard-codes a value that belongs to a token', () => {
  it('uses no inline style anywhere', () => {
    // The last one was `/confirm`: `style={{ fontSize: 48, marginBottom: 16 }}`,
    // `style={{ display: 'block' }}` and `style={{ textAlign: 'center' }}`. An
    // inline style renders exactly like a token and cannot be reached by the
    // media queries that make the page fit 320px.
    const offenders = sources
      .filter(({ source }) => /style=\{\{/.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('keeps the viewport free of anything that would block zoom', () => {
    // Zoom has to stay available. Reflow is the answer to a narrow screen, not
    // a lock on the pinch.
    const layout = readFileSync(join(appDir, 'layout.tsx'), 'utf8');

    expect(layout).not.toMatch(/maximumScale/);
    expect(layout).not.toMatch(/userScalable/);
    expect(layout).not.toMatch(/maximum-scale/);
    expect(layout).not.toMatch(/user-scalable/);
    // And it must not depend on `100vh`, which is taller than the visible area
    // on a mobile browser and hides the bottom of the page behind its own UI.
    const globals = readFileSync(join(appDir, 'globals.css'), 'utf8');

    expect(globals).not.toMatch(/[^-]100vh/);
  });
});

describe('keyboard reach', () => {
  it('never takes an element out of the natural tab order', () => {
    // A positive `tabindex` reorders the whole page relative to what is on
    // screen, which is the one way a visually correct layout becomes
    // unusable with a keyboard. The single `-1` below is a focus *target*, not
    // a stop: the redeem outcome is focused programmatically once it exists.
    const offenders = sources
      .filter(({ source }) => /tabIndex=\{(?!-1)/.test(source) || /tabindex="[1-9]/.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);

    const target = sources.filter(({ source }) => /tabIndex=\{-1\}/.test(source));

    // Exactly one, and it is the redeem outcome.
    expect(target.map(({ file }) => file)).toEqual(['profile/rewards/confirm/page.tsx']);
  });

  it('never hides a focusable element from assistive technology', () => {
    // `aria-hidden` on something Tab can reach produces focus on an element the
    // screen reader will not describe: focus lands nowhere the user can read.
    const reachable = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);

    const offenders = ariaHiddenTags().filter((tag) => reachable.has(tag));

    expect(offenders).toEqual([]);
  });

  it('uses `aria-hidden` for decoration, which is what it is for', () => {
    // The other direction: the decorative glyphs — arrows, spinners, the QR
    // success mark, the required-field asterisk — all carry it, so none of them
    // is read out as a stray character.
    const hidden = ariaHiddenTags();

    expect(hidden.length).toBeGreaterThan(10);
    expect(new Set(hidden)).toEqual(
      new Set([
        'div',
        'span',
        'p',
        'ArrowRight',
        'Clock',
        'Gift',
        'QrCode',
        'ChevronUp',
        'ChevronDown',
        'Icon',
      ]),
    );
  });

  it('never focuses on load', () => {
    // Forcing focus on mount opens the virtual keyboard over the form before
    // the customer has asked for it, on a phone. The two `.focus()` calls in
    // the app are both guarded by a flag that only a validation failure sets,
    // and the contract suites for login and register pin their absence.
    const offenders = sources.filter(({ source }) => /autoFocus/.test(source));

    expect(offenders).toEqual([]);
  });
});

describe('images', () => {
  it('gives every image an alt attribute, empty or not', () => {
    // An image with no `alt` at all is announced by some screen readers as its
    // own filename, which is worse than saying nothing.
    //
    // Anchored to the start of a line, because this codebase's own comments
    // mention `<img>` in prose — `member-qr.tsx` opens with a comment about the
    // element — and a tag scan that reads comments would report markup that is
    // not there. JSX tags are always on their own line here.
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      for (const match of source.matchAll(/\n\s*<img\b[^>]*>/g)) {
        if (!/\balt=/.test(match[0])) offenders.push(`${file}: ${match[0].trim().slice(0, 60)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('sizes the one image that can arrive at an unknown size', () => {
    // The QR carries `width` and `height` because it is a real `<img>` whose
    // intrinsic size is known but whose decode is not instant; without them the
    // page jumps as the code appears.
    const qr = readFileSync(join(appDir, 'components/member-qr.tsx'), 'utf8');

    expect(qr).toMatch(/width=\{QR_SIZE\}/);
    expect(qr).toMatch(/height=\{QR_SIZE\}/);
    // And it says what it is, rather than being skipped: the customer's name and
    // the id the code carries are both useful at the counter.
    expect(qr).toMatch(/alt=\{`Código QR de \$\{fullName\}/);
  });

  it('fixes the reward image in a box instead, because its size is the merchant’s', () => {
    // The catalog image is arbitrary and remote, so there is no honest
    // `width`/`height` to put on it — any pair would be a guess, and CSS
    // overrides them anyway. What is honest is a wrapper with a fixed height and
    // `overflow: hidden` around an `object-fit: cover` image: the box is decided
    // before the request is made, so a slow or broken image moves nothing.
    const card = readFileSync(join(appDir, 'components/reward-card.tsx'), 'utf8');

    expect(card).toMatch(/reward-card__image-wrap/);

    const globals = readFileSync(join(appDir, 'globals.css'), 'utf8');
    const wrap = /\.reward-card__image-wrap\s*\{([\s\S]*?)\}/.exec(globals)?.[1] ?? '';

    expect(wrap).toMatch(/height:\s*140px/);
    expect(wrap).toMatch(/overflow:\s*hidden/);
    expect(wrap).toMatch(/width:\s*100%/);

    // Decorative on purpose: the card already states the reward's name and
    // description in text, so a description of the photograph would be a third
    // statement of the same thing. `alt=""` is the decision, not an oversight —
    // and if the image 404s, the card is still complete.
    expect(card).toMatch(/<img src=\{reward\.imageUrl\} alt=""/);
  });
});
