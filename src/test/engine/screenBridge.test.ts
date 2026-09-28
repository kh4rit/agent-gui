// SPDX-License-Identifier: MIT
// Ported in part from Swooey Tests/SwooeyAppTests/Bug0148Tests.swift (MIT), `nativeSessionScope`:
// the corrected session state of the native multiple-logon confirmation (PV-1034) goes only with a
// decoded native question. Swooey also checks its fake server's question and gate; those screens
// are covered by agent-gui's end-to-end tests. And ListData's list cursor (issues #184, #186).
// source: fake: invented geometry and labels, the established numeric radio structure.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntElementType,
  InputEnvelope,
  SESValue,
  UIEventFunctionKey
} from "../../diag/codec/index.js"
import { FieldEdits, FunctionReadings, FunctionTrigger, MultipleLogonQuestion, Screen, ScreenPick } from "../../diag/screen/index.js"
import { ByteWriter } from "../../diag/wire/index.js"
import { ListData } from "../../engine/listData.js"
import { ScreenBridge } from "../../engine/screenBridge.js"

const utf8 = (text: string) => new TextEncoder().encode(text)

/** A popup of `program`, screen 0500, with three numeric radios named MULTI_LOGON_OPT1 to 3. */
function nativeQuestion(program: string): Screen {
  const items = new ByteWriter()
  const ses = new ByteWriter()
  new SESValue({ modalNumber: 1, dimRow: 19, dimCol: 61 }).append(ses)
  DiagItemEncoder.appendSimple("ses", ses.toBytes(), items)
  DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("dynproName"), utf8(program), items)
  DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("dynproNumber"), utf8("0500"), items)
  const atoms = new ByteWriter()
  for (let index = 0; index < 3; index++) {
    const caption = utf8(`ZZ Pond choice ${index}   `)
    const body = Uint8Array.from([index === 0 ? 1 : 0, 0, caption.length, 0, 0, 0, 0, 0, 0, caption.length, ...caption])
    DyntAtomEncoder.appendAtom(
      new DyntAtomHeader({ etype: DyntElementType.of("radiobutton3"), block: 3, group: 1, row: 2 + index * 3, col: 1 }),
      body,
      atoms
    )
    DyntAtomEncoder.appendText(
      new DyntAtomHeader({ etype: DyntElementType.of("fname"), block: 3, group: 1, row: 2 + index * 3, col: 1 }),
      utf8(`MULTI_LOGON_OPT${index + 1}`),
      atoms
    )
  }
  DiagItemEncoder.appendAPPL(ApplItem.dynt("atom"), atoms.toBytes(), items)
  return Screen.fromItems(items.toBytes())
}

describe("ScreenBridge: the native multiple-logon confirmation (#148)", () => {
  const readings = new FunctionReadings({ envelope: InputEnvelope.chlStage })

  test("the native SES correction is automatic only for a decoded native confirmation", () => {
    const native = nativeQuestion("SAPMSYST")
    assert.ok(MultipleLogonQuestion.of(native) !== undefined)
    const step = ScreenBridge.inputStep(native, new FieldEdits(), FunctionTrigger.enter, { readings })
    assert.ok(step.nativeLogonSession)
    assert.deepEqual(step.uiEvent, UIEventFunctionKey.multipleLogonEnter)

    const other = nativeQuestion("ZZ_POND")
    assert.equal(MultipleLogonQuestion.of(other), undefined)
    assert.ok(!ScreenBridge.inputStep(other, new FieldEdits(), FunctionTrigger.enter, { readings }).nativeLogonSession)
  })

  test("the chosen option goes out as a native radio with the focus on it", () => {
    const native = nativeQuestion("SAPMSYST")
    const question = MultipleLogonQuestion.of(native)!
    const edits = new FieldEdits()
    edits.select(question.buttons.get("continueLogon")!)
    const step = ScreenBridge.inputStep(native, edits, FunctionTrigger.enter, { readings })
    assert.ok(step.nativeLogonSession)
    const chosen = native.element(question.buttons.get("continueLogon")!)!
    assert.equal(step.focus?.row, chosen.atom.row)
    assert.equal(step.focus?.col, chosen.atom.col)
  })
})

describe("ListData: where a step puts the list cursor (#184, #186)", () => {
  test("no list, no cursor", () => {
    assert.equal(ListData.cursor(undefined), undefined)
  })

  test("a pick inside a hotspot keeps its column; otherwise the first hotspot's", () => {
    const line = {
      index: 1,
      row: 4,
      segments: [
        { column: 0, width: 5, text: "Pond ", isHotspot: false, isBox: false },
        { column: 10, width: 8, text: "ZZDUCK01", isHotspot: true, isBox: false }
      ]
    } as unknown as Parameters<typeof ListData.pick>[0]
    assert.deepEqual(ListData.pick(line, 12), ScreenPick.list(4, 12))
    assert.deepEqual(ListData.pick(line, 2), ScreenPick.list(4, 10))
    assert.deepEqual(ListData.pick(line), ScreenPick.list(4, 10))
  })
})
