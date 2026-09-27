// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/InventedDataObject.swift (MIT).

import { concatBytes } from "../../diag/wire/index.js"
import { InventedFlushCall, InventedFlushCallTable, utf8 } from "./inventedFlushCall.js"

/** A field: text of a length, a 4-byte integer, or a 2-byte integer (Swift `InventedDataObject.Field`). */
export type InventedField = { readonly kind: "text"; readonly length: number } | { readonly kind: "integer" } | { readonly kind: "short" }

export const InventedField = {
  text: (length: number): InventedField => ({ kind: "text", length }),
  integer: { kind: "integer" } as InventedField,
  short: { kind: "short" } as InventedField,

  length(field: InventedField): number {
    switch (field.kind) {
      case "text":
        return field.length
      case "integer":
        return 4
      case "short":
        return 2
    }
  },

  type(field: InventedField): number {
    switch (field.kind) {
      case "text":
        return 0x43 // "C"
      case "integer":
        return 0x49 // "I"
      case "short":
        return 0x73 // "s"
    }
  }
} as const

/** A cell: a text or a number (Swift `InventedDataObject.Cell`, written as string and integer literals). */
export type InventedCell = string | number

/** `bytes` cut or padded with spaces to `width`. */
function pad(bytes: Uint8Array, width: number): Uint8Array {
  return bytes.length >= width ? bytes.slice(0, width) : concatBytes(bytes, new Uint8Array(width - bytes.length).fill(0x20))
}

/** Four little-endian bytes of `number`. */
const le32 = (number: number): number[] => [number & 0xff, (number >> 8) & 0xff, (number >> 16) & 0xff, (number >> 24) & 0xff]

/**
 * An invented data object of a flush call's RFC_QUEUE table (docs/protocol/controls/data-provider.md),
 * for the tests of Swooey's reader: its fields, its rows of invented values, and the rows of the queue
 * table that carry it, framed by this file's own code (PV-1000 to PV-1004). Every value is invented
 * and deliberately funny (D15); the parameter and table names are protocol identifiers.
 */
export class InventedDataObject {
  url: string
  type = "APPLICATION"
  subtype = "X-R3TABLE"
  /** The structure name the FORMAT records carry; undefined writes `X-UNKNOWN`. */
  structureName: string | undefined
  fields: InventedField[]
  rows: InventedCell[][]
  /** The entry id's four hex digits and its sequence number in the call. */
  id = "0001"
  sequence = 1
  /** The rows are compressed unless `raw`. */
  raw = false

  constructor(url: string, fields: InventedField[], rows: InventedCell[][], structureName?: string) {
    this.url = url
    this.structureName = structureName
    this.fields = fields
    this.rows = rows
  }

  /** A copy, where a Swift test copies the struct (`var object = …`) and changes the copy. */
  clone(): InventedDataObject {
    const copy = new InventedDataObject(
      this.url,
      this.fields.slice(),
      this.rows.map(row => row.slice()),
      this.structureName
    )
    copy.type = this.type
    copy.subtype = this.subtype
    copy.id = this.id
    copy.sequence = this.sequence
    copy.raw = this.raw
    return copy
  }

  /**
   * The fields' offsets: an integer is aligned to 4 bytes, a short to 2; and the row width, padded to
   * a multiple of 4 (PV-1003).
   */
  get layout(): { offsets: number[]; width: number } {
    const offsets: number[] = []
    let offset = 0
    for (const field of this.fields) {
      const length = InventedField.length(field)
      const alignment = length > 1 && InventedField.type(field) !== 0x43 ? length : 1
      offset += (alignment - (offset % alignment)) % alignment
      offsets.push(offset)
      offset += length
    }
    return { offsets, width: offset + ((4 - (offset % 4)) % 4) }
  }

  /** The FORMAT records (PV-1004). */
  get formatRows(): Uint8Array[] {
    const { offsets } = this.layout
    return this.fields.map((field, index) => {
      const numbers = [index + 1, offsets[index], InventedField.length(field), 0].flatMap(le32)
      const record = concatBytes(pad(utf8(this.structureName ?? "X-UNKNOWN"), 30), pad(utf8(String(index + 1)), 30), numbers, [InventedField.type(field)])
      return pad(record, 80)
    })
  }

  /** The data rows, each cell at its field's offset. */
  get dataRows(): Uint8Array[] {
    const { offsets, width } = this.layout
    return this.rows.map(cells => {
      const row = new Uint8Array(width).fill(0x20)
      this.fields.forEach((field, index) => {
        if (!(index < cells.length)) return
        const offset = offsets[index]
        const cell = cells[index]
        if (field.kind === "text") {
          const bytes = utf8(typeof cell === "string" ? cell : String(cell)).subarray(0, field.length)
          row.set(bytes, offset)
        } else if (field.kind === "integer" && typeof cell === "number") {
          row.set(le32(cell), offset)
        } else if (field.kind === "short" && typeof cell === "number") {
          row.set([cell & 0xff, (cell >> 8) & 0xff], offset)
        }
      })
      return row
    })
  }

  /**
   * The type-structure value: the field count, then a type and a length byte per field, with padding
   * entries (type 0x1a) where alignment leaves gaps (PV-1003).
   */
  get typeStructure(): Uint8Array {
    const { offsets, width } = this.layout
    const value = [0]
    let count = 0
    let position = 0
    this.fields.forEach((field, index) => {
      if (offsets[index] > position) {
        value.push(0x1a, offsets[index] - position)
        count += 1
      }
      const length = InventedField.length(field)
      // A length past a byte is written as 255: the reader takes the layout from FORMAT.
      value.push(InventedField.type(field) === 0x43 ? 0 : length === 2 ? 9 : 8, Math.min(length, 255))
      count += 1
      position = offsets[index] + length
    })
    if (width > position) {
      value.push(0x1a, width - position)
      count += 1
    }
    value[0] = count
    return Uint8Array.from(value)
  }

  /**
   * The nested stream: a call of the data-provider function with its parameters and tables
   * (PV-1001), framed as `InventedFlushCall` frames items.
   */
  get stream(): Uint8Array {
    const item = InventedFlushCall.item
    const parts = [item(0x0101, utf8("QUACKRFC")), item(0x0006, utf8("SAPGUI_QUEUE")), item(0x0102, utf8("DP_PUT_CLIENT_TABLE45A"))]
    const parameters: [string, string][] = [
      ["CACHEABLE", " "],
      ["DESURL", this.url],
      ["SUBTYPE", this.subtype],
      ["TYPE", this.type]
    ]
    for (const [name, value] of parameters) parts.push(item(0x0201, utf8(name)), item(0x0203, utf8(value)))
    const { width } = this.layout
    const data = new InventedFlushCallTable("DATAASC", width, this.dataRows)
    data.raw = this.raw
    const format = new InventedFlushCallTable("FORMAT", 80, this.formatRows)
    format.raw = this.raw
    parts.push(this.table(data, this.typeStructure), this.table(format, Uint8Array.of(7, 0, 30, 0, 30, 8, 4, 8, 4, 8, 4, 8, 4, 0, 1)))
    parts.push(item(0x0213, [2, 0, 20, 0, 60]), item(0x0301, utf8("PROPS")))
    parts.push(item(0x0302, concatBytes(InventedFlushCall.u32(80), InventedFlushCall.u32(0))))
    parts.push(item(0xffff, []))
    return concatBytes(...parts)
  }

  /**
   * The RFC_QUEUE rows that carry `stream`: the 68-byte prefix and 1785 bytes of the stream per row,
   * the last row padded with zero bytes (PV-1000).
   */
  get queueRows(): Uint8Array[] {
    const payload = this.stream
    const width = 1853 - 68
    const rows: Uint8Array[] = []
    for (let start = 0, part = 0; start < payload.length; start += width, part++) {
      const digits = String(this.sequence)
      const slice = payload.subarray(start, Math.min(start + width, payload.length))
      rows.push(
        concatBytes(
          utf8("ZZQUACKQUACKQUACK001"),
          utf8(this.id),
          pad(utf8("SAPGUI"), 32),
          utf8("0".repeat(Math.max(8 - digits.length, 0)) + digits),
          InventedFlushCall.u32(part + 1),
          slice,
          new Uint8Array(width - slice.length)
        )
      )
    }
    return rows
  }

  private table(table: InventedFlushCallTable, type: Uint8Array): Uint8Array {
    const item = InventedFlushCall.item
    const parts = [item(0x0213, type), item(0x0301, table.name), item(0x0302, concatBytes(InventedFlushCall.u32(table.width), InventedFlushCall.u32(table.rows.length)))]
    if (table.rows.length === 0) return concatBytes(...parts)
    if (table.raw) return concatBytes(...parts, ...table.rows.map(row => item(0x0304, row)))
    return concatBytes(...parts, InventedFlushCall.contentItems(InventedFlushCall.compressed(concatBytes(...table.rows), 0x7b02_00ea)))
  }
}
