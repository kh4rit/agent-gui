// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/LZCDecoder.swift (MIT).

import { CompressedDataError } from "./diagCompression.js"
import { OutputBuffer } from "./lzhDecoder.js"

/** Constants of the LZC format (docs/protocol/compression-lzc.md). */
export const LZCFormat = {
  /** maxbits is the low five bits of header byte 7 (PV-0310). */
  maxbitsMask: 0x1f, // provenance: PV-0310
  /** Bit 0x80 of header byte 7 selects block mode (PV-0312). */
  blockModeFlag: 0x80, // provenance: PV-0312
  /** Valid maxbits (PV-0080, PV-0311). */
  maxbitsRange: [9, 16], // provenance: PV-0080, PV-0311
  /** Code width at the start and after a clear (PV-0384). */
  initialWidth: 9, // provenance: PV-0384
  /** Codes 0–255 are single bytes (PV-0385). */
  literalCodeCount: 256, // provenance: PV-0385
  /** Block mode: the clear code (PV-0386). */
  clearCode: 256, // provenance: PV-0386
  /** Block mode: the first dictionary code (PV-0386). */
  firstBlockModeCode: 257, // provenance: PV-0386
  /** Single-block mode: the first dictionary code (PV-0387). */
  firstSingleBlockCode: 256 // provenance: PV-0387
} as const

/**
 * The two LZC parameters of compression-header byte 7 (docs/protocol/compression-lzc.md,
 * "Position and parameters"): maxbits in the low five bits, block mode in bit 0x80; bits 0x20 and
 * 0x40 are ignored (PV-0310 to PV-0313).
 */
export class LZCParameters {
  /**
   * Fails with `badMaxbits` unless `maxbits` is 9–16 (PV-0311).
   * @param maxbits The largest code width, 9–16.
   * @param blockMode Block mode (code 256 is the clear code) or single-block mode (code 256 is
   *   the first dictionary entry).
   */
  constructor(
    readonly maxbits: number,
    readonly blockMode: boolean
  ) {
    const [low, high] = LZCFormat.maxbitsRange
    if (!Number.isInteger(maxbits) || maxbits < low || maxbits > high) throw new CompressedDataError({ kind: "badMaxbits", maxbits })
  }

  /**
   * Reads maxbits and block mode from compression-header byte 7 and checks maxbits (IMPL-LZC-4).
   * Bits 0x20 and 0x40 are ignored (PV-0313).
   */
  static fromHeaderByte7(byte7: number): LZCParameters {
    return new LZCParameters(LZCParameters.maxbits(byte7), LZCParameters.blockMode(byte7))
  }

  /** maxbits as byte 7 carries it, unchecked: byte 7 & 0x1F (PV-0310). */
  static maxbits(byte7: number): number {
    return byte7 & LZCFormat.maxbitsMask
  }

  /** Whether byte 7 selects block mode: bit 0x80 (PV-0312). */
  static blockMode(byte7: number): boolean {
    return (byte7 & LZCFormat.blockModeFlag) !== 0
  }

  /** Byte 7 for these parameters, with bits 0x20 and 0x40 clear (E-LZC-1). */
  get headerByte7(): number {
    return this.maxbits | (this.blockMode ? LZCFormat.blockModeFlag : 0)
  }
}

/**
 * Decoder for LZC compressed data (docs/protocol/compression-lzc.md), written from the spec.
 *
 * Input is the code stream after the 8-byte compression header, to the end of the frame
 * (PV-0350). Decoding stops when the output reaches the declared length (the rest of the input
 * is ignored, PV-0395) or when the input cannot supply another code; the output must then be
 * exactly the declared length (PV-0314), or the message fails with `lengthMismatch`. A code
 * whose string would go past the declared length fails at once (IMPL-LZC-1).
 *
 * ```ts
 * const decoder = new LZCDecoder()   // keep one per connection: its dictionary is reused
 * const parameters = LZCParameters.fromHeaderByte7(header.byte7)
 * const body = decoder.decode(data, parameters, header.uncompressedLength, cap)
 * ```
 *
 * Dictionary: each entry is stored as the position and length of its string in the output
 * already produced (an entry is always the previous code's string plus the next byte, which sit
 * next to each other in the output), so decoding copies bytes instead of walking chains. The
 * table is sized from maxbits, 2^maxbits entries, never from input data (IMPL-LZC-5). It is
 * allocated the first time a decoder sees a maxbits that needs more room, and reused after.
 */
export class LZCDecoder {
  /** Per dictionary code: output position of its string. (Swift packs both into one UInt64.) */
  private entryStart = new Uint32Array(0)
  /** Per dictionary code: length of its string. */
  private entryLength = new Uint32Array(0)

  /**
   * Decodes `data` (the code stream after the 8-byte compression header). `declaredLength` is
   * checked against `maxLength` before any memory is reserved (`lengthOverCap`, IMPL-CH-5). On
   * success returns exactly `declaredLength` bytes; on failure throws `CompressedDataError` (no
   * partial output).
   *
   * Swift's `decode(_:parameters:into: MutableSpan)` overload, which writes a caller-sized
   * buffer, collapses into this one.
   */
  decode(data: Uint8Array, parameters: LZCParameters, declaredLength: number, maxLength: number): Uint8Array {
    const output = OutputBuffer.allocate(declaredLength, maxLength)
    this.decodeRaw(data, parameters, output)
    return output
  }

  // MARK: Decoding

  private decodeRaw(input: Uint8Array, parameters: LZCParameters, output: Uint8Array): void {
    if (output.length === 0) return
    const dictionarySize = 1 << parameters.maxbits
    if (this.entryStart.length < dictionarySize) {
      this.entryStart = new Uint32Array(dictionarySize)
      this.entryLength = new Uint32Array(dictionarySize)
    }
    this.decodeCodes(input, parameters.maxbits, parameters.blockMode, output)
  }

  /** The decoding procedure of compression-lzc.md ("Decoding procedure"). */
  private decodeCodes(input: Uint8Array, maxbits: number, blockMode: boolean, out: Uint8Array): void {
    const entryStart = this.entryStart
    const entryLength = this.entryLength
    const declared = out.length
    const firstCode = blockMode ? LZCFormat.firstBlockModeCode : LZCFormat.firstSingleBlockCode
    const dictionaryLimit = 1 << maxbits
    let width: number = LZCFormat.initialWidth
    let nextFree: number = firstCode
    let hasPrevious = false
    let previousStart = 0
    let previousLength = 0
    let chunkStart = 0 // byte offset of the current chunk in the input
    let chunkUsed = 0 // bits of the current chunk already read
    let produced = 0

    while (produced < declared) {
      // Width rule, checked before each code (PV-0390); a width increase starts a new chunk
      // after the current one (PV-0389).
      if (width < maxbits && nextFree > (1 << width) - 1) {
        chunkStart += width
        chunkUsed = 0
        width += 1
      }
      // A chunk with fewer than `width` unread bits is done; if the next one cannot hold a code
      // either, the input has ended (PV-0395).
      if (chunkBits(chunkStart, width, input.length) - chunkUsed < width) {
        chunkStart += width
        chunkUsed = 0
        if (chunkBits(chunkStart, width, input.length) < width) break
      }
      const code = readCode(input, (chunkStart << 3) + chunkUsed, width) // not-protocol: bytes to bits
      chunkUsed += width

      // Block mode: the clear code, accepted anywhere; the rest of the chunk is skipped (PV-0394).
      if (blockMode && code === LZCFormat.clearCode) {
        chunkStart += width
        chunkUsed = 0
        width = LZCFormat.initialWidth
        nextFree = LZCFormat.firstBlockModeCode
        hasPrevious = false
        continue
      }
      // No previous code: only a literal is valid (PV-0393).
      if (!hasPrevious) {
        if (code >= LZCFormat.literalCodeCount) throw new CompressedDataError({ kind: "badCode", code: { kind: "notALiteral", code } })
        out[produced] = code
        previousStart = produced
        previousLength = 1
        produced += 1
        hasPrevious = true
        continue
      }
      const start = produced
      let length: number
      if (code < LZCFormat.literalCodeCount) {
        // One byte always fits: the loop runs only while produced < declared.
        length = 1
        out[produced] = code
      } else if (code < nextFree) {
        const source = entryStart[code]
        length = entryLength[code]
        if (length > declared - produced)
          throw new CompressedDataError({ kind: "lengthMismatch", declaredLength: declared, decodedLength: produced + length })
        // The entry's string lies wholly before `produced`.
        out.copyWithin(produced, source, source + length)
      } else if (code === nextFree) {
        // Not stored yet: string(previous) + its first byte (PV-0392).
        length = previousLength + 1
        if (length > declared - produced)
          throw new CompressedDataError({ kind: "lengthMismatch", declaredLength: declared, decodedLength: produced + length })
        out.copyWithin(produced, previousStart, previousStart + previousLength)
        out[produced + previousLength] = out[previousStart]
      } else {
        throw new CompressedDataError({ kind: "badCode", code: { kind: "beyondNextFree", code, nextFree } })
      }
      // New entry: string(previous) + first byte of this string, which follow each other in the
      // output (PV-0391).
      if (nextFree < dictionaryLimit) {
        entryStart[nextFree] = previousStart
        entryLength[nextFree] = previousLength + 1
        nextFree += 1
      }
      previousStart = start
      previousLength = length
      produced += length
    }
    if (produced !== declared)
      throw new CompressedDataError({ kind: "lengthMismatch", declaredLength: declared, decodedLength: produced })
  }
}

/**
 * Bits the chunk at `start` holds: a chunk is `width` bytes, room for 8 codes (PV-0389), or fewer
 * at the end of the input.
 */
function chunkBits(start: number, width: number, inputCount: number): number {
  const available = inputCount - start
  if (available <= 0) return 0
  return Math.min(width, available) << 3 // not-protocol: bytes to bits
}

/**
 * Reads a `width`-bit code at `bitPosition`, least significant bit first (PV-0388). The caller
 * has checked that the input holds all of its bits.
 */
function readCode(input: Uint8Array, bitPosition: number, width: number): number {
  const index = bitPosition >>> 3 // not-protocol: bits to bytes
  const shift = bitPosition & 7 // not-protocol: bit within byte
  let bits = input[index] | (input[index + 1] << 8)
  if (shift + width > 16) bits |= input[index + 2] << 16 // not-protocol: third byte of a code
  return (bits >>> shift) & ((1 << width) - 1)
}
