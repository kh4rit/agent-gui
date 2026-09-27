// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/LZHEncoder.swift (MIT).

import { ByteWriter } from "../wire/bytes.js"
import { HuffmanDecodeTable } from "./huffmanDecodeTable.js"
import { LZHFormat } from "./lzhFormat.js"

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
  /**
   * Which codes blocks use: per block, whichever of the fixed and the dynamic codes gives fewer
   * bits (`automatic`); fixed codes only (block type 1); or dynamic codes only (block type 2).
   */
  blockCodes: "automatic" | "fixed" | "dynamic"
  /** Literals and matches per block before a new block starts (at least 1). */
  maxSymbolsPerBlock: number
  /** Candidates the match finder looks at per position (0 disables matches). */
  maxChainLength: number
}

export const LZH_DEFAULT_MAX_SYMBOLS_PER_BLOCK = 16_384 // not-protocol: encoder heuristic
export const LZH_DEFAULT_MAX_CHAIN_LENGTH = 32 // not-protocol: encoder heuristic

/**
 * Encoder for LZH compressed data (docs/protocol/compression-lzh.md, "Encoder rules").
 *
 * `encodeInto` appends the data that follows the 8-byte compression header. The caller writes
 * that header first, with DiagCodec: `CompressionHeader.lzh(uncompressedLength)` gives algorithm
 * byte 0x12, magic `1F 9D`, byte 7 = 2 and the exact input length (E-LZH-1).
 *
 * What the output follows:
 * - E-LZH-2: noise count 3 and three 1 bits, so bits 0–4 of the first byte are set (PV-0353);
 * - E-LZH-3: fixed-code (type 1) and dynamic-code (type 2) blocks only;
 * - E-LZH-4: every distance ≤ 16 122 and ≤ the bytes already produced; lengths 3–258, with
 *   258 always sent as symbol 285;
 * - E-LZH-5: dynamic codes complete, each with at least two used symbols, lengths ≤ 15
 *   (code-length code ≤ 7), symbol 256 used, HLIT + 257 ≤ 286, HDIST + 1 ≤ 30, no run across
 *   the two length sequences and no symbol 16 at the start of either;
 * - E-LZH-6: the final flag on the last block, zero bits to the byte boundary, then one 0x00;
 * - E-LZH-7: every call starts with an empty history;
 * - E-LZH-8: empty input is refused (`LZHEncodingError`, `emptyInput`).
 *
 * How matches are searched and where blocks end are encoder heuristics, not format rules
 * (`LZHEncoderConfiguration`). The encoder is deterministic: the same input and configuration
 * always give the same bytes.
 */
export class LZHEncoder {
  /**
   * Longest input accepted: positions are kept as 32-bit integers. (The header's length field is
   * u32 LE, PV-0062; this limit is lower.)
   */
  static readonly maxInputLength = 0x7fffffff

  readonly configuration: LZHEncoderConfiguration
  /** Most recent position per hash of three bytes, or -1. */
  private readonly head = new Int32Array(MatchFinder.hashSize).fill(-1)
  /** Previous position with the same hash, per position modulo the window size. */
  private readonly chain = new Int32Array(LZHFormat.windowSize).fill(-1)
  /** The current block's literals and matches (`Token`). */
  private tokens = new Uint32Array(1024)
  private tokenCount = 0

  constructor(configuration: Partial<LZHEncoderConfiguration> = {}) {
    this.configuration = {
      blockCodes: configuration.blockCodes ?? "automatic",
      maxSymbolsPerBlock: Math.max(1, configuration.maxSymbolsPerBlock ?? LZH_DEFAULT_MAX_SYMBOLS_PER_BLOCK),
      maxChainLength: Math.max(0, configuration.maxChainLength ?? LZH_DEFAULT_MAX_CHAIN_LENGTH)
    }
  }

  /** Appends the LZH data for `input` to `output` (header not included). */
  encodeInto(input: Uint8Array, output: ByteWriter): void {
    if (input.length === 0) throw new LZHEncodingError({ kind: "emptyInput" })
    if (input.length > LZHEncoder.maxInputLength)
      throw new LZHEncodingError({ kind: "inputTooLong", count: input.length, limit: LZHEncoder.maxInputLength })
    this.encodeData(input, new LZHBitWriter(output))
  }

  /** The LZH data for `input` (header not included). */
  encode(input: Uint8Array): Uint8Array {
    const output = new ByteWriter(Math.max(64, input.length >>> 1))
    this.encodeInto(input, output)
    return output.toBytes()
  }

  // MARK: Matching

  private encodeData(input: Uint8Array, writer: LZHBitWriter): void {
    // E-LZH-2: noise count 3, then three 1 bits (PV-0353).
    writer.write(LZHFormat.encoderNoiseCount, LZHFormat.noiseCountBits)
    writer.write(LZHFormat.encoderNoiseBits, LZHFormat.encoderNoiseCount)
    // E-LZH-7: an empty history for every message.
    this.head.fill(-1)
    this.tokenCount = 0

    const count = input.length
    let position = 0
    while (position < count) {
      let bestLength = 0
      let bestDistance = 0
      if (count - position >= LZHFormat.minMatch) {
        const hash = MatchFinder.hash(input, position)
        const match = this.longestMatch(input, position, this.head[hash])
        bestLength = match.length
        bestDistance = match.distance
        this.insert(position, hash)
      }
      if (bestLength >= LZHFormat.minMatch) {
        this.appendToken(Token.match(bestLength, bestDistance))
        for (let next = position + 1; next < position + bestLength; next++)
          if (count - next >= LZHFormat.minMatch) this.insert(next, MatchFinder.hash(input, next))
        position += bestLength
      } else {
        this.appendToken(input[position])
        position += 1
      }
      if (this.tokenCount >= this.configuration.maxSymbolsPerBlock && position < count) this.writeBlock(false, writer)
    }
    this.writeBlock(true, writer)
    // E-LZH-6: zero bits to the byte boundary, then one 0x00 byte (PV-0375).
    writer.flush()
    writer.output.u8(LZHFormat.encoderTrailingByte)
  }

  private appendToken(token: number): void {
    if (this.tokenCount === this.tokens.length) {
      const grown = new Uint32Array(this.tokens.length * 2)
      grown.set(this.tokens)
      this.tokens = grown
    }
    this.tokens[this.tokenCount++] = token
  }

  private insert(position: number, hash: number): void {
    this.chain[position & (LZHFormat.windowSize - 1)] = this.head[hash]
    this.head[hash] = position
  }

  /**
   * The longest earlier match for `position`, following the hash chain from `first`. Only
   * distances ≤ 16 122 and ≤ `position` are considered (E-LZH-4).
   */
  private longestMatch(input: Uint8Array, position: number, first: number): { length: number; distance: number } {
    const limit = Math.min(LZHFormat.maxMatch, input.length - position)
    let bestLength = 0
    let bestDistance = 0
    let candidate = first
    let remaining = this.configuration.maxChainLength
    while (candidate >= 0 && remaining > 0) {
      const distance = position - candidate
      // Candidates only get older along the chain, so the first one out of range ends it.
      // Within range, the chain slot cannot have been reused: that needs a position at least
      // `windowSize` later, which is beyond `position`.
      if (distance > LZHFormat.maxDistance) break
      if (input[candidate + bestLength] === input[position + bestLength]) {
        let length = 0
        while (length < limit && input[candidate + length] === input[position + length]) length += 1
        if (length > bestLength) {
          bestLength = length
          bestDistance = distance
          if (length === limit) break
        }
      }
      candidate = this.chain[candidate & (LZHFormat.windowSize - 1)]
      remaining -= 1
    }
    return { length: bestLength, distance: bestDistance }
  }

  // MARK: Blocks

  private writeBlock(isFinal: boolean, writer: LZHBitWriter): void {
    const literalLengthFrequencies = new Uint32Array(LZHFormat.literalLengthCount)
    const distanceFrequencies = new Uint32Array(LZHFormat.distanceCount)
    for (let index = 0; index < this.tokenCount; index++) {
      const token = this.tokens[index]
      if (Token.isMatch(token)) {
        literalLengthFrequencies[LZHFormat.firstLengthSymbol + Symbols.lengthIndex(Token.length(token))] += 1
        distanceFrequencies[Symbols.distanceIndex(Token.distance(token))] += 1
      } else {
        literalLengthFrequencies[token] += 1
      }
    }
    literalLengthFrequencies[LZHFormat.endOfBlock] = 1

    let dynamic: DynamicCodes | undefined
    switch (this.configuration.blockCodes) {
      case "fixed":
        dynamic = undefined
        break
      case "dynamic":
        dynamic = new DynamicCodes(literalLengthFrequencies, distanceFrequencies)
        break
      case "automatic": {
        const codes = new DynamicCodes(literalLengthFrequencies, distanceFrequencies)
        const smaller =
          codes.cost(literalLengthFrequencies, distanceFrequencies) < FixedCodes.cost(literalLengthFrequencies, distanceFrequencies)
        dynamic = smaller ? codes : undefined
        break
      }
    }

    writer.write(isFinal ? 1 : 0, 1)
    if (dynamic) {
      writer.write(LZHFormat.dynamicBlockType, LZHFormat.blockTypeBits)
      dynamic.writeHeader(writer)
      this.writeSymbols(dynamic.literalLengthCodes, dynamic.distanceCodes, writer)
    } else {
      writer.write(LZHFormat.fixedBlockType, LZHFormat.blockTypeBits)
      this.writeSymbols(FixedCodes.literalLength, FixedCodes.distance, writer)
    }
    this.tokenCount = 0
  }

  private writeSymbols(literalLength: readonly Code[], distance: readonly Code[], writer: LZHBitWriter): void {
    for (let index = 0; index < this.tokenCount; index++) {
      const token = this.tokens[index]
      if (Token.isMatch(token)) {
        // Length symbol, its extra bits, distance symbol, its extra bits (PV-0373).
        const length = Token.length(token)
        const lengthIndex = Symbols.lengthIndex(length)
        writer.writeCode(literalLength[LZHFormat.firstLengthSymbol + lengthIndex])
        writer.write(length - LZHFormat.lengthBase[lengthIndex], LZHFormat.lengthExtraBits[lengthIndex])
        const offset = Token.distance(token)
        const distanceIndex = Symbols.distanceIndex(offset)
        writer.writeCode(distance[distanceIndex])
        writer.write(offset - LZHFormat.distanceBase[distanceIndex], LZHFormat.distanceExtraBits[distanceIndex])
      } else {
        writer.writeCode(literalLength[token])
      }
    }
    writer.writeCode(literalLength[LZHFormat.endOfBlock])
  }
}

// MARK: - Encoder internals

/**
 * A block symbol: a literal byte (bit 31 clear, value 0–255), or a match with bit 31 set, the
 * length in bits 16–24 and the distance in bits 0–15.
 */
const Token = {
  matchFlag: 0x8000_0000, // not-protocol: token layout
  lengthShift: 16, // not-protocol: token layout
  fieldMask: 0xffff, // not-protocol: token layout

  match(length: number, distance: number): number {
    return (Token.matchFlag | (length << Token.lengthShift) | distance) >>> 0
  },

  isMatch(token: number): boolean {
    return (token & Token.matchFlag) !== 0
  },

  length(token: number): number {
    return (token >>> Token.lengthShift) & Token.fieldMask & ~(Token.matchFlag >>> Token.lengthShift)
  },

  distance(token: number): number {
    return token & Token.fieldMask
  }
} as const

/** Hashing for the match finder (heuristic, not protocol). */
const MatchFinder = {
  hashBits: 15, // not-protocol: hash table size
  hashSize: 1 << 15, // not-protocol: hash table size
  hashShift: 5, // not-protocol: hash mixing

  hash(input: Uint8Array, position: number): number {
    return (
      ((input[position] << (2 * MatchFinder.hashShift)) ^ (input[position + 1] << MatchFinder.hashShift) ^ input[position + 2]) & // not-protocol: hash mixing
      (MatchFinder.hashSize - 1)
    )
  }
} as const

/** Symbol lookup for lengths and distances (PV-0359, PV-0361). */
const Symbols = {
  /**
   * Index 0–28 of the length symbol (257–285) for a length 3–258. 258 is always symbol 285,
   * never 284 with extra value 31 (E-LZH-4, R-LZH-2).
   */
  lengthIndexTable: (() => {
    const table = new Uint8Array(LZHFormat.maxMatch + 1)
    for (let index = 0; index < LZHFormat.lengthBase.length; index++) {
      const base = LZHFormat.lengthBase[index]
      const span = 1 << LZHFormat.lengthExtraBits[index]
      for (let length = base; length < Math.min(base + span, LZHFormat.maxMatch + 1); length++) table[length] = index
    }
    return table
  })(),

  lengthIndex(length: number): number {
    return Symbols.lengthIndexTable[length]
  },

  /** Index 0–29 of the distance symbol for a distance 1–16 122. */
  distanceIndex(distance: number): number {
    let low = 0
    let high = LZHFormat.distanceBase.length - 1
    while (low < high) {
      const middle = (low + high + 1) >>> 1 // not-protocol: binary search
      if (LZHFormat.distanceBase[middle] <= distance) low = middle
      else high = middle - 1
    }
    return low
  }
} as const

/**
 * A code word ready for the bit writer: the code bit-reversed (codes are sent most significant
 * bit first, PV-0363) and its length.
 */
interface Code {
  readonly reversed: number
  readonly length: number
}

const NO_CODE: Code = { reversed: 0, length: 0 }

/** Canonical codes from code lengths (PV-0364). */
const CanonicalCodes = {
  make(lengths: ArrayLike<number>): Code[] {
    const counts = new Int32Array(LZHFormat.maxCodeLength + 1)
    for (let symbol = 0; symbol < lengths.length; symbol++) if (lengths[symbol] > 0) counts[lengths[symbol]] += 1
    const nextCode = new Int32Array(LZHFormat.maxCodeLength + 1)
    let code = 0
    for (let length = 1; length <= LZHFormat.maxCodeLength; length++) {
      code = (code + counts[length - 1]) << 1
      nextCode[length] = code
    }
    const codes: Code[] = new Array<Code>(lengths.length).fill(NO_CODE)
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      const length = lengths[symbol]
      if (length === 0) continue
      codes[symbol] = { reversed: HuffmanDecodeTable.reverse(nextCode[length], length), length }
      nextCode[length] += 1
    }
    return codes
  }
} as const

/** The fixed codes (PV-0365). */
const FixedCodes = (() => {
  const literalLength = CanonicalCodes.make(
    Array.from({ length: LZHFormat.fixedLiteralLengthPositions }, (_, symbol) => LZHFormat.fixedLiteralLengthCodeLength(symbol))
  )
  const distance = CanonicalCodes.make(new Uint8Array(LZHFormat.fixedDistancePositions).fill(LZHFormat.fixedDistanceCodeLength))
  return {
    literalLength,
    distance,
    /** Bits the block's symbols take with the fixed codes (extra bits excluded: they are the same with either code). */
    cost(literalLengthFrequencies: Uint32Array, distanceFrequencies: Uint32Array): number {
      let bits = 0
      for (let symbol = 0; symbol < literalLengthFrequencies.length; symbol++)
        bits += literalLengthFrequencies[symbol] * literalLength[symbol].length
      for (let symbol = 0; symbol < distanceFrequencies.length; symbol++) bits += distanceFrequencies[symbol] * distance[symbol].length
      return bits
    }
  } as const
})()

/** A run-length coded length: code-length symbol and extra-bit value. */
interface LengthSymbol {
  readonly symbol: number
  readonly extra: number
}

/** A dynamic code header and its codes for one block (E-LZH-5). */
class DynamicCodes {
  readonly literalLengthLengths: Uint8Array
  readonly distanceLengths: Uint8Array
  readonly codeLengthLengths: Uint8Array
  /** The run-length coded length sequences: code-length symbol and extra-bit value. */
  readonly lengthSymbols: LengthSymbol[]
  readonly literalLengthCount: number
  readonly distanceCount: number
  readonly codeLengthCount: number
  readonly literalLengthCodes: Code[]
  readonly distanceCodes: Code[]
  readonly codeLengthCodes: Code[]

  constructor(literalLength: Uint32Array, distance: Uint32Array) {
    this.literalLengthLengths = HuffmanLengths.make(literalLength, LZHFormat.maxCodeLength)
    this.distanceLengths = HuffmanLengths.make(distance, LZHFormat.maxCodeLength)
    // Both codes have at least two used symbols, so the scans below stop inside the arrays.
    let literalLengthCount = this.literalLengthLengths.length
    while (this.literalLengthLengths[literalLengthCount - 1] === 0) literalLengthCount -= 1
    this.literalLengthCount = Math.max(LZHFormat.hlitBase, literalLengthCount)
    let distanceCount = this.distanceLengths.length
    while (this.distanceLengths[distanceCount - 1] === 0) distanceCount -= 1
    this.distanceCount = distanceCount
    // Two separate sequences: no run crosses from one into the other (PV-0370).
    this.lengthSymbols = [
      ...DynamicCodes.runLengths(this.literalLengthLengths.subarray(0, this.literalLengthCount)),
      ...DynamicCodes.runLengths(this.distanceLengths.subarray(0, distanceCount))
    ]
    const codeLengthFrequencies = new Uint32Array(LZHFormat.codeLengthSymbolCount)
    for (const { symbol } of this.lengthSymbols) codeLengthFrequencies[symbol] += 1
    const codeLengthLengths = HuffmanLengths.make(codeLengthFrequencies, LZHFormat.maxCodeLengthCodeLength)
    // Send the code-length code lengths up to the last nonzero one in the fixed order, and never
    // fewer than HCLEN + 4 = 4 (PV-0366, PV-0368).
    let codeLengthCount: number = LZHFormat.codeLengthSymbolCount
    while (codeLengthCount > LZHFormat.hclenBase && codeLengthLengths[LZHFormat.codeLengthOrder[codeLengthCount - 1]] === 0)
      codeLengthCount -= 1
    this.codeLengthLengths = codeLengthLengths
    this.codeLengthCount = codeLengthCount
    this.literalLengthCodes = CanonicalCodes.make(this.literalLengthLengths)
    this.distanceCodes = CanonicalCodes.make(this.distanceLengths)
    this.codeLengthCodes = CanonicalCodes.make(codeLengthLengths)
  }

  /**
   * Run-length codes one sequence with code-length symbols 0–18 (PV-0369). Every sequence
   * starts with a literal length or a zero run, never with 16 (IMPL-LZH-7).
   */
  static runLengths(lengths: Uint8Array): LengthSymbol[] {
    const symbols: LengthSymbol[] = []
    let index = 0
    while (index < lengths.length) {
      const length = lengths[index]
      let run = 1
      while (index + run < lengths.length && lengths[index + run] === length) run += 1
      index += run
      if (length === 0) {
        while (run >= LZHFormat.repeatZeroLongBase) {
          const chunk = Math.min(run, LZHFormat.repeatZeroLongBase + (1 << LZHFormat.repeatZeroLongExtraBits) - 1)
          symbols.push({ symbol: LZHFormat.repeatZeroLong, extra: chunk - LZHFormat.repeatZeroLongBase })
          run -= chunk
        }
        if (run >= LZHFormat.repeatZeroShortBase) {
          symbols.push({ symbol: LZHFormat.repeatZeroShort, extra: run - LZHFormat.repeatZeroShortBase })
          run = 0
        }
      } else {
        symbols.push({ symbol: length, extra: 0 })
        run -= 1
        while (run >= LZHFormat.repeatPreviousBase) {
          const chunk = Math.min(run, LZHFormat.repeatPreviousBase + (1 << LZHFormat.repeatPreviousExtraBits) - 1)
          symbols.push({ symbol: LZHFormat.repeatPrevious, extra: chunk - LZHFormat.repeatPreviousBase })
          run -= chunk
        }
      }
      for (; run > 0; run--) symbols.push({ symbol: length, extra: 0 })
    }
    return symbols
  }

  /** Extra-bit width of a code-length symbol (PV-0369). */
  static extraBits(symbol: number): number {
    switch (symbol) {
      case LZHFormat.repeatPrevious:
        return LZHFormat.repeatPreviousExtraBits
      case LZHFormat.repeatZeroShort:
        return LZHFormat.repeatZeroShortExtraBits
      case LZHFormat.repeatZeroLong:
        return LZHFormat.repeatZeroLongExtraBits
      default:
        return 0
    }
  }

  /** Bits of the header plus the block's symbols (extra bits of matches excluded). */
  cost(literalLength: Uint32Array, distance: Uint32Array): number {
    let bits =
      LZHFormat.hlitBits + LZHFormat.hdistBits + LZHFormat.hclenBits + this.codeLengthCount * LZHFormat.codeLengthCodeLengthBits
    for (const { symbol } of this.lengthSymbols) bits += this.codeLengthLengths[symbol] + DynamicCodes.extraBits(symbol)
    for (let symbol = 0; symbol < literalLength.length; symbol++) bits += literalLength[symbol] * this.literalLengthLengths[symbol]
    for (let symbol = 0; symbol < distance.length; symbol++) bits += distance[symbol] * this.distanceLengths[symbol]
    return bits
  }

  /** Writes HLIT, HDIST, HCLEN, the code-length code lengths and both length sequences (PV-0366 to PV-0370). */
  writeHeader(writer: LZHBitWriter): void {
    writer.write(this.literalLengthCount - LZHFormat.hlitBase, LZHFormat.hlitBits)
    writer.write(this.distanceCount - 1, LZHFormat.hdistBits)
    writer.write(this.codeLengthCount - LZHFormat.hclenBase, LZHFormat.hclenBits)
    for (let index = 0; index < this.codeLengthCount; index++)
      writer.write(this.codeLengthLengths[LZHFormat.codeLengthOrder[index]], LZHFormat.codeLengthCodeLengthBits)
    for (const { symbol, extra } of this.lengthSymbols) {
      writer.writeCode(this.codeLengthCodes[symbol])
      writer.write(extra, DynamicCodes.extraBits(symbol))
    }
  }
}

/** Length-limited, complete prefix codes from symbol frequencies (encoder side). */
const HuffmanLengths = {
  /** Bits for a symbol in a sort key (alphabets have at most 288 symbols). */
  symbolBits: 16, // not-protocol: sort key layout

  /**
   * Code lengths ≤ `limit` for `frequencies`: a Huffman code, lengthened or shortened where
   * needed so that no length exceeds `limit` and the Kraft sum is exactly 1 (PV-0372). At least
   * two symbols get a length, even when fewer occur (R-LZH-4): the lowest unused symbols are
   * added as padding.
   */
  make(frequencies: Uint32Array, limit: number): Uint8Array {
    const weights = new Float64Array(frequencies.length)
    const used: number[] = []
    for (let symbol = 0; symbol < frequencies.length; symbol++) {
      if (frequencies[symbol] > 0) {
        weights[symbol] = frequencies[symbol]
        used.push(symbol)
      }
    }
    let padding = 0
    while (used.length < 2) { // provenance: PV-0372 (a complete code needs two used symbols, R-LZH-4)
      if (weights[padding] === 0) {
        weights[padding] = 1
        used.push(padding)
      }
      padding += 1
    }
    // Huffman tree by the two-queue method over the leaves in ascending weight (ties by symbol):
    // sorting packed keys (weight · 2^16 + symbol, exact in a double) keeps the order total.
    const symbolScale = 2 ** HuffmanLengths.symbolBits
    const keys = Float64Array.from(used, symbol => weights[symbol] * symbolScale + symbol).sort()
    const leaves = Array.from(keys, key => key % symbolScale)
    const leafCount = leaves.length
    const nodeCount = 2 * leafCount - 1 // not-protocol: binary tree size
    const nodeWeight = new Float64Array(nodeCount)
    const parent = new Int32Array(nodeCount)
    for (let index = 0; index < leafCount; index++) nodeWeight[index] = weights[leaves[index]]
    let nextLeaf = 0
    let nextInner = leafCount
    let created = leafCount
    const takeLightest = (): number => {
      if (nextLeaf < leafCount && (nextInner >= created || nodeWeight[nextLeaf] <= nodeWeight[nextInner])) return nextLeaf++
      return nextInner++
    }
    while (created < nodeCount) {
      const first = takeLightest()
      const second = takeLightest()
      nodeWeight[created] = nodeWeight[first] + nodeWeight[second]
      parent[first] = created
      parent[second] = created
      created += 1
    }
    const depth = new Int32Array(nodeCount)
    for (let node = nodeCount - 2; node >= 0; node--) depth[node] = depth[parent[node]] + 1 // not-protocol: every node below the root
    const lengths = new Int32Array(frequencies.length)
    for (let index = 0; index < leafCount; index++) lengths[leaves[index]] = Math.min(depth[index], limit)
    HuffmanLengths.makeComplete(lengths, weights, leaves, limit)
    return Uint8Array.from(lengths)
  },

  /** Adjusts lengths (all 1…limit for `used`) until the Kraft sum is exactly 1. */
  makeComplete(lengths: Int32Array, weights: Float64Array, used: readonly number[], limit: number): void {
    const target = 1 << limit
    let kraft = 0
    for (const symbol of used) kraft += 1 << (limit - lengths[symbol])
    // Over-subscribed (after clamping): lengthen the longest code below the limit, lightest
    // first. One always exists: `used.length` codes at the limit sum to far less than 1.
    while (kraft > target) {
      let pick = -1
      for (const symbol of used) {
        if (lengths[symbol] >= limit) continue
        if (
          pick < 0 ||
          lengths[symbol] > lengths[pick] ||
          (lengths[symbol] === lengths[pick] && weights[symbol] < weights[pick])
        )
          pick = symbol
      }
      kraft -= 1 << (limit - lengths[pick] - 1)
      lengths[pick] += 1
    }
    // Incomplete: shorten the longest code whose gain still fits, heaviest first. The longest
    // code always fits, since the deficit is a multiple of its weight.
    while (kraft < target) {
      let pick = -1
      for (const symbol of used) {
        if (!(lengths[symbol] > 1 && 1 << (limit - lengths[symbol]) <= target - kraft)) continue
        if (
          pick < 0 ||
          lengths[symbol] > lengths[pick] ||
          (lengths[symbol] === lengths[pick] && weights[symbol] > weights[pick])
        )
          pick = symbol
      }
      kraft += 1 << (limit - lengths[pick])
      lengths[pick] -= 1
    }
  }
} as const

/**
 * Writes LZH bits in stream order: fields least significant bit first (PV-0351), codes most
 * significant bit first (PV-0363, via `Code.reversed`). Appends to a `ByteWriter`; fewer than 8
 * bits are ever pending between writes, so a write of up to 24 bits fits a 32-bit number.
 */
class LZHBitWriter {
  private pending = 0
  private pendingCount = 0

  constructor(readonly output: ByteWriter) {}

  /** Writes the low `count` bits of `value` (at most 24), least significant bit first. */
  write(value: number, count: number): void {
    this.pending |= value << this.pendingCount
    this.pendingCount += count
    while (this.pendingCount >= 8) {
      this.output.u8(this.pending)
      this.pending >>>= 8
      this.pendingCount -= 8
    }
  }

  writeCode(code: Code): void {
    this.write(code.reversed, code.length)
  }

  /** Fills the last byte with zero bits. */
  flush(): void {
    if (this.pendingCount > 0) this.output.u8(this.pending)
    this.pending = 0
    this.pendingCount = 0
  }
}
