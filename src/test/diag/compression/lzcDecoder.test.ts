// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCompressionTests/LZCDecoderTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { CompressedDataError, LZCDecoder, LZCParameters } from "../../../diag/compression/index.js"
import { assertThrowsInfo } from "../../support/assertions.js"
import { LZCTestEncoder, LZHStreamWriter, Samples, concat, decodeLZC, range, repeated, utf8 } from "./testSupport.js"

/**
 * Packs codes of one width back to back, least significant bit first (PV-0388). No chunk
 * handling: only for streams that stay within one width and one chunk structure.
 */
function pack(codes: number[], width = 9): Uint8Array {
  const writer = new LZHStreamWriter()
  for (const code of codes) writer.field(code, width)
  return writer.data
}

/** LZC decoder behaviour (docs/protocol/compression-lzc.md). */
describe("LZC decoder", () => {
  // MARK: Parameters (PV-0310 to PV-0313)

  test("parametersFromEveryByte7", () => {
    for (let byte7 = 0; byte7 <= 255; byte7++) {
      const maxbits = byte7 & 0x1f
      const blockMode = (byte7 & 0x80) !== 0
      assert.equal(LZCParameters.maxbits(byte7), maxbits)
      assert.equal(LZCParameters.blockMode(byte7), blockMode)
      if (maxbits >= 9 && maxbits <= 16) {
        const parameters = LZCParameters.fromHeaderByte7(byte7)
        assert.ok(parameters.maxbits === maxbits && parameters.blockMode === blockMode)
        // Bits 0x20 and 0x40 are ignored and not written back (E-LZC-1).
        assert.equal(parameters.headerByte7, byte7 & 0x9f)
      } else {
        assertThrowsInfo(CompressedDataError, { kind: "badMaxbits", maxbits }, () => LZCParameters.fromHeaderByte7(byte7))
      }
    }
    assertThrowsInfo(CompressedDataError, { kind: "badMaxbits", maxbits: 17 }, () => new LZCParameters(17, true))
    assertThrowsInfo(CompressedDataError, { kind: "badMaxbits", maxbits: 8 }, () => new LZCParameters(8, false))
  })

  // MARK: Codes

  test("singleLiteral", () => {
    assert.deepEqual(decodeLZC(Uint8Array.of(0x41, 0x00), 1).bytes, Uint8Array.of(0x41))
  })

  test("codeEqualToNextFree", () => {
    // A, B, 257 (AB), 259 = next free: ABA (PV-0392).
    assert.deepEqual(decodeLZC(pack([0x41, 0x42, 257, 259]), 7).bytes, utf8("ABABABA"))
  })

  test("singleBlockModeCode256IsAnEntry", () => {
    // Single-block mode: A, B, 256 (AB), 258 = next free: ABA (PV-0387).
    assert.deepEqual(decodeLZC(pack([0x41, 0x42, 256, 258]), 7, { blockMode: false }).bytes, utf8("ABABABA"))
    // Code 256 right after the first literal equals next free: A + A.
    assert.deepEqual(decodeLZC(pack([0x5a, 256]), 3, { blockMode: false }).bytes, utf8("ZZZ"))
  })

  test("firstCodeMustBeALiteral", () => {
    assert.deepEqual(decodeLZC(pack([257]), 1).error, { kind: "badCode", code: { kind: "notALiteral", code: 257 } })
    assert.deepEqual(decodeLZC(pack([256]), 1, { blockMode: false }).error, { kind: "badCode", code: { kind: "notALiteral", code: 256 } })
    assert.deepEqual(decodeLZC(pack([511]), 1, { blockMode: false }).error, { kind: "badCode", code: { kind: "notALiteral", code: 511 } })
  })

  test("codeBeyondNextFreeFails", () => {
    assert.deepEqual(decodeLZC(pack([0x41, 258]), 3).error, {
      kind: "badCode",
      code: { kind: "beyondNextFree", code: 258, nextFree: 257 }
    })
    assert.deepEqual(decodeLZC(pack([0x41, 0x42, 300]), 9).error, {
      kind: "badCode",
      code: { kind: "beyondNextFree", code: 300, nextFree: 258 }
    })
  })

  // MARK: Clear code and chunks (PV-0389, PV-0394)

  test("clearSkipsTheRestOfTheChunk", () => {
    // Chunk 1 (9 bytes): A, clear, then filler; chunk 2: B.
    const first = pack([0x41, 256])
    const data = concat(first, repeated(0xee, 9 - first.length), pack([0x42]))
    assert.deepEqual(decodeLZC(data, 2).bytes, Uint8Array.of(0x41, 0x42))
  })

  test("clearIsAcceptedAnywhere", () => {
    // First code, and twice in a row: each clear starts a new 9-byte chunk.
    const data = concat(pack([256]), repeated(0x33, 7), pack([256]), repeated(0x44, 7), pack([0x5a, 0x5a, 257]))
    assert.deepEqual(decodeLZC(data, 4).bytes, utf8("ZZZZ"))
  })

  test("afterAClearTheFirstCodeMustBeALiteral", () => {
    const data = concat(pack([0x41, 0x42, 256]), repeated(0, 5), pack([257]))
    assert.deepEqual(decodeLZC(data, 4).error, { kind: "badCode", code: { kind: "notALiteral", code: 257 } })
  })

  test("clearResetsTheDictionary", () => {
    // Before the clear, 257 = AB. After it, 257 is next free again: first code C, then 257 =
    // C + C.
    const data = concat(pack([0x41, 0x42, 256]), repeated(0, 5), pack([0x43, 257]))
    assert.deepEqual(decodeLZC(data, 5).bytes, utf8("ABCCC"))
  })

  // MARK: End of stream (PV-0395, IMPL-LZC-1 to IMPL-LZC-3)

  test("inputLeftAfterTheDeclaredLengthIsIgnored", () => {
    assert.deepEqual(decodeLZC(pack([0x41, 0x42, 0x43, 0x1ff]), 2).bytes, Uint8Array.of(0x41, 0x42))
    assert.deepEqual(decodeLZC(Uint8Array.of(0x41, 0x00, 0xff, 0xff, 0xff), 1).bytes, Uint8Array.of(0x41))
  })

  test("declaredLengthZeroReadsNothing", () => {
    assert.deepEqual(decodeLZC(new Uint8Array(0), 0).bytes, new Uint8Array(0))
    assert.deepEqual(decodeLZC(Uint8Array.of(0xff, 0xff), 0).bytes, new Uint8Array(0))
  })

  test("inputEndingEarlyIsALengthMismatch", () => {
    assert.deepEqual(decodeLZC(new Uint8Array(0), 1).error, { kind: "lengthMismatch", declaredLength: 1, decodedLength: 0 })
    assert.deepEqual(decodeLZC(Uint8Array.of(0x41), 1).error, { kind: "lengthMismatch", declaredLength: 1, decodedLength: 0 })
    assert.deepEqual(decodeLZC(pack([0x41, 0x42, 257, 259]), 8).error, { kind: "lengthMismatch", declaredLength: 8, decodedLength: 7 })
  })

  test("stringPastTheDeclaredLengthFailsAtOnce", () => {
    // 257 = AB would reach 4 of a declared 3; 259 = ABA would reach 7 of 6.
    assert.deepEqual(decodeLZC(pack([0x41, 0x42, 257]), 3).error, { kind: "lengthMismatch", declaredLength: 3, decodedLength: 4 })
    assert.deepEqual(decodeLZC(pack([0x41, 0x42, 257, 259]), 6).error, { kind: "lengthMismatch", declaredLength: 6, decodedLength: 7 })
  })

  // MARK: Width growth (PV-0390, R-LZC-3)

  for (const blockMode of [true, false]) {
    test(`widthGrowsWhenNextFreePassesTheLargestCode(${blockMode})`, () => {
      // Literals 0–255 then more literals: block mode switches to 10 bits at code 257, single-
      // block mode at code 258. The test encoder follows E-LZC-3; the decoder must agree.
      const input = concat(Uint8Array.from(range(0, 255)), utf8("ZZSOCK"))
      const data = new LZCTestEncoder({ maxbits: 16, blockMode }).encode(input)
      assert.deepEqual(decodeLZC(data, input.length, { blockMode }).bytes, input)
      // A stream written without the width change does not decode to the same bytes.
      const flat = pack(Array.from(input))
      assert.notDeepEqual(decodeLZC(flat, input.length, { blockMode }).bytes, input)
    })
  }

  for (const maxbits of range(9, 16)) {
    test(`roundTripsAtEveryMaxbits(${maxbits})`, () => {
      for (const blockMode of [true, false]) {
        for (const input of [Samples.silly, Samples.screenLike(40_000, maxbits), Samples.random(3_000, 7)]) {
          const data = new LZCTestEncoder({ maxbits, blockMode }).encode(input)
          assert.deepEqual(decodeLZC(data, input.length, { maxbits, blockMode }).bytes, input)
        }
      }
    })
  }

  for (const every of [1, 2, 7, 8, 9, 100, 255, 256, 257, 700]) {
    test(`clearsAtAnyPointRoundTrip(${every})`, () => {
      const input = Samples.screenLike(12_000, every)
      for (const maxbits of [9, 12, 16]) {
        const encoder = new LZCTestEncoder({ maxbits, blockMode: true, clearEvery: every })
        encoder.filler = 0xa5
        const data = encoder.encode(input)
        assert.deepEqual(decodeLZC(data, input.length, { maxbits }).bytes, input)
      }
    })
  }

  test("fullDictionaryAtMaxbits16", () => {
    // Random input fills all 65 536 codes; entries stop at 2^16 (PV-0391).
    const input = Samples.random(200_000, 16)
    for (const blockMode of [true, false]) {
      const data = new LZCTestEncoder({ maxbits: 16, blockMode }).encode(input)
      assert.deepEqual(decodeLZC(data, input.length, { maxbits: 16, blockMode }).bytes, input)
    }
  })

  test("fillerInSkippedChunkPartsIsIgnored", () => {
    const input = Samples.screenLike(5_000, 3)
    for (const filler of [0x00, 0xff, 0x5a]) {
      const encoder = new LZCTestEncoder({ maxbits: 12, blockMode: false })
      encoder.filler = filler
      assert.deepEqual(decodeLZC(encoder.encode(input), input.length, { maxbits: 12, blockMode: false }).bytes, input)
    }
  })

  // MARK: APIs and reuse

  test("decoderReuseAcrossMaxbits", () => {
    const decoder = new LZCDecoder()
    for (const maxbits of [9, 16, 9, 13, 16, 10]) {
      const input = Samples.screenLike(20_000, maxbits)
      const blockMode = maxbits % 2 === 0
      const data = new LZCTestEncoder({ maxbits, blockMode }).encode(input)
      assert.deepEqual(decodeLZC(data, input.length, { maxbits, blockMode, decoder }).bytes, input)
    }
  })

  // Swift's MutableSpan overload collapses into decode(data, parameters, declaredLength,
  // maxLength): the caller's buffer size is the declared length.
  test("mutableSpanAPI", () => {
    const data = pack([0x41, 0x42, 257, 259])
    const decoder = new LZCDecoder()
    const parameters = new LZCParameters(12, true)
    assert.deepEqual(decoder.decode(data, parameters, 7, 7), utf8("ABABABA"))
    assert.deepEqual(decoder.decode(Uint8Array.of(0xff), parameters, 0, 0), new Uint8Array(0))
  })

  test("declaredLengthAboveTheCapFails", () => {
    const decoder = new LZCDecoder()
    const parameters = new LZCParameters(16, true)
    const data = Uint8Array.of(0x41, 0x00)
    // (Swift also checks that the output array is left empty; here nothing is returned.)
    assertThrowsInfo(CompressedDataError, { kind: "lengthOverCap", declaredLength: 2, cap: 1 }, () => decoder.decode(data, parameters, 2, 1))
  })
})
