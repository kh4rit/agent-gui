// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0141Tests.swift (MIT).

// Issue #141: the owner's popup showed eight toolbar buttons, four of them the main window's: the
// popup's first message carried two GUI statuses (PV-0985), and Swooey read every MNUENTRY item of
// a message as one status. Reading R-EL-23: each window section has its own GUI status; the screen
// (the top window, the popup) offers its section's, and the main window's goes to window level 0
// (Reading R-EL-22, per section).
//
// The Beaver Dam popup (duck-pond-dam) and the lobby come from the real fake server over TCP
// (src/test/support/screenSession.ts), and the tests skip without it; the popup's parts are cut from
// `dam-select` as the fake server sends it (`damSelectPart`).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem } from "../../../diag/codec/index.js"
import { Screen, WindowLevelCarry, WindowLevelCarryNote, type ScreenFunction } from "../../../diag/screen/index.js"
import { ElementAtoms, ElementItems } from "../../support/elementScreenBuilder.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/** Swift `Bug0142Tests.damScreen`: a screen of duck-pond-dam. */
async function damScreen(name: string): Promise<Screen> {
  return Screen.fromItems(await Fixtures.items(name, "duck-pond-dam"))
}

/** Swift `WindowLevelCarryTests.bareMain`: a main screen with no MNUENTRY item. */
function bareMain(program = "ZZ_DAM_BARE"): Screen {
  const items = new ElementItems()
  items.text(ApplItem.stSystemInfo("dynproName"), program)
  const atoms = new ElementAtoms()
  atoms.label({ row: 1, col: 2, mlen: 20 }, "Nothing but logs")
  items.atoms(atoms)
  return items.screen()
}

/** The application-toolbar functions of `screen`. */
function toolbar(screen: Screen): ScreenFunction[] {
  return screen.functions.filter(f => f.kind.kind === "applicationToolbar")
}

/** Swift `compactMap`: the defined values. */
function compact<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined)
}

/** The dam popup's parts, in `order` (Tests/Scenarios/beaver-dam.screens). */
async function damParts(order: string[]): Promise<Screen> {
  const parts: Uint8Array[] = []
  for (const part of order) parts.push(await Fixtures.items(part, "duck-pond-dam"))
  const items = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    items.set(part, offset)
    offset += part.length
  }
  return Screen.fromItems(items)
}

describe("A popup offers its own GUI status, not the main window's", () => {
  /** the dam popup's functions: its own four toolbar entries and six function keys, no menu bar (bug #141) */
  test("popupStatus", { skip: skipWithoutFakeServer }, async () => {
    const screen = await damScreen("dam-select")
    const entries = toolbar(screen)
    assert.deepEqual(
      compact(entries.map(f => f.virtualKey)),
      [8, 19, 32, 12]
    )
    assert.deepEqual(
      compact(entries.map(f => f.text)),
      ["@15@", "@38@ Check", "@2L@", "@0W@"]
    )
    assert.deepEqual(
      compact(screen.functions.filter(f => f.isContextMenuEntry).map(f => f.virtualKey)),
      [19, 1, 4, 8, 12, 32]
    )
    assert.equal(screen.menuBar.length, 0, "the popup's menu bar is empty")
    assert.deepEqual(
      screen.menus.map(menu => menu.kind),
      ["menuAct", "menuPfk", "menuKyb"]
    )
    assert.equal(screen.functionForVirtualKey(86), undefined, "print is the main window's")
  })

  /** the main window's section sets level 0's GUI status: a main screen without one after the popup carries it (bug #141) */
  test("mainSectionCarried", { skip: skipWithoutFakeServer }, async () => {
    const carry = new WindowLevelCarry()
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    const select = await damScreen("dam-select")
    carry.carry(lobby, 3)
    assert.deepEqual(carry.carry(select, 4), new WindowLevelCarryNote())
    const bare = bareMain()
    assert.equal(carry.carry(bare, 5).statusFrom, 4, "the main section of message 4, not the lobby's status")
    assert.deepEqual(
      compact(toolbar(bare).map(f => f.virtualKey)),
      [86, 71, 84, 12]
    )
    assert.deepEqual(
      bare.menuBar.map(menu => menu.title),
      ["Dam", "Gnaw", "Swim To", "Pond", "Help"]
    )
  })

  /** the popup sent again without MNUENTRY carries the popup's status, not the main window's (bug #141) */
  test("popupSentAgain", { skip: skipWithoutFakeServer }, async () => {
    const carry = new WindowLevelCarry()
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    const select = await damScreen("dam-select")
    const again = await damScreen("dam-select-again")
    carry.carry(lobby, 3)
    carry.carry(select, 4)
    assert.equal(carry.carry(again, 5).statusFrom, 4)
    assert.deepEqual(
      compact(toolbar(again).map(f => f.virtualKey)),
      [8, 19, 32, 12]
    )
  })

  // Where each set sits in the owner's message was not reported (#141 stays open until it is):
  // the fix holds when each set is in its own window's section, as duck-pond-dam sends them.
  // These two tests record what Swooey does with the other placements.

  /** both GUI statuses in the popup's section: the popup still offers both (the placement #141 waits for) (bug #141) */
  test("bothSetsInThePopupSection", { skip: skipWithoutFakeServer }, async () => {
    const screen = await damParts(["dam-main-head", "dam-main-tail", "dam-select-head", "dam-main-status", "dam-select-status", "dam-select-base"])
    assert.deepEqual(
      compact(toolbar(screen).map(f => f.virtualKey)),
      [86, 71, 84, 12, 8, 19, 32, 12],
      "eight entries, as Swooey 0.0.72 drew them"
    )
    assert.equal(screen.windowSections[0]?.menus.length === 0, true)
  })

  /** both GUI statuses in the main window's section: the popup has none of its own (bug #141) */
  test("bothSetsInTheMainSection", { skip: skipWithoutFakeServer }, async () => {
    const screen = await damParts(["dam-main-head", "dam-main-status", "dam-select-status", "dam-main-tail", "dam-select-head", "dam-select-base"])
    assert.equal(toolbar(screen).length, 0, "the popup's section has no MNUENTRY")
    const first = screen.windowSections[0]
    assert.equal(first === undefined ? undefined : first.menus.length === 0, false, "both sets go to the main window's level")
  })
})
