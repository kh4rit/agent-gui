// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCompressionTests/TestSupport.swift (MIT).
//
// Helpers for the DiagCompression tests. Everything here is written from the spec text
// (docs/protocol/compression-lzh.md, compression-lzc.md) independently of the library, so that
// hand-built streams test the decoders rather than restate them.

import {
  CompressedDataError,
  LZCDecoder,
  LZCParameters,
  LZHDecoder,
  type CompressedDataErrorInfo
} from "../../../diag/compression/index.js"
import { SeededGenerator } from "../../support/seededGenerator.js"

// MARK: - Decoding shortcuts

/** The output cap the decompress vectors run under: the README's minimum of 1 MiB (IMPL-CH-5). */
export const OUTPUT_CAP = 1 << 20

/** A decoder result: the bytes, or the error (never both). */
export type DecodeResult = { bytes: Uint8Array; error?: undefined } | { bytes?: undefined; error: CompressedDataErrorInfo }

function capture(body: () => Uint8Array): DecodeResult {
  try {
    return { bytes: body() }
  } catch (e) {
    if (e instanceof CompressedDataError) return { error: e.info }
    throw e
  }
}

/** Decodes LZH data with a fresh decoder unless one is given. */
export function decodeLZH(data: Uint8Array, declaredLength: number, cap = OUTPUT_CAP, decoder = new LZHDecoder()): DecodeResult {
  return capture(() => decoder.decode(data, declaredLength, cap))
}

/** Decodes LZC data with a fresh decoder unless one is given. */
export function decodeLZC(
  data: Uint8Array,
  declaredLength: number,
  options: { maxbits?: number; blockMode?: boolean; decoder?: LZCDecoder; cap?: number } = {}
): DecodeResult {
  const { maxbits = 16, blockMode = true, decoder = new LZCDecoder(), cap = OUTPUT_CAP } = options
  return capture(() => decoder.decode(data, new LZCParameters(maxbits, blockMode), declaredLength, cap))
}

/** The bytes of an ASCII or UTF-8 string. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** `count` copies of `byte`. */
export const repeated = (byte: number, count: number): Uint8Array => new Uint8Array(count).fill(byte)

/** Concatenates byte arrays. */
export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

// MARK: - LZH bit writer (compression-lzh.md, "Bit order")

/**
 * Builds LZH data bit by bit: fields least significant bit first, Huffman codes most significant
 * bit first.
 */
export class LZHStreamWriter {
  private readonly bytes: number[] = []
  bitCount = 0

  bit(value: number): void {
    if (this.bitCount % 8 === 0) this.bytes.push(0)
    this.bytes[this.bytes.length - 1] |= (value & 1) << this.bitCount % 8
    this.bitCount += 1
  }

  /** An integer field, least significant bit first. */
  field(value: number, bits: number): void {
    for (let index = 0; index < bits; index++) this.bit(value >> index)
  }

  /** A Huffman code, most significant bit first. */
  code(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index--) this.bit(value >> index)
  }

  /** Noise count and noise bits. */
  noise(count: number, noiseBits = 0): void {
    this.field(count, 2)
    this.field(noiseBits, count)
  }

  blockHeader(final: boolean, type: number): void {
    this.field(final ? 1 : 0, 1)
    this.field(type, 2)
  }

  /** A literal/length symbol with the fixed code (the third column of the spec's table). */
  fixedSymbol(symbol: number): void {
    if (symbol < 144) this.code(0x30 + symbol, 8)
    else if (symbol < 256) this.code(0x190 + symbol - 144, 9)
    else if (symbol < 280) this.code(symbol - 256, 7)
    else this.code(0xc0 + symbol - 280, 8)
  }

  /** A distance symbol with the fixed code: 5 bits, the code equals the symbol. */
  fixedDistance(symbol: number): void {
    this.code(symbol, 5)
  }

  /** A match with the fixed codes: length symbol and extra bits, distance symbol and extra bits. */
  fixedMatch(length: number, distance: number): void {
    const [lengthSymbol, lengthExtra, lengthExtraBits] = SpecTables.lengthSymbol(length)
    this.fixedSymbol(lengthSymbol)
    this.field(lengthExtra, lengthExtraBits)
    const [distanceSymbol, distanceExtra, distanceExtraBits] = SpecTables.distanceSymbol(distance)
    this.fixedDistance(distanceSymbol)
    this.field(distanceExtra, distanceExtraBits)
  }

  /** Everything so far, with zero fill in the last byte. */
  get data(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

/** The spec's tables, restated for the tests (compression-lzh.md, PV-0359, PV-0361). */
export const SpecTables = {
  lengthBases: [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258],
  lengthExtras: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0],
  distanceBases: [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
    12289, 16385, 24577
  ],
  distanceExtras: [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13],

  /** Symbol, extra value and extra-bit count for a length 3–258 (258 as symbol 285). */
  lengthSymbol(length: number): [number, number, number] {
    const index = SpecTables.lengthBases.findLastIndex(base => base <= length)
    return [257 + index, length - SpecTables.lengthBases[index], SpecTables.lengthExtras[index]]
  },

  /** Symbol, extra value and extra-bit count for a distance. */
  distanceSymbol(distance: number): [number, number, number] {
    const index = SpecTables.distanceBases.findLastIndex(base => base <= distance)
    return [index, distance - SpecTables.distanceBases[index], SpecTables.distanceExtras[index]]
  },

  /** The order of the code-length code lengths (PV-0368). */
  codeLengthOrder: [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15],

  /** Canonical codes for lengths (PV-0364), as integers sent most significant bit first. */
  canonicalCodes(lengths: readonly number[]): number[] {
    const counts = new Array<number>(16).fill(0)
    for (const length of lengths) if (length > 0) counts[length] += 1
    const next = new Array<number>(16).fill(0)
    let code = 0
    for (let length = 1; length <= 15; length++) {
      code = (code + counts[length - 1]) << 1
      next[length] = code
    }
    return lengths.map(length => (length > 0 ? next[length]++ : 0))
  },

  /** Complete code lengths for `symbols` out of an alphabet of `size`: as flat as possible. */
  flatLengths(symbols: readonly number[], size: number): number[] {
    const lengths = new Array<number>(size).fill(0)
    const count = symbols.length
    let short = 0
    while (1 << (short + 1) <= count) short += 1
    // 2^(short+1) - count codes of length `short`, the rest one longer.
    const shortCount = (1 << (short + 1)) - count
    ;[...symbols]
      .sort((a, b) => a - b)
      .forEach((symbol, index) => {
        lengths[symbol] = index < shortCount ? short : short + 1
      })
    return lengths
  }
}

/** `lower ... upper` as an array. */
export const range = (lower: number, upper: number): number[] => Array.from({ length: upper - lower + 1 }, (_, i) => lower + i)

// MARK: - LZH dynamic blocks

/** A code-length symbol with its extra value. */
export type LengthSymbol = [symbol: number, extra: number]

/** A dynamic code header, written field by field so that tests can break any rule. */
export class DynamicHeader {
  /**
   * The code-length code used for every valid header here: symbols 0–12 get 4 bits and 13–18
   * get 5 bits, which is complete (13/16 + 6/32 = 1).
   */
  static readonly flatCodeLengthLengths = SpecTables.flatLengths(range(0, 18), 19)

  /**
   * @param hlit Raw 5-bit HLIT.
   * @param hdist Raw 5-bit HDIST.
   * @param hclen Raw 4-bit HCLEN.
   * @param codeLengthLengths Length of each code-length symbol 0–18.
   * @param symbols Code-length symbols with their extra values, both sequences one after the other.
   */
  constructor(
    public hlit: number,
    public hdist: number,
    public hclen: number,
    public codeLengthLengths: number[],
    public symbols: LengthSymbol[]
  ) {}

  /** A valid header for these lengths, with every length sent as a literal symbol. */
  static forLengths(literalLength: readonly number[], distance: readonly number[]): DynamicHeader {
    return new DynamicHeader(
      literalLength.length - 257,
      distance.length - 1,
      19 - 4,
      [...DynamicHeader.flatCodeLengthLengths],
      [...literalLength, ...distance].map((length): LengthSymbol => [length, 0])
    )
  }

  /** A header with raw counts and symbols; HCLEN 15 and the flat code-length code by default. */
  static raw(options: { hlit: number; hdist: number; hclen?: number; codeLengthLengths?: number[]; symbols: LengthSymbol[] }): DynamicHeader {
    return new DynamicHeader(
      options.hlit,
      options.hdist,
      options.hclen ?? 15,
      options.codeLengthLengths ?? [...DynamicHeader.flatCodeLengthLengths],
      options.symbols
    )
  }

  write(writer: LZHStreamWriter): void {
    writer.field(this.hlit, 5)
    writer.field(this.hdist, 5)
    writer.field(this.hclen, 4)
    for (const symbol of SpecTables.codeLengthOrder.slice(0, this.hclen + 4)) writer.field(this.codeLengthLengths[symbol], 3)
    const codes = SpecTables.canonicalCodes(this.codeLengthLengths)
    for (const [symbol, extra] of this.symbols) {
      writer.code(codes[symbol], this.codeLengthLengths[symbol])
      if (symbol === 16) writer.field(extra, 2)
      else if (symbol === 17) writer.field(extra, 3)
      else if (symbol === 18) writer.field(extra, 7)
    }
  }
}

/** Writes symbols of a dynamic block with the codes of the given lengths. */
export class DynamicCodeWriter {
  private readonly literalLengthCodes: number[]
  private readonly distanceCodes: number[]

  constructor(
    private readonly literalLengthLengths: readonly number[],
    private readonly distanceLengths: readonly number[]
  ) {
    this.literalLengthCodes = SpecTables.canonicalCodes(literalLengthLengths)
    this.distanceCodes = SpecTables.canonicalCodes(distanceLengths)
  }

  symbol(symbol: number, writer: LZHStreamWriter): void {
    writer.code(this.literalLengthCodes[symbol], this.literalLengthLengths[symbol])
  }

  match(length: number, distance: number, writer: LZHStreamWriter): void {
    const [lengthSymbol, lengthExtra, lengthExtraBits] = SpecTables.lengthSymbol(length)
    this.symbol(lengthSymbol, writer)
    writer.field(lengthExtra, lengthExtraBits)
    const [distanceSymbol, distanceExtra, distanceExtraBits] = SpecTables.distanceSymbol(distance)
    writer.code(this.distanceCodes[distanceSymbol], this.distanceLengths[distanceSymbol])
    writer.field(distanceExtra, distanceExtraBits)
  }
}

// MARK: - LZC test encoder (compression-lzc.md, "Encoder rules")

/**
 * An LZC encoder written from E-LZC-1 to E-LZC-7, for tests only: Swooey's client sends no LZC.
 * `clearEvery` inserts a clear (block mode only) after that many codes since the start or the
 * last clear, which the spec allows at any point (E-LZC-5). Chunks ended early are filled with
 * `filler`: 0x00 as Swooey writes it (E-LZC-4), or other bytes, which the decoder must ignore
 * because the fill is free.
 */
export class LZCTestEncoder {
  maxbits: number
  blockMode: boolean
  clearEvery: number | undefined
  filler: number

  constructor(options: { maxbits: number; blockMode: boolean; clearEvery?: number; filler?: number }) {
    this.maxbits = options.maxbits
    this.blockMode = options.blockMode
    this.clearEvery = options.clearEvery
    this.filler = options.filler ?? 0x00
  }

  encode(input: Uint8Array): Uint8Array {
    const output: number[] = []
    const chunk = new ChunkWriter(this.filler)
    const firstCode = this.blockMode ? 257 : 256
    const limit = 1 << this.maxbits
    let width = 9
    let nextFree = firstCode
    let dictionary = new Map<number, number>()
    let codes = 0 // codes since the start or the last clear
    let index = 0
    while (index < input.length) {
      if (this.blockMode && this.clearEvery !== undefined && codes === this.clearEvery) {
        chunk.put(256, width, output)
        chunk.endEarly(width, output)
        width = 9
        nextFree = 257
        dictionary = new Map()
        codes = 0
      }
      let code = input[index]
      let end = index + 1
      for (;;) {
        if (end >= input.length) break
        const longer = dictionary.get(code * 256 + input[end])
        if (longer === undefined) break
        code = longer
        end += 1
      }
      chunk.put(code, width, output)
      codes += 1
      if (end < input.length && nextFree < limit) {
        dictionary.set(code * 256 + input[end], nextFree)
        nextFree += 1
      }
      // E-LZC-3: the width the decoder will use for the next code.
      const decoderNextFree = Math.min(firstCode + codes - 1, limit)
      if (width < this.maxbits && decoderNextFree > (1 << width) - 1) {
        chunk.endEarly(width, output)
        width += 1
      }
      index = end
    }
    chunk.finish(output)
    return Uint8Array.from(output)
  }
}

/** Packs codes least significant bit first into chunks of `width` bytes. */
class ChunkWriter {
  private bytes: number[] = []
  private used = 0

  constructor(private readonly filler: number) {}

  put(code: number, width: number, output: number[]): void {
    for (let index = 0; index < width; index++) {
      const position = this.used + index
      if (position % 8 === 0) this.bytes.push(0)
      this.bytes[position >> 3] |= ((code >> index) & 1) << position % 8
    }
    this.used += width
    if (this.used === 8 * width) {
      output.push(...this.bytes)
      this.bytes = []
      this.used = 0
    }
  }

  /** E-LZC-4: a chunk ended early is filled to exactly `width` bytes. */
  endEarly(width: number, output: number[]): void {
    if (this.used === 0) return
    output.push(...this.bytes)
    for (let i = this.bytes.length; i < width; i++) output.push(this.filler)
    this.bytes = []
    this.used = 0
  }

  /** E-LZC-6: only the bytes that hold code bits. */
  finish(output: number[]): void {
    output.push(...this.bytes)
    this.bytes = []
    this.used = 0
  }
}

// MARK: - Inputs (D15: invented, and deliberately silly)

export const Samples = {
  /** Screen-like text with the reserved ZZ transaction prefix. */
  silly: utf8(
    [
      "ZZCOFFEE Coffee machine cockpit: espresso pressure 9 bar, grinder mood grumpy.",
      "ZZSOCK   Sock drawer reconciliation: 17 left socks, 12 right socks, 5 philosophers.",
      "ZZNAP    Nap scheduler: next nap in 00:14:59, snooze budget exceeded by a llama.",
      "ZZCOFFEE Coffee machine cockpit: espresso pressure 9 bar, grinder mood cheerful."
    ].join("\n")
  ),

  /** `count` bytes of screen-like data: repeated rows with changing fields and some noise. */
  screenLike(count: number, seed: number | bigint): Uint8Array {
    const generator = new SeededGenerator(seed)
    const silly = Samples.silly
    const bytes: number[] = []
    let row = 0
    while (bytes.length < count) {
      bytes.push(...utf8(`ZZROW${row % 97} |`))
      const start = (row * 13) % silly.length
      bytes.push(...silly.subarray(start, Math.min(silly.length, start + 40)))
      bytes.push(0x12, 0x09, row & 0xff, 0x00)
      if (row % 5 === 0) bytes.push(...generator.bytes(generator.int(1, 24)))
      row += 1
    }
    return Uint8Array.from(bytes.slice(0, count))
  },

  random(count: number, seed: number | bigint): Uint8Array {
    return new SeededGenerator(seed).bytes(count)
  }
}
