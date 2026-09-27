// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenElement.swift (MIT).

import { DyntAttributes, DyntElementType, type DyntAtom, type DyntAtomHeader } from "../codec/index.js"
import type { ScreenDropdown, ScreenInputFormat, ScreenRadioGroupID } from "./screenControls.js"
import { GridPoint, TextMarkup, characterCount, type ScreenIcon } from "./screenLayout.js"
import type { ScreenTableCell } from "./screenTable.js"

/**
 * The stable identity of a screen element: where its atom sits (area, block, row, column), its
 * element type, and which of several atoms with all of these it is.
 *
 * Two decodes of the same screen give the same ids, and an element keeps its id on a later screen
 * that puts the same kind of atom at the same place, so the app can keep focus and edits keyed by
 * it. Ordered by area, block, row, column, element type and occurrence (`compare`); `mapKey` names
 * it in a `Map` (Swift `Hashable`).
 */
export class ScreenElementID {
  readonly area: number
  readonly block: number
  readonly row: number
  readonly column: number
  /** The atom's etype byte (dynt-atoms.md, "Element types"). */
  readonly elementType: number
  /** 0 for the first atom with these values in the screen, 1 for the second, and so on. */
  readonly occurrence: number

  constructor(fields: { area?: number; block: number; row: number; column: number; elementType: number; occurrence?: number }) {
    this.area = fields.area ?? 0
    this.block = fields.block
    this.row = fields.row
    this.column = fields.column
    this.elementType = fields.elementType
    this.occurrence = fields.occurrence ?? 0
  }

  /** The id of the atom with `header`'s position and type (Swift `init(header:occurrence:)`). */
  static ofHeader(header: DyntAtomHeader, occurrence = 0): ScreenElementID {
    return new ScreenElementID({
      area: header.area,
      block: header.block,
      row: header.row,
      column: header.col,
      elementType: DyntElementType.rawValue(header.etype),
      occurrence
    })
  }

  /** Swift's `<`: -1, 0 or 1 by area, block, row, column, element type and occurrence. */
  static compare(lhs: ScreenElementID, rhs: ScreenElementID): number {
    const pairs: [number, number][] = [
      [lhs.area, rhs.area],
      [lhs.block, rhs.block],
      [lhs.row, rhs.row],
      [lhs.column, rhs.column],
      [lhs.elementType, rhs.elementType],
      [lhs.occurrence, rhs.occurrence]
    ]
    for (const [a, b] of pairs) if (a !== b) return a < b ? -1 : 1
    return 0
  }

  /** Swift's `==`. */
  static equals(lhs: ScreenElementID | undefined, rhs: ScreenElementID | undefined): boolean {
    if (lhs === undefined || rhs === undefined) return lhs === rhs
    return ScreenElementID.compare(lhs, rhs) === 0
  }

  /** A string that names the id, for maps and sets keyed by it (Swift `Hashable`). */
  get mapKey(): string {
    return `${this.area}/${this.block}/${this.row}/${this.column}/${this.elementType}/${this.occurrence}`
  }

  /** For example `b1 r6 c18 t130`, with `a2 ` in front for an area other than 0 and `#1` after it for a second occurrence. */
  get description(): string {
    const prefix = this.area === 0 ? "" : `a${this.area} `
    const suffix = this.occurrence === 0 ? "" : `#${this.occurrence}`
    return `${prefix}b${this.block} r${this.row} c${this.column} t${this.elementType}${suffix}`
  }

  toString(): string {
    return this.description
  }
}

/**
 * What a screen element is, from its atom's element type (dynt-atoms.md, R-DA-4). Swift's
 * `element.kind == .input` is `element.kind.kind === "input"`.
 * - `label`: KEYWORD, KEYWORD_1_1, KEYWORD_2: a static label.
 * - `input`: EFIELD, EFIELD_1, EFIELD_2: an input field. INVISIBLE makes it a password field.
 * - `output`: OFIELD, OFIELD_1, OFIELD_2: an output (display) field.
 * - `frame`: FRAME_1, FRAME_3: a box, with a caption for FRAME_1.
 * - `tab`: TABSTRIP_BUTTON: a tab, with its caption.
 * - `button`: PUSHBUTTON_1, _2, _3: a push button. PUSHBUTTON_2's caption and function code are
 *   decoded under Reading R-DA-9 (#35); the other two stay opaque.
 * - `checkbox`: CHECKBUTTON_1 to _4.
 * - `radioButton`: RADIOBUTTON_0, _1, __0, _3. RADIOBUTTON_3's caption is decoded where the sources
 *   agree (PV-0659, #35).
 * - `dropdown`: COMBOBOX (117) or COMBOBOX_1 (126) with a `ZZValueList` in its XMLPROP child
 *   (elements.md Reading R-EL-3, invented). COMBOSTYLE alone stays `input`, and 117 or 126 without
 *   a `ZZValueList` stays `other`: `ScreenElementKind.of` never gives this case, the screen decode
 *   does.
 * - `other`: every other element type, unknown ones included, kept by its type.
 */
export type ScreenElementKind =
  | { readonly kind: "label" }
  | { readonly kind: "input" }
  | { readonly kind: "output" }
  | { readonly kind: "frame" }
  | { readonly kind: "tab" }
  | { readonly kind: "button" }
  | { readonly kind: "checkbox" }
  | { readonly kind: "radioButton" }
  | { readonly kind: "dropdown" }
  | { readonly kind: "other"; readonly value: DyntElementType }

export const ScreenElementKind = {
  label: { kind: "label" } as ScreenElementKind,
  input: { kind: "input" } as ScreenElementKind,
  output: { kind: "output" } as ScreenElementKind,
  frame: { kind: "frame" } as ScreenElementKind,
  tab: { kind: "tab" } as ScreenElementKind,
  button: { kind: "button" } as ScreenElementKind,
  checkbox: { kind: "checkbox" } as ScreenElementKind,
  radioButton: { kind: "radioButton" } as ScreenElementKind,
  dropdown: { kind: "dropdown" } as ScreenElementKind,
  other: (value: DyntElementType): ScreenElementKind => ({ kind: "other", value }),

  /**
   * The kind of an element type (Swift `init(_:)`). FNAME and XMLPROP are children, not elements;
   * they map to `other` here and are never elements of a `Screen`.
   */
  of(etype: DyntElementType): ScreenElementKind {
    switch (DyntElementType.fieldRole(etype)) {
      case "editable":
        return ScreenElementKind.input
      case "display":
        return ScreenElementKind.output
      case "label":
        return ScreenElementKind.label
      case undefined:
        switch (DyntElementType.fromRaw(DyntElementType.rawValue(etype)).kind) {
          case "frame1":
          case "frame3":
            return ScreenElementKind.frame
          case "tabstripButton":
            return ScreenElementKind.tab
          case "pushbutton1":
          case "pushbutton2":
          case "pushbutton3":
            return ScreenElementKind.button
          case "checkbutton1":
          case "checkbutton2":
          case "checkbutton3":
          case "checkbutton4":
            return ScreenElementKind.checkbox
          case "radiobutton0":
          case "radiobutton1":
          case "radiobutton__0":
          case "radiobutton3":
            return ScreenElementKind.radioButton
          default:
            return ScreenElementKind.other(etype)
        }
    }
  },

  /** Swift's `==`: the same case, and for `other` the same element type. */
  equals(a: ScreenElementKind | undefined, b: ScreenElementKind | undefined): boolean {
    if (a === undefined || b === undefined) return a === b
    if (a.kind !== b.kind) return false
    if (a.kind === "other" && b.kind === "other") {
      if (a.value.kind !== b.value.kind) return false
      return a.value.kind !== "unknown" || a.value.value === (b.value as typeof a.value).value
    }
    return true
  },

  /** A short name: `label`, `input`, … or the element type's name for `other` (Swift `description`). */
  description(kind: ScreenElementKind): string {
    switch (kind.kind) {
      case "radioButton":
        return "radio"
      case "other":
        return DyntElementType.name(kind.value) ?? `etype ${DyntElementType.rawValue(kind.value)}`
      default:
        return kind.kind
    }
  }
} as const

/** The widths and flag1 of a dropdown's `_2` body (PV-0651), kept for its return (Swift `ScreenElement.DropdownBody`, internal). */
export interface DropdownBody {
  readonly flag1: number
  readonly mlen: number
  readonly maxNrChars: number
}

/** The fields of a `ScreenElement` (Swift's internal `init(id:kind:width:height:maxLength:text:atom:…)`). */
export interface ScreenElementFields {
  id: ScreenElementID
  kind: ScreenElementKind
  width: number | undefined
  height: number | undefined
  maxLength: number | undefined
  text: string | undefined
  atom: DyntAtom
  placement?: GridPoint | undefined
  isChecked?: boolean | undefined
  radioGroup?: ScreenRadioGroupID | undefined
  dropdown?: ScreenDropdown | undefined
  isRequired?: boolean
  inputFormat?: ScreenInputFormat
  hasValueHelp?: boolean
  isDisabled?: boolean
  firesFunction?: string | undefined
  table?: ScreenTableCell | undefined
  tabstripPage?: number | undefined
  holdsRequiredMarker?: boolean
}

/**
 * One element of a screen: a label, an input or output field, a frame, a tab, a button and so on,
 * decoded from one DYNT atom (dynt-atoms.md), with the Data Dictionary field name of the FNAME atom
 * that follows it (IMPL-DA-4).
 *
 * A password field (INVISIBLE, PV-0621) never has a `text`: its value is not decoded (IMPL-DA-1), so
 * no description of the element can show it.
 *
 * A Swift struct whose `internal(set)` members the screen decode sets while it builds the screen;
 * once a `Screen` holds it, treat it as immutable (screens share elements, `Screen.keepContent`).
 */
export class ScreenElement {
  readonly id: ScreenElementID
  readonly kind: ScreenElementKind
  /**
   * The width in cells: a field's mlen (PV-0651), a frame's dcols (PV-0654), a tab's or push
   * button's vlength (PV-0656, PV-0657), a radio button's visible label length (PV-0655); undefined
   * when the payload stays opaque.
   */
  readonly width: number | undefined
  /** The height in rows of a frame (drows), a tab or a push button (vheight); undefined otherwise. */
  readonly height: number | undefined
  /**
   * The most characters an input field accepts (maxnrchars, PV-0651); undefined for other elements
   * and for a field whose payload stays opaque (EFIELD 101, IMPL-DA-2; #36).
   */
  readonly maxLength: number | undefined
  /**
   * The text in the screen's code page with trailing spaces removed, the padding pysap's reader
   * strips from atom texts (server-screen.md §5.1): a label's caption, a field's value, a frame's or
   * tab's caption. Undefined for a password field and for an element with no decoded text (opaque
   * payloads, the button strings of #35). Bytes invalid in the code page are shown as U+FFFD
   * (`ScreenDiagnostics.repairedTexts`); in a code page Swooey does not know, the text is read as
   * ISO 8859-1 (`ScreenDiagnostics.guessedTexts`).
   */
  readonly text: string | undefined
  /**
   * The text of the FNAME child. Undefined when none follows, and for a password field, whose
   * children repeat its INVISIBLE attribute and are not decoded either. (Swift `internal(set)`.)
   */
  fieldName: string | undefined = undefined
  /**
   * The function code a push button (Reading R-DA-9) or a tab (PV-0656) sends when clicked, in
   * VARINFO OKCODE and verbatim (PV-0773), with trailing spaces removed; undefined for other
   * elements and for a button whose strings stay opaque (`ScreenReadings.buttonStrings`). Its
   * function is in `Screen.functions` as `pushButton`. (Swift `internal(set)`.)
   */
  functionCode: string | undefined = undefined
  /**
   * Where the element sits on the whole screen: the origin of the container its `area` names plus
   * its received row and column (server-screen.md §8.6, Reading R-SS-14). Area 0 is the main screen,
   * at row 0, column 0; an area no CONTAINER item of the message declared is placed there too and
   * counted in `ScreenDiagnostics.atomsWithoutContainer`. The `id` and the input step keep the
   * received values.
   */
  readonly placement: GridPoint

  // MARK: Elements of elements.md (pinned; decoded per ScreenReadings)

  /**
   * A checkbox's state or whether a radio button is selected (Readings R-EL-1, R-EL-2); undefined for
   * other elements and for a toggle whose body stays opaque.
   */
  readonly isChecked: boolean | undefined
  /** A radio button's group (Reading R-EL-2); undefined otherwise. Set once the screen's radio buttons are grouped. */
  radioGroup: ScreenRadioGroupID | undefined
  /** A dropdown's options and selection (Reading R-EL-3); undefined otherwise. */
  readonly dropdown: ScreenDropdown | undefined
  /**
   * The field is required (Reading R-EL-16, invented flag1 bit; or Reading R-EL-16a, the server's
   * `?`). The server checks; the client never blocks on it.
   */
  readonly isRequired: boolean
  /**
   * The field's text as received is the server's marker of an empty required field, a lone `?`
   * (Reading R-EL-16a): a client draws the field empty with its required marker, and returns only
   * what the user types. `text` keeps the `?` as received.
   */
  readonly holdsRequiredMarker: boolean
  /** How the field's text is meant (Reading R-EL-16). */
  readonly inputFormat: ScreenInputFormat
  /** MATCHCODE (PV-0624): the field offers value help, F4 (Reading R-EL-15). */
  readonly hasValueHelp: boolean
  /** A push button or tab the server disabled with PROTECTED (Reading R-EL-19, invented). */
  readonly isDisabled: boolean
  /** The function code a checkbox, radio button or dropdown fires when changed (Reading R-EL-4), with its `=`; undefined for none. */
  readonly firesFunction: string | undefined
  /** Set when the element is a cell of a table control (Reading R-EL-7). */
  table: ScreenTableCell | undefined
  /**
   * The tabstrip id whose active page holds the element (Reading R-EL-5); undefined outside
   * tabstrips. Set once the screen's tabstrips are read.
   */
  tabstripPage: number | undefined
  /**
   * The `text` with its leading icon and tooltip markup removed (`TextMarkup`): what a label, output
   * field, frame, tab, button, checkbox or radio button shows. An input field's text is user data and
   * is never parsed, so its caption is its text. Undefined when `text` is.
   */
  readonly caption: string | undefined
  /** The icon the text's leading markup names (`@XX@`, `@XX\Qtip@`), or undefined. Never set for an input field. */
  readonly icon: ScreenIcon | undefined
  /**
   * The tooltip: the text's `\Q` markup, else the `DefaultTooltip` of its XMLPROP child
   * (dynt-atoms.md, "Text atoms"); undefined when neither gives one. A password field has none.
   */
  tooltip: string | undefined
  /**
   * The atom as received: its header (dlg flags, area, block, group, row, column, attributes) and
   * payload fields. Its ranges point into the message it came from, which the screen does not keep;
   * the input step returns an input field from it (`ReturnedField.received`).
   */
  readonly atom: DyntAtom
  /**
   * A dropdown's `_2` body as received (Reading R-EL-3): what the input step returns the chosen key
   * with (Reading R-EL-4). Undefined for every other element. (Swift internal.)
   */
  dropdownBody: DropdownBody | undefined = undefined

  constructor(fields: ScreenElementFields) {
    const holdsRequiredMarker = fields.holdsRequiredMarker ?? false
    this.id = fields.id
    this.kind = fields.kind
    this.width = fields.width
    this.height = fields.height
    this.maxLength = fields.maxLength
    this.text = fields.text
    this.atom = fields.atom
    this.placement = fields.placement ?? new GridPoint(fields.atom.row, fields.atom.col)
    this.isChecked = fields.isChecked
    this.radioGroup = fields.radioGroup
    this.dropdown = fields.dropdown
    this.isRequired = (fields.isRequired ?? false) || holdsRequiredMarker
    this.holdsRequiredMarker = holdsRequiredMarker
    this.inputFormat = fields.inputFormat ?? "text"
    this.hasValueHelp = fields.hasValueHelp ?? false
    this.isDisabled = fields.isDisabled ?? false
    this.firesFunction = fields.firesFunction
    this.table = fields.table
    this.tabstripPage = fields.tabstripPage
    // An input field's text is user data: never parsed for markup.
    const text = fields.text
    if (fields.kind.kind === "input") {
      this.caption = text
      this.icon = undefined
      this.tooltip = undefined
    } else if (text !== undefined) {
      const markup = TextMarkup.parse(text)
      this.caption = markup.caption
      this.icon = markup.icon
      this.tooltip = markup.tooltip
    } else {
      this.caption = undefined
      this.icon = undefined
      this.tooltip = undefined
    }
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): ScreenElement {
    return Object.assign(Object.create(ScreenElement.prototype) as ScreenElement, this)
  }

  /** The row of the atom (PV-0610). */
  get row(): number {
    return this.atom.row
  }

  /** The column of the atom (PV-0611). */
  get column(): number {
    return this.atom.col
  }

  /** The attribute byte (PV-0620–PV-0627). */
  get attributes(): DyntAttributes {
    return this.atom.attributes
  }

  /** INVISIBLE is set: a password field (IMPL-DA-1). */
  get isPassword(): boolean {
    return this.atom.isPasswordField
  }

  /**
   * The cells the element owns across: `width` (a field's mlen, a frame's dcols, a button's
   * vlength), else the caption's length. A PROPFONT text may hold more characters than this; the
   * renderer fits it into these cells.
   */
  get visibleWidth(): number {
    if (this.width !== undefined) return this.width
    return this.caption === undefined ? 0 : characterCount(this.caption)
  }

  /** INTENSIFY is set (PV-0622): the text is highlighted. */
  get isHighlighted(): boolean {
    return (this.atom.attributes & DyntAttributes.intensify) !== 0
  }

  /** PROTECTED is set (PV-0620). */
  get isProtected(): boolean {
    return (this.atom.attributes & DyntAttributes.protected) !== 0
  }

  /** An input field without PROTECTED: the user may edit it. */
  get isEditable(): boolean {
    return this.kind.kind === "input" && !this.isProtected
  }

  /**
   * For example `input b1 r4 c18 t130 w12 max12 "DONALD"`; a password field shows `password` in
   * place of any text, and an element its container moves shows its placement, `at r1 c36`.
   */
  get description(): string {
    const parts = [ScreenElementKind.description(this.kind), this.id.description]
    if (this.width !== undefined) parts.push(`w${this.width}`)
    if (this.height !== undefined) parts.push(`h${this.height}`)
    if (this.maxLength !== undefined) parts.push(`max${this.maxLength}`)
    if (this.isProtected) parts.push("protected")
    if (!GridPoint.equals(this.placement, new GridPoint(this.row, this.column))) parts.push(`at ${this.placement.description}`)
    if (this.isPassword) {
      parts.push("password")
    } else if (this.text !== undefined) {
      parts.push(`"${this.text}"`)
    }
    if (this.fieldName !== undefined) parts.push(`fname ${this.fieldName}`)
    if (this.functionCode !== undefined) parts.push(`code ${this.functionCode}`)
    // The markers of elements.md, only where a Reading decoded them.
    if (this.isChecked !== undefined) parts.push(this.isChecked ? "checked" : "unchecked")
    if (this.dropdown !== undefined) parts.push(`${this.dropdown.options.length} options`)
    if (this.isRequired) parts.push("required")
    switch (this.inputFormat) {
      case "text":
        break
      case "numeric":
        parts.push("numeric")
        break
      case "date":
        parts.push("date")
        break
    }
    if (this.hasValueHelp) parts.push("F4")
    if (this.isDisabled) parts.push("disabled")
    if (this.firesFunction !== undefined) parts.push(`fires ${this.firesFunction}`)
    return parts.join(" ")
  }

  /** The description (Swift `debugDescription`). */
  get debugDescription(): string {
    return this.description
  }

  toString(): string {
    return this.description
  }
}
