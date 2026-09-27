// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ControlSceneTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlCall } from "../../../diag/codec/index.js"
import { ControlScene, replacingMinusSuffix } from "../../../diag/screen/index.js"
import { InventedControlScene, InventedControlSceneRecorder } from "../../support/inventedControlScene.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"

function scene(): ControlScene {
  const scene = new ControlScene()
  scene.apply(ControlCall.read(InventedControlScene.call().bytes))
  return scene
}

describe("The control scene: shells, a splitter, a tree and a grid from one call", () => {
  /** shells by id, the container linked by name, the splitter's cells */
  test("shells", () => {
    const pond = scene()
    assert.deepEqual(
      Array.from(pond.shells.keys()).sort((a, b) => a - b),
      [101, 102, 103, 104, 105, 106]
    )
    const container = pond.shellLinkedTo(InventedControlScene.containerName)
    assert.ok(container !== undefined)
    assert.ok(container.id === 101 && container.content.kind === "container" && container.parent === undefined)
    const splitter = pond.shells.get(102)
    assert.ok(splitter !== undefined)
    assert.equal(splitter.parent, 101)
    assert.ok(splitter.content.kind === "splitter", "no splitter")
    const layout = splitter.content.value
    assert.ok(layout.rows === 1 && layout.columns === 2)
    assert.deepEqual(layout.columnWidths, new Map([[1, 40]]))
    assert.ok(layout.columnShare(1) === 0.4 && layout.rowShare(1) === 1)
    assert.equal(pond.child(102, { row: 1, column: 1 })?.id, 103)
    assert.equal(pond.child(102, { row: 1, column: 2 })?.id, 104)
    assert.deepEqual(
      pond.children(103).map(shell => shell.id),
      [105]
    )
    assert.deepEqual(
      pond.children(104).map(shell => shell.id),
      [106]
    )
  })

  /** the tree: nodes with texts from the item table, folders, icons, hidden and disabled nodes, expanded keys */
  test("tree", () => {
    const content = scene().shells.get(105)?.content
    assert.ok(content?.kind === "tree", "no tree")
    const tree = content.value
    assert.ok(tree.listDisplay)
    assert.deepEqual(
      tree.children("").map(node => node.text),
      ["Pond Menu"]
    )
    assert.deepEqual(
      tree.children("Root").map(node => node.id),
      ["POND01", "POND02"]
    )
    assert.ok(tree.node("POND01")?.forcesExpander === true && tree.node("POND01")?.isFolder === true)
    assert.deepEqual(
      tree.children("POND02").map(node => node.text),
      ["Mallard Mel", "Quackers (retired)"],
      "the hidden duck is left out"
    )
    assert.ok(tree.node("DUCK01")?.icon === "@0A@" && tree.node("DUCK02")?.isDisabled === true)
    assert.deepEqual(tree.expanded, new Set(["Root"]))
  })

  /** the grid: columns in position order, the title, the cells by row and column */
  test("grid", () => {
    const content = scene().shells.get(106)?.content
    assert.ok(content?.kind === "grid", "no grid")
    const grid = content.value
    assert.equal(grid.title, InventedControlScene.gridTitle)
    assert.deepEqual(
      grid.columns.map(column => column.id),
      ["DUCK", "MOOD", "QUACKS"]
    )
    assert.deepEqual(
      grid.columns.map(column => column.header),
      ["Duck", "Mood", "Quacks"]
    )
    assert.ok(grid.columns[2].isNumeric && !grid.columns[0].isNumeric)
    assert.deepEqual(grid.rowNumbers, [1, 2, 3])
    assert.ok(grid.text(3, 1) === "Sir Waddles" && grid.text(2, 3) === "3")
  })

  /** a later call replaces a shell of the same id; the scene counts its calls */
  test("replacement", () => {
    const pond = scene()
    const call = ControlCall.read(InventedControlScene.call().bytes)
    for (let index = 0; index < 12; index++) pond.apply(call)
    assert.ok(pond.shells.size === 6 && pond.calls === 13)
    assert.equal(pond.shells.get(105)?.created, 13)
  })

  /** a dock: the shell linked to a program */
  test("dock", () => {
    const recorder = new InventedControlSceneRecorder()
    const root = recorder.verb("CreateObject", "C", 1, [
      [12, "{ZZ-POND-ROOT}"],
      [3, "1033"]
    ], "O1-")!
    recorder.verb("CreateControl", "C", root, [
      [3, "114"],
      [12, InventedControlScene.splitterClass],
      [3, "1342177280"],
      [3, "10"]
    ], "")
    recorder.verb("LinkControl", "C", root, [
      [3, "114"],
      [12, "ZZ_POND_MONITOR"],
      [12, "1"]
    ])
    const call = new InventedFlushCall({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs })
    const pond = new ControlScene()
    pond.apply(ControlCall.read(call.bytes))
    assert.equal(pond.shellDockedTo("ZZ_POND_MONITOR")?.id, 114)
    assert.equal(pond.shellLinkedTo("ZZ_POND_MONITOR"), undefined)
  })
})

// Not in Swooey: what the TypeScript port adds to keep Swift's value semantics, and the summary's
// shape as ControlScene.swift writes it.
describe("The control scene in TypeScript: values and the summary", () => {
  /** A shell, a model or a clone of the scene read before a call stays as it was. */
  test("valueSemantics", () => {
    const pond = scene()
    const before = pond.clone()
    const tree = pond.shells.get(105)
    assert.ok(tree !== undefined)
    // A later call that changes the tree's shell without creating it again.
    const recorder = new InventedControlSceneRecorder()
    recorder.verb("RegisterCachedProp", "C", 1, [
      [3, "105"],
      [12, "ZZDuckMood"]
    ])
    recorder.verb("LinkContainer", "C", 1, [
      [3, "105"],
      [12, "ZZ_POND_TOO"]
    ])
    pond.apply(ControlCall.read(new InventedFlushCall({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs }).bytes))
    const after = pond.shells.get(105)
    assert.ok(after !== undefined && after !== tree, "the call changed a copy")
    assert.deepEqual(after.cachedProperties, ["ABAPSelNodeKey", "ZZDuckMood"])
    assert.equal(after.containerName, "ZZ_POND_TOO")
    assert.equal(after.content.kind === "tree" && after.content.value.nodes.length, 6)
    for (const old of [tree, before.shells.get(105)]) {
      assert.deepEqual(old?.cachedProperties, ["ABAPSelNodeKey"])
      assert.equal(old?.containerName, undefined)
    }
    assert.ok(before.calls === 1 && pond.calls === 2)
  })

  /** The summary: structure only, shells by id. */
  test("summary", () => {
    assert.equal(new ControlScene().summary, "control scene after 0 call(s): no shells")
    assert.equal(
      scene().summary,
      "control scene after 1 call(s): 101 container, linked to a container name of 17 chars; 102 splitter 1x2 in 101; " +
        "103 container in 102 cell 1,1; 104 container in 102 cell 1,2; 105 tree, 6 node(s), 1 expanded in 103; " +
        "106 grid, 3 column(s), 3 row(s) in 104"
    )
  })

  /** A trailing minus is a leading one (Swift's `String.replacingMinusSuffix`). */
  test("replacingMinusSuffix", () => {
    assert.equal(replacingMinusSuffix("1-"), "-1")
    assert.equal(replacingMinusSuffix("40"), "40")
    assert.equal(replacingMinusSuffix("-"), "-")
  })
})
