// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/NIPayloadClassTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  DISPATCHER_LITERALS,
  NIFrameDecoder,
  NIFrameEncoder,
  NIKeepAlive,
  NILiteral,
  SpecGapIssue,
  classifyNIPayload,
  dispatcherExpectedPayloadLength,
  dispatcherLiteralBytes,
  dispatcherLiteralName,
  dispatcherTrailingByteCount,
  openSpecGap,
  receiveAction,
  type NIPayloadClass,
  type NIReceiveAction
} from "../../../diag/wire/index.js"
import { decodeStream } from "../../vectors/wireRunners.js"
import { concat, dptmmsgText, dptmopcText, drain, frame, pingText, pongText } from "./support.js"

const dispatcher = (literal: "dptmmsg" | "dptmopc", payloadLength: number): NIPayloadClass => ({ kind: "dispatcher", literal, payloadLength })
const EMPTY: NIPayloadClass = { kind: "empty" }
const PING: NIPayloadClass = { kind: "keepAlivePing" }
const PONG: NIPayloadClass = { kind: "keepAlivePong" }
const DIAG: NIPayloadClass = { kind: "diag" }

describe("NI payload classification (ni-framing.md rules 1-5)", () => {
  test("literalsMatchTheirAsciiSpelling", () => {
    assert.deepEqual(NILiteral.ping, pingText)
    assert.deepEqual(NILiteral.pong, pongText)
    assert.deepEqual(NILiteral.dptmmsg, dptmmsgText)
    assert.deepEqual(NILiteral.dptmopc, dptmopcText)
    assert.deepEqual(dispatcherLiteralBytes("dptmmsg"), dptmmsgText)
    assert.deepEqual(dispatcherLiteralBytes("dptmopc"), dptmopcText)
    assert.equal(dispatcherLiteralName("dptmmsg"), "**DPTMMSG**")
    assert.equal(dispatcherLiteralName("dptmopc"), "**DPTMOPC**")
    assert.deepEqual(DISPATCHER_LITERALS, ["dptmmsg", "dptmopc"])
  })

  test("expectedDispatcherLengthsAreTheLiteralPlusTwoOrFive", () => {
    // PV-0203, PV-0204: NI lengths 14 and 17.
    assert.equal(dispatcherExpectedPayloadLength("dptmmsg"), dptmmsgText.length + 2)
    assert.equal(dispatcherExpectedPayloadLength("dptmopc"), dptmopcText.length + 5)
  })

  test("rule1EmptyPayload", () => {
    assert.deepEqual(classifyNIPayload(new Uint8Array(0)), EMPTY)
    // (Swift's Span overload is the same function here.)
  })

  test("rule2PingIsAnExactEightByteMatch", () => {
    assert.deepEqual(classifyNIPayload(pingText), PING)
    assert.deepEqual(classifyNIPayload(pingText.subarray(0, pingText.length - 1)), DIAG, "7 bytes: no zero byte")
    assert.deepEqual(classifyNIPayload(concat(pingText, [0])), DIAG, "9 bytes: length must be exactly 8")
    assert.deepEqual(classifyNIPayload(concat([0], pingText)), DIAG)
    for (let index = 0; index < pingText.length; index++) {
      const altered = pingText.slice()
      altered[index] ^= 0x20
      assert.notDeepEqual(classifyNIPayload(altered), PING, `byte ${index} altered`)
    }
  })

  test("rule3PongIsAnExactEightByteMatch", () => {
    assert.deepEqual(classifyNIPayload(pongText), PONG)
    assert.deepEqual(classifyNIPayload(pongText.subarray(0, pongText.length - 1)), DIAG)
    assert.deepEqual(classifyNIPayload(concat(pongText, [0x5a])), DIAG)
    const altered = pongText.slice()
    altered[7] = 1
    assert.deepEqual(classifyNIPayload(altered), DIAG)
  })

  test("rule4DispatcherLiteralsArePrefixesWhateverTheLength", () => {
    // R-NI-9: the bare literal, pysap's lengths (14, 17), and any other length all classify.
    assert.deepEqual(classifyNIPayload(dptmmsgText), dispatcher("dptmmsg", 12))
    assert.deepEqual(classifyNIPayload(dptmopcText), dispatcher("dptmopc", 12))
    assert.deepEqual(classifyNIPayload(concat(dptmmsgText, [0xa1, 0xa2])), dispatcher("dptmmsg", 14))
    assert.deepEqual(classifyNIPayload(concat(dptmopcText, [1, 2, 3, 4, 5])), dispatcher("dptmopc", 17))
    const long = concat(dptmopcText, new Uint8Array(300).fill(0x7e))
    assert.deepEqual(classifyNIPayload(long), dispatcher("dptmopc", 312))
    assert.deepEqual(classifyNIPayload(dptmmsgText.subarray(0, dptmmsgText.length - 1)), DIAG, "the zero byte is part of the literal")
    assert.deepEqual(classifyNIPayload(dptmopcText.subarray(0, 5)), DIAG)
    assert.deepEqual(classifyNIPayload(concat([0x00], dptmmsgText)), DIAG, "the literal starts at offset 0")
  })

  test("rule5EverythingElseIsDiag", () => {
    assert.deepEqual(classifyNIPayload(new Uint8Array(8)), DIAG)
    assert.deepEqual(classifyNIPayload(Uint8Array.of(0x2a)), DIAG)
    assert.deepEqual(classifyNIPayload(concat([0xff], new Uint8Array(250))), DIAG, "a client never looks for a DP header (IMPL-DP-5)")
  })

  test("spanAndArrayOverloadsAgree", () => {
    // One function in the port: a view and a copy of the same bytes classify alike.
    for (const payload of [new Uint8Array(0), pingText, pongText, concat(dptmmsgText, [9]), Uint8Array.of(1, 2, 3)]) {
      const view = concat([0xee], payload).subarray(1)
      assert.deepEqual(classifyNIPayload(payload), classifyNIPayload(view))
    }
  })

  test("dispatcherTrailingByteCount", () => {
    assert.equal(dispatcherTrailingByteCount(dispatcher("dptmmsg", 14)), 2)
    assert.equal(dispatcherTrailingByteCount(dispatcher("dptmopc", 12)), 0)
    assert.equal(dispatcherTrailingByteCount(DIAG), undefined)
    assert.equal(dispatcherTrailingByteCount(PING), undefined)
  })

  test("onlyDispatcherFramesAreGapBound", () => {
    assert.equal(openSpecGap(dispatcher("dptmmsg", 14)), 3)
    assert.equal(openSpecGap(dispatcher("dptmopc", 12)), SpecGapIssue.niDispatcherFrames)
    for (const payloadClass of [EMPTY, PING, PONG, DIAG]) assert.equal(openSpecGap(payloadClass), undefined)
    assert.equal(SpecGapIssue.niDispatcherFrames, 3)
    assert.equal(SpecGapIssue.diagErrorText, 8)
  })

  test("receiveActions", () => {
    // IMPL-NI-4: reply at once with the 12-byte framed pong; IMPL-NI-8/9: ignore;
    // IMPL-NI-10 (provisional, #3): disconnect; rule 5: deliver.
    assert.deepEqual(receiveAction(PING), { kind: "reply", frame: frame(pongText) })
    assert.deepEqual(receiveAction(EMPTY), { kind: "ignore" })
    assert.deepEqual(receiveAction(PONG), { kind: "ignore" })
    assert.deepEqual(receiveAction(dispatcher("dptmopc", 17)), {
      kind: "disconnect",
      literal: "dptmopc",
      payloadLength: 17,
      provisionalUntilIssue: 3
    })
    assert.deepEqual(receiveAction(DIAG), { kind: "deliver" })
  })
})

describe("NI keep-alive", () => {
  test("pongFrameIsTheFramedPong", () => {
    // PV-0201: 00 00 00 08 then NI_PONG\0, 12 bytes.
    assert.deepEqual(NIKeepAlive.pongFrame, concat([0, 0, 0, 8], pongText))
    assert.equal(NIKeepAlive.pongFrame.length, 12)
    assert.deepEqual(new NIFrameEncoder().encode(NILiteral.pong), NIKeepAlive.pongFrame)
  })

  test("replyIsForAPingOnly", () => {
    assert.deepEqual(NIKeepAlive.replyPayload(PING), pongText)
    assert.deepEqual(NIKeepAlive.replyFrame(PING), frame(pongText))
    for (const payloadClass of [EMPTY, PONG, DIAG, dispatcher("dptmmsg", 14)]) {
      assert.equal(NIKeepAlive.replyPayload(payloadClass), undefined)
      assert.equal(NIKeepAlive.replyFrame(payloadClass), undefined)
    }
  })

  test("thePongTheClientWritesDecodesAsOneLength8Frame", () => {
    // The server's side of the exchange: the client's reply is one ordinary frame (PV-0201).
    const decoder = new NIFrameDecoder()
    decoder.append(NIKeepAlive.pongFrame)
    decoder.finish()
    const { frames, error } = drain(decoder)
    assert.equal(error, undefined)
    assert.deepEqual(frames, [{ streamOffset: 0, payload: pongText }])
    assert.ok(frames[0])
    assert.deepEqual(classifyNIPayload(frames[0].payload), PONG)
  })

  /**
   * A server stream with pings between messages, under every two-read split: each ping is
   * answered exactly once with the framed pong, and nothing else gets a reply (R-NI-4).
   */
  test("pingsBetweenMessagesAreAnsweredOnceEach", () => {
    const stream = concat(
      frame([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11]),
      frame(pingText),
      frame([]),
      frame(pongText),
      frame(pingText),
      frame(concat(dptmmsgText, [0xab, 0xcd]))
    )
    const expectedActions: NIReceiveAction[] = [
      { kind: "deliver" },
      { kind: "reply", frame: NIKeepAlive.pongFrame },
      { kind: "ignore" },
      { kind: "ignore" },
      { kind: "reply", frame: NIKeepAlive.pongFrame },
      { kind: "disconnect", literal: "dptmmsg", payloadLength: 14, provisionalUntilIssue: 3 }
    ]
    for (let split = 0; split <= stream.length; split++) {
      const result = decodeStream(stream, [split])
      assert.equal(result.error, undefined)
      const written: number[] = []
      const actions: NIReceiveAction[] = []
      for (const received of result.frames) {
        const action = receiveAction(classifyNIPayload(received.payload))
        actions.push(action)
        if (action.kind === "reply") written.push(...action.frame)
      }
      assert.deepEqual(Uint8Array.from(written), concat(NIKeepAlive.pongFrame, NIKeepAlive.pongFrame))
      assert.deepEqual(actions, expectedActions)
    }
  })
})
