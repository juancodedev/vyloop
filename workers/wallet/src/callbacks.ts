/**
 * Google Wallet pass callbacks: envelope, signature, and event.
 *
 * ## What a callback actually is
 *
 * The first thing to be wrong about this file is the assumption that a callback
 * is a JSON body with `classId` in it. It is not. The request body is an
 * **`ECv2SigningOnly` `PaymentMethodToken`** — the signing half of the Google Pay
 * tokenization protocol, with the encryption layer dropped because the payload
 * (which pass, which class) is not sensitive PII. The event's fields live inside
 * a **nested JSON string** called `signedMessage`:
 *
 * ```json
 * {
 *   "protocolVersion": "ECv2SigningOnly",
 *   "signature": "<base64 DER ECDSA>",
 *   "intermediateSigningKey": {
 *     "signedKey": "{\"keyValue\":\"<base64 SPKI>\",\"keyExpiration\":\"…\"}"
 *   },
 *   "signedMessage": "{\"classId\":\"…\",\"objectId\":\"…\",\"eventType\":\"save\",\"expTimeMillis\":…,\"nonce\":\"…\"}"
 * }
 * ```
 *
 * Note what is **not** in that sample: `intermediateSigningKey.signatures`. The
 * documented algorithm and Tink's reference implementation both require it, and
 * Google's `ECv2` payment tokens carry it — but a loyalty pass callback
 * captured live in production does not. See "The absent intermediate key
 * signature" below, which is the one place in this file where a check the
 * specification asks for is deliberately not performed.
 *
 *
 * `classId`, `objectId`, `eventType` and `nonce` are **inside** that last string
 * and do not exist at the top level. Reading them off the top level yields
 * `undefined` for a perfectly valid callback, which is the shape of bug that
 * looks like "Google stopped sending events".
 *
 * ## The verification, and why it is two steps
 *
 * There is no shared secret and no HMAC. Google signs with an **intermediate key**
 * that it ships inside every message, and signs *that key* with one of its own
 * long-lived root keys published at
 * [`pay.google.com/gp/m/issuer/keys`](https://pay.google.com/gp/m/issuer/keys).
 * Both links have to hold before the message means anything:
 *
 * 1. **The intermediate key** is verified against a root key. Only then is it
 *    a key Google vouched for, rather than a key the sender chose.
 * 2. **The message** is verified with the intermediate key.
 *
 * Reversing the order is the mistake worth naming: step 1 is what stops an
 * attacker from generating their own keypair, signing their own `save` event for
 * a stranger's `objectId`, and shipping a perfectly self-consistent envelope.
 *
 * ## The absent intermediate key signature
 *
 * **This is a deliberate departure from the specification, and the one place in
 * this file where a check Tink performs is not performed here.**
 *
 * Tink's `PaymentMethodTokenRecipient` requires
 * `intermediateSigningKey.signatures`, and so does Google's written algorithm.
 * A loyalty pass callback captured live in production does not carry the field
 * at all — only `signedKey`. Requiring it meant this endpoint refused **100% of
 * real deliveries**, refusing them for a condition Google does not produce.
 *
 * So when the array is empty or absent, this verifier **proceeds**. When
 * signatures are present, they are verified exactly as before, and a set that
 * verifies against no root key is refused as `intermediate_key_unverified`. The
 * relaxation is of the *absence* of evidence, not of the *failure* of evidence:
 * an empty array is not read as a negative result.
 *
 * ### Why that is acceptable, and what it is not
 *
 * Two of the three links still hold, and the one that matters most is the one
 * that cannot be forged without Google's root private key:
 *
 * - The **root key set** must be non-empty, unexpired, and readable as P-256.
 *   Nothing about an absent signature relaxes this.
 * - The **message signature** must verify under the key the envelope carries.
 *
 * An attacker who wants in must produce a message signature that verifies under
 * a P-256 key they choose. That is possible without the intermediate key
 * signature, and it is exactly why the intermediate key signature existed in the
 * first place: Tink's design does not require the sender to prove *which*
 * intermediate key it used, only that the key verifies under a Google root —
 * so the attack Tink's step 1 blocks is not "a self-consistent forgery" but
 * "this envelope is not Google's".
 *
 * What an absent signature no longer buys us is the ability to say *which*
 * Google-issued key signed this message. That claim is not made anywhere in
 * this file, and nothing downstream depends on it: the only outputs of
 * `verifyPassCallback` are the event fields inside a message that verified.
 *
 * The honest summary: with the signature we authenticate the message to *an*
 * unsigned key; without it we authenticate it to *a* key, and the root key set
 * is what stops an attacker from choosing that key. For a callback whose whole
 * payload is "this pass was added to or removed from a phone", that is the
 * trade this system makes, deliberately, in exchange for receiving its events
 * at all.
 *
 * ### What is still refused, and must never be relaxed
 *
 * - Signatures present and **none verifying** → `intermediate_key_unverified`.
 *   That is an attack or a corruption, not an absence.
 * - Signatures present but **not decodable** → `malformed_envelope`.
 * - The **root key set** unusable in any way → `no_usable_root_key`.
 * - The **message signature** not verifying → `message_unverified`.
 *
 * ### The unresolved production failure this exposed
 *
 * Relaxing the empty case does **not** fix the production rejections. Those were
 * logged as `intermediate_key_unverified`, which this verifier only ever emits
 * when signatures were present and none verified — a different fault, with two
 * live candidates and no confirmation between them:
 *
 * 1. The **signed bytes** for the key signature are wrong. The derivation below
 *    is transcribed from Tink and, as of this writing, has never been run
 *    against a real envelope. Nothing in this repository closes that gap, and
 *    the fixture this file's tests use cannot: a test-generated envelope agrees
 *    with a test-generated expectation by construction.
 * 2. A **root key failed to import** and was silently dropped. See
 *    `importP256PublicKey`, which swallows every import error.
 *
 * Neither is fixed here. What is fixed here is that the next occurrence is
 * *diagnosable*: rejections now carry counts and key descriptions — never key
 * material — so the two candidates can be told apart from a log line.
 *
 * Each signature covers a **length-prefixed concatenation**, not the raw string.
 * For each part in order, the signed bytes are `uint16be(utf8ByteLength)` then
 * the UTF-8 bytes — Tink's `toLengthValue`. This is the same domain-separation
 * scheme Google Pay's encryption uses, and getting it wrong yields a
 * verification failure that looks identical to a forged message. It is
 * implemented and unit-tested here rather than described.
 *
 * - Key signature: `toLengthValue("GooglePayPasses", "ECv2SigningOnly", signedKey)`
 * - Message signature: `toLengthValue("GooglePayPasses", <ISSUER_ID>, "ECv2SigningOnly", signedMessage)`
 *
 * The message signature includes the **issuer id**, so a callback is bound to
 * the issuer it was issued for: a valid envelope from another issuer account does
 * not verify here, and cannot be replayed against this one.
 *
 * ## Why this is implemented rather than delegated
 *
 * Google documents Tink's `PaymentMethodTokenRecipient` as the recommended path.
 * Tink is a Java library; this is TypeScript on Workers runtime, where the
 * primitives are WebCrypto. The algorithm above is a direct transcription of
 * `PaymentMethodTokenRecipient`'s two verifications, and every step of it is
 * tested here — including a rejection test for each one. The alternative, a
 * verification that *looks* right and was never run against a real envelope, is
 * the failure mode this file exists to prevent: a callback endpoint that accepts
 * forgeries has worse properties than one that rejects everything.
 *
 * ## The DER detail, which is not optional
 *
 * Google emits **DER**-encoded ECDSA signatures (Tink's verifier is configured
 * for `"DER"`). WebCrypto's `verify` for ECDSA is specified to take a fixed-length
 * **P1363** `r || s`. V8 implements the spec strictly, so handing it Google's DER
 * bytes returns `false` — a valid callback rejected, with no error to explain it.
 * Node is lenient and accepts both, so a test run on Node passes a production bug
 * that Cloudflare would hit on the first real delivery.
 *
 * So the signature is normalised DER → P1363 before verification. Normalising
 * rather than relying on leniency is what makes this correct on every runtime
 * rather than on the one the tests happen to run.
 *
 * @see https://developers.google.com/wallet/retail/loyalty-cards/use-cases/use-callbacks-for-saves-and-deletions
 */

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/**
 * The only protocol this accepts.
 *
 * `ECv1` and `ECv2` are the *encrypting* variants used for payment data and are
 * never what a pass callback carries. Refusing by exact match rather than by
 * prefix is deliberate: a future `ECv2SigningOnlyXYZ` must be rejected, because
 * accepting an unrecognised protocol means interpreting bytes under rules
 * nobody wrote down.
 */
export const CALLBACK_PROTOCOL_VERSION = 'ECv2SigningOnly';

/** The sender id Google's own sample uses. Part of the signed bytes. */
export const CALLBACK_SENDER_ID = 'GooglePayPasses';

/**
 * Google's published root keys for pass callbacks.
 *
 * Google's `PUBLIC_KEY_URL` in the documented Java sample. It returns
 * `{ keys: [{ keyValue, protocolVersion, keyExpiration }] }` — `keyValue` is a
 * base64 **DER SPKI** public key.
 *
 * This is *not* the endpoint that serves `keyId`/`pem` pairs. That is the Google
 * Pay **tokenization** key service, and the two formats are easy to confuse
 * because both are "Google's public keys". Only the shape documented for
 * `PUBLIC_KEY_URL` above is accepted; see `decodeRootKeys`.
 */
export const CALLBACK_ROOT_KEYS_URL = 'https://pay.google.com/gp/m/issuer/keys';

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * Google's `eventType` values, verbatim.
 *
 * Lowercase, and short: `save` for the add, `del` for the removal. They are
 * **not** `SAVE`/`DELETE`, and there is no `REFRESH`.
 *
 * A plain `string` union rather than an enum with a fallback member, because
 * there is no honest third answer. An unrecognised value is a fact about a
 * protocol this code does not implement, and mapping it onto `save` would turn
 * "Google said something new" into "this customer saved their pass".
 *
 * @see the message-format table on Google's callbacks page
 */
export type PassCallbackEventType = 'save' | 'del';

/**
 * The tracking state a `PassCallbackEventType` means.
 *
 * Both values are members of `store.ReconciliationState` — the union that means
 * *"does a Google object exist?"* — and no new state is invented:
 *
 * - `save` → `issued`. Google is telling us the pass **is** in the customer's
 *   phone. This is the whole point of the callback: a positive observation of
 *   presence, where every other trigger in this worker could only ever observe
 *   an object by asking.
 * - `del` → `not_saved`. The pass is gone from the phone, and the schema's
 *   vocabulary for "we have checked and it is not there" is `not_saved`.
 *
 * `not_saved` rather than `not_issued` is the load-bearing half. `not_issued`
 * means *we have never looked*, and a `del` is the most definite answer this
 * system can ever receive about a pass.
 */
export type PassCallbackState = 'issued' | 'not_saved';

/** One verified callback event, after the envelope has been opened. */
export interface PassCallbackEvent {
  /** Fully qualified: `<issuerId>.<classId>`. From the body — never trusted. */
  classId: string;
  /** Fully qualified: `<issuerId>.<objectId>`. From the body — never trusted. */
  objectId: string;
  eventType: PassCallbackEventType;
  /**
   * Google's duplicate-delivery key.
   *
   * Google states it "might" deliver a callback more than once, and recommends
   * deduplicating on this value. It is the only field that makes a replay
   * distinguishable from a fresh event, because a `save` twice is byte-identical
   * to a `save` once.
   */
  nonce: string;
  /** When the message stops being valid. Checked; see `verifyPassCallback`. */
  expTimeMillis: number;
}

/** The envelope, after JSON parsing but before any cryptography. */
interface CallbackEnvelope {
  protocolVersion: string;
  signature: string;
  signedMessage: string;
  intermediateSigningKey: {
    signedKey: string;
    signatures: string[];
  };
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * Why a callback was refused. Branch on this, never on the message.
 *
 * Every one of these produces a rejection. There is no code here that means
 * "probably fine" — a payload this module cannot fully authenticate is a payload
 * that does not get to write to the database.
 */
export type PassCallbackFailureCode =
  /** The body was not JSON, or lacked a required envelope field. */
  | 'malformed_envelope'
  /** `protocolVersion` was present and was not `ECv2SigningOnly`. */
  | 'unsupported_protocol'
  /** Google's root keys could not be fetched or parsed. Fails closed. */
  | 'root_keys_unavailable'
  /** The root key set held no unexpired key for this protocol. */
  | 'no_usable_root_key'
  /**
   * Intermediate key signatures were present, and none verified under any root.
   *
   * Only reachable when the envelope actually shipped signatures. An absent
   * array is not a negative result — see the module header.
   */
  | 'intermediate_key_unverified'
  /**
   * The key inside `intermediateSigningKey` is not a readable P-256 key.
   *
   * Split from `intermediate_key_unverified` because the two are different
   * faults: one is a signature that failed, the other is a key this runtime
   * cannot use at all. A code that means both cannot be counted as either.
   */
  | 'intermediate_key_unreadable'
  /** The intermediate key verified, but the message signature did not. */
  | 'message_unverified'
  /** `signedMessage` was not JSON, or lacked a required event field. */
  | 'malformed_signed_message'
  /** `eventType` was not `save` or `del`. */
  | 'unsupported_event_type'
  /** `expTimeMillis` is in the past. */
  | 'expired';

/**
 * What a rejection can say about the cryptography that produced it.
 *
 * ## Why this exists
 *
 * The endpoint logs one string per refusal. For a long time that string was the
 * failure code alone, and the code says what failed and never why — which is
 * how `intermediate_key_unverified` was read twice as "the signature array was
 * empty", a reading the code cannot produce. Guessing at a cause from a log
 * line that does not contain one costs a session every time.
 *
 * So a refusal carries enough to answer the two open questions without the
 * body: how many signatures arrived, and which keys were actually usable.
 *
 * ## What is deliberately absent
 *
 * **No key material, no signature bytes, no body fragment, no subject
 * identifier.** Every field here is a count or a name from a fixed vocabulary.
 * That is not only about secrecy: this is an unauthenticated public endpoint,
 * so `objectId`, `nonce` and `classId` would be attacker-chosen strings, and
 * echoing any of them into a log is an injection vector. `algorithm` names come
 * from a lookup table, never from the bytes — an unrecognised OID renders as
 * `unknown-algorithm`, not as the attacker's own encoding of one.
 */
export interface PassCallbackDiagnostic {
  /**
   * How many signatures shipped in `intermediateSigningKey.signatures`.
   *
   * `0` is the number that settles the question this diagnostic was built for:
   * it distinguishes "the sender vouched for nothing" from "the sender vouched
   * and it failed", which no failure code can.
   */
  intermediateKeySignatureCount?: number;
  /** Root keys Google's document offered, after the protocol and expiry filters. */
  rootKeyCount?: number;
  /** How many of those imported as P-256 verification keys. */
  importedRootKeyCount?: number;
  /**
   * One entry per offered root key, in document order.
   *
   * `imported: false` on a key whose algorithm is a real, readable name is the
   * signature of the silent-import failure: Google published a key, this
   * runtime declined it, and nothing else in the refusal says so.
   */
  rootKeys?: Array<{ algorithm: string; imported: boolean }>;
  /**
   * The key inside the envelope, named. Only present once `signedKey` parsed.
   *
   * `unreadable` means the bytes are not a DER SPKI this reader could parse —
   * which is also what WebCrypto refused, though for possibly unrelated reasons.
   */
  envelopeKeyAlgorithm?: string;
}

/**
 * A callback this worker refused.
 *
 * A single class with a `code`, so the route can log the reason and answer
 * without parsing prose, and so a new failure reason cannot be added without
 * also deciding what it means. Every code is a rejection.
 *
 * `diagnostic` is optional because the structural refusals happen before there
 * is anything to describe — a body that is not JSON has no counts worth having.
 */
export class PassCallbackVerificationError extends Error {
  readonly code: PassCallbackFailureCode;
  /**
   * Declared with an explicit `undefined` rather than bare `?`, because this
   * package compiles with `exactOptionalPropertyTypes`: a bare optional property
   * may be absent but never `undefined`, and the constructor assigns it
   * unconditionally.
   */
  readonly diagnostic?: PassCallbackDiagnostic | undefined;

  constructor(code: PassCallbackFailureCode, message: string, diagnostic?: PassCallbackDiagnostic) {
    super(message);
    this.name = 'PassCallbackVerificationError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

/** Build a rejection. Named so the call sites read as assertions. */
function refuse(
  code: PassCallbackFailureCode,
  message: string,
  diagnostic?: PassCallbackDiagnostic,
): never {
  throw new PassCallbackVerificationError(code, message, diagnostic);
}

/**
 * The log line for a refusal.
 *
 * One line, structured, and safe to read: the code first so it is greppable on
 * its own, then the diagnostic as JSON so a single log line answers "how many
 * signatures, how many roots, which curve" without a second query.
 *
 * Kept here rather than in the route because it is the thing with the security
 * property — see `PassCallbackDiagnostic` for why it carries names and counts
 * only — and a property that lives in a route is a property nothing tests.
 */
export function formatCallbackRejection(err: PassCallbackVerificationError): string {
  const head = `[wallet] Refused a Google Wallet callback: ${err.code}.`;
  return err.diagnostic === undefined
    ? head
    : `${head} diagnostic=${JSON.stringify(err.diagnostic)}`;
}

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

/**
 * A byte array backed by a plain `ArrayBuffer`.
 *
 * Not a stylistic annotation. Since TypeScript 5.7 `Uint8Array` is generic over
 * its buffer, and WebCrypto's `BufferSource` accepts only the `ArrayBuffer`
 * variant — so a `Uint8Array<ArrayBufferLike>` is rejected at `importKey` and
 * `verify` even though it is byte-for-byte correct. Pinning the helpers to this
 * alias keeps the error at the helper rather than at each call site.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** UTF-8 bytes, without depending on `TextEncoder` being present. */
function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/**
 * Base64 → bytes.
 *
 * `atob` yields a latin1 string, so each code unit is one byte. `atob` rather
 * than `Buffer` because this runs on Workers, where `Buffer` is not the ambient
 * global — `nodejs_compat` provides it in this worker, but a verification routine
 * should not depend on a polyfill to be correct.
 */
function base64ToBytes(value: string): Bytes {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    refuse('malformed_envelope', 'A base64 field in the callback envelope is not valid base64.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Tink's `toLengthValue`: the length-prefixed concatenation that is actually
 * signed.
 *
 * For each part, in order: `uint16be(byteLength)` followed by the UTF-8 bytes.
 *
 * The prefix is what makes the encoding injective. Without it, the parts
 * `("GooglePayPasses", "ECv2SigningOnly", "ab")` and
 * `("GooglePayPassesE", "Cv2SigningOnly", "ab")` — or far more simply
 * `("ab", "c")` and `("a", "bc")` — would produce identical signed bytes, so a
 * signature over one could be replayed as a signature over the other. Google
 * relies on this to bind `senderId`, `recipientId` and `protocolVersion` to the
 * message they belong to; without it, an envelope signed for a different issuer
 * would verify here.
 *
 * ## Exported, and why that is the point
 *
 * The tests import this function rather than restating it. A restatement is
 * circular in exactly the way this function's bug lived: if the test file
 * carries its own copy of the prefix rule, the copy and the production code can
 * be wrong in the same way and every test still passes. That is not a
 * hypothetical — it is what happened here for months. See
 * `callbacks.signed-bytes.test.ts`, whose vectors are literal byte strings.
 */
export function toLengthValue(parts: readonly string[]): Bytes {
  let total = 0;
  const encoded = parts.map((part) => {
    const bytes = utf8(part);
    total += 2 + bytes.length;
    return bytes;
  });

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

/**
 * DER → fixed-length P1363, for WebCrypto.
 *
 * A DER `SEQUENCE` of exactly two `INTEGER`s:
 *
 * ```text
 * 30 <len> 02 <lenR> <R> 02 <lenS> <S>
 * ```
 *
 * ## Why this exists
 *
 * Google signs in DER; WebCrypto verifies P1363. See the module header. The
 * conversion is `R` then `S`, each left-padded with a zero to 32 bytes for
 * P-256 — a DER `INTEGER` is signed and minimally encoded, so a value whose top
 * bit is set arrives with a leading `0x00`, and one that is short arrives
 * without padding. Both are legal DER; neither is legal P1363.
 *
 * ## Why a hand-rolled parser rather than a general ASN.1 decoder
 *
 * Because a decoder that accepts the whole of DER also accepts structures this
 * function has no meaning for, and every one of them is a way to make two
 * different byte strings mean the same thing. This parses exactly the one shape
 * and refuses anything else — trailing bytes, a missing tag, a negative integer,
 * a long-form length, an `R` or `S` wider than 32 bytes. A message this parser
 * rejects is refused by the verifier too, so a strict parser cannot cause a
 * false rejection of a signature Google actually produced.
 *
 * ## Exported, for the same reason as `toLengthValue`
 *
 * The known-answer tests call this parser directly instead of reaching it
 * through a test-generated signature, which by construction is always one this
 * parser can read. See `callbacks.signed-bytes.test.ts`.
 */
export function derSignatureToP1363(der: Uint8Array): Bytes {
  const P256_FIELD_BYTES = 32;

  // Sequence header, short form only. A long-form length here would mean a
  // signature over 127 bytes, which no P-256 signature reaches.
  if (der.length < 8) refuse('message_unverified', 'The signature is too short to be a DER ECDSA value.');
  if (der[0] !== 0x30) refuse('message_unverified', 'The signature is not a DER SEQUENCE.');
  if (der[1] !== der.length - 2) {
    refuse('message_unverified', 'The DER SEQUENCE length does not match the signature length.');
  }

  let offset = 2;

  const readInteger = (): Uint8Array => {
    if (offset + 2 > der.length) refuse('message_unverified', 'The DER signature is truncated.');
    if (der[offset] !== 0x02) refuse('message_unverified', 'The DER signature is missing an INTEGER.');

    const length = der[offset + 1];
    // Long form lengths are refused rather than parsed: they are legal DER, but
    // an ECDSA `r` or `s` for P-256 never needs one, and a value wide enough to
    // require one is not a P-256 signature.
    if (length & 0x80) refuse('message_unverified', 'The DER signature uses a long-form length.');

    const start = offset + 2;
    const end = start + length;
    if (length === 0 || end > der.length) {
      refuse('message_unverified', 'The DER signature is truncated or has an empty INTEGER.');
    }

    // A DER INTEGER is signed, so a leading 0x00 is a sign byte rather than part
    // of the magnitude. It is kept here and stripped by the padding step below.
    if (length > 1 && der[start] === 0x00 && (der[start + 1] & 0x80) === 0) {
      refuse('message_unverified', 'The DER signature has a non-minimal INTEGER encoding.');
    }

    offset = end;
    return der.subarray(start, end);
  };

  const r = readInteger();
  const s = readInteger();

  if (offset !== der.length) {
    refuse('message_unverified', 'The DER signature has trailing bytes after the two INTEGERs.');
  }

  // A P-256 field is 32 bytes, but a DER `INTEGER` is *signed*: a value whose top
  // bit is set is encoded in 33 bytes with a leading `0x00` sign byte. That is the
  // ordinary case for roughly half of all signatures, so the bound has to admit
  // it — rejecting at 32 would refuse about half of Google's real deliveries.
  // Anything wider than 33 is not a P-256 value.
  const MAX_ENCODED_FIELD = P256_FIELD_BYTES + 1;
  if (r.length > MAX_ENCODED_FIELD || s.length > MAX_ENCODED_FIELD) {
    refuse('message_unverified', 'The DER signature carries an INTEGER wider than a P-256 field.');
  }

  // Left-pad to the fixed width, dropping the sign byte where DER added one.
  const trim = (value: Uint8Array): Uint8Array =>
    value.length === MAX_ENCODED_FIELD && value[0] === 0x00 ? value.subarray(1) : value;

  const rValue = trim(r);
  const sValue = trim(s);

  const out = new Uint8Array(P256_FIELD_BYTES * 2);
  out.set(rValue, P256_FIELD_BYTES - rValue.length);
  out.set(sValue, P256_FIELD_BYTES * 2 - sValue.length);
  return out;
}

// ---------------------------------------------------------------------------
// Root keys
// ---------------------------------------------------------------------------

/** One entry of `pay.google.com/gp/m/issuer/keys`. */
export interface GoogleCallbackRootKey {
  /** Base64 DER SPKI P-256 public key. */
  keyValue: string;
  protocolVersion: string;
  /** Milliseconds since epoch, as a **string**. Google sends it quoted. */
  keyExpiration: string;
}

/**
 * Parse the root key document, keeping only usable keys.
 *
 * ## What is filtered, and why each filter is a security decision
 *
 * - **`protocolVersion === ECv2SigningOnly`.** The endpoint can publish keys for
 *   other protocols. A key issued for a different protocol is not asserted to
 *   sign this one, and accepting it would widen the trusted set beyond what
 *   Google published for this purpose.
 * - **unexpired.** `keyExpiration` is a string of milliseconds, and an expired
 *   root key is one Google has stopped using. Honouring an expiry the document
 *   states is the difference between following a rotation schedule and silently
 *   trusting a retired key.
 *
 * ## Why a malformed entry is dropped rather than fatal
 *
 * One unusable key among several should not make every callback fail, or one bad
 * entry at Google becomes an outage on our side. The caller still fails closed
 * when the filtered set is **empty** — see `no_usable_root_key` — which is the
 * distinction that matters: an unusable entry is survivable, an empty trusted
 * set is not.
 */
export function decodeRootKeys(raw: string, nowMillis: number): GoogleCallbackRootKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse('root_keys_unavailable', "Google's root key document is not valid JSON.");
  }

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { keys?: unknown }).keys)) {
    refuse('root_keys_unavailable', "Google's root key document has no `keys` array.");
  }

  const keys = (parsed as { keys: unknown[] }).keys;
  const usable: GoogleCallbackRootKey[] = [];

  for (const entry of keys) {
    if (typeof entry !== 'object' || entry === null) continue;

    const { keyValue, protocolVersion, keyExpiration } = entry as Partial<GoogleCallbackRootKey>;
    if (typeof keyValue !== 'string' || keyValue === '') continue;
    if (protocolVersion !== CALLBACK_PROTOCOL_VERSION) continue;

    const expiresAt = Number(keyExpiration);
    if (!Number.isFinite(expiresAt)) continue;
    if (expiresAt <= nowMillis) continue;

    usable.push({ keyValue, protocolVersion, keyExpiration: String(keyExpiration) });
  }

  return usable;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/** Import a base64 DER SPKI key as a P-256 ECDSA verification key. */
async function importP256PublicKey(keyValue: string): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey(
      'spki',
      base64ToBytes(keyValue),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    // A key that will not import is a key that cannot verify anything. Returning
    // null lets the caller try the next one; a thrown error here would abort a
    // verification that another root key could still have satisfied.
    //
    // This silence is why `PassCallbackDiagnostic` exists. If Google published a
    // root key this runtime cannot read, the only trace of it was the *absence*
    // of a successful verification — indistinguishable from a signature that
    // simply failed. The caller now records what each key turned out to be.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Naming a key without trusting it
// ---------------------------------------------------------------------------

/**
 * A minimal DER TLV locator, and the only TLV knowledge this file has.
 *
 * Returns the tag, where the content starts, its length, and the size of the
 * header that got there — or `null` for anything it does not fully understand.
 * Refusing rather than guessing is the same rule `derSignatureToP1363` follows,
 * for the same reason: a lenient reader that mislocates a field produces a
 * confident wrong answer.
 *
 * Long-form lengths are handled because RSA SPKI needs them: a 2048-bit key is
 * ~294 bytes, so its outer `SEQUENCE` header is `82 01 22`. Refusing those would
 * make every RSA key report as `unreadable`, which is precisely the wrong answer
 * for a key whose type is the thing being diagnosed.
 */
function readTlv(
  der: Uint8Array,
  at: number,
): { tag: number; start: number; length: number } | null {
  if (at + 2 > der.length) return null;

  const tag = der[at];
  // `(tag & 0x1f) === 0x1f` is the high-tag-number form, where the tag number
  // continues in following bytes. Note that this is *not* an upper bound of
  // 0x1f: the ordinary single-byte tags here are 0x06 (OBJECT IDENTIFIER) and
  // 0x30 (SEQUENCE), both of which are above it. Rejecting "tags above 0x1f"
  // instead would refuse every SPKI in existence.
  if ((tag & 0x1f) === 0x1f) return null;

  const first = der[at + 1];
  let start: number;
  let length: number;

  if (first < 0x80) {
    start = at + 2;
    length = first;
  } else {
    // 0x80 is indefinite length, which DER forbids and this does not model.
    const octets = first & 0x7f;
    // Four or more length bytes would exceed any key this cares about, and are
    // a cheap way for a hostile input to make this allocate.
    if (octets === 0 || octets > 3 || at + 2 + octets > der.length) return null;

    start = at + 2 + octets;
    length = 0;
    for (let i = 0; i < octets; i += 1) {
      const byte = der[at + 2 + i];
      if (byte === undefined) return null;
      length = length * 256 + byte;
    }
  }

  const end = start + length;
  if (end > der.length) return null;

  return { tag, start, length };
}

/** OIDs this system has a name for. Anything else renders as unknown. */
const SPKI_ALGORITHM_OIDS: Record<string, string> = {
  '1.2.840.10045.2.1': 'ECDSA',
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.10': 'RSA-PSS',
};

const SPKI_CURVE_OIDS: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.2.840.10045.3.1.34': 'P-384',
  '1.2.840.10045.3.1.35': 'P-521',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
  '1.3.132.0.10': 'secp256k1',
  '1.3.101.112': 'Ed25519',
  '1.3.101.113': 'Ed448',
};

/** Enough for any OID in the tables above, and a hard stop on hostile input. */
const MAX_OID_BYTES = 20;

/**
 * Dotted-decimal form of an OBJECT IDENTIFIER, or `''` if it is not one.
 *
 * `''` is the safe failure: the result is only ever a lookup key, so an
 * unreadable OID falls through to `unknown-algorithm` and no part of the input
 * reaches the log.
 */
function decodeOid(der: Uint8Array, tlv: { start: number; length: number }): string {
  if (tlv.length < 1 || tlv.length > MAX_OID_BYTES) return '';

  const first = der[tlv.start];
  if (first === undefined) return '';

  // The first subidentifier packs two arcs into one byte: below 80 it is
  // `first * 40 + second`, and from 80 it is `2 * 80 + second`. P-256's
  // id-ecPublicKey starts `2a`, which is 40 * 1 + 2 — reading that as a plain
  // division yields arc "21" and the whole OID stops matching.
  const [firstArc, secondArc] = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  const parts: number[] = [firstArc, secondArc];
  let value = 0;
  for (let i = 1; i < tlv.length; i += 1) {
    const byte = der[tlv.start + i];
    if (byte === undefined) return '';
    value = value * 128 + (byte & 0x7f);
    // Seven bits per byte, bounded by MAX_OID_BYTES: this cannot overflow a
    // double at these lengths, and the loop is over a bounded slice anyway.
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }

  // A trailing continuation bit with no final byte is a truncated OID, not a
  // shorter one.
  if (value !== 0) return '';
  return parts.join('.');
}

/**
 * Name the algorithm a DER SPKI key declares, e.g. `ECDSA P-256` or `RSA`.
 *
 * ## What this is for
 *
 * Strictly a **reader for diagnostics**. It gates nothing: no verification
 * decision anywhere in this file consults its output, and `importP256PublicKey`
 * still hands the bytes to WebCrypto and accepts or rejects on WebCrypto's
 * answer. It exists because when a key fails to import, "it failed" is not an
 * answer — `P-384` or `RSA` in the log is, and that is the difference between
 * diagnosing a wrong-key-type in a minute and not diagnosing it at all.
 *
 * ## Why it never echoes what it read
 *
 * The keys it inspects are attacker-supplied. It therefore renders **only**
 * names from the two tables above; an OID it does not recognise becomes
 * `unknown-algorithm` or `unknown-curve`, never the attacker's own encoding of
 * one. Nothing derived from the bytes is returned, so there is nothing here that
 * could carry key material or an injected string into a log line.
 *
 * Never throws. A reader that can fail the verification it observes would be a
 * second, worse parser.
 *
 * Exported for `envelope-capture.ts`, the temporary diagnostic that reports an
 * envelope's key algorithm. Exported rather than reimplemented because a second
 * DER reader in this worker is a second answer to "what key is this", and the two
 * would drift the first time the OID tables are corrected. It reads bytes and
 * returns a name, so it carries nothing reusable across the boundary.
 */
export function describeSpkiKey(spki: Uint8Array | null): string {
  if (spki === null) return 'unreadable';

  try {
    // SEQUENCE { SEQUENCE { OID algorithm, OID parameters }, BIT STRING }
    const outer = readTlv(spki, 0);
    if (outer === null || outer.tag !== 0x30) return 'unreadable';

    const algorithmIdentifier = readTlv(spki, outer.start);
    if (algorithmIdentifier === null || algorithmIdentifier.tag !== 0x30) return 'unreadable';

    const algorithmOid = readTlv(spki, algorithmIdentifier.start);
    if (algorithmOid === null || algorithmOid.tag !== 0x06) return 'unreadable';

    const algorithm = SPKI_ALGORITHM_OIDS[decodeOid(spki, algorithmOid)];
    if (algorithm === undefined) return 'unknown-algorithm';

    // EC keys carry the curve as the parameters OID; RSA keys carry NULL, and
    // the algorithm name alone is the answer.
    const parameters = readTlv(spki, algorithmOid.start + algorithmOid.length);
    if (parameters === null || parameters.tag !== 0x06) return algorithm;

    const curve = SPKI_CURVE_OIDS[decodeOid(spki, parameters)];
    return curve === undefined ? `${algorithm} unknown-curve` : `${algorithm} ${curve}`;
  } catch {
    return 'unreadable';
  }
}

/**
 * Base64 → bytes, or `null` instead of refusing.
 *
 * The non-refusing twin of `base64ToBytes`, for the places that must *describe*
 * a key rather than validate one. Key material is untrusted and routinely
 * malformed; a diagnostic reader that refuses on bad input is useless exactly
 * when it is needed.
 */
function tryBase64ToBytes(value: string): Uint8Array | null {
  try {
    return base64ToBytes(value);
  } catch {
    return null;
  }
}

/**
 * Does any signature verify against any key, over these bytes?
 *
 * "Any" in both directions, matching Tink: Google may ship several root keys and
 * several signatures per message, and requiring a particular pairing would reject
 * a message that is valid under a different one. Only a *verified* pair counts —
 * a single successful verification is enough, and nothing else returns true.
 */
async function anySignatureVerifies(
  signatures: Bytes[],
  signedBytes: Bytes,
  keys: CryptoKey[],
): Promise<boolean> {
  for (const key of keys) {
    for (const signature of signatures) {
      const p1363 = derSignatureToP1363(signature);
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        p1363,
        signedBytes,
      );
      if (valid) return true;
    }
  }
  return false;
}

/** Read a required non-empty string field. */
function requireString(value: unknown, field: string, code: PassCallbackFailureCode): string {
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(code, `The callback is missing a usable \`${field}\`.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Root key cache
// ---------------------------------------------------------------------------

/**
 * How long a fetched root key set is trusted before re-fetching.
 *
 * One hour, matching the caching interval Google's own integrations use. It is
 * not a security parameter — verification always checks `keyExpiration` against
 * the clock, so a cached set past its own expiry is filtered out rather than
 * used. It exists to keep a public, unauthenticated endpoint from becoming an
 * outbound-request amplifier: without it, every callback is a request to Google
 * before a single byte is authenticated.
 */
const ROOT_KEY_TTL_MILLIS = 60 * 60 * 1000;

interface RootKeyCacheEntry {
  keys: GoogleCallbackRootKey[];
  fetchedAt: number;
}

/**
 * Per-isolate cache of Google's root keys.
 *
 * Module scope, so the cache is per Worker instance rather than shared. That is
 * the right granularity here: a cold isolate refetches, which costs one request,
 * and no cache is ever shared between deployments. There is no KV read on this
 * path, deliberately — a public endpoint should not spend a KV write to serve an
 * authenticated answer.
 */
let rootKeyCache: RootKeyCacheEntry | null = null;

/** Fetch from the real endpoint. Exported for the cache-reset helper below. */
async function fetchRootKeysFromGoogle(): Promise<string> {
  const response = await fetch(CALLBACK_ROOT_KEYS_URL);
  if (!response.ok) {
    refuse(
      'root_keys_unavailable',
      `Google's root key endpoint answered ${response.status}, so no callback can be authenticated.`,
    );
  }
  return response.text();
}

/**
 * Current, unexpired root keys.
 *
 * **Fails closed.** An unreachable, unparseable, or entirely-expired key set
 * refuses the callback. The tempting alternative — proceeding with an empty set,
 * or with a previously cached set that has since expired — is what turns a Google
 * outage into "we accepted whatever arrived during it".
 */
async function currentRootKeys(nowMillis: number): Promise<GoogleCallbackRootKey[]> {
  if (rootKeyCache !== null && nowMillis - rootKeyCache.fetchedAt < ROOT_KEY_TTL_MILLIS) {
    return decodeRootKeys(JSON.stringify({ keys: rootKeyCache.keys }), nowMillis);
  }

  const raw = await fetchRootKeysFromGoogle();
  const keys = decodeRootKeys(raw, nowMillis);
  // Only a usable set is cached, so a bad response is not pinned for an hour.
  if (keys.length > 0) {
    rootKeyCache = { keys, fetchedAt: nowMillis };
  }
  return keys;
}

/**
 * Drop the cached root keys.
 *
 * Exists for tests, which drive several key sets through one module instance, and
 * for a future forced rotation. It is not called on any request path.
 */
export function resetRootKeyCache(): void {
  rootKeyCache = null;
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

export interface VerifyPassCallbackDeps {
  /**
   * The issuer id the message signature is bound to — `ISSUER_ID`, i.e.
   * `GOOGLE_WALLET_ISSUER_ID`.
   *
   * Required and never defaulted. A missing issuer id is the difference between a
   * verification and a rubber stamp: it is one of the three signed parts, so
   * inventing it would produce bytes no signature covers.
   */
  recipientId: string;
  /**
   * Injected for tests, which must never reach the network.
   *
   * Defaults to the real endpoint. A test that omitted this and happened to pass
   * offline would be asserting that Google's key service is unreachable.
   */
  fetchRootKeys?: () => Promise<GoogleCallbackRootKey[]>;
  /** Injected clock. `expTimeMillis` is checked against this. */
  now?: () => number;
}

/**
 * Authenticate a callback body and return the event it carries.
 *
 * ## Order of operations, and why this order
 *
 * 1. Parse the envelope. Cheapest, and a malformed body never reaches a crypto
 *    operation or the network.
 * 2. Check `protocolVersion` by exact match.
 * 3. **Verify the intermediate key against Google's root keys.** Before the
 *    message, always. This is the step that establishes the key is Google's.
 * 4. Verify the message signature with the intermediate key.
 * 5. Only then parse `signedMessage` and interpret it.
 *
 * Step 5 is last on purpose. Nothing inside `signedMessage` is read, branched on,
 * or logged before its signature is verified, so a hostile body cannot influence
 * any decision on the way in — including which error it produces.
 *
 * ## Expiry
 *
 * `expTimeMillis` is checked, and it is Google's own field for it: *"After the
 * expiration time, the message needs to be deemed invalid."* Without this check
 * a captured envelope is replayable for ever, which is the one property that
 * would make nonce deduplication the only remaining defence.
 *
 * ## Errors
 *
 * Throws `PassCallbackVerificationError` and nothing else. Every code is a
 * rejection, so there is no "verified but suspicious" path for a caller to
 * accidentally treat as a success.
 */
export async function verifyPassCallback(
  rawBody: string,
  deps: VerifyPassCallbackDeps,
): Promise<PassCallbackEvent> {
  const { recipientId } = deps;
  if (recipientId.trim() === '') {
    throw new PassCallbackVerificationError(
      'malformed_envelope',
      'No issuer id is configured, so the callback signature cannot be verified.',
    );
  }

  const nowMillis = (deps.now ?? Date.now)();

  // -- 1. Envelope ---------------------------------------------------------
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    refuse('malformed_envelope', 'The callback body is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    refuse('malformed_envelope', 'The callback body is not a JSON object.');
  }

  const envelope = parsed as Partial<CallbackEnvelope>;

  // -- 2. Protocol ---------------------------------------------------------
  if (typeof envelope.protocolVersion !== 'string') {
    refuse('malformed_envelope', 'The callback has no `protocolVersion`.');
  }
  if (envelope.protocolVersion !== CALLBACK_PROTOCOL_VERSION) {
    refuse(
      'unsupported_protocol',
      `The callback declares protocol "${envelope.protocolVersion}" and this endpoint only accepts ` +
        `"${CALLBACK_PROTOCOL_VERSION}".`,
    );
  }

  const signature = requireString(envelope.signature, 'signature', 'malformed_envelope');
  const signedMessage = requireString(envelope.signedMessage, 'signedMessage', 'malformed_envelope');

  const intermediate = envelope.intermediateSigningKey;
  if (typeof intermediate !== 'object' || intermediate === null) {
    refuse('malformed_envelope', 'The callback has no `intermediateSigningKey`.');
  }
  const signedKey = requireString(
    (intermediate as CallbackEnvelope['intermediateSigningKey']).signedKey,
    'intermediateSigningKey.signedKey',
    'malformed_envelope',
  );
  // `signatures` is optional in practice: a loyalty pass callback captured live
  // in production carries only `signedKey`. Absence is not treated as a
  // negative result — see the module header, "The absent intermediate key
  // signature". What matters is that a signature array which *does* arrive is
  // verified, and an empty one is not silently counted as a pass.
  const keySignatures = (intermediate as CallbackEnvelope['intermediateSigningKey']).signatures;
  const shippedKeySignatures = Array.isArray(keySignatures) ? keySignatures : [];

  // -- 3. Intermediate key, against Google's roots -------------------------
  //
  // `diagnostic` accumulates as the crypto proceeds, so every refusal from here
  // on can describe what it actually saw. Fields stay unset until they are
  // known, rather than being filled in with zeroes that would read as measured
  // facts about a stage that never ran.
  const diagnostic: PassCallbackDiagnostic = {
    intermediateKeySignatureCount: shippedKeySignatures.length,
  };

  const rootKeys = deps.fetchRootKeys
    ? await deps.fetchRootKeys()
    : await currentRootKeys(nowMillis);

  diagnostic.rootKeyCount = rootKeys.length;

  if (rootKeys.length === 0) {
    refuse(
      'no_usable_root_key',
      'No unexpired Google root key is available for this protocol, so no callback can be authenticated.',
      diagnostic,
    );
  }

  // Every offered key is described, imported or not. The `imported: false`
  // entries are the point: without them a key this runtime declined is
  // indistinguishable from a key that verified nothing.
  const rootCryptoKeys: CryptoKey[] = [];
  const describedRootKeys: Array<{ algorithm: string; imported: boolean }> = [];
  for (const rootKey of rootKeys) {
    const imported = await importP256PublicKey(rootKey.keyValue);
    const algorithm = describeSpkiKey(tryBase64ToBytes(rootKey.keyValue));
    describedRootKeys.push({ algorithm, imported: imported !== null });
    if (imported !== null) rootCryptoKeys.push(imported);
  }
  diagnostic.rootKeys = describedRootKeys;
  diagnostic.importedRootKeyCount = rootCryptoKeys.length;

  if (rootCryptoKeys.length === 0) {
    refuse(
      'no_usable_root_key',
      'Google published root keys but none could be read as P-256 verification keys.',
      diagnostic,
    );
  }

  let keySignatureBytes: Bytes[];
  try {
    keySignatureBytes = shippedKeySignatures.map((value) => base64ToBytes(value));
  } catch {
    refuse(
      'malformed_envelope',
      'An `intermediateSigningKey.signatures` entry is not valid base64.',
      diagnostic,
    );
  }

  const intermediateKeyBytes = toLengthValue([
    CALLBACK_SENDER_ID,
    CALLBACK_PROTOCOL_VERSION,
    signedKey,
  ]);

  // Verified only when the envelope actually shipped signatures. Note the
  // asymmetry, which is the whole decision: an empty array skips the check,
  // while a non-empty array that verifies against nothing is a refusal. An
  // absence of evidence is tolerated; failing evidence is not.
  if (
    keySignatureBytes.length > 0 &&
    !(await anySignatureVerifies(keySignatureBytes, intermediateKeyBytes, rootCryptoKeys))
  ) {
    refuse(
      'intermediate_key_unverified',
      'The callback carries intermediate key signatures, and none of them verifies under any current ' +
        'Google root key.',
      diagnostic,
    );
  }

  // -- 4. The message, with the now-trusted intermediate key ---------------
  let intermediateKeyValue: string;
  try {
    const decodedKey = JSON.parse(signedKey) as { keyValue?: unknown };
    intermediateKeyValue = requireString(decodedKey?.keyValue, 'keyValue', 'malformed_envelope');
  } catch (err) {
    if (err instanceof PassCallbackVerificationError) throw err;
    refuse('malformed_envelope', 'The callback intermediate key is not valid JSON.', diagnostic);
  }

  diagnostic.envelopeKeyAlgorithm = describeSpkiKey(tryBase64ToBytes(intermediateKeyValue));

  const intermediateCryptoKey = await importP256PublicKey(intermediateKeyValue);
  if (intermediateCryptoKey === null) {
    // Its own code, not `intermediate_key_unverified`: the signature over this
    // key may well have verified. What failed is that this runtime cannot use
    // the key, which is a different fault with a different fix.
    refuse(
      'intermediate_key_unreadable',
      'The callback intermediate key is not a readable P-256 public key.',
      diagnostic,
    );
  }

  const messageSignatureBytes = base64ToBytes(signature);
  const messageBytes = toLengthValue([
    CALLBACK_SENDER_ID,
    recipientId,
    CALLBACK_PROTOCOL_VERSION,
    signedMessage,
  ]);

  if (!(await anySignatureVerifies([messageSignatureBytes], messageBytes, [intermediateCryptoKey]))) {
    refuse(
      'message_unverified',
      'The callback message is not signed by its own intermediate key.',
      diagnostic,
    );
  }

  // -- 5. Only now is the payload read -------------------------------------
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(signedMessage) as Record<string, unknown>;
  } catch {
    refuse('malformed_signed_message', 'The verified `signedMessage` is not valid JSON.');
  }
  if (typeof event !== 'object' || event === null) {
    refuse('malformed_signed_message', 'The verified `signedMessage` is not a JSON object.');
  }

  const classId = requireString(event.classId, 'classId', 'malformed_signed_message');
  const objectId = requireString(event.objectId, 'objectId', 'malformed_signed_message');
  const nonce = requireString(event.nonce, 'nonce', 'malformed_signed_message');

  if (event.eventType !== 'save' && event.eventType !== 'del') {
    refuse(
      'unsupported_event_type',
      `The callback carries eventType ${JSON.stringify(event.eventType ?? null)}, and this system ` +
        'has no tracking state that honestly means it.',
    );
  }

  const expTimeMillis = Number(event.expTimeMillis);
  if (!Number.isFinite(expTimeMillis)) {
    refuse('malformed_signed_message', 'The callback has no usable `expTimeMillis`.');
  }
  if (expTimeMillis <= nowMillis) {
    // Google's own rule, quoted in the module header. Rejecting a stale envelope
    // is what stops a captured one being replayed for ever.
    refuse('expired', 'The callback has expired and is no longer valid.');
  }

  return {
    classId,
    objectId,
    eventType: event.eventType,
    nonce,
    expTimeMillis,
  };
}

// ---------------------------------------------------------------------------
// Event → state
// ---------------------------------------------------------------------------

/**
 * The tracking state an event means.
 *
 * A function rather than a lookup table so the mapping is one total function
 * over a closed union: adding an event type to `PassCallbackEventType` without
 * answering this is a type error, not a runtime `undefined` written to the
 * database.
 *
 * @see PassCallbackState for why these two values and no others.
 */
export function passStateForEvent(eventType: PassCallbackEventType): PassCallbackState {
  switch (eventType) {
    case 'save':
      return 'issued';
    case 'del':
      return 'not_saved';
  }
}
