// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/LZHDecoder.swift (MIT).

import { CompressedDataError, type LZHCode, type LZHCodeLengthsFault, type LZHLengthSequence } from "./diagCompression.js"
import { HuffmanDecodeTable, TableEntry } from "./huffmanDecodeTable.js"
import { LZHFormat } from "./lzhFormat.js"

/**
 * Offsets into the decoder's storage. Table sizes follow `HuffmanDecodeTable.capacity`.
 *
 * Primary index widths: the fixed tables use the longest fixed code (PV-0365) and the
 * code-length table the longest code-length code (PV-0371), so they need no subtables; the
 * dynamic widths are a speed/size choice.
 */
const Layout = (() => {
  const fixedLiteralLengthBits = 9 // provenance: PV-0365
  const fixedDistanceBits = 5 // provenance: PV-0365
  const literalLengthBits = 10 // not-protocol: primary table width
  const distanceBits = 8 // not-protocol: primary table width
  const codeLengthBits = LZHFormat.maxCodeLengthCodeLength

  const fixedLiteralLength = 0
  const fixedDistance = fixedLiteralLength + (1 << fixedLiteralLengthBits)
  const literalLength = fixedDistance + (1 << fixedDistanceBits)
  const distance = literalLength + HuffmanDecodeTable.capacity(literalLengthBits, LZHFormat.literalLengthCount)
  const codeLength = distance + HuffmanDecodeTable.capacity(distanceBits, LZHFormat.distanceCount)
  const literalLengthLengths = codeLength + (1 << codeLengthBits)
  const distanceLengths = literalLengthLengths + LZHFormat.fixedLiteralLengthPositions
  const codeLengthLengths = distanceLengths + LZHFormat.fixedDistancePositions
  const subtableWidths = codeLengthLengths + LZHFormat.codeLengthSymbolCount
  const totalSize = subtableWidths + (1 << literalLengthBits)
  return {
    fixedLiteralLengthBits,
    fixedDistanceBits,
    literalLengthBits,
    distanceBits,
    codeLengthBits,
    fixedLiteralLength,
    fixedDistance,
    literalLength,
    distance,
    codeLength,
    literalLengthLengths,
    distanceLengths,
    codeLengthLengths,
    subtableWidths,
    totalSize
  } as const
})()

/**
 * The fixed literal/length and distance tables (PV-0365), laid out as at the start of the
 * decoder's storage (`Layout.fixedLiteralLength`, `Layout.fixedDistance`). Built once per
 * process, on first use.
 */
let fixedTablesCache: Uint32Array | undefined

function fixedTables(): Uint32Array {
  if (fixedTablesCache) return fixedTablesCache
  const tables = new Uint32Array(Layout.literalLength)
  const lengths = new Uint32Array(LZHFormat.fixedLiteralLengthPositions)
  const scratch = new Uint32Array(1 << Layout.fixedLiteralLengthBits)
  for (let symbol = 0; symbol < LZHFormat.fixedLiteralLengthPositions; symbol++)
    lengths[symbol] = LZHFormat.fixedLiteralLengthCodeLength(symbol)
  HuffmanDecodeTable.build(
    lengths,
    LZHFormat.fixedLiteralLengthPositions,
    "literalLength",
    Layout.fixedLiteralLengthBits,
    tables.subarray(Layout.fixedLiteralLength, Layout.fixedDistance),
    scratch
  )
  lengths.fill(LZHFormat.fixedDistanceCodeLength)
  HuffmanDecodeTable.build(
    lengths,
    LZHFormat.fixedDistancePositions,
    "distance",
    Layout.fixedDistanceBits,
    tables.subarray(Layout.fixedDistance, Layout.literalLength),
    scratch
  )
  fixedTablesCache = tables
  return tables
}

/**
 * Decoder for LZH compressed data (docs/protocol/compression-lzh.md), written from the spec. No
 * zlib or other inflater is used: whether the stream is RFC 1951 raw DEFLATE is spec gap #26,
 * and the format has rules of its own (no block type 0, complete codes only, distances up to
 * 16 122).
 *
 * Input is the data after the 8-byte compression header, to the end of the frame (PV-0350).
 * Output is exactly the declared uncompressed length, or an error and no output (PV-0314).
 *
 * ```ts
 * const decoder = new LZHDecoder()   // keep one per connection: its tables are reused
 * const body = decoder.decode(data, header.uncompressedLength, cap)
 * ```
 *
 * Allocation: the decode tables (about 65 KB) are allocated once, in the constructor, which
 * copies in the fixed codes (built once per process). `decode` allocates only the output.
 *
 * Behaviour on malformed input, all per the spec: block types 0 and 3 fail (`badBlockType`);
 * invalid dynamic headers fail (`badCodeLengths`); symbols 286/287 and distance symbols 30/31
 * fail (`badSymbol`); distances above 16 122 or before the first byte of the message fail
 * (`badDistance`); input that ends before the final end-of-block symbol fails
 * (`dataTruncated`), without ever needing bits beyond the code being read (IMPL-LZH-1); output
 * longer or shorter than declared fails (`lengthMismatch`), and nothing is written past the
 * declared length (IMPL-LZH-3). Bits and bytes after the final block are ignored (PV-0374).
 */
export class LZHDecoder {
  /** All tables and scratch space, in one array (`Layout`). */
  private readonly storage = new Uint32Array(Layout.totalSize)
  // Views of the regions of `storage`, made once.
  private readonly fixedLiteralLengthTable: Uint32Array
  private readonly fixedDistanceTable: Uint32Array
  private readonly literalLengthTable: Uint32Array
  private readonly distanceTable: Uint32Array
  private readonly codeLengthTable: Uint32Array
  private readonly literalLengthLengths: Uint32Array
  private readonly distanceLengths: Uint32Array
  private readonly codeLengthLengths: Uint32Array
  private readonly subtableWidths: Uint32Array

  /** Allocates the tables and copies in the fixed codes, which are built once per process. */
  constructor() {
    const s = this.storage
    s.set(fixedTables(), Layout.fixedLiteralLength)
    this.fixedLiteralLengthTable = s.subarray(Layout.fixedLiteralLength, Layout.fixedDistance)
    this.fixedDistanceTable = s.subarray(Layout.fixedDistance, Layout.literalLength)
    this.literalLengthTable = s.subarray(Layout.literalLength, Layout.distance)
    this.distanceTable = s.subarray(Layout.distance, Layout.codeLength)
    this.codeLengthTable = s.subarray(Layout.codeLength, Layout.literalLengthLengths)
    this.literalLengthLengths = s.subarray(Layout.literalLengthLengths, Layout.distanceLengths)
    this.distanceLengths = s.subarray(Layout.distanceLengths, Layout.codeLengthLengths)
    this.codeLengthLengths = s.subarray(Layout.codeLengthLengths, Layout.subtableWidths)
    this.subtableWidths = s.subarray(Layout.subtableWidths, Layout.totalSize)
  }

  /**
   * Decodes `data` (after the 8-byte compression header). `declaredLength` is checked against
   * `maxLength` before any memory is reserved (`lengthOverCap`, IMPL-CH-5). On success returns
   * exactly `declaredLength` bytes; on failure throws `CompressedDataError` (no partial output).
   *
   * Swift's `decode(_:into: MutableSpan)` overload, which writes a caller-sized buffer, collapses
   * into this one.
   */
  decode(data: Uint8Array, declaredLength: number, maxLength: number): Uint8Array {
    const output = OutputBuffer.allocate(declaredLength, maxLength)
    this.inflate(data, output)
    return output
  }

  // MARK: Decoding

  private inflate(input: Uint8Array, output: Uint8Array): void {
    const reader = new LZHBitReader(input)
    // Noise prefix: a 2-bit count N, then N bits skipped unread (PV-0352).
    const noise = reader.read(LZHFormat.noiseCountBits)
    reader.read(noise)
    let produced = 0
    let isFinal = false
    do {
      isFinal = reader.read(1) === 1
      const type = reader.read(LZHFormat.blockTypeBits)
      switch (type) {
        case LZHFormat.fixedBlockType:
          produced = inflateBlock(
            reader,
            this.fixedLiteralLengthTable,
            Layout.fixedLiteralLengthBits,
            this.fixedDistanceTable,
            Layout.fixedDistanceBits,
            output,
            produced
          )
          break
        case LZHFormat.dynamicBlockType:
          this.readDynamicCodes(reader)
          produced = inflateBlock(
            reader,
            this.literalLengthTable,
            Layout.literalLengthBits,
            this.distanceTable,
            Layout.distanceBits,
            output,
            produced
          )
          break
        default:
          // Block types 0 and 3 are not part of the format (PV-0073, PV-0356).
          throw new CompressedDataError({ kind: "badBlockType", blockType: type })
      }
    } while (!isFinal)
    // The final end-of-block symbol ends the stream; the rest is ignored (PV-0374).
    if (produced !== output.length)
      throw new CompressedDataError({ kind: "lengthMismatch", declaredLength: output.length, decodedLength: produced })
  }

  /** Reads a dynamic code header and builds its literal/length and distance tables (PV-0366 to PV-0372). */
  private readDynamicCodes(reader: LZHBitReader): void {
    const literalLengthCount = reader.read(LZHFormat.hlitBits) + LZHFormat.hlitBase
    if (literalLengthCount > LZHFormat.literalLengthCount)
      throw codeLengthsError({ kind: "literalLengthCount", count: literalLengthCount })
    const distanceCount = reader.read(LZHFormat.hdistBits) + 1
    if (distanceCount > LZHFormat.distanceCount) throw codeLengthsError({ kind: "distanceCount", count: distanceCount })
    const codeLengthCount = reader.read(LZHFormat.hclenBits) + LZHFormat.hclenBase

    // The code-length code: 3-bit lengths in the fixed order, unsent ones 0 (PV-0368).
    const codeLengthLengths = this.codeLengthLengths
    codeLengthLengths.fill(0)
    for (let index = 0; index < codeLengthCount; index++)
      codeLengthLengths[LZHFormat.codeLengthOrder[index]] = reader.read(LZHFormat.codeLengthCodeLengthBits)
    requireComplete(codeLengthLengths, LZHFormat.codeLengthSymbolCount, LZHFormat.maxCodeLengthCodeLength, "codeLength")
    HuffmanDecodeTable.build(
      codeLengthLengths,
      LZHFormat.codeLengthSymbolCount,
      "codeLength",
      Layout.codeLengthBits,
      this.codeLengthTable,
      this.subtableWidths
    )

    // Two separate sequences with the same code-length code (PV-0370).
    readLengths(literalLengthCount, "literalLength", this.literalLengthLengths, reader, this.codeLengthTable)
    readLengths(distanceCount, "distance", this.distanceLengths, reader, this.codeLengthTable)

    if (this.literalLengthLengths[LZHFormat.endOfBlock] === 0) throw codeLengthsError({ kind: "missingEndOfBlock" })
    requireComplete(this.literalLengthLengths, literalLengthCount, LZHFormat.maxCodeLength, "literalLength")
    requireComplete(this.distanceLengths, distanceCount, LZHFormat.maxCodeLength, "distance")
    HuffmanDecodeTable.build(
      this.literalLengthLengths,
      literalLengthCount,
      "literalLength",
      Layout.literalLengthBits,
      this.literalLengthTable,
      this.subtableWidths
    )
    HuffmanDecodeTable.build(this.distanceLengths, distanceCount, "distance", Layout.distanceBits, this.distanceTable, this.subtableWidths)
  }
}

/**
 * Decodes the symbols of one block up to and including its end-of-block symbol. Returns the
 * number of bytes produced so far. (Swift refills a 64-bit buffer to 48 bits here, so that a
 * whole match decodes without another refill; the 32-bit reader below refills on demand in
 * `read` and `decode` instead.)
 */
function inflateBlock(
  reader: LZHBitReader,
  literalLength: Uint32Array,
  literalLengthBits: number,
  distance: Uint32Array,
  distanceBits: number,
  output: Uint8Array,
  produced: number
): number {
  const count = output.length
  let position = produced
  for (;;) {
    const entry = reader.decode(literalLength, literalLengthBits)
    switch (TableEntry.kind(entry)) {
      case TableEntry.literal:
        if (position >= count)
          throw new CompressedDataError({ kind: "lengthMismatch", declaredLength: count, decodedLength: position + 1 })
        output[position++] = TableEntry.value(entry)
        break
      case TableEntry.length: {
        // Length symbol, its extra bits, distance symbol, its extra bits (PV-0373).
        const length = TableEntry.value(entry) + reader.read(TableEntry.aux(entry))
        if (length > count - position)
          throw new CompressedDataError({ kind: "lengthMismatch", declaredLength: count, decodedLength: position + length })
        const distanceEntry = reader.decode(distance, distanceBits)
        if (TableEntry.kind(distanceEntry) !== TableEntry.distance)
          throw new CompressedDataError({ kind: "badSymbol", symbol: { kind: "distance", symbol: TableEntry.value(distanceEntry) } })
        const offset = TableEntry.value(distanceEntry) + reader.read(TableEntry.aux(distanceEntry))
        if (offset > LZHFormat.maxDistance || offset > position)
          throw new CompressedDataError({ kind: "badDistance", distance: offset, producedLength: position })
        copyMatch(output, position, offset, length)
        position += length
        break
      }
      case TableEntry.endOfBlock:
        return position
      default:
        throw new CompressedDataError({ kind: "badSymbol", symbol: { kind: "literalLength", symbol: TableEntry.value(entry) } })
    }
  }
}

/** Copies `length` bytes from `distance` bytes back, byte by byte where they overlap. */
function copyMatch(output: Uint8Array, position: number, distance: number, length: number): void {
  const source = position - distance
  if (distance >= length) {
    output.copyWithin(position, source, source + length)
  } else if (distance === 1) {
    output.fill(output[source], position, position + length)
  } else {
    for (let index = 0; index < length; index++) output[position + index] = output[source + index]
  }
}

function codeLengthsError(fault: LZHCodeLengthsFault): CompressedDataError {
  return new CompressedDataError({ kind: "badCodeLengths", fault })
}

/** Fails unless the lengths form a complete code (PV-0372). */
function requireComplete(lengths: Uint32Array, count: number, maxLength: number, code: LZHCode): void {
  switch (HuffmanDecodeTable.validity(lengths, count, maxLength)) {
    case "complete":
      return
    case "overSubscribed":
      throw codeLengthsError({ kind: "overSubscribed", code })
    case "incomplete":
      throw codeLengthsError({ kind: "incomplete", code })
  }
}

/** Reads one sequence of `count` code lengths (PV-0369, PV-0370). */
function readLengths(
  count: number,
  sequence: LZHLengthSequence,
  lengths: Uint32Array,
  reader: LZHBitReader,
  codeLengthCode: Uint32Array
): void {
  let index = 0
  let previous: number | undefined
  while (index < count) {
    const symbol = TableEntry.value(reader.decode(codeLengthCode, Layout.codeLengthBits))
    if (symbol <= LZHFormat.largestLiteralCodeLength) {
      lengths[index++] = symbol
      previous = symbol
      continue
    }
    let value: number
    let run: number
    switch (symbol) {
      case LZHFormat.repeatPrevious:
        // No previous length at the start of a sequence (IMPL-LZH-7, #27).
        if (previous === undefined) throw codeLengthsError({ kind: "repeatWithoutPreviousLength", sequence })
        value = previous
        run = LZHFormat.repeatPreviousBase + reader.read(LZHFormat.repeatPreviousExtraBits)
        break
      case LZHFormat.repeatZeroShort:
        value = 0
        run = LZHFormat.repeatZeroShortBase + reader.read(LZHFormat.repeatZeroShortExtraBits)
        break
      default:
        value = 0
        run = LZHFormat.repeatZeroLongBase + reader.read(LZHFormat.repeatZeroLongExtraBits)
    }
    if (run > count - index) throw codeLengthsError({ kind: "runPastSequenceEnd", sequence })
    lengths.fill(value, index, index + run)
    index += run
    previous = value
  }
}

/**
 * Reads LZH bits in stream order: bit 0x01 of each byte first, fields least significant bit
 * first (PV-0351). Bits are buffered ahead freely, but a read fails only when the input really
 * lacks the bits it needs (IMPL-LZH-1).
 *
 * The Swift reader buffers up to 63 bits in a UInt64; JavaScript's bit operators work on 32
 * bits, so this one buffers up to 32. Reads are at most 13 bits and codes at most 15, so a
 * refill always leaves enough bits unless the input ends.
 */
class LZHBitReader {
  private position = 0
  /** Buffered bits; bit 0 is the next bit of the stream. Bits at and above `bitCount` are zero. */
  private buffer = 0
  /** Number of buffered bits, 0–32. */
  private bitCount = 0

  constructor(private readonly input: Uint8Array) {}

  /** Buffers as many whole bytes as fit, up to the end of the input. */
  refill(): void {
    const input = this.input
    while (this.bitCount <= LZHBitReader.maxBufferedBits - 8 && this.position < input.length) {
      this.buffer = (this.buffer | (input[this.position++] << this.bitCount)) >>> 0
      this.bitCount += 8
    }
  }

  /** At most 32 bits are buffered. */
  static readonly maxBufferedBits = 32

  /** Reads an unsigned field of `count` bits (0–24), least significant bit first. */
  read(count: number): number {
    if (this.bitCount < count) {
      this.refill()
      if (this.bitCount < count) throw new CompressedDataError({ kind: "dataTruncated" })
    }
    const value = this.buffer & ((1 << count) - 1)
    this.buffer >>>= count
    this.bitCount -= count
    return value
  }

  /** Decodes one code with a table from `HuffmanDecodeTable` and returns its entry. */
  decode(table: Uint32Array, primaryBits: number): number {
    if (this.bitCount < LZHFormat.maxCodeLength) this.refill()
    const bits = this.buffer
    let entry = table[bits & ((1 << primaryBits) - 1)]
    if (TableEntry.kind(entry) === TableEntry.link)
      entry = table[TableEntry.value(entry) + ((bits >>> primaryBits) & ((1 << TableEntry.aux(entry)) - 1))]
    // Zero bits above bitCount cannot change a code that fits in the real bits, so a code
    // longer than what is buffered means the input ends inside it.
    const length = TableEntry.codeLength(entry)
    if (length > this.bitCount) throw new CompressedDataError({ kind: "dataTruncated" })
    this.buffer >>>= length
    this.bitCount -= length
    return entry
  }
}

/** Sizes the output of a decoder: exactly the declared number of bytes (shared with `LZCDecoder`). */
export const OutputBuffer = {
  /**
   * Checks the cap (IMPL-CH-5) before any memory is reserved and returns a zeroed buffer of
   * `declaredLength` bytes for a decoder to fill. `declaredLength` and `maxLength` are u32
   * values, as in the compression header.
   */
  allocate(declaredLength: number, maxLength: number): Uint8Array {
    if (!isU32(declaredLength) || !isU32(maxLength))
      throw new RangeError(`declared length ${declaredLength} and cap ${maxLength} must be u32 values`)
    if (declaredLength > maxLength) throw new CompressedDataError({ kind: "lengthOverCap", declaredLength, cap: maxLength })
    return new Uint8Array(declaredLength)
  }
} as const

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}
