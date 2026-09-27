// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/NIRobustnessTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  NIFraming,
  WireBytes,
  bytesEqual,
  classifyNIPayload,
  hexText,
  receiveAction,
  type NIPayloadClass
} from "../../../diag/wire/index.js"
import { SeededGenerator } from "../../support/seededGenerator.js"
import { decodeStream, niFrameErrorClass, payloadClassName, type StreamDecodeResult } from "../../vectors/wireRunners.js"
import { concat, dptmmsgText, dptmopcText, frame, pingText, pongText, sameStreamResult } from "./support.js"

const INPUT_COUNT = 60_000
const CAPS = [0, 1, 7, 256, NIFraming.defaultMaxPayloadLength, 0xffff_ffff]

/**
 * A plausible stream: a few frames, some carrying the NI literals (keep-alive, dispatcher,
 * empty), before mutation cuts, grows or corrupts them.
 */
function plausibleStream(generator: SeededGenerator): Uint8Array {
  const frames: Uint8Array[] = []
  for (let count = generator.int(0, 4); count > 0; count--) {
    let payload: Uint8Array
    switch (generator.intBelow(0, 8)) {
      case 0:
        payload = pingText
        break
      case 1:
        payload = pongText
        break
      case 2:
        payload = concat(dptmmsgText, generator.bytes(generator.int(0, 5)))
        break
      case 3:
        payload = concat(dptmopcText, generator.bytes(generator.int(0, 5)))
        break
      case 4:
        payload = new Uint8Array(0)
        break
      default:
        payload = generator.bytes(generator.int(0, 40))
    }
    frames.push(frame(payload))
  }
  return concat(...frames)
}

/** Rules 1-5 checked against independent predicates, and the receive action against the class. */
function classificationHolds(payload: Uint8Array): boolean {
  const payloadClass = classifyNIPayload(payload)
  let expected: NIPayloadClass
  if (payload.length === 0) expected = { kind: "empty" }
  else if (bytesEqual(payload, pingText)) expected = { kind: "keepAlivePing" }
  else if (bytesEqual(payload, pongText)) expected = { kind: "keepAlivePong" }
  else if (WireBytes.hasPrefix(payload, dptmmsgText)) expected = { kind: "dispatcher", literal: "dptmmsg", payloadLength: payload.length }
  else if (WireBytes.hasPrefix(payload, dptmopcText)) expected = { kind: "dispatcher", literal: "dptmopc", payloadLength: payload.length }
  else expected = { kind: "diag" }
  if (JSON.stringify(payloadClass) !== JSON.stringify(expected)) return false
  const action = receiveAction(payloadClass)
  switch (action.kind) {
    case "reply":
      return payloadClass.kind === "keepAlivePing" && bytesEqual(action.frame, concat([0, 0, 0, 8], pongText))
    case "ignore":
      return payloadClass.kind === "empty" || payloadClass.kind === "keepAlivePong"
    case "disconnect":
      return (
        payloadClass.kind === "dispatcher" &&
        payloadClass.literal === action.literal &&
        payloadClass.payloadLength === action.payloadLength &&
        action.provisionalUntilIssue === 3
      )
    case "deliver":
      return payloadClass.kind === "diag"
  }
}

/** Returns whether every invariant holds. */
function check(input: Uint8Array, cap: number, oneRead: StreamDecodeResult, split: StreamDecodeResult): boolean {
  // IMPL-NI-3: the splitting does not matter.
  if (!sameStreamResult(oneRead, split)) return false
  // Frames tile the input from the start; what is left is the trailing count.
  let offset = 0
  for (const received of oneRead.frames) {
    if (
      received.payloadOffset !== offset + 4 ||
      received.payload.length > cap ||
      received.payloadOffset + received.payload.length > input.length ||
      !bytesEqual(received.payload, input.subarray(received.payloadOffset, received.payloadOffset + received.payload.length))
    )
      return false
    offset = received.payloadOffset + received.payload.length
  }
  if (offset + oneRead.trailing !== input.length) return false
  const error = oneRead.error
  if (error === undefined) return oneRead.trailing === 0
  switch (error.kind) {
    case "truncated":
      return error.bufferedByteCount === oneRead.trailing && error.bufferedByteCount > 0 && error.streamOffset === offset
    case "lengthOverCap":
      return error.declaredLength > cap && error.cap === cap && error.streamOffset === offset && oneRead.trailing >= 4
    case "payloadOverCap":
      return false
  }
}

/**
 * Deterministic robustness run (docs/testing.md §3: size caps and checked arithmetic): random and
 * mutated byte streams through the NI framer, the payload classifier and the receive action.
 * Nothing may throw, and the invariants below must hold for every input. The seed is fixed, so a
 * failure reproduces exactly.
 */
describe("NI framer robustness", () => {
  test("randomAndMutatedStreamsKeepTheInvariants", () => {
    const generator = new SeededGenerator(0x5eed_0001)
    const outcomes = new Map<string, number>()
    const classes = new Map<string, number>()
    const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)
    for (let iteration = 0; iteration < INPUT_COUNT; iteration++) {
      let input: Uint8Array
      switch (iteration % 3) {
        case 0:
          input = generator.bytes(generator.int(0, 48))
          break
        case 1:
          input = generator.mutate(plausibleStream(generator))
          break
        default:
          input = plausibleStream(generator)
      }
      const cap = CAPS[generator.intBelow(0, CAPS.length)]
      const oneRead = decodeStream(input, [], cap)
      const split = decodeStream(input, generator.cuts(input.length), cap)
      if (!check(input, cap, oneRead, split)) assert.fail(`invariant broken at iteration ${iteration}, cap ${cap}, input ${hexText(input)}`)
      bump(outcomes, oneRead.error ? niFrameErrorClass(oneRead.error) : "none")
      for (const received of oneRead.frames) {
        if (!classificationHolds(received.payload))
          assert.fail(`classification broken at iteration ${iteration}, payload ${hexText(received.payload)}`)
        bump(classes, payloadClassName(classifyNIPayload(received.payload)))
      }
    }
    // The run must exercise every outcome, or it proves little.
    const at = (map: Map<string, number>, key: string) => map.get(key) ?? 0
    const summary = JSON.stringify({ outcomes: [...outcomes], classes: [...classes] })
    assert.ok(at(outcomes, "none") > 1000, summary)
    assert.ok(at(outcomes, "truncated") > 1000, summary)
    assert.ok(at(outcomes, "length-over-cap") > 1000, summary)
    assert.ok(at(classes, "empty") > 100, summary)
    assert.ok(at(classes, "diag") > 1000, summary)
    assert.ok(at(classes, "keepalive-ping") > 100, summary)
    assert.ok(at(classes, "keepalive-pong") > 100, summary)
    assert.ok(at(classes, "dispatcher-dptmmsg") > 100, summary)
    assert.ok(at(classes, "dispatcher-dptmopc") > 100, summary)
  })
})
