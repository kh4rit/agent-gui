// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenInput.swift (MIT).

// The user's edits on one screen and the input step that returns them (docs/protocol/
// client-input.md §2, §3, R-CI-3, R-CI-4, R-CI-19; elements.md Readings R-EL-4 and R-EL-10).
//
// Swift's `extension Screen` of this file (`inputStep(edits:functionCode:trigger:flags:)`,
// `fieldStep`, `elementReturns`, `isLogonStep(_:)`, `encode` and their helpers) is the object
// `ScreenInput`, whose functions take the screen; `Screen.inputStep` and `Screen.isLogonStep` call
// them.

import {
  ClientInputError,
  ClientInputStep,
  CodePage,
  CodecSpecGap,
  DyntAtomHeader,
  DyntDialogFlags,
  DyntToggle,
  ElementValueReading,
  ReturnedField,
  TextEncoding,
  secretTranscoded,
  type ClientInputErrorInfo,
  type ClientInputStepFunctionTrigger,
  type Secret
} from "../codec/index.js"
import type { Screen } from "./screen.js"
import { ScreenElementID, type ScreenElement, type ScreenElementKind } from "./screenElement.js"
import { ScreenTextDecoding, characterCount } from "./screenLayout.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

// MARK: - Edits

/** One field's new value (Swift `FieldEdits.Value`, internal): a text, or for a password field a `Secret`. */
export type FieldEditValue = { readonly kind: "text"; readonly value: string } | { readonly kind: "secret"; readonly value: Secret }

/** A table row: its table and absolute line (Swift `FieldEdits.TableRowKey`, internal). */
export interface TableRowKey {
  readonly table: number
  readonly line: number
}

/**
 * The user's edits on one screen: the new value of each edited input field, by element id — a text,
 * or for a password field a DiagCodec `Secret` — and the element edits of elements.md Reading
 * R-EL-4.
 *
 * Values may be passwords, so the edits never print them: `description`, `toString()`, `toJSON()`
 * and `util.inspect` show only how many fields were edited, and the values live in private fields
 * that neither reflection nor `assert.deepStrictEqual` sees (IMPL-DA-1).
 *
 * Swift's subscript is `text(id)` and `setText(text, id)`; every setter takes the value first and
 * the element after it, as Swift's `set(_:for:)` does. A Swift struct: `clone()` copies it.
 */
export class FieldEdits {
  readonly #values = new Map<string, { id: ScreenElementID; value: FieldEditValue }>()
  /** The element edits of Reading R-EL-4, kept apart from the field texts: `ids`, `count` and `isEmpty` count field texts and secrets only. */
  readonly #checks = new Map<string, { id: ScreenElementID; checked: boolean }>()
  /** Selected radio buttons with the order they were selected in: within a group the latest wins, which the input step resolves with the screen. */
  readonly #radioSelections = new Map<string, { id: ScreenElementID; order: number }>()
  #radioSelectionCount = 0
  /** Dropdown keys; an undefined key is the empty entry. */
  readonly #dropdownKeys = new Map<string, { id: ScreenElementID; key: string | undefined }>()
  /** Row marks of table controls (Reading R-EL-10). */
  readonly #rowSelections = new Map<string, { row: TableRowKey; selected: boolean }>()

  /** A copy (Swift copies the struct on assignment); secrets are shared, not copied. */
  clone(): FieldEdits {
    const copy = new FieldEdits()
    for (const [key, entry] of this.#values) copy.#values.set(key, entry)
    for (const [key, entry] of this.#checks) copy.#checks.set(key, entry)
    for (const [key, entry] of this.#radioSelections) copy.#radioSelections.set(key, entry)
    copy.#radioSelectionCount = this.#radioSelectionCount
    for (const [key, entry] of this.#dropdownKeys) copy.#dropdownKeys.set(key, entry)
    for (const [key, entry] of this.#rowSelections) copy.#rowSelections.set(key, entry)
    return copy
  }

  // MARK: Element edits (elements.md Reading R-EL-4; pinned)

  /** Checks or unchecks the checkbox `id`. (Swift `setChecked(_:for:)`.) */
  setChecked(checked: boolean, id: ScreenElementID): void {
    this.#checks.set(id.mapKey, { id, checked })
  }

  /**
   * Selects the radio button `radio`. The group follows from the screen: the button the latest
   * `select` of the group chose is the selected one, and the others are deselected.
   */
  select(radio: ScreenElementID): void {
    this.#radioSelectionCount += 1
    this.#radioSelections.set(radio.mapKey, { id: radio, order: this.#radioSelectionCount })
  }

  /** Chooses `key` in the dropdown `id`; undefined chooses the empty entry. (Swift `setDropdownKey(_:for:)`.) */
  setDropdownKey(key: string | undefined, id: ScreenElementID): void {
    this.#dropdownKeys.set(id.mapKey, { id, key })
  }

  /** Marks or unmarks the row at absolute `line` of table `table` (Reading R-EL-10). (Swift `setTableRowSelected(_:line:table:)`.) */
  setTableRowSelected(selected: boolean, line: number, table: number): void {
    this.#rowSelections.set(`${table}/${line}`, { row: { table, line }, selected })
  }

  /**
   * The edited state of a checkbox (`setChecked`) or radio button (true once `select` chose it;
   * which button of a group wins is resolved with the screen), or undefined when the element has no
   * such edit.
   */
  isChecked(id: ScreenElementID): boolean | undefined {
    const check = this.#checks.get(id.mapKey)
    if (check !== undefined) return check.checked
    return this.#radioSelections.has(id.mapKey) ? true : undefined
  }

  /** The checkbox edits, by element (Swift internal `checkedEdits`). */
  get checkedEdits(): { id: ScreenElementID; checked: boolean }[] {
    return Array.from(this.#checks.values())
  }

  /** The selected radio buttons with their selection order, larger is later (Swift internal `radioSelectionOrder`). */
  get radioSelectionOrder(): { id: ScreenElementID; order: number }[] {
    return Array.from(this.#radioSelections.values())
  }

  /** The dropdown edits; an undefined key is the empty entry (Swift internal `dropdownEdits`). */
  get dropdownEdits(): { id: ScreenElementID; key: string | undefined }[] {
    return Array.from(this.#dropdownKeys.values())
  }

  /** The row marks by table and line (Swift internal `rowSelectionEdits`). */
  get rowSelectionEdits(): { row: TableRowKey; selected: boolean }[] {
    return Array.from(this.#rowSelections.values())
  }

  /** Whether any element edit of Reading R-EL-4 was made (checkboxes, radio buttons, dropdowns, row marks). */
  get hasElementEdits(): boolean {
    return this.#checks.size > 0 || this.#radioSelections.size > 0 || this.#dropdownKeys.size > 0 || this.#rowSelections.size > 0
  }

  // MARK: Field texts and secrets

  /** The new text of the element `id`: undefined when it has no edit or its edit is a secret. (Swift's subscript getter.) */
  text(id: ScreenElementID): string | undefined {
    const entry = this.#values.get(id.mapKey)
    return entry?.value.kind === "text" ? entry.value.value : undefined
  }

  /** Sets the new text of the element `id`, replacing any edit; undefined removes it. (Swift's subscript setter.) */
  setText(text: string | undefined, id: ScreenElementID): void {
    if (text === undefined) this.#values.delete(id.mapKey)
    else this.#values.set(id.mapKey, { id, value: { kind: "text", value: text } })
  }

  /**
   * Sets the new value of a password field as a `Secret`, replacing any edit. The secret's bytes are
   * the password in UTF-8; the input step transcodes them into the screen's code page
   * (`secretTranscoded`) without making a `string` of them. (Swift `set(_:for:)`.)
   */
  setSecret(secret: Secret, id: ScreenElementID): void {
    this.#values.set(id.mapKey, { id, value: { kind: "secret", value: secret } })
  }

  /** Removes the edit of the element `id`. */
  remove(id: ScreenElementID): void {
    this.#values.delete(id.mapKey)
  }

  /** Whether the element `id` has an edit, a text or a secret. */
  contains(id: ScreenElementID): boolean {
    return this.#values.has(id.mapKey)
  }

  /** The ids of the edited elements, in order (`ScreenElementID.compare`). */
  get ids(): ScreenElementID[] {
    return Array.from(this.#values.values(), entry => entry.id).sort(ScreenElementID.compare)
  }

  /** The number of edited elements. */
  get count(): number {
    return this.#values.size
  }

  get isEmpty(): boolean {
    return this.#values.size === 0
  }

  /** The edit of `id` (Swift internal `value(_:)`). */
  value(id: ScreenElementID): FieldEditValue | undefined {
    return this.#values.get(id.mapKey)?.value
  }

  /** Counts only: values may be passwords. */
  get description(): string {
    return `FieldEdits(${this.#values.size} fields)`
  }

  get debugDescription(): string {
    return this.description
  }

  toString(): string {
    return this.description
  }

  /** The description, so that `JSON.stringify` writes no value. */
  toJSON(): string {
    return this.description
  }

  /** The description, so that `util.inspect` shows no value (Swift's empty `customMirror`). */
  [INSPECT](): string {
    return this.description
  }
}

/**
 * The dlg flags a returned field carries (client-input.md §3, R-CI-4).
 * - `asReceived`: the flags the field was received with. The reading of R-CI-4: the reference client
 *   returns each field with the constant flags the screen carried, and no source shows a per-edit
 *   "changed" bit. The default.
 * - `markedChanged`: the codec's changed marking, `ReturnedField.markedChanged()`. While which bit
 *   marks a field changed is spec gap #34, the codec refuses it, and the step fails with
 *   `ScreenInputError` `field`.
 */
export type ReturnedFieldFlags = "asReceived" | "markedChanged"

// MARK: - Errors

/**
 * Why an input step could not be built from a screen and the user's edits. No error carries a
 * field's text.
 * - `unknownElement`: no element of the screen has this id.
 * - `notEditable`: the element is not an input field, or it is PROTECTED.
 * - `tooLong`: the text has more characters than the field's maxnrchars (PV-0651).
 * - `field`: the codec refused the field: an EFIELD (101) whose widths are unknown (IMPL-DA-2), a
 *   text longer than dlen's one byte, or the changed marking of #34.
 * - `functionCode`: the codec refused the function code or the function: the `specGap` trigger
 *   (which item carries it is #55), a code longer than an APPL value, or a function the screen does
 *   not offer enabled (`ClientInputError` `function`).
 * - `notEncodable`: the field's text, or the password, holds a character the screen's code page
 *   cannot represent (ISO 8859-1 above U+00FF, session.md §6.4). Undefined names the function code.
 * - `notOffered`: the element does not offer what the trigger asks of it: for example value help on
 *   a field without MATCHCODE (elements.md Reading R-EL-15; allowed with a flag).
 * - `specGap`: the screen's code page is none Swooey knows (#18), and the text is not ASCII, which
 *   reads the same in every ASCII-compatible code page (session.md §6.4).
 */
export type ScreenInputErrorInfo =
  | { readonly kind: "unknownElement"; readonly value: ScreenElementID }
  | { readonly kind: "notEditable"; readonly value: ScreenElementID }
  | { readonly kind: "tooLong"; readonly value: ScreenElementID; readonly maxLength: number }
  | { readonly kind: "field"; readonly value: ScreenElementID; readonly error: ClientInputErrorInfo }
  | { readonly kind: "functionCode"; readonly value: ClientInputErrorInfo }
  | { readonly kind: "notEncodable"; readonly value: ScreenElementID | undefined }
  | { readonly kind: "notOffered"; readonly value: ScreenElementID }
  | { readonly kind: "specGap"; readonly issue: number }

export class ScreenInputError extends Error {
  constructor(readonly info: ScreenInputErrorInfo) {
    super(describeScreenInputError(info))
    this.name = "ScreenInputError"
  }
}

/** The error in words: element ids and the codec's reason, never a field's text. */
function describeScreenInputError(info: ScreenInputErrorInfo): string {
  switch (info.kind) {
    case "unknownElement":
      return `input step: no element ${info.value.description}`
    case "notEditable":
      return `input step: ${info.value.description} is not editable`
    case "tooLong":
      return `input step: ${info.value.description} takes at most ${info.maxLength}`
    case "field":
      return `input step: ${info.value.description}: ${new ClientInputError(info.error).message}`
    case "functionCode":
      return `input step: the function: ${new ClientInputError(info.value).message}`
    case "notEncodable":
      return `input step: ${info.value === undefined ? "the function code" : info.value.description} is not encodable in the screen's code page`
    case "notOffered":
      return `input step: ${info.value.description} does not offer it`
    case "specGap":
      return `input step: spec gap #${info.issue}`
  }
}

/** Runs `body`; a codec refusal of the field becomes `ScreenInputError` `field` of `id`. */
function forField<T>(id: ScreenElementID, body: () => T): T {
  try {
    return body()
  } catch (error) {
    if (error instanceof ClientInputError) throw new ScreenInputError({ kind: "field", value: id, error: error.info })
    throw error
  }
}

// MARK: - Element returns (elements.md Readings R-EL-4 and R-EL-10)

/**
 * What goes back for one checkbox, radio button or dropdown (Swift `Screen.ElementReturn`, internal).
 * - `toggle`: a checkbox or radio button with its new state; for a radio button, whether dlg_flag_2
 *   0x80 is set (the selected button) or cleared (PV-0964); undefined for a checkbox.
 * - `dropdown`: a dropdown's chosen key; undefined is the empty entry.
 */
export type ElementReturn =
  | { readonly kind: "toggle"; readonly isChecked: boolean; readonly selectedRadio: boolean | undefined }
  | { readonly kind: "dropdown"; readonly key: string | undefined }

/** The element returns of a step, by element (`ScreenElementID.mapKey`). */
export type ElementReturns = Map<string, { id: ScreenElementID; value: ElementReturn }>

/** The first byte value that is not ASCII. */
const FIRST_NON_ASCII = 0x80

/** Swift `UInt16(clamping:)`. */
function clampU16(value: number): number {
  return Math.min(Math.max(value, 0), 0xffff)
}

// MARK: - Screen members (Swift's `extension Screen`)

/** The members Swift's `extension Screen` of ScreenInput.swift adds; `Screen` calls the public ones. */
export const ScreenInput = {
  /**
   * The input step that submits `screen`: an EFIELD_2 atom for every edited input field
   * (client-input.md §2, R-CI-3), in screen order, and the function code when one is given.
   *
   * - Only edited fields are returned. A field whose new text equals the text it was received with,
   *   trailing spaces and zero characters aside, is left out (R-CI-3: "only edited fields are sent";
   *   a field received as zero bytes is empty, R-DA-11); a password field and a secret are never
   *   compared, as a password's text is never decoded.
   * - **Except in the logon step** (`isLogonStep`: the logon screen, not a server error, with the
   *   password field edited): there every editable field that holds a value goes back, edited or
   *   not, with its edit or else with the text it was received with, and an empty field that was not
   *   edited stays out (Reading R-CI-19). The owner's server did not accept a logon step that left
   *   the prefilled client out, and accepted the one that returned it (client-input.md §11.7,
   *   PV-0783, PV-0784).
   * - Each field is returned at its block, row and column with the widths, area, group, attributes
   *   and flag1 it was received with (`ReturnedField.received`), and its dlg flags per `flags`: as
   *   received by default (R-CI-4).
   * - A text edit is sent in the screen's code page (`Screen.textEncoding`; ASCII only when the code
   *   page is unknown, #18), not padded, and may have at most the field's maxnrchars characters. A
   *   secret, UTF-8, may have at most maxnrchars bytes (credentials.md §5.1) and is sent transcoded
   *   into the code page.
   * - `functionCode` (a command typed in the OK-code field, a function key's code) goes to
   *   `ClientInputStep.setFunctionCode` in the same code page, carried as `trigger` says: by default
   *   the VARINFO OKCODE item of client-input.md Reading R-CI-6, or `specGap` to refuse it while #55
   *   is open. Undefined submits the fields alone, which is what Enter sends in the reference
   *   client's logon input (client-input.md §7.4).
   *
   * Nothing is sent here: the session wraps the step with DIALOG_STEP_NUMBER and EOM. The function
   * triggers of client-input.md §7.5 are the other form of `Screen.inputStep`; this form sends a
   * command. (Swift `inputStep(edits:functionCode:trigger:flags:)`.)
   */
  inputStep(
    screen: Screen,
    edits: FieldEdits,
    options: { functionCode?: string | undefined; trigger?: ClientInputStepFunctionTrigger; flags?: ReturnedFieldFlags } = {}
  ): ClientInputStep {
    const step = ScreenInput.fieldStep(screen, edits, options.flags ?? "asReceived", false)
    if (options.functionCode !== undefined) {
      const bytes = ScreenInput.encode(screen, options.functionCode, undefined)
      try {
        step.setFunctionCode(bytes, options.trigger ?? "varInfoOKCode")
      } catch (error) {
        if (error instanceof ClientInputError) throw new ScreenInputError({ kind: "functionCode", value: error.info })
        throw error
      }
    }
    return step
  },

  /**
   * The step with the edited fields only (R-CI-3), their dlg flags per `flags`, and with bit 0x01 of
   * dlg_flag_2 set on top when `changedBit` is (the reference envelope's Reading R-CI-13); the
   * changed checkboxes, radio buttons, dropdowns and row marks go back among them in screen order,
   * as `elementValues` says (elements.md Readings R-EL-4 and R-EL-10). (Swift internal `fieldStep`.)
   */
  fieldStep(
    screen: Screen,
    edits: FieldEdits,
    flags: ReturnedFieldFlags,
    changedBit: boolean,
    elementValues: ElementValueReading = new ElementValueReading()
  ): ClientInputStep {
    const known = new Set(screen.elements.map(element => element.id.mapKey))
    for (const id of edits.ids) if (!known.has(id.mapKey)) throw new ScreenInputError({ kind: "unknownElement", value: id })
    const returns = ScreenInput.elementReturns(screen, edits, elementValues)
    const step = new ClientInputStep()
    const returnsHeldValues = ScreenInput.isLogonStep(screen, edits)
    for (const element of screen.elements) {
      const returned = returns.get(element.id.mapKey)
      if (returned !== undefined) {
        appendReturn(screen, returned.value, element, flags, changedBit, elementValues, step)
        continue
      }
      const value = edits.value(element.id)
      if (value === undefined) {
        // In the logon step a field that holds a value goes back as received (R-CI-19).
        if (!(returnsHeldValues && element.kind.kind === "input" && element.isEditable && !element.isPassword)) continue
        appendReceived(screen, element, flags, changedBit, step)
        continue
      }
      if (!element.isEditable) throw new ScreenInputError({ kind: "notEditable", value: element.id })
      switch (value.kind) {
        case "text": {
          const text = value.value
          if (!element.isPassword && element.text !== undefined && element.text === ScreenTextDecoding.trimmingPadding(text)) {
            // Unchanged: left out, except that the logon step returns it as received.
            if (returnsHeldValues) appendReceived(screen, element, flags, changedBit, step)
            continue
          }
          if (element.maxLength !== undefined && characterCount(text) > element.maxLength)
            throw new ScreenInputError({ kind: "tooLong", value: element.id, maxLength: element.maxLength })
          const bytes = ScreenInput.encode(screen, text, element.id)
          const field = returnedField(element, flags, changedBit)
          forField(element.id, () => step.appendField(field, bytes))
          break
        }
        case "secret": {
          const secret = value.value
          if (element.maxLength !== undefined && !secret.fits(element.maxLength))
            throw new ScreenInputError({ kind: "tooLong", value: element.id, maxLength: element.maxLength })
          const encoded = encodeSecret(screen, secret, element.id)
          try {
            const field = returnedField(element, flags, changedBit)
            forField(element.id, () => step.appendSecretField(field, encoded))
          } finally {
            // A transcoded copy is this step's own: wiped once it is in the atoms.
            if (encoded !== secret) encoded.dispose()
          }
          break
        }
      }
    }
    return step
  },

  /**
   * The elements whose edits change them, and what each returns (R-EL-4): checkboxes and row marks
   * (R-EL-10) whose state differs from the received one, the radio groups whose selection moved
   * (`ElementValueReading.radios`), dropdowns whose key differs. Throws for an element that is not on
   * the screen, not of the edit's kind, PROTECTED, or whose body stayed opaque, and, under the
   * `specGap` returns, for any return at all. (Swift internal `elementReturns(_:reading:)`.)
   */
  elementReturns(screen: Screen, edits: FieldEdits, reading: ElementValueReading): ElementReturns {
    const result: ElementReturns = new Map()
    if (!edits.hasElementEdits) return result
    const set = (id: ScreenElementID, value: ElementReturn | undefined) => {
      if (value === undefined) result.delete(id.mapKey)
      else result.set(id.mapKey, { id, value })
    }
    for (const { id, checked } of edits.checkedEdits.sort((a, b) => ScreenElementID.compare(a.id, b.id))) {
      const received = receivedToggle(screen, id, "checkbox")
      set(id, checked === received ? undefined : { kind: "toggle", isChecked: checked, selectedRadio: undefined })
    }
    const rows = edits.rowSelectionEdits.sort((a, b) => a.row.table - b.row.table || a.row.line - b.row.line)
    for (const { row, selected } of rows) {
      const table = screen.tables.find(candidate => candidate.id === row.table)
      const held = table?.rows.find(candidate => candidate.line === row.line)
      const selector = held?.selector
      // Only a row this screen carries with a selector can be marked (R-EL-10, #110).
      if (selector === undefined) throw new ScreenInputError({ kind: "specGap", issue: CodecSpecGap.tableControlItems })
      const received = receivedToggle(screen, selector, "checkbox")
      set(selector, selected === received ? undefined : { kind: "toggle", isChecked: selected, selectedRadio: undefined })
    }
    radioReturns(screen, edits, reading, set)
    for (const { id, key } of edits.dropdownEdits.sort((a, b) => ScreenElementID.compare(a.id, b.id))) {
      const element = screen.element(id)
      if (element === undefined) throw new ScreenInputError({ kind: "unknownElement", value: id })
      const dropdown = element.dropdown
      if (element.kind.kind !== "dropdown" || element.isProtected || dropdown === undefined) throw new ScreenInputError({ kind: "notEditable", value: id })
      if (key !== undefined) {
        if (!dropdown.options.some(option => option.key === key)) throw new ScreenInputError({ kind: "notOffered", value: id })
      } else if (!dropdown.allowsEmpty) {
        throw new ScreenInputError({ kind: "notOffered", value: id })
      }
      set(id, key === dropdown.selectedKey ? undefined : { kind: "dropdown", key })
    }
    if (reading.returns === "specGap" && result.size > 0) {
      const first = Array.from(result.values(), entry => entry.id).sort(ScreenElementID.compare)[0]
      const issue = screen.element(first)?.kind.kind === "dropdown" ? CodecSpecGap.dropdownValues : CodecSpecGap.toggleElements
      throw new ScreenInputError({ kind: "field", value: first, error: { kind: "specGap", issue } })
    }
    return result
  },

  /**
   * Whether `edits` make the logon step, which returns every field that holds a value, changed or not
   * (Reading R-CI-19, client-input.md §11.7): this is the logon screen, no server error, and the
   * password field is edited. Every other step, on the logon screen too, returns the edited fields
   * only.
   */
  isLogonStep(screen: Screen, edits: FieldEdits): boolean {
    return screen.isLogonScreen && !screen.isServerError && screen.elements.some(element => element.isPassword && edits.contains(element.id))
  },

  /** `text` in the screen's code page; for a code page Swooey does not know, ASCII only. (Swift internal `encode(_:element:)`.) */
  encode(screen: Screen, text: string, element: ScreenElementID | undefined): Uint8Array {
    if (!screen.knowsCodePage) {
      for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) >= FIRST_NON_ASCII) throw new ScreenInputError({ kind: "specGap", issue: CodecSpecGap.codePageValues })
      }
    }
    const bytes = TextEncoding.encode(screen.textEncoding, text)
    if (bytes === undefined) throw new ScreenInputError({ kind: "notEncodable", value: element })
    return bytes
  }
} as const

/**
 * The received state of the toggle `id` of `kind`; throws when it is not one, is PROTECTED, or its
 * body stayed opaque (#107).
 */
function receivedToggle(screen: Screen, id: ScreenElementID, kind: ScreenElementKind["kind"]): boolean {
  const element = screen.element(id)
  if (element === undefined) throw new ScreenInputError({ kind: "unknownElement", value: id })
  if (element.kind.kind !== kind || element.isProtected) throw new ScreenInputError({ kind: "notEditable", value: id })
  const received = element.isChecked
  if (received === undefined) throw new ScreenInputError({ kind: "field", value: id, error: { kind: "specGap", issue: CodecSpecGap.toggleElements } })
  return received
}

/**
 * The radio buttons that go back: per group, the button the latest `FieldEdits.select` chose, when
 * it is not the received selection, with the others as `ElementValueReading.radios` says (R-EL-4).
 */
function radioReturns(
  screen: Screen,
  edits: FieldEdits,
  reading: ElementValueReading,
  set: (id: ScreenElementID, value: ElementReturn | undefined) => void
): void {
  // The latest selection per group; an ungrouped button is its own group.
  const chosen = new Map<string, { group: NonNullable<ScreenElement["radioGroup"]>; id: ScreenElementID; order: number }>()
  const ungrouped: ScreenElementID[] = []
  for (const { id, order } of edits.radioSelectionOrder.sort((a, b) => a.order - b.order)) {
    // A button of a group may have a state that was not read (#107, issue #149): the group then
    // returns whole below. An ungrouped one needs its state.
    const group = screen.element(id)?.radioGroup
    if (group === undefined) {
      receivedToggle(screen, id, "radioButton")
      ungrouped.push(id)
      continue
    }
    const button = screen.element(id)
    if (button === undefined || button.kind.kind !== "radioButton" || button.isProtected) throw new ScreenInputError({ kind: "notEditable", value: id })
    chosen.set(group.mapKey, { group, id, order })
  }
  for (const id of ungrouped) {
    if (screen.element(id)?.isChecked !== true) set(id, { kind: "toggle", isChecked: true, selectedRadio: true })
  }
  for (const selection of chosen.values()) {
    const members = screen.radioGroups.find(group => group.id.mapKey === selection.group.mapKey)
    if (members === undefined) continue
    // A group with a state that was not read has no known selection: the chosen button goes back
    // selected and every other one deselected, since any of them may be the one it replaces
    // (Reading R-EL-4, issue #149).
    if (members.members.some(member => screen.element(member)?.isChecked === undefined)) {
      for (const member of members.members) {
        const isChosen = ScreenElementID.equals(member, selection.id)
        if (isChosen || reading.radios !== "selectedOnly") set(member, { kind: "toggle", isChecked: isChosen, selectedRadio: isChosen })
      }
      continue
    }
    const previous = members.selected
    if (ScreenElementID.equals(previous, selection.id)) continue
    switch (reading.radios) {
      case "changedButtons":
        set(selection.id, { kind: "toggle", isChecked: true, selectedRadio: true })
        if (previous !== undefined) set(previous, { kind: "toggle", isChecked: false, selectedRadio: false })
        break
      case "selectedOnly":
        set(selection.id, { kind: "toggle", isChecked: true, selectedRadio: true })
        break
      case "wholeGroup":
        for (const member of members.members) {
          const isChosen = ScreenElementID.equals(member, selection.id)
          set(member, { kind: "toggle", isChecked: isChosen, selectedRadio: isChosen })
        }
        break
    }
  }
}

/**
 * Appends one element return (R-EL-4): the received header with the dlg flags per `flags` and
 * `changedBit` (and, for a radio button, 0x80 set or cleared), then the toggle's or dropdown's body.
 */
function appendReturn(
  screen: Screen,
  returned: ElementReturn,
  element: ScreenElement,
  flags: ReturnedFieldFlags,
  changedBit: boolean,
  reading: ElementValueReading,
  step: ClientInputStep
): void {
  const received = element.atom.header
  if (flags === "markedChanged") throw new ScreenInputError({ kind: "field", value: element.id, error: { kind: "specGap", issue: CodecSpecGap.dyntDialogFlags } })
  let dialogFlags = received.dialogFlags
  if (changedBit) dialogFlags = dialogFlags.withChangedBit()
  if (returned.kind === "toggle" && returned.selectedRadio !== undefined) {
    const flag2 = returned.selectedRadio ? dialogFlags.flag2 | DyntToggle.selectedRadioFlag : dialogFlags.flag2 & ~DyntToggle.selectedRadioFlag & 0xff
    dialogFlags = new DyntDialogFlags({ flag1: dialogFlags.flag1, flag2 })
  }
  const header = new DyntAtomHeader({
    etype: received.etype,
    dialogFlags,
    area: received.area,
    block: received.block,
    group: received.group,
    row: received.row,
    col: received.col,
    attributes: received.attributes
  })
  switch (returned.kind) {
    case "toggle":
      forField(element.id, () =>
        step.appendToggle(header, { isChecked: returned.isChecked, visibleLength: clampU16(element.width ?? 0), trailingZero: reading.trailingZero })
      )
      break
    case "dropdown": {
      // A dropdown always has its received body (R-EL-3).
      const body = element.dropdownBody ?? { flag1: 0, mlen: 0, maxNrChars: 0 }
      const bytes = ScreenInput.encode(screen, returned.key ?? "", element.id)
      forField(element.id, () => step.appendDropdown(header, { flag1: body.flag1, mlen: body.mlen, maxNrChars: body.maxNrChars, key: bytes }))
      break
    }
  }
}

/**
 * Appends `element` with the text it was received with, when that text is not empty (Reading
 * R-CI-19); a field that holds no value is left out.
 */
function appendReceived(screen: Screen, element: ScreenElement, flags: ReturnedFieldFlags, changedBit: boolean, step: ClientInputStep): void {
  const received = element.text
  if (received === undefined || received.length === 0) return
  const bytes = ScreenInput.encode(screen, received, element.id)
  const field = returnedField(element, flags, changedBit)
  forField(element.id, () => step.appendField(field, bytes))
}

/** The field an input element returns, its dlg flags per `flags`, with the changed bit of R-CI-13 when `changedBit` is set. */
function returnedField(element: ScreenElement, flags: ReturnedFieldFlags, changedBit: boolean): ReturnedField {
  return forField(element.id, () => {
    const field = ReturnedField.received(element.atom)
    const flagged = flags === "asReceived" ? field : field.markedChanged()
    return changedBit ? flagged.withChangedBit() : flagged
  })
}

/**
 * The UTF-8 `secret` in the screen's code page; for a code page Swooey does not know, ASCII only.
 * The check reads the bytes without keeping them. (Swift's private `encode(_:element:)` for a
 * `Secret`.)
 */
function encodeSecret(screen: Screen, secret: Secret, element: ScreenElementID): Secret {
  if (!screen.knowsCodePage && !secret.withBytes(bytes => CodePage.isASCII(bytes))) {
    throw new ScreenInputError({ kind: "specGap", issue: CodecSpecGap.codePageValues })
  }
  if (screen.textEncoding === "utf8") return secret
  const encoded = secretTranscoded(secret, screen.textEncoding)
  if (encoded === undefined) throw new ScreenInputError({ kind: "notEncodable", value: element })
  return encoded
}
