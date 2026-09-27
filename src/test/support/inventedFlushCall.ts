// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/InventedFlushCall.swift (MIT).

import { CompressionHeader, CompressionHeaderEncodingError } from "../../diag/codec/index.js"
import { LZHEncoder, LZHEncodingError } from "../../diag/compression/index.js"
import { concatBytes } from "../../diag/wire/index.js"

/** Swift `Array(text.utf8)`. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The head's form (§7.7.2): the long form's eleven extra items after `00 17`. */
export type InventedFlushCallForm = "long" | "short"

/**
 * How the call's texts travel (rfc-tr.md Reading R-CT-37, issue #150): single-byte, as SAP GUI's
 * server sent them; UTF-16 in either byte order, two bytes per character, table widths in bytes; or
 * single-byte with the function name padded with zero bytes. Binary items (`01 01`, `01 03`,
 * `01 06`, `01 36`, `02 13`, `04 20`, …) and the `3C` group are the same in all four.
 */
export type InventedFlushCallText = "singleByte" | "utf16LittleEndian" | "utf16BigEndian" | "zeroPaddedName"

export const InventedFlushCallText = {
  allCases: ["singleByte", "utf16LittleEndian", "utf16BigEndian", "zeroPaddedName"] as readonly InventedFlushCallText[]
} as const

/** One of the call's tables (Swift `InventedFlushCall.Table`). A Swift struct: `clone()` copies it. */
export class InventedFlushCallTable {
  name: Uint8Array
  width: number
  rows: Uint8Array[]
  /** Raw `03 04` rows instead of compressed content. */
  raw = false
  /** The four bytes at offset 0 of compressed content: invented, so that an echo shows. */
  tag = 0x5155_4143
  /** Content items to send instead of the rows' own (for broken calls). */
  content: Uint8Array | undefined = undefined
  /** The row count to declare instead of the rows' (for broken calls). */
  declaredRows: number | undefined = undefined

  constructor(name: string | Uint8Array, width: number, rows: readonly Uint8Array[] = []) {
    this.name = typeof name === "string" ? utf8(name) : name.slice()
    this.width = width
    this.rows = rows.map(row => row.slice())
  }

  clone(): InventedFlushCallTable {
    const copy = new InventedFlushCallTable(this.name, this.width, this.rows)
    copy.raw = this.raw
    copy.tag = this.tag
    copy.content = this.content?.slice()
    copy.declaredRows = this.declaredRows
    return copy
  }
}

/**
 * An invented `OLE_FLUSH_CALL` in the shape of docs/protocol/controls/rfc-tr.md §7.7.2, for the tests
 * of Swooey's call reader and answer builder (§7.8, IMPL-CT-14). Every value is invented and
 * deliberately funny (D15); only the protocol identifiers the spec names are real (`OLE_FLUSH_CALL`,
 * `IMPORT_XML`, `EXPORT_XML`, `SVARS`, `VARS`, `VERBS`, `XML_DATA_STREAM` and the verbs of Reading
 * R-CT-34).
 *
 * The bytes are written by this type's own framing, not by Swooey's encoders, so that a test of the
 * encoders is no test of themselves: each item is its id, a u16 BE length, the value and the id
 * again (PV-0910, PV-0919); a raw row is one `03 04` item at the full row width, as the server sent
 * its raw rows (PV-0934); a compressed table's content is the tag, L from offset 0, the v1 LZH header
 * and the data (PV-0933), split into `03 05` items of 250 bytes with the last one short, as ODG saw
 * (PV-0915), where Swooey pads its own (PV-0933).
 *
 * A Swift struct: where a Swift test copies one (`var call = Self.pond`) and changes the copy, the
 * port calls `clone()`.
 */
export class InventedFlushCall {
  /** The echoed head items' ids (R-CT-29). */
  static readonly echoedHeadIDs: readonly number[] = [0x0101, 0x0103, 0x0106, 0x0007, 0x0018, 0x0013, 0x0012, 0x0006]
  /** The head items that hold texts, written in the call's text. */
  static readonly textHeadIDs: ReadonlySet<number> = new Set([
    0x0007, 0x0018, 0x0008, 0x0011, 0x0013, 0x0012, 0x0006, 0x0130, 0x0111, 0x0114, 0x0003, 0x0135, 0x0010, 0x0002, 0x0115, 0x0009, 0x0134,
    0x0021
  ])
  /** How long the zero-padded function name is: the name, then zero bytes. */
  static readonly paddedNameLength = 30

  form: InventedFlushCallForm
  text: InventedFlushCallText = "singleByte"
  /** The function name's bytes as sent, instead of `function` in `text` (for mixed calls). */
  functionBytes: Uint8Array | undefined = undefined
  function = "OLE_FLUSH_CALL"
  /** The head items before the function name, in order. */
  head: { id: number; value: Uint8Array }[]
  /** The value of the import parameter's `02 03` item, sent as it is. */
  parameterValue: Uint8Array = Uint8Array.of(0)
  /** The export parameters (`02 05`), in order. */
  parameters: string[] = ["IMPORT_XML", "SVARS", "ZZ_QUACK_REPORT", "EXPORT_XML", "SVARS"]
  /** The six tables, in the order of §7.7.2. */
  tables: InventedFlushCallTable[]
  /** Bytes after the end item. */
  afterEnd: Uint8Array = new Uint8Array(0)
  /** The end item; undefined leaves it out. */
  endItem: Uint8Array | undefined = Uint8Array.of(0xff, 0xff, 0x00, 0x00, 0xff, 0xff)

  /** A call with these descriptor rows, value records and verbs. */
  constructor(
    options: { descriptors?: readonly Uint8Array[]; values?: readonly Uint8Array[]; verbs?: readonly Uint8Array[]; form?: InventedFlushCallForm } = {}
  ) {
    this.form = options.form ?? "short"
    const h = (id: number, value: string | number[]) => ({ id, value: typeof value === "string" ? utf8(value) : Uint8Array.from(value) })
    this.head = [
      h(0x0101, "QUACKRFC"),
      h(0x0103, [0x00, 0x00, 0x0d, 0x0c]),
      h(0x0106, "\u{01}DUCKHEAD01"),
      h(0x0161, [0x00]),
      h(0x0015, [0x00, 0x00, 0x00, 0x2a]),
      h(0x0127, "the pond's context blob"),
      h(0x0007, "QUACK-QUACK-001"),
      h(0x0020, [0, 0, 0, 0]),
      h(0x0021, "00"),
      h(0x0018, "POND-NEST-12"),
      h(0x0008, "THE-POND-KEEPER-1"),
      h(0x0011, "3"),
      h(0x0013, "DUCK"),
      h(0x0012, "MOAT"),
      h(0x0006, "WADDLE"),
      h(0x0130, "ZZ_POND_OLE"),
      h(0x0017, [])
    ]
    if (this.form === "long") {
      this.head.push(
        h(0x0111, "ZZDUCKER"),
        h(0x0114, "DCK"),
        h(0x0003, "DCK"),
        h(0x0135, "POND-LOCAL"),
        h(0x0010, "00"),
        h(0x0002, "THE-BIG-POND"),
        h(0x0114, "DCK"),
        h(0x0115, "E"),
        h(0x0009, "ZZMALLRD"),
        h(0x0134, "WET"),
        h(0x0501, [0x01]),
        h(0x0136, "duck metadata"),
        h(0x0502, [])
      )
    } else {
      this.head.push(h(0x0502, []), h(0x0136, "duck metadata"))
    }
    this.tables = [
      new InventedFlushCallTable("ZZ_POND_CATALOG", 260),
      new InventedFlushCallTable("ZZ_DUCK_SLOTS", 44, options.descriptors ?? []),
      new InventedFlushCallTable("ZZ_POND_BLOBS", 1853),
      new InventedFlushCallTable("VARS", 337, options.values ?? []),
      new InventedFlushCallTable("VERBS", 53, options.verbs ?? []),
      new InventedFlushCallTable("XML_DATA_STREAM", 255)
    ]
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): InventedFlushCall {
    const copy = new InventedFlushCall({ form: this.form })
    copy.text = this.text
    copy.functionBytes = this.functionBytes?.slice()
    copy.function = this.function
    copy.head = this.head.map(entry => ({ id: entry.id, value: entry.value.slice() }))
    copy.parameterValue = this.parameterValue.slice()
    copy.parameters = this.parameters.slice()
    copy.tables = this.tables.map(table => table.clone())
    copy.afterEnd = this.afterEnd.slice()
    copy.endItem = this.endItem?.slice()
    return copy
  }

  /** The value of the first head item `id`, as written in `head`. */
  headValue(id: number): Uint8Array | undefined {
    return this.head.find(entry => entry.id === id)?.value
  }

  /** The value of the first head item `id` as the call sends it: a text in the call's text. */
  sentHeadValue(id: number): Uint8Array | undefined {
    const entry = this.head.find(item => item.id === id)
    if (entry === undefined) return undefined
    return InventedFlushCall.textHeadIDs.has(entry.id) ? this.encoded(entry.value) : entry.value
  }

  /** Bytes per character of the call's texts. */
  get bytesPerCharacter(): number {
    return this.text === "utf16LittleEndian" || this.text === "utf16BigEndian" ? 2 : 1
  }

  /** `ascii` in the call's text: each byte one character. */
  encoded(ascii: ArrayLike<number>): Uint8Array {
    const bytes = Array.from(ascii)
    switch (this.text) {
      case "utf16LittleEndian":
        return Uint8Array.from(bytes.flatMap(byte => [byte, 0]))
      case "utf16BigEndian":
        return Uint8Array.from(bytes.flatMap(byte => [0, byte]))
      default:
        return Uint8Array.from(bytes)
    }
  }

  /** The function name's value: the name in the call's text, zero-padded for `zeroPaddedName`. */
  get functionValue(): Uint8Array {
    if (this.functionBytes !== undefined) return this.functionBytes
    const name = this.encoded(utf8(this.function))
    if (this.text !== "zeroPaddedName") return name
    return concatBytes(name, new Uint8Array(Math.max(InventedFlushCall.paddedNameLength - name.length, 0)))
  }

  /** Changes the table named `name`. */
  table(name: string, change: (table: InventedFlushCallTable) => void): void {
    const bytes = utf8(name)
    const table = this.tables.find(candidate => candidate.name.length === bytes.length && candidate.name.every((byte, index) => byte === bytes[index]))
    if (table !== undefined) change(table)
  }

  /** The call's bytes. */
  get bytes(): Uint8Array {
    const Call = InventedFlushCall
    const parts: Uint8Array[] = []
    for (const { id, value } of this.head) parts.push(Call.item(id, Call.textHeadIDs.has(id) ? this.encoded(value) : value))
    parts.push(Call.item(0x000b, this.encoded(utf8("DCK"))))
    parts.push(Call.item(0x0102, this.functionValue))
    parts.push(Call.item(0x000b, this.encoded(utf8("DCK"))))
    parts.push(Call.item(0x0130, this.encoded(utf8("ZZ_POND_OLE"))))
    for (const [id, value] of [
      [0x0337, []],
      [0x0503, []],
      [0x0420, [0, 0, 0, 0]],
      [0x0512, []]
    ] as [number, number[]][])
      parts.push(Call.item(id, value))
    for (const parameter of this.parameters) parts.push(Call.item(0x0205, this.encoded(utf8(parameter))))
    parts.push(Call.item(0x0201, this.encoded(utf8("IMPORT_XML"))), Call.item(0x0203, this.parameterValue))
    // basXML stays single-byte in every form (rfc-tr.md Reading R-CT-37).
    parts.push(Call.item(0x3c02, []), Call.item(0x3c05, utf8("<SVARS>")), Call.item(0x3c05, utf8("</SVARS>")), Call.item(0x3c02, []))
    for (const table of this.tables) parts.push(Call.table(this.sent(table)))
    return concatBytes(...parts, this.endItem ?? [], this.afterEnd)
  }

  /** `table` as the call sends it: its name and rows in the call's text, its width in bytes. */
  sent(table: InventedFlushCallTable): InventedFlushCallTable {
    if (!(this.bytesPerCharacter > 1)) return table
    const wide = table.clone()
    wide.name = this.encoded(table.name)
    wide.width = table.width * this.bytesPerCharacter
    wide.rows = table.rows.map(row => this.encoded(row))
    return wide
  }

  // MARK: Framing

  /** An RFC item: id, u16 BE length, value, the id again (PV-0910, PV-0919). */
  static item(id: number, value: ArrayLike<number>): Uint8Array {
    return concatBytes([id >> 8, id & 0xff, (value.length >> 8) & 0xff, value.length & 0xff], value, [id >> 8, id & 0xff])
  }

  /** `value` as a u32 BE. */
  static u32(value: number): Uint8Array {
    return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
  }

  /** A table's items: `02 13`, `03 01`, `03 02` (width, rows as u32 BE, PV-0958) and its content. */
  static table(table: InventedFlushCallTable): Uint8Array {
    const Call = InventedFlushCall
    const parts = [
      Call.item(0x0213, [0x00, 0x2a]),
      Call.item(0x0301, table.name),
      Call.item(0x0302, concatBytes(Call.u32(table.width), Call.u32(table.declaredRows ?? table.rows.length)))
    ]
    if (table.content !== undefined) return concatBytes(...parts, table.content)
    if (table.rows.length === 0) return concatBytes(...parts)
    // Each row whole, at the row width, as SAP GUI's server sent its raw rows (PV-0934).
    if (table.raw) return concatBytes(...parts, ...table.rows.map(row => Call.item(0x0304, row)))
    return concatBytes(...parts, Call.contentItems(Call.compressed(concatBytes(...table.rows), table.tag)))
  }

  /** Compressed content: the tag, L from offset 0, the v1 LZH header and the data, unpadded. */
  static compressed(rows: Uint8Array, tag: number): Uint8Array {
    let data: Uint8Array = new Uint8Array(0)
    try {
      data = new LZHEncoder().encode(rows)
    } catch (error) {
      if (!(error instanceof LZHEncodingError)) throw error
    }
    let header: Uint8Array = new Uint8Array(0)
    try {
      header = CompressionHeader.lzh(rows.length).bytes
    } catch (error) {
      if (!(error instanceof CompressionHeaderEncodingError)) throw error
    }
    return concatBytes(InventedFlushCall.u32(tag), InventedFlushCall.u32(16 + data.length), header, data)
  }

  /** Content split into `03 05` items of 250 bytes, the last one short, and the `03 06` end. */
  static contentItems(content: Uint8Array): Uint8Array {
    const parts: Uint8Array[] = []
    for (let start = 0; start < content.length; start += 250) parts.push(InventedFlushCall.item(0x0305, content.subarray(start, Math.min(start + 250, content.length))))
    parts.push(InventedFlushCall.item(0x0306, []))
    return concatBytes(...parts)
  }

  // MARK: Records

  /** A descriptor row: `text` padded with spaces to 44 bytes (PV-0924). */
  static descriptor(text: string): Uint8Array {
    return InventedFlushCall.padded(utf8(text), 44)
  }

  /** A value record: `name` padded to 32 bytes, then `value` padded to 305 (PV-0926). */
  static value(name: string, value: string): Uint8Array {
    return concatBytes(InventedFlushCall.padded(utf8(name), 32), InventedFlushCall.padded(utf8(value), 305))
  }

  /**
   * A VERBS record: the object right-aligned in bytes 0–8, a space, the name in 10–51, the flag at
   * 52 (PV-0922).
   */
  static verb(object: number, name: string, flag: string): Uint8Array {
    const objectText = utf8(String(object))
    return concatBytes(
      new Uint8Array(9 - objectText.length).fill(0x20),
      objectText,
      [0x20],
      InventedFlushCall.padded(utf8(name), 42),
      [flag.length > 0 ? flag.charCodeAt(0) : 0x20]
    )
  }

  static padded(text: ArrayLike<number>, width: number): Uint8Array {
    return concatBytes(text, new Uint8Array(Math.max(width - text.length, 0)).fill(0x20))
  }

  // MARK: The pond call

  /**
   * The pond call's descriptor rows: inputs, result slots, a set-property row and a get-property row
   * outside the four-column layout, a shared slot, an input pointing at an output record, a blank
   * row, an S verb with a result slot, and a result slot on an input. (Fresh on every read.)
   */
  static get pondDescriptors(): Uint8Array[] {
    return [
      "1 12 #1 2",
      "1 12 _RESULT 3",
      "2 3 #1 4",
      "2 12 #2 5",
      "2 12 _RESULT 6",
      "3 12 ZZ_QUACK_VOLUME 0 7",
      "4 12 _RESULT 8",
      "5 12 ZZ_PUDDLE_DEPTH 0 9",
      "6 3 #1 10",
      "6 12 _RESULT 11",
      "7 12 #1 12",
      "7 12 _RESULT 11",
      "8 9 #1 13",
      "9 3 #1 14",
      "9 12 _RESULT 15",
      "10 12 #1 3",
      "",
      "11 12 _RESULT 16",
      "12 12 _RESULT 5"
    ].map(InventedFlushCall.descriptor)
  }

  /**
   * The pond call's value records: object references, inputs, `_RESULT` slots and a slot with a name
   * of its own, pre-filled with its object receiver's content (R-CT-34, issue #151). (Fresh on every
   * read.)
   */
  static get pondValues(): Uint8Array[] {
    return (
      [
        ["", "000000000DPC"],
        ["", "000000000 Pond grid for very important ducks"],
        ["_RESULT", "000000000"],
        ["", "000000000 7"],
        ["", "000000000 ZZ_POND_SHELL"],
        ["_RESULT", "000000000"],
        ["", "000000000 11"],
        ["_RESULT", "000000000"],
        ["ZZ_PUDDLE_DEPTHS1", "000000000OPuddle of the deep end"],
        ["", "000000000 3"],
        ["_RESULT", "000000000"],
        ["", "000000000 Pond/Depth/Of/The/Deep/End"],
        ["", "000000000QCK"],
        ["", "000000000 5"],
        ["_RESULT", "000000000"],
        ["_RESULT", "000000000Old news about the pond"],
        ["", "000000000O42"]
      ] as [string, string][]
    ).map(([name, value]) => InventedFlushCall.value(name, value))
  }

  /** The pond call's verbs, one of each kind of result (Reading R-CT-34). (Fresh on every read.) */
  static get pondVerbs(): Uint8Array[] {
    return (
      [
        [1, "CreateObject", "C"],
        [3, "CreateControl", "C"],
        [6, "SetPaddleSpeed", "S"],
        [6, "GetContainer", "C"],
        [6, "GetPuddleDepth", "G"],
        [6, "PaddleInCircles", "C"],
        [6, "GetRegValueEx", "C"],
        [13, "FreeObject", "C"],
        [6, "RegisterEvent", "C"],
        [17, "AddControl", "C"],
        [17, "SetPaddleSpeed", "S"],
        [1, "CreateObject", "C"]
      ] as [number, string, string][]
    ).map(([object, name, flag]) => InventedFlushCall.verb(object, name, flag))
  }

  /** The pond call: three handles (O1 to O3 on a fresh counter), 1, 0, an emptied shared slot. */
  static pond(form: InventedFlushCallForm = "short"): InventedFlushCall {
    return new InventedFlushCall({
      descriptors: InventedFlushCall.pondDescriptors,
      values: InventedFlushCall.pondValues,
      verbs: InventedFlushCall.pondVerbs,
      form
    })
  }
}
