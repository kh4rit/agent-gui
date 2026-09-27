// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0149Tests.swift (MIT).

// Issue #149: the owner could not choose any of the multiple-logon question's radio buttons: Swooey
// drew them greyed (PV-0988), which it does for a radio button whose state Reading R-EL-1 did not
// read (#107). Such a button now belongs to its group (Reading R-EL-2), whose selection is then
// unknown, and can be chosen: the chosen one goes back selected and the group's others deselected,
// since any of them may be the one it replaces (Reading R-EL-4). The fake server's `unread-body`
// radio buttons have such a body (D15).
//
// The paddling question (duck-pond-paddling) comes from the real fake server over TCP
// (src/test/support/screenSession.ts), and the tests skip without it.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DyntToggle, DyntToggleReturn, ElementValueReading, type ClientInputStep } from "../../../diag/codec/index.js"
import { FieldEdits, FunctionReadings, FunctionTrigger, Screen, ScreenInputError, ScreenReadings } from "../../../diag/screen/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/** Swift `Bug0147Tests.paddleQuestion`: the paddling question, the gate again as the main window, the question as a popup. */
async function paddleQuestion(readings: ScreenReadings = new ScreenReadings()): Promise<Screen> {
  return Screen.fromItems(await Fixtures.items("paddle-question", "duck-pond-paddling"), { readings })
}

/** The suite's static members (Swift `Self.returnedToggles`). */
const Self = {
  /** The toggles a step returns, in screen order: row, state and whether dlg_flag_2 0x80 is set. */
  returnedToggles(step: ClientInputStep): { row: number; isChecked: boolean; selectedFlag: boolean }[] {
    const { atoms, value } = Fixtures.returnedAtoms(step)
    const toggles: { row: number; isChecked: boolean; selectedFlag: boolean }[] = []
    for (const atom of atoms) {
      const toggle = DyntToggleReturn.fromAtom(atom, value)
      assert.ok(toggle !== undefined, "a toggle's return")
      toggles.push({ row: atom.row, isChecked: toggle?.isChecked ?? false, selectedFlag: (atom.dialogFlags.flag2 & DyntToggle.selectedRadioFlag) !== 0 })
    }
    return toggles
  }
}

describe("Radio buttons whose state was not read can be chosen", () => {
  /** the question's buttons are one group with no known selection; choosing one returns the whole group (bug #149) */
  test("unreadGroup", { skip: skipWithoutFakeServer }, async () => {
    const screen = await paddleQuestion()
    const buttons = screen.elements.filter(element => element.kind.kind === "radioButton")
    assert.ok(buttons.length === 3 && buttons.every(button => button.isChecked === undefined), "unread bodies")
    assert.ok(
      buttons.every(button => button.width === 60),
      "the visible length still read"
    )
    const group = screen.radioGroups[0]
    assert.ok(group !== undefined)
    assert.ok(screen.radioGroups.length === 1 && group.members.length === 3 && group.selected === undefined)
    const edits = new FieldEdits()
    edits.select(buttons[1].id)
    const returned = Self.returnedToggles(screen.inputStep(edits, FunctionTrigger.enter))
    assert.deepEqual(
      returned.map(toggle => toggle.row),
      [4, 7, 11]
    )
    assert.deepEqual(
      returned.map(toggle => toggle.isChecked),
      [false, true, false]
    )
    assert.deepEqual(
      returned.map(toggle => toggle.selectedFlag),
      [false, true, false]
    )
  })

  /** under the Reading that returns the selected button only, only the chosen one goes back (bug #149) */
  test("selectedOnly", { skip: skipWithoutFakeServer }, async () => {
    const screen = await paddleQuestion()
    const buttons = screen.elements.filter(element => element.kind.kind === "radioButton")
    const edits = new FieldEdits()
    edits.select(buttons[2].id)
    const readings = new FunctionReadings()
    // Swift `readings.elementValues.radios = .selectedOnly`: ElementValueReading's fields are readonly here.
    readings.elementValues = new ElementValueReading({ ...readings.elementValues, radios: "selectedOnly" })
    const returned = Self.returnedToggles(screen.inputStep(edits, FunctionTrigger.enter, { readings }))
    assert.deepEqual(
      returned.map(toggle => toggle.row),
      [11]
    )
    assert.deepEqual(
      returned.map(toggle => toggle.isChecked),
      [true]
    )
  })

  /** with every body left opaque (the fallback Reading), a radio button is still not guessed */
  test("opaqueFallback", { skip: skipWithoutFakeServer }, async () => {
    const readings = new ScreenReadings()
    readings.checkbox = "specGap"
    const screen = Screen.fromItems(await Fixtures.items("paddle-question", "duck-pond-paddling"), { readings })
    assert.equal(screen.radioGroups.length, 0)
    const edits = new FieldEdits()
    const button = screen.elements.find(element => element.kind.kind === "radioButton")
    assert.ok(button !== undefined)
    edits.select(button.id)
    assert.throws(() => screen.inputStep(edits, FunctionTrigger.enter), ScreenInputError)
  })
})
