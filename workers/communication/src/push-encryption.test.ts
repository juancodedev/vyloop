/// <reference types="node" />
import {
  createDecipheriv,
  createECDH,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildVapidAuthorization,
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
} from './push-encryption';

// ---------------------------------------------------------------------------
// The encryption is checked by decrypting it with a different implementation.
//
// The whole point of this file is that **the body this module produces is
// decrypted by an independent implementation**. A test that encrypts and then
// decrypts with the same code proves only that the code is self-consistent; a
// wrong `info` string or a wrong byte layout would survive that and produce a
// body the push service rejects — silently, forever.
//
// So the decryptor below is written against the specification, using Node's
// crypto rather than WebCrypto's, and the browser's key pair is the one a real
// browser would hold. If the bytes are the bytes the specification means, this
// decryptor recovers the payload; if they are not, it throws.
// ---------------------------------------------------------------------------

/** The uncompressed P-256 point of a public key. */
function rawPublicKey(key: { export: (o: { format: 'jwk' }) => { x?: string; y?: string } }): Buffer {
  const jwk = key.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

interface BrowserKeyPair {
  privateKey: Buffer;
  publicKey: Buffer;
  authSecret: Buffer;
}

function newBrowserKeyPair(): BrowserKeyPair {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    authSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** The nonce of one record, mixed the way the specification says. */
function nonceForRecord(base: Uint8Array, counter: number): Buffer {
  // A **copy**, and the copy is the point.
  //
  // `Buffer.from(arrayBuffer)` shares the memory, and mixing the counter into
  // the nonce writes to it. So the first record would have mutated the base
  // the second record reads, and the second record would have been encrypted
  // under a nonce neither side could reproduce.
  //
  // The encryption under test does not have this problem — it copies — which
  // is why the mismatch showed up here and not there. A decryptor that mutates
  // its input is a decryptor that is wrong about the second record, and the
  // symptom is an authentication failure that looks like a bad ciphertext.
  const nonce = Buffer.from(Uint8Array.from(new Uint8Array(base)));
  const m = nonce.readUIntBE(nonce.length - 6, 6);
  const x =
    ((m ^ counter) & 0xffffff) +
    ((((m / 0x1000000) ^ (counter / 0x1000000)) & 0xffffff) * 0x1000000);
  nonce.writeUIntBE(x, nonce.length - 6, 6);
  return nonce;
}

/**
 * Decrypt a body the way a browser would.
 *
 * Written from the specification and using Node's crypto, so it shares no code
 * with the module under test.
 */
function decryptAsBrowser(body: Buffer, browser: BrowserKeyPair): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body.readUInt8(20);
  const applicationServerKey = body.subarray(21, 21 + keyIdLength);
  const records = body.subarray(21 + keyIdLength);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(browser.privateKey);
  const sharedSecret = ecdh.computeSecret(applicationServerKey);

  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'ascii'),
    browser.publicKey,
    applicationServerKey,
  ]);
  const inputKeyingMaterial = hkdfSync('sha256', sharedSecret, browser.authSecret, authInfo, 32);
  const contentKey = hkdfSync(
    'sha256',
    inputKeyingMaterial,
    salt,
    Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'),
    16,
  );
  // `hkdfSync` returns an ArrayBuffer, not a Buffer — and a Buffer made from
  // an ArrayBuffer *shares* its memory, which is the aliasing the copy below
  // exists to avoid.
  const nonceBase = new Uint8Array(
    hkdfSync(
      'sha256',
      inputKeyingMaterial,
      salt,
      Buffer.from('Content-Encoding: nonce\0', 'ascii'),
      12,
    ),
  );

  // The browser reads the record size out of the header and splits on it. Every
  // record but the last is exactly one record size; the last is the remainder.
  const plaintexts: Buffer[] = [];
  let offset = 0;
  let counter = 0;

  for (;;) {
    const record = records.subarray(offset, Math.min(offset + recordSize, records.length));
    offset += record.length;

    const decipher = createDecipheriv('aes-128-gcm', contentKey, nonceForRecord(nonceBase, counter));
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(record.subarray(0, record.length - 16)),
      decipher.final(),
    ]);
    // Each record ends with a one-byte delimiter: 0x02 for the last, 0x01 for
    // the others. It is stripped from every record, not only the last.
    plaintexts.push(plaintext.subarray(0, plaintext.length - 1));
    counter += 1;

    if (offset >= records.length) break;
  }

  return Buffer.concat(plaintexts);
}

function subscriptionFor(browser: BrowserKeyPair) {
  return {
    p256dh: base64UrlEncode(new Uint8Array(browser.publicKey)),
    auth: base64UrlEncode(new Uint8Array(browser.authSecret)),
  };
}

describe('base64url', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);

    expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
  });

  it('uses the url-safe alphabet and no padding', () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255]));

    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

describe('encryptPushPayload', () => {
  it('produces a body a browser can decrypt', async () => {
    const browser = newBrowserKeyPair();
    const payload = new TextEncoder().encode('{"title":"TuPoints","body":"Tenés 500 puntos"}');

    const encrypted = await encryptPushPayload(payload, subscriptionFor(browser));

    const decrypted = decryptAsBrowser(Buffer.from(encrypted.body), browser);
    expect(decrypted.toString('utf8')).toBe(
      '{"title":"TuPoints","body":"Tenés 500 puntos"}',
    );
  });

  it('produces a body a browser can decrypt for a larger payload', async () => {
    // Longer than one record, so the body is split and each record gets its
    // own nonce. A notification is small, but a body that only works below
    // 4KB is a body that fails on the first long message.
    const browser = newBrowserKeyPair();
    const payload = new TextEncoder().encode('x'.repeat(9000));

    const encrypted = await encryptPushPayload(payload, subscriptionFor(browser));

    const decrypted = decryptAsBrowser(Buffer.from(encrypted.body), browser);
    expect(decrypted.length).toBe(9000);
    expect(decrypted.toString('utf8')).toBe('x'.repeat(9000));
  });

  it('uses a fresh salt and a fresh ephemeral key for every delivery', async () => {
    // Reusing either would let a push service correlate two deliveries, and a
    // reused ephemeral key would let one delivery decrypt another.
    const browser = newBrowserKeyPair();
    const payload = new TextEncoder().encode('hello');

    const first = await encryptPushPayload(payload, subscriptionFor(browser));
    const second = await encryptPushPayload(payload, subscriptionFor(browser));

    expect(base64UrlEncode(first.salt)).not.toBe(base64UrlEncode(second.salt));
    expect(base64UrlEncode(first.applicationServerKey)).not.toBe(
      base64UrlEncode(second.applicationServerKey),
    );
    // And the two bodies are different, because the salt is inside them.
    expect(base64UrlEncode(first.body)).not.toBe(base64UrlEncode(second.body));
  });

  it('lays the body out as salt, record size, key id and records', async () => {
    const browser = newBrowserKeyPair();
    const encrypted = await encryptPushPayload(new Uint8Array([1, 2, 3]), subscriptionFor(browser));

    const body = Buffer.from(encrypted.body);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.subarray(0, 16)).toEqual(Buffer.from(encrypted.salt));
    expect(body.subarray(21, 86)).toEqual(Buffer.from(encrypted.applicationServerKey));
  });

  it('refuses a browser key that is not an uncompressed point', async () => {
    await expect(
      encryptPushPayload(new Uint8Array([1]), {
        p256dh: base64UrlEncode(new Uint8Array(32)),
        auth: base64UrlEncode(new Uint8Array(16)),
      }),
    ).rejects.toThrow(/uncompressed/);
  });

  it('refuses an auth secret that is not 16 bytes', async () => {
    const browser = newBrowserKeyPair();

    await expect(
      encryptPushPayload(new Uint8Array([1]), {
        p256dh: subscriptionFor(browser).p256dh,
        auth: base64UrlEncode(new Uint8Array(8)),
      }),
    ).rejects.toThrow(/16 bytes/);
  });
});

describe('buildVapidAuthorization', () => {
  it('is a signed JWT with the audience, the expiry and the subject', async () => {
    // A real VAPID key pair: the private half in PKCS#8, which is what the
    // secret holds, and the public half as the uncompressed point.
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const identity = {
      publicKey: base64UrlEncode(new Uint8Array(publicKey.export({ format: 'jwk' }).x
        ? rawPublicKey(publicKey)
        : Buffer.alloc(0))),
      privateKey: base64UrlEncode(
        new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' })),
      ),
      subject: 'mailto:push@vyloop.app',
    };

    const header = await buildVapidAuthorization(identity, 'https://fcm.googleapis.com');
    expect(header).toMatch(/^vapid t=[^.]+\.[^.]+\.[^,]+, k=.+$/);

    const token = header.slice('vapid t='.length).split(', k=')[0];
    const [encodedHeader, encodedPayload] = token.split('.');
    const decodedPayload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );

    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    expect(decodedPayload.aud).toBe('https://fcm.googleapis.com');
    expect(decodedPayload.sub).toBe('mailto:push@vyloop.app');
    expect(decodedPayload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
