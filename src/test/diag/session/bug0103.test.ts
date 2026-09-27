// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/Bug0103Tests.swift (MIT).

// Issue #103: after a failed write of the close message, the session said that the client had
// closed with its close message. SessionMachine.close() set `disconnected(closedByClient)` before
// the message was written; when DiagSession then failed to write it, `machine.transportFailed(_:)`
// left the reason alone, because the session was disconnected already. So the reason claimed a
// close message that never reached the server, and the transport's error was lost. The owner's
// report of the connect-only live mode (D20) showed it after a server-error reply, where the
// session still waits for its first screen; the same happens after the logon screen. A scripted
// transport whose second write (the close message) fails reproduces both; no live-system data is
// needed.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ComFlag } from "../../../diag/codec/index.js"
import { DisconnectReason, SessionState, describeDiagTransportError } from "../../../diag/session/index.js"
import { Fixtures, ScriptStep, TransportLog, scriptedSession } from "../../support/sessionTestSupport.js"

/** What a scripted session left behind after its close. */
interface ScriptedOutcome {
  close: Uint8Array | undefined
  state: SessionState
  log: TransportLog
}

/**
 * A session that received `reply` as the server's first reply and was in `state` then, and whose
 * write of the close message failed.
 */
async function closeFails(reply: Uint8Array, state: SessionState): Promise<ScriptedOutcome> {
  const log = new TransportLog([ScriptStep.payload(reply)], 2)
  const session = scriptedSession(log)
  assert.notEqual(await session.start(), undefined)
  assert.notEqual(await session.nextMessage(), undefined)
  assert.deepStrictEqual(session.state, state)
  const close = await session.close()
  return { close, state: session.state, log }
}

/** The close message was attempted and not written, and the reason says so and keeps the transport's error. */
function expectCloseNotWritten(outcome: ScriptedOutcome): void {
  assert.equal(outcome.close, undefined, "the close message was not written")
  assert.equal(outcome.log.sendAttempts, 2, "its write was attempted")
  assert.equal(outcome.log.sent.length, 1, "only the first message reached the transport")
  assert.equal(outcome.log.closeCount, 1, "the transport is closed anyway")
  const state = outcome.state
  assert.ok(state.kind === "disconnected", `the session is not disconnected: ${SessionState.describe(state)}`)
  const reason = state.reason
  assert.notDeepStrictEqual(reason, DisconnectReason.closedByClient, "closedByClient says that the close message was written")
  const text = DisconnectReason.describe(reason)
  assert.ok(text.includes("close message could not be written"), `the reason says that the close message was not written: ${text}`)
  const failure = describeDiagTransportError(TransportLog.sendFailure.info)
  assert.ok(text.includes(failure), `the reason names the transport's error: ${text}`)
  // Swift reflects the reason's associated values; the port's reason holds the error's info.
  const kept = Object.entries(reason)
    .filter(([key]) => key !== "kind")
    .map(([, value]) => value)
  assert.deepStrictEqual(kept, [TransportLog.sendFailure.info], `the reason keeps the transport's error class: ${text}`)
}

describe("Bug #103: a close message that could not be written is never reported as written", () => {
  /** Bug #103. */
  test("closeNotWrittenAfterTheLogonScreen", async () => {
    const outcome = await closeFails(Fixtures.minimalScreen, SessionState.logon)
    expectCloseNotWritten(outcome)
  })

  /** Bug #103. */
  test("closeNotWrittenAfterAServerError", async () => {
    // As in the owner's report: err_no 1, com_flag EOC, an error body; no screen was reached.
    const serverError = Fixtures.message(Fixtures.vector("diag-error-body/error-body-text-then-items.vec"), { comFlag: ComFlag.eoc, errNo: 1 })
    const outcome = await closeFails(serverError, SessionState.awaitingFirstReply)
    expectCloseNotWritten(outcome)
  })
})
