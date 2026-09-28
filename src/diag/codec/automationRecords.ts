// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/AutomationRecords.swift (MIT).

// The records of the three automation streams of an `OLE_FLUSH_CALL` (docs/protocol/controls/
// rfc-tr.md §7.2–§7.4) as far as Swooey's answer reads and writes them (§7.8, Readings R-CT-32 to
// R-CT-34): a verb's name and flag, a descriptor's role, group and pointer, a value record's kind,
// and the result each verb returns. The streams are the server's data: nothing here keeps or prints
// a value, and the answer's summary counts records only.

import { ascii } from "../wire/index.js"
import { ByteRange } from "./diagCodec.js"

/**
 * The record layouts of the automation streams (PV-0922, PV-0924, PV-0926) and the fixed texts of
 * the answer's value records (PV-0938, PV-0939, PV-0957).
 */
export const AutomationRecordLayout = {
  /** A VERBS record (PV-0922). */
  verbWidth: 53, // provenance: PV-0922
  /** A descriptor record (PV-0924). */
  descriptorWidth: 44, // provenance: PV-0924
  /** A value record (PV-0926). */
  valueWidth: 337, // provenance: PV-0926
  /** A value record's name field, bytes 0–31; the value field follows (PV-0926). */
  valueNameWidth: 32, // provenance: PV-0926
  /** Where a VERBS record's name starts, and where its flag byte is (PV-0922). */
  verbNameStart: 10, // provenance: PV-0922
  verbFlagOffset: 52, // provenance: PV-0922
  /**
   * The nine `0` characters every value field the server sends starts with, and every output
   * record of the answer (PV-0938, PV-0957; Reading R-CT-33).
   */
  zeros: ascii("000000000"), // provenance: PV-0938, PV-0957
  /** The name of a result slot (PV-0924). */
  resultName: ascii("_RESULT"), // provenance: PV-0924
  /**
   * What every result column's name starts with: `_RESULT`, or a longer name of a get-property
   * verb's output such as `_RESULT_QUEUEONLY` (PV-0955, PV-1006).
   */
  resultPrefix: "_RESULT", // provenance: PV-0924, PV-1006
  /** The mark of an input descriptor's name, `#N` (PV-0924). */
  inputMark: 0x23, // provenance: PV-0924
  /** The padding of every record field (PV-0922, PV-0926). */
  space: 0x20, // provenance: PV-0926
  /** A handle is `O` and decimal digits (PV-0939). */
  handlePrefix: 0x4f, // provenance: PV-0939
  /** The most digits a group or pointer is read with: more is no number Swooey uses. */
  maxDigits: 9 // not-protocol: overflow guard
} as const

/** The flag byte of a VERBS record (PV-0923; Swift `AutomationVerb.Flag`). */
export type AutomationVerbFlag =
  /** `C`, call a method. */
  | { readonly kind: "call" }
  /** `S`, set a property. */
  | { readonly kind: "set" }
  /** `G`, get a property. */
  | { readonly kind: "get" }
  /** Any other byte. */
  | { readonly kind: "unknown"; readonly value: number }

export const AutomationVerbFlag = {
  call: { kind: "call" } as AutomationVerbFlag,
  set: { kind: "set" } as AutomationVerbFlag,
  get: { kind: "get" } as AutomationVerbFlag,
  unknown: (value: number): AutomationVerbFlag => ({ kind: "unknown", value }),

  callByte: 0x43, // provenance: PV-0923
  setByte: 0x53, // provenance: PV-0923
  getByte: 0x47, // provenance: PV-0923

  /** The flag of `byte` (Swift `Flag(_:)`). */
  of(byte: number): AutomationVerbFlag {
    switch (byte) {
      case AutomationVerbFlag.callByte:
        return { kind: "call" }
      case AutomationVerbFlag.setByte:
        return { kind: "set" }
      case AutomationVerbFlag.getByte:
        return { kind: "get" }
      default:
        return { kind: "unknown", value: byte }
    }
  },

  /** Swift's `==`. */
  equals(a: AutomationVerbFlag, b: AutomationVerbFlag): boolean {
    return a.kind === b.kind && (a.kind !== "unknown" || a.value === (b as typeof a).value)
  }
} as const

/**
 * One VERBS record (rfc-tr.md §7.2, PV-0922): the verb's name and its flag. The object column is
 * not read: Swooey's results do not depend on the target (Reading R-CT-34).
 */
export class AutomationVerb {
  constructor(
    /** Bytes 10–51 without their trailing spaces. */
    readonly name: Uint8Array,
    readonly flag: AutomationVerbFlag
  ) {}

  /** Reads a record of `AutomationRecordLayout.verbWidth` bytes (Swift `init(record:)`). */
  static decode(record: Uint8Array): AutomationVerb {
    let end = AutomationRecordLayout.verbFlagOffset
    const start = AutomationRecordLayout.verbNameStart
    while (end > start && record[end - 1] === AutomationRecordLayout.space) end -= 1
    return new AutomationVerb(record.slice(start, end), AutomationVerbFlag.of(record[AutomationRecordLayout.verbFlagOffset]))
  }
}

/** What a descriptor row is (Swift `AutomationDescriptor.Role`). */
export type AutomationDescriptorRole =
  /** Four columns, name `#N`: an input the server fills. */
  | "input"
  /** Four columns, name `_RESULT`: a result slot. */
  | "result"
  /** Any other row, a blank one included. */
  | "other"

/**
 * One descriptor record (rfc-tr.md §7.3, PV-0924), read as Readings R-CT-32 and R-CT-33 say: the
 * four-column layout `group type name pointer`, name `#N` or `_RESULT`; any other row is read
 * leniently, its first white-space-separated token its group and its last its pointer when they are
 * decimal (a guess: the layout of those rows is not known, PV-0955).
 */
export class AutomationDescriptor {
  constructor(
    readonly role: AutomationDescriptorRole,
    /** The group, 1-based: the verb the row belongs to; undefined when it cannot be read. */
    readonly group: number | undefined,
    /** The pointer, 1-based: the value record the row maps to; undefined when it cannot be read. */
    readonly pointer: number | undefined
  ) {}

  /** Reads a record of `AutomationRecordLayout.descriptorWidth` bytes (Swift `init(record:)`). */
  static decode(record: Uint8Array): AutomationDescriptor {
    const tokens: ByteRange[] = []
    let start: number | undefined
    for (let index = 0; index < record.length; index++) {
      const separator = AutomationDescriptor.isSeparator(record[index])
      if (separator && start !== undefined) {
        tokens.push(new ByteRange(start, index))
        start = undefined
      } else if (!separator && start === undefined) {
        start = index
      }
    }
    if (start !== undefined) tokens.push(new ByteRange(start, record.length))
    // The four columns: group, type, name, pointer (PV-0924).
    const columns = 4 // provenance: PV-0924
    if (tokens.length === columns) {
      const group = AutomationDescriptor.decimal(record, tokens[0])
      const type = AutomationDescriptor.decimal(record, tokens[1])
      const pointer = AutomationDescriptor.decimal(record, tokens[columns - 1]) // provenance: PV-0924
      const role = AutomationDescriptor.name(record, tokens[columns - 2]) // provenance: PV-0924
      if (group !== undefined && type !== undefined && pointer !== undefined && role !== undefined)
        return new AutomationDescriptor(role, group, pointer)
    }
    const group = tokens.length > 0 ? AutomationDescriptor.decimal(record, tokens[0]) : undefined
    const pointer = tokens.length > 1 ? AutomationDescriptor.decimal(record, tokens[tokens.length - 1]) : undefined
    return new AutomationDescriptor("other", group, pointer)
  }

  /** White space between the columns: spaces, and the control bytes a text never carries. */
  static isSeparator(byte: number): boolean {
    return byte <= AutomationRecordLayout.space
  }

  /** A token of decimal digits, at most `AutomationRecordLayout.maxDigits` of them. */
  static decimal(record: Uint8Array, range: ByteRange): number | undefined {
    if (!(range.count <= AutomationRecordLayout.maxDigits)) return undefined
    let value = 0
    for (let index = range.lowerBound; index < range.upperBound; index++) {
      const byte = record[index]
      if (!(byte >= 0x30 && byte <= 0x39)) return undefined
      value = value * 10 + (byte - 0x30) // not-protocol: decimal digits
    }
    return value
  }

  /** `#N` or `_RESULT` (PV-0924), else undefined. */
  static name(record: Uint8Array, range: ByteRange): AutomationDescriptorRole | undefined {
    if (
      range.count > 1 &&
      record[range.lowerBound] === AutomationRecordLayout.inputMark &&
      AutomationDescriptor.decimal(record, new ByteRange(range.lowerBound + 1, range.upperBound)) !== undefined
    )
      return "input"
    const resultName = AutomationRecordLayout.resultName
    if (range.count !== resultName.length) return undefined
    for (let offset = 0; offset < resultName.length; offset++) if (record[range.lowerBound + offset] !== resultName[offset]) return undefined
    return "result"
  }
}

/** What a value record of the call is to the answer (Reading R-CT-33, PV-0938). */
export type AutomationValueKind =
  /** Its name field is not blank: a slot the answer fills. */
  | "output"
  /**
   * Its name field is blank and its value field is the nine zeros followed directly by a printable
   * byte other than a space: a handle or a three-character object record, which the answer keeps.
   */
  | "reference"
  /** Every other record, which the answer blanks. */
  | "input"

export const AutomationValueKind = {
  /** The kind of a record of `AutomationRecordLayout.valueWidth` bytes (Swift `init(record:)`). */
  of(record: Uint8Array): AutomationValueKind {
    const nameWidth = AutomationRecordLayout.valueNameWidth
    for (let index = 0; index < nameWidth; index++) if (record[index] !== AutomationRecordLayout.space) return "output"
    const zeros = AutomationRecordLayout.zeros
    for (let offset = 0; offset < zeros.length; offset++) if (record[nameWidth + offset] !== zeros[offset]) return "input"
    const next = record[nameWidth + zeros.length]
    return next > AutomationRecordLayout.space && next < 0x7f ? "reference" : "input" // not-protocol: printable ASCII
  },

  /**
   * Whether an output record of the call holds something after the nine zeros: the server
   * pre-fills a result slot whose receiver is an object with the object's content, and leaves the
   * slot of an integer receiver at the zeros (rfc-tr.md §7.7.5, Reading R-CT-34; issue #151).
   */
  holdsValue(record: Uint8Array): boolean {
    const start = AutomationRecordLayout.valueNameWidth + AutomationRecordLayout.zeros.length
    for (let index = start; index < record.length; index++) if (record[index] !== AutomationRecordLayout.space) return true
    return false
  }
} as const

/** What a verb returns in Swooey's answer (Reading R-CT-34, PV-0953). */
export type AutomationResult =
  /** A new handle from the connection's counter. */
  | { readonly kind: "newHandle" }
  /** A decimal integer after one space. */
  | { readonly kind: "integer"; readonly value: number }
  /** An indexed SVARS string containing the supported optional features (PV-1023). */
  | { readonly kind: "guiFeatures" }
  /** The nine zeros alone. */
  | { readonly kind: "empty" }

/**
 * How a result was decided (Reading R-CT-34; Swift `AutomationResult.Basis`).
 * - `name`: the verb's name is in R-CT-34's table.
 * - `record`: the verb is not in the table; the call's result record decided (issue #151, PV-0761):
 *   a new handle when the record holds the receiver's content, the integer 0 when it holds nothing
 *   after the nine zeros.
 */
export type AutomationResultBasis = "name" | "record"

/** A verb name's bytes as a set key. */
const nameKey = (name: ArrayLike<number>): string => String.fromCharCode(...Array.from(name))

export const AutomationResult = {
  newHandle: { kind: "newHandle" } as AutomationResult,
  integer: (value: number): AutomationResult => ({ kind: "integer", value }),
  guiFeatures: { kind: "guiFeatures" } as AutomationResult,
  empty: { kind: "empty" } as AutomationResult,

  /**
   * The verbs that return a new handle, whatever their flag (PV-0953). `G` verbs return one by
   * their flag (`of`).
   */
  handleVerbs: new Set([
    "CreateObject",
    "CreateControl",
    "CreateControl2",
    "GetGuiServices",
    "GetServiceByName",
    "GetDataAsFormat",
    "GetTable"
  ]) as ReadonlySet<string>, // provenance: PV-0953
  /** The verbs that return 0. */
  zeroVerbs: new Set(["AddControl", "SetGrid", "SetColumnWidth", "PublishUrl"]) as ReadonlySet<string>, // provenance: PV-0953
  /** The verbs that return 1. */
  oneVerbs: new Set(["GetContainer"]) as ReadonlySet<string>, // provenance: PV-0953
  /** The verbs that return nothing: a client without a registry has no value. */
  emptyVerbs: new Set(["GetRegValueEx"]) as ReadonlySet<string>, // provenance: PV-0953
  /** The `G` verbs that return a new handle by name (PV-0953): the three seen doing so. */
  handleProperties: new Set(["Structures", "Level", "Image"]) as ReadonlySet<string>, // provenance: PV-0953

  /**
   * The result of `verb` (R-CT-34) and what decided it, or undefined for a verb that writes none:
   * an `S` verb, or a flag Swooey does not know. `recordHoldsValue` says whether a result record
   * the verb writes holds something after the nine zeros in the call
   * (`AutomationValueKind.holdsValue`).
   */
  decide(verb: AutomationVerb, recordHoldsValue: boolean): { result: AutomationResult; basis: AutomationResultBasis } | undefined {
    const name = nameKey(verb.name)
    if (verb.flag.kind === "call" && name === "GetGuiFeatures") return { result: { kind: "guiFeatures" }, basis: "name" } // provenance: PV-1023
    if (AutomationResult.handleVerbs.has(name)) return { result: { kind: "newHandle" }, basis: "name" }
    if (AutomationResult.zeroVerbs.has(name)) return { result: { kind: "integer", value: 0 }, basis: "name" }
    if (AutomationResult.oneVerbs.has(name)) return { result: { kind: "integer", value: 1 }, basis: "name" }
    if (AutomationResult.emptyVerbs.has(name)) return { result: { kind: "empty" }, basis: "name" }
    switch (verb.flag.kind) {
      case "get":
        if (AutomationResult.handleProperties.has(name)) return { result: { kind: "newHandle" }, basis: "name" }
        return AutomationResult.byRecord(recordHoldsValue)
      case "call":
        return AutomationResult.byRecord(recordHoldsValue)
      case "set":
      case "unknown":
        return undefined
    }
  },

  /**
   * A verb the table does not name: the server pre-fills the result record of an object receiver
   * with the object's content and leaves an integer receiver's record at the zeros (PV-0957,
   * PV-0761). A handle to an integer receiver made the server dump (issue #151); an integer to an
   * object receiver is the other way round.
   */
  byRecord(recordHoldsValue: boolean): { result: AutomationResult; basis: AutomationResultBasis } {
    return { result: recordHoldsValue ? { kind: "newHandle" } : { kind: "integer", value: 0 }, basis: "record" }
  },

  /** The result of `verb` (R-CT-34) for a result record that holds nothing in the call, by default. */
  of(verb: AutomationVerb, recordHoldsValue = false): AutomationResult | undefined {
    return AutomationResult.decide(verb, recordHoldsValue)?.result
  }
} as const

/**
 * Swooey's handle counter (Reading R-CT-34): one per connection, for all its modes, starting at 1,
 * only growing. A handle is `O` and the counter's decimal digits without leading zeros (PV-0939).
 *
 * A Swift struct: `clone()` copies it where Swift copies the value.
 */
export class ControlHandleCounter {
  private _next: number

  /** A fresh counter (the first handle is `O1`), or one whose next handle is `O<next>` (for tests; a session starts at 1). */
  constructor(next = 1) {
    this._next = Math.max(next, 1)
  }

  /** The number of the next handle; 1 before the first. */
  get next(): number {
    return this._next
  }

  /** A copy of this counter. */
  clone(): ControlHandleCounter {
    return new ControlHandleCounter(this._next)
  }

  /** The next handle; the counter moves on. */
  mint(): { number: number; text: Uint8Array } {
    const number = this._next
    this._next += 1
    return { number, text: Uint8Array.of(AutomationRecordLayout.handlePrefix, ...ascii(String(number))) }
  }
}
