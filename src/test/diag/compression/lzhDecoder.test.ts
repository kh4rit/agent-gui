// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCompressionTests/LZHDecoderTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { CompressedDataError, LZHDecoder } from "../../../diag/compression/index.js"
import { assertThrowsInfo } from "../../support/assertions.js"
import {
  DynamicCodeWriter,
  DynamicHeader,
  LZHStreamWriter,
  Samples,
  SpecTables,
  concat,
  decodeLZH,
  range,
  repeated,
  utf8
} from "./testSupport.js"

/** A fixed block with the given literal/length symbols (256 appended). */
function fixedBlock(symbols: ArrayLike<number>, noise = 0, final = true): Uint8Array {
  const writer = new LZHStreamWriter()
  writer.noise(noise)
  writer.blockHeader(final, 1)
  for (let i = 0; i < symbols.length; i++) writer.fixedSymbol(symbols[i])
  writer.fixedSymbol(256)
  return writer.data
}

/** A fixed block producing `produced` bytes of 0x42, then one match of length 3 at `distance`. */
function longHistory(produced: number, distance: number): Uint8Array {
  const writer = new LZHStreamWriter()
  writer.noise(0)
  writer.blockHeader(true, 1)
  writer.fixedSymbol(0x42)
  let remaining = produced - 1
  while (remaining > 0) {
    const length = Math.min(258, remaining)
    if (length < 3) {
      for (let i = 0; i < length; i++) writer.fixedSymbol(0x42)
    } else {
      writer.fixedMatch(length, 1)
    }
    remaining -= length
  }
  writer.fixedMatch(3, distance)
  writer.fixedSymbol(256)
  return writer.data
}

/** LZH decoder behaviour, one spec rule per test (docs/protocol/compression-lzh.md). */
describe("LZH decoder", () => {
  // MARK: Noise prefix and block header

  for (const count of range(0, 3)) {
    test(`anyNoiseCountAndNoiseValue(${count})`, () => {
      // R-LZH-1: any N from 0 to 3 and any noise values.
      for (let noiseBits = 0; noiseBits < 1 << count; noiseBits++) {
        const writer = new LZHStreamWriter()
        writer.noise(count, noiseBits)
        writer.blockHeader(true, 1)
        for (const byte of utf8("ZZNAP")) writer.fixedSymbol(byte)
        writer.fixedSymbol(256)
        assert.deepEqual(decodeLZH(writer.data, 5).bytes, utf8("ZZNAP"))
      }
    })
  }

  test("referenceEncoderPrefixDecodes", () => {
    // PV-0353: N = 3 and three 1 bits; then a fixed block with one literal.
    const writer = new LZHStreamWriter()
    writer.noise(3, 0b111)
    writer.blockHeader(true, 1)
    writer.fixedSymbol(0x41)
    writer.fixedSymbol(256)
    assert.equal(writer.data[0] & 0x1f, 0x1f)
    assert.deepEqual(decodeLZH(concat(writer.data, [0x00]), 1).bytes, Uint8Array.of(0x41))
  })

  for (const type of [0, 3]) {
    test(`blockTypesZeroAndThreeFail(${type})`, () => {
      const writer = new LZHStreamWriter()
      writer.noise(0)
      writer.blockHeader(true, type)
      writer.field(0x1234, 16)
      assert.deepEqual(decodeLZH(writer.data, 1).error, { kind: "badBlockType", blockType: type })
    })
  }

  test("emptyDataIsTruncated", () => {
    assert.deepEqual(decodeLZH(new Uint8Array(0), 0).error, { kind: "dataTruncated" })
    assert.deepEqual(decodeLZH(new Uint8Array(0), 1).error, { kind: "dataTruncated" })
  })

  test("emptyOutputFromEndOfBlockOnly", () => {
    // A declared length of 0 needs a stream that decodes to nothing.
    assert.deepEqual(decodeLZH(fixedBlock([]), 0).bytes, new Uint8Array(0))
    assert.deepEqual(decodeLZH(fixedBlock([0x41]), 0).error, { kind: "lengthMismatch", declaredLength: 0, decodedLength: 1 })
  })

  // MARK: Fixed codes

  test("everyLiteralWithTheFixedCode", () => {
    const all = range(0, 255)
    assert.deepEqual(decodeLZH(fixedBlock(all), 256).bytes, Uint8Array.from(all))
  })

  for (const symbol of [286, 287]) {
    test(`fixedLiteralLengthPositionsBeyondTheAlphabetFail(${symbol})`, () => {
      assert.deepEqual(decodeLZH(fixedBlock([0x41, symbol]), 2).error, { kind: "badSymbol", symbol: { kind: "literalLength", symbol } })
    })
  }

  for (const symbol of [30, 31]) {
    test(`fixedDistancePositionsBeyondTheAlphabetFail(${symbol})`, () => {
      const writer = new LZHStreamWriter()
      writer.noise(0)
      writer.blockHeader(true, 1)
      writer.fixedSymbol(0x41)
      writer.fixedSymbol(257)
      writer.fixedDistance(symbol)
      writer.fixedSymbol(256)
      assert.deepEqual(decodeLZH(writer.data, 4).error, { kind: "badSymbol", symbol: { kind: "distance", symbol } })
    })
  }

  test("everyLengthSymbolAndExtraValue", () => {
    // Symbols 257–285 with every extra value (PV-0359, PV-0373), each at distance 1.
    const writer = new LZHStreamWriter()
    writer.noise(1, 1)
    writer.blockHeader(true, 1)
    writer.fixedSymbol(0x5a)
    const expected: number[] = [0x5a]
    SpecTables.lengthBases.forEach((base, index) => {
      for (let extra = 0; extra < 1 << SpecTables.lengthExtras[index]; extra++) {
        writer.fixedSymbol(257 + index)
        writer.field(extra, SpecTables.lengthExtras[index])
        writer.fixedDistance(0)
        for (let i = 0; i < base + extra; i++) expected.push(0x5a)
      }
    })
    writer.fixedSymbol(256)
    assert.deepEqual(decodeLZH(writer.data, expected.length).bytes, Uint8Array.from(expected))
  })

  test("symbol284WithExtra31IsLength258", () => {
    // R-LZH-2: base 227 + 31 = 258 is accepted.
    const writer = new LZHStreamWriter()
    writer.noise(0)
    writer.blockHeader(true, 1)
    writer.fixedSymbol(0x41)
    writer.fixedSymbol(284)
    writer.field(31, 5)
    writer.fixedDistance(0)
    writer.fixedSymbol(256)
    assert.deepEqual(decodeLZH(writer.data, 259).bytes, repeated(0x41, 259))
  })

  test("overlappingAndNonOverlappingMatches", () => {
    const writer = new LZHStreamWriter()
    writer.noise(2, 2)
    writer.blockHeader(true, 1)
    for (const byte of utf8("ZZSOCK")) writer.fixedSymbol(byte)
    writer.fixedMatch(6, 6) // copy, no overlap
    writer.fixedMatch(10, 4) // overlap
    writer.fixedMatch(7, 1) // run
    writer.fixedSymbol(256)
    const expected = Array.from(utf8("ZZSOCK"))
    expected.push(...expected.slice(0, 6))
    for (let i = 0; i < 10; i++) expected.push(expected[expected.length - 4])
    for (let i = 0, last = expected[expected.length - 1]; i < 7; i++) expected.push(last)
    assert.deepEqual(decodeLZH(writer.data, expected.length).bytes, Uint8Array.from(expected))
  })

  // MARK: Distances (PV-0071, R-LZH-5)

  test("largestDistanceIsAccepted", () => {
    const data = longHistory(16_200, 16_122)
    assert.deepEqual(decodeLZH(data, 16_203).bytes, repeated(0x42, 16_203))
  })

  for (const distance of [16_123, 16_384, 16_385, 24_577, 32_768]) {
    test(`distancesAboveTheLimitFail(${distance})`, () => {
      const data = longHistory(33_000, distance)
      assert.deepEqual(decodeLZH(data, 33_003).error, { kind: "badDistance", distance, producedLength: 33_000 })
    })
  }

  test("distanceReachingBeforeTheMessageFails", () => {
    const data = longHistory(100, 101)
    assert.deepEqual(decodeLZH(data, 103).error, { kind: "badDistance", distance: 101, producedLength: 100 })
    assert.equal(decodeLZH(longHistory(100, 100), 103).bytes?.length, 103)
  })

  // MARK: Blocks and history

  test("blocksFollowWithoutAlignmentAndShareTheHistory", () => {
    const writer = new LZHStreamWriter()
    writer.noise(3, 5)
    writer.blockHeader(false, 1)
    for (const byte of utf8("ZZNAP")) writer.fixedSymbol(byte)
    writer.fixedSymbol(256)
    // A dynamic block that copies from the fixed block before it.
    // Length 5 is symbol 259; distance 5 is symbol 4 with one extra bit.
    const literalLength = SpecTables.flatLengths([0x21, 256, 259], 260)
    const distance = SpecTables.flatLengths([0, 4], 5)
    writer.blockHeader(false, 2)
    DynamicHeader.forLengths(literalLength, distance).write(writer)
    const codes = new DynamicCodeWriter(literalLength, distance)
    codes.match(5, 5, writer)
    codes.symbol(0x21, writer)
    codes.symbol(256, writer)
    writer.blockHeader(true, 1)
    writer.fixedMatch(3, 11)
    writer.fixedSymbol(256)
    assert.deepEqual(decodeLZH(writer.data, 14).bytes, utf8("ZZNAPZZNAP!ZZN"))
  })

  test("trailingBitsAndBytesAreIgnored", () => {
    const data = fixedBlock([0x41])
    data[data.length - 1] |= 0xe0 // bits after the end of block in the last byte
    assert.deepEqual(decodeLZH(concat(data, [0xff, 0x00, 0x13]), 1).bytes, Uint8Array.of(0x41))
  })

  // MARK: Truncation (IMPL-LZH-1)

  test("everyCutBeforeTheFinalEndOfBlockIsTruncated", () => {
    const writer = new LZHStreamWriter()
    writer.noise(3, 7)
    writer.blockHeader(false, 1)
    for (const byte of Samples.silly.subarray(0, 40)) writer.fixedSymbol(byte)
    writer.fixedSymbol(256)
    // Length 11 is symbol 265, 24 is 270 + 1; distance 40 is symbol 10, 4 is symbol 3.
    const literalLength = SpecTables.flatLengths([...range(0x20, 0x7a), 256, 265, 270], 271)
    const distance = SpecTables.flatLengths([3, 10], 11)
    writer.blockHeader(true, 2)
    DynamicHeader.forLengths(literalLength, distance).write(writer)
    const codes = new DynamicCodeWriter(literalLength, distance)
    codes.match(11, 40, writer)
    codes.match(24, 4, writer)
    codes.symbol(0x7a, writer)
    codes.symbol(256, writer)
    const data = writer.data
    const full = decodeLZH(data, 76)
    assert.equal(full.bytes?.length, 76)
    // The stream ends exactly in its last byte, so every shorter prefix lacks bits.
    for (let cut = 0; cut < data.length; cut++)
      assert.deepEqual(decodeLZH(data.subarray(0, cut), 76).error, { kind: "dataTruncated" }, `cut at ${cut}`)
  })

  test("noLookaheadIsNeededPastTheLastCode", () => {
    // Prefix 5 bits, header 3, literals 8 + 8 + 9 + 8, end of block 7: 48 bits, so the end of
    // block ends exactly at the last bit of the input.
    const writer = new LZHStreamWriter()
    writer.noise(3, 0)
    writer.blockHeader(true, 1)
    for (const byte of [0x5a, 0x5a, 0x90, 0x41]) writer.fixedSymbol(byte)
    writer.fixedSymbol(256)
    assert.equal(writer.bitCount, 48)
    assert.deepEqual(decodeLZH(writer.data, 4).bytes, Uint8Array.of(0x5a, 0x5a, 0x90, 0x41))
    assert.deepEqual(decodeLZH(writer.data.subarray(0, writer.data.length - 1), 4).error, { kind: "dataTruncated" })
  })

  // MARK: Output length (PV-0314, IMPL-LZH-3, IMPL-LZH-4)

  test("shortOutputFails", () => {
    assert.deepEqual(decodeLZH(fixedBlock([0x41, 0x42]), 3).error, { kind: "lengthMismatch", declaredLength: 3, decodedLength: 2 })
  })

  test("literalPastTheDeclaredLengthFailsAtOnce", () => {
    assert.deepEqual(decodeLZH(fixedBlock([0x41, 0x42, 0x43]), 2).error, { kind: "lengthMismatch", declaredLength: 2, decodedLength: 3 })
  })

  test("matchPastTheDeclaredLengthFailsAtOnce", () => {
    const writer = new LZHStreamWriter()
    writer.noise(0)
    writer.blockHeader(true, 1)
    writer.fixedSymbol(0x41)
    writer.fixedMatch(10, 1)
    writer.fixedSymbol(256)
    assert.deepEqual(decodeLZH(writer.data, 8).error, { kind: "lengthMismatch", declaredLength: 8, decodedLength: 11 })
    assert.equal(decodeLZH(writer.data, 11).bytes?.length, 11)
  })

  test("declaredLengthAboveTheCapFailsBeforeDecoding", () => {
    // (Swift also checks that the output array keeps its capacity; here nothing is returned.)
    const decoder = new LZHDecoder()
    assertThrowsInfo(CompressedDataError, { kind: "lengthOverCap", declaredLength: 0xffff_ffff, cap: 1 << 20 }, () =>
      decoder.decode(new Uint8Array(0), 0xffff_ffff, 1 << 20)
    )
    assert.deepEqual(decodeLZH(fixedBlock([0x41, 0x42]), 2, 1).error, { kind: "lengthOverCap", declaredLength: 2, cap: 1 })
    assert.deepEqual(decodeLZH(fixedBlock([0x41, 0x42]), 2, 2).bytes, Uint8Array.of(0x41, 0x42))
  })

  // MARK: APIs

  // Swift's MutableSpan overload collapses into decode(data, declaredLength, maxLength): the
  // caller's buffer size is the declared length.
  test("mutableSpanAPIWritesTheCallersBuffer", () => {
    const data = fixedBlock(Samples.silly)
    const decoder = new LZHDecoder()
    assert.deepEqual(decoder.decode(data, Samples.silly.length, Samples.silly.length), Samples.silly)
    assertThrowsInfo(CompressedDataError, { kind: "lengthMismatch", declaredLength: 3, decodedLength: 4 }, () => decoder.decode(data, 3, 3))
  })

  // The capacity and buffer-address checks of the Swift test do not apply: decode returns a new
  // array, and on failure nothing.
  test("outputCapacityIsReusedAndFailureEmptiesTheOutput", () => {
    const decoder = new LZHDecoder()
    const data = fixedBlock(Samples.silly)
    assert.deepEqual(decoder.decode(data, Samples.silly.length, 1 << 20), Samples.silly)
    for (let i = 0; i < 20; i++) assert.deepEqual(decoder.decode(data, Samples.silly.length, 1 << 20), Samples.silly)
    assert.throws(() => decoder.decode(data, 5, 1 << 20), CompressedDataError)
  })
})
