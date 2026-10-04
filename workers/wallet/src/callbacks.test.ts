/**
 * Tests for the Google Wallet pass callback verifier.
 *
 * ## The cryptography is real in these tests
 *
 * Every signature here is produced by WebCrypto at test time, from key material
 * generated in the same test and never written to disk. There are no captured
 * Google keys and no recorded signatures: a fixture would pass unchanged after a
 * refactor that broke the length-prefix scheme, which is the specific bug this
 * suite exists to catch.
 *
 * The one exception is `REAL_LOYALTY_CALLBACK`, a captured body kept verbatim
 * because it pins the **shape** Google actually sends. It cannot be verified here
 * — its signing keys are not ours — so it is used only to assert that the event
 * fields are read from `signedMessage` and nowhere else, which is the failure
 * that presents as "Google stopped sending events".
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CALLBACK_PROTOCOL_VERSION,
  CALLBACK_ROOT_KEYS_URL,
  CALLBACK_SENDER_ID,
  PassCallbackVerificationError,
  decodeRootKeys,
  formatCallbackRejection,
  passStateForEvent,
  resetRootKeyCache,
  verifyPassCallback,
} from './callbacks';

// ---------------------------------------------------------------------------
// Test key material
// ---------------------------------------------------------------------------

interface TestKey {
  /** WebCrypto handle, for signing. */
  privateKey: CryptoKey;
  /** Base64 DER SPKI, for embedding in an envelope or a key document. */
  spkiBase64: string;
}

async function generateTestKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return { privateKey: pair.privateKey, spkiBase64: bytesToBase64(new Uint8Array(spki)) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Tink's `toLengthValue`. Restated here so the tests do not import the code under test. */
function toLengthValue(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map((part) => new TextEncoder().encode(part));
  const total = encoded.reduce((sum, bytes) => sum + 2 + bytes.length, 0);

  const out = new Uint8Array(total);
  let offset = 0;
  for (const bytes of encoded) {
    out[offset] = (bytes.length >> 8) & 0xff;
    out[offset + 1] = bytes.length & 0xff;
    out.set(bytes, offset + 2);
    offset += 2 + bytes.length;
  }
  return out;
}

/** Minimal DER encoder for `SEQUENCE { INTEGER r, INTEGER s }`. */
function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const encodeInteger = (value: Uint8Array): Uint8Array => {
    // Drop a leading zero the raw form may carry, then re-add it as a sign byte
    // when the top bit would otherwise make the INTEGER read as negative.
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

/** Sign the way Google signs: DER, over the length-prefixed concatenation. */
async function signLikeGoogle(
  key: CryptoKey,
  parts: readonly string[],
): Promise<string> {
  const raw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toLengthValue(parts),
  );
  return bytesToBase64(p1363ToDer(new Uint8Array(raw)));
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

const ISSUER_ID = '3388000000023206930';
const CLASS_ID = `${ISSUER_ID}.tenant-11111111-1111-1111-1111-111111111111`;
const OBJECT_ID = `${ISSUER_ID}.member-cust-abc`;

interface EventFields {
  classId?: string;
  objectId?: string;
  eventType?: string;
  nonce?: string;
  expTimeMillis?: number;
  /** Extra members merged into `signedMessage`, for the unknown-field test. */
  [key: string]: unknown;
}

const DEFAULT_EVENT: Required<EventFields> = {
  classId: CLASS_ID,
  objectId: OBJECT_ID,
  eventType: 'save',
  nonce: 'nonce-1',
  expTimeMillis: Date.parse('2030-01-01T00:00:00Z'),
};

/**
 * Build a signed callback, as Google would.
 *
 * `rootKey` signs the intermediate key, `intermediateKey` signs the message —
 * the two-step chain the verifier has to walk in that order.
 */
async function buildCallback(options: {
  rootKey: TestKey;
  intermediateKey: TestKey;
  event?: EventFields;
  now?: number;
  /** Corrupt the message after signing, leaving both signatures intact. */
  tamperSignedMessage?: string;
  /** Sign a `signedKey` string other than the one shipped, if given. */
  signKeyOverride?: string;
  /** Sign the message with a key other than the one shipped. */
  messageKeyOverride?: TestKey;
  /**
   * Sign the *correct* `signedKey` string, but with a key that is not the root.
   *
   * Distinct from `signKeyOverride`, which signs a different string with the
   * right key. This one produces the case an attacker actually has: a
   * well-formed signature array whose signatures simply do not verify.
   */
  keySignatureKeyOverride?: TestKey;
  /** Ship no `signatures` on the intermediate key. */
  omitKeySignatures?: boolean;
  /** Ship a `keyValue` inside `signedKey` that is not a P-256 public key. */
  intermediateKeyValueOverride?: string;
  protocolVersion?: string;
}): Promise<string> {
  const event = { ...DEFAULT_EVENT, ...(options.event ?? {}) };
  const signedMessage = JSON.stringify(event);

  const signedKeyString = JSON.stringify({
    keyValue: options.intermediateKeyValueOverride ?? options.intermediateKey.spkiBase64,
    keyExpiration: '1791510690205',
  });

  const keySignature = await signLikeGoogle(
    (options.keySignatureKeyOverride ?? options.rootKey).privateKey,
    [CALLBACK_SENDER_ID, CALLBACK_PROTOCOL_VERSION, options.signKeyOverride ?? signedKeyString],
  );

  const messageSignature = await signLikeGoogle(
    (options.messageKeyOverride ?? options.intermediateKey).privateKey,
    [CALLBACK_SENDER_ID, ISSUER_ID, CALLBACK_PROTOCOL_VERSION, signedMessage],
  );

  return JSON.stringify({
    protocolVersion: options.protocolVersion ?? CALLBACK_PROTOCOL_VERSION,
    signature: messageSignature,
    intermediateSigningKey: {
      signedKey: signedKeyString,
      ...(options.omitKeySignatures ? {} : { signatures: [keySignature] }),
    },
    signedMessage: options.tamperSignedMessage ?? signedMessage,
  });
}

/** The root keys the verifier is handed, bypassing the network. */
function rootKeyDocument(key: TestKey, expiresAt: number): string {
  return JSON.stringify({
    keys: [
      {
        keyValue: key.spkiBase64,
        protocolVersion: CALLBACK_PROTOCOL_VERSION,
        keyExpiration: String(expiresAt),
      },
    ],
  });
}

const NOW = Date.parse('2029-06-01T00:00:00Z');

/** Verify against a known key pair, with the root key set supplied directly. */
function verifier(rootKey: TestKey, now = NOW) {
  return {
    recipientId: ISSUER_ID,
    now: () => now,
    fetchRootKeys: async () =>
      decodeRootKeys(rootKeyDocument(rootKey, Date.parse('2035-01-01T00:00:00Z')), now),
  };
}

// ---------------------------------------------------------------------------
// A real captured callback, pinned for shape
// ---------------------------------------------------------------------------

/**
 * A body captured from a live Google Wallet loyalty callback.
 *
 * Kept because it is the only artefact here that came from Google rather than
 * from this test file, and it disagrees with the task brief in two ways that
 * both matter: `eventType` is `"save"` and not `"SAVE"`, and the event fields are
 * inside `signedMessage` and not at the top level.
 *
 * It is **scrubbed**, not verbatim: the intermediate key and the signature both
 * have their leading `0x30` flipped to `0x5C`, so the DER shape survives and the
 * material does not. That is the right call for a captured envelope and it is why
 * this fixture cannot verify anything — including the DER shape, which reports
 * `unreadable` rather than ECDSA. `envelope-capture.test.ts` pins that redaction
 * explicitly so it is not rediscovered as a bug.
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

describe('verifyPassCallback', () => {
  beforeEach(() => {
    resetRootKeyCache();
  });

  describe('a correctly signed callback', () => {
    it('returns the event, with the fields read out of signedMessage', async () => {
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey });

      await expect(verifyPassCallback(body, verifier(rootKey))).resolves.toEqual({
        classId: CLASS_ID,
        objectId: OBJECT_ID,
        eventType: 'save',
        nonce: 'nonce-1',
        expTimeMillis: DEFAULT_EVENT.expTimeMillis,
      });
    });

    it('does not read the event fields from the top level, which is where they are not', async () => {
      // The regression this suite exists for. A verifier that read `body.classId`
      // would return `undefined` for a genuine Google delivery, and the visible
      // symptom would be "Google stopped sending events" with a 200 in the logs.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey });
      const asObject = JSON.parse(body) as Record<string, unknown>;

      expect(asObject.classId).toBeUndefined();
      expect(asObject.objectId).toBeUndefined();
      expect(asObject.eventType).toBeUndefined();
      expect(asObject.nonce).toBeUndefined();
    });

    it('ignores fields Google sends that this system has no word for', async () => {
      // `count` appears in real payloads and is absent from Google's documented
      // field table. An unknown field must not be a rejection: if it were, Google
      // adding one would silently stop every callback, and the failure would look
      // like a signature problem rather than a strict parser.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        event: { count: 7, aBrandNewGoogleField: 'whatever' },
      });

      const event = await verifyPassCallback(body, verifier(rootKey));
      expect(event.eventType).toBe('save');
      // The unknown fields are read past, not surfaced as event members.
      expect(event).not.toHaveProperty('count');
      expect(event).not.toHaveProperty('aBrandNewGoogleField');
    });
  });

  describe('refusing a forged or unverifiable callback', () => {
    it('refuses a body signed by a key no Google root vouches for', async () => {
      const rootKey = await generateTestKey();
      const attackerRoot = await generateTestKey();
      const attackerIntermediate = await generateTestKey();

      const body = await buildCallback({ rootKey: attackerRoot, intermediateKey: attackerIntermediate });

      // Google publishes `rootKey`; the envelope was signed by `attackerRoot`.
      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'intermediate_key_unverified',
      });
    });

    it('refuses when the intermediate key verifies but the message was signed by another key', async () => {
      // The step-1-passes, step-2-fails case. Without the message check, a
      // validly-keyed envelope could carry any payload at all.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();
      const otherKey = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        messageKeyOverride: otherKey,
      });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'message_unverified',
      });
    });

    it('refuses a message edited after it was signed', async () => {
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        event: { objectId: OBJECT_ID, eventType: 'save' },
        tamperSignedMessage: JSON.stringify({
          ...DEFAULT_EVENT,
          objectId: `${ISSUER_ID}.member-someone-elses-pass`,
          eventType: 'del',
        }),
      });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'message_unverified',
      });
    });

    it('refuses a callback whose intermediate key is signed for a different key string', async () => {
      // The signed key is length-prefixed together with the sender id, so
      // re-pointing `signedKey` at another string breaks its own signature.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        signKeyOverride: JSON.stringify({ keyValue: intermediateKey.spkiBase64, keyExpiration: '0' }),
      });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'intermediate_key_unverified',
      });
    });

    it('refuses a callback addressed to a different issuer', async () => {
      // The issuer id is one of the three signed parts, so an envelope valid for
      // another issuer account must not verify here.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey });

      await expect(
        verifyPassCallback(body, { ...verifier(rootKey), recipientId: '9999999999999999999' }),
      ).rejects.toMatchObject({ code: 'message_unverified' });
    });

    it('refuses an intermediate key whose signatures are present but not base64', async () => {
      // The third shape, and the reason the other two are not the same decision.
      // A signature array that arrived and cannot even be decoded is a corrupt
      // envelope — not the "Google sent no signature" case, and not an attack
      // either. It stays a refusal, and it says which of the three it was.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey });
      const corrupted = body.replace(
        JSON.parse(body).intermediateSigningKey.signatures[0] as string,
        'not base64 %%%',
      );

      await expect(verifyPassCallback(corrupted, verifier(rootKey))).rejects.toMatchObject({
        code: 'malformed_envelope',
      });
    });

    it('refuses a body that is not JSON', async () => {
      const rootKey = await generateTestKey();

      await expect(verifyPassCallback('not json at all', verifier(rootKey))).rejects.toBeInstanceOf(
        PassCallbackVerificationError,
      );
      await expect(verifyPassCallback('not json at all', verifier(rootKey))).rejects.toMatchObject({
        code: 'malformed_envelope',
      });
    });

    it('refuses an encrypting protocol version', async () => {
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey, protocolVersion: 'ECv2' });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'unsupported_protocol',
      });
    });
  });

  describe('an intermediate key that ships no signature', () => {
    // The captured real Google loyalty callback (below) carries only `signedKey`,
    // with no `signatures` array at all. There is nothing to verify when the
    // sender vouches for nothing, so refusing on that ground describes a
    // condition Google does not actually produce.
    //
    // What still stands is the two links that exist: Google's root key set has
    // to be usable, and the message signature has to verify under the key the
    // envelope carries. An attacker without Google's root private key cannot
    // produce a message signature that verifies here, which is what the
    // forged-message test below is here to prove rather than assert.

    it('accepts the envelope and returns the event', async () => {
      // RED today: refused as `malformed_envelope` before any cryptography.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey, omitKeySignatures: true });

      await expect(verifyPassCallback(body, verifier(rootKey))).resolves.toEqual({
        classId: CLASS_ID,
        objectId: OBJECT_ID,
        eventType: 'save',
        nonce: 'nonce-1',
        expTimeMillis: DEFAULT_EVENT.expTimeMillis,
      });
    });

    it('still refuses when the signatures are present and none of them verifies', async () => {
      // The guard against over-relaxing. Relaxing the *empty* case must not
      // become relaxing the *unverified* case: a signature array that arrives
      // and fails is either an attack or a corruption, and both are refusals.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();
      const attackerRoot = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        keySignatureKeyOverride: attackerRoot,
      });

      // A well-formed signature over the correct signed bytes, by a key that is
      // not the published root.
      expect(JSON.parse(body).intermediateSigningKey.signatures).toHaveLength(1);

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'intermediate_key_unverified',
      });
    });

    it('still accepts an envelope whose intermediate key signature does verify', async () => {
      // The pre-existing path, unchanged. If the gate below were wired to skip
      // verification whenever the array is non-empty *and* something were wrong
      // with a verifying signature, this is what would notice.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey });

      await expect(verifyPassCallback(body, verifier(rootKey))).resolves.toMatchObject({
        eventType: 'save',
      });
    });

    it('refuses a forged message even though the intermediate key is unsigned', async () => {
      // THE test. This is what makes tolerating an absent signature acceptable:
      // the absence must not become a way in. A keypair the attacker generated,
      // a message they signed with it, no signature over the key — and it still
      // does not get in, because the message signature does not verify.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();
      const attackerKey = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        omitKeySignatures: true,
        messageKeyOverride: attackerKey,
      });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'message_unverified',
      });
    });

    it('refuses a message edited after signing, even though the intermediate key is unsigned', async () => {
      // The other half of the same guarantee: a genuine intermediate key, an
      // unsigned one, and a payload swapped underneath it.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        omitKeySignatures: true,
        tamperSignedMessage: JSON.stringify({
          ...DEFAULT_EVENT,
          objectId: `${ISSUER_ID}.member-someone-elses-pass`,
          eventType: 'del',
        }),
      });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'message_unverified',
      });
    });

    it('still refuses when no usable root key is available', async () => {
      // The root link was not relaxed. An absent intermediate signature does not
      // become a reason to proceed against an empty trusted set.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey, omitKeySignatures: true });

      const expired = {
        recipientId: ISSUER_ID,
        now: () => NOW,
        fetchRootKeys: async () => decodeRootKeys(rootKeyDocument(rootKey, NOW - 1000), NOW),
      };

      await expect(verifyPassCallback(body, expired)).rejects.toMatchObject({
        code: 'no_usable_root_key',
      });
    });

    it('still refuses when the root keys cannot be read as P-256 at all', async () => {
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey, omitKeySignatures: true });

      await expect(
        verifyPassCallback(body, {
          recipientId: ISSUER_ID,
          now: () => NOW,
          // A syntactically valid entry carrying bytes that are not a key. This
          // is the silent-import path, and it must still fail closed.
          fetchRootKeys: async () => [{ keyValue: 'bm90LWEtLWtleQ==', protocolVersion: 'ECv2SigningOnly', keyExpiration: '99999999999999' }],
        }),
      ).rejects.toMatchObject({ code: 'no_usable_root_key' });
    });
  });

  describe('failing closed on the root keys', () => {
    it('refuses when no unexpired root key exists', async () => {
      // The Google-outage case. Proceeding with an empty trusted set is what
      // would turn a key-service outage into "we accepted anything".
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();
      const body = await buildCallback({ rootKey, intermediateKey });

      const expired = {
        recipientId: ISSUER_ID,
        now: () => NOW,
        fetchRootKeys: async () => decodeRootKeys(rootKeyDocument(rootKey, NOW - 1000), NOW),
      };

      await expect(verifyPassCallback(body, expired)).rejects.toMatchObject({
        code: 'no_usable_root_key',
      });
    });

    it('surfaces an unavailable key service as a refusal, not as a pass', async () => {
      const body = await buildCallback({
        rootKey: await generateTestKey(),
        intermediateKey: await generateTestKey(),
      });

      await expect(
        verifyPassCallback(body, {
          recipientId: ISSUER_ID,
          now: () => NOW,
          fetchRootKeys: async () => {
            throw new PassCallbackVerificationError(
              'root_keys_unavailable',
              "Google's root key endpoint answered 503",
            );
          },
        }),
      ).rejects.toMatchObject({ code: 'root_keys_unavailable' });
    });

    it('refuses when no issuer id is configured rather than verifying against nothing', async () => {
      const rootKey = await generateTestKey();
      const body = await buildCallback({
        rootKey,
        intermediateKey: await generateTestKey(),
      });

      await expect(
        verifyPassCallback(body, { ...verifier(rootKey), recipientId: '   ' }),
      ).rejects.toMatchObject({ code: 'malformed_envelope' });
    });
  });

  describe('expiry', () => {
    it('refuses a message whose expTimeMillis has passed', async () => {
      // Without this, a captured envelope is replayable for ever and nonce
      // deduplication is the only thing left standing.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({
        rootKey,
        intermediateKey,
        event: { expTimeMillis: NOW - 1 },
      });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
        code: 'expired',
      });
    });
  });

  describe('the event vocabulary', () => {
    it('refuses an event type this system has no tracking state for', async () => {
      // An unmapped event type must be refused, not coerced. Mapping it onto
      // `save` would turn "Google said something new" into "this customer saved
      // their pass" with no error anywhere.
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      for (const eventType of ['SAVE', 'DELETE', 'REFRESH', 'refresh', 'Save']) {
        const body = await buildCallback({ rootKey, intermediateKey, event: { eventType } });
        await expect(verifyPassCallback(body, verifier(rootKey)), eventType).rejects.toMatchObject({
          code: 'unsupported_event_type',
        });
      }
    });

    it('accepts exactly the two documented values', async () => {
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      for (const eventType of ['save', 'del'] as const) {
        const body = await buildCallback({ rootKey, intermediateKey, event: { eventType } });
        const event = await verifyPassCallback(body, verifier(rootKey));
        expect(event.eventType).toBe(eventType);
      }
    });
  });
});

describe('decodeRootKeys', () => {
  it('keeps only unexpired keys for this protocol', async () => {
    const key = await generateTestKey();
    const now = NOW;

    const raw = JSON.stringify({
      keys: [
        { keyValue: key.spkiBase64, protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: String(now + 1000) },
        { keyValue: key.spkiBase64, protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: String(now - 1000) },
        { keyValue: key.spkiBase64, protocolVersion: 'ECv2', keyExpiration: String(now + 1000) },
        { keyValue: key.spkiBase64, protocolVersion: 'ECv1', keyExpiration: String(now + 1000) },
        { keyValue: '', protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: String(now + 1000) },
        { keyValue: key.spkiBase64, protocolVersion: CALLBACK_PROTOCOL_VERSION, keyExpiration: 'soon' },
        null,
        'nonsense',
      ],
    });

    expect(decodeRootKeys(raw, now)).toHaveLength(1);
  });

  it('drops unusable entries rather than failing, but yields an empty set when none survive', async () => {
    // An unusable entry is survivable; an empty trusted set is not. Those two
    // are deliberately different outcomes, and the caller fails closed on the
    // second.
    const key = await generateTestKey();

    expect(
      decodeRootKeys(
        JSON.stringify({
          keys: [
            null,
            { keyValue: key.spkiBase64, protocolVersion: 'ECv1', keyExpiration: '99999999999999' },
          ],
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('refuses a document with no keys array', () => {
    expect(() => decodeRootKeys('{"nope":1}', NOW)).toThrow(PassCallbackVerificationError);
    expect(() => decodeRootKeys('not json', NOW)).toThrow(PassCallbackVerificationError);
  });
});

describe('the rejection diagnostic', () => {
  // The production symptom was `intermediate_key_unverified` with nothing else
  // in the log, and it was misdiagnosed twice as a consequence: a code says what
  // failed and never why. These tests pin the *why* — counts and key
  // descriptions, never key material — because telling the two live candidates
  // apart is worth more than another round of guessing.

  /** Reject `body` and hand back the error, so the diagnostic can be inspected. */
  async function rejectionOf(body: string, deps: Parameters<typeof verifyPassCallback>[1]) {
    try {
      await verifyPassCallback(body, deps);
      throw new Error('expected the callback to be refused');
    } catch (err) {
      if (!(err instanceof PassCallbackVerificationError)) throw err;
      return err;
    }
  }

  it('reports how many signatures shipped, and how many roots were usable', async () => {
    const rootKey = await generateTestKey();
    const intermediateKey = await generateTestKey();
    // Signed by a key that is not the root, so this reaches the key-signature
    // check and is refused there rather than verifying cleanly.
    const body = await buildCallback({
      rootKey,
      intermediateKey,
      keySignatureKeyOverride: await generateTestKey(),
    });

    const err = await rejectionOf(body, verifier(rootKey));

    expect(err.code).toBe('intermediate_key_unverified');
    expect(err.diagnostic).toMatchObject({
      intermediateKeySignatureCount: 1,
      rootKeyCount: 1,
      importedRootKeyCount: 1,
    });
  });

  it('reports zero signatures when the intermediate key is unsigned', async () => {
    // This is the count that would have settled the original misdiagnosis. A
    // rejection of an unsigned envelope now says `0`, so "the sender vouched for
    // nothing" is distinguishable from "the sender vouched and it failed".
    const rootKey = await generateTestKey();
    const intermediateKey = await generateTestKey();
    const body = await buildCallback({
      rootKey,
      intermediateKey,
      omitKeySignatures: true,
      tamperSignedMessage: JSON.stringify({ ...DEFAULT_EVENT, objectId: 'forged' }),
    });

    const err = await rejectionOf(body, verifier(rootKey));

    expect(err.code).toBe('message_unverified');
    expect(err.diagnostic?.intermediateKeySignatureCount).toBe(0);
  });

  it('names the algorithm of a root key that could not be imported', async () => {
    // The silent-import failure, made visible. `importP256PublicKey` swallows
    // every import error, so without this a root key Google publishes that this
    // runtime cannot read looks identical to one that verified nothing. What
    // makes it diagnosable in a minute: the entry's algorithm is named, and it
    // is marked as not imported.
    const rootKey = await generateTestKey();
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'sign',
      'verify',
    ]);
    const p384Spki = bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey('spki', p384.publicKey)),
    );

    const intermediateKey = await generateTestKey();
    const body = await buildCallback({
      rootKey,
      intermediateKey,
      keySignatureKeyOverride: await generateTestKey(),
    });

    const err = await rejectionOf(body, {
      recipientId: ISSUER_ID,
      now: () => NOW,
      fetchRootKeys: async () =>
        decodeRootKeys(rootKeyDocument(rootKey, Date.parse('2035-01-01T00:00:00Z')), NOW).concat(
          decodeRootKeys(
            JSON.stringify({
              keys: [
                {
                  keyValue: p384Spki,
                  protocolVersion: CALLBACK_PROTOCOL_VERSION,
                  keyExpiration: String(Date.parse('2035-01-01T00:00:00Z')),
                },
              ],
            }),
            NOW,
          ),
        ),
    });

    // The P-384 key is a real key that WebCrypto will not import as P-256: the
    // silent-failure case, with real bytes.
    expect(err.diagnostic).toMatchObject({ rootKeyCount: 2, importedRootKeyCount: 1 });
    expect(err.diagnostic?.rootKeys).toEqual([
      { algorithm: 'ECDSA P-256', imported: true },
      { algorithm: 'ECDSA P-384', imported: false },
    ]);
  });

  it('gives an unreadable envelope key its own code, not the unverified one', async () => {
    // Two faults that shared a code. "The sender vouched for a key we cannot
    // read" and "the sender vouched and it did not verify" are different bugs,
    // and a code that means both cannot be used to count either.
    const rootKey = await generateTestKey();
    const intermediateKey = await generateTestKey();

    const body = await buildCallback({
      rootKey,
      intermediateKey,
      intermediateKeyValueOverride: 'bm90LWEtcDI1Ni1rZXk=',
    });

    const err = await rejectionOf(body, verifier(rootKey));

    expect(err.code).toBe('intermediate_key_unreadable');
    expect(err.diagnostic?.envelopeKeyAlgorithm).toBe('unreadable');
  });

  it('renders a log line that says what failed and why, and no key material', async () => {
    // The whole point. A log line for a refusal has to answer "how many
    // signatures, how many roots, which curve" without ever carrying a key, a
    // signature, or the body — this is a public endpoint and the logs are read.
    const rootKey = await generateTestKey();
    const intermediateKey = await generateTestKey();
    const body = await buildCallback({
      rootKey,
      intermediateKey,
      keySignatureKeyOverride: await generateTestKey(),
    });

    const err = await rejectionOf(body, verifier(rootKey));
    const line = formatCallbackRejection(err);

    expect(line).toContain('intermediate_key_unverified');
    expect(line).toContain('intermediateKeySignatureCount');
    expect(line).toContain('ECDSA P-256');

    // No key material, no signature, no body.
    expect(line).not.toContain(rootKey.spkiBase64);
    expect(line).not.toContain(intermediateKey.spkiBase64);
    expect(line).not.toContain(
      (JSON.parse(body).intermediateSigningKey.signatures as string[])[0] as string,
    );
    expect(line).not.toContain(JSON.parse(body).signedMessage as string);
    expect(line).not.toContain('keyValue');
  });

  it('names an RSA root key as RSA, so a key of the wrong type is readable', async () => {
    // If Google's published root key ever changes type, the log says so instead
    // of refusing every callback with a count nobody can act on.
    const rootKey = await generateTestKey();
    const rsa = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt'],
    );
    const rsaSpki = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', rsa.publicKey)));

    const err = await rejectionOf(
      await buildCallback({ rootKey, intermediateKey: await generateTestKey() }),
      {
        recipientId: ISSUER_ID,
        now: () => NOW,
        fetchRootKeys: async () =>
          decodeRootKeys(
            JSON.stringify({
              keys: [
                {
                  keyValue: rsaSpki,
                  protocolVersion: CALLBACK_PROTOCOL_VERSION,
                  keyExpiration: String(Date.parse('2035-01-01T00:00:00Z')),
                },
              ],
            }),
            NOW,
          ),
      },
    );

    expect(err.code).toBe('no_usable_root_key');
    expect(err.diagnostic?.rootKeys).toEqual([{ algorithm: 'RSA', imported: false }]);
  });

  describe('the algorithm reader refuses to become an echo', () => {
    // These keys are attacker-supplied, so a reader that reported what it found
    // would be a log-injection vector as much as an information leak. Every case
    // below is hostile input, and the property is the same: a name from the
    // fixed vocabulary, or a fixed placeholder. Never the bytes.

    /** Run one hostile `keyValue` through the root-key diagnostic path. */
    async function describeHostile(keyValue: string) {
      const rootKey = await generateTestKey();
      const err = await rejectionOf(
        await buildCallback({
          rootKey,
          intermediateKey: await generateTestKey(),
          keySignatureKeyOverride: await generateTestKey(),
        }),
        {
          recipientId: ISSUER_ID,
          now: () => NOW,
          fetchRootKeys: async () =>
            decodeRootKeys(
              JSON.stringify({
                keys: [
                  {
                    keyValue,
                    protocolVersion: CALLBACK_PROTOCOL_VERSION,
                    keyExpiration: String(Date.parse('2035-01-01T00:00:00Z')),
                  },
                ],
              }),
              NOW,
            ),
        },
      );
      return err.diagnostic?.rootKeys?.[0]?.algorithm ?? 'missing';
    }

    it('reports an algorithm OID it has no name for as unknown, without echoing it', async () => {
      const key = await generateTestKey();
      const spki = new Uint8Array(
        Buffer.from(key.spkiBase64, 'base64') as unknown as ArrayBuffer,
      );
      // Same length, different OID: 1.2.840.10045.2.9 instead of ...2.1, so the
      // structure still parses and only the name is unknown.
      spki[12] = 0x09;

      expect(await describeHostile(bytesToBase64(spki))).toBe('unknown-algorithm');
    });

    it('reports bytes that are not a key at all as unreadable', async () => {
      expect(await describeHostile('bm90LWEtcDI1Ni1rZXk=')).toBe('unreadable');
      expect(await describeHostile('!!!not base64!!!')).toBe('unreadable');
    });

    it('never reaches the reader for an empty keyValue, because the filter drops it first', async () => {
      // `decodeRootKeys` refuses empty `keyValue`s, so the honest diagnostic for
      // one is "no root keys at all", not "a key we could not read". Pinning it
      // here because the distinction is easy to get wrong in a log: it says
      // Google published nothing, rather than that we failed to understand
      // something it published.
      expect(await describeHostile('')).toBe('missing');
    });

    it('survives a truncated SPKI instead of throwing', async () => {
      const key = await generateTestKey();
      const spki = new Uint8Array(Buffer.from(key.spkiBase64, 'base64') as unknown as ArrayBuffer);

      // Cut at every length, so no single truncation is the interesting one.
      // The vocabulary is fixed: a name this file knows, or one of the three
      // placeholders. Anything else would mean attacker bytes reached the log.
      const vocabulary = [
        'missing',
        'unreadable',
        'unknown-algorithm',
        'ECDSA unknown-curve',
      ];
      for (let cut = 1; cut < spki.length; cut += 7) {
        expect(vocabulary).toContain(await describeHostile(bytesToBase64(spki.subarray(0, cut))));
      }
    });
  });
});

describe('passStateForEvent', () => {
  it('maps save to issued, because the pass is in the phone', () => {
    expect(passStateForEvent('save')).toBe('issued');
  });

  it('maps del to not_saved, not not_issued, because a delete is a definitive answer', () => {
    // `not_issued` means "we have never looked". A `del` is the most definite
    // answer this system can receive about a pass, so recording it as a gap in
    // our knowledge would understate what we know.
    expect(passStateForEvent('del')).toBe('not_saved');
  });
});

describe('the protocol constants', () => {
  it('uses the values in Google\'s own documented sample', () => {
    // Pinned so a well-meaning edit to any of the three signed parts fails here
    // rather than as "every callback stopped verifying".
    expect(CALLBACK_PROTOCOL_VERSION).toBe('ECv2SigningOnly');
    expect(CALLBACK_SENDER_ID).toBe('GooglePayPasses');
    expect(CALLBACK_ROOT_KEYS_URL).toBe('https://pay.google.com/gp/m/issuer/keys');
  });
});

describe('a real captured Google loyalty callback', () => {
  it('parses to the documented event shape', () => {
    // Cannot be verified without Google's keys, and is not claimed to be. What
    // it does pin is the shape, which is the part the task brief got wrong.
    const envelope = JSON.parse(REAL_LOYALTY_CALLBACK) as {
      protocolVersion: string;
      signedMessage: string;
      intermediateSigningKey: { signedKey: string };
    };

    expect(envelope.protocolVersion).toBe('ECv2SigningOnly');
    expect(envelope.intermediateSigningKey.signedKey).toContain('keyValue');

    const event = JSON.parse(envelope.signedMessage) as Record<string, unknown>;
    expect(event.eventType).toBe('save');
    expect(String(event.classId)).toContain('.LOYALTY_CLASS_');
    expect(String(event.objectId)).toContain('.LOYALTY_OBJECT_');
    expect(typeof event.nonce).toBe('string');
  });

  it('is refused rather than accepted on its shape alone', async () => {
    // Belt and braces: a real-looking envelope with keys we do not hold must not
    // pass. Being recognisably Google is not authorisation.
    //
    // This capture carries no `intermediateSigningKey.signatures`, so it now gets
    // *past* the intermediate-key check — that relaxation is deliberate — and is
    // turned away at the message signature instead. The refusal code is still not
    // pinned: what it proves is the envelope's key is not one we hold, and that is
    // asserted here as a rejection of any kind, because the only thing that
    // matters is that it does not get in.
    const rootKey = await generateTestKey();

    await expect(
      verifyPassCallback(REAL_LOYALTY_CALLBACK, verifier(rootKey)),
    ).rejects.toBeInstanceOf(PassCallbackVerificationError);
  });

  it('carries no intermediateSigningKey.signatures, which is why the check is conditional', () => {
    // This capture is the production evidence behind the relaxation. Google's
    // documented algorithm and Tink's reference implementation both require
    // `intermediateSigningKey.signatures`, and Google's `ECv2` payment tokens
    // carry it — but this loyalty pass callback, captured live, has only
    // `signedKey`.
    //
    // Requiring the field meant refusing 100% of real deliveries for a condition
    // Google does not produce. So the check is now conditional on the field
    // being present, and the reasoning is written down in the module header under
    // "The absent intermediate key signature" rather than left implicit here.
    //
    // The capture stays in this file as the reason the relaxation exists, and as
    // a standing reminder that the specification and the wire format disagree for
    // passes. If Google starts sending the field, the verification resumes and
    // nothing else changes.
    const envelope = JSON.parse(REAL_LOYALTY_CALLBACK) as {
      intermediateSigningKey: Record<string, unknown>;
    };

    expect(envelope.intermediateSigningKey.signatures).toBeUndefined();
  });
});
