// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/GUIBlobSessionTests.swift (MIT).

// GUI blob screen delivery (issue #180, Reading R-CT-44): a one-way GUI-core call whose STREAM
// holds a screen becomes the screen, opt-in, with synthetic screens.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, CodePage, CompressField, DiagHeader, DiagItemEncoder, DialogStepNumber, GUIBlob } from "../../../diag/codec/index.js"
import { SessionState, type SessionMachine } from "../../../diag/session/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { cat } from "../../support/codecTestSupport.js"
import { CodePageScreens } from "../../support/codePageScreens.js"
import { ControlFixtures, LogonScreens, inputStep, utf8 } from "../../support/sessionTestSupport.js"

describe("GUI blob screen delivery: synthetic screens", () => {
  function item(id: number, value: ArrayLike<number>): Uint8Array {
    return cat([id >> 8, id & 255, value.length >> 8, value.length & 255], value, [id >> 8, id & 255])
  }

  function call(items: ArrayLike<number>): Uint8Array {
    return cat(item(0x0102, cat(utf8(GUIBlob.functionName), [0, 0])), item(0x0201, utf8("STREAM")), item(0x0203, items), item(0xffff, []))
  }

  // SessionModesTests' statics: the moat's lobby in `mode` with step `step`, and a machine logged on in mode 0.
  function lobby(mode: number, step: number): Uint8Array {
    const header = new DiagHeader({ mode, comFlag: 0, modeStat: 0, errNo: 0, msgType: 0, msgInfo: 1, msgRC: 0, compress: CompressField.uncompressed })
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(step).bytes, items)
    return cat(header.bytes, items.toBytes(), LogonScreens.lobby().slice(DiagHeader.size))
  }

  function loggedOn(): SessionMachine {
    const machine = LogonScreens.logonMachine()
    machine.send(inputStep())
    machine.receive({ kind: "payload", payload: lobby(0, 2) })
    assert.deepStrictEqual(machine.state, SessionState.active)
    return machine
  }

  /** fragmented one-way STREAM becomes the screen without rewinding the transport step (#180) */
  for (const fragmented of [false, true]) {
    test(`deliversScreen(fragmented: ${fragmented})`, () => {
      const machine = loggedOn()
      machine.controlReadings.guiBlobScreens = true
      const nested = lobby(0, 4).slice(DiagHeader.size)
      const bytes = call(nested)
      const split = fragmented ? Math.floor(bytes.length / 2) : 0
      if (fragmented) {
        const prefix = machine.receive({ kind: "payload", payload: ControlFixtures.part(0x04, 7, bytes.slice(0, split)) })
        assert.equal(prefix.send.length, 1)
        assert.equal(prefix.message?.control?.showsScreen, false)
      }
      const original = ControlFixtures.part(0x06, 8, bytes.slice(split), { msgInfo: 2 })
      const before = machine.modes.get(0)?.messages
      const result = machine.receive({ kind: "payload", payload: original })
      const message = result.message
      assert.ok(message !== undefined)
      assert.equal(result.send.length, 0)
      assert.deepEqual(message.payload, original, "retain the received frame for structural diagnostics")
      assert.equal(message.control?.showsScreen, true)
      assert.ok(message.control?.isInterim === true && message.control?.serverContinues === true)
      assert.deepEqual(message.identityText("dynproName"), utf8("ZZ_MOAT_LOBBY"))
      assert.deepEqual(message.withItems(items => items.slice()), nested)
      assert.equal(machine.echo.stepNumber, 8, "the outer transport step takes precedence over the embedded screen's step")
      assert.equal(machine.modes.get(0)?.messages, before === undefined ? undefined : before + 1, "one frame, one mode message")
      assert.deepStrictEqual(machine.state, SessionState.active)
    })
  }

  /** a malformed blob keeps the outer control message and does not replace the screen (#180) */
  test("invalidItems", () => {
    const machine = loggedOn()
    machine.controlReadings.guiBlobScreens = true
    const result = machine.receive({ kind: "payload", payload: ControlFixtures.part(0x06, 9, call([0xff]), { msgInfo: 2 }) })
    const message = result.message
    assert.ok(message !== undefined)
    assert.ok(result.send.length === 0 && message.control?.showsScreen === false)
    assert.ok(message.control?.notes.some(note => note.includes("could not be read")))
    assert.equal(machine.echo.stepNumber, 9)
  })

  /** embedded code pages govern the screen; nested echoes stay in the outer mode (#180) */
  test("codePageAndMode", () => {
    const machine = loggedOn()
    machine.controlReadings.guiBlobScreens = true
    const nested = CodePageScreens.gateItems("utf16LittleEndian", { program: "ZZ_UNICODE", declaring: CodePage.utf16LittleEndian })
    const outer = ControlFixtures.part(0x06, 9, call(nested), { msgInfo: 2 })
    outer[0] = 1
    const message = machine.receive({ kind: "payload", payload: outer }).message
    assert.ok(message !== undefined)
    assert.ok(message.mode === 1 && message.modeEvent === "opened")
    assert.ok(message.codePage === 4103 && message.declaredCodePage === 4103)
    assert.equal(message.isLogonProgram(), false)
    assert.equal(machine.echoFor(0).stepNumber, 2)
    assert.equal(machine.echoFor(1).stepNumber, 9)
    assert.equal(machine.modes.get(1)?.messages, 1)
    assert.equal(machine.diagnostics.modesOpened, 1)
  })

  /** unvalidated blob screen delivery is opt-in, with structural diagnostics available by default (#180) */
  test("optIn", () => {
    const machine = loggedOn()
    assert.ok(!machine.controlReadings.guiBlobScreens)
    const nested = LogonScreens.lobby().slice(DiagHeader.size)
    const message = machine.receive({ kind: "payload", payload: ControlFixtures.part(0x06, 9, call(nested), { msgInfo: 2 }) }).message
    assert.ok(message !== undefined)
    assert.ok(message.control?.guiBlob === undefined && message.control?.showsScreen === false)
    assert.ok(message.control?.notes.some(note => note.startsWith("GUI blob STREAM:")))
  })
})
