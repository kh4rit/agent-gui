// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ColumnPositionTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlCall, ControlHandleCounter, FlushCallAnswerBuilder, type DataManagerColumnPositions } from "../../../diag/codec/index.js"
import { ControlScene, GridColumn, GridModel } from "../../../diag/screen/index.js"
import { InventedControlScene, InventedControlSceneRecorder } from "../../support/inventedControlScene.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"

/** Shell 106's grid in `scene`. */
function grid106(scene: ControlScene): GridModel | undefined {
  const content = scene.shells.get(106)?.content
  return content?.kind === "grid" ? content.value : undefined
}

describe("Column-position reports follow explicit on-demand bindings", () => {
  /** A later binding resolves the grid's returned handle and ignores an unknown target */
  test("laterBinding", () => {
    const bytes = InventedControlScene.call().bytes
    const call = ControlCall.read(bytes)
    const answer = FlushCallAnswerBuilder.answer(bytes, new ControlHandleCounter(200))
    const creation = call.invocations.find(invocation => invocation.name === "CreateControl" && call.argument(1, invocation) === "106")
    assert.ok(creation !== undefined)
    const handle = answer.summary.handlesByVerb.get(creation.index)
    assert.ok(handle !== undefined)
    const scene = new ControlScene()
    scene.apply(call, answer.summary.handlesByVerb)
    for (const [target, assigned, expected] of [
      [`O${handle}`, "74", 74],
      ["O999999", "88", 74],
      [`${handle}`, "81", 81]
    ] as const) {
      const recorder = new InventedControlSceneRecorder()
      const root = recorder.record("", "OZZ_ROOT")
      const object = recorder.verb("CreateObject", "C", root, [[12, InventedControlScene.onDemandClass]], "O1-")!
      const table = recorder.verb("GetTable", "C", object, [], "O1-")!
      recorder.verb("AssignProperty2", "C", root, [
        [9, `O${table}-`],
        [12, "data"],
        [12, target],
        [12, "ColPosIDOnDemand"]
      ])
      // Handle may arrive after the binding in the same flush.
      recorder.verb("Handle", "S", object, [[3, assigned]])
      scene.apply(ControlCall.read(new InventedFlushCall({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs }).bytes))
      const grid = grid106(scene)
      assert.ok(grid !== undefined, "missing grid")
      assert.equal(grid.columnPositionReport?.handle, expected)
      assert.equal(scene.shells.get(106)?.created, 1)
    }
  })

  /** An explicit Handle is independent of the automation answer handle */
  test("explicitHandle", () => {
    const bytes = InventedControlScene.call(73).bytes
    const answer = FlushCallAnswerBuilder.answer(bytes, new ControlHandleCounter(200))
    const scene = new ControlScene()
    scene.apply(ControlCall.read(bytes), answer.summary.handlesByVerb)
    const grid = grid106(scene)
    assert.ok(grid !== undefined, "missing grid")
    const report = grid.columnPositionReport
    assert.ok(report !== undefined)
    assert.equal(report.handle, 73)
    assert.deepEqual(
      report.columns.map(column => column.position),
      [1, 2, 3]
    )
    assert.deepEqual(
      report.columns.map(column => column.width),
      [20, 12, 6]
    )
    assert.ok(!Array.from(answer.summary.handlesByVerb.values()).includes(73))
  })

  /** Rebuilding a grid replaces its binding, including a missing or invalid Handle */
  test("replacement", () => {
    const scene = new ControlScene()
    for (const handle of [73, 81, -1, 0]) {
      scene.apply(ControlCall.read(InventedControlScene.call(handle).bytes))
      const grid = grid106(scene)
      assert.ok(grid !== undefined, "missing grid")
      assert.equal(grid.columnPositionHandle, handle > 0 ? handle : undefined)
    }
    scene.apply(ControlCall.read(InventedControlScene.call().bytes))
    const grid = grid106(scene)
    assert.ok(grid !== undefined, "missing grid")
    assert.equal(grid.columnPositionReport, undefined)
  })

  /** Catalog gaps remain positions; no catalog or invalid columns produce no report */
  test("positions", () => {
    const grid = new GridModel()
    // A getter read anew each time (an assertion would narrow the property).
    const report = (): DataManagerColumnPositions | undefined => grid.columnPositionReport
    grid.columnPositionHandle = 52
    assert.equal(report(), undefined)
    grid.columns = [
      new GridColumn({ id: "ZZ_FIRST", position: 2, header: "First", width: 12, dataType: "C" }),
      new GridColumn({ id: "ZZ_LAST", position: 7, header: "Last", width: 9, dataType: "C" })
    ]
    assert.deepEqual(
      report()?.columns.map(column => column.position),
      [2, 7]
    )
    // Swift `grid.columns[1].width = 0`: a column is immutable here, so it is replaced.
    grid.columns[1] = new GridColumn({ ...grid.columns[1], width: 0 })
    assert.equal(report(), undefined)
  })
})
