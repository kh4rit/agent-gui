// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0167Tests.swift (MIT).

// Issue #167: the runtime-error list's grid kept its first filling when a later flush call filled
// it again. The owner's control traffic dump of 2026-09-26 (trial-derived, structure only,
// controls/scene.md Reading R-SC-8) shows the second call, which creates no control, naming the
// grid in `AssignProperty2`'s shell argument by the number of the handle Swooey's answer had
// returned for the grid's `CreateControl` (`38` for `O38`), and aiming its other verbs at records
// whose value is the same for every object. The scene resolved the argument only through the
// records of the same call, so the refill was dropped.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlCall, ControlHandleCounter, FlushCallAnswerBuilder, type FlushAnswerSummary } from "../../../diag/codec/index.js"
import { ControlScene, type GridModel } from "../../../diag/screen/index.js"
import { ducks, fewerDucks, queueFillings, type GridFilling } from "../../support/gridFillings.js"
import type { InventedDataObject } from "../../support/inventedDataObject.js"
import { InventedControlScene, InventedControlSceneRecorder } from "../../support/inventedControlScene.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"

/** The list's grid, and the handle Swooey's answer returns for its creation: the counter stands at 37 before the first call, whose root object takes `O37`. */
const gridID = 115
const gridHandle = 38

/**
 * A call that fills a grid once per filling, in issue #166's order. With `creating`, the call
 * creates grid `creating` first and names it by its creation's result record; without, it names
 * the grid by `naming`, a record holding a number or a handle. Every verb aimed at the grid or at
 * the automation root targets one record, whose value is the same for every object.
 */
function call(options: { creating?: number; naming?: string }, fillings: readonly GridFilling[]): InventedFlushCall {
  const recorder = new InventedControlSceneRecorder()
  const anyone = recorder.record("", "OQUACK")
  let target = anyone
  let shellArgument: [type: number, value: string] = [3, options.naming ?? ""]
  if (options.creating !== undefined) {
    const root = recorder.verb("CreateObject", "C", anyone, [
      [12, "{ZZ-POND-ROOT}"],
      [3, "1033"]
    ], "O1-")!
    const grid = recorder.verb("CreateControl", "C", root, [
      [3, `${options.creating}`],
      [12, InventedControlScene.gridClass],
      [3, "1409286144"],
      [3, "10"]
    ], "")!
    recorder.verb("Title", "S", grid, [[12, InventedControlScene.gridTitle]])
    target = grid
    shellArgument = [12, `O${grid}-`]
  }
  const format = (object: InventedDataObject): number => {
    const provider = recorder.verb("CreateObject", "C", anyone, [
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
  recorder.verb("AutoRedraw", "S", target, [[3, "0"]])
  for (const filling of fillings) {
    recorder.verb("DeleteAllCells", "C", target)
    const catalog = format(filling.catalog)
    recorder.verb("AssignProperty2", "C", anyone, [[9, `O${catalog}-`], [12, "data"], shellArgument, [12, "InfoTable"]])
    const onDemand = recorder.verb("CreateObject", "C", anyone, [
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
    recorder.verb("AssignProperty2", "C", anyone, [[12, `O${table}-`], [12, ""], shellArgument, [12, "DataTableOnDemand"]])
    const rows = recorder.verb("data", "G", format(filling.rows), [], "O1-")!
    recorder.verb("InsertPacket", "C", onDemand, [
      [3, "1"],
      [9, `O${rows}-`]
    ])
  }
  recorder.verb("AutoRedraw", "S", target, [[3, "1"]])
  const flushCall = new InventedFlushCall({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs })
  queueFillings(flushCall, fillings)
  return flushCall
}

/**
 * A mode's calls as the session handles them: each answered by Swooey's answer builder with the
 * connection's one counter, then applied to the scene with the handles its answer returned.
 */
class Pond {
  counter = new ControlHandleCounter(37)
  scene = new ControlScene()

  receive(call: InventedFlushCall): FlushAnswerSummary {
    const bytes = call.bytes
    const answer = FlushCallAnswerBuilder.answer(bytes, this.counter)
    this.counter = answer.handles
    this.scene.apply(ControlCall.read(bytes), answer.summary.handlesByVerb)
    return answer.summary
  }

  grid(id: number): GridModel | undefined {
    const content = this.scene.shells.get(id)?.content
    return content?.kind === "grid" ? content.value : undefined
  }
}

/** The ducks' three columns and three rows, created and filled by the first call. */
function pondWithDucks(): Pond {
  const pond = new Pond()
  const answer = pond.receive(call({ creating: gridID }, [ducks()]))
  assert.equal(answer.handlesByVerb.get(2), gridHandle, "the grid's CreateControl, the call's second verb, gets O38")
  assert.equal(pond.grid(gridID)?.columns.length, 3)
  assert.deepEqual(pond.grid(gridID)?.rowNumbers, [1, 2, 3])
  return pond
}

describe("Issue #167: a grid filled again by a later call", () => {
  /** a later call that names the grid by its handle's number, or by the handle, draws its last filling (bug #167) */
  for (const shell of ["38", "O38"]) {
    test(`refilledByLaterCall(${shell})`, () => {
      const pond = pondWithDucks()
      pond.receive(call({ naming: shell }, [ducks(), fewerDucks()]))
      const grid = pond.grid(gridID)
      assert.ok(grid !== undefined)
      assert.equal(grid.title, InventedControlScene.gridTitle)
      assert.deepEqual(
        grid.columns.map(column => column.id),
        ["DUCK", "MOOD"],
        "the second call's last catalog, a column fewer"
      )
      assert.deepEqual(grid.rowNumbers, [1])
      assert.ok(grid.text(1, 1) === "Mallard Mel" && grid.text(1, 2) === "smug")
      assert.equal(grid.text(1, 3), "", "no cell of the first call's filling stays behind")
    })
  }

  /** a grid created in between keeps its own filling: the handle names the first (bug #167) */
  test("anotherGridInBetween", () => {
    const pond = pondWithDucks()
    pond.receive(call({ creating: 116 }, [ducks()]))
    pond.receive(call({ naming: `${gridHandle}` }, [fewerDucks()]))
    assert.deepEqual(
      pond.grid(gridID)?.columns.map(column => column.id),
      ["DUCK", "MOOD"]
    )
    assert.deepEqual(
      pond.grid(116)?.columns.map(column => column.id),
      ["DUCK", "MOOD", "QUACKS"]
    )
    assert.deepEqual(pond.grid(116)?.rowNumbers, [1, 2, 3])
  })

  /** a number that is no shell's handle fills no grid (bug #167) */
  for (const shell of ["37", "39", "O", "Quack"]) {
    test(`noShellsHandle(${shell})`, () => {
      const pond = pondWithDucks()
      pond.receive(call({ naming: shell }, [fewerDucks()]))
      assert.equal(pond.grid(gridID)?.columns.length, 3)
      assert.deepEqual(pond.grid(gridID)?.rowNumbers, [1, 2, 3])
    })
  }

  /** a shell created again under the same id no longer answers to the old handle (bug #167) */
  test("createdAgain", () => {
    const pond = pondWithDucks()
    pond.receive(call({ creating: gridID }, [ducks()]))
    pond.receive(call({ naming: `${gridHandle}` }, [fewerDucks()]))
    assert.equal(pond.grid(gridID)?.columns.length, 3, "O38 named the grid the second call replaced")
  })
})
