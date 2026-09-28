// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/FrontendTableRegistryTests.swift (MIT).

// source: fake — invented controls, handles and node keys.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ControlCall,
  ControlHandleCounter,
  FlushCallAnswerBuilder,
  FrontendTableRegistry,
  FrontendTableRegistryProblem,
  FrontendTableRequest,
  type FrontendTableExpandedTrees
} from "../../../diag/codec/index.js"
import { ascii, throwsInfo } from "../../support/codecTestSupport.js"
import { frontendTableRequest } from "../../support/frontendTableSupport.js"
import { InventedControlSceneRecorder as Recorder } from "../../support/inventedControlScene.js"
import { InventedField } from "../../support/inventedDataObject.js"
import { InventedFlushCall as Call } from "../../support/inventedFlushCall.js"

/** The export call (Swift `static func exportCall(url:source:property:)`). */
function exportCall(options: { url?: string; source?: string; property?: string } = {}): Call {
  const url = options.url ?? "sapr3://ZZ_DUCK_EXPORT"
  const property = options.property ?? "ExpandedKeys"
  const recorder = new Recorder()
  const root = recorder.record("", "O99")
  const tree = recorder.verb("CreateControl", "C", root, [
    [3, "501"],
    [12, "ZZ_DUCK_TREE"]
  ], "DPC")!
  const provider = recorder.verb("CreateObject", "C", root, [[12, "ZZ_DataProvider"]], "DPC")!
  const formats = recorder.verb("formats", "G", provider, [], "DPC")!
  const format = recorder.verb("Force", "C", formats, [
    [12, "APPLICATION"],
    [12, "X-R3TABLE"]
  ], "DPC")!
  recorder.verb("AssignProperty2", "C", root, [
    [9, options.source ?? `O${tree}-`],
    [12, property],
    [9, `O${format}-`],
    [12, "data"]
  ])
  recorder.verb("FreeObject", "C", root, [[9, `O${formats}-`]])
  recorder.verb("FreeObject", "C", root, [[9, `O${format}-`]])
  recorder.verb("SaveDataToUrl", "C", provider, [
    [12, ""],
    [12, ""],
    [12, url]
  ], "")
  recorder.verb("FreeObject", "C", root, [[9, `O${provider}-`]])
  return new Call({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs })
}

/** Applies `call` to `registry` with the handles of Swooey's answer (Swift `static func apply`). */
function apply(call: Call, registry: FrontendTableRegistry, trees: FrontendTableExpandedTrees): Map<number, string> {
  const built = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter())
  return registry.apply(ControlCall.read(call.bytes), built.summary.handlesByVerb, trees)
}

const trees = (entries: [number, string[]][]): FrontendTableExpandedTrees => new Map(entries.map(([id, keys]) => [id, new Set(keys)]))

describe("Frontend provider registrations contain actual control state (bug #192)", () => {
  /** saved rows follow the resolved tree; helper release retains the registration until retrieval */
  test("rows", () => {
    const registry = new FrontendTableRegistry()
    const urls = apply(
      exportCall(),
      registry,
      trees([
        [501, ["ZZ_ROOT", "ZZ_BRANCH"]],
        [502, ["ZZ_OTHER"]]
      ])
    )
    assert.deepEqual(urls, new Map([[8, "sapr3://ZZ_DUCK_EXPORT"]]))
    const request = FrontendTableRequest.read(frontendTableRequest())
    const table = registry.table(request)
    assert.deepEqual(table.rows, [ascii("ZZ_BRANCH   "), ascii("ZZ_ROOT     ")])
    assert.equal(table.rowWidth, 12)
    assert.equal(registry.tableCount, 1)
    assert.ok(!inspect(registry).includes("ZZ_DUCK"))
    registry.consumed(request.url)
    throwsInfo(() => registry.table(request), FrontendTableRegistryProblem, { kind: "unknownURL" })
  })

  /** missing state differs from an explicitly empty expansion set */
  test("missingState", () => {
    const missing = new FrontendTableRegistry()
    throwsInfo(() => apply(exportCall(), missing, trees([])), FrontendTableRegistryProblem, { kind: "missingSnapshot" })
    const empty = new FrontendTableRegistry()
    apply(exportCall(), empty, trees([[501, []]]))
    const request = FrontendTableRequest.read(frontendTableRequest())
    assert.equal(empty.table(request).rows.length, 0)
    const otherMode = new FrontendTableRegistry()
    throwsInfo(() => otherMode.table(request), FrontendTableRegistryProblem, { kind: "unknownURL" })
  })

  /** unknown targets, forward properties, nonlocal URLs and invalid keys are refused */
  test("refused", () => {
    for (const call of [exportCall({ source: "O777" }), exportCall({ property: "ExpandedKeys2" })]) {
      throwsInfo(() => apply(call, new FrontendTableRegistry(), trees([[501, []]])), FrontendTableRegistryProblem, { kind: "missingBinding" })
    }
    for (const url of ["", "https://example.invalid/ZZ_DUCK", "file:///ZZ_DUCK"]) {
      throwsInfo(() => apply(exportCall({ url }), new FrontendTableRegistry(), trees([[501, []]])), FrontendTableRegistryProblem, {
        kind: "unsupportedURL"
      })
    }
    for (const key of ["", "ZZ_TOO_LONG_FOR_A_NODE_KEY", "ZZ_\u{1F986}"]) {
      throwsInfo(() => apply(exportCall(), new FrontendTableRegistry(), trees([[501, [key]]])), FrontendTableRegistryProblem, { kind: "nodeKey" })
    }
  })

  /** a mismatched schema cannot consume the saved table */
  test("mismatch", () => {
    const registry = new FrontendTableRegistry()
    apply(exportCall(), registry, trees([[501, ["ZZ_ROOT"]]]))
    const wrong = FrontendTableRequest.read(frontendTableRequest({ fields: [InventedField.text(16)] }))
    throwsInfo(() => registry.table(wrong), FrontendTableRegistryProblem, { kind: "schema" })
    assert.equal(registry.tableCount, 1)
  })
})
