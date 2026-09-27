// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/SessionModesTests.swift (MIT).

// Modes on the session (docs/protocol/session.md §8): messages are routed by the DIAG header's
// mode byte (Reading R-MO-1), each mode keeps its own echo (R-MO-4), a message in a new mode opens
// it (R-MO-3), a header-only EOC message ends one of several modes (R-MO-5), and each step carries
// its mode (R-MO-2). Invented names follow docs/testing.md §8 (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientInputStep,
  ComFlag,
  CompressField,
  DiagHeader,
  DiagItemEncoder,
  DialogStepNumber,
  InputEnvelope,
  ReturnedField,
  ServerEcho
} from "../../../diag/codec/index.js"
import { SessionSendError, SessionState, type SessionMachine } from "../../../diag/session/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { cat, throwsInfo } from "../../support/codecTestSupport.js"
import { LogonScreens, ScriptStep, TransportLog, inputStep, scriptedSession, utf8 } from "../../support/sessionTestSupport.js"

describe("Modes on the session", () => {
  /** A header in `mode` with `modeStat`, msg_info 1 as real screens carry it. */
  function header(mode: number, modeStat = 0, comFlag = 0): DiagHeader {
    return new DiagHeader({ mode, comFlag, modeStat, errNo: 0, msgType: 0, msgInfo: 1, msgRC: 0, compress: CompressField.uncompressed })
  }

  /** The moat's lobby in `mode`, with DIALOG_STEP_NUMBER `step`. */
  function lobby(mode: number, step: number, modeStat = 0): Uint8Array {
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(step).bytes, items)
    const lobby = LogonScreens.lobby()
    return cat(header(mode, modeStat).bytes, items.toBytes(), lobby.slice(DiagHeader.size))
  }

  /** A machine logged on in mode 0: the gate, a step, the lobby (step 2). */
  function loggedOn(): SessionMachine {
    const machine = LogonScreens.logonMachine()
    machine.send(inputStep())
    machine.receive({ kind: "payload", payload: lobby(0, 2) })
    assert.deepStrictEqual(machine.state, SessionState.active)
    return machine
  }

  /** one mode: the first message's mode opens quietly, and the echo is the connection's */
  test("singleMode", () => {
    const machine = loggedOn()
    assert.deepStrictEqual(machine.openModes, [0])
    assert.ok(machine.isOpen(0) && !machine.isOpen(1))
    assert.equal(machine.echo.stepNumber, 2)
    assert.deepStrictEqual(machine.echoFor(0), machine.echo)
    assert.equal(machine.modes.get(0)?.messages, 2)
    assert.ok(machine.diagnostics.modesOpened === 0 && machine.diagnostics.modesEnded === 0)
  })

  /** a message in a new mode opens it; each mode keeps its own echo; steps carry their mode and its echo */
  test("routing", () => {
    const machine = loggedOn()
    const opened = machine.receive({ kind: "payload", payload: lobby(1, 7, 0xf0) }).message
    assert.ok(opened !== undefined)
    assert.equal(opened.mode, 1)
    assert.equal(opened.modeEvent, "opened")
    assert.deepStrictEqual(machine.openModes, [0, 1])
    assert.equal(machine.latestMode, 1)
    assert.equal(machine.diagnostics.modesOpened, 1)
    assert.ok(machine.echoFor(1).stepNumber === 7 && machine.echoFor(1).modeStat === 0xf0)
    assert.ok(machine.echoFor(0).stepNumber === 2 && machine.echoFor(0).modeStat === 0)
    assert.deepStrictEqual(machine.echoFor(3), new ServerEcho(), "a mode that is not open echoes nothing")

    const again = machine.receive({ kind: "payload", payload: lobby(1, 8) }).message
    assert.ok(again !== undefined)
    assert.equal(again.modeEvent, undefined, "a mode opens once")

    const step = new ClientInputStep({ envelope: InputEnvelope.echoStage })
    step.appendField(new ReturnedField({ block: 1, row: 6, col: 30, mlen: 12, maxNrChars: 12 }), utf8("moat"))
    const inOne = machine.send(step, 1).send[0]
    assert.ok(inOne !== undefined)
    assert.equal(inOne[0], 1, "the header's mode byte is the step's mode (R-MO-2)")
    const { items, body } = LogonScreens.walk(inOne)
    assert.equal(DialogStepNumber.decode(items[0].valueRange.of(body)).step, 8, "mode 1's own step echoed (R-MO-4)")
    const inZero = machine.send(step, 0).send[0]
    assert.ok(inZero !== undefined)
    assert.equal(inZero[0], 0)
    const { items: zeroItems, body: zeroBody } = LogonScreens.walk(inZero)
    assert.equal(DialogStepNumber.decode(zeroItems[0].valueRange.of(zeroBody)).step, 2, "mode 0's step echoed")
    throwsInfo(() => machine.send(step, 2), SessionSendError, { kind: "modeNotOpen", mode: 2 })
  })

  /** a header-only EOC message ends one of several modes; in the last mode it ends nothing */
  test("ending", () => {
    const machine = loggedOn()
    machine.receive({ kind: "payload", payload: lobby(1, 3) })
    machine.receive({ kind: "payload", payload: lobby(4, 3) })
    assert.deepStrictEqual(machine.openModes, [0, 1, 4])

    const error = header(1, 0, ComFlag.eoc).bytes.slice()
    const withError = error.slice()
    withError[3] = 0x01
    const notEnded = machine.receive({ kind: "payload", payload: cat(withError, [0x0c]) }).message
    assert.ok(notEnded !== undefined)
    assert.equal(notEnded.modeEvent, undefined, "a server error ends no mode")
    const withItems = machine.receive({ kind: "payload", payload: cat(error, [0x0c]) }).message
    assert.ok(withItems !== undefined)
    assert.equal(withItems.modeEvent, undefined, "only a header-only message ends a mode")

    const end = machine.receive({ kind: "payload", payload: header(1, 0, ComFlag.eop | ComFlag.eoc).bytes }).message
    assert.ok(end !== undefined)
    assert.equal(end.modeEvent, "ended")
    assert.deepStrictEqual(machine.openModes, [0, 4])
    assert.equal(machine.diagnostics.modesEnded, 1)
    machine.receive({ kind: "payload", payload: header(0, 0, ComFlag.eop | ComFlag.eoc).bytes })
    assert.deepStrictEqual(machine.openModes, [4])
    const last = machine.receive({ kind: "payload", payload: header(4, 0, ComFlag.eop | ComFlag.eoc).bytes }).message
    assert.ok(last !== undefined)
    assert.equal(last.modeEvent, undefined, "in the last mode it is the logoff; the connection's end follows")
    assert.deepStrictEqual(machine.openModes, [4])
    assert.equal(machine.diagnostics.modesEnded, 2)
    assert.deepStrictEqual(machine.state, SessionState.active)

    const reopened = machine.receive({ kind: "payload", payload: lobby(1, 9) }).message
    assert.ok(reopened !== undefined)
    assert.equal(reopened.modeEvent, "opened", "an ended mode opens again with its next message")
  })

  /** a message without a header counts for the latest mode */
  test("headerless", () => {
    const machine = loggedOn()
    machine.receive({ kind: "payload", payload: lobby(2, 5, 0x11) })
    const short = machine.receive({ kind: "payload", payload: Uint8Array.of(0x02, 0x00, 0x00) }).message
    assert.ok(short !== undefined)
    assert.ok(short.mode === undefined && short.modeEvent === undefined)
    assert.deepStrictEqual(machine.openModes, [0, 2])
    assert.equal(machine.echoFor(2).modeStat, 0x11, "kept: no header came to change it")
    assert.equal(machine.modes.get(2)?.messages, 1)
  })

  /** the driver sends a step in its mode and reads the reply in the new mode */
  test("driver", async () => {
    const log = new TransportLog([
      ScriptStep.payload(LogonScreens.gate()),
      ScriptStep.payload(lobby(0, 2)),
      ScriptStep.payload(lobby(1, 1))
    ])
    const session = scriptedSession(log)
    await session.start()
    await session.nextMessage()
    assert.ok(await session.send(inputStep()))
    await session.nextMessage()
    const ask = new ClientInputStep()
    ask.setFunctionCode(utf8("/oZZMOAT"), "varInfoOKCode")
    assert.ok(await session.send(ask))
    const opened = await session.nextMessage()
    assert.ok(opened !== undefined)
    assert.ok(opened.modeEvent === "opened" && opened.mode === 1)
    assert.deepStrictEqual(session.openModes, [0, 1])
    assert.ok(await session.send(inputStep(), 1))
    const sent = log.sent.at(-1)
    assert.ok(sent !== undefined)
    assert.equal(sent[0], 1)
    const other = inputStep()
    try {
      await session.submit(other, 5)
      assert.fail("a step for a mode that is not open went out")
    } catch (error) {
      if (!(error instanceof SessionSendError)) throw error
      assert.deepStrictEqual(error.info, { kind: "modeNotOpen", mode: 5 })
    }
  })
})
