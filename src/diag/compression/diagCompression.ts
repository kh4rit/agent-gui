// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/DiagCompression.swift (MIT).

// DiagCompression: the LZH and LZC data after the 8-byte compression header
// (docs/protocol/compression-lzh.md, docs/protocol/compression-lzc.md). The header itself is
// decoded by DiagCodec (`CompressionHeader`), which then calls into this module.
//
// - `LZHDecoder` decodes LZH data (algorithm nibble 2), written from compression-lzh.md; it does
//   not use zlib or any other inflater (the RFC 1951 equivalence is spec gap #26).
// - `LZCDecoder` decodes LZC data (algorithm nibble 1) with the maxbits and block-mode flag of
//   header byte 7, read by `LZCParameters`.
// - `LZHEncoder` writes LZH data following the encoder rules E-LZH-1 to E-LZH-8.
// - `CompressedDataError` is the one error type of both decoders; every case maps onto one error
//   class of test/vectors/README.md ("Error classes").

/** The rule an LZH dynamic code header broke (all fail with `bad-code-lengths`). */
export type LZHCodeLengthsFault =
  /** HLIT + 257 literal/length lengths, more than 286 (PV-0367). */
  | { kind: "literalLengthCount"; count: number }
  /** HDIST + 1 distance lengths, more than 30 (PV-0367). */
  | { kind: "distanceCount"; count: number }
  /** A run from code-length symbol 16, 17 or 18 goes past the end of its sequence (PV-0370). */
  | { kind: "runPastSequenceEnd"; sequence: LZHLengthSequence }
  /** Code-length symbol 16 is the first symbol of a sequence (PV-0370, IMPL-LZH-7, #27). */
  | { kind: "repeatWithoutPreviousLength"; sequence: LZHLengthSequence }
  /** The lengths claim more codes than exist (PV-0372). */
  | { kind: "overSubscribed"; code: LZHCode }
  /** The lengths leave codes of the longest length unassigned, including a single used symbol or none (PV-0372). */
  | { kind: "incomplete"; code: LZHCode }
  /** Symbol 256 (end of block) has length 0 in the literal/length code (PV-0372). */
  | { kind: "missingEndOfBlock" }

/** The two length sequences of an LZH dynamic code header (PV-0370). */
export type LZHLengthSequence = "literalLength" | "distance"

/** The three codes an LZH dynamic block defines (PV-0372). */
export type LZHCode = "codeLength" | "literalLength" | "distance"

/** An LZH symbol that exists only as a position in the fixed codes (PV-0358, PV-0362). */
export type LZHInvalidSymbol =
  /** Literal/length symbol 286 or 287. */
  | { kind: "literalLength"; symbol: number }
  /** Distance symbol 30 or 31. */
  | { kind: "distance"; symbol: number }

/** Why an LZC code cannot be decoded (PV-0393). */
export type LZCBadCode =
  /** The first code of the stream or after a clear is not a literal (0–255). */
  | { kind: "notALiteral"; code: number }
  /** The code is larger than next free. */
  | { kind: "beyondNextFree"; code: number; nextFree: number }

/**
 * Why compressed data failed to decode. Every case aborts the message only (IMPL-CH-6); no case
 * comes with partial output. The vector error class of each case is given in brackets.
 */
export type CompressedDataErrorInfo =
  /** The declared uncompressed length is above the caller's cap (IMPL-CH-5). [`length-over-cap`] */
  | { kind: "lengthOverCap"; declaredLength: number; cap: number }
  /** LZC maxbits (header byte 7 & 0x1F) is outside 9–16 (PV-0311, IMPL-LZC-4). [`bad-maxbits`] */
  | { kind: "badMaxbits"; maxbits: number }
  /** An LZH block type is 0 or 3 (PV-0073, PV-0356). [`bad-block-type`] */
  | { kind: "badBlockType"; blockType: number }
  /** An LZH dynamic code header is invalid (PV-0367, PV-0370, PV-0372, IMPL-LZH-7). [`bad-code-lengths`] */
  | { kind: "badCodeLengths"; fault: LZHCodeLengthsFault }
  /** An LZH literal/length symbol 286 or 287, or a distance symbol 30 or 31 (PV-0358, PV-0362). [`bad-symbol`] */
  | { kind: "badSymbol"; symbol: LZHInvalidSymbol }
  /** An LZH distance exceeds 16 122 or the bytes produced so far (PV-0071, R-LZH-5, IMPL-LZH-2). [`bad-distance`] */
  | { kind: "badDistance"; distance: number; producedLength: number }
  /** An LZC code cannot be decoded (PV-0393). [`bad-code`] */
  | { kind: "badCode"; code: LZCBadCode }
  /** The LZH data ends before the end-of-block symbol of the final block (PV-0374, IMPL-LZH-1). [`data-truncated`] */
  | { kind: "dataTruncated" }
  /**
   * The data decodes to a different length than declared (PV-0314). `decodedLength` is the length
   * reached when the stream ended (shorter), or the length a literal, match or LZC string would
   * have reached (longer); nothing is ever written past the declared length. [`length-mismatch`]
   */
  | { kind: "lengthMismatch"; declaredLength: number; decodedLength: number }

export class CompressedDataError extends Error {
  constructor(readonly info: CompressedDataErrorInfo) {
    super(`compressed data: ${JSON.stringify(info)}`)
    this.name = "CompressedDataError"
  }
}

/** The vector error class of a decoder failure (test/vectors/README.md, "Error classes"). */
export function compressedDataErrorClass(info: CompressedDataErrorInfo): string {
  switch (info.kind) {
    case "lengthOverCap":
      return "length-over-cap"
    case "badMaxbits":
      return "bad-maxbits"
    case "badBlockType":
      return "bad-block-type"
    case "badCodeLengths":
      return "bad-code-lengths"
    case "badSymbol":
      return "bad-symbol"
    case "badDistance":
      return "bad-distance"
    case "badCode":
      return "bad-code"
    case "dataTruncated":
      return "data-truncated"
    case "lengthMismatch":
      return "length-mismatch"
  }
}
