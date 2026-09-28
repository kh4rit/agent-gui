// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/FrontendTableReplyTests.swift (MIT).

// source: fake — candidate response grammar, not a captured successful reply.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  DataField,
  DataObject,
  FlushCallAnswerBuilder,
  FrontendTableReply,
  FrontendTableReplyProblem,
  FrontendTableRequest,
  type RFCTextEncoding
} from "../../../diag/codec/index.js"
import { concatBytes } from "../../../diag/wire/index.js"
import { ascii, throwsInfo } from "../../support/codecTestSupport.js"
import { frontendTableRequest } from "../../support/frontendTableSupport.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"
import { decodeAnswer } from "../../support/rfcTestSupport.js"

/** The pond call's echoed head items, then a request (Swift `static func request(encoding:)`). */
function request(encoding: RFCTextEncoding = "singleByte"): Uint8Array {
  const head = InventedFlushCall.pond()
    .head.filter(item => FlushCallAnswerBuilder.echoedHeadIDs.includes(item.id))
    .map(item => InventedFlushCall.item(item.id, item.value))
  return concatBytes(...head, frontendTableRequest({ encoding }))
}

/** A saved table (Swift `static func table(rows:url:width:)`). */
function table(rows: Uint8Array[], url = "sapr3://ZZ_DUCK_EXPORT", width = 12): DataObject {
  return new DataObject(0, url, "APPLICATION", "X-R3TABLE", undefined, [new DataField(1, 0, 12, DataField.text)], width, rows)
}

describe("Experimental frontend table replies (bug #192)", () => {
  /** the candidate response carries the actual rows, request FORMAT and typed-table MIME */
  test("content", () => {
    const saved = table([ascii("ZZ_ROOT     "), ascii("ZZ_BRANCH   ")])
    const bytes = FrontendTableReply.experimental(request(), saved)
    const decoded = decodeAnswer(bytes)
    assert.deepEqual(decoded.table("DATAASC")?.rows, concatBytes(...saved.rows))
    assert.deepEqual(decoded.table("FORMAT")?.rows, FrontendTableRequest.read(request()).formatRows)
    assert.deepEqual(decoded.table("PROPS")?.rows, new Uint8Array(0))
    const parameters = decoded.ids.flatMap((id, index) => (id === 0x0201 ? [new TextDecoder().decode(decoded.values[index])] : []))
    assert.deepEqual(parameters, ["TYPE", "SUBTYPE"])
    assert.ok(!decoded.ids.includes(0x0102), "the response uses a return head, without a function call")
    assert.equal(decoded.ids[decoded.ids.length - 1], 0xffff)
  })

  /** an explicitly empty expansion table still returns its schema */
  test("empty", () => {
    const bytes = FrontendTableReply.experimental(request(), table([]))
    const decoded = decodeAnswer(bytes)
    assert.deepEqual(decoded.table("DATAASC")?.rows, new Uint8Array(0))
    assert.equal(decoded.table("FORMAT")?.rows.length, 80)
  })

  /** no reply is encoded for a mismatched object or an unverified character conversion */
  test("mismatches", () => {
    for (const saved of [table([], "sapr3://ZZ_OTHER"), table([], undefined, 16), table([Uint8Array.of(1)])]) {
      throwsInfo(() => FrontendTableReply.experimental(request(), saved), FrontendTableReplyProblem, { kind: "schema" })
    }
    throwsInfo(() => FrontendTableReply.experimental(request("utf16LittleEndian"), table([])), FrontendTableReplyProblem, {
      kind: "unsupportedEncoding"
    })
    throwsInfo(() => FrontendTableReply.experimental(frontendTableRequest(), table([])), FrontendTableReplyProblem, { kind: "head" })
    throwsInfo(
      () =>
        FrontendTableReply.experimental(
          request(),
          table(Array.from({ length: 4097 }, () => new Uint8Array(12).fill(32)))
        ),
      FrontendTableReplyProblem,
      { kind: "tooLarge" }
    )
    throwsInfo(
      () =>
        FrontendTableReply.experimental(
          request(),
          table(Array.from({ length: 4096 }, () => ascii("ZZ_ROOT     ")))
        ),
      FrontendTableReplyProblem,
      { kind: "tooLarge" }
    )
  })
})
