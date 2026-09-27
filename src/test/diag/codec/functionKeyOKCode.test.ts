// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/FunctionKeyOKCodeTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { FunctionKeyOKCode } from "../../../diag/codec/index.js"
import { ascii } from "../../support/codecTestSupport.js"

/** The batch-input spelling of a function key (client-input.md Reading R-CI-20, PV-0790). */
describe("Function numbers as OK-codes", () => {
  test("a function number is `/` and at least two digits", () => {
    const cases: [number, string][] = [
      [0, "/00"],
      [8, "/08"],
      [12, "/12"],
      [32, "/32"],
      [86, "/86"],
      [100, "/100"],
      [255, "/255"]
    ]
    for (const [number, expected] of cases) {
      assert.equal(FunctionKeyOKCode.text(number), expected)
      assert.equal(FunctionKeyOKCode.functionNumber(ascii(expected)), number)
    }
  })

  test("anything else names no function number", () => {
    for (const command of ["", "/", "/8", "08", "=08", "/0008", "/ 8", "/8 ", "/-1", "/256", "/999", "/nZZDAM_MON", "/n", "/A8", "/0x"])
      assert.equal(FunctionKeyOKCode.functionNumber(ascii(command)), undefined, command)
  })
})
