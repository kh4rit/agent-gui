// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/NIFrameDecoderTests.swift (MIT).
//
// Swift's three `append` overloads (Span, UnsafeRawBufferPointer, any byte Sequence) are one
// `append(ArrayLike<number>)` in the port; the tests that fed each overload feed a Uint8Array, a
// subarray view and a plain array instead.

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { NIFrameDecoder, NIFrameError, payloadStreamOffset, type NIFrame } from "../../../diag/wire/index.js"
import { assertThrowsInfo } from "../../support/assertions.js"
import { concat, drain, frame } from "./support.js"

const bytesFrom = (count: number, map: (index: number) => number): Uint8Array => Uint8Array.from({ length: count }, (_, i) => map(i))
const niFrame = (streamOffset: number, payload: number[]): NIFrame => ({ streamOffset, payload: Uint8Array.from(payload) })

describe("NI frame decoder", () => {
  test("decodesOneFrame", () => {
    const decoder = new NIFrameDecoder()
    decoder.append(frame([1, 2, 3, 4, 5]))
    const first = decoder.nextFrame()
    assert.ok(first)
    assert.deepEqual(first, niFrame(0, [1, 2, 3, 4, 5]))
    assert.equal(payloadStreamOffset(first), 4)
    assert.equal(decoder.nextFrame(), undefined)
    assert.equal(decoder.bufferedByteCount, 0)
    assert.equal(decoder.consumedByteCount, 9)
    decoder.finish()
    assert.equal(decoder.nextFrame(), undefined)
    assert.ok(decoder.hasFinished)
    assert.equal(decoder.error, undefined)
  })

  test("decodesBackToBackFramesWithStreamOffsets", () => {
    const decoder = new NIFrameDecoder()
    decoder.append(concat(frame([0xaa, 0xbb, 0xcc]), frame([0x7f]), frame([]), frame(bytesFrom(8, i => i))))
    const { frames, error } = drain(decoder)
    assert.equal(error, undefined)
    assert.deepEqual(
      frames.map(f => f.streamOffset),
      [0, 7, 12, 16]
    )
    assert.deepEqual(
      frames.map(f => f.payload),
      [Uint8Array.of(0xaa, 0xbb, 0xcc), Uint8Array.of(0x7f), new Uint8Array(0), bytesFrom(8, i => i)]
    )
  })

  test("waitsForTheLengthAndThePayload", () => {
    const decoder = new NIFrameDecoder()
    const bytes = frame([9, 8, 7])
    for (let index = 0; index < bytes.length - 1; index++) {
      decoder.append([bytes[index]])
      assert.equal(decoder.nextFrame(), undefined)
      assert.equal(decoder.bufferedByteCount, index + 1)
    }
    decoder.append([bytes[bytes.length - 1]])
    assert.deepEqual(decoder.nextFrame()?.payload, Uint8Array.of(9, 8, 7))
  })

  test("zeroLengthFrameIsAnEmptyPayload", () => {
    // IMPL-NI-8: delivered as an empty payload; the stream carries on.
    const decoder = new NIFrameDecoder()
    decoder.append(concat(frame([]), frame([1, 2])))
    const { frames, error } = drain(decoder)
    assert.equal(error, undefined)
    assert.deepEqual(frames, [niFrame(0, []), niFrame(4, [1, 2])])
  })

  test("lengthIsBigEndian", () => {
    // 00 00 01 00 is 256 big-endian; a little-endian reading would give 65536.
    const decoder = new NIFrameDecoder(256)
    decoder.append(concat([0, 0, 1, 0], new Uint8Array(256).fill(0x5a)))
    assert.equal(decoder.nextFrame()?.payload.length, 256)
  })

  test("capIsInclusive", () => {
    const decoder = new NIFrameDecoder(3)
    decoder.append(frame([1, 2, 3]))
    assert.deepEqual(decoder.nextFrame()?.payload, Uint8Array.of(1, 2, 3))
  })

  test("lengthAboveCapFailsBeforeThePayloadArrives", () => {
    // IMPL-NI-1: only the 4 length bytes are present; the failure must not wait for 4 GiB.
    const decoder = new NIFrameDecoder(1024)
    decoder.append(concat(frame([1]), [0xff, 0xff, 0xff, 0xff]))
    const { frames, error } = drain(decoder)
    assert.equal(frames.length, 1)
    assert.deepEqual(error?.info, { kind: "lengthOverCap", declaredLength: 0xffff_ffff, cap: 1024, streamOffset: 5 })
    assert.deepEqual(decoder.error?.info, error?.info)
  })

  test("capFailureIsStickyAndDropsInput", () => {
    const decoder = new NIFrameDecoder(2)
    decoder.append(frame([1, 2, 3]))
    const info = { kind: "lengthOverCap", declaredLength: 3, cap: 2, streamOffset: 0 } as const
    assertThrowsInfo(NIFrameError, info, () => decoder.nextFrame())
    const buffered = decoder.bufferedByteCount
    decoder.append(frame([1]))
    decoder.append(frame([2]).subarray(0))
    decoder.append(Array.from(frame([3])))
    assert.equal(decoder.bufferedByteCount, buffered)
    assertThrowsInfo(NIFrameError, info, () => decoder.withNextFrame(() => 0))
  })

  test("maximalDeclaredLengthWithMaximalCapWaitsWithoutAllocating", () => {
    // With the cap at u32 max, a length of 0xFFFFFFFF is legal: the decoder must wait for the
    // payload (4 + L computed without overflow) and report truncated at end of stream.
    const decoder = new NIFrameDecoder(0xffff_ffff)
    decoder.append([0xff, 0xff, 0xff, 0xff, 0x01])
    assert.equal(decoder.nextFrame(), undefined)
    decoder.finish()
    assertThrowsInfo(NIFrameError, { kind: "truncated", streamOffset: 0, bufferedByteCount: 5 }, () => decoder.nextFrame())
  })

  test("endOfStreamInsideALengthFieldIsTruncated", () => {
    const decoder = new NIFrameDecoder()
    decoder.append([0, 0, 0])
    assert.equal(decoder.nextFrame(), undefined)
    decoder.finish()
    assertThrowsInfo(NIFrameError, { kind: "truncated", streamOffset: 0, bufferedByteCount: 3 }, () => decoder.nextFrame())
    // Sticky.
    assertThrowsInfo(NIFrameError, { kind: "truncated", streamOffset: 0, bufferedByteCount: 3 }, () => decoder.nextFrame())
  })

  test("endOfStreamInsideAPayloadAfterAFrameIsTruncatedWithItsOffset", () => {
    const decoder = new NIFrameDecoder()
    decoder.append(concat(frame([0xaa, 0xbb]), [0, 0, 0, 4, 0xcc]))
    decoder.finish()
    assert.deepEqual(decoder.nextFrame()?.payload, Uint8Array.of(0xaa, 0xbb))
    assertThrowsInfo(NIFrameError, { kind: "truncated", streamOffset: 6, bufferedByteCount: 5 }, () => decoder.nextFrame())
  })

  test("framesBufferedBeforeFinishAreStillDelivered", () => {
    const decoder = new NIFrameDecoder()
    decoder.append(concat(frame([1]), frame([2])))
    decoder.finish()
    const { frames, error } = drain(decoder)
    assert.deepEqual(
      frames.map(f => f.payload),
      [Uint8Array.of(1), Uint8Array.of(2)]
    )
    assert.equal(error, undefined)
  })

  test("appendAfterFinishIsIgnored", () => {
    const decoder = new NIFrameDecoder()
    decoder.finish()
    decoder.append(frame([1]))
    assert.equal(decoder.bufferedByteCount, 0)
    assert.equal(decoder.nextFrame(), undefined)
  })

  test("emptyAppendsAreHarmless", () => {
    const decoder = new NIFrameDecoder()
    decoder.append(new Uint8Array(0))
    decoder.append(new Uint8Array(8).subarray(3, 3))
    decoder.append([])
    assert.equal(decoder.bufferedByteCount, 0)
    assert.equal(decoder.nextFrame(), undefined)
  })

  test("allAppendOverloadsAgree", () => {
    const bytes = concat(frame([1, 2, 3]), frame([4]))
    const viaArray = new NIFrameDecoder()
    viaArray.append(bytes)
    const viaView = new NIFrameDecoder()
    viaView.append(concat([0xee], bytes).subarray(1))
    const viaSequence = new NIFrameDecoder()
    viaSequence.append(Array.from(bytes))
    const expected = [niFrame(0, [1, 2, 3]), niFrame(7, [4])]
    assert.deepEqual(drain(viaArray).frames, expected)
    assert.deepEqual(drain(viaView).frames, expected)
    assert.deepEqual(drain(viaSequence).frames, expected)
  })

  test("withNextFrameGivesAViewOfThePayload", () => {
    const decoder = new NIFrameDecoder()
    decoder.append(concat(frame([5, 6, 7]), frame([8])))
    const first = decoder.withNextFrame((offset, payload) => [offset, payload.length, payload[0], payload[2]])
    assert.deepEqual(first, [0, 3, 5, 7])
    const second = decoder.withNextFrame((offset, payload) => [offset, payload.length])
    assert.deepEqual(second, [7, 1])
    assert.equal(
      decoder.withNextFrame(() => true),
      undefined
    )
  })

  test("compactionKeepsBufferBoundedAndOffsetsRight", () => {
    // Many frames fed in odd-sized reads: the buffer never holds more than one partial frame plus
    // one read, and stream offsets keep counting across compactions.
    const decoder = new NIFrameDecoder()
    const parts: Uint8Array[] = []
    for (let index = 0; index < 2000; index++) parts.push(frame(new Uint8Array(index % 37).fill(index & 0xff)))
    const stream = concat(...parts)
    const frames: NIFrame[] = []
    let position = 0
    let readSize = 1
    while (position < stream.length) {
      const end = Math.min(position + readSize, stream.length)
      decoder.append(stream.subarray(position, end))
      position = end
      readSize = (readSize % 97) + 13
      frames.push(...drain(decoder).frames)
      assert.ok(decoder.bufferedByteCount <= 4 + 36 + 97 + 13)
    }
    decoder.finish()
    assert.equal(drain(decoder).error, undefined)
    assert.equal(frames.length, 2000)
    let offset = 0
    frames.forEach((frame, index) => {
      assert.equal(frame.streamOffset, offset)
      assert.deepEqual(frame.payload, new Uint8Array(index % 37).fill(index & 0xff))
      offset += 4 + frame.payload.length
    })
    assert.equal(decoder.consumedByteCount, stream.length)
  })

  test("largeFrameInManySmallReadsIsLinear", () => {
    // A 1 MiB payload arriving in 1 KiB reads: completes, and the result is exact.
    const payload = bytesFrom(1 << 20, i => (i * 31) & 0xff)
    const bytes = frame(payload)
    const decoder = new NIFrameDecoder()
    let position = 0
    const frames: NIFrame[] = []
    while (position < bytes.length) {
      const end = Math.min(position + 1024, bytes.length)
      decoder.append(bytes.subarray(position, end))
      position = end
      frames.push(...drain(decoder).frames)
    }
    assert.equal(frames.length, 1)
    assert.deepEqual(frames[0]?.payload, payload)
  })
})
