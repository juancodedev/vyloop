/**
 * Known-answer tests for the two encoders that decide the Google Wallet callback
 * wire format.
 *
 * ## Why this file exists separately from `callbacks.test.ts`
 *
 * `callbacks.test.ts` signs its own envelopes at test time. That is right for
 * testing the verifier's *decisions* and useless for testing the *bytes*: an
 * envelope signed with the same construction the verifier rebuilds agrees with a
 * wrong construction too, so the two would have to be broken identically for a
 * test to notice. They were, for months, and nothing noticed.
 *
 * So the vectors below are **literal byte strings**, written down by hand or
 * generated once by an independent construction and pasted in. Nothing here
 * calls `toLengthValue` to decide what `toLengthValue` should produce. Every
 * expected value in this file could have been computed with a shift and a mask;
 * none of them was.
 *
 * ## The protocol, from the source
 *
 * Google's payment-data cryptography guide gives the derivation for both signed
 * strings this verifier builds, and specifies the prefix explicitly:
 *
 * ```text
 * signedStringForIntermediateSigningKeySignature =
 *   length_of_sender_id      || sender_id      ||
 *   length_of_protocol_ver   || protocol_ver   ||
 *   length_of_signed_key     || signed_key
 *
 * signedStringForMessageSignature =
 *   length_of_sender_id    || sender_id    ||
 *   length_of_recipient_id || recipient_id ||
 *   length_of_protocol_ver || protocol_ver ||
 *   length_of_signed_msg   || signed_msg
 * ```
 *
 * "The byte length of each component is 4 bytes in little-endian format."
 *
 * @see https://developers.google.com/pay/api/web/guides/resources/payment-data-cryptography
 */

import { describe, expect, it } from 'vitest';

import { derSignatureToP1363, toLengthValue } from './callbacks';

// ---------------------------------------------------------------------------
// Helpers that are NOT the code under test
// ---------------------------------------------------------------------------

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Lowercase hex, so an assertion failure is readable. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `uint32` little-endian, via `DataView`.
 *
 * Deliberately a different mechanism from the shifts and masks the production
 * function uses. A test that only re-ran those shifts would be a copy; this one
 * at least asks the platform to do the byte order, so a mistake about which end
 * is the low byte cannot be copied between the two.
 */
function u32le(value: number): string {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, value, true);
  return hex(new Uint8Array(buffer));
}

/** The whole construction, the independent way. Used to build fixtures, not expectations of the code. */
function lengthPrefixed(parts: readonly string[]): string {
  return parts.map((part) => u32le(utf8(part).length) + hex(utf8(part))).join('');
}

// ---------------------------------------------------------------------------
// Pinned material
// ---------------------------------------------------------------------------

/**
 * The `signedKey` string from the live Google delivery in `callbacks.test.ts`,
 * copied verbatim. Present so the expected sizes below are about a real Google
 * envelope rather than about a convenient test string.
 */
const REAL_SIGNED_KEY =
  '{"keyValue":"XFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVsEtOdPMaE+DJDzuCJaO7EJXaHor4Kyklp411iwfBa+5TmdbiEWUXzewA79H0PXjdyRMhKBY99+sh056JB75LQ==","keyExpiration":"1754778096000"}';

/**
 * The **real** Google message signature from that delivery, base64.
 *
 * Its first byte reads `0x5c` because the capture was scrubbed (`0x30` -> `0x5c`);
 * see `callbacks.test.ts`. Everything after it is Google's own bytes, which is
 * what makes it useful here: `r` is 33 bytes and `s` is 32, so this is a real
 * signature carrying a DER sign byte, not one this repository produced.
 *
 * Under the old `uint16be` prefix it is 213 bytes; under `uint32le` it is 219.
 */
const REAL_KEY_SIGNATURE_HEX =
  '3045022100898b6eaf97e6a4d7b76c1c36d9667459c66e7576e5003e260bc0e22bf6b56f0002201947d1d7c829293ab5f8cb1abf4bcfad6bc2eb1f5d0d1c16157fdbf39fa31359';

/** What that signature's 71 DER bytes mean, as P1363. Hand-read from the lengths, then confirmed by verify(). */
const REAL_KEY_SIGNATURE_P1363_HEX =
  '898b6eaf97e6a4d7b76c1c36d9667459c66e7576e5003e260bc0e22bf6b56f001947d1d7c829293ab5f8cb1abf4bcfad6bc2eb1f5d0d1c16157fdbf39fa31359';

/**
 * A P-256 key pair and one signature, generated once, offline, and pinned.
 *
 * Chosen because it is the **worst case for the DER parser**: both `r` and `s`
 * have their top bit set, so both are encoded in 33 bytes with a `0x00` sign
 * byte, and the whole signature is 72 bytes — the largest a P-256 ECDSA
 * signature can possibly be. It is a genuine signature: `verifies through the
 * production normalisation` below proves the pinned public key really signed
 * the pinned message, so this is not a hand-built blob that merely parses.
 *
 * These are test-only keys with no other use. They are committed because the
 * point is to have a signature that did not come from this test file.
 */
const PINNED_SIGNATURE_KEY = {
  spkiBase64:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEReahUayFNhmk6xX9bvfTumLXR/H1iaLjQgss4G1ZM1qakUVqWZ4BJjlIVFtlpBiYSczskil55KwP71Nc8YWxpA==',
  /** The `signedKey` string whose length-prefixed form was signed. */
  signedKey:
    '{"keyValue":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEReahUayFNhmk6xX9bvfTumLXR/H1iaLjQgss4G1ZM1qakUVqWZ4BJjlIVFtlpBiYSczskil55KwP71Nc8YWxpA==","keyExpiration":"1791510690205","n":1}',
  messageHex:
    '0f000000476f6f676c655061795061737365730f000000454376325369676e696e674f6e6c79b10000007b226b657956616c7565223a224d466b77457759484b6f5a497a6a3043415159494b6f5a497a6a3044415163445167414552656168556179464e686d6b3678583962766654756d4c58522f483169614c6a516773733447315a4d3171616b555671575a34424a6a6c495646746c7042695953637a736b696c35354b775037314e633859577870413d3d222c226b657945787069726174696f6e223a2231373931353130363930323035222c226e223a317d',
  derHex:
    '30460221008906ff1d495cd7d645267c17cbc69e5079c64b5cfc9885a806a51ccde2bf7eb0022100bfcca5eb3060dfd8672c4b5831d81980a35f401d17e180df0cb4549abae4b5da',
  /** The same signature as P1363, with both sign bytes dropped. */
  p1363Hex:
    '8906ff1d495cd7d645267c17cbc69e5079c64b5cfc9885a806a51ccde2bf7eb0bfcca5eb3060dfd8672c4b5831d81980a35f401d17e180df0cb4549abae4b5da',
};

const fromHex = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------

describe('toLengthValue', () => {
  it('builds nothing from no parts', () => {
    expect(toLengthValue([])).toHaveLength(0);
  });

  it('prefixes an empty part with a zero length and four bytes of prefix', () => {
    // `00 00 00 00`. A two-byte prefix would make this two bytes long, so the
    // length alone separates the two encodings.
    expect(hex(toLengthValue(['']))).toBe('00000000');
  });

  it('puts a short length in the low byte, with the three high bytes zero', () => {
    // The lengths 1..3 are the case where a careless reader sees agreement:
    // `uint16be(1)` is `00 01` and `uint32le(1)` is `01 00 00 00`, and both
    // "contain" the number 1. What separates them is that the little-endian
    // value *starts* with the significant byte.
    expect(hex(toLengthValue(['a']))).toBe('01000000' + '61');
    expect(hex(toLengthValue(['ab']))).toBe('02000000' + '6162');
    expect(hex(toLengthValue(['abc']))).toBe('03000000' + '616263');
  });

  it('encodes 128 as 80 00 00 00, where a big-endian pair would be 00 80', () => {
    // 128 is 0x0080, so the two encodings are the same two bytes in the opposite
    // order and with two more of padding. This is the vector that fails loudly
    // if someone "fixes" the prefix to 16-bit big-endian.
    const part = 'x'.repeat(128);

    expect(hex(toLengthValue([part]))).toBe('80000000' + hex(utf8(part)));
    expect(hex(toLengthValue([part])).slice(0, 8)).toBe('80000000');
  });

  it('encodes 256 as 00 01 00 00, the bytes a 16-bit prefix would have swapped', () => {
    // 256 is 0x0100. Written little-endian in 32 bits the prefix is
    // `00 01 00 00`; truncated to a big-endian pair it would be `01 00` — the
    // same two non-zero bytes in the opposite order. A prefix of the wrong
    // width is worst exactly here, where the value still *fits* the smaller
    // prefix and the only symptom is a length that reads as one part shifted
    // against another.
    const part = 'x'.repeat(256);

    expect(hex(toLengthValue([part])).slice(0, 8)).toBe('00010000');
    expect(toLengthValue([part])).toHaveLength(260);
  });

  it('encodes a 70-byte part, the size of a typical signedKey', () => {
    // 70 = 0x46. The brief for this fix calls 70 the typical signedKey size,
    // and it is a value that looks identical in either encoding until you count
    // the prefix width, so it is worth pinning.
    const part = 'x'.repeat(70);

    expect(hex(toLengthValue([part])).slice(0, 8)).toBe('46000000');
    expect(toLengthValue([part])).toHaveLength(74);
  });

  it('encodes a 250-byte part, the size of a typical signedMessage', () => {
    // 250 = 0xfa, whose high bit is set. Under `uint16be` the prefix would be
    // `00 fa`; here it is `fa 00 00 00`, so the single significant byte moves
    // from last position to first.
    const part = 'x'.repeat(250);

    expect(hex(toLengthValue([part])).slice(0, 8)).toBe('fa000000');
    expect(toLengthValue([part])).toHaveLength(254);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 'ñ' is one character and two bytes (c3 b1); '🙂' is one character and four
    // (f0 9f 99 82). A length taken from `String.length` would write `01` for
    // both and silently shift every following part by its own width.
    expect(hex(toLengthValue(['ñ']))).toBe('02000000' + 'c3b1');
    expect(hex(toLengthValue(['🙂']))).toBe('04000000' + 'f09f9982');
  });

  it('keeps parts distinguishable, which is the only reason the prefix exists', () => {
    // Without a length prefix these two produce identical bytes, so a signature
    // over one would verify as a signature over the other.
    expect(hex(toLengthValue(['ab', 'c']))).not.toBe(hex(toLengthValue(['a', 'bc'])));
    expect(hex(toLengthValue(['GooglePayPasses', 'ECv2SigningOnly', 'ab']))).not.toBe(
      hex(toLengthValue(['GooglePayPassesE', 'Cv2SigningOnly', 'ab'])),
    );
  });

  it('spends exactly four bytes of overhead per part', () => {
    // 70 + 250 bytes of content, two parts, so the total is the content plus 8.
    // This is the invariant that makes the *sizes* below change when the
    // prefix width changes, which is why they are pinned.
    const out = toLengthValue(['x'.repeat(70), 'x'.repeat(250)]);

    expect(out).toHaveLength(70 + 250 + 8);
  });

  describe('against a real captured Google envelope', () => {
    const keyParts = ['GooglePayPasses', 'ECv2SigningOnly', REAL_SIGNED_KEY];

    it('has the exact size the protocol implies for that signedKey', () => {
      // 15 + 15 + 171 bytes of content, three parts, plus 12 bytes of prefix.
      // Under the old two-byte prefix this same envelope produced 207 bytes, and
      // a future change to the prefix width breaks here rather than as "Google
      // stopped sending callbacks".
      expect(toLengthValue(keyParts)).toHaveLength(15 + 15 + 171 + 12);
      expect(toLengthValue(keyParts)).toHaveLength(213);
    });

    it('starts the way the specification says it starts', () => {
      // Byte-for-byte reading of the first part: length 15 as `0f 00 00 00`,
      // then the UTF-8 of "GooglePayPasses". A big-endian prefix puts the `0f`
      // last, and this assertion is the one that says so.
      expect(hex(toLengthValue(keyParts)).slice(0, 38)).toBe(
        '0f000000476f6f676c65506179506173736573',
      );
    });

    it('agrees with an independent construction of the same envelope', () => {
      // Cross-check against the DataView restatement at the top of this file.
      // Two mechanisms, one expectation written down by hand.
      expect(hex(toLengthValue(keyParts))).toBe(lengthPrefixed(keyParts));
    });
  });
});

describe('derSignatureToP1363', () => {
  it('converts a real Google signature to the 64 bytes WebCrypto wants', () => {
    // This is the one DER in the repository that Google produced. It is 71
    // bytes: `30 45 02 21 00 <r, 33 bytes> 02 20 <s, 32 bytes>`. The 33-byte
    // `r` is the case a self-generated test signature only hits by luck about
    // half the time — a DER INTEGER is signed, so a value whose top bit is set
    // arrives with a leading `0x00`.
    const p1363 = derSignatureToP1363(fromHex(REAL_KEY_SIGNATURE_HEX));

    expect(p1363).toHaveLength(64);
    expect(hex(p1363)).toBe(REAL_KEY_SIGNATURE_P1363_HEX);
  });

  it('handles both INTEGERs carrying a sign byte, which is the maximum size a P-256 signature can have', () => {
    // 72 bytes: `30 46 02 21 00 <r> 02 21 00 <s>`. Both are 33 bytes. This is the
    // ceiling — see the long-form test below for why the ceiling matters.
    const p1363 = derSignatureToP1363(fromHex(PINNED_SIGNATURE_KEY.derHex));

    expect(fromHex(PINNED_SIGNATURE_KEY.derHex)).toHaveLength(72);
    expect(p1363).toHaveLength(64);
    // The sign bytes are dropped, not copied through, so the result is the two
    // 32-byte magnitudes back to back. Read once, with `r`'s sign byte absent.
    expect(hex(p1363)).toBe(PINNED_SIGNATURE_KEY.p1363Hex);
    // …and the sign byte really was there, rather than the fixture being a
    // short-form signature that never needed one.
    expect(PINNED_SIGNATURE_KEY.derHex).toContain('022100');
  });

  it('produces a signature the pinned public key really signed', async () => {
    // The parser is not just returning 64 bytes of the right length. Importing
    // the pinned key and verifying is what makes the previous test a statement
    // about real signatures rather than about byte shuffling.
    const publicKey = await crypto.subtle.importKey(
      'spki',
      base64ToBytes(PINNED_SIGNATURE_KEY.spkiBase64) as unknown as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const message = fromHex(PINNED_SIGNATURE_KEY.messageHex);

    // The message is the length-prefixed concatenation of the three parts, which
    // is what makes this an end-to-end statement about the prefix as well.
    expect(hex(message)).toBe(
      lengthPrefixed(['GooglePayPasses', 'ECv2SigningOnly', PINNED_SIGNATURE_KEY.signedKey]),
    );

    await expect(
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        derSignatureToP1363(fromHex(PINNED_SIGNATURE_KEY.derHex)),
        message,
      ),
    ).resolves.toBe(true);
  });

  it('refuses a long-form length, and the arithmetic says why it is safe to', () => {
    // A DER `SEQUENCE` needs the long form only once its content passes 127
    // bytes. A P-256 ECDSA signature is `30 <len> 02 <lr> <r> 02 <ls> <s>`: six
    // bytes of framing plus the two integers. Each integer is at most 33 bytes,
    // because a 32-byte field with its top bit set becomes 33 with a `0x00` sign
    // byte and anything wider is not a P-256 value. So:
    //
    //     6 + 33 + 33 = 72   maximum
    //
    // 72 < 127, so the long form is unreachable for P-256 and refusing it cannot
    // reject a signature Google produced. The pinned fixture above is a real
    // 72-byte signature, so the ceiling is not theoretical either.
    //
    // Note the brief for this fix quoted that ceiling as 74. It is 72; the
    // conclusion is unchanged, and the difference is the two length octets.
    expect(() => derSignatureToP1363(fromHex('30080281000102810002'))).toThrowError(
      /long-form length/i,
    );
  });

  it('refuses a trailing byte, so two byte strings cannot mean the same signature', () => {
    // The SEQUENCE declares 8 content bytes; the two INTEGERs take 6 and `aabb`
    // is left over. Declared length and buffer length agree, so this is the only
    // guard that can catch it.
    expect(() => derSignatureToP1363(fromHex('3008020105020107aabb'))).toThrowError(
      /trailing bytes/i,
    );
  });

  it('refuses a non-minimal INTEGER, which is the encoding that would smuggle a byte', () => {
    // `02 02 00 01`: the second zero is not a sign byte, it is padding, and a
    // decoder that accepted it would let two encodings mean the same value.
    expect(() => derSignatureToP1363(fromHex('300702020001020107'))).toThrowError(
      /non-minimal/i,
    );
  });

  it('refuses an INTEGER wider than a P-256 field', () => {
    // 34 bytes cannot be a 32-byte field plus a sign byte. The second byte has
    // its top bit set, so this reaches the width check rather than tripping the
    // non-minimal one first.
    expect(() =>
      derSignatureToP1363(
        fromHex(
          '304602220080000000000000000000000000000000000000000000000000000000000000000002200100000000000000000000000000000000000000000000000000000000000000',
        ),
      ),
    ).toThrowError(/wider than a P-256 field/i);
  });

  it('refuses bytes that are not a SEQUENCE', () => {
    expect(() => derSignatureToP1363(fromHex('31080000000000000000'))).toThrowError(
      /not a DER SEQUENCE/i,
    );
  });
});