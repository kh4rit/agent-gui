// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/DPHeaderVectorTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { DPHeader, DPHeaderError, NIFrameEncoder, type NIPayloadClass } from "../../../diag/wire/index.js"
import { PENDING_KINDS } from "../../vectors/kinds.js"
import { loadVector, vectorFiles } from "../../vectors/paths.js"
import { runVector } from "../../vectors/registry.js"
import { VectorFile } from "../../vectors/vectorFile.js"
import { decodeStream, dpHeaderErrorClass, payloadClassName } from "../../vectors/wireRunners.js"

const run = (vector: VectorFile) => runVector(vector, PENDING_KINDS)

/**
 * The dp-header vectors of test/vectors/dp-header (src/test/vectors.test.ts runs every vector of
 * every kind; this suite runs the DiagWire kinds on their own and adds framing checks).
 */
describe("DP header vectors", () => {
  const dpVectors = vectorFiles().filter(path => path.startsWith("test/vectors/dp-header/"))

  test("dpVectorsExist", () => {
    assert.ok(dpVectors.length >= 7)
  })

  for (const path of dpVectors) {
    test(`vectorPasses(${path})`, () => {
      const vector = loadVector(path)
      assert.equal(vector.kind, "dp-header")
      assert.deepEqual(run(vector), { status: "passed" })
    })
  }

  /**
   * Every positive vector, framed as the client's first frame, survives the NI framer under every
   * two-read split, and decodes to the same header (R-DP-2: DP length = NI length − 200).
   */
  for (const path of dpVectors) {
    test(`positiveVectorsSurviveFraming(${path})`, () => {
      const vector = loadVector(path)
      if (vector.expectations.get("expect.error") !== "none") return
      const reference = DPHeader.parseFirstMessage(vector.bytes)
      const stream = new NIFrameEncoder().encode(vector.bytes)
      for (let split = 0; split <= stream.length; split += 7) {
        const result = decodeStream(stream, [split])
        assert.equal(result.error, undefined)
        assert.ok(result.frames[0])
        const payload = result.frames[0].payload
        assert.deepEqual(DPHeader.parseFirstMessage(payload).bytes, reference.bytes)
        assert.equal(reference.length, payload.length - DPHeader.size)
      }
    })
  }

  /**
   * The runner itself notices a wrong decoder result (a runner that passes everything proves
   * nothing): a vector whose bytes are changed in the length, a filler or the terminal fails.
   */
  test("runnerNoticesChangedBytes", () => {
    const vector = loadVector("test/vectors/dp-header/first-message-testhost.vec")
    assert.deepEqual(run(vector), { status: "passed" })
    for (const position of [30, 4, 142, 81, 95, 199]) {
      const bytes = vector.bytes.slice()
      bytes[position] ^= 0x01
      const changed = new VectorFile(vector.path, vector.header, bytes)
      assert.equal(run(changed).status, "failed", `byte ${position} changed`)
    }
    const longer = new VectorFile(vector.path, vector.header, Uint8Array.from([...vector.bytes, 0]))
    assert.equal(run(longer).status, "failed", "one more body byte")
  })

  test("errorClassNames", () => {
    assert.equal(dpHeaderErrorClass(new DPHeaderError({ kind: "truncated", byteCount: 3 })), "truncated")
    assert.equal(dpHeaderErrorClass(new DPHeaderError({ kind: "lengthMismatch", declaredLength: 1, bodyLength: 2 })), "length-mismatch")
    assert.equal(dpHeaderErrorClass(new DPHeaderError({ kind: "bodyTooLong", bodyLength: -1 })), "length-over-cap")
  })

  test("payloadClassNames", () => {
    const classes: NIPayloadClass[] = [
      { kind: "empty" },
      { kind: "keepAlivePing" },
      { kind: "keepAlivePong" },
      { kind: "dispatcher", literal: "dptmmsg", payloadLength: 12 },
      { kind: "dispatcher", literal: "dptmopc", payloadLength: 17 },
      { kind: "diag" }
    ]
    assert.deepEqual(classes.map(payloadClassName), [
      "empty",
      "keepalive-ping",
      "keepalive-pong",
      "dispatcher-dptmmsg",
      "dispatcher-dptmopc",
      "diag"
    ])
  })
})
