// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DiagMessageTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  CompressionHeader,
  DiagErrorBody,
  DiagErrorBodyError,
  DiagHeader,
  DiagMessage,
  DiagMessageBody,
  DiagMessageDecodingError,
  Decompressor,
  byteRange
} from "../../../diag/codec/index.js"
import { LZHEncoder } from "../../../diag/compression/index.js"
import { appl, ascii, bytes, cat, walkItems, throwsInfo, xmlblob } from "../../support/codecTestSupport.js"

function header(compress: number, errNo = 0): Uint8Array {
  return bytes(1, 0, 0, errNo, 0, 0, 0, compress)
}

describe("DIAG message", () => {
  test("itemsBody", () => {
    const payload = cat(header(0), xmlblob([1, 2]))
    const message = DiagMessage.parse(payload)
    assert.equal(message.header.mode, 1)
    assert.deepEqual(message.body, { kind: "items", range: byteRange(8, 15) })
    assert.equal(DiagMessageBody.bodyClass(message.body), "items")
    assert.deepEqual(DiagMessageBody.range(message.body), byteRange(8, 15))
  })

  test("emptyItemsBody", () => {
    // The client's close message is one: the header alone.
    assert.deepEqual(DiagMessage.parse(DiagHeader.clientClose.bytes).body, { kind: "items", range: byteRange(8, 8) })
  })

  test("compressedBodies", () => {
    const compression = bytes(3, 0, 0, 0, 0x12, 0x1f, 0x9d, 2)
    const items = DiagMessage.parse(cat(header(1), compression, [0xaa, 0xbb, 0xcc]))
    const expected = CompressionHeader.decode(compression)
    assert.deepEqual(items.body, { kind: "compressed", header: expected, data: byteRange(16, 19), isErrorBody: false })
    assert.equal(DiagMessageBody.bodyClass(items.body), "compressed")
    assert.deepEqual(DiagMessageBody.range(items.body), byteRange(8, 19))
    // IMPL-DH-6: err_no ≠ 0 with compress 1 is decompressed like any other message.
    const error = DiagMessage.parse(cat(header(1, 7), compression))
    assert.deepEqual(error.body, { kind: "compressed", header: expected, data: byteRange(16, 16), isErrorBody: true })
    assert.equal(DiagMessageBody.bodyClass(error.body), "compressedErrorBody")
  })

  test("compressionHeaderFaultsDropTheMessage", () => {
    throwsInfo(() => DiagMessage.parse(cat(header(1), [1, 2, 3])), DiagMessageDecodingError, {
      kind: "compressionHeader",
      error: { kind: "truncated", availableByteCount: 3 }
    })
    throwsInfo(() => DiagMessage.parse(cat(header(1), [0, 0, 0, 0, 0x12, 0, 0, 0])), DiagMessageDecodingError, {
      kind: "compressionHeader",
      error: { kind: "badMagic", first: 0, second: 0 }
    })
    throwsInfo(() => DiagMessage.parse(cat(header(1), [0, 0, 0, 0, 0x10, 0x1f, 0x9d, 0])), DiagMessageDecodingError, {
      kind: "compressionHeader",
      error: { kind: "unknownAlgorithm", byte: 0x10 }
    })
    throwsInfo(() => DiagMessage.parse(cat(header(1), [0, 0, 0, 0, 0x11, 0x1f, 0x9d, 0x80])), DiagMessageDecodingError, {
      kind: "compressionHeader",
      error: { kind: "badMaxbits", maxbits: 0 }
    })
  })

  test("errorAndSNCBodies", () => {
    const snc = DiagMessage.parse(cat(header(2), ascii("SNCFRAME")))
    assert.deepEqual(snc.body, { kind: "snc", range: byteRange(8, 16) })
    assert.equal(DiagMessageBody.bodyClass(snc.body), "snc")
    // IMPL-DH-3: compress 2 or 3 is SNC whatever err_no is.
    assert.deepEqual(DiagMessage.parse(cat(header(3, 5), [9])).body, { kind: "snc", range: byteRange(8, 9) })
    const error = DiagMessage.parse(cat(header(0, 1), [0x41, 0x00, 0x0c]))
    assert.deepEqual(error.body, { kind: "errorBody", range: byteRange(8, 11) })
    assert.equal(DiagMessageBody.bodyClass(error.body), "errorBody")
    assert.deepEqual(DiagMessageBody.range(error.body), byteRange(8, 11))
    assert.ok(error.header.isError)
  })

  test("headerErrors", () => {
    throwsInfo(() => DiagMessage.parse(bytes(0, 0, 0, 0, 0)), DiagMessageDecodingError, {
      kind: "header",
      error: { kind: "truncated", availableByteCount: 5 }
    })
    throwsInfo(() => DiagMessage.parse(header(9, 1)), DiagMessageDecodingError, { kind: "header", error: { kind: "unknownCompress", value: 9 } })
  })

  /** A compressed server message end to end: layout, decompression, then the item walker. */
  test("compressedItemsDecompressAndWalk", () => {
    const items = cat(appl(0x06, 0x07, ascii("ZZCOFFEE")), [0x0c])
    const data = new LZHEncoder().encode(items)
    const payload = cat(header(1), CompressionHeader.clientLZH(items.length).bytes, data)
    const message = DiagMessage.parse(payload)
    if (message.body.kind !== "compressed" || message.body.isErrorBody) {
      assert.fail("not a compressed item body")
    }
    const body = new Decompressor().decompress(message.body.data.of(payload), message.body.header)
    const walked = walkItems(body)
    assert.equal(walked.error, undefined)
    assert.deepEqual(
      walked.items.map(item => item.type),
      ["appl", "eom"]
    )
    assert.deepEqual(walked.items[0]?.appl, ApplItem.stSystemInfo("tcode"))
    assert.deepEqual(walked.items[0].valueRange.of(body), ascii("ZZCOFFEE"))
  })
})

describe("Error body", () => {
  test("splitsAtTheFirstTerminator", () => {
    const body = cat([0x41, 0x00, 0x42, 0x00, 0x0c], xmlblob([1]), [0x0c])
    const split = DiagErrorBody.split(body)
    assert.deepEqual(split.textRange, byteRange(0, 4))
    assert.deepEqual(split.itemsRange, byteRange(5, body.length))
    const walked = walkItems(split.itemsRange.of(body).slice())
    assert.deepEqual(
      walked.items.map(item => item.type),
      ["xmlblob", "eom"]
    )
  })

  test("emptyTextAndEmptyItems", () => {
    const only = DiagErrorBody.split(bytes(0x0c))
    assert.deepEqual(only.textRange, byteRange(0, 0))
    assert.deepEqual(only.itemsRange, byteRange(1, 1))
    // R-DH-6: the first 0x0C ends the text, even when more follow.
    const twice = DiagErrorBody.split(bytes(0x0c, 0x0c))
    assert.deepEqual(twice.textRange, byteRange(0, 0))
    assert.deepEqual(twice.itemsRange, byteRange(1, 2))
  })

  test("missingTerminator", () => {
    throwsInfo(() => DiagErrorBody.split(new Uint8Array(0)), DiagErrorBodyError, { kind: "missingTerminator", byteCount: 0 })
    throwsInfo(() => DiagErrorBody.split(bytes(0x41, 0x41, 0x42, 0x42)), DiagErrorBodyError, { kind: "missingTerminator", byteCount: 4 })
  })
})
