// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/CompressionHeaderTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  CompressionAlgorithm,
  CompressionHeader,
  CompressionHeaderDecodingError,
  CompressionHeaderEncodingError,
  CompressionHeaderError,
  Decompression,
  Decompressor
} from "../../../diag/codec/index.js"
import { CompressedDataError, LZCParameters, LZHEncoder, compressedDataErrorClass } from "../../../diag/compression/index.js"
import { ByteWriter, hexText } from "../../../diag/wire/index.js"
import { compressionHeaderDecodingErrorClass } from "../../vectors/codecRunners.js"
import { loadVector, vectorFiles } from "../../vectors/paths.js"
import { NO_ERROR } from "../../vectors/wireRunners.js"
import { ascii, bytes, throwsInfo } from "../../support/codecTestSupport.js"

describe("Compression header", () => {
  test("decodesLZH", () => {
    const header = CompressionHeader.decode(bytes(0x02, 0x01, 0x00, 0x00, 0x12, 0x1f, 0x9d, 0x02))
    assert.equal(header.uncompressedLength, 258)
    assert.equal(header.algorithm, "lzh")
    assert.ok(header.version === 1 && header.hasKnownVersion)
    assert.equal(header.level, 2)
    assert.ok(header.maxbits === undefined && header.blockMode === undefined && header.unusedBits === undefined)
    assert.equal(header.lzcParameters(), undefined)
    assert.equal(header.algorithmByte, 0x12)
    assert.equal(header.byte7, 2)
  })

  test("decodesLZC", () => {
    const header = CompressionHeader.decode(bytes(0x70, 0x11, 0x01, 0x00, 0x11, 0x1f, 0x9d, 0x90, 0xab))
    assert.equal(header.uncompressedLength, 70000)
    assert.equal(header.algorithm, "lzc")
    assert.equal(header.version, 1)
    assert.equal(header.maxbits, 16)
    assert.equal(header.blockMode, true)
    assert.equal(header.unusedBits, 0)
    assert.equal(header.level, undefined)
    assert.deepEqual(header.lzcParameters(), new LZCParameters(16, true))
  })

  test("lengthIsLittleEndianAndUnsigned", () => {
    assert.equal(CompressionHeader.decode(bytes(0xff, 0xff, 0xff, 0xff, 0x12, 0x1f, 0x9d, 0x02)).uncompressedLength, 0xffffffff)
    assert.equal(CompressionHeader.decode(bytes(0x01, 0x02, 0x03, 0x04, 0x12, 0x1f, 0x9d, 0x02)).uncompressedLength, 0x04030201)
  })

  test("dispatchUsesTheLowNibbleOnly", () => {
    // Both sources label 0x10 "LZC", but nibble 0 names no algorithm.
    throwsInfo(() => CompressionHeader.decode(bytes(0, 1, 0, 0, 0x10, 0x1f, 0x9d, 0x90)), CompressionHeaderDecodingError, {
      kind: "unknownAlgorithm",
      byte: 0x10
    })
    for (let byte = 0; byte <= 0xff; byte++) {
      const input = bytes(0, 1, 0, 0, byte, 0x1f, 0x9d, 0x89)
      const nibble = byte & 0x0f
      if (nibble === 1 || nibble === 2) {
        // IMPL-CH-8: other versions are reported, not rejected (#25).
        const header = CompressionHeader.decode(input)
        assert.equal(header.algorithm, nibble === 1 ? "lzc" : "lzh")
        assert.equal(header.version, byte >> 4)
        assert.equal(header.hasKnownVersion, byte >> 4 === 1)
        assert.deepEqual(header.bytes, input)
      } else {
        throwsInfo(() => CompressionHeader.decode(input), CompressionHeaderDecodingError, { kind: "unknownAlgorithm", byte })
        throwsInfo(() => CompressionHeader.parse(input), CompressionHeaderError, { kind: "unknownAlgorithm", byte })
      }
    }
  })

  test("checkOrderIsTruncatedMagicAlgorithmMaxbits", () => {
    // IMPL-CH-4: each header below has two faults; the earlier check wins.
    throwsInfo(() => CompressionHeader.decode(bytes(0, 0, 0, 0, 0x13, 0x9d, 0x1f, 0)), CompressionHeaderDecodingError, {
      kind: "badMagic",
      first: 0x9d,
      second: 0x1f
    })
    throwsInfo(() => CompressionHeader.decode(bytes(2, 1, 0, 0, 0x11, 0x1f, 0x9e, 0x80)), CompressionHeaderDecodingError, {
      kind: "badMagic",
      first: 0x1f,
      second: 0x9e
    })
    throwsInfo(() => CompressionHeader.decode(bytes(2, 1, 0, 0, 0x13, 0x1f, 0x9d, 0x80)), CompressionHeaderDecodingError, {
      kind: "unknownAlgorithm",
      byte: 0x13
    })
    throwsInfo(() => CompressionHeader.decode(bytes(2, 1, 0, 0, 0x12, 0x00, 0x9d, 2)), CompressionHeaderDecodingError, {
      kind: "badMagic",
      first: 0x00,
      second: 0x9d
    })
    for (let count = 0; count < 8; count++) {
      throwsInfo(() => CompressionHeader.decode(new Uint8Array(count).fill(0x11)), CompressionHeaderDecodingError, {
        kind: "truncated",
        availableByteCount: count
      })
      throwsInfo(() => CompressionHeader.parse(new Uint8Array(count).fill(0x11)), CompressionHeaderError, {
        kind: "truncated",
        availableByteCount: count
      })
    }
    throwsInfo(() => CompressionHeader.parse(bytes(0, 0, 0, 0, 0x13, 0x9d, 0x1f, 0)), CompressionHeaderError, {
      kind: "badMagic",
      first: 0x9d,
      second: 0x1f
    })
  })

  /**
   * R-CH-5 (v1): maxbits = byte 7 & 0x1F, block mode = bit 0x80, bits 0x20 and 0x40 ignored; the
   * decoder rejects maxbits outside 9–16, the structural parse reports it.
   */
  test("lzcByte7", () => {
    for (let byte7 = 0; byte7 <= 0xff; byte7++) {
      const input = bytes(9, 0, 0, 0, 0x11, 0x1f, 0x9d, byte7)
      const parsed = CompressionHeader.parse(input)
      assert.equal(parsed.maxbits, byte7 & 0x1f)
      assert.equal(parsed.blockMode, (byte7 & 0x80) !== 0)
      assert.equal(parsed.unusedBits, byte7 & 0x60)
      assert.deepEqual(parsed.bytes, input)
      const maxbits = byte7 & 0x1f
      if (maxbits >= 9 && maxbits <= 16) {
        assert.deepEqual(CompressionHeader.decode(input), parsed)
        assert.equal(parsed.lzcParameters()?.maxbits, maxbits)
      } else {
        throwsInfo(() => CompressionHeader.decode(input), CompressionHeaderDecodingError, { kind: "badMaxbits", maxbits })
        throwsInfo(() => parsed.lzcParameters(), CompressedDataError, { kind: "badMaxbits", maxbits })
      }
    }
  })

  test("lzhLevelIsReportedNeverChecked", () => {
    // IMPL-CH-3: any LZH level decodes and round-trips.
    for (let byte7 = 0; byte7 <= 0xff; byte7++) {
      const input = bytes(9, 0, 0, 0, 0x12, 0x1f, 0x9d, byte7)
      const header = CompressionHeader.decode(input)
      assert.equal(header.level, byte7)
      assert.deepEqual(header.bytes, input)
    }
  })

  test("encoders", () => {
    assert.deepEqual(CompressionHeader.lzh(258).bytes, bytes(0x02, 0x01, 0, 0, 0x12, 0x1f, 0x9d, 0x02))
    assert.deepEqual(CompressionHeader.lzh(1, { level: 9, version: 3 }).bytes, bytes(1, 0, 0, 0, 0x32, 0x1f, 0x9d, 9))
    assert.deepEqual(CompressionHeader.lzc(256, 16).bytes, bytes(0, 1, 0, 0, 0x11, 0x1f, 0x9d, 0x90))
    assert.deepEqual(CompressionHeader.lzc(300, 9).bytes, bytes(0x2c, 0x01, 0, 0, 0x11, 0x1f, 0x9d, 0x89))
    assert.equal(CompressionHeader.lzc(256, 16, { blockMode: false }).bytes.at(-1), 0x10)
    assert.equal(CompressionHeader.lzc(256, 13, { unusedBits: 0x60 }).bytes.at(-1), 0xed)
    assert.deepEqual(
      CompressionHeader.of({ uncompressedLength: 5, version: 15, algorithm: "lzc", byte7: 0x44 }).bytes,
      bytes(5, 0, 0, 0, 0xf1, 0x1f, 0x9d, 0x44)
    )
    assert.deepEqual(CompressionHeader.clientLZH(7).bytes, bytes(7, 0, 0, 0, 0x12, 0x1f, 0x9d, 2))
    assert.equal(CompressionHeader.knownVersion, 1)
    assert.equal(CompressionHeader.defaultLZHLevel, 2)
    assert.equal(CompressionAlgorithm.nibble("lzc"), 1)
    assert.equal(CompressionAlgorithm.nibble("lzh"), 2)
    const output = new ByteWriter()
    output.u8(0xee)
    CompressionHeader.lzh(0).serialize(output)
    assert.deepEqual(output.toBytes(), bytes(0xee, 0, 0, 0, 0, 0x12, 0x1f, 0x9d, 2))
  })

  test("encoderRejectsValuesTheHeaderCannotCarry", () => {
    throwsInfo(() => CompressionHeader.lzh(0, { version: 16 }), CompressionHeaderEncodingError, { kind: "versionOutOfRange", value: 16 })
    throwsInfo(() => CompressionHeader.lzc(0, 9, { version: 0xff }), CompressionHeaderEncodingError, { kind: "versionOutOfRange", value: 0xff })
    for (const maxbits of [0, 8, 17, 0x1f, 0x7f, 0x89])
      throwsInfo(() => CompressionHeader.lzc(0, maxbits), CompressionHeaderEncodingError, { kind: "maxbitsOutOfRange", value: maxbits })
    for (const unused of [0x01, 0x80, 0x9f, 0xff])
      throwsInfo(() => CompressionHeader.lzc(0, 12, { unusedBits: unused }), CompressionHeaderEncodingError, {
        kind: "unusedBitsOutOfRange",
        value: unused
      })
    for (let maxbits = 9; maxbits <= 16; maxbits++) assert.doesNotThrow(() => CompressionHeader.lzc(0, maxbits))
  })

  test("encodeDecodeRoundTrip", () => {
    for (const length of [0, 1, 255, 256, 65535, 65536, 70000, 0xffffffff - 1, 0xffffffff]) {
      for (let version = 0; version <= 15; version++) {
        const lzh = CompressionHeader.lzh(length, { level: (version * 7) & 0xff, version })
        assert.deepEqual(CompressionHeader.decode(lzh.bytes), lzh)
        const lzc = CompressionHeader.lzc(length, 9 + (version % 8), {
          blockMode: version % 2 === 0,
          unusedBits: (version % 4) << 5,
          version
        })
        assert.deepEqual(CompressionHeader.decode(lzc.bytes), lzc)
      }
    }
  })
})

describe("Decompression", () => {
  /** "ABABABA" as LZC codes 0x041, 0x042, 0x101, 0x103 (test/vectors/compression/lzc-code-equals-next-free.vec). */
  const lzcData = bytes(0x41, 0x84, 0x04, 0x1c, 0x08)
  const lzcHeader = (): CompressionHeader => CompressionHeader.lzc(7, 16)

  const lzhData = (input: Uint8Array): Uint8Array => new LZHEncoder().encode(input)

  test("decompressesLZHAndLZCWithOneReusedDecompressor", () => {
    const decompressor = new Decompressor()
    const text = ascii("ZZDUCK consults the rubber duck; the rubber duck consults ZZDUCK.")
    const data = lzhData(text)
    const header = CompressionHeader.lzh(text.length)
    assert.deepEqual(decompressor.decompress(data, header), text)
    assert.deepEqual(decompressor.decompress(lzcData, lzcHeader()), ascii("ABABABA"))
    assert.deepEqual(decompressor.decompress(data, header), text, "a reused decompressor gives the same result")
    assert.deepEqual(Decompression.decompress(data, header), text)
    assert.deepEqual(Decompression.decompress(lzcData, lzcHeader()), ascii("ABABABA"))
  })

  test("capIsCheckedFirstAndIsInclusive", () => {
    const header = CompressionHeader.lzh(1000)
    throwsInfo(() => Decompression.decompress(new Uint8Array(0), header, 999), CompressedDataError, {
      kind: "lengthOverCap",
      declaredLength: 1000,
      cap: 999
    })
    const lzc = CompressionHeader.lzc(0xffffffff, 16)
    throwsInfo(() => Decompression.decompress(new Uint8Array(0), lzc), CompressedDataError, {
      kind: "lengthOverCap",
      declaredLength: 0xffffffff,
      cap: Decompression.defaultMaxUncompressedLength
    })
    // A declared length equal to the cap is allowed; this data then fails for another reason.
    try {
      Decompression.decompress(new Uint8Array(0), header, 1000)
    } catch (error) {
      assert.ok(error instanceof CompressedDataError, String(error))
      assert.notDeepEqual(error.info, { kind: "lengthOverCap", declaredLength: 1000, cap: 1000 })
    }
    assert.equal(new Decompressor().maxUncompressedLength, 64 << 20)
    assert.equal(new Decompressor(5).maxUncompressedLength, 5)
  })

  test("failuresLeaveNoOutput", () => {
    // The port's decompressor returns its output or throws: a failure has no output to leave.
    const decompressor = new Decompressor()
    // LZC maxbits outside 9–16 from a structurally parsed header (the decoder would reject it).
    const bad = CompressionHeader.parse(bytes(7, 0, 0, 0, 0x11, 0x1f, 0x9d, 0x88))
    throwsInfo(() => decompressor.decompress(lzcData, bad), CompressedDataError, { kind: "badMaxbits", maxbits: 8 })
    const longer = CompressionHeader.lzc(8, 16)
    throwsInfo(() => decompressor.decompress(lzcData, longer), CompressedDataError, { kind: "lengthMismatch", declaredLength: 8, decodedLength: 7 })
    const lzh = CompressionHeader.lzh(3)
    throwsInfo(() => decompressor.decompress(new Uint8Array(0), lzh), CompressedDataError, { kind: "dataTruncated" })
  })

  /**
   * Every decompress vector through the codec's Decompressor, which must agree with the vectors
   * exactly as the DiagCompression harness does.
   */
  test("decompressVectorsThroughTheCodec", () => {
    let count = 0
    const decompressor = new Decompressor(1 << 20)
    for (const path of vectorFiles()) {
      const vector = loadVector(path)
      if (vector.kind !== "decompress") continue
      count += 1
      const expect = vector.expectations
      let output: Uint8Array | undefined
      let errorClass = NO_ERROR
      try {
        const header = CompressionHeader.decode(vector.bytes)
        output = decompressor.decompress(vector.bytes.subarray(CompressionHeader.size), header)
      } catch (error) {
        if (error instanceof CompressionHeaderDecodingError) errorClass = compressionHeaderDecodingErrorClass(error.info)
        else if (error instanceof CompressedDataError) errorClass = compressedDataErrorClass(error.info)
        else throw error
      }
      assert.equal(errorClass, expect.get("expect.error"), path)
      if (errorClass === NO_ERROR) assert.equal(hexText(output!), expect.get("expect.output"), path)
    }
    assert.ok(count >= 25)
  })
})
