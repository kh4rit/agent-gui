// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/NIFrameEncoderTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { ByteWriter, NIFrameDecoder, NIFrameEncoder, NIFrameError, NIFraming, WireBytes } from "../../../diag/wire/index.js"
import { assertThrowsInfo } from "../../support/assertions.js"
import { SeededGenerator } from "../../support/seededGenerator.js"
import { drain } from "./support.js"

const writerWith = (...bytes: number[]): ByteWriter => new ByteWriter().bytes(bytes)

describe("NI frame encoder", () => {
  test("writesBigEndianLengthThenPayload", () => {
    const encoded = new NIFrameEncoder().encode(Uint8Array.of(0xaa, 0xbb, 0xcc))
    assert.deepEqual(encoded, Uint8Array.of(0, 0, 0, 3, 0xaa, 0xbb, 0xcc))
  })

  test("lengthUsesAllFourBytes", () => {
    const payload = new Uint8Array(0x01_02_03).fill(1)
    const encoded = new NIFrameEncoder().encode(payload)
    assert.deepEqual(encoded.subarray(0, 4), Uint8Array.of(0x00, 0x01, 0x02, 0x03))
    assert.equal(encoded.length, 4 + payload.length)
  })

  test("emptyPayload", () => {
    assert.deepEqual(new NIFrameEncoder().encode(new Uint8Array(0)), Uint8Array.of(0, 0, 0, 0))
  })

  test("appendsToExistingOutput", () => {
    const output = writerWith(0xee)
    new NIFrameEncoder().encodeInto(Uint8Array.of(1), output)
    new NIFrameEncoder().encodeInto(new Uint8Array(0), output)
    assert.deepEqual(output.toBytes(), Uint8Array.of(0xee, 0, 0, 0, 1, 1, 0, 0, 0, 0))
  })

  test("rejectsPayloadAboveCap", () => {
    const encoder = new NIFrameEncoder(2)
    assertThrowsInfo(NIFrameError, { kind: "payloadOverCap", length: 3, cap: 2 }, () => encoder.encode(Uint8Array.of(1, 2, 3)))
    assert.deepEqual(encoder.encode(Uint8Array.of(1, 2)), Uint8Array.of(0, 0, 0, 2, 1, 2))
    const output = writerWith(7)
    assertThrowsInfo(NIFrameError, { kind: "payloadOverCap", length: 3, cap: 2 }, () => encoder.encodeInto(Uint8Array.of(1, 2, 3), output))
    assert.deepEqual(output.toBytes(), Uint8Array.of(7), "a rejected payload leaves the output untouched")
  })

  test("defaultCapIsTheDecoderDefault", () => {
    assert.equal(new NIFrameEncoder().maxPayloadLength, NIFraming.defaultMaxPayloadLength)
    assert.equal(new NIFrameDecoder().maxPayloadLength, NIFraming.defaultMaxPayloadLength)
  })

  test("roundTripThroughTheDecoder", () => {
    const generator = new SeededGenerator(0xc0ffee)
    for (let round = 0; round < 500; round++) {
      const payloads = Array.from({ length: generator.int(0, 6) }, () => generator.bytes(generator.int(0, 300)))
      const stream = new ByteWriter()
      for (const payload of payloads) new NIFrameEncoder().encodeInto(payload, stream)
      const decoder = new NIFrameDecoder()
      decoder.append(stream.toBytes())
      decoder.finish()
      const { frames, error } = drain(decoder)
      assert.equal(error, undefined)
      assert.deepEqual(
        frames.map(f => f.payload),
        payloads
      )
    }
  })
})

describe("Wire byte helpers", () => {
  test("readsBothByteOrders", () => {
    const bytes = Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0x05)
    assert.equal(WireBytes.u32BigEndian(bytes, 0), 0x0102_0304)
    assert.equal(WireBytes.u32BigEndian(bytes, 1), 0x0203_0405)
    assert.equal(WireBytes.u32LittleEndian(bytes, 0), 0x0403_0201)
    assert.equal(WireBytes.u32LittleEndian(bytes, 1), 0x0504_0302)
  })

  test("writesBothByteOrders", () => {
    const big = new ByteWriter()
    WireBytes.appendU32BigEndian(0xa1b2_c3d4, big)
    assert.deepEqual(big.toBytes(), Uint8Array.of(0xa1, 0xb2, 0xc3, 0xd4))
    const little = new ByteWriter()
    WireBytes.appendU32LittleEndian(0xa1b2_c3d4, little)
    assert.deepEqual(little.toBytes(), Uint8Array.of(0xd4, 0xc3, 0xb2, 0xa1))
  })

  test("prefixCheck", () => {
    const bytes = Uint8Array.of(1, 2, 3)
    assert.ok(WireBytes.hasPrefix(bytes, []))
    assert.ok(WireBytes.hasPrefix(bytes, [1, 2]))
    assert.ok(WireBytes.hasPrefix(bytes, [1, 2, 3]))
    assert.ok(!WireBytes.hasPrefix(bytes, [1, 2, 3, 4]))
    assert.ok(!WireBytes.hasPrefix(bytes, [2]))
  })
})
