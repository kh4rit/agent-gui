// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/NIVectorTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { PENDING_KINDS } from "../../vectors/kinds.js"
import { loadVector, vectorFiles } from "../../vectors/paths.js"
import { runVector } from "../../vectors/registry.js"
import { decodeStream } from "../../vectors/wireRunners.js"
import { SeededGenerator } from "../../support/seededGenerator.js"
import { concat, sameStreamResult } from "./support.js"

/** Every read one byte long (Swooey's `StreamHarness.decodeByteByByte`). */
const decodeByteByByte = (input: Uint8Array) =>
  decodeStream(
    input,
    Array.from({ length: Math.max(0, input.length - 1) }, (_, i) => i + 1)
  )

/**
 * The ni-stream and ni-payload vectors of test/vectors/ni. (src/test/vectors.test.ts runs every
 * vector of every kind; this suite adds the exhaustive splitting that IMPL-NI-3 asks for.)
 */
describe("NI vectors", () => {
  const niVectors = vectorFiles().filter(path => path.startsWith("test/vectors/ni/"))

  test("niVectorsExist", () => {
    assert.ok(niVectors.length >= 24)
  })

  for (const path of niVectors) {
    test(`vectorPasses(${path})`, () => {
      const vector = loadVector(path)
      assert.ok(["ni-stream", "ni-payload"].includes(vector.kind))
      assert.deepEqual(runVector(vector, PENDING_KINDS), { status: "passed" })
    })
  }

  /**
   * IMPL-NI-3: every ni-stream vector, split into three reads at every pair of positions, and
   * into random numbers of reads, gives exactly the one-read result.
   */
  for (const path of niVectors) {
    test(`everySplittingGivesTheSameResult(${path})`, () => {
      const vector = loadVector(path)
      if (vector.kind !== "ni-stream") return
      const input = vector.bytes
      const reference = decodeStream(input)
      let checked = 0
      for (let first = 0; first <= input.length; first++) {
        for (let second = first; second <= input.length; second++) {
          const result = decodeStream(input, [first, second])
          if (!sameStreamResult(result, reference))
            assert.fail(`${path}: cuts at ${first} and ${second} give ${JSON.stringify(result)}, one read gives ${JSON.stringify(reference)}`)
          checked += 1
        }
      }
      const generator = new SeededGenerator(BigInt(input.length) * 7919n)
      for (let round = 0; round < 500; round++) {
        const cuts = generator.cuts(input.length)
        assert.ok(sameStreamResult(decodeStream(input, cuts), reference), `cuts ${cuts}`)
      }
      assert.equal(checked, ((input.length + 1) * (input.length + 2)) / 2)
    })
  }

  /**
   * The same, for streams built from the vectors' frames back to back (multi-frame streams whose
   * frames straddle every boundary).
   */
  test("concatenatedVectorStreamsSplitAnywhere", () => {
    const streams: Uint8Array[] = []
    const expectedPayloads: Uint8Array[] = []
    for (const path of niVectors) {
      const vector = loadVector(path)
      if (vector.kind !== "ni-stream" || vector.expectations.get("expect.error") !== "none") continue
      const result = decodeStream(vector.bytes)
      streams.push(vector.bytes)
      expectedPayloads.push(...result.frames.map(f => f.payload))
    }
    const stream = concat(...streams)
    assert.ok(expectedPayloads.length >= 7)
    const reference = decodeStream(stream)
    assert.equal(reference.error, undefined)
    assert.deepEqual(
      reference.frames.map(f => f.payload),
      expectedPayloads
    )
    for (let position = 0; position <= stream.length; position++)
      assert.ok(sameStreamResult(decodeStream(stream, [position]), reference), `split at ${position}`)
    assert.ok(sameStreamResult(decodeByteByByte(stream), reference))
  })
})
