// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/DecompressVectorRunner.swift (MIT): the `decompress`
// kind. Not imported by kinds.ts until the DiagCompression port lands (the decoders are stubs).

import { CompressionHeader, CompressionHeaderError } from "../../diag/codec/index.js"
import { CompressedDataError, LZCDecoder, LZCParameters, LZHDecoder, compressedDataErrorClass } from "../../diag/compression/index.js"
import { bytesEqual } from "../../diag/wire/index.js"
import { algorithmName, compressionHeaderErrorClass } from "./codecRunners.js"
import type { Expectations } from "./expectations.js"
import { registerKind } from "./registry.js"
import { NO_ERROR } from "./wireRunners.js"

/** What the `decompress` kind observes for one input (README, "decompress"). */
export interface DecompressOutcome {
  /** `lzh` or `lzc`, once the header decoded far enough to name the algorithm. */
  algorithm: string | undefined
  /** Header bytes 0–3, u32 LE, once the header decoded far enough. */
  uncompressedLength: number | undefined
  /** LZC only: header byte 7 bit 0x80 (PV-0312). */
  blockMode: boolean | undefined
  /** `none` or an error class. */
  errorClass: string
  /** The decompressed bytes; empty whenever `errorClass` is not `none`. */
  output: Uint8Array
}

/**
 * Runs the compression header decoder and then the LZH or LZC decoder on one input: the bytes
 * after a DIAG header whose compress byte is 1, to the end of the frame.
 */
const OUTPUT_CAP = 1 << 20 // not-protocol: README's minimum output cap, 1 MiB (IMPL-CH-5)

export const DecompressHarness = {
  /** The output cap vectors run under: the README's minimum of 1 MiB (IMPL-CH-5). */
  outputCap: OUTPUT_CAP,

  /**
   * Decodes with the given decoders (fresh ones by default), so that callers can check that reused
   * decoders behave like fresh ones.
   */
  decode(
    input: Uint8Array,
    decoders: { lzh?: LZHDecoder; lzc?: LZCDecoder } = {},
    cap: number = OUTPUT_CAP
  ): DecompressOutcome {
    const lzh = decoders.lzh ?? new LZHDecoder()
    const lzc = decoders.lzc ?? new LZCDecoder()
    const outcome: DecompressOutcome = {
      algorithm: undefined,
      uncompressedLength: undefined,
      blockMode: undefined,
      errorClass: NO_ERROR,
      output: new Uint8Array(0)
    }
    let header: CompressionHeader
    try {
      header = CompressionHeader.parse(input)
    } catch (error) {
      if (!(error instanceof CompressionHeaderError)) throw error
      outcome.errorClass = compressionHeaderErrorClass(error.info)
      // A header decoder that checks maxbits itself (IMPL-CH-4 step 4) still leaves the fields in
      // place; report them from the bytes, as the decompress kind expects them.
      if (outcome.errorClass === "bad-maxbits" && input.length >= CompressionHeader.size) {
        outcome.algorithm = algorithmName("lzc")
        outcome.uncompressedLength = (input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24)) >>> 0
        outcome.blockMode = LZCParameters.blockMode(input[CompressionHeader.size - 1])
      }
      return outcome
    }
    outcome.algorithm = algorithmName(header.algorithm)
    outcome.uncompressedLength = header.uncompressedLength
    const data = input.slice(CompressionHeader.size)
    try {
      switch (header.algorithm) {
        case "lzh":
          outcome.output = lzh.decode(data, header.uncompressedLength, cap)
          break
        case "lzc": {
          outcome.blockMode = LZCParameters.blockMode(header.byte7)
          const parameters = LZCParameters.fromHeaderByte7(header.byte7)
          outcome.output = lzc.decode(data, parameters, header.uncompressedLength, cap)
          break
        }
      }
    } catch (error) {
      if (!(error instanceof CompressedDataError)) throw error
      outcome.errorClass = compressedDataErrorClass(error.info)
      outcome.output = new Uint8Array(0)
    }
    return outcome
  }
} as const

function runDecompress(input: Uint8Array, expect: Expectations, failures: string[]): void {
  const outcome = DecompressHarness.decode(input)
  const expectedError = expect.string("expect.error")
  if (expectedError === undefined) return
  if (expectedError !== outcome.errorClass) {
    failures.push(`error: expected ${expectedError}, got ${outcome.errorClass}`)
    expect.consumeAll()
    return
  }
  // A negative vector produces no output (README, "Harness rules").
  if (outcome.errorClass !== NO_ERROR && outcome.output.length > 0)
    failures.push(`the decoder returned ${outcome.output.length} byte(s) of output together with ${outcome.errorClass}`)
  // Header fields: present unless the header itself failed before naming the algorithm.
  const algorithm = outcome.algorithm
  const uncompressedLength = outcome.uncompressedLength
  if (algorithm === undefined || uncompressedLength === undefined) return
  const expectedAlgorithm = expect.string("expect.algorithm")
  if (expectedAlgorithm !== undefined && expectedAlgorithm !== algorithm) failures.push(`algorithm: expected ${expectedAlgorithm}, got ${algorithm}`)
  const expectedLength = expect.int("expect.uncompressed_length")
  if (expectedLength !== undefined && expectedLength !== uncompressedLength)
    failures.push(`uncompressed_length: expected ${expectedLength}, got ${uncompressedLength}`)
  if (outcome.blockMode !== undefined) {
    const expected = expect.int("expect.block_mode")
    const actual = outcome.blockMode ? 1 : 0
    if (expected !== undefined && expected !== actual) failures.push(`block_mode: expected ${expected}, got ${actual}`)
  }
  if (outcome.errorClass !== NO_ERROR) return
  const expectedOutputLength = expect.int("expect.output_length")
  if (expectedOutputLength !== undefined && expectedOutputLength !== outcome.output.length)
    failures.push(`output_length: expected ${expectedOutputLength}, got ${outcome.output.length}`)
  const expectedOutput = expect.hex("expect.output")
  if (expectedOutput !== undefined && !bytesEqual(expectedOutput, outcome.output)) {
    let firstDifference = Math.min(expectedOutput.length, outcome.output.length)
    for (let index = 0; index < firstDifference; index++)
      if (expectedOutput[index] !== outcome.output[index]) {
        firstDifference = index
        break
      }
    failures.push(
      `output: expected ${expectedOutput.length} byte(s), got ${outcome.output.length}; first difference at byte ${firstDifference}`
    )
  }
}

registerKind("decompress", runDecompress)
