/**
 * Why the camera is unusable, in words a cashier can act on.
 *
 * ## Why this lives outside the page
 *
 * `apps/dashboard/vitest.config.ts` sets no `environment`, so the dashboard runs
 * in `node`: no jsdom, no React, nothing renders. The decision of *which* of
 * three failures we are looking at is worth more than the rendering, so it is
 * here where it can be checked. This is the same split as `lib/pass-state.ts`
 * and `lib/lookup-identifier.ts`.
 *
 * ## Why `getUserMedia` is called before `Html5Qrcode` is constructed
 *
 * Nothing else opens the permission dialog. `html5-qrcode` does call
 * `getUserMedia` itself, but only once its own scan loop is already running, so
 * the cashier sees a modal with no video and no prompt, and the rejection
 * arrives as a failure to start rather than as a permission question. Asking
 * first moves the browser's dialog in front of the user while they are still
 * looking at the button they pressed.
 *
 * The permission itself has to be granted in a user gesture. `startScanner` is
 * the click handler, so this runs inside one; a request fired from an effect on
 * mount is blocked in Safari and is the usual reason a fix for this looks like
 * it did nothing.
 *
 * ## Why `navigator.permissions` is not consulted
 *
 * It is the obvious first move and it cannot answer the question:
 *
 * - `state: 'denied'` covers a user clicking "Block", an enterprise policy, and
 *   a browser that has forgotten the site. Those need different words.
 * - `state: 'granted'` is returned on a machine with no camera at all, because
 *   the permission and the hardware are different questions.
 * - `state: 'prompt'` — the state this page was stuck in — says only that nobody
 *   has been asked yet, which is the one thing we already knew.
 *
 * The `name` of the `DOMException` from `getUserMedia` is the signal that
 * actually distinguishes a refusal from absent hardware from a camera another
 * app is holding. So that is what is read.
 */

/**
 * The failures a cashier can do something different about.
 *
 * Each is a separate action, which is the whole point: one message for all of
 * them tells the cashier to do the wrong thing, or nothing.
 */
export type CameraFailure =
  /** The user or a policy refused. The browser will not ask again. */
  | 'denied'
  /** No camera on this device. */
  | 'no_camera'
  /** A camera exists but something else is holding it. */
  | 'busy'
  /** Not a secure origin, so the API is unavailable regardless of hardware. */
  | 'insecure_context'
  /** This browser exposes no camera API at all. */
  | 'unsupported'
  /** Something we have no name for. Reported as itself rather than as a guess. */
  | 'unknown';

export interface CameraFailurePresentation {
  /** One word for the banner. */
  title: string;
  /** What happened, and what to try. Never a request to retry blindly. */
  detail: string;
}

/**
 * A failure we detected ourselves, before any browser exception existed.
 *
 * Carries the classification instead of a `name` so `classifyCameraError` has
 * one shape to read: either we know, or the browser told us.
 */
export class CameraAccessError extends Error {
  readonly failure: CameraFailure;

  constructor(failure: CameraFailure, detail: string) {
    super(detail);
    this.name = 'CameraAccessError';
    this.failure = failure;
  }
}

/**
 * Which failure this is, from whatever the media layer threw.
 *
 * Both the current spec names and the legacy prefixed ones are accepted because
 * Safari and Firefox have shipped the prefixed variants for years and a cashier
 * on an old browser is exactly the person who cannot be told "unknown".
 *
 * @param err the rejection from `getUserMedia`, or anything else entirely.
 */
export function classifyCameraError(err: unknown): CameraFailure {
  if (err instanceof CameraAccessError) return err.failure;

  const name = err instanceof Error ? err.name : '';

  switch (name) {
    // The prompt was shown and answered with "Block", or a permissions policy
    // forbade the camera. Either way the browser will not ask again, so the
    // advice has to be "change it in the address bar", not "try once more".
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'denied';

    // No capture device, or none matching the requested constraints.
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no_camera';

    // Hardware present, another app holding it. Retryable, unlike the rest.
    case 'NotReadableError':
    case 'TrackStartError':
      return 'busy';

    // The spec's answer for an origin the browser will not hand a camera to.
    // The same case is also caught before the call by `isSecureContext`, since
    // some browsers report it as a bare `TypeError` instead of a named error.
    case 'SecurityError':
      return 'insecure_context';

    default:
      return 'unknown';
  }
}

const PRESENTATION: Record<CameraFailure, CameraFailurePresentation> = {
  denied: {
    title: 'Permiso de cámara denegado',
    detail:
      'El navegador no permite usar la cámara en este sitio. Habilitalo desde el candado o el ícono de cámara de la barra de direcciones y volvé a intentarlo.',
  },
  no_camera: {
    title: 'No hay cámara disponible',
    detail:
      'Este dispositivo no tiene ninguna cámara, o la que tiene no sirve para escanear. Podés buscar al cliente por teléfono o correo en el campo de arriba.',
  },
  busy: {
    title: 'Cámara ocupada',
    detail:
      'Otra aplicación está usando la cámara. Cerrala y volvé a intentarlo.',
  },
  insecure_context: {
    title: 'Conexión no segura',
    detail:
      'El navegador sólo entrega la cámara en sitios HTTPS. Esta página no está en una, así que el escaneo no puede funcionar.',
  },
  unsupported: {
    title: 'Cámara no soportada',
    detail:
      'Este navegador no expone la API de cámara. Podés buscar al cliente por teléfono o correo en el campo de arriba.',
  },
  unknown: {
    title: 'No se pudo abrir la cámara',
    detail:
      'El navegador falló sin explicar por qué. Podés buscar al cliente por teléfono o correo en el campo de arriba.',
  },
};

/**
 * The words for one failure.
 *
 * Every entry offers a way forward. A message that only names the problem
 * leaves a cashier at the counter with nothing to do, which is the state this
 * page was in before the failure was told apart at all.
 */
export function presentCameraFailure(failure: CameraFailure): CameraFailurePresentation {
  return PRESENTATION[failure];
}

/**
 * Ask for the camera and let go of it again.
 *
 * Called before `Html5Qrcode` so the permission dialog belongs to this call.
 *
 * The stream is stopped immediately on purpose: `html5-qrcode` opens its own
 * one, and on several devices a second `getUserMedia` while the first is still
 * live fails with `NotReadableError` — a "camera busy" the cashier caused and
 * would then be told to go and fix. Releasing here costs a re-acquire the
 * browser does not charge for, because the permission is already granted.
 *
 * @throws {CameraAccessError} when the API is missing or the origin is not
 * secure — the two cases no exception can report for us.
 * @throws the browser's own `DOMException` when the request itself fails; use
 * `classifyCameraError` on whatever comes out.
 */
export async function requestCameraAccess(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraAccessError('unsupported', 'navigator.mediaDevices.getUserMedia is unavailable');
  }

  // `getUserMedia` is undefined on an insecure origin even though
  // `navigator.mediaDevices` exists, so the origin is checked for its own sake:
  // "your camera is blocked by policy" would be a lie here.
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new CameraAccessError('insecure_context', 'the page is not on a secure origin');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
  });

  for (const track of stream.getTracks()) track.stop();
}
