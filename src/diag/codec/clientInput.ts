// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ClientInput.swift (MIT).

// The client's input step (docs/protocol/client-input.md): the dialog message that returns the
// fields the user edited. What the spec fully specifies is encoded here — the edited fields as
// EFIELD_2 atoms at their block, row and column (R-CI-3), and the envelope: DIALOG_STEP_NUMBER
// first, the input items in the reference client's order, EOM last (R-CI-1, R-CI-2). What it
// leaves open stays a typed gap: the dlg-flag bit that marks a field changed (#34), the item that
// triggers a function (#55), the focus item that goes with input (#33) and the metrics blob (#20).
//
// Swift adds `inputMessage` and `controlReply` to `ClientMessageEncoder`, and a description to
// `ClientItem`, in extensions in this file. A TypeScript class cannot take members from another
// module without a load-order cycle, so they live in the object `ClientInput` here
// (`ClientInput.inputMessage(encoder, step, …)` for `encoder.inputMessage(step, …)`).

import { ByteWriter } from "../wire/index.js"
import { ApplItem, ApplSID } from "./applRegistry.js"
import { ClientMessageEncoder, ClientMessageError, type ClientItem } from "./clientMessages.js"
import { CodecSpecGap } from "./diagCodec.js"
import { DiagItemEncoder, DiagItemEncodingError, type DiagItemType } from "./diagItem.js"
import { DyntAtomHeader, DyntAttributes, DyntDialogFlags, DyntElementType, type DyntAtom } from "./dyntAtom.js"
import { DyntAtomEncoder, DyntAtomEncodingError, type DyntAtomEncodingErrorInfo } from "./dyntAtomEncoder.js"
import { DyntCombobox, DyntToggleReturn } from "./dyntElements.js"
import { ClientDataManager, InputEnvelope, InputFocus, ServerEcho } from "./inputEnvelope.js"
import type { ListWindowState } from "./listItems.js"
import type { RFCTransferValue } from "./rfcTransfer.js"
import { ScreenValueEncodingError } from "./screenListValues.js"
import type { ListFocus } from "./screenValues.js"
import type { Secret } from "./secret.js"
import { SESValue } from "./simpleItemValues.js"
import { TableRowRecord } from "./tableItems.js"
import { UIEventFunctionKey, type UIEventDataWidth } from "./uiEventFunctionKey.js"
import type { UIControlType } from "./uiEventSource.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

// MARK: - Errors

/**
 * Why a function cannot be fired (client-input.md §7.5). A function whose trigger the spec does not
 * know is `ClientInputError` `specGap` 55 instead.
 */
export type FunctionRefusal =
  /** The screen offers no such function: it is not in the screen's GUI status or on its elements. */
  | { readonly kind: "notOffered" }
  /** The screen offers the function, but not enabled (a menu entry without SEL, Reading R-SS-12). */
  | { readonly kind: "disabled" }
  /** The number does not fit the one byte a virtual key takes (PV-0718, PV-0772). */
  | { readonly kind: "virtualKeyOutOfRange"; readonly value: number }

/** Why an input step could not be built. Nothing is appended when one is thrown. */
export type ClientInputErrorInfo =
  /**
   * The step needs a fact the spec does not state; `issue` names the spec-gap issue: #34 (the
   * changed flag), #55 (the function trigger), #33 (the focus item), #20 (the metrics blob).
   */
  | { readonly kind: "specGap"; readonly issue: number }
  /** The received atom is not an input field: only the EFIELD family (101, 121, 130; R-DA-4) is returned. */
  | { readonly kind: "notAnInputField"; readonly value: DyntElementType }
  /**
   * The received input field has no decoded field payload, so its display width and maximum length
   * are unknown: EFIELD (101) is opaque (IMPL-DA-2), and a `_1` or `_2` payload whose dlen does not
   * fill the atom is #36.
   */
  | { readonly kind: "unknownFieldWidths"; readonly value: DyntElementType }
  /** The atom cannot be written: for example a text longer than dlen's single byte. */
  | { readonly kind: "atom"; readonly error: DyntAtomEncodingErrorInfo }
  /**
   * The password field cannot be written with the secret as its text: its bytes do not fit dlen's
   * single byte (PV-0651). Unlike `atom` it carries no reason, since the encoder's reason holds the
   * text's length (IMPL-DA-1).
   */
  | { readonly kind: "secretNotEncodable" }
  /** The function the user chose cannot be fired: ScreenModel's function triggers report why (client-input.md §7.5). */
  | { readonly kind: "function"; readonly value: FunctionRefusal }

export class ClientInputError extends Error {
  constructor(readonly info: ClientInputErrorInfo) {
    super(describeClientInputError(info))
    this.name = "ClientInputError"
  }
}

/** The error in words. A secret that does not fit names no length (IMPL-DA-1). */
function describeClientInputError(info: ClientInputErrorInfo): string {
  switch (info.kind) {
    case "specGap":
      return `input step: spec gap #${info.issue}`
    case "notAnInputField":
      return `input step: element type ${DyntElementType.rawValue(info.value)} is no input field`
    case "unknownFieldWidths":
      return `input step: the widths of the element type ${DyntElementType.rawValue(info.value)} field are unknown`
    case "atom":
      return `input step: ${new DyntAtomEncodingError(info.error).message}`
    case "secretNotEncodable":
      return "input step: the password cannot be written into its field"
    case "function":
      return `input step: the function cannot be fired (${info.value.kind})`
  }
}

/** Runs `body`; an atom encoder error becomes `ClientInputError.atom`. */
function encodingAtom(body: () => void): void {
  try {
    body()
  } catch (error) {
    if (error instanceof DyntAtomEncodingError) throw new ClientInputError({ kind: "atom", error: error.info })
    throw error
  }
}

// MARK: - Returned field

/** The fields of a `ReturnedField` (Swift `init(block:row:col:mlen:maxNrChars:area:group:dialogFlags:attributes:flag1:)`). */
export interface ReturnedFieldFields {
  block: number
  row: number
  col: number
  mlen: number
  maxNrChars: number
  area?: number
  group?: number
  dialogFlags?: DyntDialogFlags
  attributes?: DyntAttributes
  flag1?: number
}

/**
 * One edited field as a client returns it (client-input.md §2, R-CI-3): an EFIELD_2 (130) atom at
 * the field's block, row and column, with the widths of the field the server sent.
 *
 * The dlg flags are carried verbatim and not interpreted: which bit marks a field changed is #34
 * (R-CI-4), so `markedChanged()` is blocked. The atom header's other fields (area, group, attribute
 * byte) and the payload's flag1 are carried verbatim too; the reference client's returned password
 * atom keeps INVISIBLE (PV-0621). Immutable: `withChangedBit()` returns a new field.
 */
export class ReturnedField {
  /** The atom header. Its element type is always EFIELD_2 (130). */
  readonly header: DyntAtomHeader
  /** field2_flag1 (PV-0651), not interpreted. */
  readonly flag1: number
  /** The display width (field2_mlen, PV-0651). */
  readonly mlen: number
  /** The maximum input length (field2_maxnrchars, PV-0651). */
  readonly maxNrChars: number

  /** A field at `block`, `row`, `col` with the given widths. */
  constructor(fields: ReturnedFieldFields) {
    this.header = new DyntAtomHeader({
      etype: DyntElementType.of("efield2"),
      dialogFlags: fields.dialogFlags ?? new DyntDialogFlags({ flag1: 0, flag2: 0 }),
      area: fields.area ?? 0,
      block: fields.block,
      group: fields.group ?? 0,
      row: fields.row,
      col: fields.col,
      attributes: fields.attributes ?? 0
    })
    this.flag1 = fields.flag1 ?? 0
    this.mlen = fields.mlen
    this.maxNrChars = fields.maxNrChars
  }

  /**
   * The field an input atom of a received screen describes: its block, row and column, its widths,
   * and verbatim its dlg flags, area, group, attributes and flag1. (Swift `init(received:)`; throws
   * `ClientInputError`.)
   */
  static received(atom: DyntAtom): ReturnedField {
    if (DyntElementType.fieldRole(atom.etype) !== "editable") throw new ClientInputError({ kind: "notAnInputField", value: atom.etype })
    if (atom.payload.kind !== "field") throw new ClientInputError({ kind: "unknownFieldWidths", value: atom.etype })
    const field = atom.payload.value
    return new ReturnedField({
      block: atom.block,
      row: atom.row,
      col: atom.col,
      mlen: field.mlen,
      maxNrChars: field.maxNrChars,
      area: atom.area,
      group: atom.group,
      dialogFlags: atom.dialogFlags,
      attributes: atom.attributes,
      flag1: field.flag1
    })
  }

  /** INVISIBLE is set: a password field (IMPL-DA-1). */
  get isPasswordField(): boolean {
    return DyntAttributes.isPasswordField(this.header.attributes)
  }

  /**
   * The field with its dlg flags marked changed. Blocked, like `DyntDialogFlags.markedChanged()`:
   * which bit marks a field changed is spec gap #34, so this always throws `ClientInputError`
   * `specGap` with issue 34.
   */
  markedChanged(): ReturnedField {
    throw new ClientInputError({ kind: "specGap", issue: CodecSpecGap.dyntDialogFlags })
  }

  /**
   * The field with bit 0x01 of dlg_flag_2 set (Reading R-CI-13, PV-0777), as the reference envelope
   * returns an edited field (`InputEnvelope.changedBit`). Unlike `markedChanged()` it does not claim
   * to know what the bit means: it sends what open-diag-go's live-tested client sends.
   */
  withChangedBit(): ReturnedField {
    const header = this.header
    return new ReturnedField({
      block: header.block,
      row: header.row,
      col: header.col,
      mlen: this.mlen,
      maxNrChars: this.maxNrChars,
      area: header.area,
      group: header.group,
      dialogFlags: header.dialogFlags.withChangedBit(),
      attributes: header.attributes,
      flag1: this.flag1
    })
  }
}

// MARK: - Input step

/**
 * How a step carries the function the user triggered (Swift `ClientInputStep.FunctionTrigger`).
 * Which item a real server needs is spec gap #55, so the choice is the caller's and the default is
 * the gap.
 * - `specGap`: the gap: `setFunctionCode` throws with issue 55.
 * - `varInfoOKCode`: client-input.md Reading R-CI-6 (unconfirmed): the code as the text of a
 *   VARINFO OKCODE item (PV-0708), sent as APPL after the fields. pysap's example server reads a
 *   typed command from this item (client-input.md §7.1, §7.4); the fake server does too.
 */
export type ClientInputStepFunctionTrigger = "specGap" | "varInfoOKCode"

/** The options of `ClientInputStep.setFunctionKey` (Swift's labelled parameters and their defaults). */
export interface ClientInputFunctionKeyOptions {
  /** The event-data width of Reading R-CI-9 (#56); `fourBytes` by default. */
  width?: UIEventDataWidth
  /** FIELD by default. */
  controlType?: UIControlType
  /** The cursor's row; 0 by default. */
  row?: number
  /** The cursor's column; 0 by default. */
  col?: number
}

/**
 * The input items of one dialog step, before `ClientMessageEncoder` wraps them with
 * DIALOG_STEP_NUMBER and EOM (client-input.md §1, R-CI-1).
 *
 * The items keep the reference client's relative order (R-CI-2, PV-0760): an optional SES, an
 * optional DYNN CHL, then one DYNT_ATOM item (APPL4, R-IT-10) holding an EFIELD_2 atom per edited
 * field (R-CI-3). Whether a real server needs the SES and DYNN CHL items is open (#33); their values
 * are opaque (#32). No XMLBLOB is sent until #20 (IMPL-IT-10).
 *
 * Field texts may be passwords, so an input step never prints them: its description, `toString()`,
 * `toJSON()` and `util.inspect` show only counts (IMPL-DA-1).
 *
 * A Swift struct: `clone()` copies it where Swift copies the value.
 */
export class ClientInputStep {
  /**
   * An SES item to send before the fields; the reference client sends one with `event_array = 1`
   * (client-input.md §5, R-CI-5). Opaque (#32).
   */
  ses: SESValue | undefined
  /**
   * Native logon confirmation (PV-1034), selected by the recognized native Enter path. Updates only
   * the received SES event array and screen flag; all other bytes, including reserved bytes, survive.
   */
  nativeLogonSession = false
  /** A DYNN CHL value (APPL 0x05/0x01) to send before the fields; opaque (#32). At most 65 535 bytes. */
  dynnCHL: Uint8Array | undefined
  /** The atoms of the DYNT_ATOM item. Never printed. */
  #atoms = new ByteWriter()
  #fieldCount = 0
  /**
   * Which parts of the reference input envelope the step sends (client-input.md §11). With
   * `InputEnvelope.minimal`, the default, the step is the one of R-CI-1 and R-CI-2; with any part,
   * `ClientInput.inputMessage` writes the envelope's order (R-CI-12 to R-CI-17). The changed bit is
   * the builder's to set on the fields it appends (`ReturnedField.withChangedBit()`): the step
   * cannot tell an edited field from the cursor field it returns as received.
   */
  envelope: InputEnvelope
  /** The DYNT_FOCUS_1 the step sends when its envelope holds `InputEnvelope.focus` (Reading R-CI-16); undefined sends none. */
  focus: InputFocus | undefined = undefined
  /** Optional classic-list cursor (PV-0717, PV-1026). */
  listFocus: ListFocus | undefined = undefined
  /**
   * Received plain list state for classic-list input (PV-1026). It replaces dynpro CHL and dynpro
   * focus carriers for a list-only step.
   */
  plainListWindow: ListWindowState | undefined = undefined
  /**
   * The row record of a table scroll request (elements.md Reading R-EL-9, PV-0968): an APPL DYNT
   * 09/05 item that the message encoder writes after the step's `items` (so after the DYNT_ATOM item)
   * and before the UI event; undefined sends none. It is no `ClientItem`.
   */
  tableRowRecord: TableRowRecord | undefined = undefined
  /**
   * An RFC_TR item (APPL 0x08) the step carries right after DIALOG_STEP_NUMBER, as a client's reply
   * to the server's control traffic does in the envelope shape (controls/transport.md §2.3; ODG's
   * control round trip, PV-0903); undefined sends none. The three-item reply of Reading R-CT-26 is
   * `ClientInput.controlReply`.
   */
  rfcTransfer: RFCTransferValue | undefined = undefined
  /**
   * A DATAMANAGER document to send in place of the bare one (controls/events.md §4, PV-1013 to
   * PV-1016): the events and control state a click into a grid or a tree reports. Written with any
   * envelope but the minimal one, a UI event or not; undefined leaves the envelope's bare document
   * (Reading R-CI-17).
   */
  dataManager: Uint8Array | undefined = undefined
  /**
   * The shell id, in ASCII, of the control that has the focus: a DYNT_CONTROL_FOCUS item (APPL
   * 0x09/0x12, transport.md §4) in place of DYNT_FOCUS_1 and, on a step without fields, of
   * DYNT_NOFOCUS, as SAP GUI sent it (PV-1016); undefined sends none.
   */
  controlFocus: Uint8Array | undefined = undefined
  #functionCode: Uint8Array | undefined = undefined
  #uiEvent: Uint8Array | undefined = undefined

  constructor(options: { ses?: SESValue; dynnCHL?: Uint8Array; envelope?: InputEnvelope } = {}) {
    this.ses = options.ses
    this.dynnCHL = options.dynnCHL
    this.envelope = options.envelope ?? InputEnvelope.minimal
  }

  /** A copy of this step, its atoms included (Swift copies the struct on assignment). */
  clone(): ClientInputStep {
    const copy = new ClientInputStep({ ses: this.ses, dynnCHL: this.dynnCHL?.slice(), envelope: this.envelope })
    copy.#atoms.bytes(this.#atoms.toBytes())
    copy.#fieldCount = this.#fieldCount
    copy.nativeLogonSession = this.nativeLogonSession
    copy.focus = this.focus === undefined ? undefined : cloneFocus(this.focus)
    // ListFocus and ListWindowState are immutable: the copy may share them.
    copy.listFocus = this.listFocus
    copy.plainListWindow = this.plainListWindow
    copy.tableRowRecord = this.tableRowRecord
    copy.rfcTransfer = this.rfcTransfer?.clone()
    copy.dataManager = this.dataManager?.slice()
    copy.controlFocus = this.controlFocus?.slice()
    copy.#functionCode = this.#functionCode?.slice()
    copy.#uiEvent = this.#uiEvent?.slice()
    return copy
  }

  /** The atoms, for the message encoder (Swift internal `atomBytes`). */
  get atomBytes(): Uint8Array {
    return this.#atoms.toBytes()
  }

  /**
   * The number of atoms appended: edited fields, and the checkboxes, radio buttons and dropdowns of
   * elements.md Reading R-EL-4.
   */
  get fieldCount(): number {
    return this.#fieldCount
  }

  /**
   * Appends one edited field: an EFIELD_2 atom with `text` in field2_text and field2_dlen its byte
   * length (PV-0651, PV-0652). The text's character set is the negotiated code page's (#18); it is
   * not checked against `ReturnedField.maxNrChars`, which counts characters. Throws
   * `ClientInputError`; nothing is appended then.
   */
  appendField(field: ReturnedField, text: Uint8Array): void {
    encodingAtom(() =>
      DyntAtomEncoder.appendField(field.header, { flag1: field.flag1, mlen: field.mlen, maxNrChars: field.maxNrChars, text }, this.#atoms)
    )
    this.#fieldCount += 1
  }

  /**
   * Appends a changed checkbox or radio button as the client returns it (elements.md Reading R-EL-4,
   * PV-0963): `header` is the received atom's (etype, area, block, group, row, column, attributes)
   * with the dlg flags the caller chose; the body is the new state, the received visible length and
   * zeros (`DyntToggleReturn`). It counts as a returned field.
   */
  appendToggle(header: DyntAtomHeader, toggle: { isChecked: boolean; visibleLength: number; trailingZero?: boolean }): void {
    encodingAtom(() =>
      DyntToggleReturn.append(
        header,
        { isChecked: toggle.isChecked, visibleLength: toggle.visibleLength, trailingZero: toggle.trailingZero ?? true },
        this.#atoms
      )
    )
    this.#fieldCount += 1
  }

  /**
   * Returns a numeric native radio using its exact received caption (PV-1027). It counts as a
   * returned field. Throws `ClientInputError`; nothing is appended then.
   */
  appendNativeRadio(header: DyntAtomHeader, isChecked: boolean, caption: Uint8Array): void {
    encodingAtom(() => DyntToggleReturn.appendNativeRadio(header, isChecked, caption, this.#atoms))
    this.#fieldCount += 1
  }

  /**
   * Appends a changed dropdown as the client returns it (elements.md Readings R-EL-3 and R-EL-4):
   * `header` is the received atom's (etype 117 or 126), the `_2` body its received flag1 and widths
   * with `key`, the chosen key, as its text (empty for the empty entry). It counts as a returned
   * field.
   */
  appendDropdown(header: DyntAtomHeader, dropdown: { flag1: number; mlen: number; maxNrChars: number; key: Uint8Array }): void {
    encodingAtom(() =>
      DyntCombobox.append(
        header,
        { flag1: dropdown.flag1, mlen: dropdown.mlen, maxNrChars: dropdown.maxNrChars, selectedKey: dropdown.key },
        this.#atoms
      )
    )
    this.#fieldCount += 1
  }

  /**
   * Appends the password field with the secret's bytes as its text (R-CI-3; the atom keeps the
   * received field's INVISIBLE, PV-0621). The bytes go into the step's atoms and from there only to
   * the message encoder; nothing prints them (IMPL-DA-1). A secret that cannot be written throws
   * `ClientInputError` `secretNotEncodable`, which holds no length. (Swift
   * `appendField(_:secret:)`.)
   */
  appendSecretField(field: ReturnedField, secret: Secret): void {
    try {
      secret.withBytes(bytes => this.appendField(field, bytes))
    } catch (error) {
      if (error instanceof ClientInputError) throw new ClientInputError({ kind: "secretNotEncodable" })
      throw error
    }
  }

  /** The function code the step carries under the `varInfoOKCode` trigger; undefined when none was set. */
  get functionCode(): Uint8Array | undefined {
    return this.#functionCode?.slice()
  }

  /**
   * Sets the function the user triggered (Enter, a function key, a command). With the default
   * trigger it is blocked: which item a real server needs for that — VARINFO OKCODE,
   * UI_EVENT_SOURCE, both or another — is spec gap #55 (R-CI-6 is unconfirmed), so it throws with
   * issue 55 and the step returns the edited fields without claiming to submit a function. With
   * `varInfoOKCode` the code is sent as a VARINFO OKCODE item (Reading R-CI-6); at most 65 535 bytes,
   * the APPL value limit.
   */
  setFunctionCode(code: Uint8Array, trigger: ClientInputStepFunctionTrigger = "specGap"): void {
    switch (trigger) {
      case "specGap":
        throw new ClientInputError({ kind: "specGap", issue: CodecSpecGap.functionTrigger })
      case "varInfoOKCode":
        this.#functionCode = code.slice()
        return
    }
  }

  /** The value of the UI_EVENT_SOURCE item the step carries (client-input.md §7.5, Reading R-CI-10); undefined when none was set. */
  get uiEvent(): Uint8Array | undefined {
    return this.#uiEvent?.slice()
  }

  /**
   * Sets the UI_EVENT_SOURCE value that fires a function: a function key, a toolbar button or a menu
   * item bound to a function number (Reading R-CI-10), sent as APPL 0x0f/0x01 after the items by
   * `ClientInput.inputMessage`, built with `UIEventFunctionKey.appendFunctionKey`. A GUI sends it
   * instead of a command in VARINFO OKCODE, never both (PV-0773); this step sends what it is given,
   * and ScreenModel sets only one of the two.
   */
  setUIEventSource(value: Uint8Array): void {
    this.#uiEvent = value.slice()
  }

  /**
   * Sets a function-key event for function `number` (Reading R-CI-10, PV-0771), with the event-data
   * `width` of Reading R-CI-9 (#56) and the cursor at `row`, `col`.
   */
  setFunctionKey(number: number, options: ClientInputFunctionKeyOptions = {}): void {
    const value = new ByteWriter()
    // One container id: appendFunctionKey fails only above 65 535 ids.
    try {
      UIEventFunctionKey.appendFunctionKey(
        number,
        { width: options.width ?? "fourBytes", controlType: options.controlType, controlRow: options.row ?? 0, controlCol: options.col ?? 0 },
        value
      )
    } catch (error) {
      if (!(error instanceof ScreenValueEncodingError)) throw error
    }
    this.#uiEvent = value.toBytes()
  }

  /**
   * Sets the focus or cursor position that goes with the input. Blocked: which focus item a client
   * sends with its input is open (client-input.md §9, R-CI-8, #33; the server side is #51), so this
   * always throws with issue 33.
   */
  setFocus(_row: number, _col: number): void {
    throw new ClientInputError({ kind: "specGap", issue: CodecSpecGap.applPayloadLayouts })
  }

  /**
   * Attaches the XML metrics blob the reference client sends before EOM. Blocked: its encoding and
   * whether a server needs it are spec gap #20, and encoders send no XMLBLOB until then
   * (IMPL-IT-10), so this always throws with issue 20.
   */
  setMetricsBlob(_blob: Uint8Array): void {
    throw new ClientInputError({ kind: "specGap", issue: CodecSpecGap.xmlblobValue })
  }

  /**
   * The items between DIALOG_STEP_NUMBER and EOM, in the order of R-CI-2: SES, DYNN CHL, DYNT_ATOM,
   * then the VARINFO OKCODE of Reading R-CI-6 when a function code was set with that trigger (the
   * reference client's step has none, so its place is our choice). The UI_EVENT_SOURCE of Reading
   * R-CI-10 (`uiEvent`) is not a `ClientItem`: `ClientInput.inputMessage` appends it after these
   * items, after the fields as ODG observed (PV-0771). The DYNT_ATOM item is left out when no field
   * was appended. Its value holds the field texts, passwords included: it goes to the message
   * encoder and is never logged.
   */
  get items(): ClientItem[] {
    const items: ClientItem[] = []
    if (this.ses !== undefined) items.push({ kind: "ses", value: this.ses })
    if (this.dynnCHL !== undefined) items.push({ kind: "dynnCHL", value: this.dynnCHL })
    if (this.#fieldCount > 0) items.push(withheldAtoms(this.#atoms.toBytes()))
    if (this.#functionCode !== undefined) items.push({ kind: "varInfoOKCode", text: this.#functionCode.slice() })
    return items
  }

  /** Counts only: field texts may be passwords. */
  get description(): string {
    const transfer = this.rfcTransfer
    const envelope = this.envelope
    return (
      `ClientInputStep(fields: ${this.#fieldCount}, SES: ${this.ses === undefined ? "no" : "yes"}, DYNN CHL: ${this.dynnCHL === undefined ? "no" : "yes"}` +
      (transfer === undefined ? "" : `, ${ApplSID.RfcTr.name(transfer.sid)}: ${transfer.value.length} bytes`) +
      (this.tableRowRecord === undefined ? "" : ", row record: yes") +
      (this.#functionCode === undefined ? "" : ", OKCODE: yes") +
      (this.#uiEvent === undefined ? "" : ", UI_EVENT_SOURCE: yes") +
      (envelope === InputEnvelope.minimal
        ? ")"
        : `, envelope: ${InputEnvelope.name(envelope)}` + (this.focus === undefined ? ")" : ", focus: yes)"))
    )
  }

  toString(): string {
    return this.description
  }

  /** The description, so that `JSON.stringify` writes no field byte. */
  toJSON(): string {
    return this.description
  }

  /** The description, so that `util.inspect` shows no field byte. */
  [INSPECT](): string {
    return this.description
  }
}

/**
 * The step's DYNT_ATOM item: a plain `ClientItem` whose `toJSON()` and `util.inspect` show
 * `dyntAtom(value withheld)`, as Swift's `ClientItem` description, debug description and mirror do:
 * the atoms may hold a password field's text, so neither their bytes nor their length is printed
 * (IMPL-DA-1). The hooks are not enumerable, so the item still compares equal to a plain
 * `{ kind: "dyntAtom", value }`.
 */
function withheldAtoms(value: Uint8Array): ClientItem {
  const item: ClientItem = { kind: "dyntAtom", value }
  const withheld = { enumerable: false, value: () => ClientInput.describeItem(item) }
  Object.defineProperty(item, "toJSON", withheld)
  Object.defineProperty(item, INSPECT, withheld)
  return item
}

/** A copy of an input focus (a Swift struct). */
function cloneFocus(focus: InputFocus): InputFocus {
  return new InputFocus(focus.row, focus.col, focus.colOffset, focus.containers.slice())
}

// MARK: - The encoder side (Swift's extensions of ClientMessageEncoder and ClientItem)

/** The options of `ClientInput.controlReply` (Swift's labelled parameters). */
export interface ControlReplyOptions {
  mode?: number
  modeStat?: number
  /** The replied message's step; undefined for the next per-connection step. */
  stepNumber: number | undefined
  /** An envelope without echoes, whose steps count their own: the counter never moves back. */
  ownCount?: boolean
}

/**
 * The members of Swift's `extension ClientMessageEncoder` and `extension ClientItem` in
 * ClientInput.swift.
 */
export const ClientInput = {
  /**
   * The item and its value, except a DYNT_ATOM's atoms: they may hold a password field's text, so
   * neither their bytes nor their length is shown (IMPL-DA-1). (Swift `ClientItem.description`.)
   */
  describeItem(item: ClientItem): string {
    switch (item.kind) {
      case "ses":
        return `ses(${describeSES(item.value)})`
      case "dynnCHL":
        return `dynnCHL(value: ${byteList(item.value)})`
      case "dyntAtom":
        return "dyntAtom(value withheld)"
      case "varInfoOKCode":
        return `varInfoOKCode(text: ${byteList(item.text)})`
    }
  },

  /**
   * The payload of the dialog message that returns user input (client-input.md §1, R-CI-1): the
   * later-message DIAG header, DIALOG_STEP_NUMBER with the next per-connection step, the step's
   * items (`ClientInputStep.items`, the VARINFO OKCODE of a function code included), the
   * UI_EVENT_SOURCE of a fired function (`ClientInputStep.uiEvent`, Reading R-CI-10), and EOM last.
   * Nothing follows EOM.
   *
   * A step whose `envelope` holds a part of the reference envelope is written in the envelope's
   * order, with `echo`, what the server last sent (`ServerEcho`; Swift's
   * `inputMessage(_:mode:echo:)`, and `inputMessage(_:mode:)` with an empty echo). Otherwise, in
   * open-diag-go's order (PV-0774):
   *
   * ```
   * header      mode_stat: the echo's (echoes), else 0
   * APPL        ST_USER DIALOG_STEP_NUMBER: the echo's (echoes), else the next per-connection step
   * APPL        RFC_TR: the step's reply to control traffic (controls/transport.md §2.3)
   * SES         the echo's 16 bytes (echoes), else the step's SES, else event_array 1 (echoes)
   * APPL        ST_R3INFO CODEPAGE_DIAG_GUI: the echo's (echoes, when there is one)
   * APPL        VARINFO OKCODE: the step's function code
   * APPL        DYNN CHL: the echo's (DYNN CHL), else the step's
   * APPL        VARINFO SCROLL_INFOS2, CONTAINER RESET: the echo's (screen state)
   * APPL/APPL4  DYNT_ATOM: the fields, as APPL with the GUI carriers; with none, an empty APPL
   *             DYNT_NOFOCUS (GUI carriers, without a control focus) or nothing
   * APPL        UI_EVENT_SOURCE: the step's event
   * APPL        DYNT_CONTROL_FOCUS: the step's control focus, else
   * APPL        DYNT_FOCUS_1: the step's focus (focus)
   * XMLBLOB     the step's DATAMANAGER document, else the bare one (DATAMANAGER) on a step
   *             with no UI event
   * EOM
   * ```
   *
   * A step's RFC_TR item (`ClientInputStep.rfcTransfer`) goes right after DIALOG_STEP_NUMBER, as in
   * ODG's control round trip (PV-0903). The step counter becomes the number sent, echoed or not.
   * Throws `ClientMessageError`; the counter is then unchanged.
   */
  inputMessage(encoder: ClientMessageEncoder, step: ClientInputStep, mode = 0, echo: ServerEcho = new ServerEcho()): Uint8Array {
    const envelope = step.envelope
    if (envelope === InputEnvelope.minimal) {
      if (
        step.rfcTransfer === undefined &&
        step.tableRowRecord === undefined &&
        step.controlFocus === undefined &&
        step.dataManager === undefined &&
        step.listFocus === undefined &&
        step.plainListWindow === undefined
      )
        return encoder.dialogMessageWithEvent(step.items, step.uiEvent, mode)
      return encoder.composeDialogMessage({ mode, modeStat: 0, stepNumber: undefined }, body => {
        const transfer = step.rfcTransfer
        if (transfer !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.rfcTR(transfer.sid), transfer.value, body)
        for (const item of step.items) {
          if (item.kind === "dynnCHL" && step.plainListWindow !== undefined) continue
          ClientMessageEncoder.appendClientItem(item, body)
        }
        // provenance: PV-1026 — plain CHL precedes the list event in the reference step.
        step.plainListWindow?.appendPlainItem(body)
        const record = step.tableRowRecord
        if (record !== undefined) ClientMessageEncoder.appendAPPL(TableRowRecord.item, record.bytes, body)
        const event = step.uiEvent
        if (event !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.uiEvent("uiEventSource"), event, body)
        appendListFocus(step.listFocus, body)
        // A control event goes with its focus and document in any envelope (PV-1016).
        const shell = step.controlFocus
        if (shell !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.dynt("controlFocus"), shell, body)
        const document = step.dataManager
        if (document !== undefined) appendXMLBLOB(document, body)
      })
    }
    const echoes = InputEnvelope.contains(envelope, InputEnvelope.echoes)
    return encoder.composeDialogMessage(
      {
        mode,
        modeStat: echoes ? echo.modeStat : 0,
        stepNumber: echoes ? echo.stepNumber : undefined,
        controlReply: InputEnvelope.contains(envelope, InputEnvelope.referenceHeader)
      },
      body => appendEnvelopeItems(step, echo, body)
    )
  },

  /**
   * The session's reply to control traffic in the shape SAP GUI replies (controls/transport.md §2.5,
   * Reading R-CT-26): the control-reply header (msg_info 0x01, PV-0908) with `mode` and `modeStat`,
   * then exactly DIALOG_STEP_NUMBER, the RFC_TR item and EOM (PV-0906), whatever the input envelope.
   * The step is `stepNumber`, the replied message's, when one is given, else the next
   * per-connection step; it becomes `lastStepNumber`, except that with `ownCount` (an envelope
   * without echoes, whose steps count their own) the counter never moves back: it becomes the step
   * only when that is higher. The reply without an RFC_TR item, "the envelope alone" (Reading
   * R-CT-24), has no three-item form: it is an input step in the envelope shape. Throws
   * `ClientMessageError`.
   */
  controlReply(encoder: ClientMessageEncoder, transfer: RFCTransferValue, options: ControlReplyOptions): Uint8Array {
    return encoder.composeDialogMessage(
      {
        mode: options.mode ?? 0,
        modeStat: options.modeStat ?? 0,
        stepNumber: options.stepNumber,
        controlReply: true,
        counterOnlyGrows: options.ownCount ?? false
      },
      body => ClientMessageEncoder.appendAPPL(ApplItem.rfcTR(transfer.sid), transfer.value, body)
    )
  }
} as const

/**
 * The items between DIALOG_STEP_NUMBER and EOM of a step with the reference envelope, in the order
 * of `ClientInput.inputMessage`. (Swift private `appendEnvelopeItems(_:echo:to:)`.)
 */
function appendEnvelopeItems(step: ClientInputStep, echo: ServerEcho, body: ByteWriter): void {
  const envelope = step.envelope
  const echoes = InputEnvelope.contains(envelope, InputEnvelope.echoes)
  const screenState = InputEnvelope.contains(envelope, InputEnvelope.screenState)
  const transfer = step.rfcTransfer
  if (transfer !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.rfcTR(transfer.sid), transfer.value, body)
  if (echoes && echo.ses !== undefined) {
    // Swift copies the echo's bytes into a `var` before changing them.
    const ses = echo.ses.slice()
    // provenance: PV-1034 — native confirmation; preserve opaque bytes.
    if (step.nativeLogonSession && ses.length === SESValue.size) {
      ses[SESValue.Offset.eventArray] = 1
      ses[SESValue.Offset.screenFlag] = 0
    }
    appendSimple("ses", ses, body)
  } else {
    const ses = step.ses ?? (echoes ? new SESValue({ eventArray: 1 }) : undefined)
    if (ses !== undefined) ClientMessageEncoder.appendClientItem({ kind: "ses", value: ses }, body)
  }
  if (echoes && echo.codepageDiagGUI !== undefined)
    ClientMessageEncoder.appendAPPL(ApplItem.stSystemInfo("codepageDiagGUI"), echo.codepageDiagGUI, body)
  const code = step.functionCode
  if (code !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.varInfo("okcode"), code, body)
  const window = step.plainListWindow
  if (window !== undefined) {
    // provenance: PV-1026 — list-only step, replacing the stale dynpro carrier.
    window.appendPlainItem(body)
  } else {
    const chl = (InputEnvelope.contains(envelope, InputEnvelope.dynnCHL) ? echo.dynnCHL : undefined) ?? step.dynnCHL
    if (chl !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.dynn("chl"), chl, body)
  }
  if (screenState && echo.scrollInfos2 !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.varInfo("scrollInfos2"), echo.scrollInfos2, body)
  if (screenState && echo.containerReset !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.container("reset"), echo.containerReset, body)
  const guiCarriers = InputEnvelope.contains(envelope, InputEnvelope.guiCarriers)
  if (step.fieldCount > 0) {
    if (guiCarriers) ClientMessageEncoder.appendAPPL(ApplItem.dynt("atom"), step.atomBytes, body)
    else ClientMessageEncoder.appendClientItem({ kind: "dyntAtom", value: step.atomBytes }, body)
  } else if (guiCarriers && step.controlFocus === undefined && step.plainListWindow === undefined) {
    ClientMessageEncoder.appendAPPL(ApplItem.dynt("noFocus"), new Uint8Array(0), body)
  }
  const record = step.tableRowRecord
  if (record !== undefined) ClientMessageEncoder.appendAPPL(TableRowRecord.item, record.bytes, body)
  const event = step.uiEvent
  if (event !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.uiEvent("uiEventSource"), event, body)
  appendListFocus(step.listFocus, body)
  const shell = step.controlFocus
  if (shell !== undefined) {
    ClientMessageEncoder.appendAPPL(ApplItem.dynt("controlFocus"), shell, body)
  } else if (step.plainListWindow === undefined && InputEnvelope.contains(envelope, InputEnvelope.focus) && step.focus !== undefined) {
    ClientMessageEncoder.appendAPPL(ApplItem.dynt("focus1"), step.focus.bytes, body)
  }
  const document =
    step.dataManager ??
    (InputEnvelope.contains(envelope, InputEnvelope.dataManager) && event === undefined ? ClientDataManager.bareDocument : undefined)
  if (document !== undefined) appendXMLBLOB(document, body)
}

/** The VARINFO LIST_FOCUS item of a classic-list cursor (PV-0717, PV-1026), when the step has one. */
function appendListFocus(focus: ListFocus | undefined, body: ByteWriter): void {
  if (focus === undefined) return
  const value = new ByteWriter()
  focus.append(value)
  ClientMessageEncoder.appendAPPL(ApplItem.varInfo("listFocus"), value.toBytes(), body)
}

/** A simple item; an encoder error becomes `ClientMessageError.item`. (Swift private `appendSimple`.) */
function appendSimple(type: DiagItemType, value: Uint8Array, body: ByteWriter): void {
  try {
    DiagItemEncoder.appendSimple(type, value, body)
  } catch (error) {
    if (error instanceof DiagItemEncodingError) throw new ClientMessageError({ kind: "item", error: error.info })
    throw error
  }
}

/** An XMLBLOB item; an encoder error becomes `ClientMessageError.item`. */
function appendXMLBLOB(value: Uint8Array, body: ByteWriter): void {
  try {
    DiagItemEncoder.appendXMLBLOB(value, body)
  } catch (error) {
    if (error instanceof DiagItemEncodingError) throw new ClientMessageError({ kind: "item", error: error.info })
    throw error
  }
}

/** A byte array as Swift prints `[UInt8]`: `[90, 90]`. */
function byteList(bytes: Uint8Array): string {
  return `[${Array.from(bytes).join(", ")}]`
}

/** An SES value as Swift's `String(reflecting:)` of the struct prints its fields. */
function describeSES(ses: SESValue): string {
  return (
    `DiagCodec.SESValue(eventArray: ${ses.eventArray}, eventID1: ${ses.eventID1}, eventID2: ${ses.eventID2}, eventID3: ${ses.eventID3}, ` +
    `eventID4: ${ses.eventID4}, eventID5: ${ses.eventID5}, screenFlag: ${ses.screenFlag}, modalNumber: ${ses.modalNumber}, ` +
    `xPos: ${ses.xPos}, yPos: ${ses.yPos}, imode: ${ses.imode}, flag1: ${ses.flag1}, dimRow: ${ses.dimRow}, dimCol: ${ses.dimCol})`
  )
}
