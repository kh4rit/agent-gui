// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/RFCEncoding.swift (MIT).

// Swooey's own RFC item and table content encoders (docs/protocol/controls/rfc-tr.md §7.8,
// IMPL-CT-12 and IMPL-CT-13), for the answer Swooey builds to a server call. What they write walks
// back with `RFCItemWalker` (IMPL-CT-2), reassembles with `RFCTableContent` (IMPL-CT-3) and parses
// with `RFCCompressedTable` (IMPL-CT-4). No byte of any captured answer is used: every byte is a
// value handed in, a length, or a constant with its PV row.
//
// Swift appends to an `inout [UInt8]`; the port appends to a `ByteWriter`.

import { LZHEncodingError, type LZHEncoder } from "../compression/index.js"
import { ByteWriter, WireBytes } from "../wire/index.js"
import { CompressionHeader, CompressionHeaderEncodingError } from "./compressionHeader.js"
import { isUInt32 } from "./diagCodec.js"
import { RFCCompressedTable, RFCTableContent } from "./rfcTables.js"

/** Why an RFC item could not be written (IMPL-CT-12). */
export type RFCItemEncodingErrorInfo =
  /** The value is longer than the item's u16 length field can declare (PV-0910). */
  { readonly kind: "valueTooLong"; readonly id: number; readonly length: number }

export class RFCItemEncodingError extends Error {
  constructor(readonly info: RFCItemEncodingErrorInfo) {
    super(`valueTooLong(id: ${info.id}, length: ${info.length})`)
    this.name = "RFCItemEncodingError"
  }
}

/**
 * The RFC item encoder (rfc-tr.md §3, IMPL-CT-12): an item is its two id bytes, the value's length
 * as a u16 BE, the value, and the id's two bytes again as the trailing pair (PV-0910, PV-0919). The
 * end item is `FF FF 00 00 FF FF` (PV-0911, PV-0920).
 */
export const RFCItemEncoder = {
  /** The longest value one item carries: its length field is a u16 (PV-0910). */
  maxValueLength: 0xffff, // provenance: PV-0910

  /**
   * The end item: id `FF FF`, length 0, its trailing pair, and nothing after it (PV-0911, PV-0919,
   * PV-0920). A fresh copy on every read.
   */
  get endItem(): Uint8Array {
    return Uint8Array.of(0xff, 0xff, 0x00, 0x00, 0xff, 0xff) // provenance: PV-0911, PV-0919, PV-0920
  },

  /** Appends one item; a value longer than `maxValueLength` is refused and nothing is written. */
  append(id: number, value: Uint8Array, stream: ByteWriter): void {
    if (!(value.length <= RFCItemEncoder.maxValueLength)) throw new RFCItemEncodingError({ kind: "valueTooLong", id, length: value.length })
    RFCItemEncoder.appendU16(id, stream) // provenance: PV-0910
    RFCItemEncoder.appendU16(value.length, stream) // provenance: PV-0910
    stream.bytes(value)
    RFCItemEncoder.appendU16(id, stream) // provenance: PV-0919
  },

  /** Appends the end item (`endItem`). */
  appendEnd(stream: ByteWriter): void {
    stream.bytes(RFCItemEncoder.endItem)
  },

  /** Appends `value` most significant byte first. */
  appendU16(value: number, stream: ByteWriter): void {
    stream.u16be(value)
  }
} as const

/** Why table content could not be written (IMPL-CT-13). */
export type RFCTableEncodingErrorInfo =
  /** The rows are not a whole number of rows of `width` bytes, or `width` is 0. */
  | { readonly kind: "notWholeRows"; readonly bytes: number; readonly width: number }
  /** A raw row does not fit an RFC item. */
  | { readonly kind: "item"; readonly error: RFCItemEncodingErrorInfo }
  /** The rows are longer than the compression header's u32 length or the LZH encoder takes. */
  | { readonly kind: "tooLong"; readonly bytes: number }

export class RFCTableEncodingError extends Error {
  constructor(readonly info: RFCTableEncodingErrorInfo) {
    super(describeTableEncodingError(info))
    this.name = "RFCTableEncodingError"
  }
}

function describeTableEncodingError(info: RFCTableEncodingErrorInfo): string {
  switch (info.kind) {
    case "notWholeRows":
      return `notWholeRows(bytes: ${info.bytes}, width: ${info.width})`
    case "item":
      return `item(${new RFCItemEncodingError(info.error).message})`
    case "tooLong":
      return `tooLong(bytes: ${info.bytes})`
  }
}

/** Runs `body`, turning an `RFCItemEncodingError` into `RFCTableEncodingError.item`. */
function asTableError<T>(body: () => T): T {
  try {
    return body()
  } catch (error) {
    if (error instanceof RFCItemEncodingError) throw new RFCTableEncodingError({ kind: "item", error: error.info })
    throw error
  }
}

/**
 * The table content encoder (rfc-tr.md §7.8, Reading R-CT-31, IMPL-CT-13): a table's rows as the
 * items that follow its `03 01` and `03 02` items, either as raw rows or compressed.
 */
export const RFCTableContentEncoder = {
  /** The id of a raw row item: one row per item, and no end item after them (PV-0934). */
  rawRowID: 0x0304, // provenance: PV-0934
  /**
   * Bytes of every table-content item of compressed content, the last one included: the content
   * is padded to a whole number of them (PV-0915, PV-0933).
   */
  contentItemSize: 250, // provenance: PV-0915, PV-0933
  /** The padding byte of rows, and the one byte a blank raw row travels as (PV-0934). */
  space: 0x20, // provenance: PV-0934
  /**
   * The byte compressed content is padded with: Swooey's choice, since what fills SAP GUI's
   * padding is not shown; ODG describes zero padding (rfc-tr.md §5, R-CT-31).
   */
  padding: 0,

  /**
   * Appends the rows as raw rows (R-CT-31): one `03 04` item per row, a blank row (all spaces) as
   * one space, every other row whole, at the row width, and no `03 06` item (PV-0934: every
   * non-blank raw row seen, the server's and SAP GUI's, was full width; the one shortened row was
   * blank). Zero rows append nothing. `blank` is the space character in the rows' text encoding
   * (Reading R-CT-37): a row of it is blank and travels as one of it.
   */
  appendRaw(rows: Uint8Array, width: number, stream: ByteWriter, blank: Uint8Array = Uint8Array.of(RFCTableContentEncoder.space)): void {
    if (!(width > 0 && rows.length % width === 0 && blank.length > 0 && width % blank.length === 0))
      throw new RFCTableEncodingError({ kind: "notWholeRows", bytes: rows.length, width })
    let start = 0
    while (start < rows.length) {
      const end = start + width
      let blankRow = true
      for (let index = start; index < end; index++) {
        if (rows[index] !== blank[(index - start) % blank.length]) {
          blankRow = false
          break
        }
      }
      asTableError(() => {
        if (blankRow) RFCItemEncoder.append(RFCTableContentEncoder.rawRowID, blank, stream)
        else RFCItemEncoder.append(RFCTableContentEncoder.rawRowID, rows.subarray(start, end), stream)
      })
      start = end
    }
  },

  /**
   * The compressed content of `rows` (R-CT-31): the four bytes of `tag`, the length L as a u32 BE,
   * the v1 compression header for LZH with level 2 and the uncompressed length of the rows (PV-0916,
   * PV-0918, PV-0933), and the LZH data; L counts from offset 0 to the end of the data (PV-0917,
   * PV-0933). The content is then padded with `padding` bytes to a whole number of
   * `contentItemSize` bytes. The rows must not be empty: a table of 0 rows has no content.
   */
  compressedContent(rows: Uint8Array, tag: number, encoder: LZHEncoder): Uint8Array {
    if (!(isUInt32(rows.length) && rows.length > 0)) throw new RFCTableEncodingError({ kind: "tooLong", bytes: rows.length })
    let header: CompressionHeader
    try {
      header = CompressionHeader.lzh(rows.length)
    } catch (error) {
      if (error instanceof CompressionHeaderEncodingError) throw new RFCTableEncodingError({ kind: "tooLong", bytes: rows.length })
      throw error
    }
    const content = new ByteWriter(RFCCompressedTable.prefixSize + (rows.length >>> 1))
    WireBytes.appendU32BigEndian(tag, content)
    WireBytes.appendU32BigEndian(0, content) // L, written below
    header.serialize(content)
    try {
      encoder.encodeInto(rows, content)
    } catch (error) {
      if (error instanceof LZHEncodingError) throw new RFCTableEncodingError({ kind: "tooLong", bytes: rows.length })
      throw error
    }
    const declared = content.length
    if (!isUInt32(declared)) throw new RFCTableEncodingError({ kind: "tooLong", bytes: rows.length })
    content.setU32be(RFCCompressedTable.lengthOffset, declared) // provenance: PV-0917, PV-0933
    const remainder = content.length % RFCTableContentEncoder.contentItemSize
    if (remainder !== 0) content.repeat(RFCTableContentEncoder.padding, RFCTableContentEncoder.contentItemSize - remainder)
    return content.toBytes()
  },

  /**
   * Appends `rows` compressed (R-CT-31): `compressedContent` as one `03 05` item per
   * `contentItemSize` bytes, then the table-content end `03 06` with length 0 (PV-0913, PV-0914,
   * PV-0933). Returns how many `03 05` items it wrote.
   */
  appendCompressed(rows: Uint8Array, tag: number, encoder: LZHEncoder, stream: ByteWriter): number {
    const content = RFCTableContentEncoder.compressedContent(rows, tag, encoder)
    let start = 0
    while (start < content.length) {
      // compressedContent pads to whole items, so every item carries contentItemSize bytes.
      const end = start + RFCTableContentEncoder.contentItemSize
      asTableError(() => RFCItemEncoder.append(RFCTableContent.contentID, content.subarray(start, end), stream))
      start = end
    }
    asTableError(() => RFCItemEncoder.append(RFCTableContent.endID, new Uint8Array(0), stream)) // provenance: PV-0914
    return content.length / RFCTableContentEncoder.contentItemSize
  }
} as const
