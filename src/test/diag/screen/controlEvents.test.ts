// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ControlEventsTests.swift (MIT).

// What a click into the pond scene's grid and tree reports (controls/events.md §4, Readings
// R-CT-38 to R-CT-41): the registrations the scene keeps, the grid's double-click and current
// cell, the tree's opened node. Every name and text is invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlCall, DataManagerControl, DataManagerFirstVisible } from "../../../diag/codec/index.js"
import { ControlEvents, ControlScene, GridModel } from "../../../diag/screen/index.js"
import { InventedControlScene } from "../../support/inventedControlScene.js"

function scene(): ControlScene {
  const scene = new ControlScene()
  scene.apply(ControlCall.read(InventedControlScene.call().bytes))
  return scene
}

describe("Control events: a grid's double-click and current cell, a tree's opened node", () => {
  /** the scene keeps the events and cached properties the server registered for each shell, and each row's id */
  test("registrations", () => {
    const pond = scene()
    assert.deepEqual(pond.shells.get(106)?.events, new Set([ControlEvents.gridDoubleClick]))
    assert.deepEqual(pond.shells.get(106)?.cachedProperties, InventedControlScene.gridProperties)
    assert.deepEqual(pond.shells.get(105)?.events, new Set([ControlEvents.treeNodeOpened]))
    assert.deepEqual(pond.shells.get(105)?.cachedProperties, [ControlEvents.selectedNodeKey])
    assert.equal(pond.shells.get(101)?.events.size, 0)
    const content = pond.shells.get(106)?.content
    assert.ok(content?.kind === "grid", "no grid")
    assert.deepEqual(
      content.value.rowIDs,
      new Map([
        [1, "0000000001"],
        [2, "0000000002"],
        [3, "0000000003"]
      ])
    )
  })

  /** a double-click on a grid cell: the OK-code, the focus, event 3 with the row id, the column, the row, the column's place and 0, and the grid's state */
  test("gridDoubleClick", () => {
    const action = ControlEvents.gridDoubleClickIn(scene(), 106, { row: 3, column: 1 })
    assert.ok(action !== undefined)
    assert.equal(action.okCode, "%_GC 106 3")
    assert.equal(action.focus, 106)
    assert.deepEqual(action.report.events, [{ shell: 106, event: 3, parameters: ["0000000003", "DUCK", "3", "1", "0"] }])
    const state = action.report.controls[0]
    assert.ok(state !== undefined)
    assert.equal(state.shell, 106)
    assert.deepEqual(state.firstVisible, DataManagerFirstVisible.origin)
    assert.deepEqual(
      state.properties.map(property => property.name),
      ["CurrentCellCol", "CurrentCellRow", "FirstVisibleRow", "FirstVisibleRowID", "CurrentCellColID", "CurrentCellRowID", "CurrentCellText"]
    )
    assert.deepEqual(
      state.properties.map(property => property.value),
      ["1", "3", "1", "0000000001", "DUCK", "0000000003", "Sir Waddles"]
    )
  })

  /** the first row's current cell reports no current row, as SAP GUI's did; only registered properties go */
  test("gridState", () => {
    const pond = scene()
    // Swift's `guard var shell = scene.shells[106]` copies the shell.
    const shell = pond.shells.get(106)?.clone()
    assert.ok(shell !== undefined && shell.content.kind === "grid", "no grid")
    const grid = shell.content.value
    const first = ControlEvents.gridState(grid, shell, { row: 1, column: 2 })
    assert.ok(first !== undefined)
    assert.deepEqual(
      first.properties.map(property => property.name),
      ["CurrentCellCol", "FirstVisibleRow", "FirstVisibleRowID", "CurrentCellColID", "CurrentCellText"]
    )
    assert.ok(first.property("CurrentCellColID") === "MOOD" && first.property("CurrentCellText") === "smug")
    shell.cachedProperties = ["CurrentCellText"]
    assert.deepEqual(ControlEvents.gridState(grid, shell, { row: 2, column: 3 })?.properties, [{ name: "CurrentCellText", value: "3" }])
    assert.equal(ControlEvents.gridState(grid, shell, { row: 2, column: 4 }), undefined, "no fourth column")
    // Without a registered double-click, a double-click is no event.
    pond.shells.get(106)!.events = new Set()
    assert.equal(ControlEvents.gridDoubleClickIn(pond, 106, { row: 1, column: 1 }), undefined)
  })

  /** a row id without a marker is the row number as the server writes it: ten digits, right-aligned in 33 characters */
  test("rowIDWithoutMarker", () => {
    const id = ControlEvents.rowID(7, new GridModel())
    assert.ok(id.length === 33 && id.endsWith("0000000007") && id.startsWith(" ".repeat(23)))
  })

  /** opening a tree node: event 25 with the node's key, the selected node, the OK-code and the focus; a node not in the tree is none */
  test("treeNodeOpen", () => {
    const pond = scene()
    const action = ControlEvents.treeNodeOpen(pond, 105, "DUCK01")
    assert.ok(action !== undefined)
    assert.ok(action.okCode === "%_GC 105 25" && action.focus === 105)
    assert.deepEqual(action.report.events, [{ shell: 105, event: 25, parameters: ["DUCK01"] }])
    assert.deepEqual(action.report.controls, [new DataManagerControl(105, [{ name: "ABAPSelNodeKey", value: "DUCK01" }])])
    assert.equal(ControlEvents.treeNodeOpen(pond, 105, "SWAN"), undefined)
    assert.equal(ControlEvents.treeNodeOpen(pond, 106, "DUCK01"), undefined, "a grid is no tree")
  })
})
