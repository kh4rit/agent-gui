// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0142Tests.swift (MIT).

// Issue #142: the owner's popup came in messages of two window sections, each opened by an SES
// item (PV-0984): the main window's identity, then the popup's. Swooey read each message as one
// screen, every identity item came twice, and spec gap #54 withheld them all: the popup had no
// title, program or screen number. Reading R-EL-23 (elements.md): an SES item opens a window
// section; the identity items, AREASIZE, the window state and the GUI status are per section, and
// the last section is the top window.
//
// The Beaver Dam popup (duck-pond-dam), the lobby and the inline `.screens` texts come from the real
// fake server over TCP (src/test/support/screenSession.ts), and the tests skip without it.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ContainerGeometry, ServerEcho } from "../../../diag/codec/index.js"
import { Screen, ScreenSize } from "../../../diag/screen/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/** Swift `Bug0142Tests.damScreen`: a screen of duck-pond-dam. */
async function damScreen(name: string): Promise<Screen> {
  return Screen.fromItems(await Fixtures.items(name, "duck-pond-dam"))
}

describe("A popup message's window sections each keep their identity", () => {
  for (const name of ["dam-select", "dam-select-again"]) {
    /** the dam popup, first sent and sent again: its own title, program, screen and GUI status, and no #54 repeat (bug #142) */
    test(`popupIdentity(${name})`, { skip: skipWithoutFakeServer }, async () => {
      const screen = await damScreen(name)
      assert.equal(screen.identity.title, "Which Dam, Which Beavers?")
      assert.equal(screen.identity.program, "ZZ_DAM_MONITOR")
      assert.equal(screen.identity.screenNumber, "1100")
      assert.equal(screen.identity.guiProgram, "ZZ_DAM_MONITOR")
      assert.equal(screen.identity.guiStatus, "ZZLOG")
      assert.equal(screen.identity.transaction, "ZZDAM_MON", "before the first section: the message's")
      assert.equal(screen.identity.client, "314", "the main section's, which the popup's lacks")
      assert.deepEqual(screen.size, new ScreenSize({ rows: 8, columns: 58, windowRows: 8, windowColumns: 58 }), "the popup's AREASIZE")
      assert.equal(screen.diagnostics.codec.repeatedIdentityItems, 0)
      const presentation = screen.presentation
      assert.ok(presentation.kind === "popup", "not a popup")
      const popup = presentation.value
      assert.equal(popup.level, 1)
      assert.equal(popup.title, "Which Dam, Which Beavers?")
    })
  }

  /** the sections: the main window's identity, size and GUI status, then the popup's (bug #142) */
  test("sections", { skip: skipWithoutFakeServer }, async () => {
    const screen = await damScreen("dam-select")
    const sections = screen.windowSections
    assert.ok(sections.length === 2)
    const main = sections[0]
    assert.equal(main.level, 0)
    assert.equal(main.identity.title, "Watch the Beaver Dam")
    assert.equal(main.identity.program, "ZZ_DAM_MONITOR")
    assert.equal(main.identity.screenNumber, "1000")
    assert.equal(main.identity.guiStatus, "ZZLODGE")
    assert.deepEqual(main.size, new ScreenSize({ rows: 22, columns: 84, windowRows: 22, windowColumns: 84 }))
    assert.deepEqual(
      main.menus.map(menu => menu.kind),
      ["menuAct", "menuPfk", "menuKyb"]
    )
    const popup = sections[1]
    assert.equal(popup.level, 1)
    assert.ok(popup.identity.title === screen.identity.title && popup.identity.screenNumber === "1100")
    assert.deepEqual(popup.menus, screen.menus)
    const again = (await damScreen("dam-select-again")).windowSections
    assert.ok(again.length === 2 && again.every(section => section.menus.length === 0), "sent again: no GUI status in either section")
  })

  /** an identity item twice in one section is still #54; one in each of two sections is not (bug #142) */
  test("repeatsWithinASection", { skip: skipWithoutFakeServer }, async () => {
    const twice = Screen.fromItems(
      await Fixtures.screens(`
screen twice
  ses
  text DYNPRONAME "ZZ_ONE_LOG"
  text DYNPRONAME "ZZ_TWO_LOGS"
  text SESSION_TITLE "Logs"
end
`)
    )
    assert.equal(twice.identity.program, undefined)
    assert.equal(twice.identity.title, "Logs")
    assert.equal(twice.diagnostics.codec.repeatedIdentityItems, 1)
    const split = Screen.fromItems(
      await Fixtures.screens(`
screen split
  ses
  text DYNPRONAME "ZZ_ONE_LOG"
  window popup level 1 row 3 col 4 rows 5 cols 30
  text DYNPRONAME "ZZ_TWO_LOGS"
  text DYNPRONAME "ZZ_THREE_LOGS"
end
`)
    )
    assert.deepEqual(
      split.windowSections.map(section => section.identity.program),
      ["ZZ_ONE_LOG", undefined]
    )
    assert.equal(split.identity.program, undefined, "the popup's own repeat")
    assert.equal(split.diagnostics.codec.repeatedIdentityItems, 1)
  })

  /** a message with one SES, or none, reads as it did before (bug #142) */
  test("oneSection", { skip: skipWithoutFakeServer }, async () => {
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    assert.equal(lobby.windowSections.length, 0, "no SES: no section")
    assert.equal(lobby.identity.program, "ZZ_DUCK_LOBBY")
    const one = Screen.fromItems(
      await Fixtures.screens(`
screen one
  text TCODE "ZZNEST_MON" pad 20
  text DYNPRONAME "ZZ_NEST"
  ses
  text DYNPRONUMBER "0200"
  areasize 10 40 10 40
end
`)
    )
    assert.equal(one.windowSections.length, 1)
    assert.ok(one.identity.program === "ZZ_NEST" && one.identity.screenNumber === "0200" && one.identity.transaction === "ZZNEST_MON")
    assert.equal(one.size?.rows, 10)
  })

  /** the step's window state comes from the last section: the popup's CONTAINER RESET, not the main window's (bug #142) */
  test("echoOfTheLastSection", { skip: skipWithoutFakeServer }, async () => {
    const items = await Fixtures.items("dam-select", "duck-pond-dam")
    const echo = new ServerEcho(items)
    const reset = echo.containerReset
    assert.ok(reset !== undefined)
    const geometry = ContainerGeometry.decode(reset)
    assert.ok(geometry.width === 56 && geometry.height === 5, "the popup's")
    // One section, or none: the first CONTAINER RESET of the message, as before.
    const lobby = await Fixtures.screens(`
screen lobby
  ses
  container reset id 0 row 0 col 0 width 40 height 10
  container reset id 0 row 0 col 0 width 30 height 9
end
`)
    const firstReset = new ServerEcho(lobby).containerReset
    assert.ok(firstReset !== undefined)
    const first = ContainerGeometry.decode(firstReset)
    assert.equal(first.width, 40)
  })
})
