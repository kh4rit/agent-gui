// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/DiagSessionDriverTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ClientMessageEncoder, ClientMessageError, DiagItemWalkError, DyntAtomWalkError } from "../../../diag/codec/index.js"
import {
  DiagSession,
  DiagTransportError,
  DisconnectReason,
  MessageProblem,
  SessionMachine,
  SessionState,
  describeDiagTransportError
} from "../../../diag/session/index.js"
import { NIFrameError, NILiteral } from "../../../diag/wire/index.js"
import { attempt } from "../../support/codecTestSupport.js"
import { Fixtures, ScriptStep, ScriptedTransport, TransportLog, scriptedSession } from "../../support/sessionTestSupport.js"

describe("Session driver on a scripted transport", () => {
  /** first message, keep-alive on the way, the first screen, then the close message */
  test("fullSession", async () => {
    const screen = Fixtures.minimalScreen
    const log = new TransportLog([
      ScriptStep.pingAnswered(),
      ScriptStep.payload(NILiteral.ping),
      ScriptStep.payload(new Uint8Array(0)),
      ScriptStep.payload(NILiteral.pong),
      ScriptStep.payload(screen)
    ])
    const session = scriptedSession(log)
    assert.deepStrictEqual(session.state, SessionState.connecting)
    const first = await session.start()
    assert.ok(first !== undefined)
    assert.deepStrictEqual(first, new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal).firstMessage())
    assert.deepStrictEqual(session.state, SessionState.awaitingFirstReply)

    const message = await session.nextMessage()
    assert.ok(message !== undefined)
    assert.deepStrictEqual(message.payload, screen)
    assert.ok(message.isLogonProgram())
    assert.deepStrictEqual(session.state, SessionState.logon)
    assert.deepStrictEqual(log.sent, [first, NILiteral.pong], "the ping the session saw is answered, once")
    assert.equal(session.diagnostics.pingsAnswered, 1)
    assert.equal(session.diagnostics.pingsAnsweredByTransport, 1)
    assert.equal(session.diagnostics.pongsIgnored, 1)
    assert.equal(session.diagnostics.emptyPayloads, 1)

    const close = await session.close()
    assert.ok(close !== undefined)
    assert.deepStrictEqual(close, Fixtures.vector("diag-header/client-close.vec"))
    assert.deepStrictEqual(log.sent.at(-1), close)
    assert.equal(log.closeCount, 1)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.closedByClient))
    assert.equal(await session.close(), undefined, "closing again writes nothing")
    assert.equal(await session.nextMessage(), undefined)
    assert.equal(log.receiveCount, 5, "nothing is read after the close")
  })

  /** start twice writes the first message once */
  test("startTwice", async () => {
    const log = new TransportLog()
    const session = scriptedSession(log)
    assert.notEqual(await session.start(), undefined)
    assert.equal(await session.start(), undefined)
    assert.equal(log.sent.length, 1)
  })

  /** a failed write of the first message disconnects with the transport's error */
  test("startWriteFails", async () => {
    const log = new TransportLog([], 1)
    const session = scriptedSession(log)
    assert.equal(await session.start(), undefined)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.transportFailed(TransportLog.sendFailure.info)))
    assert.equal(log.closeCount, 1)
    assert.equal(await session.nextMessage(), undefined)
    assert.equal(log.receiveCount, 0)
  })

  /** the peer closes before any reply: nil, and the reason says so */
  test("peerClosesBeforeReply", async () => {
    const log = new TransportLog([ScriptStep.pingAnswered()])
    const session = scriptedSession(log)
    await session.start()
    assert.equal(await session.nextMessage(), undefined)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.closedByServer(false)))
    assert.equal(log.closeCount, 1)
    assert.equal(await session.close(), undefined)
    assert.equal(log.sent.length, 1, "no close message after the peer closed")
  })

  /** a read that fails disconnects with the transport's error (IMPL-NI-6) */
  test("readFails", async () => {
    const failure = new DiagTransportError({ kind: "frame", error: new NIFrameError({ kind: "truncated", streamOffset: 0, bufferedByteCount: 20 }) })
    const log = new TransportLog([ScriptStep.fail(failure)])
    const session = scriptedSession(log)
    await session.start()
    assert.equal(await session.nextMessage(), undefined)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.transportFailed(failure.info)))
    assert.equal(log.closeCount, 1)
  })

  /** a dispatcher frame ends the wait and closes the transport (IMPL-NI-10) */
  test("dispatcherFrame", async () => {
    const log = new TransportLog([ScriptStep.payload(Fixtures.vector("ni/payload-dptmmsg-14.vec")), ScriptStep.payload(Fixtures.minimalScreen)])
    const session = scriptedSession(log)
    await session.start()
    assert.equal(await session.nextMessage(), undefined)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.dispatcherFrame("dptmmsg", 14)))
    assert.equal(log.closeCount, 1)
    assert.equal(log.receiveCount, 1)
  })

  /** a pong that cannot be written disconnects */
  test("pongWriteFails", async () => {
    const log = new TransportLog([ScriptStep.payload(NILiteral.ping)], 2)
    const session = scriptedSession(log)
    await session.start()
    assert.equal(await session.nextMessage(), undefined)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.transportFailed(TransportLog.sendFailure.info)))
    assert.equal(log.closeCount, 1)
  })

  /** a close message that cannot be written: nil, the session is closed anyway, and the reason says so (#103) */
  test("closeWriteFails", async () => {
    const log = new TransportLog([ScriptStep.payload(Fixtures.minimalScreen)], 2)
    const session = scriptedSession(log)
    await session.start()
    await session.nextMessage()
    assert.equal(await session.close(), undefined)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.closeMessageNotWritten(TransportLog.sendFailure.info)))
    assert.equal(log.closeCount, 1)
  })

  /** close before start writes nothing, and the reason says that there was no close message */
  test("closeBeforeStart", async () => {
    const log = new TransportLog()
    const session = scriptedSession(log)
    assert.equal(await session.close(), undefined)
    assert.equal(log.sent.length, 0)
    assert.equal(log.sendAttempts, 0)
    assert.equal(log.closeCount, 1)
    assert.deepStrictEqual(session.state, SessionState.disconnected(DisconnectReason.closedBeforeFirstMessage))
    assert.equal(await session.start(), undefined, "a closed session never starts")
  })

  /** an undecodable message is handed over, and the wait goes on to the next */
  test("undecodableThenScreen", async () => {
    const log = new TransportLog([
      ScriptStep.payload(Fixtures.vector("diag-header/neg-unknown-compress.vec")),
      ScriptStep.payload(Fixtures.minimalScreen)
    ])
    const session = scriptedSession(log)
    await session.start()
    const bad = await session.nextMessage()
    assert.ok(bad !== undefined)
    assert.deepStrictEqual(bad.problem, { kind: "header", error: { kind: "unknownCompress", value: 4 } })
    assert.deepStrictEqual(session.state, SessionState.awaitingFirstReply)
    const good = await session.nextMessage()
    assert.ok(good !== undefined)
    assert.equal(good.number, 2)
    assert.deepStrictEqual(session.state, SessionState.logon)
  })

  /** no timeout: the wait for the reply goes on through any number of keep-alive frames (architecture.md §4) */
  test("noTimeout", async () => {
    const pings = Array.from({ length: 500 }, () => ScriptStep.payload(NILiteral.ping))
    const log = new TransportLog([...pings, ScriptStep.payload(Fixtures.minimalScreen)])
    const session = scriptedSession(log)
    await session.start()
    assert.notEqual(await session.nextMessage(), undefined)
    assert.equal(log.sent.length, 501)
    assert.equal(session.diagnostics.pingsAnswered, 500)
  })

  /** a session on a given machine keeps that machine's settings */
  test("givenMachine", async () => {
    const machine = new SessionMachine(Fixtures.identity, Fixtures.terminal, { compression: "lzh" })
    const log = new TransportLog()
    const session = new DiagSession(new ScriptedTransport(log), machine)
    const first = await session.start()
    const expected = attempt(() => new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal, "lzh").firstMessage(), ClientMessageError)
    assert.deepStrictEqual(first, expected, "CONNECT declares the compressed protocol_version; the first message itself is never compressed")
    assert.ok(session.machine.identity.equals(Fixtures.identity))
  })
})

describe("Session descriptions: classes and numbers, never payload bytes", () => {
  test("disconnectReasons", () => {
    const text = DisconnectReason.describe
    assert.equal(text(DisconnectReason.closedByClient), "closed by the client (close message, com_flag EOC)")
    assert.equal(text(DisconnectReason.closedBeforeFirstMessage), "closed by the client before its first message (no close message)")
    assert.equal(
      text(DisconnectReason.closeMessageNotWritten({ kind: "connectionFailed", reason: "reset" })),
      "closed by the client; the close message could not be written: transport failed: connection failed: reset"
    )
    assert.equal(
      text(DisconnectReason.closeMessageNotWritten({ kind: "frame", error: new NIFrameError({ kind: "payloadOverCap", length: 8, cap: 4 }) })),
      "closed by the client; the close message could not be written: transport failed: an outgoing payload of 8 bytes is above the cap of 4 (IMPL-NI-1)"
    )
    assert.equal(text(DisconnectReason.closedByServer(false)), "the server closed the connection")
    assert.equal(
      text(DisconnectReason.closedByServer(true)),
      "the server closed the connection after a message with com_flag EOC (its meaning is spec gap #7)"
    )
    assert.equal(
      text(DisconnectReason.dispatcherFrame("dptmopc", 17)),
      "dispatcher frame **DPTMOPC**, 17 bytes; the session disconnects (IMPL-NI-10, provisional until spec gap #3)"
    )
    assert.equal(text(DisconnectReason.transportFailed({ kind: "connectionFailed", reason: "reset" })), "transport failed: connection failed: reset")
    assert.ok(text(DisconnectReason.firstMessageFailed({ kind: "messageTooLong", byteCount: 9 })).startsWith("the first message could not be built: "))
  })

  test("transportErrors", () => {
    assert.equal(describeDiagTransportError({ kind: "connectFailed", reason: "refused" }), "connect failed: refused")
    assert.equal(
      describeDiagTransportError({ kind: "frame", error: new NIFrameError({ kind: "lengthOverCap", declaredLength: 99, cap: 10, streamOffset: 4 }) }),
      "a frame at stream offset 4 declares 99 bytes, above the cap of 10 (IMPL-NI-1)"
    )
    assert.equal(
      describeDiagTransportError({ kind: "frame", error: new NIFrameError({ kind: "truncated", streamOffset: 8, bufferedByteCount: 3 }) }),
      "the stream ended inside the frame at offset 8, after 3 byte(s) of it (IMPL-NI-6)"
    )
    assert.equal(
      describeDiagTransportError({ kind: "frame", error: new NIFrameError({ kind: "payloadOverCap", length: 12, cap: 11 }) }),
      "an outgoing payload of 12 bytes is above the cap of 11 (IMPL-NI-1)"
    )
    assert.equal(describeDiagTransportError({ kind: "connectionFailed", reason: "gone" }), "connection failed: gone")
  })

  test("messageProblems", () => {
    const cases: [MessageProblem, string][] = [
      [{ kind: "header", error: { kind: "truncated", availableByteCount: 3 } }, "the DIAG header is truncated: 3 of 8 bytes (IMPL-DH-1)"],
      [{ kind: "header", error: { kind: "unknownCompress", value: 9 } }, "the compress byte is none of 0-3 (IMPL-DH-2)"],
      [{ kind: "snc" }, "an SNC frame (compress 2 or 3), not decoded: encrypted connections are unsupported (IMPL-DH-3)"],
      [{ kind: "compressionHeader", error: { kind: "truncated", availableByteCount: 2 } }, "the compression header fails its decoder (IMPL-CH-4)"],
      [{ kind: "decompression", error: { kind: "dataTruncated" } }, "the compressed data does not decompress to its declared length (IMPL-CH-6)"],
      [{ kind: "errorBody", error: { kind: "missingTerminator", byteCount: 4 } }, "the error body has no 0x0C terminator (IMPL-DH-7)"],
      [
        { kind: "items", error: { kind: "items", value: new DiagItemWalkError({ kind: "unknownType", typeByte: 0x0d, itemIndex: 2, itemOffset: 7 }) } },
        "the item walk stopped: a truncated item or an unknown item type (IMPL-IT-2, IMPL-IT-5)"
      ],
      [
        { kind: "items", error: { kind: "items", value: new DiagItemWalkError({ kind: "unknownType", typeByte: 0x08, itemIndex: 2, itemOffset: 7 }) } },
        "the item walk stopped at an item whose size is unknown (spec gap #30)"
      ],
      [
        {
          kind: "items",
          error: { kind: "atoms", value: new DyntAtomWalkError({ kind: "badAtomLength", length: 5, atomIndex: 1, atomOffset: 0 }), itemIndex: 3 }
        },
        "the atom walk of item 3 stopped (IMPL-DA-3)"
      ]
    ]
    for (const [problem, text] of cases) {
      assert.equal(MessageProblem.describe(problem), text)
    }
  })

  test("states", () => {
    assert.ok(!SessionState.isDisconnected(SessionState.connecting))
    assert.ok(!SessionState.isDisconnected(SessionState.awaitingFirstReply))
    assert.ok(!SessionState.isDisconnected(SessionState.logon))
    assert.ok(SessionState.isDisconnected(SessionState.disconnected(DisconnectReason.closedByClient)))
  })
})
