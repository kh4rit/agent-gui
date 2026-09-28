// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/LogonCodePageTests.swift (MIT).

// The logon program in the code page in force (R-SS-5; session.md §6.3, Reading R-SE-9, §6.4).
// DYNPRONAME was compared with `SAPMSYST` as raw bytes. On a UTF-16 system (code page 4102 or
// 4103, requested in CONNECT or declared in CODEPAGE_DIAG_GUI) its bytes never equal the UTF-8
// name, and R-SS-4's byte trimming even cuts the last little-endian code unit in half; so the
// logon screen was not recognised, a second logon screen (after a rejected logon) moved the
// session on to `active`, and no logon step could be built for it. The name is now decoded in the
// code page in force and trimmed after decoding, as ScreenModel's `Screen.isLogonScreen` does.
// Invented names follow docs/testing.md §8 (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientIdentity,
  CodePage,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAttributes,
  DyntElementType,
  ScreenText,
  Secret,
  SupportBits,
  TextEncoding,
  type CompressField
} from "../../../diag/codec/index.js"
import { DiagSession, LogonCredentials, SessionMachine, SessionState } from "../../../diag/session/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { cat } from "../../support/codecTestSupport.js"
import { CodePageScreens } from "../../support/codePageScreens.js"
import { Fixtures, LogonScreens, ScriptStep, ScriptedTransport, TransportLog, inputStep, utf8 } from "../../support/sessionTestSupport.js"

describe("The logon program in the code page in force (R-SS-5, Reading R-SE-9)", () => {
  /**
   * UTF-16 in both byte orders, the code page declared by the first reply (CONNECT asked for
   * 1100) or requested in CONNECT and never declared.
   */
  const utf16Cases: [TextEncoding, boolean][] = [
    ["utf16LittleEndian", true],
    ["utf16BigEndian", true],
    ["utf16LittleEndian", false],
    ["utf16BigEndian", false]
  ]

  /**
   * A UTF-16 logon screen twice, as the first reply and after a step: the logon program both times,
   * so the session stays on the logon screen
   */
  test("logonScreenTwice", () => {
    for (const [encoding, declaredByServer] of utf16Cases) {
      const label = `${encoding}, declared by the server: ${declaredByServer}`
      const machine = CodePageScreens.awaitingMachine(declaredByServer ? CodePage.latin1 : TextEncoding.codePage(encoding))
      const firstReply = CodePageScreens.gate(encoding, { declaring: declaredByServer ? TextEncoding.codePage(encoding) : undefined })
      const first = machine.receive({ kind: "payload", payload: firstReply }).message
      assert.ok(first !== undefined, label)
      assert.deepStrictEqual(machine.state, SessionState.logon, label)
      assert.ok(first.isLogonProgram(), `the first reply is the logon program (${label})`)

      // A rejected logon: the logon screen again, without a declaration of its own; the first
      // reply's declaration stays in force.
      const step = inputStep()
      machine.send(step)
      const secondReply = CodePageScreens.gate(encoding)
      const again = machine.receive({ kind: "payload", payload: secondReply }).message
      assert.ok(again !== undefined, label)
      assert.ok(again.isLogonProgram(), `the logon screen again is the logon program (${label})`)
      assert.deepStrictEqual(machine.state, SessionState.logon, `the logon screen again does not log the session on (${label})`)

      machine.send(step)
      const lobby = CodePageScreens.lobby(encoding)
      machine.receive({ kind: "payload", payload: lobby })
      assert.deepStrictEqual(machine.state, SessionState.active, `a UTF-16 screen past the logon screen logs the session on (${label})`)
    }
  })

  /** The driver logs on to a UTF-16LE logon screen and stays on it when the logon screen comes back */
  test("driverLogonStep", async () => {
    const encoding: TextEncoding = "utf16LittleEndian"
    const firstReply = CodePageScreens.gate(encoding, { declaring: TextEncoding.codePage(encoding) })
    const secondReply = CodePageScreens.gate(encoding)
    const log = new TransportLog([ScriptStep.payload(firstReply), ScriptStep.payload(secondReply)])
    const session = new DiagSession(new ScriptedTransport(log), CodePageScreens.identity(CodePage.latin1), Fixtures.terminal)
    await session.start()
    const first = await session.nextMessage()
    assert.ok(first !== undefined)
    assert.deepStrictEqual(session.state, SessionState.logon)
    const credentials = new LogonCredentials({
      client: new Uint8Array(0),
      user: CodePageScreens.bytes("ZZEMU", encoding),
      password: new Secret(CodePageScreens.bytes("quack", encoding))
    })
    const step = await session.logOn(credentials, first)
    assert.deepStrictEqual(step.roles, ["user", "password"])
    const again = await session.nextMessage()
    assert.ok(again !== undefined)
    assert.ok(again.isLogonProgram())
    assert.deepStrictEqual(session.state, SessionState.logon, "a rejected logon leaves the session on the logon screen")
  })

  /** DYNPRONAME decoded in UTF-16LE and trimmed after decoding: padding by spaces or zero characters, never a cut code unit */
  test("decodedName", () => {
    const cases: [Uint8Array, boolean][] = [
      [CodePageScreens.utf16LE("SAPMSYST"), true],
      [CodePageScreens.utf16LE("SAPMSYST  "), true],
      [CodePageScreens.utf16LE("SAPMSYST\u{0}\u{0} \u{0}"), true],
      // The last code unit cut in half: what byte trimming made of the bare name.
      [CodePageScreens.utf16LE("SAPMSYST").slice(0, -1), false],
      // U+2054 is 54 20 in UTF-16LE: byte trimming would take its 20 for a space.
      [CodePageScreens.utf16LE("SAPMSYS\u{2054}"), false],
      [CodePageScreens.utf16LE(" SAPMSYST"), false],
      [CodePageScreens.utf16LE("ZZ_MOAT"), false],
      // The UTF-8 name read as UTF-16LE is four other characters.
      [utf8("SAPMSYST"), false]
    ]
    for (const [value, isLogon] of cases) {
      const name = `[${Array.from(value).join(", ")}]`
      const machine = CodePageScreens.awaitingMachine(CodePage.utf16LittleEndian)
      const items = CodePageScreens.textItem(ApplItem.stSystemInfo("dynproName"), value)
      const message = machine.receive({ kind: "payload", payload: Fixtures.message(items) }).message
      assert.ok(message !== undefined, name)
      assert.equal(message.isLogonProgram(), isLogon, name)
    }
  })

  /** The code page in force: CONNECT's until a declaration, then the latest; a declaration counts wherever items were read */
  test("codePageInForce", () => {
    const machine = CodePageScreens.awaitingMachine(CodePage.latin1)
    assert.equal(machine.codePageInForce, CodePage.latin1)

    // A server error whose items after the text declare UTF-16LE, as ScreenModel reads them.
    const declaration = CodePageScreens.codePageItem(CodePage.utf16LittleEndian)
    const serverError = Fixtures.message(cat(utf8("no crossing"), [0x0c], declaration), { errNo: 1 })
    const error = machine.receive({ kind: "payload", payload: serverError }).message
    assert.ok(error !== undefined)
    assert.equal(error.declaredCodePage, CodePage.utf16LittleEndian)
    assert.equal(error.codePage, CodePage.utf16LittleEndian)
    assert.equal(machine.codePageInForce, CodePage.utf16LittleEndian)
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply, "a server error is no logon screen")

    // No items: nothing declared, the code page stays.
    const snc: CompressField = { kind: "snc", value: 2 }
    for (const payload of [Fixtures.message([]), cat(Fixtures.header({ compress: snc }).bytes, [0x01])]) {
      const message = machine.receive({ kind: "payload", payload }).message
      assert.ok(message !== undefined)
      assert.equal(message.declaredCodePage, undefined)
      assert.equal(message.codePage, CodePage.utf16LittleEndian)
    }

    // A walk that stops after a UTF-8 declaration: the items before the stop count.
    const stopped = cat(CodePageScreens.codePageItem(CodePage.utf8), [0x10, 0x06, 0x02, 0x00, 0x10])
    const dropped = machine.receive({ kind: "payload", payload: Fixtures.message(stopped) }).message
    assert.ok(dropped !== undefined)
    assert.notEqual(dropped.problem, undefined)
    assert.equal(dropped.codePage, CodePage.utf8)
    assert.ok(!dropped.isLogonProgram())

    // A compressed UTF-16BE logon screen that declares its code page.
    const compressed = Fixtures.compressedMessage(CodePageScreens.gateItems("utf16BigEndian", { declaring: CodePage.utf16BigEndian }))
    const gate = machine.receive({ kind: "payload", payload: compressed }).message
    assert.ok(gate !== undefined)
    assert.equal(gate.screen?.wasCompressed, true)
    assert.equal(gate.codePage, CodePage.utf16BigEndian)
    assert.ok(gate.isLogonProgram())
    assert.deepStrictEqual(machine.state, SessionState.logon)

    // A number Swooey does not know: read as ISO 8859-1 (session.md §6.4), as ScreenModel does.
    const unknownGate = CodePageScreens.gate("latin1", { declaring: 8000 })
    const unknown = machine.receive({ kind: "payload", payload: unknownGate }).message
    assert.ok(unknown !== undefined)
    assert.equal(unknown.codePage, 8000)
    assert.ok(unknown.isLogonProgram())
    assert.equal(machine.codePageInForce, 8000)
    assert.deepStrictEqual(machine.state, SessionState.logon)
  })

  /** DYNPRONAME in the UTF-8 code page after a UTF-16 CONNECT: the declaration wins for the whole message */
  test("declarationOverridesConnect", () => {
    const machine = CodePageScreens.awaitingMachine(CodePage.utf16LittleEndian)
    const utf8Gate = CodePageScreens.gate("utf8", { declaring: CodePage.utf8 })
    const first = machine.receive({ kind: "payload", payload: utf8Gate }).message
    assert.ok(first !== undefined)
    assert.ok(first.isLogonProgram())
    // The UTF-16LE name read in the declared UTF-8 is another program: logged on.
    machine.send(inputStep())
    const utf16Gate = CodePageScreens.gate("utf16LittleEndian")
    const second = machine.receive({ kind: "payload", payload: utf16Gate }).message
    assert.ok(second !== undefined)
    assert.equal(second.codePage, CodePage.utf8)
    assert.ok(!second.isLogonProgram())
    assert.deepStrictEqual(machine.state, SessionState.active)
  })
})
