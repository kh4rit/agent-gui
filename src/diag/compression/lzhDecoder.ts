// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/LZHDecoder.swift (MIT).
// STUB: the public API is fixed; the compression port fills in the body.

/**
 * Decoder for LZH compressed data (docs/protocol/compression-lzh.md), written from the spec. Keep
 * one per connection: its tables are allocated once.
 */
export class LZHDecoder {
  /**
   * Decodes `data` (after the 8-byte compression header). `declaredLength` is checked against
   * `maxLength` before any memory is reserved (`lengthOverCap`, IMPL-CH-5). On success returns
   * exactly `declaredLength` bytes; on failure throws `CompressedDataError` (no partial output).
   */
  decode(data: Uint8Array, declaredLength: number, maxLength: number): Uint8Array {
    throw new Error(`not ported yet (${data.length}, ${declaredLength}, ${maxLength})`) // STUB
  }
}
