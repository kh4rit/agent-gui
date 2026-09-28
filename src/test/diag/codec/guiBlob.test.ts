// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/GUIBlobTests.swift (MIT).

// Swift's `RFCTransferTests.rfcItem` and `.end` are `rfcItem` and `rfcEnd` in
// src/test/support/rfcTestSupport.ts.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, DiagItemEncoder, GUIBlob, GUIBlobReadError, RFCStreamSummary } from "../../../diag/codec/index.js"
import { ByteWriter, concatBytes } from "../../../diag/wire/index.js"
import { ascii, throwsInfo } from "../../support/codecTestSupport.js"
import { rfcEnd, rfcItem } from "../../support/rfcTestSupport.js"

/** A blob call around `items` (Swift `static func call(_:function:parameter:)`). */
function call(items: Uint8Array, fn: string = GUIBlob.functionName, parameter = "STREAM"): Uint8Array {
  return concatBytes(rfcItem(0x0102, concatBytes(ascii(fn), [0])), rfcItem(0x0201, ascii(parameter)), rfcItem(0x0203, items), rfcEnd())
}

describe("GUI blob screen transport: synthetic STREAM values", () => {
  /** large STREAM parameters use a checked extended length (bug #180) */
  test("extendedStream", () => {
    const writer = new ByteWriter()
    const padding = new Uint8Array(70_000).fill(0x20)
    DiagItemEncoder.appendAPPL4(ApplItem.stSystemInfo("dynproName"), padding, writer)
    DiagItemEncoder.appendEOM(writer)
    const items = writer.toBytes()
    let bytes = concatBytes(rfcItem(0x0102, ascii(GUIBlob.functionName)), rfcItem(0x0201, ascii("STREAM")))
    const start = bytes.length
    const count = items.length >>> 0
    bytes = concatBytes(
      bytes,
      [0x02, 0x03, 0xff, 0xff, (count >>> 24) & 0xff, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff],
      items,
      [0x02, 0x03],
      rfcEnd()
    )
    const blob = GUIBlob.read(bytes)
    assert.deepEqual(blob.items, items)
    assert.equal(blob.itemCount, 2)
    for (const end of [start + 4, start + 5, start + 6, start + 7, start + 8, bytes.length - 1]) {
      throwsInfo(() => GUIBlob.read(bytes.slice(0, end)), GUIBlobReadError, { kind: "malformedCall" }, `${end}`)
    }
    bytes.set([0xff, 0xff, 0xff, 0xff], start + 4)
    throwsInfo(() => GUIBlob.read(bytes), GUIBlobReadError, { kind: "malformedCall" })
  })

  /** a GUI-core call carries a complete DIAG item stream; diagnostics reveal no values (bug #180) */
  test("screenStream", () => {
    const writer = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("dynproName"), ascii("ZZ_FAKE_INBOUND"), writer)
    DiagItemEncoder.appendEOM(writer)
    const items = writer.toBytes()
    const bytes = call(items)
    const blob = GUIBlob.read(bytes)
    assert.deepEqual(blob.items, items)
    assert.equal(blob.itemCount, 2)
    assert.equal(blob.summary, "GUI blob STREAM: 2 valid DIAG items (R-CT-44)")
    assert.ok(!blob.summary.includes("ZZ_FAKE_INBOUND"))
    assert.equal(new RFCStreamSummary(bytes).functionName, GUIBlob.functionName)
  })

  /** malformed envelopes, duplicate parameters and invalid nested items fail closed (bug #180) */
  test("malformed", () => {
    const good = call(Uint8Array.of(0x0c))
    for (let length = 0; length < good.length; length++) assert.throws(() => GUIBlob.read(good.slice(0, length)), `${length}`)
    throwsInfo(() => GUIBlob.read(call(Uint8Array.of(0x0c), "ZZ_UNKNOWN")), GUIBlobReadError, { kind: "notBlobCall" })
    throwsInfo(() => GUIBlob.read(call(Uint8Array.of(0x0c), undefined, "ZZ_SECRET")), GUIBlobReadError, { kind: "parameter" })
    throwsInfo(() => GUIBlob.read(call(new Uint8Array(0))), GUIBlobReadError, { kind: "parameter" })
    throwsInfo(() => GUIBlob.read(call(Uint8Array.of(0xff))), GUIBlobReadError, { kind: "items" })
    throwsInfo(() => GUIBlob.read(call(Uint8Array.of(0x0c, 0x0c))), GUIBlobReadError, { kind: "items" })
    throwsInfo(() => GUIBlob.read(concatBytes(good, [0])), GUIBlobReadError, { kind: "malformedCall" })
    const duplicate = concatBytes(good.slice(0, -6), rfcItem(0x0203, [0x0c]), rfcEnd())
    throwsInfo(() => GUIBlob.read(duplicate), GUIBlobReadError, { kind: "parameter" })
    const recursive = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.rfcTR("rnb"), good, recursive)
    throwsInfo(() => GUIBlob.read(call(recursive.toBytes())), GUIBlobReadError, { kind: "items" })
  })
})
