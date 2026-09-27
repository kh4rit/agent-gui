// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ControlCall.swift (MIT).

// A flush call read for what it does (docs/protocol/controls/rfc-tr.md §7, controls/scene.md): its
// verbs in order, each with the record it acts on, its arguments and its result slot resolved
// through the descriptor table into the value records, and the data objects of its RFC_QUEUE table.
// The answer builder (flushCallAnswer.ts) reads the same tables to answer the call; this reader is
// for the control scene the app builds from the call (ScreenModel's ControlScene).

import { ascii } from "../wire/index.js"
import { AutomationRecordLayout, AutomationVerb, type AutomationVerbFlag } from "./automationRecords.js"
import { DataField, DataObject, DataProviderQueue, decodeUTF8Repairing, parseInteger } from "./dataProviderQueue.js"
import { FlushCallAnswerBuilder, FlushCallReadError, FlushTextRows } from "./flushCallAnswer.js"
import { RFCTextEncoding, RFCTextForm } from "./rfcText.js"

/**
 * One argument of an invocation: its descriptor name (`#1`, or empty for a set-property verb's
 * value) and the value record it points at (from 1). (Swift `ControlCall.Invocation.Argument`.)
 */
export interface ControlCallArgument {
  readonly name: string
  readonly type: number | undefined
  readonly record: number
}

/** One verb of the call (Swift `ControlCall.Invocation`). */
export class ControlCallInvocation {
  readonly arguments: readonly ControlCallArgument[]

  constructor(
    /** The verb's number in the call, from 1. */
    readonly index: number,
    readonly name: string,
    readonly flag: AutomationVerbFlag,
    /**
     * The record the verb acts on (the verb record's object column), from 1; 0 when the column
     * holds no number.
     */
    readonly target: number,
    argumentList: readonly ControlCallArgument[],
    /** The record the result goes to: a descriptor named `_RESULT` or `_RESULT…`. */
    readonly result: number | undefined
  ) {
    this.arguments = argumentList
  }

  /** The argument named `#n`, or the n-th argument when names are absent. */
  argument(n: number): ControlCallArgument | undefined {
    const list = this.arguments
    return list.find(argument => argument.name === `#${n}`) ?? (n - 1 >= 0 && n - 1 < list.length ? list[n - 1] : undefined)
  }
}

/** One value record: its name field and the value after the nine zeros, without padding (Swift `ControlCall.Record`). */
export class ControlCallRecord {
  constructor(
    readonly name: string,
    readonly value: string
  ) {}

  /** A handle or object record: the value starts with `O` (PV-0939, PV-0957). */
  get isObject(): boolean {
    return this.value.startsWith("O")
  }
}

/** `bytes` with spaces cut at both ends, decoded as UTF-8 (Swift `ControlCall.trimmed`). */
function trimmed(bytes: Uint8Array): string {
  let start = 0
  let end = bytes.length
  while (start < end && bytes[start] === 0x20) start += 1 // not-protocol: space padding trimmed
  while (end > start && bytes[end - 1] === 0x20) end -= 1 // not-protocol: space padding trimmed
  return decodeUTF8Repairing(bytes.subarray(start, end))
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index++) if (bytes[index] !== prefix[index]) return false
  return true
}

/** `Uint8Array` contents as a map key. */
const bytesKey = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

/** A flush call as a list of invocations over value records, with its data objects. */
export class ControlCall {
  /** The width of a queue table's rows the reader takes (`DataProviderQueue.rowWidth`). */
  static readonly queueWidth = DataProviderQueue.rowWidth
  /** The most bytes of one data object's rows. */
  static readonly maxDataObjectBytes = 16 * 1024 * 1024 // not-protocol: memory cap, 16 MiB

  /** The names of a data object's parameters and tables (PV-1001). */
  static readonly urlParameter = ascii("DESURL") // provenance: PV-1001
  static readonly typeParameter = ascii("TYPE") // provenance: PV-1001
  static readonly subtypeParameter = ascii("SUBTYPE") // provenance: PV-1001
  static readonly formatTable = ascii("FORMAT") // provenance: PV-1001
  static readonly dataTables: readonly Uint8Array[] = [ascii("DATAASC"), ascii("DATABIN")] // provenance: PV-1001

  private constructor(
    readonly encoding: RFCTextEncoding,
    readonly invocations: readonly ControlCallInvocation[],
    /** The value records, from 1 in `record`. */
    readonly records: readonly ControlCallRecord[],
    /** The data objects of the call's RFC_QUEUE table, by sequence. */
    readonly dataObjects: readonly DataObject[],
    /** Entries of the queue that were not read: a missing part or a stream that does not read. */
    readonly queueProblems: readonly string[]
  ) {}

  /** The record numbered `number` (from 1), or undefined. */
  record(number: number): ControlCallRecord | undefined {
    return number - 1 >= 0 && number - 1 < this.records.length ? this.records[number - 1] : undefined
  }

  /** The value of an invocation's argument `n`. */
  argument(n: number, invocation: ControlCallInvocation): string | undefined {
    const argument = invocation.argument(n)
    return argument === undefined ? undefined : this.record(argument.record)?.value
  }

  /** The data object a `SetDataFromUrl` argument names, by its URL. */
  dataObject(url: string): DataObject | undefined {
    return this.dataObjects.find(object => object.url === url)
  }

  /**
   * Reads `call`, an RFC_TR value of an `OLE_FLUSH_CALL` (Swift `init(reading:)`; Reading R-CT-28's
   * requirements on the tables; a call without a queue table has no data objects). Throws
   * `FlushCallReadError`.
   */
  static read(call: Uint8Array): ControlCall {
    const B = FlushCallAnswerBuilder
    const items = B.walk(call)
    const { encoding } = B.function(items, call)
    const tables = B.readTables(items, call)
    const width = RFCTextEncoding.bytesPerCharacter(encoding)
    const descriptors = B.table("descriptors", tables, table => table.width === AutomationRecordLayout.descriptorWidth * width)
    const values = B.table("values", tables, table => RFCTextEncoding.matches(encoding, call, table.name, B.valuesName))
    const verbs = B.table("verbs", tables, table => RFCTextEncoding.matches(encoding, call, table.name, B.verbsName))
    if (values.width !== AutomationRecordLayout.valueWidth * width)
      throw new FlushCallReadError({ kind: "tableWidth", table: "values", width: values.width, expected: AutomationRecordLayout.valueWidth * width })
    if (verbs.width !== AutomationRecordLayout.verbWidth * width)
      throw new FlushCallReadError({ kind: "tableWidth", table: "verbs", width: verbs.width, expected: AutomationRecordLayout.verbWidth * width })
    const descriptorRows = new FlushTextRows(B.rows(descriptors, "descriptors", call, encoding), encoding)
    const valueRows = new FlushTextRows(B.rows(values, "values", call, encoding), encoding)
    const verbRows = new FlushTextRows(B.rows(verbs, "verbs", call, encoding), encoding)

    // The value records.
    const records: ControlCallRecord[] = []
    const valueWidth = AutomationRecordLayout.valueWidth
    for (let start = 0; start < valueRows.characters.length; start += valueWidth) {
      const record = valueRows.characters.subarray(start, start + valueWidth)
      const name = trimmed(record.subarray(0, AutomationRecordLayout.valueNameWidth))
      let rest = record.subarray(AutomationRecordLayout.valueNameWidth)
      if (startsWith(rest, AutomationRecordLayout.zeros)) rest = rest.subarray(AutomationRecordLayout.zeros.length)
      records.push(new ControlCallRecord(name, trimmed(rest)))
    }

    // The descriptors by group (PV-0924, PV-0955): four columns, or three for a set-property verb's
    // value, or a result column whose name starts with `_RESULT`.
    const byGroup = new Map<number, { name: string; type: number | undefined; pointer: number }[]>()
    const descriptorWidth = AutomationRecordLayout.descriptorWidth
    for (let start = 0; start < descriptorRows.characters.length; start += descriptorWidth) {
      const row = descriptorRows.characters.subarray(start, start + descriptorWidth)
      const tokens = trimmed(row)
        .split(" ")
        .filter(token => token.length > 0)
      if (tokens.length < 3) continue
      const group = parseInteger(tokens[0])
      const pointer = parseInteger(tokens[tokens.length - 1])
      if (group === undefined || pointer === undefined) continue // provenance: PV-1006
      const type = parseInteger(tokens[1])
      const name = tokens.length >= 4 ? tokens[2] : "" // provenance: PV-1006
      const entries = byGroup.get(group)
      if (entries === undefined) byGroup.set(group, [{ name, type, pointer }])
      else entries.push({ name, type, pointer })
    }

    // The verbs (PV-0922).
    const invocations: ControlCallInvocation[] = []
    const verbWidth = AutomationRecordLayout.verbWidth
    for (let start = 0; start < verbRows.characters.length; start += verbWidth) {
      const record = verbRows.characters.subarray(start, start + verbWidth)
      const verb = AutomationVerb.decode(record)
      const index = invocations.length + 1
      const target = parseInteger(trimmed(record.subarray(0, AutomationRecordLayout.verbNameStart))) ?? 0
      const argumentList: ControlCallArgument[] = []
      let result: number | undefined
      for (const descriptor of byGroup.get(index) ?? []) {
        if (descriptor.name.startsWith(AutomationRecordLayout.resultPrefix)) result = descriptor.pointer
        else argumentList.push({ name: descriptor.name, type: descriptor.type, record: descriptor.pointer })
      }
      invocations.push(new ControlCallInvocation(index, decodeUTF8Repairing(verb.name), verb.flag, target, argumentList, result))
    }

    // The data objects (PV-1000–PV-1004).
    const objects: DataObject[] = []
    const problems: string[] = []
    const queue = tables.find(table => RFCTextEncoding.matches(encoding, call, table.name, DataProviderQueue.tableName))
    if (queue !== undefined && queue.rows > 0) {
      if (queue.width !== ControlCall.queueWidth)
        throw new FlushCallReadError({ kind: "tableWidth", table: "dataObjects", width: queue.width, expected: ControlCall.queueWidth })
      const rows = B.rows(queue, "dataObjects", call, encoding)
      for (const entry of DataProviderQueue.entries(rows)) {
        const payload = entry.payload
        if (payload === undefined) {
          problems.push(`entry ${entry.sequence}: missing part(s) [${entry.missingParts.join(", ")}]`)
          continue
        }
        try {
          objects.push(ControlCall.dataObject(payload, entry.sequence))
        } catch (error) {
          if (!(error instanceof FlushCallReadError)) throw error
          problems.push(`entry ${entry.sequence}: ${error.message}`)
        }
      }
    }
    return new ControlCall(encoding, invocations, records, objects, problems)
  }

  /**
   * Reads one entry's stream: a call of the data-provider function whose parameter pairs (`02 01`
   * name, `02 03` value) carry the URL, type and subtype, and whose tables carry the FORMAT and the
   * rows (PV-1001). Throws `FlushCallReadError`.
   */
  static dataObject(payload: Uint8Array, sequence: number): DataObject {
    const B = FlushCallAnswerBuilder
    const items = B.walk(payload)
    const functionItem = items.find(item => item.id === B.functionNameID)
    const functionForm = functionItem === undefined ? undefined : RFCTextForm.of(functionItem.valueRange.of(payload))
    const encoding: RFCTextEncoding = (functionForm === undefined ? undefined : RFCTextForm.encoding(functionForm)) ?? "singleByte"
    const parameters = new Map<string, string>()
    for (let index = 0; index + 1 < items.length; index++) {
      if (!(items[index].id === B.importParameterID && items[index + 1].id === B.parameterValueID)) continue
      const name = RFCTextEncoding.narrow(encoding, items[index].valueRange.of(payload))
      const value = RFCTextEncoding.narrow(encoding, items[index + 1].valueRange.of(payload))
      parameters.set(bytesKey(name), trimmed(value))
    }
    const tables = B.readTables(items, payload)
    const fields: DataField[] = []
    let structureName: string | undefined
    const format = tables.find(table => RFCTextEncoding.matches(encoding, payload, table.name, ControlCall.formatTable))
    if (format !== undefined) {
      const rows = B.rows(format, "dataObjects", payload, encoding)
      if (format.width !== DataField.recordWidth)
        throw new FlushCallReadError({ kind: "tableWidth", table: "dataObjects", width: format.width, expected: DataField.recordWidth })
      for (let start = 0; start < rows.length; start += format.width) {
        const record = rows.subarray(start, start + format.width)
        const field = DataField.of(record)
        if (field !== undefined) fields.push(field)
        if (structureName === undefined) {
          const name = DataField.structureName(record)
          structureName = name === "X-UNKNOWN" ? undefined : name // provenance: PV-1004
        }
      }
    }
    let rowWidth = 0
    const rows: Uint8Array[] = []
    const data = tables.find(table => ControlCall.dataTables.some(name => RFCTextEncoding.matches(encoding, payload, table.name, name)))
    if (data !== undefined) {
      rowWidth = data.width
      const bytes = B.rows(data, "dataObjects", payload, encoding)
      if (!(bytes.length <= ControlCall.maxDataObjectBytes))
        throw new FlushCallReadError({ kind: "tableContent", table: "dataObjects", problem: { kind: "tooLarge", value: bytes.length } })
      if (data.width > 0) for (let start = 0; start < bytes.length; start += data.width) rows.push(bytes.slice(start, Math.min(start + data.width, bytes.length)))
    }
    return new DataObject(
      sequence,
      parameters.get(bytesKey(ControlCall.urlParameter)) ?? "",
      parameters.get(bytesKey(ControlCall.typeParameter)) ?? "",
      parameters.get(bytesKey(ControlCall.subtypeParameter)) ?? "",
      structureName,
      fields,
      rowWidth,
      rows
    )
  }

  /** Structure only: counts and verb names. */
  get description(): string {
    return `ControlCall(${this.invocations.length} verb(s), ${this.records.length} record(s), ${this.dataObjects.length} data object(s))`
  }

  toString(): string {
    return this.description
  }
}
