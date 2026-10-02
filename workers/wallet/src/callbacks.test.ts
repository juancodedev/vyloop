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
  /** Ship no `signatures` on the intermediate key. */
  omitKeySignatures?: boolean;
  protocolVersion?: string;
}): Promise<string> {
  const event = { ...DEFAULT_EVENT, ...(options.event ?? {}) };
  const signedMessage = JSON.stringify(event);

  const signedKeyString = JSON.stringify({
    keyValue: options.intermediateKey.spkiBase64,
    keyExpiration: '1791510690205',
  });

  const keySignature = await signLikeGoogle(options.rootKey.privateKey, [
    CALLBACK_SENDER_ID,
    CALLBACK_PROTOCOL_VERSION,
    options.signKeyOverride ?? signedKeyString,
  ]);

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
 * A body captured from a live Google Wallet loyalty callback, verbatim.
 *
 * Kept because it is the only artefact here that came from Google rather than
 * from this test file, and it disagrees with the task brief in two ways that
 * both matter: `eventType` is `"save"` and not `"SAVE"`, and the event fields are
 * inside `signedMessage` and not at the top level.
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

    it('refuses an intermediate key that ships no signature at all', async () => {
      const rootKey = await generateTestKey();
      const intermediateKey = await generateTestKey();

      const body = await buildCallback({ rootKey, intermediateKey, omitKeySignatures: true });

      await expect(verifyPassCallback(body, verifier(rootKey))).rejects.toMatchObject({
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
    // The refusal code is deliberately not pinned. This capture carries no
    // `intermediateSigningKey.signatures` array, so it is turned away at the
    // envelope check rather than at the signature check — and which of the two
    // fires first is an implementation detail, not a contract. What is asserted
    // is the only thing that matters: it does not get in.
    const rootKey = await generateTestKey();

    await expect(
      verifyPassCallback(REAL_LOYALTY_CALLBACK, verifier(rootKey)),
    ).rejects.toBeInstanceOf(PassCallbackVerificationError);
  });

  it('carries no intermediateSigningKey.signatures, which needs a live capture to confirm', () => {
    // UNVERIFIED, and stated rather than buried. Google's documented algorithm
    // requires the intermediate key to be signed by a root key, and the Tink
    // reference implementation reads those signatures from
    // `intermediateSigningKey.signatures` — so they are required here, and
    // failing closed without them is the right default.
    //
    // But the one real loyalty callback captured in the wild, and reproduced
    // verbatim above, has no `signatures` array: only `signedKey`. The same
    // capture's `ECv2` counterpart (a payment token, a different protocol) does
    // carry one, which is why the omission may be a documentation artefact of
    // the source this fixture came from rather than something Google does.
    //
    // If Google genuinely omits it for pass callbacks, this endpoint will refuse
    // 100% of real deliveries — loudly, with `intermediate_key_unverified` or
    // `malformed_envelope`, and with nothing written. The opposite failure, which
    // this design refuses to accept, is accepting an envelope whose key was
    // never shown to be Google's.
    //
    // This is the one assumption in the callback path that a single live capture
    // settles. Until it does, the endpoint is correct-by-refusal rather than
    // correct-by-acceptance.
    const envelope = JSON.parse(REAL_LOYALTY_CALLBACK) as {
      intermediateSigningKey: Record<string, unknown>;
    };

    expect(envelope.intermediateSigningKey.signatures).toBeUndefined();
  });
});
