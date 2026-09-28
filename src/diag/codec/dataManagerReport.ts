// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DataManagerReport.swift (MIT).

// What a client reports in its DATAMANAGER document (docs/protocol/controls/datamanager.md §3.5,
// events.md §4): control events and the controls' state, in the shape SAP GUI wrote them in the
// owner's capture of 2026-09-26 (trial-derived, PV-1013 to PV-1016). Written by Swooey when the
// user clicks into a grid or a tree; read back by the fake server.

import { ascii } from "../wire/index.js"
import { decodeUTF8Repairing, parseInteger } from "./dataProviderQueue.js"
import { ClientDataManager } from "./inputEnvelope.js"
import type { MarkupDocument, MarkupElement, MarkupNode } from "./markupDocument.js"

/**
 * An event (`EVENTS` › `EVENT`): the shell it happened in, its number, and its parameters by
 * position (`PARAM`, `PID` 0, 1, …). (Swift `DataManagerReport.Event`.)
 */
export interface DataManagerEvent {
  shell: number
  event: number
  parameters: string[]
}

/** A cached property of a control (Swift `DataManagerReport.Control.Property`). */
export interface DataManagerProperty {
  name: string
  value: string
}

/**
 * The first visible cell of a grid: `FVRIDS` (the row id's sub-number), `FVCID` (the column) and
 * `FVRID` (the row). (Swift `DataManagerReport.Control.FirstVisible`.)
 */
export interface DataManagerFirstVisible {
  rowSub: number
  column: number
  row: number
}

export const DataManagerFirstVisible = {
  /** The grid scrolled nowhere: row 1, column 1, sub-number 0, as SAP GUI reported it (a fresh value). */
  get origin(): DataManagerFirstVisible {
    return { rowSub: 0, column: 1, row: 1 } // provenance: PV-1015
  }
} as const

/**
 * A control's state (`CONTROLS` › `CONTROL`): its cached properties by name, in order, and a grid's
 * first visible cell (`GENERIC`). (Swift `DataManagerReport.Control`.)
 */
export class DataManagerControl {
  shell: number
  properties: DataManagerProperty[]
  firstVisible: DataManagerFirstVisible | undefined

  constructor(shell: number, properties: DataManagerProperty[] = [], firstVisible?: DataManagerFirstVisible) {
    this.shell = shell
    this.properties = properties
    this.firstVisible = firstVisible
  }

  /** The value of the property named `name`, when the control reports it. */
  property(name: string): string | undefined {
    return this.properties.find(property => property.name === name)?.value
  }
}

/** One column of a column-position snapshot (Swift `DataManagerReport.ColumnPositions.Column`). */
export interface DataManagerColumn {
  readonly position: number
  readonly width: number
}

/**
 * A complete column-position snapshot, addressed by the on-demand object's explicit Handle
 * property, never the automation result handle (PV-1024). (Swift `DataManagerReport.ColumnPositions`.)
 */
export class DataManagerColumnPositions {
  static readonly maxColumns = 4096 // not-protocol: bounded report size

  private constructor(
    readonly handle: number,
    readonly columns: readonly DataManagerColumn[]
  ) {}

  /**
   * The snapshot (Swift's failable `init?(handle:columns:)`), or undefined for a handle below 1,
   * more than `maxColumns` columns, a position or width below 1, or a position that repeats.
   */
  static of(handle: number, columns: readonly DataManagerColumn[]): DataManagerColumnPositions | undefined {
    if (
      !(
        handle > 0 &&
        columns.length <= DataManagerColumnPositions.maxColumns &&
        columns.every(column => column.position > 0 && column.width > 0) &&
        new Set(columns.map(column => column.position)).size === columns.length
      )
    )
      return undefined
    return new DataManagerColumnPositions(handle, columns.map(column => ({ position: column.position, width: column.width })))
  }
}

/** The most parameters an event read back keeps. */
const MAX_PARAMETERS = 64 // not-protocol: a reader's limit

/** A client DATAMANAGER document's events, control state and column positions. */
export class DataManagerReport {
  /**
   * The first word of the OK-code that has the server process a control event: `%_GC`, then the
   * shell id and the event number (controls/events.md Reading R-CT-38).
   */
  static readonly eventOKCodePrefix = "%_GC" // provenance: PV-1013
  /** The most parameters an event read back keeps. */
  static readonly maxParameters = MAX_PARAMETERS

  events: DataManagerEvent[]
  controls: DataManagerControl[]
  columnPositions: DataManagerColumnPositions[]

  constructor(
    options: { events?: DataManagerEvent[]; controls?: DataManagerControl[]; columnPositions?: DataManagerColumnPositions[] } = {}
  ) {
    this.events = options.events ?? []
    this.controls = options.controls ?? []
    this.columnPositions = options.columnPositions ?? []
  }

  get isEmpty(): boolean {
    return this.events.length === 0 && this.controls.length === 0 && this.columnPositions.length === 0
  }

  // MARK: Writing

  /**
   * The document's bytes: the declaration of the bare document (Reading R-CI-17), then `DATAMANAGER`
   * holding the `EVENTS` block and the `CONTROLS` block, attributes in SAP GUI's order (PV-1013,
   * PV-1015); the bare document when there is nothing to report. Values are ASCII: a character
   * outside printable ASCII, and XML's five special characters, are written as references.
   */
  get document(): Uint8Array {
    if (this.isEmpty) return ClientDataManager.bareDocument.slice()
    let text = '<?xml version="1.0" encoding="sap*"?><DATAMANAGER>' // provenance: PV-0931
    if (this.events.length > 0) {
      text += "<EVENTS>"
      for (const event of this.events) {
        text += `<EVENT SHELLID="${event.shell}" EVENTID="${event.event}">` // provenance: PV-1013
        event.parameters.forEach((parameter, index) => {
          text += `<PARAM VALUE="${DataManagerReport.escaped(parameter)}" PID="${index}"/>` // provenance: PV-1013
        })
        text += "</EVENT>"
      }
      text += "</EVENTS>"
    }
    if (this.controls.length > 0) {
      text += "<CONTROLS>"
      for (const control of this.controls) {
        text += `<CONTROL SHELLID="${control.shell}">` // provenance: PV-1015
        for (const property of control.properties)
          text += `<PROPERTY VALUE="${DataManagerReport.escaped(property.value)}" NAME="${DataManagerReport.escaped(property.name)}"/>` // provenance: PV-1015
        const first = control.firstVisible
        if (first !== undefined) text += `<GENERIC FVRIDS="${first.rowSub}" FVCID="${first.column}" FVRID="${first.row}"/>` // provenance: PV-1015
        text += "</CONTROL>"
      }
      text += "</CONTROLS>"
    }
    if (this.columnPositions.length > 0) {
      text += "<TABLES>" // provenance: PV-1015, PV-1024
      for (const table of this.columnPositions) {
        text += `<DATACHANGES HANDLE="${table.handle}"><IT OP="C" IDX="0"/>`
        table.columns.forEach((column, index) => {
          text += `<IT OP="I" IDX="${index + 1}" C1="${column.position}" C2="${column.width}"/>`
        })
        text += "</DATACHANGES>"
      }
      text += "</TABLES>"
    }
    text += "</DATAMANAGER>"
    return ascii(text)
  }

  /**
   * `value` as an attribute value: printable ASCII as it is, `& < > " '` as entities, any other
   * character as a decimal character reference.
   */
  static escaped(value: string): string {
    let text = ""
    for (const scalar of value) {
      switch (scalar) {
        case "&":
          text += "&amp;"
          break
        case "<":
          text += "&lt;"
          break
        case ">":
          text += "&gt;"
          break
        case '"':
          text += "&quot;"
          break
        case "'":
          text += "&apos;"
          break
        default:
          if (scalar >= " " && scalar <= "~") text += scalar
          else text += `&#${scalar.codePointAt(0)};`
      }
    }
    return text
  }

  // MARK: Reading

  /**
   * The report a document holds (Swift `init?(reading:)`): events, controls and column positions,
   * attributes found by name whatever their order; undefined when its root is not `DATAMANAGER`.
   * Character and entity references in values are resolved; elements it does not know are left out.
   */
  static read(document: MarkupDocument): DataManagerReport | undefined {
    const root = document.root
    if (root === undefined || !isName(root.name, "DATAMANAGER")) return undefined
    const events: DataManagerEvent[] = []
    const controls: DataManagerControl[] = []
    const columnPositions: DataManagerColumnPositions[] = []
    for (const block of DataManagerReport.elements(root.children)) {
      switch (decodeUTF8Repairing(block.name)) {
        case "EVENTS":
          for (const element of DataManagerReport.elements(block.children)) {
            if (!isName(element.name, "EVENT")) continue
            const shell = DataManagerReport.number(element.attribute("SHELLID"))
            const number = DataManagerReport.number(element.attribute("EVENTID"))
            if (shell === undefined || number === undefined) continue
            const parameters = new Map<number, string>()
            for (const parameter of DataManagerReport.elements(element.children)) {
              if (!isName(parameter.name, "PARAM")) continue
              const index = DataManagerReport.number(parameter.attribute("PID"))
              if (index === undefined || !(index >= 0 && index < MAX_PARAMETERS)) continue
              parameters.set(index, DataManagerReport.text(parameter.attribute("VALUE")))
            }
            const count = Math.max(-1, ...parameters.keys()) + 1
            events.push({ shell, event: number, parameters: Array.from({ length: count }, (_, index) => parameters.get(index) ?? "") })
          }
          break
        case "CONTROLS":
          for (const element of DataManagerReport.elements(block.children)) {
            if (!isName(element.name, "CONTROL")) continue
            const shell = DataManagerReport.number(element.attribute("SHELLID"))
            if (shell === undefined) continue
            const control = new DataManagerControl(shell)
            for (const child of DataManagerReport.elements(element.children)) {
              const name = child.attribute("NAME")
              if (isName(child.name, "PROPERTY") && name !== undefined) {
                control.properties.push({ name: DataManagerReport.text(name), value: DataManagerReport.text(child.attribute("VALUE")) })
              } else if (isName(child.name, "GENERIC")) {
                control.firstVisible = {
                  rowSub: DataManagerReport.number(child.attribute("FVRIDS")) ?? 0,
                  column: DataManagerReport.number(child.attribute("FVCID")) ?? 1,
                  row: DataManagerReport.number(child.attribute("FVRID")) ?? 1
                }
              }
            }
            controls.push(control)
          }
          break
        case "TABLES":
          for (const element of DataManagerReport.elements(block.children)) {
            if (!isName(element.name, "DATACHANGES")) continue
            const table = DataManagerReport.columnPositions(element)
            if (table !== undefined) columnPositions.push(table)
          }
          break
        default:
          break
      }
    }
    return new DataManagerReport({ events, controls, columnPositions })
  }

  /** Only the observed full replacement form; unknown operations are not partial reports. */
  static columnPositions(element: MarkupElement): DataManagerColumnPositions | undefined {
    const R = DataManagerReport
    const handle = R.number(element.attribute("HANDLE"))
    if (handle === undefined) return undefined
    const rows = R.elements(element.children)
    const clear = rows[0]
    if (
      !(
        rows.length <= DataManagerColumnPositions.maxColumns + 1 &&
        clear !== undefined &&
        isName(clear.name, "IT") &&
        R.text(clear.attribute("OP")) === "C" &&
        R.number(clear.attribute("IDX")) === 0
      )
    )
      return undefined
    const columns: DataManagerColumn[] = []
    for (let index = 0; index < rows.length - 1; index++) {
      const row = rows[index + 1]
      if (!(isName(row.name, "IT") && R.text(row.attribute("OP")) === "I" && R.number(row.attribute("IDX")) === index + 1)) return undefined
      const position = R.number(row.attribute("C1"))
      const width = R.number(row.attribute("C2"))
      if (position === undefined || width === undefined) return undefined
      columns.push({ position, width })
    }
    return DataManagerColumnPositions.of(handle, columns)
  }

  static elements(nodes: readonly MarkupNode[]): MarkupElement[] {
    const elements: MarkupElement[] = []
    for (const node of nodes) if (node.kind === "element") elements.push(node.value)
    return elements
  }

  static number(value: Uint8Array | undefined): number | undefined {
    return value === undefined ? undefined : parseInteger(decodeUTF8Repairing(value))
  }

  /**
   * An attribute value with its references resolved (`&amp;` and the other four entities, `&#N;`
   * and `&#xN;`); an unknown or malformed reference stays as it is.
   */
  static text(value: Uint8Array | undefined): string {
    if (value === undefined) return ""
    let rest = decodeUTF8Repairing(value)
    let text = ""
    for (let ampersand = rest.indexOf("&"); ampersand >= 0; ampersand = rest.indexOf("&")) {
      text += rest.slice(0, ampersand)
      rest = rest.slice(ampersand)
      const semicolon = rest.indexOf(";")
      if (semicolon < 0) break
      const resolved = resolveReference(rest.slice(1, semicolon))
      if (resolved !== undefined) {
        text += resolved
        rest = rest.slice(semicolon + 1)
      } else {
        text += "&"
        rest = rest.slice(1)
      }
    }
    return text + rest
  }
}

/** Whether `name` is the ASCII `text`. */
function isName(name: Uint8Array, text: string): boolean {
  if (name.length !== text.length) return false
  for (let index = 0; index < name.length; index++) if (name[index] !== text.charCodeAt(index)) return false
  return true
}

/** Swift `UInt32(text, radix:)`: an optional sign and digits of the radix; a minus sign only before zero. */
function parseUInt32(text: string, radix: 10 | 16): number | undefined {
  const pattern = radix === 16 ? /^[+-]?[0-9A-Fa-f]+$/ : /^[+-]?[0-9]+$/
  if (!pattern.test(text)) return undefined
  const value = parseInt(text.slice(text.startsWith("+") || text.startsWith("-") ? 1 : 0), radix)
  if (text.startsWith("-") && value !== 0) return undefined
  return value <= 0xffffffff ? value : undefined
}

/** The text of a reference's name (between `&` and `;`), or undefined when it is none this reader knows. */
function resolveReference(name: string): string | undefined {
  switch (name) {
    case "amp":
      return "&"
    case "lt":
      return "<"
    case "gt":
      return ">"
    case "quot":
      return '"'
    case "apos":
      return "'"
  }
  // Swift `Unicode.Scalar(code)`: no surrogate code point and nothing above U+10FFFF.
  const scalar = (code: number | undefined): string | undefined =>
    code === undefined || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? undefined : String.fromCodePoint(code)
  if (name.startsWith("#x")) return scalar(parseUInt32(name.slice(2), 16)) // not-protocol: a hexadecimal reference
  if (name.startsWith("#")) return scalar(parseUInt32(name.slice(1), 10))
  return undefined
}
