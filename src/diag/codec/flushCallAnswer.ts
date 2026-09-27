// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/FlushCallAnswer.swift (MIT).

// Swooey's answer to a complete `OLE_FLUSH_CALL` (docs/protocol/controls/rfc-tr.md §7.8,
// IMPL-CT-14): a pure function from the call's bytes and the connection's handle counter to the
// answer's RFC_TR_RET value, the counter after it and a summary in structure, or the reason the
// call does not read (Reading R-CT-35).
//
// The call reads when Reading R-CT-28's requirements hold, its texts in the encoding its function
// name shows (Reading R-CT-37, issue #150); the answer is the head of R-CT-29 with the own values of
// R-CT-36, the parameter of R-CT-30, the tables of R-CT-31 with the descriptor rows of R-CT-32 and
// the value records of R-CT-33, whose results and handles are R-CT-34's, then the end item. Every
// text Swooey writes is in the call's encoding. Every byte is echoed from the server's call to this
// session, computed, or a constant with its PV row; no byte of a captured answer is used. Nothing
// here prints a value of the call or of the answer, except handles, which Swooey makes itself, and
// what RFCValueDescription allows of the answer's head.

import { CompressedDataError, LZHEncoder, type CompressedDataErrorInfo } from "../compression/index.js"
import { ascii, ByteWriter, WireBytes } from "../wire/index.js"
import {
  AutomationDescriptor,
  AutomationRecordLayout,
  AutomationResult,
  AutomationValueKind,
  AutomationVerb,
  type AutomationVerbFlag,
  type ControlHandleCounter
} from "./automationRecords.js"
import { TextEncoding } from "./codePageText.js"
import { CompressionHeaderDecodingError, Decompressor } from "./compressionHeader.js"
import { ByteRange, INT_MAX } from "./diagCodec.js"
import { RFCItemEncoder, RFCItemEncodingError, RFCTableContentEncoder, RFCTableEncodingError } from "./rfcEncoding.js"
import { RFCHead, type RFCHeadItem } from "./rfcHead.js"
import {
  RFCCompressedTable,
  RFCCompressedTableError,
  RFCTableContent,
  RFCTableError,
  type RFCCompressedTableErrorInfo,
  type RFCTableErrorInfo
} from "./rfcTables.js"
import { RFCCodePageDescriptor, RFCTextEncoding, RFCTextForm } from "./rfcText.js"
import { RFCItemWalkError, RFCItemWalker, RFCStreamSummary, type RFCItem, type RFCItemWalkErrorInfo } from "./rfcTransfer.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/**
 * The four tables Swooey's reader needs (Reading R-CT-28), and the queue `ControlCall` reads.
 * `FlushTable.rawValue` gives Swift's raw values, which the descriptions use.
 * - `descriptors`: the descriptor table, known by its row width 44 (PV-0932).
 * - `values`: `VARS`, the value records (PV-0932).
 * - `verbs`: `VERBS` (PV-0932).
 * - `xmlDataStream`: `XML_DATA_STREAM` (PV-0932).
 * - `dataObjects`: `RFC_QUEUE` and the tables of the data objects inside it (PV-1000, PV-1001),
 *   read by `ControlCall`, never answered.
 */
export type FlushTable = "descriptors" | "values" | "verbs" | "xmlDataStream" | "dataObjects"

export const FlushTable = {
  allCases: ["descriptors", "values", "verbs", "xmlDataStream", "dataObjects"] as readonly FlushTable[],

  rawValue(table: FlushTable): string {
    switch (table) {
      case "descriptors":
        return "the 44-wide descriptor table"
      case "values":
        return "VARS"
      case "verbs":
        return "VERBS"
      case "xmlDataStream":
        return "XML_DATA_STREAM"
      case "dataObjects":
        return "RFC_QUEUE"
    }
  }
} as const

/** Why a table's content does not decode to its rows (Reading R-CT-28). */
export type FlushTableContentProblem =
  /** Reassembly of the `03 05` items failed (IMPL-CT-3). */
  | { readonly kind: "reassembly"; readonly error: RFCTableErrorInfo }
  /** The compressed-table prefix does not read (IMPL-CT-4). */
  | { readonly kind: "prefix"; readonly error: RFCCompressedTableErrorInfo }
  /** The compression header declares another length than row width × row count. */
  | { readonly kind: "declaredLength"; readonly declared: number; readonly expected: number }
  /** The v1 decoder failed. */
  | { readonly kind: "decompression"; readonly error: CompressedDataErrorInfo }
  /** A raw row is longer than the row width; `row` counts from 1. */
  | { readonly kind: "rawRowTooLong"; readonly row: number }
  /**
   * The content holds another number of bytes than row width × row count, no content for a table
   * with rows included.
   */
  | { readonly kind: "length"; readonly found: number; readonly expected: number }
  /** Row width × row count is more than Swooey reads (`FlushCallAnswerBuilder.maxStreamBytes`). */
  | { readonly kind: "tooLarge"; readonly value: number }
  /** A raw row of a UTF-16 call ends inside a character; `row` counts from 1 (Reading R-CT-37). */
  | { readonly kind: "rawRowSplitsACharacter"; readonly row: number }

/**
 * Why Swooey does not build an answer to a call (Reading R-CT-35): each failed requirement of
 * R-CT-28, and an answer too long for one APPL item. Structure only: no value of the call.
 */
export type FlushCallReadErrorInfo =
  /** The call is longer than Swooey reads (`FlushCallAnswerBuilder.maxCallBytes`). */
  | { readonly kind: "callTooLong"; readonly bytes: number }
  /** The walk stopped (IMPL-CT-2). */
  | { readonly kind: "notAnItemStream"; readonly error: RFCItemWalkErrorInfo }
  /** The walk ended without the end item `FF FF` (PV-0911). */
  | { readonly kind: "noEndItem" }
  /** An item's trailing pair is not its id, or is missing; `item` counts from 1 (PV-0919). */
  | { readonly kind: "trailingPair"; readonly item: number }
  /**
   * There is no function name `01 02`, or it is not `OLE_FLUSH_CALL` in any text encoding Swooey
   * reads (single-byte, UTF-16LE, UTF-16BE; padding with spaces or zeros allowed).
   */
  | { readonly kind: "notAFlushCall" }
  /**
   * A name the reader compares (item `item`, id `id`, from 1) is text of another encoding than the
   * function name's (Reading R-CT-37).
   */
  | { readonly kind: "mixedEncoding"; readonly item: number; readonly id: number; readonly form: RFCTextForm; readonly expected: RFCTextEncoding }
  /** Before the function name, the head has `count` items of `id`, not exactly one. */
  | { readonly kind: "headItem"; readonly id: number; readonly count: number }
  /**
   * The call names `value` export parameters (`02 05`) other than `IMPORT_XML`, `EXPORT_XML` and
   * `SVARS`, not exactly one.
   */
  | { readonly kind: "parameterCount"; readonly value: number }
  /** A table name `03 01` is not followed by an 8-byte table info `03 02`; `item` counts from 1. */
  | { readonly kind: "tableInfo"; readonly item: number }
  /** The call has `count` of the table, not exactly one. */
  | { readonly kind: "tableCount"; readonly table: FlushTable; readonly count: number }
  /** The table has another row width than its records need in the call's text encoding. */
  | { readonly kind: "tableWidth"; readonly table: FlushTable; readonly width: number; readonly expected: number }
  /** The table's content does not decode to row width × row count bytes. */
  | { readonly kind: "tableContent"; readonly table: FlushTable; readonly problem: FlushTableContentProblem }
  /** `XML_DATA_STREAM` carries rows, which no call showed: what its answer rows hold is not known. */
  | { readonly kind: "xmlDataStreamRows"; readonly value: number }
  /** The answer would be longer than one APPL item carries. */
  | { readonly kind: "answerTooLong"; readonly bytes: number }
  /** Swooey's own encoder refused a part of the answer. */
  | { readonly kind: "encoding"; readonly value: string }

export class FlushCallReadError extends Error {
  constructor(readonly info: FlushCallReadErrorInfo) {
    super(FlushCallReadError.describe(info))
    this.name = "FlushCallReadError"
  }

  /** The reason in structure (Swift `description`). */
  get description(): string {
    return this.message
  }

  static describe(info: FlushCallReadErrorInfo): string {
    switch (info.kind) {
      case "callTooLong":
        return `the call is ${info.bytes} bytes, more than Swooey reads`
      case "notAnItemStream":
        return `the call is no RFC item stream: the walk stopped in item ${info.error.itemIndex}`
      case "noEndItem":
        return "the call has no end item FF FF"
      case "trailingPair":
        return `item ${info.item}'s trailing pair does not repeat its id`
      case "notAFlushCall":
        return "the call is not OLE_FLUSH_CALL"
      case "mixedEncoding":
        return (
          `the call mixes text encodings: item ${info.item} (${RFCStreamSummary.hex(info.id)}) is ${RFCTextForm.rawValue(info.form)} text, ` +
          `the function name ${RFCTextEncoding.rawValue(info.expected)}`
        )
      case "headItem":
        return `the head has ${info.count} item(s) ${RFCStreamSummary.hex(info.id)}, not one`
      case "parameterCount":
        return `the call names ${info.value} export parameter(s) besides IMPORT_XML, EXPORT_XML and SVARS, not one`
      case "tableInfo":
        return `table name item ${info.item} is not followed by an 8-byte table info`
      case "tableCount":
        return `the call has ${info.count} of ${FlushTable.rawValue(info.table)}, not one`
      case "tableWidth":
        return `${FlushTable.rawValue(info.table)} is ${info.width} bytes wide, not ${info.expected}`
      case "tableContent":
        return `${FlushTable.rawValue(info.table)} does not decode: ${FlushCallReadError.describeProblem(info.problem)}`
      case "xmlDataStreamRows":
        return `XML_DATA_STREAM carries ${info.value} row(s), whose answer is not known`
      case "answerTooLong":
        return `the answer would be ${info.bytes} bytes, more than one APPL item carries`
      case "encoding":
        return `the answer could not be encoded: ${info.value}`
    }
  }

  static describeProblem(problem: FlushTableContentProblem): string {
    switch (problem.kind) {
      case "reassembly":
        return problem.error.kind === "badTableItem" ? `an item ${RFCStreamSummary.hex(problem.error.id)} inside its content` : "its content is cut short"
      case "prefix":
        return problem.error.kind === "truncated"
          ? `its content is ${problem.error.available} bytes, shorter than the compressed-table prefix`
          : `its compression header does not read (${new CompressionHeaderDecodingError(problem.error.error).message})`
      case "declaredLength":
        return `its compression header declares ${problem.declared} bytes, not ${problem.expected}`
      case "decompression":
        return `its data does not decompress (${new CompressedDataError(problem.error).message})`
      case "rawRowTooLong":
        return `raw row ${problem.row} is longer than the row width`
      case "length":
        return `${problem.found} bytes of rows, not ${problem.expected}`
      case "tooLarge":
        return `${problem.value} bytes of rows, more than Swooey reads`
      case "rawRowSplitsACharacter":
        return `raw row ${problem.row} ends inside a character`
    }
  }
}

/**
 * What Swooey writes in the head items that SAP GUI fills with values of its own (Reading R-CT-36):
 * its own code-page descriptor in `01 06`, and its own address text in `00 07` and `00 18`, or the
 * call's values (R-CT-29's echo). `00 13` and `00 12` are always the call's.
 */
export class FlushAnswerHead {
  /**
   * The code page Swooey declares in `01 06`: the call's descriptor with this code page's digits and
   * its bytes per character; undefined echoes the call's value.
   */
  codePage: number | undefined
  /**
   * Whether `00 07` and `00 18` carry Swooey's own address text, the unspecified address
   * `unspecifiedAddress`, instead of the call's.
   */
  ownAddress: boolean

  constructor(options: { codePage?: number; ownAddress?: boolean } = {}) {
    this.codePage = options.codePage
    this.ownAddress = options.ownAddress ?? false
  }

  /** The call's values throughout (R-CT-29 as Swooey 0.0.82 sent it). */
  static readonly echo: FlushAnswerHead = Object.freeze(new FlushAnswerHead())

  /**
   * The unspecified IPv4 address in dotted form: Swooey does not tell the server its address, which
   * the server sees as the connection's peer anyway (Reading R-CT-36).
   */
  static readonly unspecifiedAddress = ascii("0.0.0.0") // not-protocol: Swooey's own address text
  /** `00 07`'s width in characters, padded with spaces (PV-0798, PV-0921). */
  static readonly addressWidth = 15 // provenance: PV-0798, PV-0921

  /** Bytes per character Swooey declares with `codePage`: two for UTF-16 (4102, 4103), else one. */
  static bytesPerCharacter(codePage: number): number {
    const encoding = TextEncoding.fromCodePage(codePage)
    return encoding === undefined || TextEncoding.isASCIICompatible(encoding) ? 1 : RFCTextEncoding.bytesPerCharacter("utf16LittleEndian")
  }
}

/** How an answer table's content went (Swift `FlushAnswerSummary.Table.Form`). */
export type FlushAnswerTableForm =
  /** 0 rows: no content item. */
  | { readonly kind: "none" }
  /** One `03 04` item per row. */
  | { readonly kind: "raw" }
  /** `items` `03 05` items of 250 bytes and the `03 06` end. */
  | { readonly kind: "compressed"; readonly items: number }

/** One table of the answer (Swift `FlushAnswerSummary.Table`). */
export interface FlushAnswerTable {
  readonly table: FlushTable
  readonly width: number
  readonly rows: number
  readonly form: FlushAnswerTableForm
}

/**
 * Swooey's answer in structure, for the session report (IMPL-CT-11, IMPL-CT-14): counts, widths and
 * handles, never a value of the call or of the answer.
 */
export class FlushAnswerSummary {
  /** Items of the call. */
  callItems = 0
  /** Verbs of the call's `VERBS`. */
  verbs = 0
  /** Bytes and RFC items of the answer's value. */
  answerBytes = 0
  answerItems = 0
  /** The answer's tables in order. */
  tables: FlushAnswerTable[] = []
  /** Descriptor rows returned unchanged, and rows returned blank (Reading R-CT-32). */
  descriptorRowsKept = 0
  descriptorRowsBlanked = 0
  /** Value records kept byte for byte, and blanked (Reading R-CT-33). */
  recordsKept = 0
  recordsBlanked = 0
  /**
   * Output records filled with a handle, an integer or the zeros alone, and output records no verb
   * wrote (the zeros alone too).
   */
  recordsWithHandle = 0
  recordsWithInteger = 0
  recordsEmpty = 0
  recordsNotWritten = 0
  /** Results whose slot is no output record of the call, and so have no place in the answer. */
  unplacedResults = 0
  /**
   * Results decided by the verb's name (R-CT-34's table) and by the call's result record (a verb the
   * table does not name: a handle when the record holds the receiver's content, else the integer 0;
   * issue #151).
   */
  resultsByName = 0
  resultsByRecord = 0
  /** The numbers of the first and the last handle this answer made, when it made one. */
  firstHandle: number | undefined = undefined
  lastHandle: number | undefined = undefined
  /**
   * The number of the handle each verb got, by the verb's number in the call (from 1), for the verbs
   * that got one: a later call may name the verb's object by it (controls/scene.md Reading R-SC-8,
   * issue #167).
   */
  handlesByVerb = new Map<number, number>()
  /** The call's text encoding, in which Swooey wrote its own texts (Reading R-CT-37). */
  textEncoding: RFCTextEncoding = "singleByte"
  /** The answer's head items in structure (`RFCHead`): what the report may say of each. */
  head: RFCHeadItem[] = []
  /** The head items Swooey wrote itself (`00 11`, and R-CT-36's own values), in order. */
  ownHeadIDs: number[] = []
  /** Why a head item R-CT-36 asked Swooey to write itself went out as the call's value. */
  headNotes: string[] = []

  /** The head in lines: each item, Swooey's own or the call's, and the notes (IMPL-CT-11). */
  headLines(indent: string): string[] {
    const lines = this.head.map(item => {
      const source = this.ownHeadIDs.includes(item.id) ? "Swooey's own" : item.length === 0 ? "empty" : "the call's"
      return indent + `item ${item.index}: ${RFCStreamSummary.hex(item.id)}, length ${item.length}, ${source}; ${item.description}`
    })
    return lines.concat(this.headNotes.map(note => indent + "note: " + note))
  }

  /** How many handles the answer made. */
  get handles(): number {
    if (this.firstHandle === undefined || this.lastHandle === undefined) return 0
    return this.lastHandle - this.firstHandle + 1
  }

  /** One line: sizes, tables, rows and records, and the handles. */
  get description(): string {
    const parts = [`${this.answerBytes} bytes, ${this.answerItems} RFC item(s), to a call of ${this.callItems} item(s) and ${this.verbs} verb(s)`]
    parts.push(
      "tables " +
        this.tables
          .map(table => {
            const form =
              table.form.kind === "none" ? "no content" : table.form.kind === "raw" ? "raw rows" : `compressed in ${table.form.items} item(s)`
            return `${FlushTable.rawValue(table.table)} ${table.rows} × ${table.width}, ${form}`
          })
          .join("; ")
    )
    parts.push(`descriptor rows: ${this.descriptorRowsKept} kept, ${this.descriptorRowsBlanked} blank`)
    let records =
      `value records: ${this.recordsKept} kept, ${this.recordsBlanked} blank, ${this.recordsWithHandle} with a handle, ` +
      `${this.recordsWithInteger} with an integer, ${this.recordsEmpty} empty, ${this.recordsNotWritten} not written`
    if (this.unplacedResults > 0) records += `, ${this.unplacedResults} result(s) without an output record`
    parts.push(records)
    parts.push(`results: ${this.resultsByName} by the verb's name, ${this.resultsByRecord} by the call's record`)
    if (this.firstHandle !== undefined && this.lastHandle !== undefined) {
      parts.push(this.firstHandle === this.lastHandle ? `handle O${this.firstHandle}` : `handles O${this.firstHandle} to O${this.lastHandle}`)
    } else {
      parts.push("no handle")
    }
    parts.push(`texts ${RFCTextEncoding.rawValue(this.textEncoding)}`)
    if (this.ownHeadIDs.length > 0) parts.push("own head items " + this.ownHeadIDs.map(id => RFCStreamSummary.hex(id)).join(", ") + " (R-CT-36)")
    return parts.join("; ")
  }

  toString(): string {
    return this.description
  }
}

/** An answer Swooey built (IMPL-CT-14). */
export class FlushCallAnswer {
  constructor(
    /** The RFC_TR_RET value: an RFC item stream ending in `FF FF 00 00 FF FF`. */
    readonly value: Uint8Array,
    /** The connection's handle counter after the answer. */
    readonly handles: ControlHandleCounter,
    /** The answer in structure. */
    readonly summary: FlushAnswerSummary
  ) {}

  /** The summary only: the value echoes the server's data. */
  get description(): string {
    return `FlushCallAnswer(${this.summary.description})`
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

/** A table's content in the call (Swift `FlushCallAnswerBuilder.CallTable.Content`). */
export type FlushCallTableContent =
  | { readonly kind: "none" }
  /** The `03 04` items' value ranges. */
  | { readonly kind: "raw"; readonly value: readonly ByteRange[] }
  /** Where the first `03 05` item starts. */
  | { readonly kind: "compressed"; readonly start: number }

/**
 * A table of the call (Swift `FlushCallAnswerBuilder.CallTable`): its place among the call's tables,
 * its name and info items, its row width and count, and its content.
 */
export interface FlushCallTable {
  readonly index: number
  readonly name: ByteRange
  readonly info: ByteRange
  readonly width: number
  readonly rows: number
  readonly content: FlushCallTableContent
}

/**
 * A table's rows as the call sent them, and their characters one byte each (Reading R-CT-37): the
 * records are read from the characters, and what the answer keeps is copied from the rows (Swift
 * `FlushCallAnswerBuilder.TextRows`).
 */
export class FlushTextRows {
  readonly characters: Uint8Array

  constructor(
    readonly bytes: Uint8Array,
    readonly encoding: RFCTextEncoding
  ) {
    this.characters = encoding === "singleByte" ? bytes : RFCTextEncoding.narrow(encoding, bytes)
  }
}

/** Writes an answer table's rows in the call's text encoding, counting characters (Swift `TextWriter`). */
class TextWriter {
  readonly output: ByteWriter
  characters = 0

  constructor(
    readonly encoding: RFCTextEncoding,
    capacity: number
  ) {
    this.output = new ByteWriter(capacity)
  }

  /** The characters `start ..< end` of `rows`, as the call sent them. */
  copy(rows: FlushTextRows, start: number, end: number): void {
    const width = RFCTextEncoding.bytesPerCharacter(this.encoding)
    this.output.bytes(rows.bytes.subarray(start * width, end * width))
    this.characters += end - start
  }

  /** ASCII characters Swooey writes. */
  text(ascii: ArrayLike<number>): void {
    RFCTextEncoding.append(this.encoding, ascii, this.output)
    this.characters += ascii.length
  }

  spaces(count: number): void {
    RFCTextEncoding.appendSpaces(this.encoding, count, this.output)
    this.characters += Math.max(count, 0)
  }

  /** Spaces up to `count` characters. */
  pad(count: number): void {
    this.spaces(count - this.characters)
  }

  get bytes(): Uint8Array {
    return this.output.toBytes()
  }
}

/** What a verb wrote to an output record (Swift's local `enum Written`). */
type Written = { readonly kind: "handle"; readonly text: Uint8Array } | { readonly kind: "integer"; readonly value: number } | { readonly kind: "empty" }

/** Throws `FlushCallReadError` with `info`. */
function fail(info: FlushCallReadErrorInfo): never {
  throw new FlushCallReadError(info)
}

/** Runs `body`; an error of Swooey's own encoders becomes `FlushCallReadError.encoding`. */
function encoding<T>(body: () => T): T {
  try {
    return body()
  } catch (error) {
    if (error instanceof RFCItemEncodingError || error instanceof RFCTableEncodingError) fail({ kind: "encoding", value: error.message })
    throw error
  }
}

/** The call reader and answer builder of rfc-tr.md §7.8 (IMPL-CT-14). */
export const FlushCallAnswerBuilder = {
  // MARK: Constants

  /** The function Swooey answers (rfc-tr.md §7.1; PV-0946, PV-0929). */
  functionName: ascii("OLE_FLUSH_CALL"),
  /**
   * The head items the call must have exactly once before its function name, and the answer echoes
   * or, for R-CT-36's own values, writes in their place (R-CT-28, R-CT-29; PV-0921, PV-0929).
   */
  echoedHeadIDs: [0x0101, 0x0103, 0x0106, 0x0007, 0x0018, 0x0013, 0x0012, 0x0006] as readonly number[], // provenance: PV-0921, PV-0929
  /** The answer's head, eleven ids in order (PV-0921). */
  answerHeadIDs: [0x0101, 0x0103, 0x0106, 0x0007, 0x0018, 0x0011, 0x0013, 0x0012, 0x0006, 0x0017, 0x0500] as readonly number[], // provenance: PV-0921
  /**
   * The head item the answer always writes itself: `00 11`, the partner type, holding `E`, an
   * external program (PV-0921, PV-0798).
   */
  partnerTypeID: 0x0011, // provenance: PV-0921, PV-0798
  partnerType: ascii("E"), // provenance: PV-0921, PV-0798
  /** The code-page descriptor, and the two address texts (Reading R-CT-36; PV-0797, PV-0798). */
  codePageID: 0x0106, // provenance: PV-0797
  addressID: 0x0007, // provenance: PV-0798
  secondAddressID: 0x0018, // provenance: PV-0798
  /** The function-name, export-parameter, import-parameter and table ids (PV-0912). */
  functionNameID: 0x0102, // provenance: PV-0912
  exportParameterID: 0x0205, // provenance: PV-0912
  importParameterID: 0x0201, // provenance: PV-0912
  tableNameID: 0x0301, // provenance: PV-0912
  tableInfoID: 0x0302, // provenance: PV-0912
  /**
   * A parameter's value item, and the answer's value of the parameter: 256 space characters
   * (PV-0927), in the call's text encoding (Reading R-CT-37).
   */
  parameterValueID: 0x0203, // provenance: PV-0927, PV-0932
  parameterValue: new Uint8Array(256).fill(0x20), // provenance: PV-0927
  /** A table info's value: the row width and the row count, each a u32 BE (PV-0958). */
  tableInfoSize: 8, // provenance: PV-0958
  rowCountOffset: 4, // provenance: PV-0958
  /** The export parameters the answer never returns (R-CT-30, PV-0927, PV-0932). */
  knownParameters: [ascii("IMPORT_XML"), ascii("EXPORT_XML"), ascii("SVARS")] as readonly Uint8Array[], // provenance: PV-0927, PV-0932
  /** The table names Swooey reads (PV-0932). */
  valuesName: ascii("VARS"), // provenance: PV-0932
  verbsName: ascii("VERBS"), // provenance: PV-0932
  xmlDataStreamName: ascii("XML_DATA_STREAM"), // provenance: PV-0932
  /**
   * The names whose text encoding must be the function name's (Reading R-CT-37): parameter and
   * table names (PV-0912).
   */
  nameIDs: new Set([0x0205, 0x0201, 0x0301]) as ReadonlySet<number>, // provenance: PV-0912
  /** The largest APPL value: the answer must fit one RFC_TR item (PV-0900). */
  maxAnswerBytes: 0xffff, // provenance: PV-0900
  /** The most bytes of rows Swooey decodes from one table. */
  maxStreamBytes: 16 * 1024 * 1024, // not-protocol: memory cap, 16 MiB
  /**
   * The longest call Swooey reads: the walk keeps every item of the call, so the call's length
   * bounds that memory as `maxStreamBytes` bounds the rows'. SAP GUI's longest call was 152 105
   * bytes (rfc-tr.md §7.7.1).
   */
  maxCallBytes: 4 * 1024 * 1024, // not-protocol: memory cap, 4 MiB

  // MARK: The answer

  /**
   * Reads a complete call (Readings R-CT-28, R-CT-37) and builds Swooey's answer (R-CT-29 to
   * R-CT-34, with `own`'s own values of R-CT-36) with `handles` as the connection's counter; throws
   * the first requirement that fails (R-CT-35) as `FlushCallReadError`. A pure function: the same
   * call, counter and head always give the same answer, and `handles` is not changed.
   */
  answer(call: Uint8Array, handles: ControlHandleCounter, own: FlushAnswerHead = FlushAnswerHead.echo): FlushCallAnswer {
    const B = FlushCallAnswerBuilder
    if (!(call.length <= B.maxCallBytes)) fail({ kind: "callTooLong", bytes: call.length })
    const items = B.walk(call)
    const { index: functionIndex, encoding: textEncoding } = B.function(items, call)
    const head = new Map<number, RFCItem>()
    for (const id of B.echoedHeadIDs) {
      const found = items.slice(0, functionIndex).filter(item => item.id === id)
      if (found.length !== 1) fail({ kind: "headItem", id, count: found.length })
      head.set(id, found[0])
    }
    B.checkNames(items, call, textEncoding)
    const parameter = B.parameterName(items, call, textEncoding)
    const tables = B.readTables(items, call)
    const width = RFCTextEncoding.bytesPerCharacter(textEncoding)
    const descriptors = B.table("descriptors", tables, table => table.width === AutomationRecordLayout.descriptorWidth * width)
    const values = B.table("values", tables, table => RFCTextEncoding.matches(textEncoding, call, table.name, B.valuesName))
    const verbs = B.table("verbs", tables, table => RFCTextEncoding.matches(textEncoding, call, table.name, B.verbsName))
    const xmlDataStream = B.table("xmlDataStream", tables, table => RFCTextEncoding.matches(textEncoding, call, table.name, B.xmlDataStreamName))
    if (values.width !== AutomationRecordLayout.valueWidth * width)
      fail({ kind: "tableWidth", table: "values", width: values.width, expected: AutomationRecordLayout.valueWidth * width })
    if (verbs.width !== AutomationRecordLayout.verbWidth * width)
      fail({ kind: "tableWidth", table: "verbs", width: verbs.width, expected: AutomationRecordLayout.verbWidth * width })
    if (xmlDataStream.rows !== 0) fail({ kind: "xmlDataStreamRows", value: xmlDataStream.rows })
    const descriptorRows = new FlushTextRows(B.rows(descriptors, "descriptors", call, textEncoding), textEncoding)
    const valueRows = new FlushTextRows(B.rows(values, "values", call, textEncoding), textEncoding)
    const verbRows = new FlushTextRows(B.rows(verbs, "verbs", call, textEncoding), textEncoding)

    const summary = new FlushAnswerSummary()
    summary.callItems = items.length
    summary.textEncoding = textEncoding
    // Swift copies the counter: the caller's counter stays as it was.
    const counter = handles.clone()
    const answerDescriptors = B.rewriteDescriptors(descriptorRows, verbRows.characters, summary)
    const answerValues = B.fillValues(valueRows, descriptorRows.characters, verbRows.characters, counter, summary)

    const value = new ByteWriter(1024)
    encoding(() => {
      for (const id of B.answerHeadIDs) {
        const bytes = B.ownValue(id, head, call, textEncoding, own, summary)
        const item = head.get(id)
        if (bytes !== undefined) {
          RFCItemEncoder.append(id, bytes, value)
          summary.ownHeadIDs.push(id)
        } else if (item !== undefined) {
          RFCItemEncoder.append(id, item.valueRange.of(call), value)
        } else {
          RFCItemEncoder.append(id, new Uint8Array(0), value)
        }
      }
      RFCItemEncoder.append(B.importParameterID, parameter.valueRange.of(call), value)
      RFCItemEncoder.append(B.parameterValueID, RFCTextEncoding.encode(textEncoding, B.parameterValue), value)
    })
    const encoder = new LZHEncoder()
    const answered: { table: FlushCallTable; which: FlushTable; rows: Uint8Array }[] = [
      { table: descriptors, which: "descriptors", rows: answerDescriptors },
      { table: values, which: "values", rows: answerValues },
      { table: xmlDataStream, which: "xmlDataStream", rows: new Uint8Array(0) }
    ]
    answered.sort((a, b) => a.table.index - b.table.index)
    for (const { table, which, rows } of answered) B.appendTable(table, which, rows, call, textEncoding, encoder, value, summary)
    RFCItemEncoder.appendEnd(value)
    if (!(value.length <= B.maxAnswerBytes)) fail({ kind: "answerTooLong", bytes: value.length })
    const bytes = value.toBytes()
    summary.answerBytes = bytes.length
    summary.answerItems = new RFCStreamSummary(bytes).itemCount
    summary.head = new RFCHead(bytes, "report").items
    return new FlushCallAnswer(bytes, counter, summary)
  },

  /**
   * The value Swooey writes itself for head item `id`, or undefined for the call's value or an empty
   * item: `00 11` always (`E`, R-CT-29), and R-CT-36's own values as `own` asks for them, each text
   * in the call's encoding.
   */
  ownValue(
    id: number,
    head: ReadonlyMap<number, RFCItem>,
    call: Uint8Array,
    textEncoding: RFCTextEncoding,
    own: FlushAnswerHead,
    summary: FlushAnswerSummary
  ): Uint8Array | undefined {
    const B = FlushCallAnswerBuilder
    switch (id) {
      case B.partnerTypeID:
        return RFCTextEncoding.encode(textEncoding, B.partnerType)
      case B.codePageID: {
        const codePage = own.codePage
        const item = head.get(id)
        if (codePage === undefined || item === undefined) return undefined
        const descriptor = RFCCodePageDescriptor.replacing(item.valueRange.of(call), codePage, FlushAnswerHead.bytesPerCharacter(codePage))
        if (descriptor === undefined) {
          summary.headNotes.push(
            "01 06: the call's value is no code-page descriptor as R-CT-36 reads one, or code page " +
              `${codePage} has more than four digits; the call's value went out`
          )
          return undefined
        }
        return descriptor
      }
      case B.addressID: {
        if (!own.ownAddress) return undefined
        const text = new ByteWriter(FlushAnswerHead.addressWidth)
        text.bytes(FlushAnswerHead.unspecifiedAddress)
        text.repeat(RFCTableContentEncoder.space, Math.max(FlushAnswerHead.addressWidth - FlushAnswerHead.unspecifiedAddress.length, 0))
        return RFCTextEncoding.encode(textEncoding, text.toBytes())
      }
      case B.secondAddressID:
        if (!own.ownAddress) return undefined
        return RFCTextEncoding.encode(textEncoding, FlushAnswerHead.unspecifiedAddress)
      default:
        return undefined
    }
  },

  // MARK: Reading the call

  /** The call's items, walked to the end item with every trailing pair repeating its id. */
  walk(call: Uint8Array): RFCItem[] {
    const walker = new RFCItemWalker()
    const items: RFCItem[] = []
    for (;;) {
      let next: RFCItem | undefined
      try {
        next = walker.next(call)
      } catch (error) {
        if (error instanceof RFCItemWalkError) fail({ kind: "notAnItemStream", error: error.info })
        throw error
      }
      if (next === undefined) break
      items.push(next)
      if (next.trailerMatches !== true) fail({ kind: "trailingPair", item: items.length })
    }
    if (items.length === 0 || items[items.length - 1].id !== RFCItemWalker.endID) fail({ kind: "noEndItem" })
    return items
  },

  /**
   * The index of the function-name item, which names `OLE_FLUSH_CALL`, and the text encoding it is in
   * (Reading R-CT-37): single-byte, UTF-16LE or UTF-16BE, padded with space or zero characters or
   * not.
   */
  function(items: readonly RFCItem[], call: Uint8Array): { index: number; encoding: RFCTextEncoding } {
    const index = items.findIndex(item => item.id === FlushCallAnswerBuilder.functionNameID)
    const found = index < 0 ? undefined : RFCTextEncoding.reading(call, items[index].valueRange, FlushCallAnswerBuilder.functionName)
    if (found === undefined) fail({ kind: "notAFlushCall" })
    return { index, encoding: found }
  },

  /**
   * Every parameter and table name that is text of two characters or more is in the function name's
   * encoding (Reading R-CT-37): a call that mixes encodings is not read.
   */
  checkNames(items: readonly RFCItem[], call: Uint8Array, textEncoding: RFCTextEncoding): void {
    items.forEach((item, index) => {
      if (!FlushCallAnswerBuilder.nameIDs.has(item.id)) return
      const value = item.valueRange.of(call)
      const form = RFCTextForm.of(value)
      if (form === undefined || !(RFCTextForm.characters(value).length >= 2)) return // not-protocol: a name, not a flag
      if (RFCTextForm.encoding(form) !== textEncoding) fail({ kind: "mixedEncoding", item: index + 1, id: item.id, form, expected: textEncoding })
    })
  },

  /**
   * The one export parameter that is none of `IMPORT_XML`, `EXPORT_XML` and `SVARS` (R-CT-30), the
   * names compared in the call's text encoding.
   */
  parameterName(items: readonly RFCItem[], call: Uint8Array, textEncoding: RFCTextEncoding): RFCItem {
    const B = FlushCallAnswerBuilder
    const others = items.filter(
      item => item.id === B.exportParameterID && !B.knownParameters.some(name => RFCTextEncoding.matches(textEncoding, call, item.valueRange, name))
    )
    if (others.length !== 1) fail({ kind: "parameterCount", value: others.length })
    return others[0]
  },

  /**
   * Every table of the call, in order: each `03 01` item with the `03 02` item after it, and the
   * content items that follow them.
   */
  readTables(items: readonly RFCItem[], call: Uint8Array): FlushCallTable[] {
    const B = FlushCallAnswerBuilder
    const tables: FlushCallTable[] = []
    for (let index = 0; index < items.length; index++) {
      if (items[index].id !== B.tableNameID) continue
      const infoIndex = index + 1
      if (!(infoIndex < items.length && items[infoIndex].id === B.tableInfoID && items[infoIndex].valueRange.count === B.tableInfoSize))
        fail({ kind: "tableInfo", item: index + 1 })
      const info = items[infoIndex].valueRange
      const width = WireBytes.u32BigEndian(call, info.lowerBound) // provenance: PV-0958
      const rows = WireBytes.u32BigEndian(call, info.lowerBound + B.rowCountOffset) // provenance: PV-0958
      let content: FlushCallTableContent = { kind: "none" }
      let next = infoIndex + 1
      if (next < items.length && items[next].id === RFCTableContent.contentID) {
        // The item's id starts four bytes before its value (PV-0910).
        content = { kind: "compressed", start: items[next].valueRange.lowerBound - 2 * RFCItemWalker.fieldSize } // provenance: PV-0910
        while (next < items.length && items[next].id === RFCTableContent.contentID) next += 1
        if (next < items.length && items[next].id === RFCTableContent.endID) next += 1
      } else if (next < items.length && items[next].id === RFCTableContentEncoder.rawRowID) {
        const ranges: ByteRange[] = []
        while (next < items.length && items[next].id === RFCTableContentEncoder.rawRowID) {
          ranges.push(items[next].valueRange)
          next += 1
        }
        content = { kind: "raw", value: ranges }
      }
      tables.push({ index: tables.length, name: items[index].valueRange, info, width, rows, content })
      index = next - 1
    }
    return tables
  },

  /** The one table that `matches`. */
  table(which: FlushTable, tables: readonly FlushCallTable[], matches: (table: FlushCallTable) => boolean): FlushCallTable {
    const found = tables.filter(matches)
    if (found.length !== 1) fail({ kind: "tableCount", table: which, count: found.length })
    return found[0]
  },

  /**
   * A table's rows, row width × row count bytes as the call sent them: its compressed content
   * decompressed, or its raw rows each padded with space characters of the call's encoding to the
   * row width (R-CT-28, R-CT-37).
   */
  rows(table: FlushCallTable, which: FlushTable, call: Uint8Array, textEncoding: RFCTextEncoding): Uint8Array {
    const B = FlushCallAnswerBuilder
    // Swift multiplies with overflow reporting; a product past the port's exact integers counts as
    // Int.max (INT_MAX, diagCodec.ts).
    const product = BigInt(table.width) * BigInt(table.rows)
    const overflow = product > BigInt(INT_MAX)
    const expected = overflow ? INT_MAX : Number(product)
    if (overflow || !(expected <= B.maxStreamBytes)) fail({ kind: "tableContent", table: which, problem: { kind: "tooLarge", value: expected } })
    switch (table.content.kind) {
      case "none":
        if (expected !== 0) fail({ kind: "tableContent", table: which, problem: { kind: "length", found: 0, expected } })
        return new Uint8Array(0)
      case "raw": {
        const ranges = table.content.value
        // One item per row: another count is refused before a byte is kept, so that the rows never
        // grow past row width × row count (`maxStreamBytes`).
        if (ranges.length !== table.rows)
          fail({ kind: "tableContent", table: which, problem: { kind: "length", found: ranges.length * table.width, expected } })
        const bytesPerCharacter = RFCTextEncoding.bytesPerCharacter(textEncoding)
        const rows = new ByteWriter(Math.max(expected, 16))
        ranges.forEach((range, index) => {
          if (!(range.count <= table.width)) fail({ kind: "tableContent", table: which, problem: { kind: "rawRowTooLong", row: index + 1 } })
          const missing = table.width - range.count
          if (missing % bytesPerCharacter !== 0)
            fail({ kind: "tableContent", table: which, problem: { kind: "rawRowSplitsACharacter", row: index + 1 } })
          rows.bytes(range.of(call))
          RFCTextEncoding.appendSpaces(textEncoding, missing / bytesPerCharacter, rows)
        })
        return rows.toBytes()
      }
      case "compressed": {
        let content: RFCTableContent
        try {
          content = RFCTableContent.reassemble(call.subarray(table.content.start))
        } catch (error) {
          if (error instanceof RFCTableError) fail({ kind: "tableContent", table: which, problem: { kind: "reassembly", error: error.info } })
          throw error
        }
        let prefix: RFCCompressedTable
        try {
          prefix = RFCCompressedTable.parse(content.bytes)
        } catch (error) {
          if (error instanceof RFCCompressedTableError) fail({ kind: "tableContent", table: which, problem: { kind: "prefix", error: error.info } })
          throw error
        }
        if (prefix.header.uncompressedLength !== expected)
          fail({ kind: "tableContent", table: which, problem: { kind: "declaredLength", declared: prefix.header.uncompressedLength, expected } })
        const decompressor = new Decompressor(expected)
        let rows: Uint8Array
        try {
          rows = prefix.decompress(content.bytes, decompressor)
        } catch (error) {
          if (error instanceof CompressedDataError) fail({ kind: "tableContent", table: which, problem: { kind: "decompression", error: error.info } })
          throw error
        }
        if (rows.length !== expected) fail({ kind: "tableContent", table: which, problem: { kind: "length", found: rows.length, expected } })
        return rows
      }
    }
  },

  // MARK: Building the answer

  /**
   * The answer's descriptor rows (Reading R-CT-32): an input row (`#N`) and every row of a group
   * whose verb has the flag `S` become spaces; every other row is the call's row.
   */
  rewriteDescriptors(rows: FlushTextRows, verbs: Uint8Array, summary: FlushAnswerSummary): Uint8Array {
    const width = AutomationRecordLayout.descriptorWidth
    const flags: AutomationVerbFlag[] = FlushCallAnswerBuilder.verbRecords(verbs).map(verb => verb.flag)
    const writer = new TextWriter(rows.encoding, rows.bytes.length)
    let start = 0
    while (start < rows.characters.length) {
      const descriptor = AutomationDescriptor.decode(rows.characters.subarray(start, start + width))
      const group = descriptor.group
      const setVerb = group !== undefined && group >= 1 && group <= flags.length && flags[group - 1].kind === "set"
      if (descriptor.role === "input" || setVerb) {
        writer.spaces(width)
        summary.descriptorRowsBlanked += 1
      } else {
        writer.copy(rows, start, start + width)
        summary.descriptorRowsKept += 1
      }
      start += width
    }
    return writer.bytes
  },

  verbRecords(rows: Uint8Array): AutomationVerb[] {
    const width = AutomationRecordLayout.verbWidth
    const verbs: AutomationVerb[] = []
    for (let start = 0; start < rows.length; start += width) verbs.push(AutomationVerb.decode(rows.subarray(start, start + width)))
    return verbs
  },

  /**
   * The answer's value records (Readings R-CT-33 and R-CT-34): the verbs run in order, each writing
   * its result to its group's `_RESULT` records and to the output records its other rows point at;
   * then every record is written as the table of R-CT-33 says, in the call's text encoding.
   * `handles` moves on by the handles the answer makes.
   */
  fillValues(
    rows: FlushTextRows,
    descriptors: Uint8Array,
    verbs: Uint8Array,
    handles: ControlHandleCounter,
    summary: FlushAnswerSummary
  ): Uint8Array {
    const width = AutomationRecordLayout.valueWidth
    const nameWidth = AutomationRecordLayout.valueNameWidth
    const records = rows.characters
    const kinds: AutomationValueKind[] = []
    const holdsValue: boolean[] = []
    for (let start = 0; start < records.length; start += width) {
      const record = records.subarray(start, start + width)
      kinds.push(AutomationValueKind.of(record))
      holdsValue.push(AutomationValueKind.holdsValue(record))
    }
    const verbList = FlushCallAnswerBuilder.verbRecords(verbs)
    summary.verbs = verbList.length
    // The descriptors by group.
    const groups = new Map<number, AutomationDescriptor[]>()
    const descriptorWidth = AutomationRecordLayout.descriptorWidth
    for (let start = 0; start < descriptors.length; start += descriptorWidth) {
      const descriptor = AutomationDescriptor.decode(descriptors.subarray(start, start + descriptorWidth))
      if (descriptor.group === undefined) continue
      const group = groups.get(descriptor.group)
      if (group === undefined) groups.set(descriptor.group, [descriptor])
      else group.push(descriptor)
    }
    const written = new Map<number, Written>()
    verbList.forEach((verb, index) => {
      const targets: number[] = []
      for (const descriptor of groups.get(index + 1) ?? []) {
        const pointer = descriptor.pointer
        if (pointer === undefined) {
          if (descriptor.role === "result") summary.unplacedResults += 1
          continue
        }
        const record = pointer - 1
        const isOutput = record >= 0 && record < kinds.length && kinds[record] === "output"
        switch (descriptor.role) {
          case "result":
            if (isOutput) targets.push(record)
            else summary.unplacedResults += 1
            break
          case "other":
            if (isOutput) targets.push(record)
            break
          case "input":
            break
        }
      }
      if (targets.length === 0) return
      const decided = AutomationResult.decide(
        verb,
        targets.some(record => holdsValue[record])
      )
      if (decided === undefined) return
      if (decided.basis === "name") summary.resultsByName += 1
      else summary.resultsByRecord += 1
      let value: Written
      switch (decided.result.kind) {
        case "newHandle": {
          const handle = handles.mint()
          summary.firstHandle = summary.firstHandle ?? handle.number
          summary.lastHandle = handle.number
          summary.handlesByVerb.set(index + 1, handle.number)
          value = { kind: "handle", text: handle.text }
          break
        }
        case "integer":
          value = { kind: "integer", value: decided.result.value }
          break
        case "empty":
          value = { kind: "empty" }
          break
      }
      for (const record of targets) written.set(record, value)
    })
    const writer = new TextWriter(rows.encoding, rows.bytes.length)
    kinds.forEach((kind, index) => {
      const start = index * width
      switch (kind) {
        case "reference":
          writer.copy(rows, start, start + width)
          summary.recordsKept += 1
          break
        case "input":
          writer.spaces(width)
          summary.recordsBlanked += 1
          break
        case "output": {
          writer.copy(rows, start, start + nameWidth)
          writer.text(AutomationRecordLayout.zeros)
          const value = written.get(index)
          if (value === undefined) {
            summary.recordsNotWritten += 1
          } else if (value.kind === "handle") {
            writer.text(value.text)
            summary.recordsWithHandle += 1
          } else if (value.kind === "integer") {
            writer.text(ascii(" " + String(value.value)))
            summary.recordsWithInteger += 1
          } else {
            summary.recordsEmpty += 1
          }
          writer.pad(start + width)
          break
        }
      }
    })
    return writer.bytes
  },

  /**
   * Appends one answer table (R-CT-31): the call's `03 01` and `03 02` items, then `rows` as the
   * call sent that table: nothing for 0 rows, raw rows (a blank row as one space character of the
   * call's encoding), or compressed with the call's tag.
   */
  appendTable(
    table: FlushCallTable,
    which: FlushTable,
    rows: Uint8Array,
    call: Uint8Array,
    textEncoding: RFCTextEncoding,
    encoder: LZHEncoder,
    value: ByteWriter,
    summary: FlushAnswerSummary
  ): void {
    const B = FlushCallAnswerBuilder
    let form: FlushAnswerTableForm
    encoding(() => {
      RFCItemEncoder.append(B.tableNameID, table.name.of(call), value)
      RFCItemEncoder.append(B.tableInfoID, table.info.of(call), value)
    })
    if (rows.length === 0) {
      form = { kind: "none" }
    } else if (table.content.kind === "raw") {
      encoding(() =>
        RFCTableContentEncoder.appendRaw(rows, table.width, value, RFCTextEncoding.encode(textEncoding, [RFCTableContentEncoder.space]))
      )
      form = { kind: "raw" }
    } else {
      const tag = B.compressedTag(table, call)
      form = { kind: "compressed", items: encoding(() => RFCTableContentEncoder.appendCompressed(rows, tag, encoder, value)) }
    }
    summary.tables.push({ table: which, width: table.width, rows: table.rows, form })
  },

  /**
   * The four tag bytes of the call's own compressed content of `table` (R-CT-31). The table has rows,
   * so its content decoded as compressed content in `rows`.
   */
  compressedTag(table: FlushCallTable, call: Uint8Array): number {
    if (table.content.kind === "compressed") {
      try {
        const content = RFCTableContent.reassemble(call.subarray(table.content.start))
        return RFCCompressedTable.parse(content.bytes).tag
      } catch (error) {
        if (!(error instanceof RFCTableError || error instanceof RFCCompressedTableError)) throw error
      }
    }
    return fail({ kind: "encoding", value: "no compressed content to take the tag from" })
  }
} as const
