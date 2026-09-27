// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/AutomationRecordsTests.swift (MIT).

// The automation-stream records as Swooey's answer reads them (docs/protocol/controls/rfc-tr.md
// §7.2–§7.4, §7.8): a verb's name and flag, a descriptor's role, group and pointer (Reading
// R-CT-32's lenient reading of rows outside the four-column layout), a value record's kind
// (R-CT-33), the result of each verb (R-CT-34) and the handle counter. Values are invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  AutomationDescriptor,
  AutomationRecordLayout,
  AutomationResult,
  AutomationValueKind,
  AutomationVerb,
  AutomationVerbFlag,
  ControlHandleCounter
} from "../../../diag/codec/index.js"
import { ascii } from "../../support/codecTestSupport.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"

describe("Automation records: verbs, descriptors, value kinds, results and handles", () => {
  /** A verb record: the name without trailing spaces, the flag C, S, G or another byte (PV-0922, PV-0923). */
  test("verbs", () => {
    const create = AutomationVerb.decode(InventedFlushCall.verb(1, "CreateObject", "C"))
    assert.deepEqual(create.name, ascii("CreateObject"))
    assert.deepEqual(create.flag, AutomationVerbFlag.call)
    assert.deepEqual(AutomationVerb.decode(InventedFlushCall.verb(12, "SetPaddleSpeed", "S")).flag, AutomationVerbFlag.set)
    assert.deepEqual(AutomationVerb.decode(InventedFlushCall.verb(123_456_789, "GetPuddleDepth", "G")).flag, AutomationVerbFlag.get)
    const odd = AutomationVerb.decode(InventedFlushCall.verb(2, "", "Q"))
    assert.equal(odd.name.length, 0)
    assert.deepEqual(odd.flag, AutomationVerbFlag.unknown(0x51))
    assert.ok(AutomationRecordLayout.verbWidth === 53 && InventedFlushCall.verb(1, "X", "C").length === 53)
  })

  /** A descriptor row: #N is an input, _RESULT a result slot, in four columns; any other row reads its first and last token. */
  test("descriptors", () => {
    const read = (text: string) => AutomationDescriptor.decode(InventedFlushCall.descriptor(text))
    assert.deepEqual(read("1 12 #1 2"), new AutomationDescriptor("input", 1, 2))
    assert.deepEqual(read("  17   12   _RESULT   54"), new AutomationDescriptor("result", 17, 54))
    assert.deepEqual(read("49 9 #1 93"), new AutomationDescriptor("input", 49, 93), "type 9 (PV-0955)")
    assert.deepEqual(read("3 12 ZZ_QUACK_VOLUME 0 7"), new AutomationDescriptor("other", 3, 7), "five tokens: outside the layout")
    assert.deepEqual(read("5 12 ZZ_DEPTH 9"), new AutomationDescriptor("other", 5, 9), "a name that is no #N or _RESULT")
    assert.equal(read("1 12 _RESULTS 3").role, "other")
    assert.equal(read("1 12 # 3").role, "other", "a # without a number")
    assert.equal(read("1 1x #1 3").role, "other", "a type that is no number")
    assert.deepEqual(read("ZZ 12 ZZ_DEPTH 9"), new AutomationDescriptor("other", undefined, 9))
    assert.deepEqual(read("7 12 ZZ_DEPTH ZZ"), new AutomationDescriptor("other", 7, undefined))
    assert.deepEqual(read("42"), new AutomationDescriptor("other", 42, undefined), "one token: a group, no pointer")
    assert.deepEqual(read(""), new AutomationDescriptor("other", undefined, undefined), "a blank row")
    assert.equal(read("1234567890 12 #1 2").group, undefined, "ten digits are no number Swooey uses")
    const tabbed = InventedFlushCall.descriptor("2 3 #1 4")
    tabbed[1] = 0x09
    assert.deepEqual(AutomationDescriptor.decode(tabbed), new AutomationDescriptor("input", 2, 4), "a tab separates too")
  })

  /** A value record: a name makes an output, the nine zeros and a printable byte a reference, anything else an input (R-CT-33). */
  test("valueKinds", () => {
    const kind = (name: string, value: string) => AutomationValueKind.of(InventedFlushCall.value(name, value))
    assert.equal(kind("_RESULT", "000000000"), "output")
    assert.equal(kind("ZZ_PUDDLE_DEPTHS1", "000000000 12"), "output", "any name, also with a value")
    assert.equal(kind("", "000000000O17"), "reference", "a handle")
    assert.equal(kind("", "000000000DPC"), "reference", "a three-character object")
    assert.equal(kind("", "000000000 7"), "input", "a value after a space")
    assert.equal(kind("", "000000000"), "input", "nothing after the zeros")
    assert.equal(kind("", "00000000O1"), "input", "eight zeros")
    assert.equal(kind("", ""), "input")
    const control = InventedFlushCall.value("", "000000000X")
    control[41] = 0x7f
    assert.equal(AutomationValueKind.of(control), "input", "DEL is not printable")
  })

  /** Results by verb (R-CT-34): handles, 0, 1, empty, 0 for other methods, nothing for S verbs. */
  test("results", () => {
    const result = (name: string, flag: AutomationVerbFlag) => AutomationResult.of(new AutomationVerb(ascii(name), flag))
    for (const name of ["CreateObject", "CreateControl", "CreateControl2", "GetGuiServices", "GetServiceByName", "GetDataAsFormat", "GetTable"])
      assert.deepEqual(result(name, AutomationVerbFlag.call), AutomationResult.newHandle, name)
    for (const name of ["Structures", "Level", "Image"])
      assert.deepEqual(result(name, AutomationVerbFlag.get), AutomationResult.newHandle, `${name}: a G verb seen returning a handle`)
    assert.deepEqual(
      result("GetPuddleDepth", AutomationVerbFlag.get),
      AutomationResult.integer(0),
      "a G verb not seen, its record at the zeros: an integer receiver (#151)"
    )
    assert.deepEqual(
      AutomationResult.of(new AutomationVerb(ascii("GetPuddleDepth"), AutomationVerbFlag.get), true),
      AutomationResult.newHandle,
      "a G verb not seen, its record pre-filled: an object receiver"
    )
    const decided = AutomationResult.decide(new AutomationVerb(ascii("PaddleInCircles"), AutomationVerbFlag.call), true)
    assert.ok(decided !== undefined && decided.result.kind === "newHandle" && decided.basis === "record", "a C verb not seen, its record pre-filled")
    assert.equal(AutomationResult.decide(new AutomationVerb(ascii("GetTable"), AutomationVerbFlag.call), false)?.basis, "name")
    for (const name of ["AddControl", "SetGrid", "SetColumnWidth", "PublishUrl"])
      assert.deepEqual(result(name, AutomationVerbFlag.call), AutomationResult.integer(0), name)
    assert.deepEqual(result("GetContainer", AutomationVerbFlag.call), AutomationResult.integer(1))
    assert.deepEqual(result("GetGuiFeatures", AutomationVerbFlag.call), AutomationResult.integer(1))
    assert.deepEqual(result("GetRegValueEx", AutomationVerbFlag.call), AutomationResult.empty)
    assert.deepEqual(result("PaddleInCircles", AutomationVerbFlag.call), AutomationResult.integer(0), "Swooey's default for another method")
    assert.deepEqual(result("FreeObject", AutomationVerbFlag.call), AutomationResult.integer(0))
    assert.equal(result("SetPaddleSpeed", AutomationVerbFlag.set), undefined)
    assert.equal(result("Level", AutomationVerbFlag.unknown(0x51)), undefined)
  })

  /** Handles: O1 first, one counter that only grows (R-CT-34, PV-0939). */
  test("counter", () => {
    assert.equal(new ControlHandleCounter().next, 1)
    assert.equal(new ControlHandleCounter(5_969).next, 5_969)
    assert.equal(new ControlHandleCounter(0).next, 1, "the counter never starts below 1")
  })
})
