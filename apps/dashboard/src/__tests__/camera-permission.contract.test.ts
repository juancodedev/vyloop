// @vitest-environment node

/**
 * The POS scanner asks for the camera, and says which failure it hit.
 *
 * ## The bug this exists to prevent
 *
 * Pressing "📷 Escanear QR" opened the modal and closed it again, with nothing
 * on screen. Nothing ever called `getUserMedia`, so the browser never showed a
 * permission dialog, `html5-qrcode` could not start, and the rejection was
 * swallowed by a `catch` that called `setShowScanner(false)` — closing the
 * modal and discarding the only evidence at the same time.
 *
 * A swallowed diagnostic is the expensive kind of failure: the screen says
 * nothing, so the next person starts from zero. That is why the assertions here
 * are about what the page *does not* do as much as what it does.
 *
 * ## Why there is a module and not a regex in the page
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs
 * in `node` and nothing renders. Same split as `lib/lookup-identifier.ts` and
 * `lib/pass-state.ts`: the decision is testable, the rendering is not.
 *
 * `requestCameraAccess` is tested by running it. It reads `navigator` and
 * `window` off the globals at call time and touches neither at import time, so
 * `vi.stubGlobal` can stand in for a browser and the calls can be counted --
 * which is the difference between proving the permission is requested and
 * reading a file that says it is.
 */

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CameraAccessError,
  classifyCameraError,
  presentCameraFailure,
  requestCameraAccess,
  type CameraFailure,
} from '../lib/camera-permission';

const posSource = readFileSync(
  new URL('../app/dashboard/loyalty/pos/page.tsx', import.meta.url).pathname,
  'utf8',
);

/** `startScanner` through to `stopScanner`, so a failure handler is in scope. */
function startScannerSource(): string {
  const start = posSource.indexOf('const startScanner = useCallback(');
  const end = posSource.indexOf('const stopScanner = useCallback(');
  // Guard against a slice that is empty or inverted: every assertion below is
  // satisfied by an empty string, so a moved function would report "clean".
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return posSource.slice(start, end);
}

/**
 * The bodies of every `catch` in `source`, found by matching braces.
 *
 * Scoping to `catch` blocks is the whole point. The decoder callback closes the
 * modal on purpose -- a code was read and there is nothing left to scan -- so an
 * assertion over the whole function would either flag correct behaviour or have
 * to be weakened until it proved nothing.
 */
function catchBlocks(source: string): string[] {
  const blocks: string[] = [];

  for (const match of source.matchAll(/\bcatch\b[^{]*\{/g)) {
    let depth = 0;
    let i = match.index + match[0].length - 1;

    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }

    blocks.push(source.slice(match.index, i + 1));
  }

  return blocks;
}

/** A `DOMException`-alike: the media layer rejects with a *named* error. */
function mediaError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

/** A stand-in for the stream `getUserMedia` resolves with. */
function fakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { stream: { getTracks: () => tracks }, tracks };
}

/** A browser that grants the camera. */
function grantCamera() {
  const { stream, tracks } = fakeStream();
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('window', { isSecureContext: true });
  return { getUserMedia, tracks };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requesting the camera', () => {
  it('calls getUserMedia for the rear camera', async () => {
    const { getUserMedia } = grantCamera();

    await requestCameraAccess();

    // Without the constraint the browser hands over a selfie camera on a laptop
    // and a cashier is then filming their own face at the counter.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'environment' },
    });
  });

  it('releases the stream it opened', async () => {
    // `html5-qrcode` opens a second stream. On several devices a second
    // `getUserMedia` while the first is live fails with `NotReadableError`, so
    // holding ours would make the cashier the cause of the "camera busy" they
    // are then asked to go and fix.
    const { tracks } = grantCamera();

    await requestCameraAccess();

    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('reports an absent camera API as its own failure', async () => {
    // No `getUserMedia` is what an old browser looks like, and it is not a
    // refusal: telling someone to unblock a permission that was never asked for
    // wastes their time at the counter.
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { isSecureContext: true });

    await expect(requestCameraAccess()).rejects.toBeInstanceOf(CameraAccessError);
    await expect(requestCameraAccess()).rejects.toMatchObject({
      failure: 'unsupported',
    });
  });

  it('reports an insecure origin before blaming the camera', async () => {
    // On http the API is withheld by the browser regardless of hardware. The
    // refusal-shaped message would be a diagnosis of the wrong thing.
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal('window', { isSecureContext: false });

    await expect(requestCameraAccess()).rejects.toMatchObject({
      failure: 'insecure_context',
    });
  });

  it('lets the browser refusal through with its name intact', async () => {
    // Swallowing the error here is what left the modal opening and closing with
    // nothing on it. It must arrive at `classifyCameraError` unchanged.
    const denied = mediaError('NotAllowedError');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => { throw denied; }) },
    });
    vi.stubGlobal('window', { isSecureContext: true });

    await expect(requestCameraAccess()).rejects.toBe(denied);
  });
});

describe('telling the failures apart', () => {
  it('reads each browser error name as its own failure', () => {
    expect(classifyCameraError(mediaError('NotAllowedError'))).toBe('denied');
    expect(classifyCameraError(mediaError('PermissionDeniedError'))).toBe('denied');
    expect(classifyCameraError(mediaError('NotFoundError'))).toBe('no_camera');
    expect(classifyCameraError(mediaError('OverconstrainedError'))).toBe('no_camera');
    expect(classifyCameraError(mediaError('NotReadableError'))).toBe('busy');
    expect(classifyCameraError(mediaError('TrackStartError'))).toBe('busy');
    expect(classifyCameraError(mediaError('SecurityError'))).toBe('insecure_context');
  });

  it('trusts a failure we detected over a name we could misread', () => {
    const ours = new CameraAccessError('no_camera', 'no devices');
    expect(classifyCameraError(ours)).toBe('no_camera');
  });

  it('falls back to unknown rather than guessing', () => {
    // An unrecognised error reported as `denied` would send a cashier to their
    // browser settings for a problem that is not there.
    expect(classifyCameraError(mediaError('SomethingNewInChrome'))).toBe('unknown');
    expect(classifyCameraError(new Error('boom'))).toBe('unknown');
    expect(classifyCameraError(undefined)).toBe('unknown');
    expect(classifyCameraError('a string')).toBe('unknown');
  });

  it('gives a refusal and absent hardware different words', () => {
    const denied = presentCameraFailure('denied');
    const missing = presentCameraFailure('no_camera');

    // The whole point of change #2. These three used to be one string, so a
    // cashier could not act on any of them.
    expect(denied.title).not.toBe(missing.title);
    expect(denied.detail).not.toBe(missing.detail);

    // A refusal needs the browser settings; absent hardware has no setting to
    // change. Pointing the reader at the wrong one wastes their time.
    const deniedWords = `${denied.title} ${denied.detail}`.toLowerCase();
    const missingWords = `${missing.title} ${missing.detail}`.toLowerCase();

    expect(deniedWords).toContain('permiso');
    expect(missingWords).not.toContain('permiso');

    // The only path that still works without a camera is the search box, so
    // every message that is not a permission problem has to point at it.
    expect(missingWords).toContain('cámara');
    expect(missingWords).toMatch(/busc|barrera de direcciones/);
  });

  it('tells a busy camera from a denied one', () => {
    // Only one of the two is worth retrying, so they must not share a sentence.
    const busy = presentCameraFailure('busy');
    const denied = presentCameraFailure('denied');

    expect(busy.title).not.toBe(denied.title);
    expect(busy.detail).not.toBe(denied.detail);
    expect(busy.detail.toLowerCase()).toContain('usando la cámara');
  });

  it('never collapses two failures onto the same words', () => {
    // The general form of the test above: adding a failure that reuses another
    // one's copy fails here, wherever the new one is added.
    const failures: CameraFailure[] = [
      'denied',
      'no_camera',
      'busy',
      'insecure_context',
      'unsupported',
      'unknown',
    ];

    const titles = failures.map((f) => presentCameraFailure(f).title);
    const details = failures.map((f) => presentCameraFailure(f).detail);

    expect(new Set(titles).size).toBe(failures.length);
    expect(new Set(details).size).toBe(failures.length);

    // And nothing is empty: a blank banner reads as a screen that did not load.
    for (const shown of failures.map(presentCameraFailure)) {
      expect(shown.title.trim().length).toBeGreaterThan(0);
      expect(shown.detail.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('what the page does with the camera', () => {
  it('asks for the camera before it builds the scanner', () => {
    const source = startScannerSource();

    const ask = source.indexOf('requestCameraAccess()');
    const build = source.indexOf('new Html5Qrcode(');

    // Both halves matter. Without `new Html5Qrcode` the page stopped scanning;
    // without the earlier `requestCameraAccess()` it is back to a modal that
    // opens and closes, which is the failure this whole change is about.
    expect(ask).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(build);
  });

  it('never closes the modal on a camera failure', () => {
    // The regression, in the exact shape it had: an error set and the modal
    // dismissed together, so the explanation arrived on a screen already gone.
    const catches = catchBlocks(startScannerSource());

    // Two failures are handled -- the permission request and the scanner start.
    expect(catches.length).toBeGreaterThanOrEqual(2);

    for (const block of catches) {
      expect(block).not.toMatch(/setShowScanner\(/);
    }
  });

  it('still closes the modal once a code has been read', () => {
    // The counterpart, so the assertion above cannot be satisfied by never
    // closing at all: a decoded code has nothing left to scan, and leaving the
    // reader running would fight the customer's next attempt.
    const source = startScannerSource();

    expect(source).toMatch(/setShowScanner\(false\)/);
    // And only from the decoder, never from a failure path.
    expect(source.indexOf('setShowScanner(false)')).toBeGreaterThan(
      source.indexOf('async (decodedText)'),
    );
  });

  it('reports the failure through the classifier instead of a fixed string', () => {
    const source = startScannerSource();

    // `catch { setErrorMsg('Error al acceder a la cámara') }` is what collapsed
    // three different problems into one useless line.
    expect(source).toMatch(/setCameraFailure\(\s*classifyCameraError\(/);
    expect(source).not.toMatch(/Error al acceder a la cámara/);
  });

  it('keeps the reason on screen instead of the page-level banner', () => {
    // `errorMsg` renders above the layout, outside the modal. A reason shown
    // there while the modal is closed is a reason nobody is looking at.
    expect(posSource).toContain('cameraMessage');
    expect(posSource).toContain('presentCameraFailure');
    expect(posSource).toMatch(/role="alert"/);
  });

  it('does not read the permission state to decide what happened', () => {
    // `navigator.permissions` reports "denied" for a policy block, for a
    // forgotten site and for a real refusal, and reports "granted" on a machine
    // with no camera. Branching on it reintroduces the collapse.
    expect(posSource).not.toMatch(/navigator\.permissions/);
  });
});
