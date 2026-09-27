// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCompressionTests/LZHEncoderTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { LZHDecoder, LZHEncoder, LZHEncodingError, type LZHEncoderConfiguration } from "../../../diag/compression/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { assertThrowsInfo } from "../../support/assertions.js"
import { Samples, concat, decodeLZH, range, repeated } from "./testSupport.js"

function encode(input: Uint8Array, configuration: Partial<LZHEncoderConfiguration> = {}): Uint8Array {
  return new LZHEncoder(configuration).encode(input)
}

const inputs: [string, Uint8Array][] = [
  ["one byte", Uint8Array.of(0x5a)],
  ["two bytes", Uint8Array.of(0x5a, 0x5a)],
  ["silly text", Samples.silly],
  ["screen-like 64 KiB", Samples.screenLike(65_536, 1)],
  ["random 20 KiB", Samples.random(20_000, 2)],
  ["all zero 100 KiB", new Uint8Array(100_000)],
  ["every byte value", Uint8Array.from(range(0, 255))]
]

const BLOCK_CODES = ["automatic", "fixed", "dynamic"] as const

/**
 * The LZH encoder against the encoder rules E-LZH-1 to E-LZH-8, round-tripped through the decoder
 * (which rejects every stream those rules forbid: stored blocks, incomplete codes, runs across
 * sequences, a leading 16, distances above 16 122).
 */
describe("LZH encoder", () => {
  for (const codes of BLOCK_CODES) {
    test(`roundTrips(${codes})`, () => {
      for (const [name, input] of inputs) {
        const data = encode(input, { blockCodes: codes })
        assert.deepEqual(decodeLZH(data, input.length).bytes, input, `${name}, ${codes}`)
      }
    })
  }

  for (const symbolsPerBlock of [1, 2, 3, 17, 1000]) {
    test(`manyBlocksRoundTrip(${symbolsPerBlock})`, () => {
      const input = Samples.screenLike(12_000, symbolsPerBlock)
      for (const codes of BLOCK_CODES) {
        const data = encode(input, { blockCodes: codes, maxSymbolsPerBlock: symbolsPerBlock })
        assert.deepEqual(decodeLZH(data, input.length).bytes, input)
      }
    })
  }

  test("noMatchesWithChainLengthZero", () => {
    const input = Samples.silly
    const data = encode(input, { blockCodes: "fixed", maxChainLength: 0 })
    // Literals only with the fixed code: at least 8 bits per byte.
    assert.ok(data.length >= input.length)
    assert.deepEqual(decodeLZH(data, input.length).bytes, input)
  })

  test("noisePrefixAndTrailingByte", () => {
    for (const [, input] of inputs) {
      const data = encode(input)
      // E-LZH-2: bits 0–4 of the first byte are set (count 3, noise 111).
      assert.equal(data[0] & 0x1f, 0x1f)
      // E-LZH-6: one 0x00 byte after the last byte, which the decoder does not need.
      assert.equal(data[data.length - 1], 0x00)
      assert.deepEqual(decodeLZH(data.subarray(0, data.length - 1), input.length).bytes, input)
    }
  })

  test("distanceLimitIsKept", () => {
    // A 64-byte random pattern repeated at distance 16 123 only: the encoder must not use that
    // distance (E-LZH-4); at 16 122 it may.
    const pattern = Samples.random(64, 9)
    for (const gap of [16_122 - 64, 16_123 - 64, 16_500]) {
      const input = concat(pattern, Samples.random(gap, 10), pattern)
      const data = encode(input, { maxChainLength: 4096 })
      assert.deepEqual(decodeLZH(data, input.length).bytes, input)
    }
    // The repeat within range compresses; the one out of range does not.
    const near = concat(pattern, Samples.random(16_122 - 64, 10), pattern)
    const far = concat(pattern, Samples.random(16_123 - 64, 10), pattern)
    const nearSize = encode(near, { maxChainLength: 4096 }).length
    const farSize = encode(far, { maxChainLength: 4096 }).length
    assert.ok(farSize > nearSize + 32, `far ${farSize}, near ${nearSize}`)
  })

  test("emptyInputIsRefused", () => {
    const encoder = new LZHEncoder()
    const output = new ByteWriter()
    output.u8(0xab)
    assertThrowsInfo(LZHEncodingError, { kind: "emptyInput" }, () => encoder.encodeInto(new Uint8Array(0), output))
    assert.deepEqual(output.toBytes(), Uint8Array.of(0xab))
  })

  // DiagCodec's CompressionHeader and the decompress harness are not part of this module: the
  // header is written by hand as the Swift test expects it, and the data after it is decoded
  // directly.
  test("appendsAfterExistingBytesWithTheHeader", () => {
    // E-LZH-1: the caller writes the compression header, then the data.
    const input = Samples.silly
    const output = new ByteWriter()
    output.u32le(input.length).bytes([0x12, 0x1f, 0x9d, 0x02])
    new LZHEncoder().encodeInto(input, output)
    const bytes = output.toBytes()
    assert.deepEqual(bytes.subarray(0, 8), Uint8Array.of(input.length & 0xff, input.length >> 8, 0, 0, 0x12, 0x1f, 0x9d, 0x02))
    assert.deepEqual(new LZHDecoder().decode(bytes.subarray(8), input.length, 1 << 20), input)
  })

  test("deterministicAndHistoryPerMessage", () => {
    // E-LZH-7: a reused encoder gives the same bytes as a fresh one.
    const encoder = new LZHEncoder()
    for (const [, input] of inputs) assert.deepEqual(encoder.encode(input), encode(input))
  })

  test("compressesRepetitiveData", () => {
    const input = Samples.screenLike(65_536, 4)
    const data = encode(input)
    assert.ok(data.length < input.length / 3, `${data.length} bytes`)
    const zeros = encode(new Uint8Array(100_000))
    assert.ok(zeros.length < 1_000, `${zeros.length} bytes`)
  })

  for (const symbols of range(14, 26)) {
    test(`skewedFrequenciesAreLengthLimited(${symbols})`, () => {
      // Fibonacci frequencies give a Huffman tree as deep as there are symbols; beyond 15 the
      // encoder must limit the lengths and still send complete codes (PV-0371, PV-0372).
      const fibonacci = [1, 1]
      while (fibonacci.length < symbols) fibonacci.push(fibonacci[fibonacci.length - 1] + fibonacci[fibonacci.length - 2])
      const input = concat(...fibonacci.map((count, symbol) => repeated(0x41 + symbol, count)))
      const data = encode(input, { blockCodes: "dynamic", maxSymbolsPerBlock: 1 << 20, maxChainLength: 0 })
      assert.deepEqual(decodeLZH(data, input.length).bytes, input)
    })
  }

  test("limitingCanOvershootAndIsCorrectedBack", () => {
    // Literal counts (found with a model of the length limiter) for which lengthening codes to
    // fit 15 bits overshoots and some codes must be shortened again to stay complete.
    const counts = [1, 2, 2, 3, 6, 7, 9, 26, 40, 71, 96, 185, 303, 321, 643, 1008, 1270, 2404, 4303, 8638, 13803]
    const input = concat(...counts.map((count, symbol) => repeated(0x41 + symbol, count)))
    const data = encode(input, { blockCodes: "dynamic", maxSymbolsPerBlock: 1 << 20, maxChainLength: 0 })
    assert.deepEqual(decodeLZH(data, input.length).bytes, input)
  })

  test("configurationClampsItsLimits", () => {
    const configuration = new LZHEncoder({ maxSymbolsPerBlock: 0, maxChainLength: -5 }).configuration
    assert.equal(configuration.maxSymbolsPerBlock, 1)
    assert.equal(configuration.maxChainLength, 0)
  })
})
