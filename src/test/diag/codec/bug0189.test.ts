// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/Bug0189Tests.swift (MIT).

// source: fake — invented objects, shared result slots and descriptor metadata. Swift's
// `FlushCallAnswerTests.decode` is `decodeAnswer` in src/test/support/rfcTestSupport.ts.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlHandleCounter, FlushAnswerHead, FlushCallAnswerBuilder } from "../../../diag/codec/index.js"
import { ascii } from "../../support/codecTestSupport.js"
import { InventedFlushCall as Call, type InventedFlushCallText } from "../../support/inventedFlushCall.js"
import { decodeAnswer } from "../../support/rfcTestSupport.js"

describe("Object result descriptors (bug #189)", () => {
  /** object results carry type 9 while scalar, input and unplaced descriptors keep their rules */
  for (const text of ["singleByte", "utf16LittleEndian", "utf16BigEndian"] as InventedFlushCallText[]) {
    for (const raw of [false, true]) {
      test(`resultTypes(${text}, ${raw})`, () => {
        const descriptors = ["1 12 #1 1", "1 12 _RESULT 2", "2 12 _RESULT 2", "3 12 _RESULT 3", "4 12 _RESULT 4", "5 12 _RESULT 1", "6 12 _RESULT 2"]
        const call = new Call({
          descriptors: descriptors.map(Call.descriptor),
          values: [
            Call.value("", "000000000 ZZ_INPUT"),
            Call.value("_RESULT", "000000000"),
            Call.value("_RESULT", "000000000"),
            Call.value("_RESULT", "000000000")
          ],
          verbs: [
            Call.verb(1, "CreateObject", "C"),
            Call.verb(2, "GetTable", "C"),
            Call.verb(2, "GetContainer", "C"),
            Call.verb(2, "GetRegValueEx", "C"),
            Call.verb(2, "CreateObject", "C"),
            Call.verb(2, "SetProperty", "S")
          ]
        })
        call.text = text
        call.table("ZZ_DUCK_SLOTS", table => {
          table.raw = raw
        })
        for (const enabled of [false, true]) {
          const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter(), FlushAnswerHead.echo, { objectResultTypes: enabled })
          const decoded = decodeAnswer(answer.value)
          const rows = decoded.table(call.encoded(ascii("ZZ_DUCK_SLOTS")))?.rows
          assert.ok(rows !== undefined)
          const expected = [
            "",
            enabled ? "1  9 _RESULT 2" : descriptors[1],
            enabled ? "2  9 _RESULT 2" : descriptors[2],
            descriptors[3],
            descriptors[4],
            descriptors[5],
            ""
          ]
          const width = 44 * call.bytesPerCharacter
          // The test decoder expands shortened raw blank rows as single-byte spaces;
          // inspect the full-width result rows independently of that convenience.
          for (let index = 1; index <= 5; index++) {
            assert.deepEqual(rows.slice(index * width, (index + 1) * width), call.encoded(Call.descriptor(expected[index])), `row ${index}`)
          }
          assert.equal(answer.summary.objectDescriptorsRewritten, enabled ? 2 : 0)
          assert.deepEqual(
            answer.summary.handlesByVerb,
            new Map([
              [1, 1],
              [2, 2]
            ])
          )
          assert.equal(answer.handles.next, 3)
        }
      })
    }
  }
})
