// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/Bug0142Tests.swift (MIT).

// Issue #142, the session's side. A message of two window sections (elements.md Reading R-EL-23,
// PV-0984) names two programs: the main window's, then the popup's. DiagCodec's `ScreenIdentity`
// and ScreenModel's `Screen.isLogonScreen` read the top window, the last section; the session read
// the first DYNPRONAME of the message, so `isLogonProgram()`, the logon → active step and LogonStep
// could disagree with the screen the app shows. And the echo: a popup section without CONTAINER
// RESET, SCROLL_INFOS2 or DYNN CHL must not echo an older message's value, which is another
// window's state (R-EL-23). Invented names follow docs/testing.md §8 (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, DiagItemEncoder } from "../../../diag/codec/index.js"
import { LogonStep, LogonStepError, SessionState } from "../../../diag/session/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { cat, throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures, LogonFixtures, LogonScreens } from "../../support/sessionTestSupport.js"

describe("Bug #142: the session reads the top window's section", () => {
  /** An SES simple item (type 0x01, 16 bytes, PV-0420) with modal_number `level`. */
  function ses(level = 0): Uint8Array {
    const value = new Uint8Array(16)
    value[7] = level
    return cat([0x01], value)
  }

  /** One window section: SES, DYNPRONAME and DYNPRONUMBER. */
  function section(program: string, screen: string, level: number): Uint8Array {
    return cat(ses(level), Fixtures.text(ApplItem.stSystemInfo("dynproName"), program), Fixtures.text(ApplItem.stSystemInfo("dynproNumber"), screen))
  }

  /** A message of two sections: `main` at level 0, then `top` at level 1. */
  function twoSections(main: string, top: string): Uint8Array {
    return Fixtures.message(cat(section(main, "1000", 0), section(top, "1100", 1)))
  }

  function appl(item: ApplItem, value: ArrayLike<number>): Uint8Array {
    const output = new ByteWriter()
    DiagItemEncoder.appendAPPL(item, Uint8Array.from(value), output)
    return output.toBytes()
  }

  /** isLogonProgram() reads the last section's DYNPRONAME, as DiagCodec's ScreenIdentity does, in both orders (bug #142) */
  test("logonProgramOfTheTopWindow", () => {
    const cases: [string, string, boolean][] = [
      ["SAPMSYST", "ZZPUDDLE_POP", false],
      ["ZZPUDDLE_POP", "SAPMSYST", true]
    ]
    for (const [main, top, logon] of cases) {
      const message = LogonScreens.received(twoSections(main, top))
      const screen = message.screen
      assert.ok(screen !== undefined)
      assert.equal(message.isLogonProgram(), logon, `main ${main}, top ${top}`)
      const codec = message.withItems(items => screen.identity.isLogonProgram(items))
      assert.equal(codec, logon, `DiagCodec agrees: main ${main}, top ${top}`)
    }
  })

  /** the logon screen moves to active only when the top window is not the logon program (bug #142) */
  test("logonToActive", () => {
    const stays = LogonScreens.logonMachine()
    stays.receive({ kind: "payload", payload: twoSections("ZZ_MOAT_LOBBY", "SAPMSYST") })
    assert.deepStrictEqual(stays.state, SessionState.logon, "the logon screen on top: still logging on")
    const moves = LogonScreens.logonMachine()
    moves.receive({ kind: "payload", payload: twoSections("SAPMSYST", "ZZ_MOAT_LOBBY") })
    assert.deepStrictEqual(moves.state, SessionState.active, "another program on top: logged on")
  })

  /** LogonStep takes a logon screen on top and refuses one under another window (bug #142) */
  test("logonStep", () => {
    const credentials = LogonFixtures.credentials()
    const onTop = Fixtures.message(cat(section("ZZ_MOAT_LOBBY", "0100", 0), ses(1), LogonScreens.gateItems()))
    const step = new LogonStep(LogonScreens.received(onTop), credentials)
    assert.deepStrictEqual(step.roles, ["client", "user", "password", "language"])
    const underneath = Fixtures.message(cat(ses(), LogonScreens.gateItems(), section("ZZ_MOAT_LOBBY", "0100", 1)))
    throwsInfo(() => new LogonStep(LogonScreens.received(underneath), credentials), LogonStepError, { kind: "notLogonProgram" })
  })

  /** a popup section without window state clears the older message's: never another window's (bug #142) */
  test("echoOfTheTopWindow", () => {
    const machine = Fixtures.awaitingMachine()
    const mainCHL = new Uint8Array(22).fill(0x11)
    const main = cat(appl(ApplItem.dynn("chl"), mainCHL), appl(ApplItem.varInfo("scrollInfos2"), [0x33, 0x33]), appl(ApplItem.container("reset"), [0x44]))
    machine.receive({ kind: "payload", payload: Fixtures.message(cat(section("ZZ_DUCK_LOBBY", "0100", 0), main)) })
    assert.deepStrictEqual(machine.echo.containerReset, Uint8Array.of(0x44))
    assert.deepStrictEqual(machine.echo.dynnCHL, mainCHL)
    const popup = cat(section("ZZ_DAM_MONITOR", "1000", 0), main, section("ZZ_DAM_MONITOR", "1100", 1))
    machine.receive({ kind: "payload", payload: Fixtures.message(popup) })
    assert.equal(machine.echo.containerReset, undefined, "the popup's section has no CONTAINER RESET")
    assert.ok(machine.echo.scrollInfos2 === undefined && machine.echo.dynnCHL === undefined, "nor SCROLL_INFOS2 or DYNN CHL")
    assert.equal(machine.echo.ses?.[7], 1, "the popup's SES")
    // A later message of one section, without window state, keeps the popup's (none): the rule
    // for one section is unchanged, the latest value that came.
    const popupCHL = new Uint8Array(22).fill(0x22)
    const again = cat(
      section("ZZ_DAM_MONITOR", "1000", 0),
      main,
      section("ZZ_DAM_MONITOR", "1100", 1),
      appl(ApplItem.dynn("chl"), popupCHL)
    )
    machine.receive({ kind: "payload", payload: Fixtures.message(again) })
    assert.deepStrictEqual(machine.echo.dynnCHL, popupCHL)
    assert.equal(machine.echo.containerReset, undefined)
    machine.receive({ kind: "payload", payload: Fixtures.message(Fixtures.text(ApplItem.varInfo("sessionTitle"), "Still damming")) })
    assert.deepStrictEqual(machine.echo.dynnCHL, popupCHL, "one section without DYNN CHL: the latest stays")
  })
})
