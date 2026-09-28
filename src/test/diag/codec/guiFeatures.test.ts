// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/GUIFeaturesTests.swift (MIT).

// Swift's `Bug0150Tests.decode(_:space:)` and `FlushCallAnswerTests.decode` are `decodeAnswer` in
// src/test/support/rfcTestSupport.ts.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlHandleCounter, FlushCallAnswerBuilder } from "../../../diag/codec/index.js"
import { ascii } from "../../support/codecTestSupport.js"
import { InventedFlushCall, InventedFlushCallText } from "../../support/inventedFlushCall.js"
import { decodeAnswer } from "../../support/rfcTestSupport.js"

describe("GUI feature results are strings, not bare integer success codes", () => {
  /** GetGuiFeatures returns an indexed XML string with no unimplemented capabilities (bug #180) */
  for (const text of InventedFlushCallText.allCases) {
    test(`featureString(${text})`, () => {
      const call = new InventedFlushCall({
        descriptors: [InventedFlushCall.descriptor("1 12 _RESULT 1")],
        values: [InventedFlushCall.value("_RESULT", "000000000")],
        verbs: [InventedFlushCall.verb(1, "GetGuiFeatures", "C")]
      })
      call.text = text
      const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter())
      const decoded = decodeAnswer(answer.value, call.encoded([0x20]))
      const xml = decoded.values.filter((_, index) => decoded.ids[index] === 0x3c05)
      assert.equal(xml.length, 1)
      assert.deepEqual(decoded.ids.slice(11, 14), [0x3c02, 0x3c05, 0x3c02])
      assert.ok(answer.summary.recordsWithString === 1 && answer.summary.recordsWithInteger === 0)
      assert.equal(
        new TextDecoder().decode(xml[0]),
        '<?xml version="1.0" encoding="UTF-8"?><SVARS><item><VALUE>&lt;AvailableFeatures&gt;&lt;/AvailableFeatures&gt;</VALUE></item></SVARS>'
      )
      const values = decoded.table(call.encoded(ascii("VARS")))
      assert.ok(values !== undefined)
      assert.deepEqual(values.rows, call.encoded(InventedFlushCall.value("_SRESULT", "000000000 1")))
      assert.deepEqual(answer.handles, new ControlHandleCounter())
    })
  }

  /** A later result overwrites the string and removes its unused document (bug #180) */
  test("overwritten", () => {
    const call = new InventedFlushCall({
      descriptors: [InventedFlushCall.descriptor("1 12 _RESULT 1"), InventedFlushCall.descriptor("2 12 _RESULT 1")],
      values: [InventedFlushCall.value("_RESULT", "000000000")],
      verbs: [InventedFlushCall.verb(1, "GetGuiFeatures", "C"), InventedFlushCall.verb(1, "GetContainer", "C")]
    })
    const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter())
    const decoded = decodeAnswer(answer.value)
    assert.ok(!decoded.ids.includes(0x3c05))
    assert.ok(answer.summary.recordsWithString === 0 && answer.summary.recordsWithInteger === 1)
    assert.deepEqual(decoded.table("VARS")?.rows, InventedFlushCall.value("_RESULT", "000000000 1"))
  })
})
