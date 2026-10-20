/**
 * Registering this browser for push messages.
 *
 * The sequence a browser goes through is fixed and unforgiving:
 *
 *   1. the service worker has to be registered, because it is what shows a
 *      message when the page is not open;
 *   2. the customer has to grant the permission, which only a user gesture can
 *      ask for;
 *   3. the browser subscribes with the platform's VAPID public key;
 *   4. the subscription is sent to the platform, which records it against the
 *      customer.
 *
 * The permission is asked for by a button and not on page load, because a
 * permission prompt that appears without being asked for is the one people
 * dismiss.
 *
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is substituted at build time, so a missing
 * value is `undefined` in the shipped bundle. That is why a production build
 * throws instead of guessing: the public key is not secret, but a build without
 * one cannot subscribe anybody, and a silent failure there would look like a
 * browser that does not support push.
 */

/** The outcome of an attempt, so a caller can say something useful. */
export type PushSubscriptionResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; reason: 'unsupported' | 'denied' | 'not-configured' | 'failed'; message: string };

/** The gateway base URL, resolved the same way the rest of the client does. */
import { gatewayUrl } from './gateway-url';

const JWT_KEY = 'vyloop_jwt';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(JWT_KEY);
}

/**
 * The VAPID public key the platform signs with.
 *
 * @throws if it is not configured. A production build without it cannot
 *         subscribe anybody, and a silent failure would look like a browser
 *         that does not support push.
 */
export function resolveVapidPublicKey(
  value: string | undefined = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  production: boolean = process.env.NODE_ENV === 'production',
): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  if (production) {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set. The browser cannot register ' +
        'for push messages without it, and a build without it fails silently ' +
        'at the point of subscribing. Set it in the build environment.',
    );
  }

  return '';
}

/** Whether this browser can receive push at all. */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Register the service worker and return its registration.
 *
 * @throws if the service worker cannot be registered. Without it there is
 *         nothing to show a message with.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!pushSupported()) {
    throw new Error('This browser cannot receive push messages.');
  }

  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

  // The worker has to be *active* before a push can be subscribed to it, and
  // `register` resolves before that is true.
  await navigator.serviceWorker.ready;

  return registration;
}

/**
 * Subscribe this browser and tell the platform about it.
 *
 * @param fetcher injectable so the request can be tested without a network.
 */
export async function subscribeToPush(
  fetcher: typeof fetch = fetch,
  publicKey: string = resolveVapidPublicKey(),
): Promise<PushSubscriptionResult> {
  if (!pushSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Este navegador no admite notificaciones push.',
    };
  }

  if (!publicKey) {
    return {
      ok: false,
      reason: 'not-configured',
      message: 'Las notificaciones push no están configuradas en este entorno.',
    };
  }

  // The permission is only ever asked for here, and only ever as the result of
  // a user gesture.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      message: 'No diste permiso para recibir notificaciones.',
    };
  }

  const registration = await registerServiceWorker();

  // An existing subscription is reused rather than replaced: a second
  // subscription for the same browser would deliver every message twice.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }));

  const token = getToken();
  const response = await fetcher(`${gatewayUrl()}/v1/communication/push/subscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: 'failed',
      message: 'No pudimos registrar este dispositivo para notificaciones.',
    };
  }

  const body = (await response.json()) as { subscription?: { id?: string } };
  return { ok: true, subscriptionId: body.subscription?.id ?? '' };
}

/**
 * Stop receiving messages on this browser.
 *
 * The subscription is removed on the platform as well as in the browser: a
 * browser that forgets its subscription still has a row on the platform, and
 * every message would be paid for and never seen.
 */
export async function unsubscribeFromPush(
  fetcher: typeof fetch = fetch,
): Promise<PushSubscriptionResult> {
  if (!pushSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Este navegador no admite notificaciones push.',
    };
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    return { ok: true, subscriptionId: '' };
  }

  const token = getToken();
  await fetcher(`${gatewayUrl()}/v1/communication/push/unsubscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });

  await subscription.unsubscribe();

  return { ok: true, subscriptionId: '' };
}

/**
 * The base64url VAPID key as the bytes `PushManager.subscribe` wants.
 *
 * Typed over `ArrayBuffer` and not over `ArrayBufferLike`, because the DOM
 * signature for `applicationServerKey` does not accept a view that might be
 * backed by a `SharedArrayBuffer`.
 */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
