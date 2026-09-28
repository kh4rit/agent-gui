// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0190Tests.swift (MIT).

// source: fake — two pond trees and a later call naming one by its returned handle.
//
// Swift's `Bug0167Tests.Pond` is rebuilt below.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlCall, ControlHandleCounter, FlushCallAnswerBuilder, type FlushAnswerSummary } from "../../../diag/codec/index.js"
import { ControlScene, type TreeModel } from "../../../diag/screen/index.js"
import { InventedControlScene, InventedControlSceneRecorder as Recorder } from "../../support/inventedControlScene.js"
import { InventedFlushCall as Call, InventedFlushCallTable } from "../../support/inventedFlushCall.js"

/**
 * A mode's calls as the session handles them: each answered by Swooey's answer builder with the
 * connection's one counter, then applied to the scene with the handles its answer returned.
 * (Swift `Bug0167Tests.Pond`.)
 */
class Pond {
  counter = new ControlHandleCounter(37)
  scene = new ControlScene()

  receive(call: Call): FlushAnswerSummary {
    const bytes = call.bytes
    const answer = FlushCallAnswerBuilder.answer(bytes, this.counter)
    this.counter = answer.handles
    this.scene.apply(ControlCall.read(bytes), answer.summary.handlesByVerb)
    return answer.summary
  }

  tree(id: number): TreeModel | undefined {
    const content = this.scene.shells.get(id)?.content
    return content?.kind === "tree" ? content.value : undefined
  }
}

function create(id: number): Call {
  const recorder = new Recorder()
  recorder.verb("CreateControl", "C", 1, [
    [3, `${id}`],
    [12, InventedControlScene.treeClass],
    [3, "0"],
    [3, "10"]
  ], "")
  return new Call({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs })
}

function fill(handle: string): Call {
  const recorder = new Recorder()
  const target = recorder.record("", handle)
  for (const [object, method] of [
    [InventedControlScene.nodes, "AddR3Table"],
    [InventedControlScene.items, "AddItemTable"]
  ] as const) {
    const provider = recorder.verb("CreateObject", "C", target, [[12, InventedControlScene.providerClass]], "O1-")!
    recorder.verb("SetDataFromUrl", "C", provider, [
      [12, "APPLICATION"],
      [12, "X-R3TABLE"],
      [12, object.url]
    ])
    const data = recorder.verb("GetDataAsFormat", "C", provider, [], "O1-")!
    recorder.verb(method, "C", target, [[9, `O${data}-`]])
  }
  recorder.verb("ABAPExpandNodes", "C", target, [[12, "Root"]])
  const call = new Call({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs })
  call.tables[2] = new InventedFlushCallTable("RFC_QUEUE", 1853, [InventedControlScene.nodes, InventedControlScene.items].flatMap(object => object.queueRows))
  return call
}

describe("Later method targets resolve persistent shell handles", () => {
  /** a later call fills and expands the addressed tree, leaving another tree alone (bug #190) */
  test("laterTarget", () => {
    const pond = new Pond()
    const first = pond.receive(create(501))
    const handle = first.handlesByVerb.get(1)
    assert.ok(handle !== undefined)
    pond.receive(create(502))
    pond.receive(fill(`O${handle}`))
    const tree = pond.tree(501)
    const other = pond.tree(502)
    assert.ok(tree !== undefined && other !== undefined, "missing invented trees")
    assert.equal(tree.nodes.length, 6)
    assert.ok(tree.expanded.has("Root"))
    assert.equal(tree.node("Root")?.text, "Pond Menu")
    assert.ok(other.nodes.length === 0 && other.expanded.size === 0)
  })

  /** a replaced shell's stale handle and an unknown handle address no tree (bug #190) */
  for (const stale of [false, true]) {
    test(`unknownHandle(${stale})`, () => {
      const pond = new Pond()
      const first = pond.receive(create(501))
      const handle = first.handlesByVerb.get(1)
      assert.ok(handle !== undefined)
      if (stale) pond.receive(create(501))
      pond.receive(fill(`O${stale ? handle : 999999}`))
      const tree = pond.tree(501)
      assert.ok(tree !== undefined, "missing tree")
      assert.ok(tree.nodes.length === 0 && tree.expanded.size === 0)
    })
  }

  /** a provider result in the current call takes precedence over matching old handle text (bug #190) */
  test("localMeaning", () => {
    const pond = new Pond()
    const first = pond.receive(create(501))
    const handle = first.handlesByVerb.get(1)
    assert.ok(handle !== undefined)
    const recorder = new Recorder()
    const provider = recorder.verb("CreateObject", "C", 1, [[12, InventedControlScene.providerClass]], `O${handle}`)!
    recorder.verb("ABAPExpandNodes", "C", provider, [[12, "Root"]])
    pond.receive(new Call({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs }))
    const tree = pond.tree(501)
    assert.ok(tree !== undefined, "missing tree")
    assert.equal(tree.expanded.size, 0)
  })
})
