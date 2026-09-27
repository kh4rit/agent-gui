// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCompressionTests/CompressionRobustnessTests.swift (MIT).
//
// Not ported: `wholeMessagesThroughTheHarness`, which runs mutated decompress vectors through
// DiagCodec's CompressionHeader decoder (the decompress harness); it belongs with the DiagCodec
// port.

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { LZCDecoder, LZHDecoder, LZHEncoder, compressedDataErrorClass } from "../../../diag/compression/index.js"
import { SeededGenerator } from "../../support/seededGenerator.js"
import { loadVector, vectorFiles } from "../../vectors/paths.js"
import { LZCTestEncoder, Samples, decodeLZC, decodeLZH, repeated, type DecodeResult } from "./testSupport.js"

const ITERATIONS_PER_ALGORITHM = 30_000

function lzhSeeds(): Uint8Array[] {
  const seeds: Uint8Array[] = []
  const inputs = [Samples.silly, Samples.screenLike(1_500, 5), Samples.random(300, 6), repeated(7, 900)]
  inputs.forEach((input, index) => {
    for (const blockCodes of ["fixed", "dynamic", "automatic"] as const) {
      const encoder = new LZHEncoder({ blockCodes, maxSymbolsPerBlock: 50 + index * 40 })
      seeds.push(encoder.encode(input))
    }
  })
  // The decompress vectors' data (after the 8-byte header).
  for (const path of vectorFiles()) {
    const vector = loadVector(path)
    if (vector.kind === "decompress" && vector.bytes.length > 8 && (vector.bytes[4] & 0x0f) === 2) seeds.push(vector.bytes.slice(8))
  }
  return seeds
}

const errorClass = (result: DecodeResult): string => (result.error ? compressedDataErrorClass(result.error) : "none")

function count(classes: Map<string, number>, name: string): void {
  classes.set(name, (classes.get(name) ?? 0) + 1)
}

/**
 * Seeded robustness: mutated and random inputs must never throw anything but the decoders' error,
 * and the decoders' contract must hold for every one: success gives exactly the declared length,
 * failure gives no output, and a decoder reused across messages behaves like a fresh one
 * (IMPL-CH-6: each message on its own).
 */
describe("Compression robustness", () => {
  test("lzhNeverTrapsAndKeepsItsContract", () => {
    const seeds = lzhSeeds()
    const generator = new SeededGenerator(0x1a2b_3c4d)
    const decoder = new LZHDecoder()
    const classes = new Map<string, number>()
    for (let iteration = 0; iteration < ITERATIONS_PER_ALGORITHM; iteration++) {
      const seed = seeds[iteration % seeds.length]
      const data = iteration % 8 === 7 ? generator.bytes(generator.int(0, 96)) : generator.mutate(seed)
      const declared = generator.int(0, 3_000)
      const result = decodeLZH(data, declared, undefined, decoder)
      if (result.bytes) assert.equal(result.bytes.length, declared)
      if (iteration % 101 === 0) {
        assert.deepEqual(decodeLZH(data, declared), result, `reused decoder differs at iteration ${iteration}`)
        // Swift also decodes into a caller-sized MutableSpan here; that overload collapses into
        // decode(data, declaredLength, maxLength), checked just above.
      }
      count(classes, errorClass(result))
    }
    // The mutations reach every data error class of LZH.
    for (const name of ["none", "bad-block-type", "bad-code-lengths", "bad-symbol", "bad-distance", "data-truncated", "length-mismatch"])
      assert.ok((classes.get(name) ?? 0) > 0, `no input gave ${name}: ${JSON.stringify([...classes])}`)
  })

  test("lzhExactLengthsDecodeAfterMutation", () => {
    // With the true declared length, unmutated seeds must decode; mutated ones either decode to
    // that length or fail cleanly.
    const seeds = lzhSeeds()
    const generator = new SeededGenerator(99)
    const decoder = new LZHDecoder()
    for (let iteration = 0; iteration < 5_000; iteration++) {
      const seed = seeds[iteration % seeds.length]
      const reference = decodeLZH(seed, 1 << 20, undefined, decoder)
      if (reference.error?.kind !== "lengthMismatch" || reference.error.decodedLength >= 1 << 20) continue
      const length = reference.error.decodedLength
      assert.equal(decodeLZH(seed, length, undefined, decoder).bytes?.length, length)
      const mutated = generator.mutate(seed)
      const bytes = decodeLZH(mutated, length, undefined, decoder).bytes
      if (bytes) assert.equal(bytes.length, length)
    }
  })

  test("lzcNeverTrapsAndKeepsItsContract", () => {
    const generator = new SeededGenerator(0x5eed)
    const seeds: { data: Uint8Array; maxbits: number; blockMode: boolean }[] = []
    for (const maxbits of [9, 10, 13, 16]) {
      for (const blockMode of [true, false]) {
        const input = Samples.screenLike(1_200, maxbits)
        const clearEvery = blockMode && maxbits === 10 ? 40 : undefined
        seeds.push({ data: new LZCTestEncoder({ maxbits, blockMode, clearEvery }).encode(input), maxbits, blockMode })
      }
    }
    const decoder = new LZCDecoder()
    const classes = new Map<string, number>()
    for (let iteration = 0; iteration < ITERATIONS_PER_ALGORITHM; iteration++) {
      const seed = seeds[iteration % seeds.length]
      const data = iteration % 8 === 7 ? generator.bytes(generator.int(0, 96)) : generator.mutate(seed.data)
      const declared = generator.int(0, 1_500)
      const maxbits = iteration % 3 === 0 ? generator.uint8(9, 16) : seed.maxbits
      const result = decodeLZC(data, declared, { maxbits, blockMode: seed.blockMode, decoder })
      if (result.bytes) assert.equal(result.bytes.length, declared)
      if (iteration % 101 === 0) assert.deepEqual(decodeLZC(data, declared, { maxbits, blockMode: seed.blockMode }), result)
      count(classes, errorClass(result))
    }
    for (const name of ["none", "bad-code", "length-mismatch"])
      assert.ok((classes.get(name) ?? 0) > 0, `no input gave ${name}: ${JSON.stringify([...classes])}`)
  })
})
