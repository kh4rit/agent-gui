// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DyntElements.swift (MIT).

// Screen elements carried by DYNT atoms (docs/protocol/elements.md §3–§5 and §11): checkboxes and
// radio buttons (Readings R-EL-1, R-EL-2, R-EL-4), dropdowns (R-EL-3), tabstrip buttons (R-EL-5),
// field markers (R-EL-16) and the cursor's container ids (R-EL-17). Each Reading has one encoder
// and decoder pair here, which the fake server and the client share, and a switch whose fallback
// is what Swooey did before elements.md.
//
// The atom walker is unchanged: these types read an atom's payload on demand, as
// DyntButtonStrings.swift does, and a payload that does not fit its Reading gives undefined, so the
// element stays what the walker made of it (opaque, or a plain field).
//
// This file's `extension CodecSpecGap` (toggleElements … fieldMarkers) is in diagCodec.ts, with
// the rest of `CodecSpecGap`.

import { ByteWriter, WireBytes } from "../wire/index.js"
import { ByteRange, INT_MAX, isUInt16, isUInt8 } from "./diagCodec.js"
import {
  DyntAttributes,
  DyntDialogFlags,
  DyntAtomHeader,
  DyntAtomLayout,
  DyntElementType,
  DyntPayloadLayout,
  type DyntAtom,
  type DyntField,
  type DyntTabstripButton
} from "./dyntAtom.js"
import { DyntAtomEncoder, DyntAtomEncodingError } from "./dyntAtomEncoder.js"
import { DyntAtoms, DyntPayloadDecoder, type DyntAtomWalkError } from "./dyntAtomWalker.js"

/** The kind of the table entry an element type's byte names (Swift `DyntElementType(rawValue: etype.rawValue)`). */
function canonical(etype: DyntElementType): DyntElementType["kind"] {
  return DyntElementType.fromRaw(DyntElementType.rawValue(etype)).kind
}

// MARK: - Checkboxes and radio buttons

/**
 * How the body of a checkbox or radio atom is read (elements.md Reading R-EL-1, #107).
 * - `pv0655`: the default: PV-0655's body (state, visible length, event id offset and length, text
 *   offset and length, then the event id and the caption), accepted when `10 + event_id_len +
 *   text_length` is the payload's length (elements.md §3.2).
 * - `odgSplit`: open-diag-go's reading: a one-byte text count at payload offset 9 and the text from
 *   offset 10, accepted only when it fills the payload (so only where event_id_len is 0); no
 *   function.
 * - `specGap`: the fallback: the body stays opaque, as before elements.md.
 */
export type CheckboxReading = "pv0655" | "odgSplit" | "specGap"
export const CheckboxReading = { allCases: ["pv0655", "odgSplit", "specGap"] as readonly CheckboxReading[] } as const

/**
 * How radio buttons are grouped (elements.md Reading R-EL-2, #107).
 * - `areaBlockGroup`: the default: one group per (area, block, group byte) (PV-0962).
 * - `sharedFieldName`: open-diag-go's builder: the buttons that share an FNAME.
 * - `specGap`: the fallback: radio buttons stay ungrouped elements, as before elements.md.
 */
export type RadioGroupReading = "areaBlockGroup" | "sharedFieldName" | "specGap"
export const RadioGroupReading = { allCases: ["areaBlockGroup", "sharedFieldName", "specGap"] as readonly RadioGroupReading[] } as const

/**
 * The two families of toggle etypes (PV-0630): checkboxes 104, 118, 124, 128 and radio buttons
 * 105, 119, 125, 129.
 */
export type DyntToggleKind = "checkbox" | "radioButton"

export const DyntToggleKind = {
  allCases: ["checkbox", "radioButton"] as readonly DyntToggleKind[],

  /** The family of `etype`, or undefined for any other element type (Swift `init?(_:)`). */
  of(etype: DyntElementType): DyntToggleKind | undefined {
    switch (canonical(etype)) {
      case "checkbutton1":
      case "checkbutton2":
      case "checkbutton3":
      case "checkbutton4":
        return "checkbox"
      case "radiobutton0":
      case "radiobutton1":
      case "radiobutton__0":
      case "radiobutton3":
        return "radioButton"
      default:
        return undefined
    }
  },

  /**
   * The etype a real server uses for the family, and the fake server sends (PV-0960): 128 for a
   * checkbox, 129 for a radio button.
   */
  serverElementType(kind: DyntToggleKind): DyntElementType {
    return DyntElementType.of(kind === "checkbox" ? "checkbutton3" : "radiobutton3")
  }
} as const

/** The fields of a toggle atom for `DyntToggle.append`. */
export interface DyntToggleContent {
  isChecked: boolean
  visibleLength: number
  functionCode: Uint8Array
  caption: Uint8Array
}

/**
 * The body of a checkbox or radio atom as the server sends it (elements.md Readings R-EL-1 and
 * R-EL-2): the state byte, the visible length, then the event id and the caption in PV-0655's
 * layout. Ranges are offsets into the bytes the toggle was read from.
 */
export class DyntToggle {
  /** The state byte of a checked checkbox or selected radio button: `X` (PV-0961). */
  static readonly checkedState = 0x58 // provenance: PV-0961
  /** The state byte otherwise: a space (PV-0961). */
  static readonly uncheckedState = 0x20 // provenance: PV-0961
  /** dlg_flag_2 bit on the selected radio button (PV-0964). */
  static readonly selectedRadioFlag = 0x80 // provenance: PV-0964
  /** The group byte of radio atoms and their children (PV-0962). */
  static readonly radioGroupByte = 0x01 // provenance: PV-0962
  /** An event id that starts with this byte is a function code the element fires (R-EL-1). */
  static readonly functionCodePrefix = 0x3d // not-protocol: ASCII "="
  /** open-diag-go's one-byte text count: the low byte of PV-0655's text_length (elements.md §3.2). */
  static readonly odgTextCountOffset = DyntPayloadLayout.radioTextLength + 1 // provenance: PV-0961

  /** The state byte, `checkedState` or `uncheckedState`. */
  readonly stateByte: number
  /** visible_label_length (PV-0655): the element's cells. */
  readonly visibleLength: number
  /** The event id's bytes; empty when event_id_len is 0 or under `odgSplit`. */
  readonly eventIDRange: ByteRange
  /** The caption's bytes, without padding removed. */
  readonly captionRange: ByteRange

  constructor(fields: { stateByte: number; visibleLength: number; eventIDRange: ByteRange; captionRange: ByteRange }) {
    this.stateByte = fields.stateByte
    this.visibleLength = fields.visibleLength
    this.eventIDRange = fields.eventIDRange
    this.captionRange = fields.captionRange
  }

  /** Whether the checkbox is checked or the radio button selected. */
  get isChecked(): boolean {
    return this.stateByte === DyntToggle.checkedState
  }

  /**
   * The body of an atom payload (the bytes after the 13-byte header) under `reading`; undefined when
   * the payload does not fit it or the reading is `specGap`. Ranges are offsets into `payload`.
   * (Swift `init?(payload:reading:)`.)
   */
  static fromPayload(payload: Uint8Array, reading: CheckboxReading = "pv0655"): DyntToggle | undefined {
    return DyntToggle.read(payload, new ByteRange(0, payload.length), reading)
  }

  /**
   * The body of `atom`, a checkbox or radio atom walked in `value` (the item value); undefined for
   * another element type or a payload that does not fit `reading`. Ranges are offsets into `value`.
   * (Swift `init?(atom:in:reading:)`.)
   */
  static fromAtom(atom: DyntAtom, value: Uint8Array, reading: CheckboxReading = "pv0655"): DyntToggle | undefined {
    if (DyntToggleKind.of(atom.etype) === undefined || !(atom.endOffset <= value.length)) return undefined
    return DyntToggle.read(value, atom.contentRange, reading)
  }

  private static read(value: Uint8Array, content: ByteRange, reading: CheckboxReading): DyntToggle | undefined {
    const fixed = DyntPayloadLayout.radioFixedSize
    if (!(content.count >= fixed)) return undefined
    const base = content.lowerBound
    const state = value[base + DyntPayloadLayout.radioButton]
    if (!(state === DyntToggle.checkedState || state === DyntToggle.uncheckedState)) return undefined
    const visible = WireBytes.u16BigEndian(value, base + DyntPayloadLayout.radioVisibleLabelLength) // provenance: PV-0655
    const strings = base + fixed
    let eventIDRange: ByteRange
    let captionRange: ByteRange
    switch (reading) {
      case "specGap":
        return undefined
      case "pv0655": {
        const eventLength = value[base + DyntPayloadLayout.radioEventIDLength]
        const textLength = WireBytes.u16BigEndian(value, base + DyntPayloadLayout.radioTextLength) // provenance: PV-0655
        if (fixed + eventLength + textLength !== content.count) return undefined
        eventIDRange = new ByteRange(strings, strings + eventLength)
        captionRange = new ByteRange(strings + eventLength, content.upperBound)
        break
      }
      case "odgSplit": {
        const count = value[base + DyntToggle.odgTextCountOffset]
        if (fixed + count !== content.count) return undefined
        eventIDRange = new ByteRange(strings, strings)
        captionRange = new ByteRange(strings, content.upperBound)
        break
      }
    }
    return new DyntToggle({ stateByte: state, visibleLength: visible, eventIDRange, captionRange })
  }

  /**
   * The event id when it is a function code (it starts with `=`, R-EL-1): what a change of the
   * element fires in VARINFO OKCODE (R-EL-4). Undefined otherwise.
   */
  functionCodeRange(value: Uint8Array): ByteRange | undefined {
    if (this.eventIDRange.isEmpty || !(this.eventIDRange.upperBound <= value.length) || value[this.eventIDRange.lowerBound] !== DyntToggle.functionCodePrefix)
      return undefined
    return this.eventIDRange
  }

  /**
   * The key radio buttons are grouped by inside their area under `areaBlockGroup` (PV-0962): the
   * block in the high byte, the group byte in the low byte.
   */
  static radioGroupKey(block: number, group: number): number {
    return ((block & 0xff) << 8) | (group & 0xff) // not-protocol: packing two bytes into one key
  }

  /**
   * Appends a checkbox or radio atom in the layout of R-EL-1: the header, the state byte,
   * `visibleLength`, event_id_off 0, event_id_len = `functionCode`'s length, text_off =
   * event_id_len, text_length = `caption`'s length, then the function code and the caption. The
   * header's etype must be a toggle (`DyntToggleKind`); a radio button's group byte and dlg flags
   * are the caller's (`radioGroupByte`, `selectedRadioFlag`). Nothing is appended when it throws.
   */
  static append(header: DyntAtomHeader, toggle: DyntToggleContent, output: ByteWriter): void {
    const { functionCode, caption } = toggle
    if (DyntToggleKind.of(header.etype) === undefined) throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    if (!isUInt8(functionCode.length)) throw new DyntAtomEncodingError({ kind: "textTooLong", length: functionCode.length })
    const eventLength = functionCode.length
    const strings = functionCode.length + caption.length
    // Swift reports a caption beyond the u16 text_length as an atom of `Int.max` bytes.
    if (!isUInt16(caption.length)) throw new DyntAtomEncodingError({ kind: "atomTooLong", length: INT_MAX })
    const textLength = caption.length
    const length = DyntAtomEncoder.atomLength(DyntPayloadLayout.radioFixedSize + strings)
    DyntAtomEncoder.appendHeader(header, length, output)
    output.u8(toggle.isChecked ? DyntToggle.checkedState : DyntToggle.uncheckedState)
    output.u16be(toggle.visibleLength) // provenance: PV-0655
    output.u16be(0) // provenance: PV-0655
    output.u8(eventLength)
    output.u16be(eventLength) // provenance: PV-0655
    output.u16be(textLength) // provenance: PV-0655
    output.bytes(functionCode)
    output.bytes(caption)
  }
}

/**
 * A checkbox or radio atom as the client returns it (elements.md Reading R-EL-4, PV-0963): the new
 * state, the visible length as received, zero offsets and lengths, and, by default, one more zero
 * byte; no caption.
 */
export class DyntToggleReturn {
  /** The state byte (PV-0961). */
  readonly stateByte: number
  /** The visible length as the client received it. */
  readonly visibleLength: number

  constructor(fields: { isChecked: boolean; visibleLength: number }) {
    this.stateByte = fields.isChecked ? DyntToggle.checkedState : DyntToggle.uncheckedState
    this.visibleLength = fields.visibleLength
  }

  get isChecked(): boolean {
    return this.stateByte === DyntToggle.checkedState
  }

  /**
   * The state and visible length of a returned payload. Lenient, as the fake server takes values
   * over by position: the first three bytes must hold a valid state and the length; what follows is
   * not read. Undefined for a shorter payload or another state byte. (Swift `init?(payload:)`.)
   */
  static fromPayload(payload: Uint8Array): DyntToggleReturn | undefined {
    const needed = DyntPayloadLayout.radioEventIDOffset
    if (!(payload.length >= needed)) return undefined
    const state = payload[DyntPayloadLayout.radioButton]
    if (!(state === DyntToggle.checkedState || state === DyntToggle.uncheckedState)) return undefined
    return new DyntToggleReturn({
      isChecked: state === DyntToggle.checkedState,
      visibleLength: WireBytes.u16BigEndian(payload, DyntPayloadLayout.radioVisibleLabelLength) // provenance: PV-0655
    })
  }

  /** The returned value of `atom`, a toggle atom walked in `value` (Swift `init?(atom:in:)`). */
  static fromAtom(atom: DyntAtom, value: Uint8Array): DyntToggleReturn | undefined {
    if (DyntToggleKind.of(atom.etype) === undefined || !(atom.endOffset <= value.length)) return undefined
    return DyntToggleReturn.fromPayload(atom.contentRange.of(value))
  }

  /**
   * Appends the returned atom of R-EL-4: `header` (the received area, block, row, column,
   * attributes and etype, with the dlg flags the envelope gives), the new state, the visible
   * length, six zero bytes (event_id_off, event_id_len, text_off), a zero text_length and, with
   * `trailingZero` (the default), one more zero byte (PV-0963).
   */
  static append(header: DyntAtomHeader, toggle: { isChecked: boolean; visibleLength: number; trailingZero?: boolean }, output: ByteWriter): void {
    if (DyntToggleKind.of(header.etype) === undefined) throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    const payload = DyntPayloadLayout.radioFixedSize + ((toggle.trailingZero ?? true) ? 1 : 0)
    const length = DyntAtomEncoder.atomLength(payload)
    DyntAtomEncoder.appendHeader(header, length, output)
    output.u8(toggle.isChecked ? DyntToggle.checkedState : DyntToggle.uncheckedState)
    output.u16be(toggle.visibleLength) // provenance: PV-0655
    output.repeat(0, payload - DyntPayloadLayout.radioEventIDOffset)
  }
}

/**
 * Whether changed elements are returned at all (Swift `ElementValueReading.Returns`).
 * - `changedAtoms`: the default: every changed checkbox, radio button and dropdown, as its own
 *   etype atom.
 * - `specGap`: the fallback: a step that would return one is refused with the element's gap.
 */
export type ElementValueReadingReturns = "changedAtoms" | "specGap"

/**
 * Which radio buttons of a group go back (Swift `ElementValueReading.Radios`).
 * - `changedButtons`: the default (the TUI clients): the newly selected button and the one it
 *   replaces.
 * - `selectedOnly`: the newly selected button only.
 * - `wholeGroup`: every button of the group.
 */
export type ElementValueReadingRadios = "changedButtons" | "selectedOnly" | "wholeGroup"

/**
 * How an element with a function code fires it (Swift `ElementValueReading.Function`).
 * - `okCode`: the default: the code in VARINFO OKCODE verbatim, with the new state in the same step
 *   (PV-0773).
 * - `stateChangedEvent`: a UI_EVENT_SOURCE STATECHANGED event; not built.
 * - `specGap`: refused with the element's gap.
 */
export type ElementValueReadingFunction = "okCode" | "stateChangedEvent" | "specGap"

/** The fields of an `ElementValueReading`. */
export interface ElementValueReadingFields {
  returns: ElementValueReadingReturns
  radios: ElementValueReadingRadios
  trailingZero: boolean
  function: ElementValueReadingFunction
}

/**
 * What the input step returns for checkboxes, radio buttons and dropdowns (elements.md Reading
 * R-EL-4, #107). An immutable value: a changed reading is `new ElementValueReading({ ...reading,
 * radios: "wholeGroup" })`.
 */
export class ElementValueReading implements ElementValueReadingFields {
  static readonly Returns = { allCases: ["changedAtoms", "specGap"] as readonly ElementValueReadingReturns[] } as const
  static readonly Radios = { allCases: ["changedButtons", "selectedOnly", "wholeGroup"] as readonly ElementValueReadingRadios[] } as const
  static readonly Function = { allCases: ["okCode", "stateChangedEvent", "specGap"] as readonly ElementValueReadingFunction[] } as const

  readonly returns: ElementValueReadingReturns
  readonly radios: ElementValueReadingRadios
  /** Whether a returned toggle ends with one more zero byte (PV-0963). */
  readonly trailingZero: boolean
  readonly function: ElementValueReadingFunction

  constructor(fields: Partial<ElementValueReadingFields> = {}) {
    this.returns = fields.returns ?? "changedAtoms"
    this.radios = fields.radios ?? "changedButtons"
    this.trailingZero = fields.trailingZero ?? true
    this.function = fields.function ?? "okCode"
  }

  /** Every part switched off. */
  static readonly specGap = new ElementValueReading({ returns: "specGap", function: "specGap" })
}

// MARK: - Dropdowns

/**
 * How dropdowns are recognised (elements.md Reading R-EL-3, invented; #108).
 * - `zzValueList`: the default: etype 117 or 126 with a valid `_2` body and an XMLPROP child holding
 *   a `ZZValueList` (`ZZValueList`).
 * - `specGap`: the fallback: etypes 117 and 126 stay opaque, as before elements.md.
 */
export type DropdownReading = "zzValueList" | "specGap"
export const DropdownReading = { allCases: ["zzValueList", "specGap"] as readonly DropdownReading[] } as const

/**
 * A dropdown atom's body (elements.md Reading R-EL-3): etype 117 or 126 carrying the `_2` field
 * body of PV-0651 and PV-0652, whose text is the selected key. Its options are the `ZZValueList` of
 * its XMLPROP child, which the caller reads.
 */
export class DyntCombobox {
  /**
   * The attributes the fake server sends a dropdown with (PV-0626, PV-0627); PROTECTED is added
   * when it is disabled. COMBOSTYLE alone never makes a dropdown (elements.md §4.1).
   */
  static readonly attributes: DyntAttributes = DyntAttributes.yes3D | DyntAttributes.comboStyle

  /** The `_2` field body; its text is the selected key. Ranges are offsets into the item value. */
  readonly field: DyntField

  constructor(field: DyntField) {
    this.field = field
  }

  /**
   * The body of `atom` walked in `value`: etype 117 or 126 with a `_2` body whose dlen fills the
   * rest. Undefined otherwise, or under `specGap`. (Swift `init?(atom:in:reading:)`.)
   */
  static fromAtom(atom: DyntAtom, value: Uint8Array, reading: DropdownReading = "zzValueList"): DyntCombobox | undefined {
    if (reading !== "zzValueList" || !DyntCombobox.isCombobox(atom.etype) || !(atom.endOffset <= value.length)) return undefined
    const payload = DyntPayloadDecoder.field("v2", atom.contentRange, value)
    return payload.kind === "field" ? new DyntCombobox(payload.value) : undefined
  }

  /** COMBOBOX (117) or COMBOBOX_1 (126). */
  static isCombobox(etype: DyntElementType): boolean {
    const kind = canonical(etype)
    return kind === "combobox" || kind === "combobox1"
  }

  /**
   * Appends a dropdown atom: `header` (etype 117 or 126), then the `_2` body with `selectedKey` as
   * its text (dlen = its bytes). `flag1` defaults to 0.
   */
  static append(
    header: DyntAtomHeader,
    combobox: { flag1?: number; mlen: number; maxNrChars: number; selectedKey: Uint8Array },
    output: ByteWriter
  ): void {
    const key = combobox.selectedKey
    if (!DyntCombobox.isCombobox(header.etype)) throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    if (!isUInt8(key.length)) throw new DyntAtomEncodingError({ kind: "textTooLong", length: key.length })
    const length = DyntAtomEncoder.atomLength(DyntPayloadLayout.field2Text + key.length)
    DyntAtomEncoder.appendHeader(header, length, output)
    output.u16be(combobox.flag1 ?? 0) // provenance: PV-0651
    output.u8(key.length)
    output.u8(combobox.mlen)
    output.u16be(combobox.maxNrChars) // provenance: PV-0651
    output.bytes(key)
  }
}

/** One option of a `ZZValueList`: the key the field holds and returns, and the text the user sees (Swift `ZZValueList.Value`). */
export interface ZZValueListValue {
  readonly key: string
  readonly text: string
}

/**
 * The option list of a dropdown in its XMLPROP child (elements.md Reading R-EL-3, invented; the
 * `ZZ` names say so, D15):
 *
 * `<Propertybag>[<DefaultTooltip>…</DefaultTooltip>]<ZZValueList empty="0|1" [function="=CODE"]><ZZValue key="KEY">Text</ZZValue>…</ZZValueList></Propertybag>`
 *
 * Texts and attribute values are XML-escaped. The type works on decoded text: the XMLPROP text in
 * the screen's code page, as `DyntText` gives it.
 */
export class ZZValueList {
  /** The element names; the `ZZ` prefix marks them invented (D15). */
  static readonly listElement = "ZZValueList"
  static readonly valueElement = "ZZValue"

  readonly values: readonly ZZValueListValue[]
  /** `empty="1"`: the dropdown offers an empty entry. */
  readonly allowsEmpty: boolean
  /** `function="=CODE"`: the code a choice fires (R-EL-4). */
  readonly functionCode: string | undefined

  constructor(fields: { values: readonly ZZValueListValue[]; allowsEmpty?: boolean; functionCode?: string }) {
    this.values = fields.values.map(value => ({ key: value.key, text: value.text }))
    this.allowsEmpty = fields.allowsEmpty ?? false
    this.functionCode = fields.functionCode
  }

  /** The `ZZValueList` element, escaped. */
  get xml(): string {
    let text = `<${ZZValueList.listElement} empty="${this.allowsEmpty ? "1" : "0"}"`
    if (this.functionCode !== undefined) text += ` function="${xmlEscaped(this.functionCode)}"`
    text += ">"
    for (const value of this.values)
      text += `<${ZZValueList.valueElement} key="${xmlEscaped(value.key)}">${xmlEscaped(value.text)}</${ZZValueList.valueElement}>`
    return text + `</${ZZValueList.listElement}>`
  }

  /** The whole XMLPROP text: a `Propertybag` with the tooltip, when there is one, and the list. */
  propertyText(tooltip?: string): string {
    const tip = tooltip === undefined ? "" : `<DefaultTooltip>${xmlEscaped(tooltip)}</DefaultTooltip>`
    return `<Propertybag>${tip}${this.xml}</Propertybag>`
  }

  /**
   * The list in an XMLPROP text, or undefined when the text holds no well-formed `ZZValueList`
   * element (a real screen's XMLPROP never does). (Swift `init?(propertyText:)`.)
   */
  static fromPropertyText(text: string): ZZValueList | undefined {
    const scanner = new XMLScanner(text)
    if (!scanner.skip("<" + ZZValueList.listElement)) return undefined
    const attributes = scanner.attributes()
    if (attributes === undefined) return undefined
    const closed = scanner.tagEnd()
    if (closed === undefined) return undefined
    const values: ZZValueListValue[] = []
    if (!closed) {
      for (;;) {
        scanner.skipWhitespace()
        if (scanner.consume("</" + ZZValueList.listElement + ">")) break
        if (!scanner.consume("<" + ZZValueList.valueElement)) return undefined
        const valueAttributes = scanner.attributes()
        const key = valueAttributes?.get("key")
        if (key === undefined || scanner.tagEnd() !== false) return undefined
        const content = scanner.text("</" + ZZValueList.valueElement + ">")
        if (content === undefined) return undefined
        values.push({ key: xmlUnescaped(key), text: xmlUnescaped(content) })
      }
    }
    const functionCode = attributes.get("function")
    return new ZZValueList({
      values,
      allowsEmpty: attributes.get("empty") === "1",
      functionCode: functionCode === undefined ? undefined : xmlUnescaped(functionCode)
    })
  }
}

// XML escaping for the invented property texts (Swift's internal `XMLText`). Characters are
// Unicode scalars here, where Swift compares grapheme clusters: they differ only for a combining
// mark right after `&`, `<`, `>`, a quote or `;`, which no property text of the fake server holds.

function xmlEscaped(text: string): string {
  let result = ""
  for (const character of text) {
    switch (character) {
      case "&":
        result += "&amp;"
        break
      case "<":
        result += "&lt;"
        break
      case ">":
        result += "&gt;"
        break
      case '"':
        result += "&quot;"
        break
      case "'":
        result += "&apos;"
        break
      default:
        result += character
    }
  }
  return result
}

/**
 * `text` with the five predefined entities and numeric references resolved; an unknown or
 * malformed reference stays as it is.
 */
function xmlUnescaped(text: string): string {
  if (!text.includes("&")) return text
  let result = ""
  let rest = text
  for (let ampersand = rest.indexOf("&"); ampersand >= 0; ampersand = rest.indexOf("&")) {
    result += rest.slice(0, ampersand)
    const after = rest.slice(ampersand + 1)
    const semicolon = after.indexOf(";")
    const scalar = semicolon < 0 ? undefined : xmlEntity(after.slice(0, semicolon))
    if (scalar === undefined) {
      result += "&"
      rest = after
      continue
    }
    result += scalar
    rest = after.slice(semicolon + 1)
  }
  return result + rest
}

function xmlEntity(name: string): string | undefined {
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
    default: {
      if (!name.startsWith("#")) return undefined
      const digits = name.slice(1)
      const number =
        digits.startsWith("x") || digits.startsWith("X")
          ? parseUInt32(digits.slice(1), 16) // not-protocol: XML hexadecimal reference
          : parseUInt32(digits, 10) // not-protocol: XML decimal reference
      // Swift `Unicode.Scalar(UInt32)`: no surrogate, nothing above U+10FFFF.
      if (number === undefined || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return undefined
      return String.fromCodePoint(number)
    }
  }
}

/** Swift `UInt32(_:radix:)`: an optional sign, then one or more digits of `radix`; undefined for anything else or above 2^32 − 1. */
function parseUInt32(text: string, radix: number): number | undefined {
  let digits = text
  let negative = false
  if (digits.startsWith("+") || digits.startsWith("-")) {
    negative = digits.startsWith("-")
    digits = digits.slice(1)
  }
  if (digits.length === 0) return undefined
  let value = 0
  for (const character of digits) {
    const digit = /^[0-9A-Za-z]$/.test(character) ? parseInt(character, 36) : Number.NaN
    if (Number.isNaN(digit) || digit >= radix) return undefined
    value = value * radix + digit
    if (value > 0xffffffff) return undefined
  }
  // A negative number fits an unsigned type only when it is zero.
  if (negative && value !== 0) return undefined
  return value
}

const WHITESPACE = /^\p{White_Space}$/u

/**
 * A small scanner for the invented property texts: tags, quoted attributes, text up to a closing
 * tag. Not a general XML parser. It works on Unicode scalars (Swift's internal `XMLScanner`).
 */
class XMLScanner {
  private readonly scalars: string[]
  private index = 0

  constructor(text: string) {
    this.scalars = Array.from(text)
  }

  private isWhitespace(position: number): boolean {
    return WHITESPACE.test(this.scalars[position])
  }

  private hasPrefix(prefix: string): boolean {
    let position = this.index
    for (const scalar of prefix) {
      if (!(position < this.scalars.length && this.scalars[position] === scalar)) return false
      position += 1
    }
    return true
  }

  /** Moves past `prefix` when the text continues with it. */
  consume(prefix: string): boolean {
    if (!this.hasPrefix(prefix)) return false
    this.index += Array.from(prefix).length
    return true
  }

  /** Moves past the first occurrence of `tag` that is followed by whitespace, `>` or `/`. */
  skip(tag: string): boolean {
    const length = Array.from(tag).length
    while (this.index < this.scalars.length) {
      if (this.hasPrefix(tag)) {
        const next = this.index + length
        if (next < this.scalars.length && (this.scalars[next] === ">" || this.scalars[next] === "/" || this.isWhitespace(next))) {
          this.index = next
          return true
        }
      }
      this.index += 1
    }
    return false
  }

  skipWhitespace(): void {
    while (this.index < this.scalars.length && this.isWhitespace(this.index)) this.index += 1
  }

  /** The attributes up to the tag's end, which it does not consume; undefined when one is malformed. */
  attributes(): Map<string, string> | undefined {
    const result = new Map<string, string>()
    const scalars = this.scalars
    for (;;) {
      this.skipWhitespace()
      if (!(this.index < scalars.length)) return undefined
      if (scalars[this.index] === ">" || scalars[this.index] === "/") return result
      let name = ""
      while (
        this.index < scalars.length &&
        scalars[this.index] !== "=" &&
        !this.isWhitespace(this.index) &&
        scalars[this.index] !== ">" &&
        scalars[this.index] !== "/"
      ) {
        name += scalars[this.index]
        this.index += 1
      }
      this.skipWhitespace()
      if (name === "" || !this.consume("=") || !(this.index < scalars.length)) return undefined
      this.skipWhitespace()
      if (!(this.index < scalars.length)) return undefined
      const quote = scalars[this.index]
      if (!(quote === '"' || quote === "'")) return undefined
      this.index += 1
      let value = ""
      while (this.index < scalars.length && scalars[this.index] !== quote) {
        value += scalars[this.index]
        this.index += 1
      }
      if (!(this.index < scalars.length)) return undefined
      this.index += 1
      result.set(name, value)
    }
  }

  /**
   * Consumes `>` (returns false: the element has content) or `/>` (returns true: it is empty);
   * undefined for anything else.
   */
  tagEnd(): boolean | undefined {
    if (this.consume(">")) return false
    if (this.consume("/>")) return true
    return undefined
  }

  /** The text up to `closing`, consuming both; undefined when `closing` never comes or a `<` comes first. */
  text(closing: string): string | undefined {
    let result = ""
    while (this.index < this.scalars.length) {
      if (this.consume(closing)) return result
      if (this.scalars[this.index] === "<") return undefined
      result += this.scalars[this.index]
      this.index += 1
    }
    return undefined
  }
}

// MARK: - Tabstrips

/**
 * How tabstrips are read (elements.md Reading R-EL-5, #109).
 * - `serverPaged`: the default: the server pages; only the active page's atoms come (R-EL-5).
 * - `specGap`: the fallback: tabs stay plain elements, as before elements.md.
 */
export type TabstripReading = "serverPaged" | "specGap"
export const TabstripReading = { allCases: ["serverPaged", "specGap"] as readonly TabstripReading[] } as const

/** One tab of a `TabstripButtons` (Swift `TabstripButtons.Tab`). */
export class TabstripButtonsTab {
  /** The 116 atom. */
  readonly atom: DyntAtom
  /** Its payload: the caption, the function code and the short name (PV-0656). */
  readonly button: DyntTabstripButton
  /** The FNAME child's text, when one follows. */
  readonly fieldNameRange: ByteRange | undefined

  constructor(fields: { atom: DyntAtom; button: DyntTabstripButton; fieldNameRange: ByteRange | undefined }) {
    this.atom = fields.atom
    this.button = fields.button
    this.fieldNameRange = fields.fieldNameRange
  }

  /** dlg_flag_1 0x40 (PV-0966). */
  get isActive(): boolean {
    return (this.atom.dialogFlags.flag1 & TabstripButtons.activeTabFlag) !== 0
  }

  /** PROTECTED on a tab: disabled (elements.md Reading R-EL-19, invented). */
  get isDisabled(): boolean {
    return (this.atom.attributes & DyntAttributes.protected) !== 0
  }

  /**
   * Whether the three offsets point at the three strings, counted from the atom's first byte
   * (PV-0965): open-diag-go's and the sequential reading then agree.
   */
  get offsetsCountFromAtomStart(): boolean {
    const { button, atom } = this
    return (
      button.textOffset === button.textRange.lowerBound - atom.offset &&
      button.functionCodeOffset === button.functionCodeRange.lowerBound - atom.offset &&
      button.idOffset === button.idRange.lowerBound - atom.offset
    )
  }
}

/** The fields of one tab for `TabstripButtons.appendTab`. */
export interface TabstripTabContent {
  vLength: number
  vHeight: number
  pageID: number
  caption: Uint8Array
  functionCode: Uint8Array
  shortName: Uint8Array
  /** The FNAME child's text, or undefined for a tab without one. */
  fieldName: Uint8Array | undefined
  isActive: boolean
}

/**
 * The tabs of one DYNT_TABSTRIP_BUTTONS item (09/10): pairs of a 116 atom and its FNAME child
 * (PV-0965), the active one marked with dlg_flag_1 0x40 (PV-0966). Ranges are offsets into the item
 * value.
 */
export class TabstripButtons {
  /** dlg_flag_1 bit of the active tab (PV-0966). */
  static readonly activeTabFlag = 0x40 // provenance: PV-0966
  /**
   * The offset of a tab's first string from the atom's first byte: the header and the nine fixed
   * bytes (PV-0656, PV-0965).
   */
  static readonly stringsAtomOffset = DyntAtomLayout.headerSize + DyntPayloadLayout.tabStrings // provenance: PV-0965

  /** The tabs in item order. */
  readonly tabs: readonly TabstripButtonsTab[]
  /** The atom walk's error, if it stopped; the tabs before it count. */
  readonly walkError: DyntAtomWalkError | undefined

  constructor(fields: { tabs: readonly TabstripButtonsTab[]; walkError?: DyntAtomWalkError }) {
    this.tabs = fields.tabs
    this.walkError = fields.walkError
  }

  /**
   * The tabs of a 09/10 item value; undefined under `specGap`. Atoms that are not tabs, and tabs
   * whose payload does not decode, are skipped. (Swift `init?(value:reading:)`.)
   */
  static fromValue(value: Uint8Array, reading: TabstripReading = "serverPaged"): TabstripButtons | undefined {
    if (reading !== "serverPaged") return undefined
    const walk = DyntAtoms.walk(value)
    const tabs: TabstripButtonsTab[] = []
    for (const atom of walk.atoms) {
      if (atom.payload.kind === "tabstripButton") {
        tabs.push(new TabstripButtonsTab({ atom, button: atom.payload.value, fieldNameRange: undefined }))
        continue
      }
      const last = tabs.at(-1)
      if (
        atom.etype.kind === "fname" &&
        atom.parentIndex !== undefined &&
        last !== undefined &&
        last.atom.index === atom.parentIndex &&
        last.fieldNameRange === undefined &&
        atom.payload.kind === "text"
      )
        tabs[tabs.length - 1] = new TabstripButtonsTab({ atom: last.atom, button: last.button, fieldNameRange: atom.payload.value })
    }
    return new TabstripButtons({ tabs, walkError: walk.error })
  }

  /** The index of the first active tab of `area`'s tabs, or undefined when none is marked (Swift `activeIndex(inArea:)`). */
  activeIndex(area: number): number | undefined {
    const index = this.tabsInArea(area).findIndex(tab => tab.isActive)
    return index < 0 ? undefined : index
  }

  /** The tabs whose atoms name `area` (the TABSTRIP container, R-EL-5) (Swift `tabs(inArea:)`). */
  tabsInArea(area: number): TabstripButtonsTab[] {
    return this.tabs.filter(tab => tab.atom.area === area)
  }

  /**
   * Appends one tab of R-EL-5: a 116 atom with the caption, the function code and the short name,
   * in that order, each followed by a zero byte, the offsets counted from the atom's first byte
   * (PV-0965), dlg_flag_1 0x40 added when `isActive`; then, when `fieldName` is given, its FNAME
   * child at the same place. Nothing is appended when it throws.
   */
  static appendTab(header: DyntAtomHeader, tab: TabstripTabContent, output: ByteWriter): void {
    if (canonical(header.etype) !== "tabstripButton") throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    // Each string ends with its zero byte; the total is checked against atom_length first so that
    // the offsets fit their u16 fields.
    const total = TabstripButtons.stringsAtomOffset + tab.caption.length + tab.functionCode.length + tab.shortName.length + 3 // not-protocol: three terminators
    if (!(total <= 0xffff)) throw new DyntAtomEncodingError({ kind: "atomTooLong", length: total })
    const textOffset = TabstripButtons.stringsAtomOffset
    const codeOffset = textOffset + tab.caption.length + 1
    const idOffset = codeOffset + tab.functionCode.length + 1
    const flags = header.dialogFlags
    const tabHeader = new DyntAtomHeader({
      ...header,
      dialogFlags: new DyntDialogFlags({ flag1: tab.isActive ? flags.flag1 | TabstripButtons.activeTabFlag : flags.flag1, flag2: flags.flag2 })
    })
    const bytes = new ByteWriter()
    DyntAtomEncoder.appendTabstripButton(
      tabHeader,
      {
        vLength: tab.vLength,
        vHeight: tab.vHeight,
        pageID: tab.pageID,
        functionCodeOffset: codeOffset,
        textOffset,
        idOffset,
        text: tab.caption,
        functionCode: tab.functionCode,
        id: tab.shortName
      },
      bytes
    )
    if (tab.fieldName !== undefined) {
      const child = new DyntAtomHeader({ ...header, etype: DyntElementType.of("fname"), dialogFlags: new DyntDialogFlags({ flag1: 0, flag2: 0 }) })
      DyntAtomEncoder.appendText(child, tab.fieldName, bytes)
    }
    output.bytes(bytes.toBytes())
  }
}

// MARK: - Field markers

/**
 * How the markers of an input field are read (elements.md Reading R-EL-16, #115).
 * - `flag1Bits`: the default: required and date from the invented flag1 bits, numeric from
 *   JUSTRIGHT, value help from MATCHCODE.
 * - `attributesOnly`: flag1 ignored: numeric and value help only.
 * - `specGap`: the fallback: no markers, as before elements.md.
 */
export type FieldMarkerReading = "flag1Bits" | "attributesOnly" | "specGap"
export const FieldMarkerReading = { allCases: ["flag1Bits", "attributesOnly", "specGap"] as readonly FieldMarkerReading[] } as const

/**
 * The markers of an input field (elements.md Reading R-EL-16). Required and date are **invented**
 * bits of the `_2` field's flag1, safe because real flag1 bytes are zero (elements.md §11.1);
 * numeric is JUSTRIGHT (PV-0623) and value help MATCHCODE (PV-0624). The fake server also sets the
 * dlg_flag_1 associations of PV-0977; the decoder does not read them. A value is the option bits
 * (Swift `OptionSet`).
 */
export type FieldMarkers = number

export const FieldMarkers = {
  required: 1 << 0, // not-protocol: option bit
  date: 1 << 1, // not-protocol: option bit
  numeric: 1 << 2, // not-protocol: option bit
  valueHelp: 1 << 3, // not-protocol: option bit

  /** flag1 bit of a required field. */
  requiredFlag1Bit: 0x0001, // not-protocol: Swooey Reading R-EL-16 (invented)
  /** flag1 bit of a date field. */
  dateFlag1Bit: 0x0002, // not-protocol: Swooey Reading R-EL-16 (invented)
  /** dlg_flag_1 association of numeric fields (PV-0977). */
  numericDialogFlag: 0x20, // provenance: PV-0977
  /** dlg_flag_1 association of fields with value help (PV-0977). */
  valueHelpDialogFlag: 0x04, // provenance: PV-0977

  /** The markers of a field with `flag1` and `attributes` under `reading` (Swift `init(flag1:attributes:reading:)`). */
  of(flag1: number, attributes: DyntAttributes, reading: FieldMarkerReading = "flag1Bits"): FieldMarkers {
    let markers: FieldMarkers = 0
    switch (reading) {
      case "specGap":
        break
      case "flag1Bits":
      case "attributesOnly":
        if (reading === "flag1Bits") {
          if ((flag1 & FieldMarkers.requiredFlag1Bit) !== 0) markers |= FieldMarkers.required
          if ((flag1 & FieldMarkers.dateFlag1Bit) !== 0) markers |= FieldMarkers.date
        }
        if ((attributes & DyntAttributes.justRight) !== 0) markers |= FieldMarkers.numeric
        if ((attributes & DyntAttributes.matchCode) !== 0) markers |= FieldMarkers.valueHelp
        break
    }
    return markers
  },

  /** The flag1 value that carries the required and date markers. */
  flag1(markers: FieldMarkers): number {
    return ((markers & FieldMarkers.required) !== 0 ? FieldMarkers.requiredFlag1Bit : 0) | ((markers & FieldMarkers.date) !== 0 ? FieldMarkers.dateFlag1Bit : 0)
  },

  /** The attributes that carry the numeric and value-help markers. */
  attributes(markers: FieldMarkers): DyntAttributes {
    return ((markers & FieldMarkers.numeric) !== 0 ? DyntAttributes.justRight : 0) | ((markers & FieldMarkers.valueHelp) !== 0 ? DyntAttributes.matchCode : 0)
  },

  /** The dlg_flag_1 bits the fake server adds (PV-0977). */
  dialogFlag1(markers: FieldMarkers): number {
    return (
      ((markers & FieldMarkers.numeric) !== 0 ? FieldMarkers.numericDialogFlag : 0) |
      ((markers & FieldMarkers.valueHelp) !== 0 ? FieldMarkers.valueHelpDialogFlag : 0)
    )
  }
} as const

// MARK: - Value help and the cursor

/**
 * How F4 is sent (elements.md Reading R-EL-15, #114).
 * - `functionKey4`: the default: function number 4 in UI_EVENT_SOURCE with the cursor on the field.
 * - `valueHelpEvent`: the UI event VALUEHELP (0x03) with control FIELD; not built.
 * - `specGap`: refused with gap #114.
 */
export type ValueHelpReading = "functionKey4" | "valueHelpEvent" | "specGap"
export const ValueHelpReading = {
  allCases: ["functionKey4", "valueHelpEvent", "specGap"] as readonly ValueHelpReading[],
  /** Function number 4, F4 (PV-0731). */
  functionNumber: 4 // provenance: PV-0731
} as const

/**
 * The container ids of DYNT_FOCUS_1 and UI_EVENT_SOURCE (elements.md Reading R-EL-17, #51).
 * - `area`: the default: one id, the cursor element's area (0 in the main area).
 * - `alwaysZero`: the fallback: one id 0 whatever the area, as open-diag-go's client sends (PV-0780).
 */
export type CursorContainerReading = "area" | "alwaysZero"
export const CursorContainerReading = {
  allCases: ["area", "alwaysZero"] as readonly CursorContainerReading[],

  /** The container ids for a cursor element in `area`. */
  containerIDs(reading: CursorContainerReading, area: number): number[] {
    return reading === "area" ? [area] : [0]
  }
} as const
