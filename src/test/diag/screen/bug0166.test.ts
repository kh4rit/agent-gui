// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0166Tests.swift (MIT).

// Issue #166 (GitHub kh4rit/swooey#1): the runtime-error list drew its grid's title and columns
// but not one row. The owner's control traffic dump of that list (2026-09-26, trial-derived,
// PV-1008, PV-1010) shows the order the server fills a grid in: the catalog, then an on-demand
// object that gets an empty packet, is assigned to the grid's `DataTableOnDemand`, and only then
// gets the packet with the rows. The same call filled the grid three times over, each time after
// `DeleteAllCells`, with a new catalog and new on-demand objects. Swooey copied an object's
// packets into the grid only when it was assigned, so the rows that came after were lost.
//
// Swift's `Bug0166Tests.Filling`, `ducks` and `fewerDucks`, which Bug0167Tests shares, are in
// src/test/support/gridFillings.ts.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlCall } from "../../../diag/codec/index.js"
import { ControlScene, GridModel } from "../../../diag/screen/index.js"
import { ducks, fewerDucks, queueFillings, type GridFilling } from "../../support/gridFillings.js"
import type { InventedDataObject } from "../../support/inventedDataObject.js"
import { InventedControlScene, InventedControlSceneRecorder } from "../../support/inventedControlScene.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"

/** A call that creates grid 106 and fills it once per filling, in the order the owner's server used. */
function call(fillings: readonly GridFilling[]): InventedFlushCall {
  const recorder = new InventedControlSceneRecorder()
  const root = recorder.verb("CreateObject", "C", 1, [
    [12, "{ZZ-POND-ROOT}"],
    [3, "1033"]
  ], "O1-")!
  const grid = recorder.verb("CreateControl", "C", root, [
    [3, "106"],
    [12, InventedControlScene.gridClass],
    [3, "1409286144"],
    [3, "10"]
  ], "")!
  recorder.verb("Title", "S", grid, [[12, InventedControlScene.gridTitle]])
  const format = (object: InventedDataObject): number => {
    const provider = recorder.verb("CreateObject", "C", 1, [
      [12, InventedControlScene.providerClass],
      [3, "1033"]
    ], "O1-")!
    recorder.verb("SetDataFromUrl", "C", provider, [
      [12, "APPLICATION"],
      [12, "X-R3TABLE"],
      [12, object.url]
    ])
    return recorder.verb("GetDataAsFormat", "C", provider, [
      [12, "APPLICATION"],
      [12, "X-R3TABLE"]
    ], "O1-")!
  }
  for (const filling of fillings) {
    recorder.verb("DeleteAllCells", "C", grid)
    const catalog = format(filling.catalog)
    recorder.verb("AssignProperty2", "C", root, [
      [9, `O${catalog}-`],
      [12, "data"],
      [12, `O${grid}-`],
      [12, "InfoTable"]
    ])
    const onDemand = recorder.verb("CreateObject", "C", 1, [
      [12, InventedControlScene.onDemandClass],
      [3, "1033"]
    ], "O1-")!
    recorder.verb("Handle", "S", onDemand, [[3, "3"]])
    const empty = recorder.verb("data", "G", format(filling.empty), [], "O1-")!
    recorder.verb("InsertPacket", "C", onDemand, [
      [3, "0"],
      [9, `O${empty}-`]
    ])
    const table = recorder.verb("GetTable", "C", onDemand, [], "", "_RESULT_QUEUEONLY")!
    recorder.verb("AssignProperty2", "C", root, [
      [12, `O${table}-`],
      [12, ""],
      [12, `O${grid}-`],
      [12, "DataTableOnDemand"]
    ])
    const rows = recorder.verb("data", "G", format(filling.rows), [], "O1-")!
    recorder.verb("InsertPacket", "C", onDemand, [
      [3, "1"],
      [9, `O${rows}-`]
    ])
  }
  const flushCall = new InventedFlushCall({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs })
  queueFillings(flushCall, fillings)
  return flushCall
}

function grid(fillings: readonly GridFilling[]): GridModel {
  const scene = new ControlScene()
  scene.apply(ControlCall.read(call(fillings).bytes))
  const content = scene.shells.get(106)?.content
  assert.ok(content?.kind === "grid", "no grid")
  return content.value
}

describe("Issue #166: cells inserted after the grid got its data table", () => {
  /** rows inserted after the data table was assigned are drawn (bug #166) */
  test("rowsAfterAssignment", () => {
    const pond = grid([ducks()])
    assert.deepEqual(
      pond.columns.map(column => column.id),
      ["DUCK", "MOOD", "QUACKS"]
    )
    assert.deepEqual(pond.rowNumbers, [1, 2, 3])
    assert.ok(pond.text(1, 1) === "Mallard Mel" && pond.text(3, 3) === "40")
  })

  /** a grid filled again in the same call shows the last filling only (bug #166) */
  test("filledAgain", () => {
    const pond = grid([ducks(), ducks(), fewerDucks()])
    assert.deepEqual(
      pond.columns.map(column => column.id),
      ["DUCK", "MOOD"]
    )
    assert.deepEqual(pond.rowNumbers, [1])
    assert.ok(pond.text(1, 1) === "Mallard Mel" && pond.text(1, 2) === "smug")
    assert.equal(pond.text(1, 3), "", "no cell of an earlier filling stays behind")
  })
})
