/**
 * Tests for the temporary Google Wallet callback envelope capture.
 *
 * ## What this module is for
 *
 * Production logged `intermediate_key_unverified`, which `verifyPassCallback` can
 * only emit when a *non-empty* array of intermediate-key signatures arrives and
 * none of them verifies under any root. That eliminates every cause except one:
 * **the bytes this worker signs are not the bytes Google signed.**
 *
 * `callbacks.ts` builds those bytes with Tink's `toLengthValue`, transcribed from
 * the Java sample and never run against a real envelope. The test suite cannot
 * close that gap, because a test-generated envelope agrees with a test-generated
 * expectation by construction. Only a real delivery can.
 *
 * So this module describes the **shape** of a real envelope: field names, lengths,
 * protocol values, and a short fingerprint of the signed bytes. Enough to compare
 * against what the code derives locally. Never a byte of key material, signature,
 * or personal data.
 *
 * ## The security property these tests exist to hold
 *
 * `describe('nothing cryptographic escapes')` is the test that makes the endpoint
 * acceptable to deploy. It searches the whole response for the exact signature and
 * the exact public key the envelope carried, and fails if either appears. If that
 * test is ever weakened, this endpoint starts publishing Google's signing keys.
 */

import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_CAPTURE_PATH,
  ENVELOPE_CAPTURE_REVIEW_BY,
  ENVELOPE_CAPTURE_SUPERSEDED_BY,
  ENVELOPE_CAPTURE_TICKET,
  captureCallbackEnvelope,
} from './envelope-capture';

// ---------------------------------------------------------------------------
// Test key material, generated per test and never written to disk
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Tink's `toLengthValue`, restated so these tests do not import the code under test. */
function toLengthValue(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map((p) => new TextEncoder().encode(p));
  const total = encoded.reduce((sum, b) => sum + 2 + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of encoded) {
    out[offset] = (b.length >> 8) & 0xff;
    out[offset + 1] = b.length & 0xff;
    out.set(b, offset + 2);
    offset += 2 + b.length;
  }
  return out;
}

/** Minimal DER encoder for `SEQUENCE { INTEGER r, INTEGER s }`. */
function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const encodeInteger = (value: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0x00) start += 1;
    const magnitude = value.subarray(start);
    const needsSignByte = (magnitude[0] & 0x80) !== 0;
    const out = new Uint8Array(2 + magnitude.length + (needsSignByte ? 1 : 0));
    out[0] = 0x02;
    out[1] = magnitude.length + (needsSignByte ? 1 : 0);
    if (needsSignByte) {
      out[2] = 0x00;
      out.set(magnitude, 3);
    } else {
      out.set(magnitude, 2);
    }
    return out;
  };
  const r = encodeInteger(p1363.subarray(0, 32));
  const s = encodeInteger(p1363.subarray(32, 64));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

async function generateTestKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { privateKey: pair.privateKey, spkiBase64: bytesToBase64(spki) };
}

async function signLikeGoogle(key: CryptoKey, parts: readonly string[]): Promise<string> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, toLengthValue(parts)),
  );
  return bytesToBase64(p1363ToDer(raw));
}

const ISSUER_ID = '3388000000023206930';
const PROTOCOL = 'ECv2SigningOnly';
const SENDER = 'GooglePayPasses';

const SIGNED_MESSAGE = JSON.stringify({
  classId: `${ISSUER_ID}.tenant-11111111-1111-1111-1111-111111111111`,
  objectId: `${ISSUER_ID}.member-cust-abc`,
  eventType: 'save',
  expTimeMillis: 1754114831806,
  count: 1,
  nonce: '40a8e5af-5b7f-4ea4-b152-63d96858550e',
});

/** A complete, correctly shaped envelope, with every value also returned for leak checks. */
async function wellFormedEnvelope() {
  const root = await generateTestKey();
  const intermediate = await generateTestKey();

  const signedKey = JSON.stringify({
    keyValue: intermediate.spkiBase64,
    keyExpiration: '1754778096000',
  });

  const keySignature = await signLikeGoogle(root.privateKey, [SENDER, PROTOCOL, signedKey]);
  const messageSignature = await signLikeGoogle(intermediate.privateKey, [
    SENDER,
    ISSUER_ID,
    PROTOCOL,
    SIGNED_MESSAGE,
  ]);

  const body = JSON.stringify({
    protocolVersion: PROTOCOL,
    signature: messageSignature,
    signedMessage: SIGNED_MESSAGE,
    intermediateSigningKey: { signedKey, signatures: [keySignature] },
  });

  return { body, keySignature, messageSignature, signedKey, keyValue: intermediate.spkiBase64 };
}

// ---------------------------------------------------------------------------

describe('captureCallbackEnvelope', () => {
  describe('a well-formed envelope', () => {
    it('returns the structure, with the values the code assumes', async () => {
      const { body } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      expect(capture.parsed).toBe(true);
      // Sorted, so two captures are diffable regardless of the order Google
      // serialised the keys in. The assertion is still strict about the set: these
      // four and nothing else, which is what proves no protocol-shaped field is
      // being ignored by the verifier.
      expect(capture.topLevelKeys).toEqual([
        'intermediateSigningKey',
        'protocolVersion',
        'signature',
        'signedMessage',
      ]);
      expect(capture.protocolVersion).toBe(PROTOCOL);
    });

    it('reports the signed message by presence, length, prefix and JSON shape', async () => {
      const { body } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      expect(capture.signedMessage.present).toBe(true);
      expect(capture.signedMessage.byteLength).toBe(new TextEncoder().encode(SIGNED_MESSAGE).length);
      expect(capture.signedMessage.isJson).toBe(true);
      expect(capture.signedMessage.jsonType).toBe('object');
      expect(capture.signedMessage.jsonKeys).toEqual([
        'classId',
        'objectId',
        'eventType',
        'expTimeMillis',
        'count',
        'nonce',
      ]);
      expect(capture.signedMessage.prefix).toBe(SIGNED_MESSAGE.slice(0, 200));
    });

    it('reports the intermediate key by length, JSON shape and SPKI algorithm', async () => {
      const { body } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      const key = capture.intermediateSigningKey.signedKey;
      expect(key.present).toBe(true);
      expect(key.byteLength).toBeGreaterThan(0);
      expect(key.isJson).toBe(true);
      expect(key.jsonKeys).toEqual(['keyValue', 'keyExpiration']);
      expect(key.keyValuePresent).toBe(true);
      // 91 bytes is a P-256 SPKI, and the reader proves it from the DER rather
      // than from the base64 prefix, which is what lets a mangled key be told
      // from a good one.
      expect(key.keyValueByteLength).toBe(91);
      expect(key.algorithm).toBe('ECDSA P-256');
    });

    it('reports each intermediate key signature by count, length and DER edges', async () => {
      const { body, keySignature } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);
      const sigs = capture.intermediateSigningKey.signatures;

      expect(sigs.count).toBe(1);
      expect(sigs.entries).toHaveLength(1);
      expect(sigs.entries[0]?.byteLength).toBe(base64ToBytes(keySignature).length);
      // 0x30 is a DER SEQUENCE. A signature that did not start here would mean
      // Google shipped something this worker's DER reader cannot read at all.
      expect(sigs.entries[0]?.firstByteHex).toBe('30');
      expect(sigs.entries[0]?.derSequence).toBe(true);
      expect(sigs.entries[0]?.lastByteHex).toMatch(/^[0-9a-f]{2}$/);
    });

    it('reports the message signature by length and DER edges', async () => {
      const { body, messageSignature } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      expect(capture.messageSignature.present).toBe(true);
      expect(capture.messageSignature.byteLength).toBe(base64ToBytes(messageSignature).length);
      expect(capture.messageSignature.firstByteHex).toBe('30');
      expect(capture.messageSignature.derSequence).toBe(true);
    });

    it('fingerprints the exact bytes this worker signs, so a derivation can be compared', async () => {
      const { body, signedKey } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      // Recomputed here from the envelope's own values, independently of the
      // capture. If the two digests agree, the capture describes the same byte
      // string the verifier builds; the operator then tests alternative
      // derivations against this digest offline.
      const expected = await sha256Hex(toLengthValue([SENDER, PROTOCOL, signedKey]));
      expect(capture.derivedSignedBytes.keySignatureInput?.sha256).toBe(expected);
      expect(capture.derivedSignedBytes.keySignatureInput?.byteLength).toBe(
        toLengthValue([SENDER, PROTOCOL, signedKey]).length,
      );

      const expectedMessage = await sha256Hex(
        toLengthValue([SENDER, ISSUER_ID, PROTOCOL, SIGNED_MESSAGE]),
      );
      expect(capture.derivedSignedBytes.messageSignatureInput?.sha256).toBe(expectedMessage);
    });

    it('uses the envelope protocol version in the fingerprint, not the configured one', async () => {
      const { body, signedKey } = await wellFormedEnvelope();
      const other = body.replace(`"protocolVersion":"${PROTOCOL}"`, '"protocolVersion":"ECv2"');

      const capture = await captureCallbackEnvelope(other, ISSUER_ID);

      expect(capture.protocolVersion).toBe('ECv2');
      const withEnvelopeProtocol = await sha256Hex(toLengthValue([SENDER, 'ECv2', signedKey]));
      const withConfiguredProtocol = await sha256Hex(toLengthValue([SENDER, PROTOCOL, signedKey]));
      expect(capture.derivedSignedBytes.keySignatureInput?.sha256).toBe(withEnvelopeProtocol);
      expect(capture.derivedSignedBytes.keySignatureInput?.sha256).not.toBe(withConfiguredProtocol);
    });

    it('reports the configured issuer id and whether the envelope carries one', async () => {
      const { body } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      // `recipientId` is what the verifier is *given*, never a field Google
      // sends. The capture says both, so the distinction is visible in the log
      // instead of assumed.
      expect(capture.recipientId.presentInEnvelope).toBe(false);
      expect(capture.recipientId.configuredIssuerId).toBe(ISSUER_ID);
    });

    it('reports no configured issuer id rather than failing when the var is unset', async () => {
      const { body } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, undefined);

      expect(capture.recipientId.configuredIssuerId).toBeNull();
      expect(capture.parsed).toBe(true);
    });
  });

  describe('nothing cryptographic escapes', () => {
    // The test that makes this endpoint acceptable to deploy. It searches the
    // entire serialised response for the exact material the envelope carried.
    it('contains neither the signature nor the public key, in any encoding', async () => {
      const { body, keySignature, messageSignature, signedKey, keyValue } =
        await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);
      const serialised = JSON.stringify(capture);

      const forbidden: Array<[string, string]> = [
        ['intermediate key signature (base64)', keySignature],
        ['message signature (base64)', messageSignature],
        ['intermediate public key (base64)', keyValue],
        ['the whole signedKey string', signedKey],
        ['intermediate key signature (hex)', hex(base64ToBytes(keySignature))],
        ['message signature (hex)', hex(base64ToBytes(messageSignature))],
        ['intermediate public key (hex)', hex(base64ToBytes(keyValue))],
        ['intermediate public key (base64url)', keyValue.replace(/\+/g, '-').replace(/\//g, '_')],
      ];

      for (const [what, value] of forbidden) {
        expect(serialised, `${what} must not appear in the capture`).not.toContain(value);
      }
    });

    it('never emits a string long enough to be key material', async () => {
      const { body } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      // The longest string the capture may contain is the 200-character prefix
      // of `signedMessage`, whose contents are event identifiers and not keys.
      // A base64 SPKI needs 124 characters, so this bound alone cannot hold a
      // whole public key, let alone a signature.
      for (const value of allStrings(capture)) {
        expect(value.length).toBeLessThanOrEqual(220);
      }
    });

    it('keeps the prefix it does emit free of the signed key and the signatures', async () => {
      const { body, keySignature, messageSignature, keyValue } = await wellFormedEnvelope();

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      expect(capture.signedMessage.prefix ?? '').not.toContain(keyValue);
      expect(capture.signedMessage.prefix ?? '').not.toContain(keySignature);
      expect(capture.signedMessage.prefix ?? '').not.toContain(messageSignature);
      // And the intermediate key's own prefix is not emitted at all: a 120-char
      // slice of it is mostly base64 public key.
      expect(capture.intermediateSigningKey.signedKey).not.toHaveProperty('prefix');
    });
  });

  describe('a malformed envelope', () => {
    it('does not throw on a body that is not JSON', async () => {
      const capture = await captureCallbackEnvelope('not json at all {{{', ISSUER_ID);

      expect(capture.parsed).toBe(false);
      expect(capture.topLevelKeys).toEqual([]);
      expect(capture.notes).toContain('The body is not valid JSON.');
    });

    it('does not throw when required fields are missing or the wrong type', async () => {
      const capture = await captureCallbackEnvelope(
        JSON.stringify({ protocolVersion: 42, intermediateSigningKey: 'nope' }),
        ISSUER_ID,
      );

      expect(capture.parsed).toBe(true);
      expect(capture.protocolVersion).toBeNull();
      expect(capture.signedMessage.present).toBe(false);
      expect(capture.intermediateSigningKey.present).toBe(false);
      expect(capture.messageSignature.present).toBe(false);
      expect(capture.derivedSignedBytes.keySignatureInput).toBeNull();
    });

    it('survives a signedMessage that is valid JSON but not an object', async () => {
      const capture = await captureCallbackEnvelope(
        JSON.stringify({ protocolVersion: PROTOCOL, signedMessage: '"a string"' }),
        ISSUER_ID,
      );

      expect(capture.signedMessage.isJson).toBe(true);
      expect(capture.signedMessage.jsonType).toBe('string');
      expect(capture.signedMessage.jsonKeys).toBeNull();
    });

    it('survives a signatures entry that is not base64', async () => {
      const capture = await captureCallbackEnvelope(
        JSON.stringify({
          protocolVersion: PROTOCOL,
          intermediateSigningKey: { signedKey: '{}', signatures: ['!!!not base64!!!'] },
        }),
        ISSUER_ID,
      );

      expect(capture.intermediateSigningKey.signatures.count).toBe(1);
      expect(capture.intermediateSigningKey.signatures.entries[0]?.decodable).toBe(false);
      expect(capture.intermediateSigningKey.signatures.entries[0]?.firstByteHex).toBeNull();
    });

    it('refuses an oversized body without parsing it, and says so', async () => {
      const huge = JSON.stringify({ protocolVersion: PROTOCOL, signedMessage: 'x'.repeat(200_000) });

      const capture = await captureCallbackEnvelope(huge, ISSUER_ID);

      expect(capture.parsed).toBe(false);
      expect(capture.notes).toContain('The body was too large to describe.');
    });

    it('bounds what an attacker can make the capture echo', async () => {
      // A public endpoint writes to the log. The prefix is the only unbounded
      // field in the response, so it is the one that has to be capped.
      const capture = await captureCallbackEnvelope(
        JSON.stringify({ protocolVersion: PROTOCOL, signedMessage: 'A'.repeat(50_000) }),
        ISSUER_ID,
      );

      expect((capture.signedMessage.prefix ?? '').length).toBeLessThanOrEqual(200);
      expect(capture.signedMessage.jsonKeys ?? []).toHaveLength(0);
    });
  });

  describe('the protocol name', () => {
    it('comes from the envelope, so a protocol this code does not implement is visible', async () => {
      // If the capture answered with the configured constant it would report
      // `ECv2SigningOnly` for every envelope ever sent, which is exactly the
      // question it exists to answer.
      const capture = await captureCallbackEnvelope(
        JSON.stringify({ protocolVersion: 'ECv2SigningOnlyXYZ' }),
        ISSUER_ID,
      );

      expect(capture.protocolVersion).toBe('ECv2SigningOnlyXYZ');
      expect(capture.protocolVersionIsTheConfiguredOne).toBe(false);
    });

    it('flags agreement with the configured protocol', async () => {
      const capture = await captureCallbackEnvelope(
        JSON.stringify({ protocolVersion: PROTOCOL }),
        ISSUER_ID,
      );

      expect(capture.protocolVersionIsTheConfiguredOne).toBe(true);
    });
  });
});

describe('the capture is temporary, and says so', () => {
  // The two deletion criteria, in the order they are checked. This block is the
  // orphan guard: it goes red the day the fix lands, which is the only moment
  // anyone remembers this file exists.
  it('has not been superseded — delete the route when it has', () => {
    expect(
      ENVELOPE_CAPTURE_SUPERSEDED_BY,
      `The ${ENVELOPE_CAPTURE_TICKET} capture must be deleted, not left behind. Set ` +
        'ENVELOPE_CAPTURE_SUPERSEDED_BY to null and remove the route, the tests and this file.',
    ).toBeNull();
  });

  it('names the ticket it exists for', () => {
    expect(ENVELOPE_CAPTURE_TICKET).toContain('intermediate_key_unverified');
  });

  it('declares a review date, so it cannot outlive the investigation unnoticed', () => {
    expect(ENVELOPE_CAPTURE_REVIEW_BY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('sits on a path that says what it is', () => {
    expect(ENVELOPE_CAPTURE_PATH).toBe('/v1/wallet/google/envelope-capture');
  });
});

// ---------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return hex(new Uint8Array(digest));
}

/** Every string reachable in a plain JSON value. */
function allStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) allStrings(item, found);
  }
  return found;
}