// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/LZHEncoder.swift (MIT).
// STUB: the public API is fixed; the compression port fills in the bodies.

import type { ByteWriter } from "../wire/bytes.js"

/** Why the LZH encoder refused an input. */
export type LZHEncodingErrorInfo =
  /** An empty body is never compressed; send it with compress = 0 instead (E-LZH-8, PV-0315). */
  | { kind: "emptyInput" }
  /** The input is longer than `LZHEncoder.maxInputLength`. */
  | { kind: "inputTooLong"; count: number; limit: number }

export class LZHEncodingError extends Error {
  constructor(readonly info: LZHEncodingErrorInfo) {
    super(info.kind === "emptyInput" ? "LZH: empty input is never compressed" : `LZH: input of ${info.count} bytes over the limit ${info.limit}`)
    this.name = "LZHEncodingError"
  }
}

/** Encoder heuristics. None of them changes what a decoder must accept. */
export interface LZHEncoderConfiguration {
  /** Per block, whichever of the fixed and the dynamic codes gives fewer bits; or fixed / dynamic only. */
  blockCodes: "automatic" | "fixed" | "dynamic"
  /** Literals and matches per block before a new block starts (at least 1). */
  maxSymbolsPerBlock: number
  /** Candidates the match finder looks at per position (0 disables matches). */
  maxChainLength: number
}

export const LZH_DEFAULT_MAX_SYMBOLS_PER_BLOCK = 16_384 // not-protocol: encoder heuristic
export const LZH_DEFAULT_MAX_CHAIN_LENGTH = 32 // not-protocol: encoder heuristic

/**
 * Encoder for LZH compressed data (docs/protocol/compression-lzh.md, "Encoder rules"). Appends
 * the data that follows the 8-byte compression header; the caller writes that header first
 * (DiagCodec `CompressionHeader.lzh(uncompressedLength)`). Deterministic: the same input and
 * configuration always give the same bytes.
 */
export class LZHEncoder {
  /** Longest input accepted: positions are kept as 32-bit integers. */
  static readonly maxInputLength = 0x7fffffff

  readonly configuration: LZHEncoderConfiguration

  constructor(configuration: Partial<LZHEncoderConfiguration> = {}) {
    this.configuration = {
      blockCodes: configuration.blockCodes ?? "automatic",
      maxSymbolsPerBlock: Math.max(1, configuration.maxSymbolsPerBlock ?? LZH_DEFAULT_MAX_SYMBOLS_PER_BLOCK),
      maxChainLength: Math.max(0, configuration.maxChainLength ?? LZH_DEFAULT_MAX_CHAIN_LENGTH)
    }
  }

  /** Appends the LZH data for `input` to `output` (header not included). */
  encodeInto(input: Uint8Array, output: ByteWriter): void {
    throw new Error(`not ported yet (${input.length}, ${output.length})`) // STUB
  }

  /** The LZH data for `input` (header not included). */
  encode(input: Uint8Array): Uint8Array {
    throw new Error(`not ported yet (${input.length})`) // STUB
  }
}
