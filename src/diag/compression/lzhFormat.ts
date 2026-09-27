// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/LZHFormat.swift (MIT).

/**
 * Constants and tables of the LZH format (docs/protocol/compression-lzh.md). Shared by the
 * decoder and the encoder.
 */
export const LZHFormat = {
  // MARK: Stream and block header

  /** Width of the noise count at the start of the data (PV-0072, PV-0352). */
  noiseCountBits: 2, // provenance: PV-0072, PV-0352
  /** Noise count the reference encoder writes, followed by that many 1 bits (PV-0353). */
  encoderNoiseCount: 3, // provenance: PV-0353
  /** The three noise bits the reference encoder writes, all 1 (PV-0353). */
  encoderNoiseBits: 0b111, // provenance: PV-0353
  /** Width of the block type after the 1-bit final flag (PV-0354). */
  blockTypeBits: 2, // provenance: PV-0354
  /** Block type of a block that uses the fixed codes (PV-0355). */
  fixedBlockType: 1, // provenance: PV-0355
  /** Block type of a block with a dynamic code header (PV-0355). */
  dynamicBlockType: 2, // provenance: PV-0355
  /** The byte the reference encoder appends after the zero fill of the last byte (PV-0375). */
  encoderTrailingByte: 0x00, // provenance: PV-0375

  // MARK: Alphabets

  /** Number of literal byte symbols, 0–255 (PV-0358). */
  literalCount: 256, // provenance: PV-0358
  /** The end-of-block symbol (PV-0358). */
  endOfBlock: 256, // provenance: PV-0358
  /** The first length symbol (PV-0358). */
  firstLengthSymbol: 257, // provenance: PV-0358
  /** Size of the literal/length alphabet: at most this many lengths in a dynamic header (PV-0358, PV-0367). */
  literalLengthCount: 286, // provenance: PV-0358, PV-0367
  /** Positions of the fixed literal/length code, including the invalid 286 and 287 (PV-0365). */
  fixedLiteralLengthPositions: 288, // provenance: PV-0365
  /** Size of the distance alphabet: at most this many lengths in a dynamic header (PV-0361, PV-0367). */
  distanceCount: 30, // provenance: PV-0361, PV-0367
  /** Positions of the fixed distance code, including the invalid 30 and 31 (PV-0362, PV-0365). */
  fixedDistancePositions: 32, // provenance: PV-0362, PV-0365

  // MARK: Matches

  /** Shortest match (PV-0360). */
  minMatch: 3, // provenance: PV-0360
  /** Longest match (PV-0360). */
  maxMatch: 258, // provenance: PV-0360
  /** Largest valid distance: 16 384 − 262 (PV-0070, PV-0071). */
  maxDistance: 16_122, // provenance: PV-0071
  /**
   * History size (PV-0070). The decoder keeps the whole message, so it needs no ring of this
   * size; the encoder's match finder uses it for its chain table.
   */
  windowSize: 16_384, // provenance: PV-0070

  /** Base length of length symbols 257–285 (PV-0359). */
  lengthBase: Uint16Array.of(
    3, 4, 5, 6, 7, 8, 9, 10, // provenance: PV-0359
    11, 13, 15, 17, 19, 23, 27, 31, // provenance: PV-0359
    35, 43, 51, 59, 67, 83, 99, 115, // provenance: PV-0359
    131, 163, 195, 227, 258 // provenance: PV-0359
  ),
  /** Extra bits of length symbols 257–285 (PV-0359). */
  lengthExtraBits: Uint8Array.of(
    0, 0, 0, 0, 0, 0, 0, 0, // provenance: PV-0359
    1, 1, 1, 1, 2, 2, 2, 2, // provenance: PV-0359
    3, 3, 3, 3, 4, 4, 4, 4, // provenance: PV-0359
    5, 5, 5, 5, 0 // provenance: PV-0359
  ),
  /** Base distance of distance symbols 0–29 (PV-0361). */
  distanceBase: Uint16Array.of(
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, // provenance: PV-0361
    33, 49, 65, 97, 129, 193, 257, 385, 513, 769, // provenance: PV-0361
    1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 // provenance: PV-0361
  ),
  /** Extra bits of distance symbols 0–29 (PV-0361). */
  distanceExtraBits: Uint8Array.of(
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, // provenance: PV-0361
    4, 4, 5, 5, 6, 6, 7, 7, 8, 8, // provenance: PV-0361
    9, 9, 10, 10, 11, 11, 12, 12, 13, 13 // provenance: PV-0361
  ),

  // MARK: Codes

  /** Longest literal/length and distance code (PV-0371). */
  maxCodeLength: 15, // provenance: PV-0371
  /** Longest code-length code (PV-0371). */
  maxCodeLengthCodeLength: 7, // provenance: PV-0371

  /** Fixed code length of a literal/length position 0–287 (PV-0365). */
  fixedLiteralLengthCodeLength(symbol: number): number {
    if (symbol < 144) return 8 // provenance: PV-0365
    if (symbol < 256) return 9 // provenance: PV-0365
    if (symbol < 280) return 7 // provenance: PV-0365
    return 8 // provenance: PV-0365
  },

  /** Fixed code length of every distance position 0–31 (PV-0365). */
  fixedDistanceCodeLength: 5, // provenance: PV-0365

  // MARK: Dynamic code header

  /** Width of HLIT; the literal/length length count is HLIT + 257 (PV-0366). */
  hlitBits: 5, // provenance: PV-0366
  /** Offset of the literal/length length count (PV-0366). */
  hlitBase: 257, // provenance: PV-0366
  /** Width of HDIST; the distance length count is HDIST + 1 (PV-0366). */
  hdistBits: 5, // provenance: PV-0366
  /** Width of HCLEN; the code-length code length count is HCLEN + 4 (PV-0366). */
  hclenBits: 4, // provenance: PV-0366
  /** Offset of the code-length code length count (PV-0366). */
  hclenBase: 4, // provenance: PV-0366
  /** Width of each code-length code length (PV-0368). */
  codeLengthCodeLengthBits: 3, // provenance: PV-0368
  /** Number of code-length symbols (PV-0368). */
  codeLengthSymbolCount: 19, // provenance: PV-0368
  /** Order in which the code-length code lengths are sent (PV-0368). */
  codeLengthOrder: Uint8Array.of(
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 // provenance: PV-0368
  ),
  /** Largest code-length symbol that is a length itself (PV-0369). */
  largestLiteralCodeLength: 15, // provenance: PV-0369
  /** Code-length symbol: repeat the previous length 3–6 times, 2 extra bits (PV-0369). */
  repeatPrevious: 16, // provenance: PV-0369
  repeatPreviousExtraBits: 2, // provenance: PV-0369
  repeatPreviousBase: 3, // provenance: PV-0369
  /** Code-length symbol: 3–10 zeros, 3 extra bits (PV-0369). */
  repeatZeroShort: 17, // provenance: PV-0369
  repeatZeroShortExtraBits: 3, // provenance: PV-0369
  repeatZeroShortBase: 3, // provenance: PV-0369
  /** Code-length symbol: 11–138 zeros, 7 extra bits (PV-0369). */
  repeatZeroLong: 18, // provenance: PV-0369
  repeatZeroLongExtraBits: 7, // provenance: PV-0369
  repeatZeroLongBase: 11 // provenance: PV-0369
} as const
