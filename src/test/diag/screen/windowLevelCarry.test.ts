// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/WindowLevelCarryTests.swift (MIT).

// What a window level keeps from one message to the next (docs/protocol/elements.md Readings
// R-EL-13a, R-EL-16a and R-EL-22; issues #134, #137, #138): the Beaver Dam popup of the fake server
// (Tests/Scenarios/beaver-dam.screens) and small invented screens.
//
// The Beaver Dam popup (duck-pond-dam), the lobby, the gate and the inline `.screens` text come from
// the real fake server over TCP (src/test/support/screenSession.ts), and the tests that read them
// skip without it. Swift's `carry.carry(into: &screen, message: n)` changes the screen in place, as
// `carry.carry(screen, n)` does here.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, DyntAttributes, PopupWindow } from "../../../diag/codec/index.js"
import { Screen, ScreenReadings, WindowLevelCarry, WindowLevelCarryNote, type ScreenFunctionKind } from "../../../diag/screen/index.js"
import { ElementAtoms, ElementItems } from "../../support/elementScreenBuilder.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/** Swift's test extension `ScreenFunction.Kind.isPushButton`. */
function isPushButton(kind: ScreenFunctionKind): boolean {
  return kind.kind === "pushButton"
}

/** The suite's static members (Swift `Self.damScreen`, `Self.bareMain`, `Self.popup`). */
const Self = {
  async damScreen(name: string): Promise<Screen> {
    return Screen.fromItems(await Fixtures.items(name, "duck-pond-dam"))
  },

  /** A main screen with no MNUENTRY item. */
  bareMain(program = "ZZ_DAM_BARE"): Screen {
    const items = new ElementItems()
    items.text(ApplItem.stSystemInfo("dynproName"), program)
    const atoms = new ElementAtoms()
    atoms.label({ row: 1, col: 2, mlen: 20 }, "Nothing but logs")
    items.atoms(atoms)
    return items.screen()
  },

  /** A popup of `level` with an optional title and no MNUENTRY item. */
  popup(level: number, title: string | undefined): Screen {
    const items = new ElementItems()
    items.ses(new PopupWindow({ level, row: 4, column: 10, rows: 6, columns: 40 }).applied())
    if (title !== undefined) items.text(ApplItem.varInfo("sessionTitle"), title)
    const atoms = new ElementAtoms()
    atoms.label({ row: 1, col: 2, mlen: 20 }, "Are you sure, beaver?")
    items.atoms(atoms)
    return items.screen()
  }
}

describe("Window levels keep their GUI status and popup title", () => {
  /** a popup sent again without MNUENTRY keeps its level's status, with the same function ids */
  test("popupResent", { skip: skipWithoutFakeServer }, async () => {
    const carry = new WindowLevelCarry()
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    const select = await Self.damScreen("dam-select")
    const again = await Self.damScreen("dam-select-again")
    assert.ok(again.menus.length === 0 && again.functions.every(f => f.kind.kind === "standardToolbar" || isPushButton(f.kind)))
    assert.deepEqual(carry.carry(lobby, 3), new WindowLevelCarryNote())
    assert.deepEqual(carry.carry(select, 4), new WindowLevelCarryNote(), "a new popup level: its own status")
    const note = carry.carry(again, 5)
    assert.equal(note.statusFrom, 4)
    assert.deepEqual(
      again.functions.map(f => f.id),
      select.functions.map(f => f.id)
    )
    assert.deepEqual(again.menus, select.menus)
    // Sent again once more: still message 4's.
    const third = await Self.damScreen("dam-select-again")
    assert.equal(carry.carry(third, 6).statusFrom, 4)
  })

  /** a popup level entered from below starts empty; a main screen drops the popups' statuses */
  test("newLevelStartsEmpty", { skip: skipWithoutFakeServer }, async () => {
    const carry = new WindowLevelCarry()
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    // A popup message of one window section: the dam popup's also sets level 0 (Reading R-EL-23).
    const select = Screen.fromItems(
      await Fixtures.screens(`screen one-window
  window popup level 1 row 5 col 10 rows 8 cols 58
  menu MENU_PFK
    entry "@15@" info "Open the sluice and see what floats out" flags SEL vkey 8 return 8
end`)
    )
    carry.carry(lobby, 3)
    carry.carry(select, 4)
    const bare = Self.bareMain()
    assert.equal(carry.carry(bare, 5).statusFrom, 3, "the main level keeps the lobby's status")
    const again = await Self.damScreen("dam-select-again")
    assert.equal(carry.carry(again, 6).statusFrom, undefined, "the popup closed with the main screen: a new popup")
    assert.equal(again.menus.length, 0)
  })

  /** a logon screen keeps and hands on nothing */
  test("logonResets", { skip: skipWithoutFakeServer }, async () => {
    const carry = new WindowLevelCarry()
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    const gate = Screen.fromItems(await Fixtures.items("pond-gate"))
    assert.ok(gate.isLogonScreen)
    carry.carry(lobby, 1)
    assert.deepEqual(carry.carry(gate, 2), new WindowLevelCarryNote())
    const bare = Self.bareMain()
    assert.equal(carry.carry(bare, 3).statusFrom, undefined, "not the logon program's status")
    assert.equal(bare.menus.length, 0)
  })

  /** the fallback carries nothing, as before R-EL-22 */
  test("fallback", { skip: skipWithoutFakeServer }, async () => {
    const carry = new WindowLevelCarry({ status: "none", title: "sessionTitle" })
    const select = await Self.damScreen("dam-select")
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    carry.carry(lobby, 3)
    carry.carry(select, 4)
    const again = await Self.damScreen("dam-select-again")
    assert.deepEqual(carry.carry(again, 5), new WindowLevelCarryNote())
    assert.equal(again.menus.length, 0)
  })

  /** a popup sent again without a title keeps its level's title; a new popup has none */
  test("titleCarried", { skip: skipWithoutFakeServer }, async () => {
    const carry = new WindowLevelCarry()
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    carry.carry(lobby, 1)
    const titled = Self.popup(1, "Select Some Logs")
    assert.equal(carry.carry(titled, 2).title, undefined, "its own")
    const untitled = Self.popup(1, undefined)
    const note = carry.carry(untitled, 3)
    assert.ok(note.title === "Select Some Logs" && note.titleFrom === 2)
    const nested = Self.popup(2, undefined)
    assert.equal(carry.carry(nested, 4).title, undefined, "a new level has no title of its own")
    const plain = new WindowLevelCarry({ title: "sessionTitle" })
    const first = Self.popup(1, "Select Some Logs")
    const second = Self.popup(1, undefined)
    plain.carry(first, 1)
    assert.equal(plain.carry(second, 2).title, undefined, "the fallback")
  })

  /** an editable field whose text is ? is an empty required field; the fallback keeps it as text */
  test("requiredMarker", { skip: skipWithoutFakeServer }, async () => {
    const select = await Self.damScreen("dam-select")
    const marked = select.elements.filter(element => element.holdsRequiredMarker)
    assert.equal(marked.length, 2, "Dam and Beaver colony, the second padded")
    assert.ok(
      marked.every(element => element.isRequired && element.text === "?"),
      "the text stays as received"
    )
    const literal = Screen.fromItems(await Fixtures.items("dam-select", "duck-pond-dam"), { readings: ScreenReadings.beforeElements })
    assert.ok(!literal.elements.some(element => element.holdsRequiredMarker))
    // Only an editable field: a label reading ? is text.
    const items = new ElementItems()
    const atoms = new ElementAtoms()
    atoms.label({ row: 1, col: 2, mlen: 3 }, "?")
    atoms.input({ row: 1, col: 10, mlen: 4, attributes: DyntAttributes.yes3D | DyntAttributes.protected }, "?")
    atoms.input({ row: 2, col: 10, mlen: 4 }, " ? ")
    atoms.input({ row: 3, col: 10, mlen: 4 }, "??")
    items.atoms(atoms)
    const screen = items.screen()
    assert.deepEqual(
      screen.elements.filter(element => element.holdsRequiredMarker).map(element => element.row),
      [2],
      "the protected one and ?? are no markers"
    )
  })
})
