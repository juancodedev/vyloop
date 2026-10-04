/**
 * TEMPORARY — a diagnostic that describes the shape of a Google Wallet callback
 * envelope, so `intermediate_key_unverified` can finally be explained.
 *
 * **Still here on purpose, even though the cause is now known.** See "Why it is
 * not deleted yet" below.
 *
 * ## The fault this existed for, and what it turned out to be
 *
 * `verifyPassCallback` refuses with `intermediate_key_unverified` when the
 * envelope ships intermediate-key signatures and none of them verifies under any
 * current Google root key. Production logged exactly that. Measured against the
 * real verifier, every other candidate is eliminated by that code:
 *
 * - The root key imports (`importedRootKeyCount: 1`, algorithm ECDSA P-256), so
 *   the silent-import path is out.
 * - A non-empty signature array is required to reach that refusal at all, so an
 *   absent or empty array is out — and Google's own loyalty callbacks do ship
 *   none, which is a separate question this module does not answer.
 * - A wrong `protocolVersion` is out too, and provably: the verifier compares it
 *   to `CALLBACK_PROTOCOL_VERSION` *before* touching any signature and refuses
 *   with `unsupported_protocol`. A log line saying `intermediate_key_unverified`
 *   is itself proof that the envelope declared `ECv2SigningOnly`.
 *
 * What was left turned out to be real: **the bytes this worker signed were not the
 * bytes Google signed.** `callbacks.ts` wrote the length prefix as `uint16be`;
 * the protocol is `uint32le`. That is fixed — see `callbacks.ts`, "The bug this
 * file shipped with".
 *
 * ## Why it is not deleted yet
 *
 * The fix is not confirmed in production. No verifiable Google signature exists
 * in this repository, so the derivation is pinned to Google's published spec and
 * to the one real Google signature in the capture — not to an envelope this
 * verifier accepted end to end. Until a live save is observed actually persisting
 * a pass, this endpoint is the only instrument that can say what a real delivery
 * looks like. Delete it once that is confirmed, and not before.
 *
 * ## What this returns, and why each field earns its place
 *
 * Only shape: names, lengths, protocol values, and fingerprints. The operator
 * holds the raw envelope locally — they captured it to get here — so this
 * endpoint's job is to make the *comparison* possible, not to move bytes.
 *
 * | Field | Distinguishes |
 * | --- | --- |
 * | `topLevelKeys` | A field this code ignores. The verifier reads four of them; a fifth protocol-shaped field would be invisible to it. |
 * | `protocolVersion` | Read from the envelope, never the constant — a capture that echoed the configured value would answer the question it was built to ask with a foregone conclusion. |
 * | `signedMessage` length / prefix / JSON shape | Whether the message stage could ever have been reached. In production it never was: the key signature fails first. |
 * | `signedKey` length / JSON shape / SPKI algorithm | A mangled or non-P-256 intermediate key. Length and algorithm only — see below. |
 * | signature lengths and DER edge bytes | Whether the signature is DER at all, and whether anything is appended after the SEQUENCE. |
 * | `derivedSignedBytes.*.sha256` | **The field that closes the case.** A fingerprint of the exact bytes the verifier signs, computed from the envelope's own values. |
 *
 * ### `recipientId` is not in the envelope, and this says so
 *
 * The obvious place to look for the cause was `recipientId`: a wrong one would
 * make verification impossible forever, since the message signature is bound to
 * it. But `recipientId` is a parameter the verifier is *given*
 * (`GOOGLE_WALLET_ISSUER_ID`), not a field Google sends, and it does not appear in
 * the key signature's signed bytes at all. Measured with the real verifier: a
 * correct and an incorrect `recipientId` produce the *same*
 * `intermediate_key_unverified`, and a correct key signature with a wrong
 * `recipientId` fails later as `message_unverified`. So it cannot be the cause of
 * the observed refusal — it would only ever be the cause of the next one.
 *
 * `recipientId` is therefore reported as two separate facts, `presentInEnvelope`
 * and `configuredIssuerId`, so the distinction is visible in a log line rather
 * than assumed. `presentInEnvelope` being `false` on a real envelope is itself
 * the confirmation that the premise "the protocol field is in the envelope" was
 * wrong.
 *
 * ### Why `signedKey` gets no raw prefix
 *
 * The obvious design would echo the first 120 characters of `signedKey`, and it
 * would be a leak: `signedKey` is a JSON wrapper around a base64 DER SPKI public
 * key, so 120 characters is roughly 90 characters of key. The same report that
 * forbids exposing a byte of public key cannot also ask for one.
 *
 * What replaces it is strictly more decisive. The operator already holds
 * `signedKey` locally, so they can fingerprint any candidate construction
 * themselves and compare against `derivedSignedBytes.keySignatureInput.sha256`.
 * A fingerprint answers "do these bytes agree?" without moving the bytes. The
 * length, the JSON keys and the SPKI algorithm still come from the envelope, and
 * together they distinguish every malformed-key shape this code has a name for.
 *
 * ## The fingerprints, and why they are not a leak
 *
 * `derivedSignedBytes` is a SHA-256 over the length-prefixed concatenation the
 * verifier builds, reported in full (64 hex characters) rather than truncated:
 * a truncated digest is a weaker equality test and this value has no secrecy to
 * protect. The inputs are public — Google's public keys, a public issuer id, and
 * a payload Google itself just transmitted in the clear. Preimage resistance
 * makes the digest useless for forging anything, and there is nothing here to
 * brute-force: the "secret" would have to be the envelope.
 *
 * Its fingerprints are computed by a `toLengthValue` **restated in this file**
 * rather than imported from `callbacks.ts`. That is the whole point: a digest
 * computed by the same function it is meant to check would agree with a broken
 * implementation by construction and prove nothing. The two implementations must
 * be able to disagree, or this file cannot fail.
 *
 * ## What is never in here
 *
 * No key byte, no signature byte, no private material, no personal data. Field
 * names, lengths, protocol values and digests only. `envelope-capture.test.ts`
 * asserts that by searching the serialised response for the exact signature and
 * the exact public key the envelope carried, in base64, base64url and hex — the
 * test that makes this endpoint acceptable to deploy.
 *
 * ## Deletion
 *
 * See `ENVELOPE_CAPTURE_SUPERSEDED_BY`. This file, the route in `routes.ts`, the
 * gateway exemption, and this module's tests all go together the moment the real
 * signed-byte construction is confirmed.
 */

import { CALLBACK_PROTOCOL_VERSION, CALLBACK_SENDER_ID, describeSpkiKey } from './callbacks';

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The investigation this belongs to.
 *
 * Named in the module, the route's logs and its tests, so an operator reading a
 * log line in six weeks can find the reasoning and the deletion criteria.
 */
export const ENVELOPE_CAPTURE_TICKET = 'vyloop/#164 intermediate_key_unverified';

/**
 * Set this to the reference that closed the investigation — the fix's PR, or the
 * commit that confirmed the correct signed-byte construction — **and delete the
 * route in the same change**.
 *
 * `null` while the capture is still needed. The test
 * `has not been superseded — delete the route when it has` asserts it is `null`,
 * so the day somebody records the fix and forgets to delete the code, the suite
 * goes red with an instruction instead of the endpoint quietly outliving its
 * purpose. That is the failure this whole module is written against: a
 * diagnostic that nobody remembers is worse than no diagnostic, because it reads
 * as a permanent part of the system.
 */
export const ENVELOPE_CAPTURE_SUPERSEDED_BY: string | null = null;

/**
 * When this must be gone or re-decided.
 *
 * A temporary endpoint with no expiry is just a permanent one with a temporary
 * name. Seven days is chosen because the capture only helps while someone is
 * reproducing the save; past that the envelope that reproduces it has expired
 * (`expTimeMillis` is hours, not months) and a fresh diagnosis is needed anyway.
 */
export const ENVELOPE_CAPTURE_REVIEW_BY = '2026-10-11';

/**
 * The path, exported so the gateway exemption, the wallet worker's auth exemption
 * and these tests all name one string. A rename that misses a side is a 401 on
 * the capture and a day of wondering why the diagnostic "doesn't work".
 */
export const ENVELOPE_CAPTURE_PATH = '/v1/wallet/google/envelope-capture';

// ---------------------------------------------------------------------------
// Bounds
//
// This route is public and unauthenticated, because it has to be reachable from
// wherever Google POSTs. Everything below therefore treats the body as hostile
// input and every number as a ceiling on what one request can make the worker do
// or write to the log.
// ---------------------------------------------------------------------------

/** A real envelope is under 2 kB. 64 kB is generous and still cheap to reject. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * How much of `signedMessage` is echoed.
 *
 * The brief this answers asked for 200 characters, and 200 is what a `signedMessage`
 * needs to be recognised as a Google loyalty event: it carries `classId`,
 * `objectId`, `eventType`, `expTimeMillis`, `count` and `nonce`. Nothing beyond
 * that adds a fact, and every extra character is log volume an anonymous caller
 * controls.
 */
const MAX_PREFIX_CHARS = 200;

/**
 * Longest echoed field name.
 *
 * Field names are attacker-controlled and end up in a log line, so they are
 * capped. 64 is well past any real protocol field name.
 */
const MAX_KEY_NAME_CHARS = 64;

/** Most field names reported. A body claiming 10 000 fields is not an envelope. */
const MAX_REPORTED_KEYS = 24;

/** Most key signatures described. The verifier checks all of them; this only reports. */
const MAX_REPORTED_SIGNATURES = 8;

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/** One signature, described without disclosing it. */
export interface CapturedSignatureShape {
  /** Position in `intermediateSigningKey.signatures`. */
  index: number;
  /** Whether a value was there at all. Absent and undecodable are different facts. */
  present: boolean;
  /** Decoded length in bytes. `0` when the value was not base64. */
  byteLength: number;
  /** `false` when the value could not be base64-decoded. */
  decodable: boolean;
  /** First byte, lowercase hex, or `null` when undecodable. `30` is a DER SEQUENCE. */
  firstByteHex: string | null;
  /** Last byte, lowercase hex, or `null`. Compared against the DER length to spot padding. */
  lastByteHex: string | null;
  /** Whether it starts with a DER SEQUENCE tag. */
  derSequence: boolean;
}

/** A fingerprint of the exact bytes the verifier signs. */
export interface CapturedSignedBytes {
  byteLength: number;
  /** Full SHA-256, lowercase hex. See the module header on why this is not a leak. */
  sha256: string;
}

/** What the capture found. Every field is set; nothing is optional. */
export interface EnvelopeCapture {
  /** Whether the body parsed as a JSON object. `false` is a finding, not a failure. */
  parsed: boolean;
  /** Sorted, de-duplicated top-level field names. */
  topLevelKeys: string[];
  /** Verbatim from the envelope. `null` when absent or not a string. */
  protocolVersion: string | null;
  /** Whether `protocolVersion` equals the one this worker accepts. */
  protocolVersionIsTheConfiguredOne: boolean;
  recipientId: {
    /** Whether the envelope carried a `recipientId` field. Google does not send one. */
    presentInEnvelope: boolean;
    /** What the verifier would be given, from `GOOGLE_WALLET_ISSUER_ID`. */
    configuredIssuerId: string | null;
  };
  signedMessage: {
    present: boolean;
    /** UTF-8 byte length, not character count. */
    byteLength: number;
    isJson: boolean;
    /** `object`, `array`, `string`, `number`, `boolean` or `null`. */
    jsonType: string | null;
    /** Top-level keys, capped. `null` when the JSON is not an object. */
    jsonKeys: string[] | null;
    /** First `MAX_PREFIX_CHARS` characters, or `null` when absent. */
    prefix: string | null;
  };
  intermediateSigningKey: {
    present: boolean;
    signedKey: {
      present: boolean;
      byteLength: number;
      isJson: boolean;
      jsonKeys: string[] | null;
      keyValuePresent: boolean;
      /** Decoded length of the embedded `keyValue`. A P-256 SPKI is 91 bytes. */
      keyValueByteLength: number;
      /** From the DER, never from the base64 prefix: `ECDSA P-256`, or `unreadable`. */
      algorithm: string | null;
    };
    signatures: {
      /** How many arrived. `0` and absent are the same thing here, and that matters. */
      count: number;
      entries: CapturedSignatureShape[];
      /** True when `entries` was capped, so a truncated report is never read as complete. */
      truncated: boolean;
    };
  };
  messageSignature: CapturedSignatureShape;
  derivedSignedBytes: {
    /** Over `toLengthValue(sender, envelopeProtocolVersion, signedKey)`. */
    keySignatureInput: CapturedSignedBytes | null;
    /** Over `toLengthValue(sender, configuredIssuerId, envelopeProtocolVersion, signedMessage)`. */
    messageSignatureInput: CapturedSignedBytes | null;
  };
  /** Bounded, human-readable remarks. Never thrown; the capture is total. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Tink's toLengthValue, restated on purpose
// ---------------------------------------------------------------------------

/**
 * The length-prefixed concatenation: each part's **UTF-8 byte length as a
 * 32-bit little-endian integer**, then its UTF-8 bytes.
 *
 * ## Why this is a second implementation and not an import
 *
 * This file fingerprints the bytes `callbacks.ts` builds, in order to find out
 * whether they are the bytes Google built. If it called the function under test,
 * the digest would agree with a wrong implementation by construction and the
 * comparison would prove nothing. The two have to be able to disagree, so this is
 * written out again rather than shared.
 *
 * ## Why it is restated from the specification, not from `callbacks.ts`
 *
 * This copy used to say `uint16be`, which is what `callbacks.ts` said — the two
 * agreeing with each other was the whole reason the bug went unnoticed, since
 * this file's test asserted the digest agreed with this copy and so agreed with
 * whatever `callbacks.ts` did. Both now follow Google's published derivation
 * ("the byte length of each component is 4 bytes in little-endian format")
 * independently, so if either drifts the digests stop matching and
 * `envelope-capture.test.ts` fails.
 *
 * @see https://developers.google.com/pay/api/web/guides/resources/payment-data-cryptography
 */
function toLengthValue(parts: readonly string[]): Bytes {
  const LENGTH_PREFIX_BYTES = 4;
  let total = 0;
  const encoded = parts.map((part) => {
    const bytes = new TextEncoder().encode(part);
    total += LENGTH_PREFIX_BYTES + bytes.length;
    return bytes;
  });

  const out = new Uint8Array(total);
  let offset = 0;
  for (const bytes of encoded) {
    out[offset] = bytes.length & 0xff;
    out[offset + 1] = (bytes.length >>> 8) & 0xff;
    out[offset + 2] = (bytes.length >>> 16) & 0xff;
    out[offset + 3] = (bytes.length >>> 24) & 0xff;
    out.set(bytes, offset + LENGTH_PREFIX_BYTES);
    offset += LENGTH_PREFIX_BYTES + bytes.length;
  }
  return out;
}

async function fingerprint(bytes: Bytes): Promise<CapturedSignedBytes> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { byteLength: bytes.length, sha256: hex };
}

/**
 * Base64 decode that returns `null` instead of throwing.
 *
 * `atob` throws on anything malformed, and this route is public, so every decode
 * is a value an anonymous caller chose.
 */
function tryBase64ToBytes(value: string): Bytes | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function byteHex(byte: number | undefined): string | null {
  return byte === undefined ? null : byte.toString(16).padStart(2, '0');
}

function describeSignature(index: number, value: unknown): CapturedSignatureShape {
  if (typeof value !== 'string') {
    return {
      index,
      present: false,
      byteLength: 0,
      decodable: false,
      firstByteHex: null,
      lastByteHex: null,
      derSequence: false,
    };
  }

  const bytes = tryBase64ToBytes(value);
  if (bytes === null || bytes.length === 0) {
    return {
      index,
      present: true,
      byteLength: 0,
      decodable: false,
      firstByteHex: null,
      lastByteHex: null,
      derSequence: false,
    };
  }

  return {
    index,
    present: true,
    byteLength: bytes.length,
    decodable: true,
    firstByteHex: byteHex(bytes[0]),
    lastByteHex: byteHex(bytes[bytes.length - 1]),
    derSequence: bytes[0] === 0x30,
  };
}

function capped(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** `null` when not JSON, `[]` when JSON has no object keys to report. */
function describeJson(text: string): {
  isJson: boolean;
  jsonType: string | null;
  jsonKeys: string[] | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { isJson: false, jsonType: null, jsonKeys: [] };
  }

  if (parsed === null) return { isJson: true, jsonType: 'null', jsonKeys: null };
  if (Array.isArray(parsed)) return { isJson: true, jsonType: 'array', jsonKeys: null };

  const type = typeof parsed;
  if (type !== 'object') return { isJson: true, jsonType: type, jsonKeys: null };

  return {
    isJson: true,
    jsonType: 'object',
    jsonKeys: Object.keys(parsed as Record<string, unknown>)
      .slice(0, MAX_REPORTED_KEYS)
      .map((name) => capped(name, MAX_KEY_NAME_CHARS)),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------

/**
 * Describe an envelope's shape. Never throws, whatever the body is.
 *
 * ## Errors
 *
 * None. A body that is not JSON, not an object, missing every field, or carrying
 * hostile values still produces a total report: the fields that could not be read
 * come back `null` or `false`, and the reason is in `notes`. The route returns 200
 * with that report, because the whole value of the capture is being able to look
 * at what actually arrived — a diagnostic that 400s on a malformed body has thrown
 * away the evidence it was sent to collect.
 *
 * ## Trust
 *
 * The report describes bytes; it never interprets them. Nothing here decides
 * whether a callback is genuine, and nothing here writes anywhere. Reading a value
 * out of the body and reporting its length is not trusting it.
 */
export async function captureCallbackEnvelope(
  rawBody: string,
  configuredIssuerId: string | undefined,
): Promise<EnvelopeCapture> {
  const notes: string[] = [];

  const capture: EnvelopeCapture = {
    parsed: false,
    topLevelKeys: [],
    protocolVersion: null,
    protocolVersionIsTheConfiguredOne: false,
    recipientId: {
      presentInEnvelope: false,
      configuredIssuerId:
        typeof configuredIssuerId === 'string' && configuredIssuerId.trim() !== ''
          ? configuredIssuerId
          : null,
    },
    signedMessage: {
      present: false,
      byteLength: 0,
      isJson: false,
      jsonType: null,
      jsonKeys: null,
      prefix: null,
    },
    intermediateSigningKey: {
      present: false,
      signedKey: {
        present: false,
        byteLength: 0,
        isJson: false,
        jsonKeys: null,
        keyValuePresent: false,
        keyValueByteLength: 0,
        algorithm: null,
      },
      signatures: { count: 0, entries: [], truncated: false },
    },
    messageSignature: describeSignature(0, undefined),
    derivedSignedBytes: { keySignatureInput: null, messageSignatureInput: null },
    notes,
  };

  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    notes.push('The body was too large to describe.');
    return capture;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    notes.push('The body is not valid JSON.');
    return capture;
  }

  if (!isPlainObject(parsed)) {
    notes.push('The body is JSON but not an object.');
    return capture;
  }

  capture.parsed = true;
  capture.topLevelKeys = Object.keys(parsed)
    .slice(0, MAX_REPORTED_KEYS)
    .map((name) => capped(name, MAX_KEY_NAME_CHARS))
    .sort();
  capture.recipientId.presentInEnvelope = 'recipientId' in parsed;

  // -- protocolVersion -------------------------------------------------------
  //
  // Read from the envelope and reported verbatim. A capture that answered with
  // the configured constant would report `ECv2SigningOnly` for every envelope
  // ever delivered, which is the answer the investigation is trying not to assume.
  if (typeof parsed.protocolVersion === 'string') {
    capture.protocolVersion = parsed.protocolVersion;
    capture.protocolVersionIsTheConfiguredOne = parsed.protocolVersion === CALLBACK_PROTOCOL_VERSION;
    if (!capture.protocolVersionIsTheConfiguredOne) {
      notes.push(
        'The envelope declares a protocol this worker does not accept, so the verifier would ' +
          'refuse it as `unsupported_protocol` before reading any signature.',
      );
    }
  } else {
    notes.push('The envelope has no string `protocolVersion`.');
  }

  // -- signedMessage ---------------------------------------------------------
  if (typeof parsed.signedMessage === 'string') {
    const text = parsed.signedMessage;
    const described = describeJson(text);
    capture.signedMessage = {
      present: true,
      byteLength: new TextEncoder().encode(text).length,
      isJson: described.isJson,
      jsonType: described.jsonType,
      jsonKeys: described.jsonKeys,
      prefix: capped(text, MAX_PREFIX_CHARS),
    };
    if (!described.isJson) {
      notes.push('`signedMessage` is not JSON, so the verifier would refuse it as malformed.');
    }
  } else {
    notes.push('The envelope has no string `signedMessage`.');
  }

  // -- signature -------------------------------------------------------------
  capture.messageSignature = describeSignature(0, parsed.signature);

  // -- intermediateSigningKey ------------------------------------------------
  let signedKeyText: string | null = null;

  if (isPlainObject(parsed.intermediateSigningKey)) {
    capture.intermediateSigningKey.present = true;
    const intermediate = parsed.intermediateSigningKey;

    if (typeof intermediate.signedKey === 'string') {
      signedKeyText = intermediate.signedKey;
      const described = describeJson(signedKeyText);
      capture.intermediateSigningKey.signedKey = {
        present: true,
        byteLength: new TextEncoder().encode(signedKeyText).length,
        isJson: described.isJson,
        jsonKeys: described.jsonKeys,
        keyValuePresent: false,
        keyValueByteLength: 0,
        algorithm: null,
      };

      // Length and algorithm only. No prefix, and no key value: `signedKey` is a
      // wrapper around a base64 public key, and a slice of it is a slice of a
      // key. See the module header.
      if (described.isJson && described.jsonType === 'object') {
        try {
          const decodedKey = JSON.parse(signedKeyText) as { keyValue?: unknown };
          if (typeof decodedKey.keyValue === 'string') {
            const keyBytes = tryBase64ToBytes(decodedKey.keyValue);
            capture.intermediateSigningKey.signedKey.keyValuePresent = true;
            capture.intermediateSigningKey.signedKey.keyValueByteLength = keyBytes?.length ?? 0;
            capture.intermediateSigningKey.signedKey.algorithm = describeSpkiKey(keyBytes);
          } else {
            notes.push('`signedKey` is JSON but carries no string `keyValue`.');
          }
        } catch {
          notes.push('`signedKey` could not be read as JSON.');
        }
      }
    } else {
      notes.push('`intermediateSigningKey` has no string `signedKey`.');
    }

    const signatures = intermediate.signatures;
    if (Array.isArray(signatures)) {
      capture.intermediateSigningKey.signatures.count = signatures.length;
      capture.intermediateSigningKey.signatures.entries = signatures
        .slice(0, MAX_REPORTED_SIGNATURES)
        .map((value, index) => describeSignature(index, value));
      capture.intermediateSigningKey.signatures.truncated =
        signatures.length > MAX_REPORTED_SIGNATURES;
    } else {
      notes.push('`intermediateSigningKey.signatures` is absent or not an array.');
    }
  } else {
    notes.push('The envelope has no object `intermediateSigningKey`.');
  }

  // -- the bytes the verifier would sign -------------------------------------
  //
  // Built from the envelope's own values, including its `protocolVersion` rather
  // than the configured one. The operator holds the raw envelope locally, so a
  // candidate construction can be fingerprinted offline and compared against
  // this: matching digests identify the correct one, which is the only question
  // left open after `intermediate_key_unverified`.
  if (signedKeyText !== null && capture.protocolVersion !== null) {
    capture.derivedSignedBytes.keySignatureInput = await fingerprint(
      toLengthValue([CALLBACK_SENDER_ID, capture.protocolVersion, signedKeyText]),
    );
  }

  if (
    typeof parsed.signedMessage === 'string' &&
    capture.protocolVersion !== null &&
    capture.recipientId.configuredIssuerId !== null
  ) {
    capture.derivedSignedBytes.messageSignatureInput = await fingerprint(
      toLengthValue([
        CALLBACK_SENDER_ID,
        capture.recipientId.configuredIssuerId,
        capture.protocolVersion,
        parsed.signedMessage,
      ]),
    );
  } else if (capture.recipientId.configuredIssuerId === null) {
    notes.push(
      'No issuer id is configured, so the message signature cannot be checked. This endpoint ' +
        'reports `GOOGLE_WALLET_ISSUER_ID` and needs it set to be useful.',
    );
  }

  return capture;
}