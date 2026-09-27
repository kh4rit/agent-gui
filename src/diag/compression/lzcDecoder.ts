// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/LZCDecoder.swift (MIT).
// STUB: the public API is fixed; the compression port fills in the bodies.

import { CompressedDataError } from "./diagCompression.js"

/**
 * The LZC parameters of compression-header byte 7 (docs/protocol/compression-lzc.md, "Header
 * parameters"): maxbits in the low five bits, block mode in bit 0x80; bits 0x20 and 0x40 are
 * ignored (PV-0310 to PV-0313).
 */
export class LZCParameters {
  /**
   * Fails with `badMaxbits` unless `maxbits` is 9–16 (PV-0311).
   * @param maxbits The largest code width, 9–16.
   * @param blockMode Block mode (code 256 is the clear code) or single-block mode.
   */
  constructor(
    readonly maxbits: number,
    readonly blockMode: boolean
  ) {
    throw new CompressedDataError({ kind: "badMaxbits", maxbits }) // STUB
  }

  /** Reads maxbits and block mode from compression-header byte 7 and checks maxbits (IMPL-LZC-4). */
  static fromHeaderByte7(byte7: number): LZCParameters {
    return new LZCParameters(LZCParameters.maxbits(byte7), LZCParameters.blockMode(byte7))
  }

  /** maxbits as byte 7 carries it, unchecked: byte 7 & 0x1F (PV-0310). */
  static maxbits(byte7: number): number {
    throw new Error(`not ported yet (${byte7})`) // STUB
  }

  /** Whether byte 7 selects block mode: bit 0x80 (PV-0312). */
  static blockMode(byte7: number): boolean {
    throw new Error(`not ported yet (${byte7})`) // STUB
  }

  /** Byte 7 for these parameters, with bits 0x20 and 0x40 clear (E-LZC-1). */
  get headerByte7(): number {
    throw new Error("not ported yet") // STUB
  }
}

/**
 * Decoder for LZC compressed data (docs/protocol/compression-lzc.md). Keep one per connection:
 * its dictionary is reused.
 */
export class LZCDecoder {
  /**
   * Decodes `data` (the code stream after the 8-byte compression header). `declaredLength` is
   * checked against `maxLength` before any memory is reserved (`lengthOverCap`, IMPL-CH-5). On
   * success returns exactly `declaredLength` bytes; on failure throws `CompressedDataError` (no
   * partial output).
   */
  decode(data: Uint8Array, parameters: LZCParameters, declaredLength: number, maxLength: number): Uint8Array {
    throw new Error(`not ported yet (${data.length}, ${parameters.maxbits}, ${declaredLength}, ${maxLength})`) // STUB
  }
}
