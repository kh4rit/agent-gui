// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/RFCTables.swift (MIT).

// Table content inside an RFC item stream (docs/protocol/controls/rfc-tr.md §4, §5): the rows of
// consecutive `03 05` items joined into one value (IMPL-CT-3), and the prefix of compressed table
// content, an 8-byte preamble and the v1 compression header (IMPL-CT-4). Structure only: nothing
// here interprets the content, and no description shows a byte of it.

import { ByteWriter, WireBytes } from "../wire/index.js"
import { CompressionHeader, CompressionHeaderDecodingError, type CompressionHeaderDecodingErrorInfo, type Decompressor } from "./compressionHeader.js"
import { ByteRange } from "./diagCodec.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/** Why table reassembly stopped (IMPL-CT-3). */
export type RFCTableErrorInfo =
  /**
   * An id other than `03 05` or `03 06` where the next table item belongs, at `offset` of the input
   * (`bad-table-item`). At offset 0: the input does not start with a content item.
   */
  | { readonly kind: "badTableItem"; readonly id: number; readonly offset: number }
  /** The input ends inside a content item, or before the end item's length is complete, at `offset`. */
  | { readonly kind: "truncated"; readonly offset: number }

export class RFCTableError extends Error {
  constructor(readonly info: RFCTableErrorInfo) {
    super(
      info.kind === "badTableItem"
        ? `RFC table: item ${info.id.toString(16).padStart(4, "0")} at offset ${info.offset} is no table item`
        : `RFC table: truncated at offset ${info.offset}`
    )
    this.name = "RFCTableError"
  }
}

/**
 * Table content reassembled from its rows (rfc-tr.md §4, IMPL-CT-3): the values of consecutive
 * table-content items (`03 05`) concatenated, up to the table-content end item (`03 06`). The bytes
 * are the call's data and are never printed; the rows and the end item are structure.
 */
export class RFCTableContent {
  /** The id of a table-content item (PV-0912, PV-0913). */
  static readonly contentID = 0x0305 // provenance: PV-0912, PV-0913
  /** The id of the table-content end item (PV-0912, PV-0913). */
  static readonly endID = 0x0306 // provenance: PV-0912, PV-0913
  /** Bytes of an id, a length field or a trailing pair (PV-0910). */
  static readonly fieldSize = 2 // provenance: PV-0910

  private constructor(
    /** Each content item's value range in the input, in order: the rows. */
    readonly rows: readonly ByteRange[],
    /** The rows' values concatenated. */
    readonly bytes: Uint8Array,
    /**
     * The end item's length. It should be 0 (PV-0914); another length is read and discarded
     * (IMPL-CT-3), and kept here for diagnostics.
     */
    readonly endLength: number,
    /** The offset just after the end item's length field: where reassembly stopped. */
    readonly endOffset: number,
    /**
     * The bytes of the input after `endOffset`: the end item's value and trailing pair, and
     * whatever follows them.
     */
    readonly trailingByteCount: number
  ) {}

  /**
   * Reassembles the table whose first content item's id starts `stream` (Swift
   * `init(reassembling:)`, IMPL-CT-3): each content item's value is appended and its trailing pair
   * stepped over, unchecked (PV-0919), while the next id is `03 05`; the id `03 06` ends the table
   * once its length is read. Throws `RFCTableError`.
   */
  static reassemble(stream: Uint8Array): RFCTableContent {
    const size = RFCTableContent.fieldSize
    let offset = 0
    const rows: ByteRange[] = []
    const bytes = new ByteWriter()
    let end: { length: number; offset: number } | undefined
    while (end === undefined) {
      if (!(stream.length - offset >= size)) throw new RFCTableError({ kind: "truncated", offset })
      const id = WireBytes.u16BigEndian(stream, offset) // provenance: PV-0910
      const lengthOffset = offset + size
      if (id === RFCTableContent.contentID) {
        if (!(stream.length - lengthOffset >= size)) throw new RFCTableError({ kind: "truncated", offset: lengthOffset })
        const length = WireBytes.u16BigEndian(stream, lengthOffset) // provenance: PV-0910
        const value = new ByteRange(lengthOffset + size, lengthOffset + size + length)
        // The value and its trailing pair must both be there.
        if (!(stream.length - value.lowerBound >= length + size)) throw new RFCTableError({ kind: "truncated", offset: value.lowerBound })
        rows.push(value)
        bytes.bytes(value.of(stream))
        offset = value.upperBound + size
      } else if (id === RFCTableContent.endID && rows.length > 0) {
        if (!(stream.length - lengthOffset >= size)) throw new RFCTableError({ kind: "truncated", offset: lengthOffset })
        end = { length: WireBytes.u16BigEndian(stream, lengthOffset), offset: lengthOffset + size } // provenance: PV-0910
      } else {
        throw new RFCTableError({ kind: "badTableItem", id, offset })
      }
    }
    return new RFCTableContent(rows, bytes.toBytes(), end.length, end.offset, stream.length - end.offset)
  }

  /** Counts only: the bytes are the call's data. */
  get description(): string {
    return `RFCTableContent(rows: ${this.rows.length}, bytes: ${this.bytes.length}, endLength: ${this.endLength})`
  }

  toString(): string {
    return this.description
  }

  toJSON(): string {
    return this.description
  }

  [INSPECT](): string {
    return this.description
  }
}

/** Why the prefix of compressed table content could not be read (IMPL-CT-4). */
export type RFCCompressedTableErrorInfo =
  /** Fewer than the 16 bytes of the preamble and the compression header. */
  | { readonly kind: "truncated"; readonly available: number }
  /** The compression header at offset 8 fails the v1 checks (IMPL-CH-4). */
  | { readonly kind: "header"; readonly error: CompressionHeaderDecodingErrorInfo }

export class RFCCompressedTableError extends Error {
  constructor(readonly info: RFCCompressedTableErrorInfo) {
    super(
      info.kind === "truncated"
        ? `compressed table: ${info.available} bytes, shorter than the prefix`
        : `compressed table: ${new CompressionHeaderDecodingError(info.error).message}`
    )
    this.name = "RFCCompressedTableError"
  }
}

/**
 * The prefix of compressed table content (rfc-tr.md §5, IMPL-CT-4): a four-byte tag nobody explains
 * (ODG), a u32 BE length at offset 4 whose extent is in conflict (PV-0917, #82), and the v1
 * compression header at offset 8 (PV-0916, PV-0918); the compressed data follows it.
 */
export class RFCCompressedTable {
  /** Where the length field starts (PV-0917). */
  static readonly lengthOffset = 4 // provenance: PV-0917
  /** Where the compression header starts (PV-0916). */
  static readonly headerOffset = 8 // provenance: PV-0916
  /** Bytes before the compressed data: the preamble and the header. */
  static readonly prefixSize = RFCCompressedTable.headerOffset + CompressionHeader.size

  private constructor(
    /** The four bytes at offset 0, not interpreted (#82). */
    readonly tag: number,
    /** The u32 BE at offset 4, reported without being checked or used (#82). */
    readonly declaredLength: number,
    /** The compression header at offset 8. */
    readonly header: CompressionHeader,
    /**
     * Where the compressed data lies in the content: from `prefixSize` to its end, zero padding
     * included, which the v1 decoders ignore (IMPL-LZH-5, IMPL-LZC-3).
     */
    readonly dataRange: ByteRange
  ) {}

  /** Reads the prefix of reassembled table content (Swift `init(parsing:)`). Throws `RFCCompressedTableError`. */
  static parse(content: Uint8Array): RFCCompressedTable {
    if (!(content.length >= RFCCompressedTable.prefixSize)) throw new RFCCompressedTableError({ kind: "truncated", available: content.length })
    const tag = WireBytes.u32BigEndian(content, 0)
    const declaredLength = WireBytes.u32BigEndian(content, RFCCompressedTable.lengthOffset) // provenance: PV-0917
    let header: CompressionHeader
    try {
      header = CompressionHeader.decode(content.subarray(RFCCompressedTable.headerOffset, RFCCompressedTable.prefixSize))
    } catch (error) {
      if (error instanceof CompressionHeaderDecodingError) throw new RFCCompressedTableError({ kind: "header", error: error.info })
      throw error
    }
    return new RFCCompressedTable(tag, declaredLength, header, new ByteRange(RFCCompressedTable.prefixSize, content.length))
  }

  /**
   * Decompresses the data of `content`, the content this prefix was read from, with the v1 decoders
   * and `decompressor`'s output cap (IMPL-CT-4). Throws `CompressedDataError`.
   */
  decompress(content: Uint8Array, decompressor: Decompressor): Uint8Array {
    return decompressor.decompress(this.dataRange.of(content), this.header)
  }
}
