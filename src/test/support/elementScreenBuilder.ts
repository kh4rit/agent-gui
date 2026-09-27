// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ElementScreenBuilder.swift (MIT).

// Builders of the screen-element tests (docs/protocol/elements.md): item sequences written with
// DiagCodec's encoders, the same ones the fake server uses, so that every test is a round trip
// encoder → ScreenModel decoder. Every text, field name and code is invented (D15, docs/testing.md
// §8).
//
// Swift's `var bytes: [UInt8]` of `ElementItems` and `ElementAtoms` is `writer`, a `ByteWriter` the
// codec's encoders append to (Swift's `to: &items.bytes` is `items.writer`), and the getter `bytes`,
// a copy of what was written. Swift's labelled parameters are an options object, the caption or
// text last, as Swift's unlabelled last parameter. Swift's `extension Screen`
// (`element(row:column:area:kind:)`) is `elementAt`.

import assert from "node:assert/strict"
import {
  ApplItem,
  ContainerGeometry,
  ContainerName,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntAtoms,
  DyntAttributes,
  DyntButtonStrings,
  DyntCombobox,
  DyntDialogFlags,
  DyntElementType,
  DyntFocus,
  DyntToggle,
  DyntToggleReturn,
  ListRun,
  ListRunStyle,
  ScreenText,
  SimpleItemValue,
  StatusMessageValue,
  TableScrollState,
  TabstripButtons,
  UIEventFunctionKey,
  type ApplSIDContainer,
  type ByteRange,
  type ClientInputStep,
  type DyntAtom,
  type KnownDyntElementKind,
  type ListRunFlags,
  type ListWindowState,
  type SESValue,
  type StatusMessageType,
  type ZZValueList
} from "../../diag/codec/index.js"
import { Screen, ScreenElementKind, type ScreenElement, type ScreenReadings } from "../../diag/screen/index.js"
import { ByteWriter } from "../../diag/wire/index.js"

/** UTF-8 bytes of an invented text (Swift `Array(text.utf8)`). */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** An element type by kind (Swift `.efield2`). */
const etype = (kind: KnownDyntElementKind): DyntElementType => DyntElementType.of(kind)

/** An item sequence, built item by item. */
export class ElementItems {
  /** What the items were written to (Swift's `bytes`, which encoders append to). */
  readonly writer = new ByteWriter()

  /** A copy of the items written so far. */
  get bytes(): Uint8Array {
    return this.writer.toBytes()
  }

  text(item: ApplItem, value: string): void {
    ScreenText.appendItem(item, utf8(value), this.writer)
  }

  container(sid: ApplSIDContainer, geometry: { id: number; row: number; col: number; width: number; height: number }): void {
    const value = new ByteWriter()
    new ContainerGeometry({ containerID: geometry.id, row: geometry.row, col: geometry.col, width: geometry.width, height: geometry.height }).append(value)
    DiagItemEncoder.appendAPPL(ApplItem.container(sid), value.toBytes(), this.writer)
  }

  reset(): void {
    this.container("reset", { id: 0, row: 0, col: 0, width: 0, height: 0 })
  }

  containerName(subscreen: string, container: string, subdynpro: string): void {
    const value = new ByteWriter()
    ContainerName.append(utf8(subscreen), utf8(container), utf8(subdynpro), value)
    DiagItemEncoder.appendAPPL(ApplItem.container("containerName"), value.toBytes(), this.writer)
  }

  scrollInfos(state: { total: number; first: number; visible: number; totalWidth: number; viewport: number }): void {
    const value = new ByteWriter()
    new TableScrollState({
      totalRows: state.total,
      firstRow: state.first,
      visibleRows: state.visible,
      totalWidth: state.totalWidth,
      viewportWidth: state.viewport
    }).scrollInfos.append(value)
    DiagItemEncoder.appendAPPL(ApplItem.varInfo("scrollInfos"), value.toBytes(), this.writer)
  }

  atoms(atoms: ElementAtoms): void {
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), atoms.bytes, this.writer)
  }

  tabs(atoms: ElementAtoms): void {
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("tabstripButtons"), atoms.bytes, this.writer)
  }

  ses(value: SESValue): void {
    SimpleItemValue.appendItem(SimpleItemValue.ses(value), this.writer)
  }

  message(type: StatusMessageType, text: string, options: { messageClass?: string; number?: string } = {}): void {
    StatusMessageValue.appendItem(
      { type, messageClass: utf8(options.messageClass ?? "ZZQUACK"), number: utf8(options.number ?? "042"), text: utf8(text) },
      this.writer
    )
  }

  raw(item: ApplItem, value: ArrayLike<number>): void {
    DiagItemEncoder.appendAPPL(item, Uint8Array.from(value), this.writer)
  }

  focus(position: { row: number; col: number; colOffset?: number; containers?: number[] }): void {
    const value = new ByteWriter()
    DyntFocus.append(
      { areaID: 1, row: position.row, col: position.col, rowOffset: 0, colOffset: position.colOffset ?? 0, containerIDs: Uint8Array.from(position.containers ?? [0]) },
      value
    )
    DiagItemEncoder.appendAPPL(ApplItem.dynt("focus1"), value.toBytes(), this.writer)
  }

  run(row: number, column: number, text: string, style: { color?: number; flags?: ListRunFlags } = {}): void {
    ListRun.append(row, column, new ListRunStyle({ color: style.color ?? 2, flags: style.flags ?? 0 }), text, this.writer)
  }

  window(state: ListWindowState | undefined): void {
    assert.ok(state !== undefined, "a window state")
    state.appendItem(this.writer)
  }

  /** The window state as a plain CHL simple item (Reading R-EL-21). */
  plainWindow(state: ListWindowState | undefined): void {
    assert.ok(state !== undefined, "a window state")
    state.appendPlainItem(this.writer)
  }

  screen(readings?: ScreenReadings): Screen {
    return Screen.fromItems(this.bytes, { readings })
  }
}

/** Where an atom sits: Swift's `area:block:group:row:col:` parameters (area 0, block 1, group 0 unless given). */
export interface AtomPlace {
  area?: number
  block?: number
  group?: number
  row: number
  col: number
}

/** The atoms of one DYNT_ATOM or DYNT_TABSTRIP_BUTTONS item. */
export class ElementAtoms {
  /** What the atoms were written to (Swift's `bytes`, which encoders append to). */
  readonly writer = new ByteWriter()

  /** A copy of the atoms written so far. */
  get bytes(): Uint8Array {
    return this.writer.toBytes()
  }

  static header(type: DyntElementType, place: AtomPlace & { attributes?: DyntAttributes; flags?: [number, number] }): DyntAtomHeader {
    const [flag1, flag2] = place.flags ?? [0, 0]
    return new DyntAtomHeader({
      etype: type,
      dialogFlags: new DyntDialogFlags({ flag1, flag2 }),
      area: place.area ?? 0,
      block: place.block ?? 1,
      group: place.group ?? 0,
      row: place.row,
      col: place.col,
      attributes: place.attributes ?? 0
    })
  }

  field(
    type: DyntElementType,
    field: Omit<AtomPlace, "group"> & { attributes?: DyntAttributes; flags?: [number, number]; flag1?: number; mlen: number; maxNrChars?: number },
    text = ""
  ): void {
    const bytes = utf8(text)
    DyntAtomEncoder.appendField(
      ElementAtoms.header(type, { area: field.area, block: field.block, row: field.row, col: field.col, attributes: field.attributes, flags: field.flags }),
      { flag1: field.flag1 ?? 0, mlen: field.mlen, maxNrChars: field.maxNrChars ?? Math.max(bytes.length, field.mlen), text: bytes },
      this.writer
    )
  }

  label(place: Omit<AtomPlace, "group"> & { mlen: number }, text: string): void {
    this.field(etype("keyword2"), { ...place, attributes: DyntAttributes.protected | DyntAttributes.propFont }, text)
  }

  input(place: Omit<AtomPlace, "group"> & { mlen: number; attributes?: DyntAttributes; flag1?: number }, text = ""): void {
    this.field(etype("efield2"), { ...place, attributes: place.attributes ?? DyntAttributes.yes3D, flag1: place.flag1 ?? 0 }, text)
  }

  output(place: Omit<AtomPlace, "group"> & { mlen: number }, text: string): void {
    this.field(etype("ofield2"), { ...place, attributes: DyntAttributes.protected }, text)
  }

  child(type: DyntElementType, place: AtomPlace, text: string): void {
    DyntAtomEncoder.appendText(ElementAtoms.header(type, place), utf8(text), this.writer)
  }

  toggle(
    toggle: AtomPlace & {
      etype?: DyntElementType
      attributes?: DyntAttributes
      flags?: [number, number]
      checked: boolean
      visible: number
      code?: string
    },
    caption: string
  ): void {
    DyntToggle.append(
      ElementAtoms.header(toggle.etype ?? etype("checkbutton3"), toggle),
      { isChecked: toggle.checked, visibleLength: toggle.visible, functionCode: utf8(toggle.code ?? ""), caption: utf8(caption) },
      this.writer
    )
  }

  /** A radio button of R-EL-2: etype 129, group byte 1, 0x80 on the selected one, an FNAME. */
  radio(radio: { block: number; row: number; col: number; selected: boolean; fname: string }, caption: string): void {
    this.toggle(
      {
        etype: etype("radiobutton3"),
        block: radio.block,
        group: DyntToggle.radioGroupByte,
        row: radio.row,
        col: radio.col,
        flags: [0, radio.selected ? DyntToggle.selectedRadioFlag : 0],
        checked: radio.selected,
        visible: caption.length
      },
      caption
    )
    this.child(etype("fname"), { block: radio.block, group: DyntToggle.radioGroupByte, row: radio.row, col: radio.col }, radio.fname)
  }

  /** A dropdown of R-EL-3: etype 126, the `_2` body with the key, FNAME and XMLPROP children. */
  dropdown(dropdown: {
    area?: number
    block?: number
    row: number
    col: number
    mlen: number
    flag1?: number
    attributes?: DyntAttributes
    key: string
    list: ZZValueList | undefined
    tooltip?: string
    fname?: string
  }): void {
    const list = dropdown.list
    const longest = list === undefined ? utf8(dropdown.key).length : Math.max(...list.values.map(value => utf8(value.key).length))
    const place = { area: dropdown.area, block: dropdown.block, row: dropdown.row, col: dropdown.col }
    DyntCombobox.append(
      ElementAtoms.header(etype("combobox1"), { ...place, attributes: dropdown.attributes ?? DyntCombobox.attributes }),
      { flag1: dropdown.flag1 ?? 0, mlen: dropdown.mlen, maxNrChars: longest, selectedKey: utf8(dropdown.key) },
      this.writer
    )
    this.child(etype("fname"), place, dropdown.fname ?? "ZZDUCK-SPECIES")
    if (list !== undefined) {
      this.child(etype("xmlprop"), place, list.propertyText(dropdown.tooltip))
    } else if (dropdown.tooltip !== undefined) {
      this.child(etype("xmlprop"), place, `<Propertybag><DefaultTooltip>${dropdown.tooltip}</DefaultTooltip></Propertybag>`)
    }
  }

  tab(tab: { area: number; col: number; page: number; code: string; active?: boolean; attributes?: DyntAttributes }, caption: string): void {
    TabstripButtons.appendTab(
      ElementAtoms.header(etype("tabstripButton"), { area: tab.area, block: 1, row: 0, col: tab.col, attributes: tab.attributes }),
      {
        vLength: caption.length,
        vHeight: 1,
        pageID: tab.page,
        caption: utf8(caption),
        functionCode: utf8(tab.code),
        shortName: utf8(`ZZT${tab.page}`),
        fieldName: utf8(`ZZTAB-${tab.page}`),
        isActive: tab.active ?? false
      },
      this.writer
    )
  }

  button(button: { row: number; col: number; code: string; attributes?: DyntAttributes }, caption: string): void {
    DyntButtonStrings.appendPushButton(
      ElementAtoms.header(etype("pushbutton2"), { row: button.row, col: button.col, attributes: button.attributes }),
      { vLength: caption.length, vHeight: 1, text: utf8(caption), functionCode: utf8(button.code) },
      this.writer
    )
  }
}

/**
 * The element at the received row and column, of `kind` when given (Swift's `extension Screen`,
 * `screen.element(row:column:area:kind:)`); fails the test when there is none.
 */
export function elementAt(screen: Screen, row: number, column: number, options: { area?: number; kind?: ScreenElementKind } = {}): ScreenElement {
  const area = options.area ?? 0
  const element = screen.elements.find(
    candidate =>
      candidate.row === row &&
      candidate.column === column &&
      candidate.atom.area === area &&
      (options.kind === undefined || ScreenElementKind.equals(candidate.kind, options.kind))
  )
  assert.ok(element !== undefined, `an element at r${row} c${column} a${area}`)
  return element
}

/** The value of the step's DYNT_ATOM item, or undefined when it has none (Swift `Fixtures.atomValue(_:)`). */
export function atomValue(step: ClientInputStep): Uint8Array | undefined {
  for (const item of step.items) if (item.kind === "dyntAtom") return item.value
  return undefined
}

/** The decoded atoms of a step's DYNT_ATOM item, with the value they point into. */
export class ReturnedAtoms {
  readonly atoms: DyntAtom[]
  readonly value: Uint8Array

  constructor(step: ClientInputStep) {
    const value = atomValue(step)
    assert.ok(value !== undefined, "the step has a DYNT_ATOM item")
    const walk = DyntAtoms.walk(value)
    assert.equal(walk.error, undefined)
    this.atoms = walk.atoms
    this.value = value
  }

  /** The payload bytes of atom `index`. */
  payload(index: number): Uint8Array {
    return this.atoms[index].contentRange.of(this.value).slice()
  }

  /** The returned toggle of atom `index`. */
  toggle(index: number): DyntToggleReturn | undefined {
    return DyntToggleReturn.fromAtom(this.atoms[index], this.value)
  }

  /** The returned dropdown body of atom `index`. */
  dropdown(index: number): DyntCombobox | undefined {
    return DyntCombobox.fromAtom(this.atoms[index], this.value)
  }

  /** The text of `range` in the value. */
  text(range: ByteRange): string {
    return new TextDecoder().decode(range.of(this.value))
  }
}

/** The UI_EVENT_SOURCE of a step, decoded: the function number, the cursor and the container ids. */
export class FiredEvent {
  readonly number: number
  readonly row: number
  readonly col: number
  readonly containers: number[]

  constructor(step: ClientInputStep) {
    const value = step.uiEvent
    assert.ok(value !== undefined, "the step fires a UI event")
    const event = UIEventFunctionKey.decode(value)
    this.number = event.functionNumber
    this.row = event.controlRow
    this.col = event.controlCol
    this.containers = Array.from(event.containerIDs.of(value))
  }
}
