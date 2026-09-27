// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ControlCallTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AutomationVerbFlag, ControlCall, DataProviderQueue, FlushCallReadError } from "../../../diag/codec/index.js"
import { concatBytes } from "../../../diag/wire/index.js"
import { InventedControlScene } from "../../support/inventedControlScene.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"

describe("A flush call read for its verbs, records and data objects", () => {
  /** The pond call: verbs with their targets, arguments and result records. */
  test("pondVerbs", () => {
    const call = ControlCall.read(InventedFlushCall.pond().bytes)
    assert.deepEqual(
      call.invocations.slice(0, 3).map(invocation => invocation.name),
      ["CreateObject", "CreateControl", "SetPaddleSpeed"]
    )
    const create = call.invocations[0]
    assert.ok(create.target === 1)
    assert.deepEqual(create.flag, AutomationVerbFlag.call)
    assert.deepEqual(
      create.arguments.map(argument => argument.record),
      [2]
    )
    assert.equal(create.result, 3)
    assert.equal(call.argument(1, create), "Pond grid for very important ducks")
    assert.ok(call.record(1)?.value === "DPC" && call.record(1)?.isObject === false)
    assert.ok(call.dataObjects.length === 0 && call.queueProblems.length === 0)
  })

  /** A queue table's entries become data objects with their URL, fields and rows. */
  test("dataObjects", () => {
    const call = ControlCall.read(InventedControlScene.call().bytes)
    assert.equal(call.dataObjects.length, 4, `${call.queueProblems}`)
    const nodes = call.dataObject("SAPR3://ZZ_POND/NODES")
    assert.ok(nodes !== undefined)
    assert.ok(nodes.type === "APPLICATION" && nodes.subtype === "X-R3TABLE" && nodes.structureName === "TREEV_NODE")
    assert.ok(nodes.fields.length === 13 && nodes.rows.length === 6)
    assert.ok(nodes.text(1, 1) === "POND01" && nodes.text(1, 2) === "Root")
    assert.ok(nodes.number(1, 3) === 6 && nodes.flag(1, 6))
    assert.equal(nodes.number(1, 13), 1, "a 2-byte integer")
    const items = call.dataObject("SAPR3://ZZ_POND/ITEMS")
    assert.ok(items !== undefined)
    assert.equal(items.text(0, 18), "Pond Menu")
    const cells = call.dataObject("SAPR3://ZZ_POND/CELLS")
    assert.ok(cells !== undefined)
    assert.ok(cells.number(0, 1) === -1 && cells.number(1, 1) === 1 && cells.text(1, 4) === "Mallard Mel")
    const catalog = call.dataObject("SAPR3://ZZ_POND/CATALOG")
    assert.ok(catalog !== undefined)
    assert.equal(catalog.structureName, undefined, "X-UNKNOWN names no structure")
    assert.ok(catalog.rows.length === 3 && catalog.rowWidth === 576)
  })

  /** The invocations that create shells carry the shell id and class as texts. */
  test("shellVerbs", () => {
    const call = ControlCall.read(InventedControlScene.call().bytes)
    const creates = call.invocations.filter(invocation => invocation.name.startsWith("CreateControl"))
    assert.deepEqual(
      creates.map(invocation => call.argument(1, invocation)),
      ["101", "102", "103", "104", "105", "106"]
    )
    assert.equal(call.argument(2, creates[4])?.includes(".tree."), true)
    const set = call.invocations.find(invocation => invocation.name === "ListDisplay")
    assert.ok(set !== undefined)
    assert.ok(set.flag.kind === "set" && set.arguments.length === 1 && set.arguments[0].name === "" && call.argument(1, set) === "1")
    const table = call.invocations.find(invocation => invocation.name === "GetTable")
    assert.ok(table !== undefined)
    assert.notEqual(table.result, undefined, "a result column named _RESULT_QUEUEONLY is a result")
  })

  /** A queue entry with a missing part is reported, the others read. */
  test("missingPart", () => {
    const scene = InventedControlScene.call()
    const rows = scene.tables[2].rows.slice()
    const catalogStart = InventedControlScene.nodes.queueRows.length + InventedControlScene.items.queueRows.length
    assert.ok(InventedControlScene.catalog.queueRows.length >= 2, "the raw catalog spans rows")
    rows.splice(catalogStart, 1)
    scene.tables[2].rows = rows
    const call = ControlCall.read(scene.bytes)
    assert.equal(call.dataObjects.length, 3)
    assert.ok(call.queueProblems.length === 1 && call.queueProblems[0].includes("missing part(s) [1]"), `${call.queueProblems}`)
  })

  /** The queue's row prefix: key, entry id, program, sequence and part. */
  test("rowPrefix", () => {
    const object = InventedControlScene.nodes
    object.id = "00A7"
    object.sequence = 12
    const entries = DataProviderQueue.entries(concatBytes(...object.queueRows))
    assert.equal(entries.length, 1)
    assert.ok(entries[0].id === "00A7" && entries[0].sequence === 12 && entries[0].program === "SAPGUI")
    assert.deepEqual(
      [...entries[0].parts.keys()].sort((a, b) => a - b),
      Array.from({ length: object.queueRows.length }, (_, index) => index + 1)
    )
    assert.equal(entries[0].missingParts.length, 0)
  })

  /** A queue table of another width is refused. */
  test("queueWidth", () => {
    const scene = InventedControlScene.call()
    scene.tables[2].width = 1852
    assert.throws(() => ControlCall.read(scene.bytes), FlushCallReadError)
  })
})
