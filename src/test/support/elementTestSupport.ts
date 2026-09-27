// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ElementTestSupport.swift (MIT).

// Helpers of the screen-element tests (docs/protocol/elements.md). Bytes are written by hand from
// elements.md and dynt-atoms.md, independent of the encoders, so that encoder tests compare two
// separate constructions. Invented texts follow docs/testing.md §8 (D15).

import {
  DyntAtomHeader,
  DyntCombobox,
  DyntDialogFlags,
  DyntToggle,
  DyntToggleReturn,
  ListRun,
  ListRunWalker,
  ListWindowState,
  StatusMessageValue,
  TabstripButtons,
  TableRowRecord,
  type ByteRange,
  type CheckboxReading,
  type DropdownReading,
  type DyntAttributes,
  type DyntElementType,
  type ListRunStyle,
  type StatusMessageType,
  type TabstripReading
} from "../../diag/codec/index.js"
import type { ByteWriter } from "../../diag/wire/index.js"
import { ascii, cat, written } from "./codecTestSupport.js"
import { u16BE, walkAtoms } from "./dyntTestSupport.js"

/** A checkbox or radio payload in PV-0655's layout, written field by field. */
export function toggleContent(fields: { state: string; visible: number; eventID?: string; caption: string }): Uint8Array {
  const event = ascii(fields.eventID ?? "")
  const text = ascii(fields.caption)
  return cat([fields.state.charCodeAt(0)], u16BE(fields.visible), u16BE(0), [event.length], u16BE(event.length), u16BE(text.length), event, text)
}

/** The toggle body of the last atom of `value`. */
export function decodeToggle(value: Uint8Array, reading: CheckboxReading = "pv0655"): DyntToggle | undefined {
  const atom = walkAtoms(value).atoms.at(-1)
  return atom === undefined ? undefined : DyntToggle.fromAtom(atom, value, reading)
}

/** The toggle body of a bare payload. */
export function decodeTogglePayload(payload: ArrayLike<number>, reading: CheckboxReading = "pv0655"): DyntToggle | undefined {
  return DyntToggle.fromPayload(Uint8Array.from(payload), reading)
}

/** The function code of a toggle read from `value`, as text. */
export function toggleFunctionCode(toggle: DyntToggle, value: Uint8Array): string | undefined {
  return bytesText(value, toggle.functionCodeRange(value))
}

/** The bytes of `range` of `value` as text (Swift `String(decoding:as: UTF8.self)`). */
export function bytesText(value: Uint8Array, range: ByteRange | undefined): string | undefined {
  return range === undefined ? undefined : new TextDecoder().decode(range.of(value))
}

export function encodeToggle(header: DyntAtomHeader, fields: { checked: boolean; visible: number; code?: string; caption: string }): Uint8Array {
  return written(output =>
    DyntToggle.append(
      header,
      { isChecked: fields.checked, visibleLength: fields.visible, functionCode: ascii(fields.code ?? ""), caption: ascii(fields.caption) },
      output
    )
  )
}

export function encodeReturn(header: DyntAtomHeader, fields: { checked: boolean; visible: number; trailingZero?: boolean }): Uint8Array {
  return written(output =>
    DyntToggleReturn.append(header, { isChecked: fields.checked, visibleLength: fields.visible, trailingZero: fields.trailingZero ?? true }, output)
  )
}

export function decodeReturn(value: Uint8Array): DyntToggleReturn | undefined {
  const atom = walkAtoms(value).atoms.at(-1)
  return atom === undefined ? undefined : DyntToggleReturn.fromAtom(atom, value)
}

export function decodeReturnPayload(payload: ArrayLike<number>): DyntToggleReturn | undefined {
  return DyntToggleReturn.fromPayload(Uint8Array.from(payload))
}

export function encodeCombobox(header: DyntAtomHeader, fields: { mlen: number; maxNrChars: number; key: string; flag1?: number }): Uint8Array {
  return written(output =>
    DyntCombobox.append(header, { flag1: fields.flag1 ?? 0, mlen: fields.mlen, maxNrChars: fields.maxNrChars, selectedKey: ascii(fields.key) }, output)
  )
}

export function decodeCombobox(value: Uint8Array, reading: DropdownReading = "zzValueList"): DyntCombobox | undefined {
  const atom = walkAtoms(value).atoms[0]
  return atom === undefined ? undefined : DyntCombobox.fromAtom(atom, value, reading)
}

export function encodeTab(
  header: DyntAtomHeader,
  fields: { vLength: number; pageID: number; caption: string; code: string; short: string; fieldName: string | undefined; active: boolean }
): Uint8Array {
  return written(output =>
    TabstripButtons.appendTab(
      header,
      {
        vLength: fields.vLength,
        vHeight: 1,
        pageID: fields.pageID,
        caption: ascii(fields.caption),
        functionCode: ascii(fields.code),
        shortName: ascii(fields.short),
        fieldName: fields.fieldName === undefined ? undefined : ascii(fields.fieldName),
        isActive: fields.active
      },
      output
    )
  )
}

export function decodeTabs(value: Uint8Array, reading: TabstripReading = "serverPaged"): TabstripButtons | undefined {
  return TabstripButtons.fromValue(value, reading)
}

export function decodeRowRecord(value: ArrayLike<number>): TableRowRecord {
  return TableRowRecord.decode(Uint8Array.from(value))
}

export function decodeWindowState(value: ArrayLike<number>): ListWindowState {
  return ListWindowState.decode(Uint8Array.from(value))
}

export function appendRun(row: number, column: number, style: ListRunStyle, text: string, output: ByteWriter): void {
  ListRun.append(row, column, style, text, output)
}

export function listRuns(items: Uint8Array): { runs: ListRun[]; walker: ListRunWalker } {
  return ListRunWalker.runs(items)
}

export function encodeMessage(type: StatusMessageType, messageClass: string, number: string, text: string): Uint8Array {
  return written(output => StatusMessageValue.append({ type, messageClass: ascii(messageClass), number: ascii(number), text: ascii(text) }, output))
}

export function encodeMessageItem(type: StatusMessageType, messageClass: string, number: string, text: string): Uint8Array {
  return written(output => StatusMessageValue.appendItem({ type, messageClass: ascii(messageClass), number: ascii(number), text: ascii(text) }, output))
}

export function decodeMessage(value: ArrayLike<number>): StatusMessageValue {
  return StatusMessageValue.decode(Uint8Array.from(value))
}

/** A header in the main area, block 1. */
export function elementHeader(
  etype: DyntElementType,
  row: number,
  col: number,
  options: { attributes?: DyntAttributes; area?: number; block?: number; group?: number; flags?: [number, number] } = {}
): DyntAtomHeader {
  const [flag1, flag2] = options.flags ?? [0, 0]
  return new DyntAtomHeader({
    etype,
    dialogFlags: new DyntDialogFlags({ flag1, flag2 }),
    area: options.area ?? 0,
    block: options.block ?? 1,
    group: options.group ?? 0,
    row,
    col,
    attributes: options.attributes ?? 0
  })
}
