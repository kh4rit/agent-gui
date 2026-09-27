// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/InputStepSessionTests.swift (MIT).

// The session's input step (client-input.md §1, R-CI-1; session.md §4): DIALOG_STEP_NUMBER first
// with the per-connection counter, EOM last, and the state moving on to `active` once a screen
// past the logon screen arrives (R-SS-5). Invented names follow docs/testing.md §8 (D15).
// `LogonScreens` and `InputStepSessionTests.step()` live in sessionTestSupport.ts (`inputStep()`).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ApplItem,
  ClientInput,
  ClientInputError,
  ClientInputStep,
  ClientMessageEncoder,
  ClientMessageError,
  Decompressor,
  DiagHeader,
  DiagItemWalker,
  DiagMessage,
  DialogStepNumber,
  DyntAttributes,
  ReturnedField,
  Secret,
  type CompressField
} from "../../../diag/codec/index.js"
import {
  DisconnectReason,
  SessionSendError,
  SessionState,
  describeSessionSendError,
  type SessionSendErrorInfo
} from "../../../diag/session/index.js"
import { cat, throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures, LogonScreens, ScriptStep, TransportLog, inputStep, scriptedSession, utf8 } from "../../support/sessionTestSupport.js"

/** Swift `await #expect(throws: SessionSendError.case) { … }`: `promise` rejects with a `SessionSendError` whose `info` is `info`. */
async function rejectsWith(promise: Promise<unknown>, info: SessionSendErrorInfo, message?: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof SessionSendError, `${message ?? ""} expected SessionSendError, got ${String(error)}`)
      assert.deepStrictEqual(error.info, info, message)
      return true
    },
    message
  )
}

describe("The input step on the session: the state machine and the driver", () => {
  /** a step is taken only on the logon screen or once logged on; nothing is built otherwise */
  test("notReady", () => {
    const step = inputStep()
    const connecting = Fixtures.machine()
    throwsInfo(() => connecting.send(step), SessionSendError, { kind: "notReady", state: SessionState.connecting })
    const awaiting = Fixtures.awaitingMachine()
    throwsInfo(() => awaiting.send(step), SessionSendError, { kind: "notReady", state: SessionState.awaitingFirstReply })
    const closed = LogonScreens.logonMachine()
    closed.close()
    throwsInfo(() => closed.send(step), SessionSendError, {
      kind: "notReady",
      state: SessionState.disconnected(DisconnectReason.closedByClient)
    })
    assert.equal(closed.lastStepNumber, 0)
    assert.equal(closed.diagnostics.inputSteps, 0)
    assert.ok(
      describeSessionSendError({ kind: "notReady", state: SessionState.connecting }).startsWith(
        "the session takes input only on the logon screen"
      )
    )
  })

  /** DIALOG_STEP_NUMBER first with the per-connection counter, the step's items, EOM last (R-CI-1, PV-0521) */
  test("envelope", () => {
    const machine = LogonScreens.logonMachine()
    const step = inputStep()
    const encoder = new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal)
    for (let number = 1; number <= 3; number++) {
      const reaction = machine.send(step)
      assert.ok(!reaction.closeTransport)
      assert.equal(reaction.message, undefined)
      const payload = reaction.send[0]
      assert.ok(payload !== undefined)
      assert.equal(reaction.send.length, 1)
      assert.deepStrictEqual(payload, ClientInput.inputMessage(encoder, step))
      const { items, body } = LogonScreens.walk(payload)
      assert.deepStrictEqual(items[0]?.appl, ApplItem.stUser("dialogStepNumber"))
      assert.equal(DialogStepNumber.decode(items[0].valueRange.of(body)).step, number)
      assert.equal(items.at(-1)?.type, "eom")
      assert.equal(machine.lastStepNumber, number)
    }
    assert.equal(machine.diagnostics.inputSteps, 3)
    assert.deepStrictEqual(machine.state, SessionState.logon, "sending moves nothing; the reply does")
  })

  /** a mode the server has not opened takes no step: nothing built, the counter unchanged */
  test("otherMode", () => {
    const machine = LogonScreens.logonMachine()
    throwsInfo(() => machine.send(inputStep(), 1), SessionSendError, { kind: "modeNotOpen", mode: 1 })
    assert.equal(machine.lastStepNumber, 0)
    assert.equal(describeSessionSendError({ kind: "modeNotOpen", mode: 1 }), "the input step is for session 2 (mode 1), which is not open")
    assert.ok(
      describeSessionSendError({ kind: "message", error: { kind: "stepNumberExhausted" } }).startsWith("the input step could not be built")
    )
  })

  /** logon → active on a screen past the logon screen; it stays active */
  test("logonToActive", () => {
    const machine = LogonScreens.logonMachine()
    machine.send(inputStep())
    machine.receive({ kind: "payload", payload: LogonScreens.lobby() })
    assert.deepStrictEqual(machine.state, SessionState.active)
    machine.receive({ kind: "payload", payload: LogonScreens.gate() })
    assert.deepStrictEqual(machine.state, SessionState.active, "a later logon-program screen does not log the session off")
    machine.send(inputStep())
    assert.equal(machine.lastStepNumber, 2, "input is taken once logged on")
  })

  /**
   * the state stays on the logon screen for the logon screen again, a server error, a header-only
   * message, a screen without DYNPRONAME, a repeated DYNPRONAME and a message that is not decoded
   */
  test("staysOnLogon", () => {
    const lobbyItems = LogonScreens.lobby().slice(DiagHeader.size)
    const repeated = cat(Fixtures.text(ApplItem.stSystemInfo("dynproName"), "ZZ_MOAT"), Fixtures.text(ApplItem.stSystemInfo("dynproName"), "ZZ_MOAT"))
    const snc: CompressField = { kind: "snc", value: 2 }
    const replies: [string, Uint8Array][] = [
      ["the logon screen again", LogonScreens.gate()],
      ["a server error", Fixtures.message(cat(utf8("no crossing"), [0x0c], lobbyItems), { errNo: 1 })],
      ["a header-only message", Fixtures.message([])],
      ["no DYNPRONAME", Fixtures.message(Fixtures.text(ApplItem.stSystemInfo("dynproNumber"), "0100"))],
      ["a repeated DYNPRONAME (#54)", Fixtures.message(repeated)],
      ["not decoded", cat(Fixtures.header({ compress: snc }).bytes, [0x01])]
    ]
    for (const [name, reply] of replies) {
      const machine = LogonScreens.logonMachine()
      machine.send(inputStep())
      machine.receive({ kind: "payload", payload: reply })
      assert.deepStrictEqual(machine.state, SessionState.logon, name)
    }
  })

  /** close and a failed write once logged on */
  test("activeCloseAndWriteFailure", () => {
    const machine = LogonScreens.logonMachine()
    machine.receive({ kind: "payload", payload: LogonScreens.lobby() })
    assert.deepStrictEqual(machine.state, SessionState.active)
    const failing = machine.clone()
    failing.writeFailed(TransportLog.sendFailure)
    assert.deepStrictEqual(failing.state, SessionState.disconnected(DisconnectReason.transportFailed(TransportLog.sendFailure.info)))
    const close = machine.close()
    assert.deepStrictEqual(close.send, [ClientMessageEncoder.closeMessage])
    assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.closedByClient))
  })

  /** the driver writes the step, reads the reply and moves on to active */
  test("driver", async () => {
    const step = inputStep()
    const log = new TransportLog([ScriptStep.payload(LogonScreens.gate()), ScriptStep.payload(LogonScreens.lobby())])
    const session = scriptedSession(log)
    assert.equal(await session.send(step), false, "nothing before the first reply")
    await session.start()
    assert.equal(await session.send(step), false)
    await session.nextMessage()
    assert.deepStrictEqual(session.state, SessionState.logon)
    assert.equal(await session.send(step), true)
    const encoder = new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal)
    assert.deepStrictEqual(log.sent.at(-1), ClientInput.inputMessage(encoder, step))
    const reply = await session.nextMessage()
    assert.ok(reply !== undefined)
    assert.equal(reply.number, 2)
    assert.deepStrictEqual(session.state, SessionState.active)
    assert.equal(session.diagnostics.inputSteps, 1)
    assert.deepStrictEqual(await session.close(), ClientMessageEncoder.closeMessage)
  })

  /** a failed write disconnects with the transport's error; submit says so */
  test("driverWriteFails", async () => {
    const log = new TransportLog([ScriptStep.payload(LogonScreens.gate())], 2)
    const session = scriptedSession(log)
    await session.start()
    await session.nextMessage()
    await rejectsWith(session.submit(inputStep()), { kind: "notWritten", error: TransportLog.sendFailure.info })
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.transportFailed(TransportLog.sendFailure.info)))
    assert.equal(log.closeCount, 1)
    assert.equal(await session.send(inputStep()), false)
    assert.ok(describeSessionSendError({ kind: "notWritten", error: TransportLog.sendFailure.info }).includes("the pond froze over"))
  })

  // sendSignpost: left out: the port has no signposts (RecordingSignposter, `submit(_:mode:signposts:)`).
})

describe("The input step's OK-code: VARINFO OKCODE under Reading R-CI-6", () => {
  /** the default trigger is the gap (#55); the R-CI-6 trigger adds a VARINFO OKCODE after the fields */
  test("okCode", () => {
    const step = inputStep()
    throwsInfo(() => step.setFunctionCode(utf8("ZZMOAT")), ClientInputError, { kind: "specGap", issue: 55 })
    assert.equal(step.functionCode, undefined)
    step.setFunctionCode(utf8("/nZZMOAT"), "varInfoOKCode")
    assert.deepStrictEqual(step.functionCode, utf8("/nZZMOAT"))
    assert.equal(step.items.length, 2)
    assert.deepStrictEqual(step.items.at(-1), { kind: "varInfoOKCode", text: utf8("/nZZMOAT") })
    assert.equal(String(step), "ClientInputStep(fields: 1, SES: no, DYNN CHL: no, OKCODE: yes)")

    const encoder = new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal)
    const { items, body } = LogonScreens.walk(ClientInput.inputMessage(encoder, step))
    assert.deepStrictEqual(
      items.map(item => item.appl),
      [ApplItem.stUser("dialogStepNumber"), ApplItem.dynt("atom"), ApplItem.varInfo("okcode"), undefined]
    )
    assert.equal(items[2].type, "appl")
    assert.deepStrictEqual(items[2].valueRange.of(body).slice(), utf8("/nZZMOAT"))
    assert.equal(items.at(-1)?.type, "eom")
  })

  /** an OK-code alone, and in a compressed step */
  test("okCodeAlone", () => {
    const step = new ClientInputStep()
    step.setFunctionCode(utf8("ZZMOAT"), "varInfoOKCode")
    assert.deepStrictEqual(step.items, [{ kind: "varInfoOKCode", text: utf8("ZZMOAT") }])
    const compressed = new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal, "lzh")
    const payload = ClientInput.inputMessage(compressed, step)
    const message = DiagMessage.parse(payload)
    assert.equal(message.body.kind, "compressed", "not compressed")
    if (message.body.kind !== "compressed") return
    const body = new Decompressor().decompress(message.body.data.of(payload), message.body.header)
    const walker = new DiagItemWalker()
    const appls: (ApplItem | undefined)[] = []
    for (let item = walker.next(body); item !== undefined; item = walker.next(body)) appls.push(item.appl)
    assert.deepStrictEqual(appls, [ApplItem.stUser("dialogStepNumber"), ApplItem.varInfo("okcode"), undefined])
  })

  /** an OK-code longer than an APPL value fails to build; nothing is sent and the counter stays */
  test("okCodeTooLong", () => {
    const step = new ClientInputStep()
    step.setFunctionCode(new Uint8Array(70_000).fill(0x5a), "varInfoOKCode")
    const encoder = new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal)
    assert.throws(() => ClientInput.inputMessage(encoder, step), ClientMessageError)
    assert.equal(encoder.lastStepNumber, 0)
  })

  /** a password field from a Secret is the same atom as from its bytes, and the step never prints it */
  test("secretField", () => {
    const field = new ReturnedField({
      block: 1,
      row: 8,
      col: 30,
      mlen: 12,
      maxNrChars: 40,
      attributes: DyntAttributes.yes3D | DyntAttributes.invisible
    })
    const fromSecret = new ClientInputStep()
    fromSecret.appendSecretField(field, new Secret(utf8("crocodile-tears")))
    const fromBytes = new ClientInputStep()
    fromBytes.appendField(field, utf8("crocodile-tears"))
    assert.deepStrictEqual(fromSecret.items, fromBytes.items)
    for (const view of [String(fromSecret), `${fromSecret}`, JSON.stringify(fromSecret), inspect(fromSecret)]) {
      assert.ok(!view.includes("crocodile"), view)
    }
  })
})
