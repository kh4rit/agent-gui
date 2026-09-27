// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/Bug0150Tests.swift (MIT).

// Issue #150: the owner's second OLE_FLUSH_CALL of a run (Swooey 0.0.82) held zero bytes in its
// function name, UTF-16 or zero padding, and Swooey's reader compared it with the single-byte
// name, refused it with R-CT-35's "the call is not OLE_FLUSH_CALL", and sent the empty RFC_TR_RET;
// the server then dumped in SAPLOLEA. Reading R-CT-37 (docs/protocol/controls/rfc-tr.md §7.8): the
// reader takes the call's text encoding from its function name, reads every name and record in it,
// and writes every text of its own answer in it. The calls are invented (D15).
//
// Swift's `Bug0150Tests.decode(_:space:)` is `decodeAnswer(answer, space)` in
// src/test/support/rfcTestSupport.ts.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlHandleCounter, FlushCallAnswerBuilder, type FlushCallAnswer } from "../../../diag/codec/index.js"
import { concatBytes } from "../../../diag/wire/index.js"
import { ascii } from "../../support/codecTestSupport.js"
import { InventedFlushCall, type InventedFlushCallText } from "../../support/inventedFlushCall.js"
import { decodeAnswer, expectedPondValues, flushHeadIDs, tableInfo } from "../../support/rfcTestSupport.js"

const Call = InventedFlushCall

function pond(text: InventedFlushCallText): InventedFlushCall {
  const call = Call.pond()
  call.text = text
  return call
}

function answer(call: InventedFlushCall): FlushCallAnswer {
  return FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter())
}

describe("A flush call whose texts are UTF-16 or zero-padded (issue #150)", () => {
  /** A call whose texts are UTF-16 gets Swooey's answer, every text Swooey writes in the call's encoding (bug #150). */
  for (const text of ["utf16LittleEndian", "utf16BigEndian"] as InventedFlushCallText[]) {
    test(`wideCall(${text})`, () => {
      const call = pond(text)
      const built = answer(call)
      const space = call.encoded([0x20])
      const decoded = decodeAnswer(built.value, space)
      assert.deepEqual(decoded.ids.slice(0, 13), [...flushHeadIDs, 0x0201, 0x0203])
      assert.deepEqual(decoded.values[5], call.encoded(ascii("E")), "00 11 in the call's encoding")
      flushHeadIDs.forEach((id, index) => {
        if (Call.echoedHeadIDs.includes(id)) assert.deepEqual(decoded.values[index], call.sentHeadValue(id), `${id} echoed as the call sent it`)
      })
      assert.deepEqual(decoded.values[11], call.encoded(ascii("ZZ_QUACK_REPORT")), "the parameter's name, as the call sent it")
      assert.deepEqual(decoded.values[12], call.encoded(new Uint8Array(256).fill(0x20)), "256 space characters, 512 bytes")

      const descriptors = decoded.table(call.encoded(ascii("ZZ_DUCK_SLOTS")))
      assert.ok(descriptors !== undefined)
      assert.deepEqual(descriptors.info, tableInfo(88, Call.pondDescriptors.length), "the width in bytes, echoed")
      const expectedDescriptors = decodeAnswer(answer(Call.pond()).value).table("ZZ_DUCK_SLOTS")?.rows
      assert.ok(expectedDescriptors !== undefined)
      assert.deepEqual(descriptors.rows, call.encoded(expectedDescriptors), "blank and kept rows, as for the single-byte call")
      const values = decoded.table(call.encoded(ascii("VARS")))
      assert.ok(values !== undefined)
      assert.deepEqual(values.info, tableInfo(674, Call.pondValues.length))
      assert.deepEqual(
        values.rows,
        call.encoded(concatBytes(...expectedPondValues(1))),
        "kept, blank and filled records, handles and integers in the call's encoding"
      )
      const xml = decoded.table(call.encoded(ascii("XML_DATA_STREAM")))
      assert.ok(xml !== undefined)
      assert.deepEqual(xml.info, tableInfo(510, 0))
      assert.equal(xml.rows.length, 0)

      const reference = answer(Call.pond()).summary
      const summary = built.summary
      assert.ok(summary.descriptorRowsKept === reference.descriptorRowsKept && summary.descriptorRowsBlanked === reference.descriptorRowsBlanked)
      assert.ok(summary.recordsKept === reference.recordsKept && summary.recordsBlanked === reference.recordsBlanked)
      assert.ok(summary.recordsWithHandle === 3 && summary.recordsWithInteger === 2 && summary.firstHandle === 1 && summary.lastHandle === 3)
    })
  }

  /** Raw rows in a UTF-16 call: a blank row as one space character, the others whole (bug #150). */
  test("wideRawRows", () => {
    const call = new Call({
      descriptors: ["1 12 #1 2", "1 12 _RESULT 3"].map(Call.descriptor),
      values: [Call.value("", "000000000O7"), Call.value("", "000000000 12"), Call.value("_RESULT", "000000000")],
      verbs: [Call.verb(1, "CreateControl2", "C")]
    })
    call.text = "utf16LittleEndian"
    for (const name of ["ZZ_DUCK_SLOTS", "VERBS", "VARS"])
      call.table(name, table => {
        table.raw = true
      })
    const built = answer(call)
    const decoded = decodeAnswer(built.value, Uint8Array.of(0x20, 0x00))
    const first = decoded.ids.indexOf(0x0304)
    assert.ok(first >= 0)
    assert.deepEqual(decoded.values[first], Uint8Array.of(0x20, 0x00), "the input row as one space character")
    assert.deepEqual(decoded.values[first + 1], call.encoded(Call.descriptor("1 12 _RESULT 3")))
    const values = decoded.table(call.encoded(ascii("VARS")))
    assert.ok(values !== undefined)
    assert.ok(values.raw)
    assert.deepEqual(
      values.rows,
      call.encoded(concatBytes(Call.value("", "000000000O7"), new Uint8Array(337).fill(0x20), Call.value("_RESULT", "000000000O1")))
    )
  })

  /** A call whose function name is padded with zero bytes gets the answer of the unpadded call (bug #150). */
  test("zeroPaddedName", () => {
    const padded = pond("zeroPaddedName")
    assert.ok(padded.functionValue.length === Call.paddedNameLength && padded.functionValue[padded.functionValue.length - 1] === 0)
    assert.deepEqual(answer(padded).value, answer(Call.pond()).value)
  })
})
