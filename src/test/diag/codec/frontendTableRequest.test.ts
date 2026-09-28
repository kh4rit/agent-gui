// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/FrontendTableRequestTests.swift (MIT).

// source: fake — invented URLs and table schemas. Swift's `FrontendTableRequestTests.request` is
// `frontendTableRequest` in src/test/support/frontendTableSupport.ts.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import { DataField, FrontendTableRequest, FrontendTableRequestProblem, RFCTextEncoding } from "../../../diag/codec/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { frontendTableRequest as request } from "../../support/frontendTableSupport.js"
import { InventedDataObject, InventedField } from "../../support/inventedDataObject.js"

const { text, integer } = InventedField

describe("Frontend table requests validate their complete schema (bug #192)", () => {
  /** tree and column-position schemas decode without exposing URLs */
  for (const encoding of RFCTextEncoding.allCases) {
    test(`schemas(${encoding})`, () => {
      const tree = FrontendTableRequest.read(request({ encoding }))
      assert.equal(tree.encoding, encoding)
      assert.equal(tree.url, "sapr3://ZZ_DUCK_EXPORT")
      assert.equal(tree.rowWidth, 12)
      assert.deepEqual(tree.fields, [new DataField(1, 0, 12, DataField.text)])
      const columns = FrontendTableRequest.read(request({ fields: [text(30), text(3), integer, integer], encoding }))
      assert.equal(columns.rowWidth, 44)
      assert.deepEqual(
        columns.fields.map(field => field.offset),
        [0, 30, 36, 40]
      )
      assert.deepEqual(
        columns.fields.map(field => field.length),
        [30, 3, 4, 4]
      )
      assert.ok(tree.type.length === 0 && tree.subtype.length === 0)
      assert.ok(!inspect(tree).includes("ZZ_DUCK_EXPORT"))
      // Swift checks that the mirror has no children; the port's JSON form withholds the values too.
      assert.ok(!JSON.stringify(tree).includes("ZZ_DUCK_EXPORT"))
    })
  }

  /** short FORMAT padding is restored without changing its binary fields */
  test("trimmedFormat", () => {
    const object = new InventedDataObject("sapr3://ZZ_DUCK_EXPORT", [text(12)], [])
    const parsed = FrontendTableRequest.read(request({ formatRows: [object.formatRows[0].slice(0, -2)] }))
    assert.equal(parsed.fields[0]?.length, 12)
    assert.deepEqual(parsed.formatRows, object.formatRows[0])
  })

  /** unknown, missing and duplicate parameters fail without including their values */
  test("parameters", () => {
    const valid: [string, string][] = [
      ["INSUBTYPE", ""],
      ["INTREP", "LIT"],
      ["INTYPE", ""],
      ["INURL", "sapr3://ZZ_PRIVATE_VALUE"]
    ]
    for (const parameters of [
      valid.slice(0, -1),
      [...valid, ["INURL", "ZZ_DUPLICATE"]],
      [...valid, ["ZZ_EXTRA", "ZZ_PRIVATE_VALUE"]],
      [...valid.slice(0, -1), ["INURL", ""]]
    ] as [string, string][][]) {
      throwsInfo(() => FrontendTableRequest.read(request({ parameters })), FrontendTableRequestProblem, { kind: "parameters" })
    }
    const other: [string, string][] = [
      ["INSUBTYPE", ""],
      ["INTREP", "ZZ_UNKNOWN"],
      ["INTYPE", ""],
      ["INURL", "sapr3://ZZ_PRIVATE_VALUE"]
    ]
    throwsInfo(() => FrontendTableRequest.read(request({ parameters: other })), FrontendTableRequestProblem, { kind: "representation" })
  })

  /** overlapping, out-of-bounds, negative and unsupported fields are rejected */
  test("badFields", () => {
    const object = new InventedDataObject("sapr3://ZZ_DUCK_EXPORT", [text(12)], [])
    for (const [offset, value] of [
      [60, 2],
      [64, 1],
      [64, 0xffffffff],
      [68, 0],
      [68, 13],
      [72, 1]
    ]) {
      const row = object.formatRows[0].slice()
      row.set(
        [0, 1, 2, 3].map(index => (value >>> (index * 8)) & 0xff),
        offset
      )
      throwsInfo(() => FrontendTableRequest.read(request({ formatRows: [row] })), FrontendTableRequestProblem, { kind: "format" }, `${offset}`)
    }
    for (const type of [0x49, 0x73, 0x3f]) {
      // "I", "s", "?"
      const row = object.formatRows[0].slice()
      row[76] = type
      throwsInfo(() => FrontendTableRequest.read(request({ formatRows: [row] })), FrontendTableRequestProblem, { kind: "format" })
    }
    const two = new InventedDataObject("sapr3://ZZ_DUCK_EXPORT", [text(4), text(8)], [])
    const overlap = two.formatRows
    overlap[1][64] = 0
    throwsInfo(() => FrontendTableRequest.read(request({ fields: two.fields, formatRows: overlap })), FrontendTableRequestProblem, {
      kind: "format"
    })
    const aligned = new InventedDataObject("sapr3://ZZ_DUCK_EXPORT", [text(1), integer], [])
    const misaligned = aligned.formatRows
    misaligned[1][64] = 2
    throwsInfo(() => FrontendTableRequest.read(request({ fields: aligned.fields, formatRows: misaligned })), FrontendTableRequestProblem, {
      kind: "format"
    })
    throwsInfo(() => FrontendTableRequest.read(request({ formatRows: [] })), FrontendTableRequestProblem, { kind: "tables" })
    throwsInfo(() => FrontendTableRequest.read(request({ formatCount: 129 })), FrontendTableRequestProblem, { kind: "tables" })
    throwsInfo(() => FrontendTableRequest.read(request({ dataRows: [new Uint8Array(12).fill(32)] })), FrontendTableRequestProblem, {
      kind: "tables"
    })
  })

  /** framing and claimed content counts are validated */
  test("framing", () => {
    throwsInfo(() => FrontendTableRequest.read(request().slice(0, -6)), FrontendTableRequestProblem, {
      kind: "framing",
      error: { kind: "noEndItem" }
    })
    const broken = request()
    broken[4 + FrontendTableRequest.functionName.length] = 0
    throwsInfo(() => FrontendTableRequest.read(broken), FrontendTableRequestProblem, { kind: "framing", error: { kind: "trailingPair", item: 1 } })
    assert.throws(() => FrontendTableRequest.read(request({ formatCount: 2 })), FrontendTableRequestProblem)
  })
})
