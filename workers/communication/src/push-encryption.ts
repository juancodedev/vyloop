// ---------------------------------------------------------------------------
// Web Push encryption (RFC 8291, aes128gcm) and VAPID signing (RFC 8292).
//
// The push service accepts a delivery only if the body is encrypted to the
// browser's key, so this is not an optional step: an unencrypted body is a
// rejected delivery.
//
// The algorithm is the one every push service implements, and it is
// implemented here from the reference rather than from memory, because the
// failure mode of getting it subtly wrong is a body that looks fine and is
// never accepted.
//
// ## What the algorithm does
//
// The browser holds a P-256 key pair and sends the public half (`p256dh`) plus
// a 16-byte auth secret. The server:
//
//   1. generates an ephemeral P-256 key pair, the "application server" key;
//   2. derives the shared secret with ECDH against the browser's public key;
//   3. mixes the browser's auth secret into it with HKDF, together with both
//      public keys, so only the two holders can reach the result;
//   4. derives the content key and the nonce from that with two more HKDF
//      steps, salted per delivery;
//   5. encrypts the payload with AES-128-GCM and prefixes the body with the
//      salt, the record size and the ephemeral public key.
//
// The result is delivered with `Content-Encoding: aes128gcm` and a `Crypto-Key`
// header, and the browser reverses it with the private key that never left it.
//
// ## Why WebCrypto and not a library
//
// The obvious library — `web-push` — sends over `https.request`, which a
// Worker does not have. Its encryption half is `http_ece`, which is a port of
// a Node library built on `node:crypto` APIs that a Worker does not implement
// either. So the algorithm is implemented here, on the primitives a Worker
// actually has, and it is checked against an independent decryptor in the
// tests: a body this module produces is decrypted by a different
// implementation, which is the only proof that the bytes are the bytes the
// specification means.
// ---------------------------------------------------------------------------

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The content encoding this implementation speaks. */
export const CONTENT_ENCODING = 'aes128gcm';

/** The record size the push service expects. */
export const DEFAULT_RECORD_SIZE = 4096;

const SALT_LENGTH = 16;
const AUTH_SECRET_LENGTH = 16;
const CONTENT_KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const SHA_256_LENGTH = 32;

/** The browser's registration keys, as they arrive from `PushSubscription`. */
export interface PushSubscriptionKeys {
  /** The browser's public key, base64url, uncompressed P-256 point. */
  p256dh: string;
  /** The browser's auth secret, base64url, 16 bytes. */
  auth: string;
}

/** An encrypted payload, ready to be sent. */
export interface EncryptedPush {
  /** The whole body: the header and the record(s). */
  body: Uint8Array;
  /** The salt, for the `Encryption` header. */
  salt: Uint8Array;
  /** The ephemeral public key, for the `Crypto-Key` header. */
  applicationServerKey: Uint8Array;
  /** The record size, which is part of the body header. */
  recordSize: number;
}

/** Base64url without padding, which is what every header here uses. */
export function base64UrlEncode(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Base64url to bytes. Accepts the padded form too. */
export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((normalized.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const character of normalized) {
    const value6 = BASE64URL_ALPHABET.indexOf(character);
    if (value6 === -1) {
      throw new Error(`Not base64url: ${character}`);
    }
    accumulator = (accumulator << 6) | value6;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (accumulator >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * HKDF with SHA-256, extract then expand.
 *
 * The order of the arguments is the one that bites: this is
 * `HKDF(salt, ikm, info, length)`, and the salt is the *first* argument while
 * the input keying material is the second. The browser's auth secret is the
 * salt of the first step, and the per-delivery salt is the salt of the second.
 */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      // The hash is not optional here, and SHA-256 is the one the
      // specification names.
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * The nonce for one record.
 *
 * The base nonce comes from the key derivation, and the counter is mixed into
 * its last six bytes. With a counter of zero — a payload that fits in one
 * record, which is every payload a notification produces — the base is used
 * unchanged.
 */
function nonceForRecord(base: Uint8Array, counter: number): Uint8Array {
  const nonce = new Uint8Array(base);
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);

  const m = view.getUint32(nonce.length - 6, false) * 0x10000 + view.getUint16(nonce.length - 2, false);
  const x =
    ((m ^ counter) & 0xffffff) +
    ((((m / 0x1000000) ^ (counter / 0x1000000)) & 0xffffff) * 0x1000000);
  view.setUint32(nonce.length - 6, Math.floor(x / 0x10000) & 0xffffffff, false);
  view.setUint16(nonce.length - 2, x & 0xffff, false);

  return nonce;
}

/**
 * Encrypt a payload for one browser.
 *
 * @param payload      The bytes to deliver.
 * @param subscription The browser's public key and auth secret.
 * @param recordSize   The record size; the push service expects 4096.
 */
export async function encryptPushPayload(
  payload: Uint8Array,
  subscription: PushSubscriptionKeys,
  recordSize: number = DEFAULT_RECORD_SIZE,
): Promise<EncryptedPush> {
  const receiverPublicKey = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);

  if (receiverPublicKey.length !== 65) {
    throw new Error('The browser public key is not an uncompressed P-256 point.');
  }
  if (authSecret.length !== AUTH_SECRET_LENGTH) {
    throw new Error('The browser auth secret is not 16 bytes.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  // The ephemeral key pair, for this delivery only.
  const senderKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const applicationServerKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderKeys.publicKey),
  );

  // The shared secret, and the browser's public key imported so it can be
  // diffed against.
  const receiverKey = await crypto.subtle.importKey(
    'raw',
    receiverPublicKey as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: receiverKey },
      senderKeys.privateKey,
      256,
    ),
  );

  // The input keying material: the shared secret, bound to the auth secret and
  // to both public keys, so that a value derived here is useless to anyone who
  // is not one of the two holders.
  const inputKeyingMaterial = await hkdf(
    authSecret,
    sharedSecret,
    concat(ascii('WebPush: info\0'), receiverPublicKey, applicationServerKey),
    SHA_256_LENGTH,
  );

  // And from that, the content key and the nonce base, with the per-delivery
  // salt.
  const contentKey = await hkdf(
    salt,
    inputKeyingMaterial,
    ascii('Content-Encoding: aes128gcm\0'),
    CONTENT_KEY_LENGTH,
  );
  const nonceBase = await hkdf(
    salt,
    inputKeyingMaterial,
    ascii('Content-Encoding: nonce\0'),
    NONCE_LENGTH,
  );

  const aesKey = await crypto.subtle.importKey(
    'raw',
    contentKey as BufferSource,
    'AES-GCM',
    false,
    ['encrypt'],
  );

  // The body header: the salt, the record size, and the ephemeral public key
  // the browser needs to derive the same key.
  const keyIdLength = new Uint8Array([applicationServerKey.length]);
  const recordSizeBytes = new Uint8Array(4);
  new DataView(recordSizeBytes.buffer).setUint32(0, recordSize, false);

  const records: Uint8Array[] = [];
  let start = 0;
  let counter = 0;
  let last = false;

  while (!last) {
    // Room for the payload, the padding delimiter and the tag.
    const overhead = 1 + TAG_LENGTH;
    const end = Math.min(start + recordSize - overhead, payload.length);
    const isLast = end >= payload.length;

    const plaintext = concat(
      payload.subarray(start, end),
      // The last record of a message ends with 0x02 and the others with 0x01.
      // The browser reads it to know where the message ends.
      new Uint8Array([isLast ? 2 : 1]),
    );

    const nonce = nonceForRecord(nonceBase, counter);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: TAG_LENGTH * 8 },
        aesKey,
        plaintext as BufferSource,
      ),
    );

    records.push(sealed);
    start = end;
    counter += 1;
    last = isLast;
  }

  const body = concat(
    salt,
    recordSizeBytes,
    keyIdLength,
    applicationServerKey,
    ...records,
  );

  return { body, salt, applicationServerKey, recordSize };
}

// ---------------------------------------------------------------------------
// VAPID
// ---------------------------------------------------------------------------

/** The VAPID identity of this server. */
export interface VapidIdentity {
  /** The public key, base64url, uncompressed P-256 point. */
  publicKey: string;
  /** The private key, base64url, PKCS#8. */
  privateKey: string;
  /** Who to contact about this sender, as a `mailto:` URL. */
  subject: string;
}

/**
 * The `Authorization` header a push service checks.
 *
 * It is a JWT signed with the VAPID private key: the audience is the push
 * service, the expiry bounds how long a captured header is useful, and the
 * subject says who to complain to.
 */
export async function buildVapidAuthorization(
  identity: VapidIdentity,
  audience: string,
  now: number = Date.now(),
): Promise<string> {
  const header = ascii(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = ascii(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(now / 1000) + 12 * 60 * 60,
      sub: identity.subject,
    }),
  );

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    base64UrlDecode(identity.privateKey) as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      concat(header, ascii('.'), payload) as BufferSource,
    ),
  );

  const token = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`;
  return `vapid t=${token}, k=${identity.publicKey}`;
}
