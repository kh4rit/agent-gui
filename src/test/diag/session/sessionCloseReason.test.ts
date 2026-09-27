// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/SessionCloseReasonTests.swift (MIT).

// Every client-initiated end of a session keeps a true reason (#103): a written close message is
// closedByClient, a close message whose write failed is closeMessageNotWritten with the
// transport's error, a close before the first message is closedBeforeFirstMessage, and a close
// after the server or the transport ended the session writes nothing and keeps that reason. The
// reproduction of the reported bug is bug0103.test.ts; these cover the machine's writeFailed(error)
// input and the driver around it. Invented texts follow docs/testing.md §8 (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ClientMessageEncoder } from "../../../diag/codec/index.js"
import {
  DiagTransportError,
  DisconnectReason,
  SessionReaction,
  SessionState,
  type SessionMachine
} from "../../../diag/session/index.js"
import { NIFrameError, NILiteral } from "../../../diag/wire/index.js"
import { Fixtures, ScriptStep, TransportLog, scriptedSession } from "../../support/sessionTestSupport.js"

describe("Session close: every client-initiated end has a true reason (#103)", () => {
  const readFailure = new DiagTransportError({ kind: "frame", error: new NIFrameError({ kind: "truncated", streamOffset: 0, bufferedByteCount: 20 }) })
  const laterFailure = new DiagTransportError({ kind: "connectionFailed", reason: "the goose sat on the cable" })

  // MARK: The machine

  /** a failed write while the session runs ends it with the transport's error, in every running state */
  test("writeFailsWhileRunning", () => {
    const logon = Fixtures.awaitingMachine()
    logon.receive({ kind: "payload", payload: Fixtures.minimalScreen })
    assert.deepStrictEqual(logon.state, SessionState.logon)
    for (const machine of [Fixtures.machine(), Fixtures.awaitingMachine(), logon.clone()]) {
      const before = SessionState.describe(machine.state)
      const reaction = machine.writeFailed(TransportLog.sendFailure)
      assert.ok(reaction.closeTransport, before)
      assert.equal(reaction.send.length, 0, before)
      assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.transportFailed(TransportLog.sendFailure.info)), before)
    }
  })

  /** a close message that cannot be written: the reason keeps the transport's error, and no later input changes it */
  test("closeMessageNotWritten", () => {
    for (const reachedLogon of [false, true]) {
      const machine = Fixtures.awaitingMachine()
      if (reachedLogon) machine.receive({ kind: "payload", payload: Fixtures.minimalScreen })
      assert.deepStrictEqual(machine.close().send, [ClientMessageEncoder.closeMessage])
      assert.deepStrictEqual(
        machine.state,
        SessionState.disconnected(DisconnectReason.closedByClient),
        "what close() asked for, until the driver reports its write"
      )
      const failure = new DiagTransportError({ kind: "frame", error: new NIFrameError({ kind: "payloadOverCap", length: 8, cap: 4 }) })
      const reaction = machine.writeFailed(failure)
      assert.ok(reaction.closeTransport)
      assert.equal(reaction.send.length, 0)
      const reason = DisconnectReason.closeMessageNotWritten(failure.info)
      assert.deepStrictEqual(machine.state, SessionState.disconnected(reason))
      assert.deepStrictEqual(machine.writeFailed(laterFailure), new SessionReaction(), "a second failure changes nothing")
      assert.deepStrictEqual(machine.transportFailed(laterFailure), new SessionReaction())
      assert.deepStrictEqual(machine.peerClosed(), new SessionReaction())
      assert.deepStrictEqual(machine.close(), new SessionReaction())
      assert.deepStrictEqual(machine.receive({ kind: "payload", payload: NILiteral.ping }), new SessionReaction(), "no pong after the end")
      assert.deepStrictEqual(machine.state, SessionState.disconnected(reason), `reached logon: ${reachedLogon}`)
    }
  })

  /** a written close message stays closedByClient, whatever the transport reports afterwards */
  test("writtenCloseStays", () => {
    const machine = Fixtures.awaitingMachine()
    assert.deepStrictEqual(machine.close().send, [ClientMessageEncoder.closeMessage])
    assert.deepStrictEqual(machine.transportFailed(readFailure), new SessionReaction(), "a read that fails after the close")
    assert.deepStrictEqual(machine.peerClosed(), new SessionReaction(), "the server closes after the close message")
    assert.deepStrictEqual(machine.close(), new SessionReaction())
    assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.closedByClient))
  })

  /** close before the first message: nothing to write, and a reported write failure changes nothing */
  test("closeBeforeFirstMessage", () => {
    const machine = Fixtures.machine()
    const reaction = machine.close()
    assert.equal(reaction.send.length, 0)
    assert.ok(reaction.closeTransport)
    assert.deepStrictEqual(machine.writeFailed(TransportLog.sendFailure), new SessionReaction())
    assert.deepStrictEqual(machine.close(), new SessionReaction())
    assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.closedBeforeFirstMessage))
  })

  /** close before the first message after a pong: no close message, and the reason does not claim that nothing was written */
  test("closeBeforeFirstMessageAfterAPong", () => {
    const machine = Fixtures.machine()
    assert.deepStrictEqual(
      machine.receive({ kind: "payload", payload: NILiteral.ping }).send,
      [NILiteral.pong],
      "a ping is answered whatever the state (IMPL-NI-4)"
    )
    assert.deepStrictEqual(machine.state, SessionState.connecting)
    const reaction = machine.close()
    assert.equal(reaction.send.length, 0, "no close message before the first message")
    assert.ok(reaction.closeTransport)
    assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.closedBeforeFirstMessage))
    const text = DisconnectReason.describe(DisconnectReason.closedBeforeFirstMessage)
    assert.equal(text, "closed by the client before its first message (no close message)")
    assert.ok(!text.includes("nothing was sent"), `a pong may have been written before: ${text}`)
  })

  /** an end by the server or the transport stays: close() writes nothing, and no later failure changes the reason */
  test("otherEndsStay", () => {
    const peerClosed = Fixtures.awaitingMachine()
    peerClosed.peerClosed()
    const readFailed = Fixtures.awaitingMachine()
    readFailed.transportFailed(readFailure)
    const dispatcher = Fixtures.awaitingMachine()
    dispatcher.receive({ kind: "payload", payload: Fixtures.vector("ni/payload-dptmmsg-14.vec") })
    const firstNotWritten = Fixtures.awaitingMachine()
    firstNotWritten.writeFailed(TransportLog.sendFailure)
    const ends: [SessionMachine, DisconnectReason][] = [
      [peerClosed, DisconnectReason.closedByServer(false)],
      [readFailed, DisconnectReason.transportFailed(readFailure.info)],
      [dispatcher, DisconnectReason.dispatcherFrame("dptmmsg", 14)],
      [firstNotWritten, DisconnectReason.transportFailed(TransportLog.sendFailure.info)]
    ]
    for (const [ended, reason] of ends) {
      const machine = ended.clone()
      const name = DisconnectReason.describe(reason)
      assert.deepStrictEqual(machine.state, SessionState.disconnected(reason))
      assert.deepStrictEqual(machine.close(), new SessionReaction(), `no close message after: ${name}`)
      assert.deepStrictEqual(machine.writeFailed(laterFailure), new SessionReaction(), name)
      assert.deepStrictEqual(machine.transportFailed(laterFailure), new SessionReaction(), name)
      assert.deepStrictEqual(machine.state, SessionState.disconnected(reason), `the reason stays: ${name}`)
    }
  })

  // MARK: The driver

  /** the close message is written before any reply: closedByClient */
  test("closeWrittenBeforeAnyReply", async () => {
    const log = new TransportLog()
    const session = scriptedSession(log)
    assert.notEqual(await session.start(), undefined)
    const close = await session.close()
    assert.ok(close !== undefined)
    assert.deepStrictEqual(close, Fixtures.vector("diag-header/client-close.vec"))
    assert.deepStrictEqual(log.sent.at(-1), close)
    assert.equal(log.closeCount, 1)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.closedByClient))
  })

  /** a close message that cannot be written before any reply: nil, the reason keeps the error, and nothing follows */
  test("closeNotWrittenBeforeAnyReply", async () => {
    const log = new TransportLog([], 2)
    const session = scriptedSession(log)
    assert.notEqual(await session.start(), undefined)
    assert.equal(await session.close(), undefined)
    const reason = DisconnectReason.closeMessageNotWritten(TransportLog.sendFailure.info)
    assert.deepStrictEqual(session.state, SessionState.disconnected(reason))
    assert.equal(log.sendAttempts, 2)
    assert.equal(log.closeCount, 1)
    assert.equal(await session.close(), undefined, "closing again writes nothing")
    assert.equal(log.sendAttempts, 2)
    assert.equal(log.closeCount, 1, "and does not close the transport again")
    assert.equal(await session.nextMessage(), undefined)
    assert.equal(log.receiveCount, 0, "nothing is read after the close")
    assert.deepStrictEqual(session.state, SessionState.disconnected(reason))
  })

  /** a pong written before start, then close: no close message, and the reason never says that nothing was sent */
  test("closeBeforeStartAfterAPong", async () => {
    const log = new TransportLog([ScriptStep.payload(NILiteral.ping), ScriptStep.payload(Fixtures.minimalScreen)])
    const session = scriptedSession(log)
    assert.notEqual(await session.nextMessage(), undefined, "the session reads before its first message")
    assert.deepStrictEqual(session.state, SessionState.connecting)
    assert.equal(await session.close(), undefined)
    assert.deepStrictEqual(log.sent, [NILiteral.pong], "the pong is the one payload written, and there is no close message")
    assert.equal(log.sendAttempts, 1)
    assert.equal(log.closeCount, 1)
    const state = session.state
    assert.ok(state.kind === "disconnected", `the session is not disconnected: ${SessionState.describe(state)}`)
    const reason = state.reason
    assert.deepStrictEqual(reason, DisconnectReason.closedBeforeFirstMessage)
    const text = DisconnectReason.describe(reason)
    assert.ok(!text.includes("nothing was sent"), `${text} after ${log.sent.length} payload(s) were written`)
    assert.ok(text.includes("no close message"), text)
  })

  /** close after the server or the transport ended the session: nothing is written, and the reason stays */
  test("closeAfterAnEnd", async () => {
    const ends: [string, TransportLog, DisconnectReason][] = [
      ["the server closes before any reply", new TransportLog([ScriptStep.pingAnswered()]), DisconnectReason.closedByServer(false)],
      [
        "the server closes after its logoff message",
        new TransportLog([ScriptStep.payload(Fixtures.minimalScreen), ScriptStep.payload(Fixtures.vector("diag-header/server-logoff.vec"))]),
        DisconnectReason.closedByServer(true)
      ],
      ["a read fails", new TransportLog([ScriptStep.fail(readFailure)]), DisconnectReason.transportFailed(readFailure.info)],
      [
        "a dispatcher frame",
        new TransportLog([ScriptStep.payload(Fixtures.vector("ni/payload-dptmmsg-14.vec"))]),
        DisconnectReason.dispatcherFrame("dptmmsg", 14)
      ],
      ["the first message cannot be written", new TransportLog([], 1), DisconnectReason.transportFailed(TransportLog.sendFailure.info)],
      [
        "a pong cannot be written",
        new TransportLog([ScriptStep.payload(NILiteral.ping)], 2),
        DisconnectReason.transportFailed(TransportLog.sendFailure.info)
      ]
    ]
    for (const [name, log, reason] of ends) {
      const session = scriptedSession(log)
      await session.start()
      while ((await session.nextMessage()) !== undefined) {
        // Read until the session ends.
      }
      assert.deepStrictEqual(session.state, SessionState.disconnected(reason), name)
      const attempts = log.sendAttempts
      assert.equal(await session.close(), undefined, name)
      assert.equal(log.sendAttempts, attempts, `no close message: ${name}`)
      assert.equal(log.closeCount, 1, `the transport was closed once: ${name}`)
      assert.deepStrictEqual(session.state, SessionState.disconnected(reason), `the reason stays: ${name}`)
    }
  })

  // closeWriteFailsSignposts: left out: it needs RecordingSignposter and session.start(signposts:), and DiagSignposts is not ported
})
