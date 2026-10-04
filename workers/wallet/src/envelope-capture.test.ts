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

/**
 * Key shapes this file generates.
 *
 * A local union rather than `KeyAlgorithm`, because the DOM/worker lib type in
 * this project does not carry `namedCurve` or `modulusLength`, so a real
 * algorithm specification does not typecheck against it. The cast in
 * `generateTestKey` is where that is absorbed, once.
 */
type TestKeyAlgorithm =
  | { name: 'ECDSA'; namedCurve: 'P-256' | 'P-384' | 'P-521' }
  | {
      name: 'RSASSA-PKCS1-v1_5';
      modulusLength: number;
      publicExponent: Uint8Array;
      hash: 'SHA-256';
    };

const P256: TestKeyAlgorithm = { name: 'ECDSA', namedCurve: 'P-256' };

const RSA_2048: TestKeyAlgorithm = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

async function generateTestKey(alg: TestKeyAlgorithm = P256) {
  const pair = (await crypto.subtle.generateKey(
    alg as unknown as AlgorithmIdentifier,
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { privateKey: pair.privateKey, spkiBase64: bytesToBase64(spki) };
}

async function signLikeGoogle(key: CryptoKey, parts: readonly string[]): Promise<string> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, toLengthValue(parts)),
  );
  return bytesToBase64(p1363ToDer(raw));
}

/**
 * Sign with whatever the key is, so a non-ECDSA envelope can be built.
 *
 * Only the capture's *shape* reporting is under test, and the DER encoding is
 * Google's ECDSA convention rather than a property of the capture. An RSA
 * signature is emitted raw, which is what RSA actually produces — running it
 * through `p1363ToDer` would fabricate a DER SEQUENCE over a value that is not
 * one, and the fixture would then be lying about the very byte layout the DER
 * edge assertions exist to read.
 */
async function signWith(
  key: CryptoKey,
  algorithm: TestKeyAlgorithm,
  parts: readonly string[],
): Promise<string> {
  const params = (
    algorithm.name === 'ECDSA'
      ? { name: 'ECDSA', hash: 'SHA-256' }
      : { name: algorithm.name }
  ) as AlgorithmIdentifier;
  const raw = new Uint8Array(await crypto.subtle.sign(params, key, toLengthValue(parts)));
  return algorithm.name === 'ECDSA' ? bytesToBase64(p1363ToDer(raw)) : bytesToBase64(raw);
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
async function wellFormedEnvelope(intermediateAlgorithm?: TestKeyAlgorithm) {
  const root = await generateTestKey();
  const intermediate = await generateTestKey(intermediateAlgorithm);
  const intermediateAlg: TestKeyAlgorithm = intermediateAlgorithm ?? P256;

  const signedKey = JSON.stringify({
    keyValue: intermediate.spkiBase64,
    keyExpiration: '1754778096000',
  });

  const keySignature = await signLikeGoogle(root.privateKey, [SENDER, PROTOCOL, signedKey]);
  const messageSignature = await signWith(intermediate.privateKey, intermediateAlg, [
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
// A real Google delivery
// ---------------------------------------------------------------------------

/**
 * A body captured from a live Google Wallet loyalty callback.
 *
 * The only artefact here that came from Google rather than from this file, and
 * the reason the two tests that use it exist: it settles, against a real
 * delivery, the two things the investigation suspected.
 *
 * **Scrubbed, not verbatim.** Both the intermediate key and the message signature
 * have their leading `0x30` flipped to `0x5C`. The DER shape and the lengths are
 * preserved and the material is gone, which is the right thing to do to a captured
 * envelope before committing it — but it means this fixture cannot exercise the
 * DER reader, and `algorithm` and `derSequence` legitimately report `unreadable`
 * and `false` on it. `callbacks.test.ts` describes the same fixture as verbatim.
 */
const REAL_LOYALTY_CALLBACK = JSON.stringify({
  signature:
    'XEUCIQCJi26vl+ak17dsHDbZZnRZxm51duUAPiYLwOIr9rVvAAIgGUfR18gpKTq1+Msav0vPrWvC6x9dDRwWFX/b85+jE1k=',
  intermediateSigningKey: {
    signedKey:
      '{"keyValue":"XFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVsEtOdPMaE+DJDzuCJaO7EJXaHor4Kyklp411iwfBa+5TmdbiEWUXzewA79H0PXjdyRMhKBY99+sh056JB75LQ==","keyExpiration":"1754778096000"}',
  },
  protocolVersion: 'ECv2SigningOnly',
  signedMessage:
    '{"classId":"1296031581681466393.LOYALTY_CLASS_dada6069-0799-44ec-a38d-c482484902e1","objectId":"1296031581681466393.LOYALTY_OBJECT_xxxxxxxxxxxxx","eventType":"save","expTimeMillis":1754114831806,"count":1,"nonce":"40a8e5af-5b7f-4ea4-b152-63d96858550e"}',
});

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

    it('reports a non-P-256 algorithm distinctly', async () => {
      // Guards against `algorithm: 'ECDSA P-256'` being hardcoded. With a P-256
      // fixture a hardcoded answer and a read answer are indistinguishable, so
      // the fixture has to disagree with the hardcoded value or the assertion
      // means nothing — which reversal testing showed it did not.
      const p384 = await captureCallbackEnvelope(
        (await wellFormedEnvelope({ name: 'ECDSA', namedCurve: 'P-384' })).body,
        ISSUER_ID,
      );
      const rsa = await captureCallbackEnvelope((await wellFormedEnvelope(RSA_2048)).body, ISSUER_ID);

      expect(p384.intermediateSigningKey.signedKey.algorithm).toBe('ECDSA P-384');
      expect(rsa.intermediateSigningKey.signedKey.algorithm).toBe('RSA');
    });

    // A real Google envelope, run through the capture. Present because it settles
    // the premise the investigation started from, and that premise was wrong: the
    // obvious suspects were a `recipientId` field and a protocol other than
    // `ECv2SigningOnly`, and a real delivery has neither.
    it('finds no recipientId and no other protocol field in a real envelope', async () => {
      const capture = await captureCallbackEnvelope(REAL_LOYALTY_CALLBACK, ISSUER_ID);

      // Exactly four fields, and none of them `recipientId`. It is a parameter the
      // verifier is given, never a field Google sends — so a capture built to look
      // for it in the envelope would report its absence forever.
      expect(capture.topLevelKeys).toEqual([
        'intermediateSigningKey',
        'protocolVersion',
        'signature',
        'signedMessage',
      ]);
      expect(capture.recipientId.presentInEnvelope).toBe(false);

      // And the protocol *is* `ECv2SigningOnly`, so "maybe loyalty passes use a
      // different protocol" is not the cause either.
      expect(capture.protocolVersion).toBe('ECv2SigningOnly');
      expect(capture.protocolVersionIsTheConfiguredOne).toBe(true);

      // The payload is JSON with the six documented fields, so the message stage
      // could have been reached had the key signature verified.
      expect(capture.signedMessage.isJson).toBe(true);
      expect(capture.signedMessage.jsonKeys).toEqual([
        'classId',
        'objectId',
        'eventType',
        'expTimeMillis',
        'count',
        'nonce',
      ]);
      expect(capture.derivedSignedBytes.keySignatureInput?.byteLength).toBe(207);
    });

    // The redaction, recorded rather than left as a surprise for whoever runs the
    // capture against this fixture next. Both the key and the signature in
    // `REAL_LOYALTY_CALLBACK` have their leading 0x30 flipped to 0x5C — the shape
    // is preserved, the material is gone. `callbacks.test.ts` calls the fixture
    // "verbatim"; it is scrubbed in exactly these two places.
    it('reports the scrubbed fixture as unreadable, not as a P-256 key', async () => {
      const capture = await captureCallbackEnvelope(REAL_LOYALTY_CALLBACK, ISSUER_ID);

      expect(capture.intermediateSigningKey.signedKey.keyValueByteLength).toBe(91);
      expect(capture.intermediateSigningKey.signedKey.algorithm).toBe('unreadable');
      expect(capture.messageSignature.byteLength).toBe(71);
      expect(capture.messageSignature.derSequence).toBe(false);
      expect(capture.messageSignature.firstByteHex).toBe('5c');
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

    it('never emits a string long enough to be key material, even for a big key', async () => {
      // A P-256 `signedKey` is 171 characters, which is *under* the 220 bound
      // below — so asserting only against it would let a leak of exactly that key
      // pass. An RSA-2048 envelope is ~440 characters, which puts the bound under
      // real pressure: emitting any slice of it trips the assertion.
      const { body, keyValue } = await wellFormedEnvelope(RSA_2048);
      expect(body.length).toBeGreaterThan(400);

      const capture = await captureCallbackEnvelope(body, ISSUER_ID);

      for (const value of allStrings(capture)) {
        expect(value.length).toBeLessThanOrEqual(220);
      }
      expect(JSON.stringify(capture)).not.toContain(keyValue);
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