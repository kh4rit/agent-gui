// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ProviderURLResultTests.swift (MIT).

// source: fake — registered URLs and result slots are invented.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlHandleCounter, FlushAnswerHead, FlushCallAnswerBuilder, FlushCallReadError } from "../../../diag/codec/index.js"
import { concatBytes } from "../../../diag/wire/index.js"
import { ascii, throwsInfo } from "../../support/codecTestSupport.js"
import { InventedFlushCall as Call, InventedFlushCallText } from "../../support/inventedFlushCall.js"
import { decodeAnswer } from "../../support/rfcTestSupport.js"

describe("Registered provider URL results (bug #192)", () => {
  /** registered URLs use distinct indexed strings alongside feature results */
  for (const text of InventedFlushCallText.allCases) {
    test(`indexedResults(${text})`, () => {
      const call = new Call({
        descriptors: [1, 2, 3, 4].map(n => Call.descriptor(`${n} 12 _RESULT ${n}`)),
        values: [1, 2, 3, 4].map(() => Call.value("_RESULT", "000000000")),
        verbs: [Call.verb(1, "SaveDataToUrl", "C"), Call.verb(1, "GetGuiFeatures", "C"), Call.verb(1, "SaveDataToUrl", "C"), Call.verb(1, "SaveDataToUrl", "C")]
      })
      call.text = text
      const first = "sapr3://ZZ_DUCK&ONE"
      const second = "sapr3://ZZ_DUCK_TWO"
      const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter(), FlushAnswerHead.echo, {
        registeredURLs: new Map([
          [1, first],
          [3, second],
          [4, first]
        ])
      })
      const decoded = decodeAnswer(answer.value)
      const index = decoded.ids.indexOf(0x3c05)
      assert.ok(index >= 0)
      assert.equal(
        new TextDecoder().decode(decoded.values[index]),
        '<?xml version="1.0" encoding="UTF-8"?><SVARS>' +
          "<item><VALUE>sapr3://ZZ_DUCK&amp;ONE</VALUE></item>" +
          "<item><VALUE>&lt;AvailableFeatures&gt;&lt;/AvailableFeatures&gt;</VALUE></item>" +
          "<item><VALUE>sapr3://ZZ_DUCK_TWO</VALUE></item></SVARS>"
      )
      const values = decoded.table(call.encoded(ascii("VARS")))
      assert.ok(values !== undefined)
      assert.deepEqual(values.rows, call.encoded(concatBytes(...[1, 2, 3, 1].map(n => Call.value("_SRESULT", `000000000 ${n}`)))))
      assert.equal(answer.summary.recordsWithString, 4)
      assert.equal(answer.summary.recordsWithInteger, 0)
      assert.equal(answer.handles.next, 1)
      assert.ok(!answer.summary.description.includes("ZZ_DUCK"))
    })
  }

  /** URL overrides cannot target unrelated methods or external resources */
  test("invalidRegistration", () => {
    const call = new Call({
      descriptors: [Call.descriptor("1 12 _RESULT 1")],
      values: [Call.value("_RESULT", "000000000")],
      verbs: [Call.verb(1, "SaveDataToUrl", "C")]
    })
    const invalid = { kind: "encoding", value: "invalid registered provider URL result" } as const
    for (const override of [
      [0, "sapr3://ZZ_DUCK"],
      [2, "sapr3://ZZ_DUCK"],
      [1, "https://example.invalid/ZZ_DUCK"],
      [1, "sapr3://ZZ\nDUCK"],
      [1, "sapr3://" + "Z".repeat(257)]
    ] as [number, string][]) {
      throwsInfo(
        () => FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter(), FlushAnswerHead.echo, { registeredURLs: new Map([override]) }),
        FlushCallReadError,
        invalid
      )
    }
    const other = new Call({ descriptors: call.tables[1].rows, values: [Call.value("_RESULT", "000000000")], verbs: [Call.verb(1, "CreateObject", "C")] })
    throwsInfo(
      () =>
        FlushCallAnswerBuilder.answer(other.bytes, new ControlHandleCounter(), FlushAnswerHead.echo, {
          registeredURLs: new Map([[1, "sapr3://ZZ_DUCK"]])
        }),
      FlushCallReadError,
      invalid
    )
  })
})
