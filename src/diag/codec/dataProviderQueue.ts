// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DataProviderQueue.swift (MIT).

// The data objects a flush call carries for its controls (docs/protocol/controls/data-provider.md,
// trial-derived): the rows of the call's RFC_QUEUE table, each a fixed prefix and a slice of a
// nested RFC item stream, and that stream, a call of the data-provider function whose parameters
// name the object's URL and format and whose tables hold the rows' layout (FORMAT) and the rows
// (DATAASC or DATABIN). A tree's node and item tables and a grid's catalog and cell packets travel
// this way. Structure and values: a data object holds screen texts, which a description never shows.

import { ascii, toInt16, toInt32, WireBytes } from "../wire/index.js"
import { TextEncoding } from "./codePageText.js"

/** Swift `String(decoding: bytes, as: UTF8.self)`: UTF-8, ill-formed sequences replaced. */
export function decodeUTF8Repairing(bytes: Uint8Array): string {
  return TextEncoding.decodeRepairing("utf8", bytes)
}

/**
 * Swift `Int(text)`: an optional sign and decimal digits, nothing else; undefined for any other
 * text. A value beyond JavaScript's safe integers (Swift reads up to 2^63 − 1) is undefined too.
 */
export function parseInteger(text: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(text)) return undefined
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return undefined
  return value === 0 ? 0 : value // no -0
}

/** Swift's `String.trimmingSpaces` (this file's `extension String`): spaces cut at both ends. */
export function trimmingSpaces(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && text[start] === " ") start += 1
  while (end > start && text[end - 1] === " ") end -= 1
  return text.slice(start, end)
}

/** `bytes` without their trailing space bytes (a view). */
function droppingTrailingSpaces(bytes: Uint8Array): Uint8Array {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0x20) end -= 1 // not-protocol: space padding trimmed
  return bytes.subarray(0, end)
}

/** Swift's range subscript, which traps on a range outside the bytes: here a thrown RangeError. */
function checkedSlice(bytes: Uint8Array, lower: number, upper: number): Uint8Array {
  if (!(lower >= 0 && lower <= upper && upper <= bytes.length))
    throw new RangeError(`range ${lower} ..< ${upper} outside 0 ..< ${bytes.length} (a trap in Swift)`)
  return bytes.subarray(lower, upper)
}

/** The rows of one entry: one data object's stream in parts (Swift `DataProviderQueue.Entry`). */
export class DataProviderQueueEntry {
  /** The parts by number; each `DataProviderQueue.payloadWidth` bytes, the last one padded. */
  readonly parts = new Map<number, Uint8Array>()

  constructor(
    /** The entry id, the four hex digits after the key, as text. */
    readonly id: string,
    /** The sequence number in the call. */
    readonly sequence: number,
    /** The program name of the prefix. */
    readonly program: string
  ) {}

  /** `1 ... highest part`; Swift traps on a highest part number below 1, the port throws. */
  private partNumbers(): number[] {
    const highest = Math.max(...this.parts.keys())
    if (!(highest >= 1)) throw new RangeError(`range 1 ... ${highest}: lowerBound above upperBound (a trap in Swift)`)
    return Array.from({ length: highest }, (_, index) => index + 1)
  }

  /** The part numbers missing below the highest. */
  get missingParts(): number[] {
    if (this.parts.size === 0) return []
    return this.partNumbers().filter(number => !this.parts.has(number))
  }

  /** The parts joined, when none is missing. */
  get payload(): Uint8Array | undefined {
    if (this.parts.size === 0 || this.missingParts.length > 0) return undefined
    const parts = this.partNumbers().map(number => this.parts.get(number)!)
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) {
      output.set(part, offset)
      offset += part.length
    }
    return output
  }
}

/** The row prefix of an RFC_QUEUE row and the reassembly of its entries (PV-1000, PV-1001). */
export const DataProviderQueue = {
  /** The table's name (PV-1000). */
  tableName: ascii("RFC_QUEUE"), // provenance: PV-1000
  /** A row: the prefix, then `payloadWidth` bytes of the entry's stream (PV-1000). */
  rowWidth: 1853, // provenance: PV-1000
  /** The key: 20 characters that name the connection, then the entry id as four hex digits. */
  keyWidth: 20, // provenance: PV-1000
  entryIDWidth: 4, // provenance: PV-1000
  /** The program name, space-padded. */
  programWidth: 32, // provenance: PV-1000
  /** The entry's sequence number in the call, eight decimal digits. */
  sequenceWidth: 8, // provenance: PV-1000
  /** The part number, u32 BE, from 1. */
  partWidth: 4, // provenance: PV-1000
  /** Where a row's payload starts. */
  get prefixWidth(): number {
    return DataProviderQueue.keyWidth + DataProviderQueue.entryIDWidth + DataProviderQueue.programWidth + DataProviderQueue.sequenceWidth + DataProviderQueue.partWidth
  },
  /** The payload bytes of a row. */
  get payloadWidth(): number {
    return DataProviderQueue.rowWidth - DataProviderQueue.prefixWidth
  },

  /**
   * The entries of a table's rows (width × count bytes), in the order their first row appears: rows
   * with the same key, id and sequence number belong to one entry, and the part number orders them.
   * A row shorter than the prefix is skipped.
   */
  entries(rows: Uint8Array): DataProviderQueueEntry[] {
    const queue = DataProviderQueue
    const prefixWidth = queue.prefixWidth
    const entries: DataProviderQueueEntry[] = []
    const indexByKey = new Map<string, number>()
    let start = 0
    while (start + prefixWidth < rows.length) {
      const row = rows.subarray(start, Math.min(start + queue.rowWidth, rows.length))
      start += queue.rowWidth
      const key = decodeUTF8Repairing(row.subarray(0, queue.keyWidth + queue.entryIDWidth))
      const id = Array.from(key).slice(-queue.entryIDWidth).join("")
      let offset = queue.keyWidth + queue.entryIDWidth
      const program = decodeUTF8Repairing(droppingTrailingSpaces(row.subarray(offset, offset + queue.programWidth))) // not-protocol: space padding trimmed
      offset += queue.programWidth
      const sequence = parseInteger(decodeUTF8Repairing(row.subarray(offset, offset + queue.sequenceWidth))) ?? 0
      offset += queue.sequenceWidth
      const part = WireBytes.u32BigEndian(row, offset) // provenance: PV-1000
      const entryKey = `${key}/${sequence}`
      let index = indexByKey.get(entryKey)
      if (index === undefined) {
        index = entries.length
        indexByKey.set(entryKey, index)
        entries.push(new DataProviderQueueEntry(id, sequence, program))
      }
      entries[index].parts.set(part, row.slice(prefixWidth))
    }
    return entries
  }
} as const

/** One field of a data object's rows, as its FORMAT table lays it out (PV-1004). */
export class DataField {
  /**
   * The FORMAT record layout (PV-1004): 80 bytes, the structure name, the field number as text,
   * four little-endian 32-bit numbers (the field's number, offset, length and 0), then the type
   * character.
   */
  static readonly recordWidth = 80 // provenance: PV-1004
  static readonly structureNameWidth = 30 // provenance: PV-1004
  static readonly numberTextWidth = 30 // provenance: PV-1004
  static readonly numbersOffset = DataField.structureNameWidth + DataField.numberTextWidth
  static readonly typeOffset = DataField.numbersOffset + 4 * 4 // provenance: PV-1004
  static readonly text = 0x43 // provenance: PV-1004
  static readonly integer = 0x49 // provenance: PV-1004
  static readonly shortInteger = 0x73 // provenance: PV-1004

  constructor(
    /** The field's number, from 1. */
    readonly index: number,
    /** The offset in a row. */
    readonly offset: number,
    /** The length in bytes. */
    readonly length: number,
    /** The type character: `C` text, `I` a 4-byte integer, `s` a 2-byte integer; others as seen. */
    readonly type: number
  ) {}

  /** Reads one FORMAT record (Swift `init?(record:)`); undefined when the record is short. */
  static of(record: Uint8Array): DataField | undefined {
    if (!(record.length >= DataField.recordWidth)) return undefined
    const number = (slot: number): number => toInt32(WireBytes.u32LittleEndian(record, DataField.numbersOffset + slot * 4)) // provenance: PV-1004
    return new DataField(number(0), number(1), number(2), record[DataField.typeOffset]) // provenance: PV-1004
  }

  /** The structure name of a FORMAT record, without trailing spaces (`X-UNKNOWN` when the server names none). */
  static structureName(record: Uint8Array): string {
    return decodeUTF8Repairing(droppingTrailingSpaces(record.subarray(0, DataField.structureNameWidth))) // not-protocol: space padding trimmed
  }
}

/**
 * A data object a control loads (PV-1001–PV-1003): its URL and format, the layout of its rows and
 * the rows themselves. Cells are read by field, as text or as a number.
 */
export class DataObject {
  constructor(
    /** The entry's sequence number in its call. */
    readonly sequence: number,
    /** The `DESURL` parameter: the URL a `SetDataFromUrl` verb names (PV-1002). */
    readonly url: string,
    /** The `TYPE` and `SUBTYPE` parameters, for example `APPLICATION` and `X-R3TABLE`. */
    readonly type: string,
    readonly subtype: string,
    /** The structure name the FORMAT records carry, or undefined for `X-UNKNOWN`. */
    readonly structureName: string | undefined,
    /** The fields in the FORMAT table's order. */
    readonly fields: readonly DataField[],
    /** The row width the data table declares. */
    readonly rowWidth: number,
    /** The rows, each `rowWidth` bytes: screen texts, never described. */
    readonly rows: readonly Uint8Array[]
  ) {}

  /** The field with number `index` (from 1). */
  field(index: number): DataField | undefined {
    return this.fields.find(field => field.index === index)
  }

  /** The cell of `row` and field number `index`, or undefined when the field is not there. */
  private cell(row: number, index: number): { field: DataField; bytes: Uint8Array } | undefined {
    const field = this.field(index)
    if (field === undefined || !(row < this.rows.length)) return undefined
    if (row < 0) throw new RangeError(`row ${row} (a trap in Swift)`)
    if (!(field.offset + field.length <= this.rows[row].length)) return undefined
    return { field, bytes: checkedSlice(this.rows[row], field.offset, field.offset + field.length) }
  }

  /**
   * A text cell without its trailing spaces, decoded as UTF-8 (the server's texts in the
   * connection's code page; non-ASCII bytes are replaced); undefined when the field is not there.
   */
  text(row: number, field: number): string | undefined {
    const cell = this.cell(row, field)
    if (cell === undefined) return undefined
    return decodeUTF8Repairing(droppingTrailingSpaces(cell.bytes)) // not-protocol: space padding trimmed
  }

  /** A number cell: a 4-byte or 2-byte little-endian integer, or the digits of a text cell. */
  number(row: number, field: number): number | undefined {
    const cell = this.cell(row, field)
    if (cell === undefined) return undefined
    if (cell.field.type === DataField.integer && cell.field.length === 4) return toInt32(WireBytes.u32LittleEndian(cell.bytes, 0)) // provenance: PV-1004
    if (cell.field.type === DataField.shortInteger && cell.field.length === 2) return toInt16(WireBytes.u16LittleEndian(cell.bytes, 0)) // provenance: PV-1004
    return parseInteger(trimmingSpaces(decodeUTF8Repairing(cell.bytes)))
  }

  /** A one-character flag cell: `X` means set. */
  flag(row: number, field: number): boolean {
    return this.text(row, field) === "X" // provenance: PV-1005
  }

  /** Structure only: the URL's length, the type, the field count and the row count. */
  get description(): string {
    return `DataObject(${this.type}/${this.subtype}, url ${Array.from(this.url).length} chars, ${this.fields.length} field(s), ${this.rows.length} row(s) of ${this.rowWidth})`
  }

  toString(): string {
    return this.description
  }
}
