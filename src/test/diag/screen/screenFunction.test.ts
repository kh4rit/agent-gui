// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ScreenFunctionTests.swift (MIT).
//
// The Duck Pond screens (Swift `Fixtures.items(_:)`, `Fixtures.gate()` and `Fixtures.items(screens:)`,
// which FakeScenarios built in process) come from the real fake server over TCP
// (src/test/support/screenSession.ts): the tests that read them skip without it.

import assert from "node:assert/strict"
import { inspect } from "node:util"
import { describe, test } from "node:test"
import {
  Screen,
  ScreenFunction,
  ScreenFunctionKind,
  ScreenReadings,
  StandardFunction,
  type ScreenMenuItem
} from "../../../diag/screen/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/**
 * A screen's functions (server-screen.md §8.7): the standard toolbar, the application toolbar,
 * the menu bar and the function-key list from the Duck Pond's GUI statuses, and the push buttons
 * on ZZDUCK (dynt-atoms.md Reading R-DA-9).
 */
describe("Screen functions", () => {
  const screenNamed = async (name: string, readings = new ScreenReadings()): Promise<Screen> =>
    Screen.fromItems(await Fixtures.items(name), { readings })

  const functionWithID = (screen: Screen, id: string): ScreenFunction => {
    const function_ = screen.functions.find(candidate => candidate.id === id)
    assert.ok(function_ !== undefined, `${id}`)
    return function_
  }

  const isPushButton = (function_: ScreenFunction): boolean => function_.kind.kind === "pushButton"

  /** the lobby's standard toolbar: always all eight, enabled as the GUI status declares their keys */
  test("standardToolbar", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby")
    assert.ok(lobby.hasGUIStatus)
    const standard = lobby.functions.filter(function_ => ScreenFunctionKind.equals(function_.kind, ScreenFunctionKind.standardToolbar))
    assert.deepEqual(
      standard.map(function_ => function_.text),
      ["Enter", "Save", "Back", "Exit", "Cancel", "Execute", "Choose", "Help"]
    )
    assert.deepEqual(
      standard.map(function_ => function_.virtualKey),
      [0, 11, 3, 15, 12, 8, 2, 1]
    )
    assert.deepEqual(
      standard.map(function_ => function_.isEnabled),
      [true, false, true, true, true, false, false, true]
    )
    assert.deepEqual(
      standard.map(function_ => function_.id),
      StandardFunction.allCases.map(standard => `standard:${StandardFunction.virtualKey(standard)}`)
    )
    const back = lobby.function("back")
    assert.ok(back !== undefined)
    assert.equal(back.tooltip, "Waddle Home", "the status's text for virtual key 3")
    assert.equal(back.keyCombination, "F3")
    assert.equal(back.code, undefined)
    assert.equal(lobby.function("save")?.keyCombination, "Ctrl+S")
    assert.equal(lobby.function("exit")?.keyCombination, "Shift+F3")
    assert.deepEqual(
      StandardFunction.allCases.map(standard => StandardFunction.label(standard)),
      ["Enter", "Save", "Back", "Exit", "Cancel", "Execute", "Choose", "Help"]
    )
    assert.equal(StandardFunction.fromRaw(3), "back")
  })

  /** the application toolbar (MENU_PFK) and the function-key list (MENU_KYB, the context menu) */
  test("toolbarAndKeys", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby")
    const toolbar = lobby.functions.filter(function_ => ScreenFunctionKind.equals(function_.kind, ScreenFunctionKind.applicationToolbar))
    assert.deepEqual(
      toolbar.map(function_ => function_.text),
      ["Feed Ducks", "Count Ducks"]
    )
    assert.deepEqual(
      toolbar.map(function_ => function_.virtualKey),
      [5, 6]
    )
    assert.deepEqual(
      toolbar.map(function_ => function_.tooltip),
      ["Scatter breadcrumbs, generously", "Count every duck, then count again"]
    )
    assert.deepEqual(
      toolbar.map(function_ => function_.id),
      ["toolbar:1", "toolbar:2"]
    )
    assert.ok(toolbar.every(function_ => function_.isEnabled))
    const keys = lobby.functions.filter(function_ => function_.isContextMenuEntry)
    assert.deepEqual(
      keys.map(function_ => function_.virtualKey),
      [1, 3, 5, 6, 12, 15, 17, 18, 19]
    )
    assert.equal(keys[0]?.text, "What Does the Duck Say?")
    assert.ok(keys.every(function_ => ScreenFunctionKind.equals(function_.kind, ScreenFunctionKind.menu([])) && function_.isEnabled))
  })

  /** the menu bar: titles from MENU_ACT, items and a submenu from MENU_MNU by position (R-SS-11) */
  test("menuBar", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby")
    assert.deepEqual(
      lobby.menuBar.map(menu => menu.title),
      ["Pond", "Ducks", "Quackery"]
    )
    assert.deepEqual(
      lobby.menuBar.map(menu => menu.position),
      [1, 2, 3]
    )
    assert.deepEqual(
      lobby.menuBar.map(menu => menu.accelerator),
      ["P", "D", "Q"]
    )
    const pond = lobby.menuBar[0].items
    assert.equal(pond.length, 4)
    const feedItem = pond[0]
    const homeItem = pond[3]
    // Swift's `guard case … else { Issue.record(…); return }`.
    if (feedItem.kind !== "function" || pond[2].kind !== "separator" || homeItem.kind !== "function") assert.fail(`Pond: ${inspect(pond)}`)
    const feed = feedItem.value
    const home = homeItem.value
    assert.equal(feed.text, "Feed Ducks")
    assert.equal(feed.virtualKey, 5)
    assert.ok(ScreenFunctionKind.equals(feed.kind, ScreenFunctionKind.menu(["Pond"])))
    assert.equal(feed.accelerator, "F")
    assert.equal(feed.id, "menu:1.1")
    assert.equal(home.text, "Waddle Home")
    assert.equal(home.virtualKey, 3)
    const ducks = lobby.menuBar[1].items
    const lineUpItem = ducks[0]
    const swanItem = ducks[2]
    if (lineUpItem.kind !== "submenu" || swanItem.kind !== "function") assert.fail(`Ducks: ${inspect(ducks)}`)
    const title = lineUpItem.title
    const lineUp = lineUpItem.items
    const swan = swanItem.value
    assert.equal(title, "Line Up")
    const row = lineUp.flatMap((item: ScreenMenuItem): ScreenFunction[] => (item.kind === "function" ? [item.value] : []))
    assert.deepEqual(
      row.map(function_ => function_.text),
      ["Get All Your Ducks in a Row", "Consult the Rubber Duck"]
    )
    assert.deepEqual(
      row.map(function_ => function_.kind),
      [ScreenFunctionKind.menu(["Ducks", "Line Up"]), ScreenFunctionKind.menu(["Ducks", "Line Up"])]
    )
    assert.deepEqual(
      row.map(function_ => function_.id),
      ["menu:2.1.1", "menu:2.1.2"]
    )
    assert.equal(swan.text, "Summon the Swan", "no SEL: the swan is busy (R-SS-12)")
    assert.ok(!swan.isEnabled, "no SEL: the swan is busy (R-SS-12)")
    const menuFunctions = lobby.functions.filter(function_ => function_.kind.kind === "menu" && function_.kind.path.length > 0)
    assert.equal(menuFunctions.length, 8)
    assert.ok(lobby.diagnostics.isClean)
    assert.equal(lobby.diagnostics.unplacedMenuEntries, 0)
  })

  /** a function by its virtual key: toolbar first, then menu, key list and standard toolbar */
  test("byVirtualKey", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby")
    assert.deepEqual(lobby.functionForVirtualKey(5)?.kind, ScreenFunctionKind.applicationToolbar)
    assert.equal(lobby.functionForVirtualKey(3)?.id, "menu:1.4")
    assert.equal(lobby.functionForVirtualKey(12)?.isContextMenuEntry, true)
    assert.equal(lobby.functionForVirtualKey(20)?.isEnabled, false)
    assert.deepEqual(lobby.functionForVirtualKey(11)?.kind, ScreenFunctionKind.standardToolbar)
    assert.equal(lobby.functionForVirtualKey(0)?.id, StandardFunction.id("enter"))
    assert.equal(lobby.functionForVirtualKey(42), undefined)
  })

  /** ZZDUCK's push buttons: caption and function code (R-DA-9) as elements and functions */
  test("pushButtons", { skip: skipWithoutFakeServer }, async () => {
    const duck = await screenNamed("pond-rubber-duck")
    const buttons = duck.elements.filter(element => element.kind.kind === "button")
    assert.deepEqual(
      buttons.map(button => button.text),
      ["Ask the Duck", "Squeak"]
    )
    assert.deepEqual(
      buttons.map(button => button.functionCode),
      ["=ZZASK", "=ZZSQUEAK"]
    )
    assert.deepEqual(
      buttons.map(button => button.width),
      [16, 10]
    )
    assert.equal(buttons[0].description, 'button b1 r9 c4 t115 w16 h1 "Ask the Duck" code =ZZASK')
    const functions = duck.functions.filter(isPushButton)
    assert.deepEqual(
      functions.map(function_ => function_.code),
      ["=ZZASK", "=ZZSQUEAK"]
    )
    assert.deepEqual(
      functions.map(function_ => function_.kind),
      buttons.map(button => ScreenFunctionKind.pushButton(button.id))
    )
    assert.deepEqual(
      functions.map(function_ => function_.id),
      ["element:b1 r9 c4 t115", "element:b1 r9 c22 t115"]
    )
    assert.ok(functions.every(function_ => function_.isEnabled && function_.virtualKey === undefined))
    assert.equal(functions[0].description, 'element:b1 r9 c4 t115 "Ask the Duck" code =ZZASK enabled')
    assert.equal(duck.diagnostics.codec.atoms.undecodedButtonStrings, 0, "the model decoded both")
    assert.equal(duck.functionForVirtualKey(8)?.text, "Ask the Duck")
    assert.equal(duck.function("execute")?.isEnabled, true)
  })

  /** the gate's example-style status: a title without items, keys 5 and 15; Exit is enabled, Back is not */
  test("gate", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    assert.deepEqual(
      gate.menuBar.map(menu => menu.title),
      ["Welcome to the Duck Pond"]
    )
    assert.equal(gate.menuBar[0]?.items.length === 0, true)
    assert.equal(gate.function("exit")?.isEnabled, true)
    assert.equal(gate.function("exit")?.tooltip, "Fly South for the Winter")
    assert.equal(gate.function("back")?.isEnabled, false)
    assert.deepEqual(
      gate.functions.filter(function_ => ScreenFunctionKind.equals(function_.kind, ScreenFunctionKind.applicationToolbar)).map(function_ => function_.virtualKey),
      [5]
    )
  })

  /** a screen without a GUI status: every standard function is enabled, and nothing else is offered */
  test("noStatus", { skip: skipWithoutFakeServer }, async () => {
    const screen = Screen.fromItems(
      await Fixtures.screens(`screen bare
  text DYNPRONAME "ZZ_BARE"
end`)
    )
    assert.ok(!screen.hasGUIStatus)
    assert.equal(screen.functions.length, 8)
    assert.ok(screen.functions.every(function_ => ScreenFunctionKind.equals(function_.kind, ScreenFunctionKind.standardToolbar) && function_.isEnabled))
    assert.equal(screen.menuBar.length, 0)
  })

  /** entries without a title or parent are counted, not shown; entries at one place get distinct ids */
  test("unplacedAndDuplicates", { skip: skipWithoutFakeServer }, async () => {
    const screen = Screen.fromItems(
      await Fixtures.screens(`screen odd
  menu MENU_ACT
    entry "Nest" position 1 0 0 0 flags SEL,MEN
    entry "Nest again" position 1 0 0 0 flags SEL,MEN
    entry "No position" flags SEL
  menu MENU_MNU
    entry "Egg" position 1 1 0 0 flags SEL vkey 5
    entry "Egg too" position 1 1 0 0 flags SEL vkey 6
    entry "Lost" position 9 1 0 0 flags SEL vkey 7
    entry "Title-less" position 1 0 0 0 flags SEL vkey 8
    entry "Menu-only" position 1 2 0 0 flags SEL vkey 100
end`)
    )
    assert.deepEqual(
      screen.menuBar.map(menu => menu.title),
      ["Nest"]
    )
    assert.equal(screen.menuBar[0].items.length, 3)
    const ids = screen.functions.filter(function_ => ScreenFunctionKind.equals(function_.kind, ScreenFunctionKind.menu(["Nest"]))).map(function_ => function_.id)
    assert.deepEqual(ids, ["menu:1.1", "menu:1.1#2", "menu:1.2"])
    assert.equal(screen.diagnostics.unplacedMenuEntries, 2)
    assert.ok(!screen.diagnostics.isClean)
    const menuOnly = functionWithID(screen, "menu:1.2")
    assert.equal(menuOnly.virtualKey, undefined)
    assert.equal(menuOnly.code, undefined)
    assert.equal(menuOnly.keyCombination, undefined)
    assert.ok(!menuOnly.canFire)
    assert.ok(functionWithID(screen, "menu:1.1").canFire)
  })

  /** the readings switch: every entry enabled without SEL, button strings opaque, strict menu lengths */
  test("readings", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby", new ScreenReadings({ menuEnabledBySEL: false }))
    assert.equal(lobby.functionForVirtualKey(20)?.isEnabled, true)
    const duck = await screenNamed("pond-rubber-duck", new ScreenReadings({ buttonStrings: "opaque" }))
    const buttons = duck.elements.filter(element => element.kind.kind === "button")
    assert.ok(buttons.every(button => button.text === undefined && button.functionCode === undefined))
    assert.ok(duck.functions.filter(isPushButton).every(function_ => !function_.isEnabled))
    assert.equal(duck.diagnostics.codec.atoms.undecodedButtonStrings, 2)
    // One entry whose length field declares 28 bytes: 20 fixed, "Egg" and three zero bytes,
    // then two bytes of zero padding (Reading R-SS-8a).
    const text = `screen padded
  menu MENU_ACT
    entry "Nest" position 1 0 0 0 flags SEL,MEN
  raw-appl4 0x0B 0x02 "\\x00\\x1C\\x01\\x01\\x00\\x00\\x12\\x05\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0\\0Egg\\0\\0\\0\\0\\0"
end`
    const lenient = Screen.fromItems(await Fixtures.screens(text))
    assert.equal(lenient.functionForVirtualKey(5)?.text, "Egg")
    assert.equal(lenient.diagnostics.codec.stoppedMenus, 0)
    const strict = Screen.fromItems(await Fixtures.screens(text), { readings: new ScreenReadings({ menuEntryPadding: false }) })
    assert.equal(strict.functionForVirtualKey(5), undefined)
    assert.equal(strict.diagnostics.codec.stoppedMenus, 1)
  })

  /** a function's description, key combination and identity */
  test("descriptions", () => {
    const function_ = new ScreenFunction({
      id: "toolbar:9",
      code: undefined,
      text: "Honk",
      virtualKey: 300,
      kind: ScreenFunctionKind.applicationToolbar,
      isEnabled: false,
      tooltip: "Loudly"
    })
    assert.equal(function_.description, 'toolbar:9 "Honk" vkey 300 disabled')
    assert.equal(function_.keyCombination, undefined)
    assert.equal(function_.accelerator, undefined)
    assert.equal(function_.tooltip, "Loudly")
    // Swift's `ScreenFunction.ID` wraps the string; here the id is the string.
    assert.equal(String(function_.id), "toolbar:9")
    assert.ok(!function_.isContextMenuEntry)
  })
})
