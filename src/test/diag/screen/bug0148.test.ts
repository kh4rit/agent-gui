// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0148Tests.swift (MIT).

// Issue #148: the logon gate took the multiple-logon question (PV-0742, PV-0743) for a screen it
// does not handle. It is recognised by structure, never by text (docs/credentials.md §4 rule 3): the
// logon program, a popup, and one radio group with one button for each of the field names
// MULTI_LOGON_OPT1 to MULTI_LOGON_OPT3.
//
// The paddling question (duck-pond-paddling), the pond rules question (duck-pond-pond-rules) and the
// gate come from the real fake server over TCP (src/test/support/screenSession.ts), and those tests
// skip without it. Swift's `var copy = screen` that is then changed is `screen.clone()`; the clone
// shares its elements, so the element renamed in `notRecognised` is cloned before it is changed.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, DyntAttributes, DyntElementType, DyntToggle, DyntToggleReturn, SESValue, type ClientInputStep } from "../../../diag/codec/index.js"
import {
  FieldEdits,
  FunctionTrigger,
  MultipleLogonQuestion,
  MultipleLogonQuestionOption,
  Screen,
  ScreenElementKind,
  ScreenPresentation,
  ScreenReadings
} from "../../../diag/screen/index.js"
import { ElementAtoms, ElementItems } from "../../support/elementScreenBuilder.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/** Swift `Bug0147Tests.paddleQuestion`: the paddling question, the gate again as the main window, the question as a popup. */
async function paddleQuestion(readings: ScreenReadings = new ScreenReadings()): Promise<Screen> {
  return Screen.fromItems(await Fixtures.items("paddle-question", "duck-pond-paddling"), { readings })
}

/** Swift `Bug0149Tests.returnedToggles`: the toggles a step returns, in screen order: row, state and whether dlg_flag_2 0x80 is set. */
function returnedToggles(step: ClientInputStep): { row: number; isChecked: boolean; selectedFlag: boolean }[] {
  const { atoms, value } = Fixtures.returnedAtoms(step)
  const toggles: { row: number; isChecked: boolean; selectedFlag: boolean }[] = []
  for (const atom of atoms) {
    const toggle = DyntToggleReturn.fromAtom(atom, value)
    assert.ok(toggle !== undefined, "a toggle's return")
    toggles.push({ row: atom.row, isChecked: toggle?.isChecked ?? false, selectedFlag: (atom.dialogFlags.flag2 & DyntToggle.selectedRadioFlag) !== 0 })
  }
  return toggles
}

/** The suite's static members (Swift `Self.readableQuestion`). */
const Self = {
  /**
   * The question as a popup of the logon program with three radio buttons whose states are read,
   * the first selected.
   */
  readableQuestion(): Screen {
    const items = new ElementItems()
    items.text(ApplItem.stSystemInfo("dynproName"), "SAPMSYST")
    items.text(ApplItem.stSystemInfo("dynproNumber"), "4250")
    items.ses(new SESValue({ modalNumber: 1, xPos: 2, yPos: 2, dimRow: 16, dimCol: 70 }))
    const atoms = new ElementAtoms()
    atoms.field(DyntElementType.of("ofield2"), { row: 1, col: 2, attributes: DyntAttributes.protected, mlen: 40 }, "Duck MALLARD paddles here already.")
    MultipleLogonQuestionOption.allCases.forEach((option, index) => {
      atoms.radio(
        { block: 21, row: 3 + 2 * index, col: 2, selected: index === 0, fname: MultipleLogonQuestionOption.fieldName(option) },
        `Choice ${index + 1}`
      )
    })
    items.atoms(atoms)
    return items.screen()
  }
}

describe("The multiple-logon question, recognised by structure", () => {
  /** the paddling question: the logon program's popup with the three radio buttons (bug #148) */
  test("recognised", { skip: skipWithoutFakeServer }, async () => {
    const screen = await paddleQuestion()
    const question = MultipleLogonQuestion.of(screen)
    assert.ok(question !== undefined)
    assert.equal(question.buttons.size, 3)
    assert.equal(question.selected, undefined, "the buttons' states were not read (unread-body, #107): what is selected is unknown")
    assert.equal(question.information, "Duck MALLARD is already paddling in this pond (at the reeds, since 06:42).")
    for (const option of MultipleLogonQuestionOption.allCases) {
      const id = question.buttons.get(option)
      assert.ok(id !== undefined)
      assert.equal(screen.element(id)?.fieldName, MultipleLogonQuestionOption.fieldName(option))
      assert.deepEqual(screen.element(id)?.kind, ScreenElementKind.radioButton)
    }
    assert.deepEqual(
      MultipleLogonQuestionOption.allCases.map(option => MultipleLogonQuestionOption.fieldName(option)),
      ["MULTI_LOGON_OPT1", "MULTI_LOGON_OPT2", "MULTI_LOGON_OPT3"]
    )
  })

  /** not the question: another popup of the logon program, the gate, its main window, a main screen, another program, a button missing (bug #148) */
  test("notRecognised", { skip: skipWithoutFakeServer }, async () => {
    const rules = Screen.fromItems(await Fixtures.items("pond-rules-question", "duck-pond-pond-rules"))
    assert.equal(MultipleLogonQuestion.of(rules), undefined, "a logon-program popup with other radio buttons")
    assert.equal(MultipleLogonQuestion.of(Screen.fromItems(await Fixtures.items("pond-gate"))), undefined)
    const screen = await paddleQuestion()
    const mainWindow = screen.mainWindowScreen
    assert.ok(mainWindow !== undefined)
    assert.equal(MultipleLogonQuestion.of(mainWindow), undefined, "the main window under it")

    const main = screen.clone()
    main.presentation = ScreenPresentation.main
    assert.equal(MultipleLogonQuestion.of(main), undefined, "the question is a popup")

    const other = screen.clone()
    other.identity.program = "ZZ_POND_PADDLES"
    other.isLogonScreen = false
    assert.equal(MultipleLogonQuestion.of(other), undefined, "only the logon program asks it")

    const renamed = screen.clone()
    const third = renamed.elements.findIndex(element => element.fieldName === "MULTI_LOGON_OPT3")
    assert.ok(third >= 0)
    // Swift changes the copy's own element (a struct); the clone shares the element objects.
    const element = renamed.elements[third].clone()
    element.fieldName = "ZZPADDLE-OPT3"
    renamed.elements[third] = element
    assert.equal(MultipleLogonQuestion.of(renamed), undefined, "all three buttons")
  })

  /** with read states: the selected button is known, and a choice returns it with the one it replaces (R-EL-4) (bug #148) */
  test("readableStates", () => {
    const screen = Self.readableQuestion()
    const question = MultipleLogonQuestion.of(screen)
    assert.ok(question !== undefined)
    assert.equal(question.selected, "endOtherLogons")
    assert.equal(question.information, "Duck MALLARD paddles here already.")
    const edits = new FieldEdits()
    const chosen = question.buttons.get("continueLogon")
    assert.ok(chosen !== undefined)
    edits.select(chosen)
    const step = screen.inputStep(edits, FunctionTrigger.enter)
    const returned = returnedToggles(step)
    assert.deepEqual(
      returned.map(toggle => toggle.row),
      [3, 5],
      "the chosen one and the one it replaces"
    )
    assert.deepEqual(
      returned.map(toggle => toggle.isChecked),
      [false, true]
    )
  })
})
