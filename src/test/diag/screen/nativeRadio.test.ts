// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/NativeRadioTests.swift (MIT).

// source: fake — invented radio captions and coordinates, PV-1027 structure.
//
// Swift's `Bug0148Tests.readableQuestion()` is rebuilt below.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  DyntAtomEncoder,
  DyntAtoms,
  DyntAttributes,
  DyntDialogFlags,
  DyntElementType,
  InputEnvelope,
  InputFocus,
  SESValue
} from "../../../diag/codec/index.js"
import {
  FieldEdits,
  FunctionReadings,
  FunctionTrigger,
  MultipleLogonQuestion,
  MultipleLogonQuestionOption,
  ScreenInputError,
  type Screen
} from "../../../diag/screen/index.js"
import { ElementAtoms, ElementItems, atomValue } from "../../support/elementScreenBuilder.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Three numeric radios of block 9, group 1; with `question`, the logon program's popup with the multiple-logon field names. */
function nativeScreen(options: { protected?: boolean; password?: boolean; question?: boolean } = {}): Screen {
  const items = new ElementItems()
  if (options.question === true) {
    items.text(ApplItem.stSystemInfo("dynproName"), "SAPMSYST")
    items.text(ApplItem.stSystemInfo("dynproNumber"), "0500")
    items.ses(new SESValue({ modalNumber: 1, xPos: 2, yPos: 2, dimRow: 16, dimCol: 70 }))
  }
  const atoms = new ElementAtoms()
  for (let index = 0; index < 3; index++) {
    const caption = utf8(`ZZ Choice ${index}   `)
    const body = Uint8Array.from([index === 2 ? 1 : 0, 0, caption.length, 0, 0, 0, 0, 0, 0, caption.length, ...caption])
    const attributes = options.password === true ? DyntAttributes.invisible : options.protected === true ? DyntAttributes.protected : 0
    DyntAtomEncoder.appendAtom(
      ElementAtoms.header(DyntElementType.of("radiobutton3"), { block: 9, group: 1, row: 3 + index * 2, col: 2, attributes }),
      body,
      atoms.writer
    )
    if (options.question === true) {
      DyntAtomEncoder.appendText(
        ElementAtoms.header(DyntElementType.of("fname"), { block: 9, group: 1, row: 3 + index * 2, col: 2 }),
        utf8(`MULTI_LOGON_OPT${index + 1}`),
        atoms.writer
      )
    }
  }
  items.atoms(atoms)
  return items.screen()
}

/**
 * The question as a popup of the logon program with three radio buttons whose states are read, the
 * first selected. (Swift `Bug0148Tests.readableQuestion()`.)
 */
function readableQuestion(): Screen {
  const items = new ElementItems()
  items.text(ApplItem.stSystemInfo("dynproName"), "SAPMSYST")
  items.text(ApplItem.stSystemInfo("dynproNumber"), "4250")
  items.ses(new SESValue({ modalNumber: 1, xPos: 2, yPos: 2, dimRow: 16, dimCol: 70 }))
  const atoms = new ElementAtoms()
  atoms.field(DyntElementType.of("ofield2"), { row: 1, col: 2, attributes: DyntAttributes.protected, mlen: 40 }, "Duck MALLARD paddles here already.")
  MultipleLogonQuestionOption.allCases.forEach((option, index) => {
    atoms.radio({ block: 21, row: 3 + 2 * index, col: 2, selected: index === 0, fname: MultipleLogonQuestionOption.fieldName(option) }, `Choice ${index + 1}`)
  })
  items.atoms(atoms)
  return items.screen()
}

describe("Native numeric radios", () => {
  /** The numeric selection is read and only the two changed buttons return (bugs #148, #149) */
  test("changedButtons", () => {
    const screen = nativeScreen()
    const buttons = screen.elements.filter(element => element.kind.kind === "radioButton")
    assert.deepEqual(
      buttons.map(button => button.isChecked),
      [false, false, true]
    )
    assert.deepEqual(
      buttons.map(button => button.text),
      ["ZZ Choice 0", "ZZ Choice 1", "ZZ Choice 2"]
    )
    assert.deepEqual(screen.radioGroups[0]?.selected, buttons[2].id)
    const edits = new FieldEdits()
    edits.select(buttons[1].id)
    const step = screen.inputStep(edits, FunctionTrigger.enter)
    assert.equal(step.fieldCount, 2)
    const value = atomValue(step)
    assert.ok(value !== undefined, "the step has a DYNT_ATOM item")
    const atoms = DyntAtoms.walk(value).atoms
    assert.deepEqual(
      atoms.map(atom => atom.row),
      [5, 7]
    )
    assert.ok(atoms.every(atom => atom.etype.kind === "radiobutton0" && atom.block === 9 && atom.group === 1 && atom.col === 2))
    for (const atom of atoms) assert.deepEqual(atom.dialogFlags, new DyntDialogFlags({ flag1: 0, flag2: 0 }))
    assert.deepEqual(Array.from(atoms[0].contentRange.of(value)), [1, ...utf8("ZZ Choice 1   ")])
    assert.deepEqual(Array.from(atoms[1].contentRange.of(value)), [0, ...utf8("ZZ Choice 2   ")])
    const unchanged = new FieldEdits()
    unchanged.select(buttons[2].id)
    assert.equal(screen.inputStep(unchanged, FunctionTrigger.enter).fieldCount, 0)
  })

  /** Native multiple-logon confirmation sends the observed dynpro Enter event (bug #148) */
  test("confirmationEvent", () => {
    const screen = nativeScreen({ question: true })
    assert.ok(MultipleLogonQuestion.of(screen) !== undefined)
    const expected = [8, 0, 7, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    for (const trigger of [FunctionTrigger.enter, FunctionTrigger.virtualKey(0), FunctionTrigger.okCode("")]) {
      const step = screen.inputStep(new FieldEdits(), trigger, { readings: new FunctionReadings({ envelope: InputEnvelope.chlStage }) })
      assert.deepEqual(Array.from(step.uiEvent ?? []), expected)
      assert.equal(step.functionCode, undefined)
      assert.deepEqual(step.focus, new InputFocus(7, 2))
      assert.ok(InputEnvelope.contains(step.envelope, InputEnvelope.focus))
    }
    const changed = new FieldEdits()
    const continueLogon = MultipleLogonQuestion.of(screen)?.buttons.get("continueLogon")
    assert.ok(continueLogon !== undefined)
    changed.select(continueLogon)
    assert.deepEqual(screen.inputStep(changed, FunctionTrigger.enter).focus, new InputFocus(5, 2))
    assert.equal(nativeScreen().inputStep(new FieldEdits(), FunctionTrigger.enter).uiEvent, undefined)
    assert.equal(readableQuestion().inputStep(new FieldEdits(), FunctionTrigger.enter).uiEvent, undefined)
    const refused = new FunctionReadings()
    refused.functionKey = "refused"
    assert.throws(() => screen.inputStep(new FieldEdits(), FunctionTrigger.enter, { readings: refused }), ScreenInputError)
  })

  /** Protected radios stay read-only and invisible captions are never retained (bug #148) */
  test("boundaries", () => {
    const screen = nativeScreen({ protected: true })
    const edits = new FieldEdits()
    const first = screen.elements[0]
    assert.ok(first !== undefined)
    edits.select(first.id)
    assert.throws(() => screen.inputStep(edits, FunctionTrigger.enter), ScreenInputError)
    assert.ok(nativeScreen({ password: true }).elements.every(element => element.nativeRadioCaption === undefined && element.text === undefined))
  })
})
