// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/Bug0151Tests.swift (MIT).

// Issue #151: the owner's run of Swooey 0.0.84 ended in the runtime error UC_OBJECTS_NOT_CONVERTIBLE
// in SAPLOLEA after Swooey answered a get-property verb for a colour value, whose receiver is an
// integer, with a new handle (Reading R-CT-34's default for a `G` verb it does not know). The call
// says which it is: the server pre-fills a result record whose receiver is an object with the
// object's content, and leaves the record of an integer receiver at the nine zeros (rfc-tr.md
// §7.7.5, §7.8 R-CT-34). The calls are invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlHandleCounter, FlushCallAnswerBuilder } from "../../../diag/codec/index.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"
import { decodeAnswer } from "../../support/rfcTestSupport.js"

const Call = InventedFlushCall

/**
 * The pond call with the get-property verb's record and the event verb's `_RESULT` record as given:
 * the zeros alone, or holding a value.
 */
function pond(puddleDepth: string, registerEvent: string): InventedFlushCall {
  const call = Call.pond()
  call.table("VARS", table => {
    table.rows[8] = Call.value("ZZ_PUDDLE_DEPTHS1", puddleDepth)
    table.rows[14] = Call.value("_RESULT", registerEvent)
  })
  return call
}

function records(call: InventedFlushCall): Uint8Array[] {
  const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter())
  const rows = decodeAnswer(answer.value, Uint8Array.of(0x20)).table("VARS")?.rows
  assert.ok(rows !== undefined)
  const list: Uint8Array[] = []
  for (let start = 0; start < rows.length; start += 337) list.push(rows.slice(start, start + 337))
  return list
}

describe("A verb's result by the call's record: a handle for an object receiver, an integer otherwise (issue #151)", () => {
  /** A get-property verb whose record holds nothing after the zeros returns the integer 0, not a handle (bug #151). */
  test("propertyOfAnInteger", () => {
    const call = pond("000000000", "000000000")
    const list = records(call)
    assert.deepEqual(list[8], Call.value("ZZ_PUDDLE_DEPTHS1", "000000000 0"), "the puddle depth is an integer")
    assert.deepEqual(list[14], Call.value("_RESULT", "000000000 0"), "the method's result too")
    const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter())
    assert.ok(
      answer.summary.recordsWithHandle === 2 && answer.summary.recordsWithInteger === 3 && answer.summary.lastHandle === 2,
      "only the two creates make a handle"
    )
  })

  /** A method whose record holds the receiver's content returns a new handle (bug #151). */
  test("methodOfAnObject", () => {
    const list = records(pond("000000000", "000000000OPond heron watch"))
    assert.deepEqual(list[14], Call.value("_RESULT", "000000000O3"), "the event verb's receiver is an object")
    assert.deepEqual(list[8], Call.value("ZZ_PUDDLE_DEPTHS1", "000000000 0"))
  })

  /** A get-property verb whose record holds the receiver's content returns a new handle, as before (bug #151). */
  test("propertyOfAnObject", () => {
    const list = records(pond("000000000OPuddle 7", "000000000"))
    assert.deepEqual(list[8], Call.value("ZZ_PUDDLE_DEPTHS1", "000000000O3"))
    assert.deepEqual(list[14], Call.value("_RESULT", "000000000 0"))
  })
})
