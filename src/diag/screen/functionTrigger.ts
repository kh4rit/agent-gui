// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/FunctionTrigger.swift (MIT).

// What the user did to submit a screen (docs/protocol/client-input.md §7.5), the Readings that
// choose how it is sent (`FunctionReadings`) and how a screen is decoded (`ScreenReadings`), and the
// input step for a trigger.
//
// Swift's `extension Screen` of this file (`inputStep(edits:trigger:readings:flags:cursor:listCursor:)`,
// `statusButtonCode(forFunction:)` and their helpers) is the object `FunctionTriggerStep`, whose
// functions take the screen; `Screen.inputStep` (with a trigger) and `Screen.statusButtonCode` call
// them.

import {
  ClientInputError,
  CodecSpecGap,
  CursorContainerReading,
  ElementValueReading,
  FunctionKeyOKCode,
  GUIFunctionNumber,
  InputEnvelope,
  InputFocus,
  ListFocus,
  ListFunctionNumber,
  PageKey,
  ReturnedField,
  ScreenValueEncodingError,
  TableRowRecord,
  UIControlType,
  UIEventFunctionKey,
  isUInt16,
  isUInt8,
  type CheckboxReading,
  type ClientInputStep,
  type ClientInputStepFunctionTrigger,
  type DropdownReading,
  type DyntButtonStringReading,
  type FieldMarkerReading,
  type ListBoxReading,
  type ListPagingReading,
  type ListReading,
  type ListWindowReading,
  type MessageTypeReading,
  type PopupReading,
  type RadioGroupReading,
  type TableReading,
  type TableScrollReading,
  type TableScrollStateReading,
  type TabstripReading,
  ValueHelpReading,
  type ClientInputErrorInfo,
  type UIEventDataWidth
} from "../codec/index.js"
import { ByteWriter, bytesEqual } from "../wire/index.js"
import type { Screen } from "./screen.js"
import type { RequiredMarkerReading } from "./screenCarry.js"
import { ScreenElementID, type ScreenElement } from "./screenElement.js"
import type { ScreenFunction } from "./screenFunction.js"
import { ScreenInput, ScreenInputError, type FieldEdits, type ReturnedFieldFlags } from "./screenInput.js"
import { ScreenTextDecoding, TextMarkup, characterCount } from "./screenLayout.js"
import { MultipleLogonQuestion } from "./screenLogon.js"
import type { WindowSectionReading } from "./screenPopup.js"

/**
 * What F2, a double-click or a hotspot click chooses (elements.md Reading R-EL-12).
 * - `element`: a field or a table cell: the cursor on the element.
 * - `list`: a list position, SBA row and column as received (area 0).
 */
export type ScreenPick = { readonly kind: "element"; readonly value: ScreenElementID } | { readonly kind: "list"; readonly row: number; readonly column: number }

export const ScreenPick = {
  element: (value: ScreenElementID): ScreenPick => ({ kind: "element", value }),
  list: (row: number, column: number): ScreenPick => ({ kind: "list", row, column })
} as const

/**
 * What the user did to submit a screen (docs/protocol/client-input.md §7.5). Pinned API between the
 * model and the app.
 * - `enter`: Enter: the fields alone (Reading R-CI-11), or function number 0 in UI_EVENT_SOURCE when
 *   `FunctionReadings.enter` says so.
 * - `virtualKey`: a virtual key: a function key (F1 = 1 … Ctrl+Shift+F12 = 48), Ctrl+S = 11, a page
 *   key and so on (PV-0731). 0 is Enter. A key no function of the screen has fires anyway, and the
 *   server decides; a key whose function the screen offers disabled is refused (for example Save on
 *   a screen whose GUI status binds no 11). It is sent as `FunctionReadings.functionKey` says: by
 *   default as VARINFO OKCODE text (Reading R-CI-20).
 * - `function`: a function the screen offers (`Screen.functions`): a push button or tab sends its
 *   code in VARINFO OKCODE (PV-0773), any other function its virtual key as `virtualKey` does.
 * - `okCode`: a command typed into the command field (the transaction field), sent as it is typed,
 *   without padding, in VARINFO OKCODE (Reading R-CI-6, PV-0773): a transaction code, `/n` and a
 *   code, a function code such as `=ZZASK`. An empty command is Enter.
 * - `scrollTable`: scroll table `id` so that `firstRow` (from 1) is the first visible row: the DYNT
 *   09/05 row record after the atoms, with no function (elements.md Reading R-EL-9). Paging stays
 *   `virtualKey` 80–83.
 * - `valueHelp`: F4 on a field: function number 4 with the cursor on it (elements.md Reading
 *   R-EL-15).
 * - `choose`: F2, a double-click or a hotspot click: function number 2 with the cursor there
 *   (elements.md Reading R-EL-12).
 * - `elementFunction`: a checkbox's, radio button's or dropdown's own function code in VARINFO
 *   OKCODE, with its new state in the same step (elements.md Reading R-EL-4).
 */
export type FunctionTrigger =
  | { readonly kind: "enter" }
  | { readonly kind: "virtualKey"; readonly value: number }
  | { readonly kind: "function"; readonly value: ScreenFunction }
  | { readonly kind: "okCode"; readonly value: string }
  | { readonly kind: "scrollTable"; readonly id: number; readonly firstRow: number }
  | { readonly kind: "valueHelp"; readonly value: ScreenElementID }
  | { readonly kind: "choose"; readonly value: ScreenPick }
  | { readonly kind: "elementFunction"; readonly value: ScreenElementID }

export const FunctionTrigger = {
  enter: { kind: "enter" } as FunctionTrigger,
  virtualKey: (value: number): FunctionTrigger => ({ kind: "virtualKey", value }),
  function: (value: ScreenFunction): FunctionTrigger => ({ kind: "function", value }),
  okCode: (value: string): FunctionTrigger => ({ kind: "okCode", value }),
  scrollTable: (id: number, firstRow: number): FunctionTrigger => ({ kind: "scrollTable", id, firstRow }),
  valueHelp: (value: ScreenElementID): FunctionTrigger => ({ kind: "valueHelp", value }),
  choose: (value: ScreenPick): FunctionTrigger => ({ kind: "choose", value }),
  elementFunction: (value: ScreenElementID): FunctionTrigger => ({ kind: "elementFunction", value })
} as const

/**
 * How Enter is sent (#55) (Swift `FunctionReadings.Enter`).
 * - `fieldsOnly`: Reading R-CI-11, the default: the fields alone, no OKCODE and no UI event, as
 *   pysap's example client and ODG's client send it (a real GUI's Enter fires an empty function
 *   code, PV-0773).
 * - `functionKeyZero`: function number 0 in UI_EVENT_SOURCE, which pysap's example server reads as
 *   Enter (PV-0725).
 */
export type FunctionReadingsEnter = "fieldsOnly" | "functionKeyZero"

/**
 * How a function number is sent (#55; client-input.md §7.5, §7.6) (Swift
 * `FunctionReadings.FunctionKey`).
 * - `okCode`: Reading R-CI-20, the default: the function goes as VARINFO OKCODE text in the command
 *   step, with no UI event: the code of the screen's push button or tab captioned like the function
 *   when there is one (PV-0773), else `/` and the function number with two digits, the batch-input
 *   spelling of a function key (`FunctionKeyOKCode`, PV-0790). Commands in OKCODE work on a live
 *   system (PV-0787), where UI events were ignored (PV-0786); both MIT clients fire functions this
 *   way (PV-0789).
 * - `okCodeOrUIEvent`: the push button's code as `okCode`, else the UI event of `uiEventSource`.
 * - `uiEventSource`: Reading R-CI-10, Swooey's default up to 0.0.72: a UI_EVENT_SOURCE function-key
 *   event (PV-0771), with no OKCODE, as ODG observed a real GUI send it.
 * - `refused`: refused with spec gap #55: for a comparison run that sends commands only.
 */
export type FunctionReadingsFunctionKey = "okCode" | "okCodeOrUIEvent" | "uiEventSource" | "refused"
export const FunctionReadingsFunctionKey = {
  allCases: ["okCode", "okCodeOrUIEvent", "uiEventSource", "refused"] as readonly FunctionReadingsFunctionKey[]
} as const

/**
 * What a step that fires a UI event sends with it about the cursor (client-input.md §7.6) (Swift
 * `FunctionReadings.UIEventCursor`).
 * - `asEnvelope`: the default: what the envelope says. The DYNT_FOCUS_1, and the cursor field as
 *   received when no field was edited, go only when `InputEnvelope.focus` is part of it (R-CI-16).
 * - `focusAndCursorField`: Reading R-CI-21: whatever the envelope, the cursor field as received when
 *   no field was edited (PV-0779) and a DYNT_FOCUS_1 at the cursor after the event, as a witnessed
 *   GUI's F8 step and ODG's step builder send them (PV-0792).
 */
export type FunctionReadingsUIEventCursor = "asEnvelope" | "focusAndCursorField"
export const FunctionReadingsUIEventCursor = {
  allCases: ["asEnvelope", "focusAndCursorField"] as readonly FunctionReadingsUIEventCursor[]
} as const

/** The fields of `FunctionReadings`. */
export interface FunctionReadingsFields {
  enter: FunctionReadingsEnter
  functionKey: FunctionReadingsFunctionKey
  eventDataWidth: UIEventDataWidth
  eventControlType: UIControlType
  okCodeCarrier: ClientInputStepFunctionTrigger
  envelope: InputEnvelope
  elementValues: ElementValueReading
  tableScroll: TableScrollReading
  valueHelp: ValueHelpReading
  cursorContainers: CursorContainerReading
  listPaging: ListPagingReading
  uiEventCursor: FunctionReadingsUIEventCursor
}

/**
 * The choices the input step makes where the protocol spec is open (client-input.md §7.5). The
 * defaults are the Readings the public sources support best; each can be switched, for example in
 * the app's Connect sheet or in an owner-run experiment (D22). A Swift struct of `var`s: `clone()`
 * copies it.
 */
export class FunctionReadings implements FunctionReadingsFields {
  /** How Enter is sent (#55). */
  enter: FunctionReadingsEnter
  /** How a function number is sent: Reading R-CI-20 by default (#55). */
  functionKey: FunctionReadingsFunctionKey
  /** The event-data width of the UI_EVENT_SOURCE (Reading R-CI-9, #56). */
  eventDataWidth: UIEventDataWidth
  /**
   * The control type of the event: FIELD, as in ODG's sample (PV-0771), or DYNPRO, which pysap's
   * example server expects (PV-0725).
   */
  eventControlType: UIControlType
  /** How a command travels: VARINFO OKCODE (Reading R-CI-6, the default) or refused (#55). */
  okCodeCarrier: ClientInputStepFunctionTrigger
  /**
   * Which parts of the reference input envelope the step sends (client-input.md §11, Readings
   * R-CI-12 to R-CI-17). Default `InputEnvelope.minimal`, the step Swooey sent before; the app
   * chooses `InputEnvelope.default(identity)` of the session's identity.
   */
  envelope: InputEnvelope
  /** What goes back for checkboxes, radio buttons and dropdowns (elements.md Reading R-EL-4). */
  elementValues: ElementValueReading
  /** How a table is scrolled (elements.md Reading R-EL-9). */
  tableScroll: TableScrollReading
  /** How F4 is sent (elements.md Reading R-EL-15). */
  valueHelp: ValueHelpReading
  /** The cursor's container ids (elements.md Reading R-EL-17). */
  cursorContainers: CursorContainerReading
  /** How list page keys are sent (elements.md Reading R-EL-12). */
  listPaging: ListPagingReading
  /** What a UI-event step sends about the cursor (Reading R-CI-21). */
  uiEventCursor: FunctionReadingsUIEventCursor

  constructor(fields: Partial<FunctionReadingsFields> = {}) {
    this.enter = fields.enter ?? "fieldsOnly"
    this.functionKey = fields.functionKey ?? "okCode"
    this.eventDataWidth = fields.eventDataWidth ?? "fourBytes"
    this.eventControlType = fields.eventControlType ?? UIControlType.field
    this.okCodeCarrier = fields.okCodeCarrier ?? "varInfoOKCode"
    this.envelope = fields.envelope ?? InputEnvelope.minimal
    this.elementValues = fields.elementValues ?? new ElementValueReading()
    this.tableScroll = fields.tableScroll ?? "keysAndRowRecord"
    this.valueHelp = fields.valueHelp ?? "functionKey4"
    this.cursorContainers = fields.cursorContainers ?? "area"
    this.listPaging = fields.listPaging ?? "okCodes"
    this.uiEventCursor = fields.uiEventCursor ?? "asEnvelope"
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): FunctionReadings {
    return new FunctionReadings(this)
  }
}

/** The fields of `ScreenReadings`. */
export interface ScreenReadingsFields {
  buttonStrings: DyntButtonStringReading
  menuEntryPadding: boolean
  menuEnabledBySEL: boolean
  checkbox: CheckboxReading
  radioGroups: RadioGroupReading
  dropdown: DropdownReading
  tabstrip: TabstripReading
  table: TableReading
  tableScrollState: TableScrollStateReading
  fieldMarkers: FieldMarkerReading
  list: ListReading
  listBoxes: ListBoxReading
  listWindow: ListWindowReading
  popup: PopupReading
  messageType: MessageTypeReading
  requiredMarker: RequiredMarkerReading
  windowSections: WindowSectionReading
  nestedSubscreens: boolean
}

/**
 * The choices a screen decode makes where the protocol spec is open. Defaults are the Readings of
 * server-screen.md §8.7 and dynt-atoms.md, "Button strings". A Swift struct of `var`s: `clone()`
 * copies it.
 */
export class ScreenReadings implements ScreenReadingsFields {
  /** How push-button strings are found (Reading R-DA-9, #35). */
  buttonStrings: DyntButtonStringReading
  /** Whether zero bytes up to a menu entry's declared length are padding (Reading R-SS-8a, #50). */
  menuEntryPadding: boolean
  /** Whether a menu entry without SEL is disabled (Reading R-SS-12, #50); false enables every entry. */
  menuEnabledBySEL: boolean
  /** Checkbox and radio bodies (elements.md Reading R-EL-1). */
  checkbox: CheckboxReading
  /** Radio groups (elements.md Reading R-EL-2). */
  radioGroups: RadioGroupReading
  /** Dropdowns (elements.md Reading R-EL-3, invented). */
  dropdown: DropdownReading
  /** Tabstrips (elements.md Reading R-EL-5). */
  tabstrip: TabstripReading
  /** Table controls (elements.md Readings R-EL-7 and R-EL-10). */
  table: TableReading
  /** A table's scroll state (elements.md Reading R-EL-8). */
  tableScrollState: TableScrollStateReading
  /** Field markers and disabled buttons (elements.md Readings R-EL-16 and R-EL-19). */
  fieldMarkers: FieldMarkerReading
  /** Classic list output (elements.md Reading R-EL-11). */
  list: ListReading
  /** How a list's box runs are shown (elements.md Reading R-EL-20). */
  listBoxes: ListBoxReading
  /** Where a list's window state comes from without APPL DYNN CHL (elements.md Reading R-EL-21). */
  listWindow: ListWindowReading
  /** Popups (elements.md Reading R-EL-13). */
  popup: PopupReading
  /** Typed status messages (elements.md Reading R-EL-14). */
  messageType: MessageTypeReading
  /** The server's `?` in an empty required field (elements.md Reading R-EL-16a). */
  requiredMarker: RequiredMarkerReading
  /** A message's window sections (elements.md Reading R-EL-23). */
  windowSections: WindowSectionReading
  /** Experimental placement of containers nested in subscreens (issue #188). */
  nestedSubscreens: boolean

  constructor(fields: Partial<ScreenReadingsFields> = {}) {
    this.buttonStrings = fields.buttonStrings ?? "agreed"
    this.menuEntryPadding = fields.menuEntryPadding ?? true
    this.menuEnabledBySEL = fields.menuEnabledBySEL ?? true
    this.checkbox = fields.checkbox ?? "pv0655"
    this.radioGroups = fields.radioGroups ?? "areaBlockGroup"
    this.dropdown = fields.dropdown ?? "zzValueList"
    this.tabstrip = fields.tabstrip ?? "serverPaged"
    this.table = fields.table ?? "headerBlockZero"
    this.tableScrollState = fields.tableScrollState ?? "scrollInfosAfterContainer"
    this.fieldMarkers = fields.fieldMarkers ?? "flag1Bits"
    this.list = fields.list ?? "runsWithCHL"
    this.listBoxes = fields.listBoxes ?? "lineElements"
    this.listWindow = fields.listWindow ?? "chlOrScrollInfos"
    this.popup = fields.popup ?? "sesModalNumber"
    this.messageType = fields.messageType ?? "mestype2"
    this.requiredMarker = fields.requiredMarker ?? "questionMark"
    this.windowSections = fields.windowSections ?? "sesSections"
    this.nestedSubscreens = fields.nestedSubscreens ?? false
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): ScreenReadings {
    return new ScreenReadings(this)
  }

  /** Every Reading of elements.md at its fallback: the decode Swooey did before elements.md. */
  static get beforeElements(): ScreenReadings {
    return new ScreenReadings({
      checkbox: "specGap",
      radioGroups: "specGap",
      dropdown: "specGap",
      tabstrip: "specGap",
      table: "specGap",
      tableScrollState: "none",
      fieldMarkers: "specGap",
      list: "specGap",
      popup: "never",
      messageType: "messageOnly",
      listBoxes: "codes",
      listWindow: "dynnCHLOnly",
      requiredMarker: "literal",
      windowSections: "wholeMessage"
    })
  }
}

// MARK: - Screen members (Swift's `extension Screen`)

/** The options of the trigger form of `Screen.inputStep` (Swift's labelled parameters and their defaults). */
export interface TriggerStepOptions {
  readings?: FunctionReadings
  flags?: ReturnedFieldFlags
  cursor?: ScreenElementID | undefined
  /** A list position the cursor is on (issues #184, #186); only `ScreenPick` `list` on a list screen. */
  listCursor?: ScreenPick | undefined
}

/**
 * Where a fired function reports the cursor (R-CI-10): the element's received row and column (0, 0
 * without one) and the container ids of Reading R-EL-17. (Swift `Screen.FunctionTarget`, internal.)
 */
interface FunctionTarget {
  readonly row: number
  readonly col: number
  readonly containers: readonly number[]
}

/** Swift `UInt16(clamping:)`. */
function clampU16(value: number): number {
  return Math.min(Math.max(value, 0), 0xffff)
}

/** The target of `element` (Swift `FunctionTarget.init(_:readings:)`). */
function targetOf(element: ScreenElement | undefined, readings: FunctionReadings): FunctionTarget {
  return {
    row: element === undefined ? 0 : clampU16(element.row),
    col: element === undefined ? 0 : clampU16(element.column),
    containers: CursorContainerReading.containerIDs(readings.cursorContainers, element?.atom.area ?? 0)
  }
}

/** A codec refusal of the function: `ScreenInputError` `functionCode`. */
function functionRefused(info: ClientInputErrorInfo): ScreenInputError {
  return new ScreenInputError({ kind: "functionCode", value: info })
}

/** The members Swift's `extension Screen` of FunctionTrigger.swift adds; `Screen` calls them. */
export const FunctionTriggerStep = {
  /**
   * The input step that submits `screen` with `trigger` (client-input.md §7.5): the edited fields as
   * the command form of `Screen.inputStep` returns them, plus what the trigger sends.
   *
   * - `enter`, an empty `okCode` and virtual key 0: the fields alone, or function number 0 in
   *   UI_EVENT_SOURCE (`FunctionReadings.enter`).
   * - `okCode`: the command in VARINFO OKCODE, in the screen's code page.
   * - `virtualKey`: the function number as `FunctionReadings.functionKey` says. By default (Reading
   *   R-CI-20) VARINFO OKCODE text in the command step: the code of the screen's enabled push button
   *   or tab whose caption equals the caption of a GUI-status entry with that number, icon codes left
   *   out (`statusButtonCode`), else `/` and the number with two digits (`FunctionKeyOKCode`). Under
   *   Reading R-CI-10 a UI_EVENT_SOURCE function-key event with the number, the cursor at `cursor`'s
   *   row and column (0, 0 without one). A key whose every function the screen offers disabled is
   *   refused with `FunctionRefusal` `disabled`; a number outside 0…255 with
   *   `virtualKeyOutOfRange`.
   * - `function`: the function as this screen offers it (looked up by `ScreenFunction.id`, else
   *   `notOffered`), refused when disabled; a push button or tab sends its code in VARINFO OKCODE, any
   *   other function its virtual key as above. A menu item with neither is spec gap #55: which item
   *   fires a menu item bound to no function number is not known.
   *
   * Refusals come as `ScreenInputError` `functionCode` with `ClientInputError` `function` or
   * `specGap`. The step never carries both OKCODE and a UI event (PV-0773).
   *
   * The step carries the parts of the reference input envelope that `FunctionReadings.envelope`
   * names (client-input.md §11); the session adds what it echoes when it writes the step:
   * - `InputEnvelope.changedBit`: every edited field carries bit 0x01 of dlg_flag_2 (R-CI-13); a field
   *   whose edit equals its received text is left out, as always, except in the logon step, which
   *   returns every field that holds a value (R-CI-19, PV-0784).
   * - `InputEnvelope.focus`: a DYNT_FOCUS_1 for `cursor` when it is an input field, at its received
   *   row and column, with the column offset at the end of its text: the edit's characters, else the
   *   received text's; 0 in a password field (R-CI-16, IMPL-DA-1). On a step that fires a UI event
   *   and returns no edited field, the cursor field goes back as received, without the changed bit
   *   (PV-0779), unless it is a password field. `focusAndCursorField` sends both with every UI event
   *   whatever the envelope (Reading R-CI-21), and a function number fired as an OK-code (a key, a
   *   toolbar function, F2 choose, F4 value help, a list page key) sends the focus at the cursor
   *   whatever the envelope, since the command carries no position (Reading R-CI-20).
   *
   * The triggers of docs/protocol/elements.md, each switchable in `readings`:
   * - `scrollTable`: the DYNT 09/05 row record after the atoms and no function (Reading R-EL-9); only
   *   for the screen's first table, a row from 1 to 65,535.
   * - `valueHelp`: function number 4 with the cursor on the field, which must offer value help
   *   (MATCHCODE; Reading R-EL-15), else `ScreenInputError` `notOffered`.
   * - `choose`: function number 2 with the cursor on the element, or at a list position in area 0
   *   (Reading R-EL-12), and a DYNT_FOCUS_1 there when the envelope sends focus.
   * - `elementFunction`: the element's own code in VARINFO OKCODE, its new state among the returned
   *   elements (Reading R-EL-4).
   *
   * Checkbox, radio, dropdown and row-mark edits go back in the DYNT_ATOM item in screen order
   * (Readings R-EL-4, R-EL-10). A UI event names the cursor's container per
   * `FunctionReadings.cursorContainers` (Reading R-EL-17), and a list page key goes as the list
   * status's code under `ListPagingReading` `okCodes`, the default (Reading R-EL-12). (Swift
   * `inputStep(edits:trigger:readings:flags:cursor:listCursor:)`.)
   */
  inputStep(screen: Screen, edits: FieldEdits, trigger: FunctionTrigger, options: TriggerStepOptions = {}): ClientInputStep {
    const readings = options.readings ?? new FunctionReadings()
    const step = ScreenInput.fieldStep(
      screen,
      edits,
      options.flags ?? "asReceived",
      InputEnvelope.contains(readings.envelope, InputEnvelope.changedBit),
      readings.elementValues
    )
    step.envelope = readings.envelope
    // The element the cursor is on, and where the UI event reports it (R-CI-10, R-EL-17).
    let focusElement = options.cursor === undefined ? undefined : screen.element(options.cursor)
    // provenance: PV-1028 — native confirmation focuses the selected radio.
    const question = focusElement === undefined ? nativeLogonQuestion(screen) : undefined
    if (question !== undefined) {
      const buttons = Array.from(question.buttons.values())
      let changed: { id: ScreenElementID; order: number } | undefined
      for (const selection of edits.radioSelectionOrder) {
        if (!buttons.some(button => ScreenElementID.equals(button, selection.id))) continue
        if (changed === undefined || selection.order > changed.order) changed = selection
      }
      const selected = changed?.id ?? (question.selected === undefined ? undefined : question.buttons.get(question.selected))
      focusElement = selected === undefined ? undefined : screen.element(selected)
    }
    let target = targetOf(focusElement, readings)
    // The DYNT_FOCUS_1 of a list pick (R-EL-12), which names no element.
    let listFocus: InputFocus | undefined
    const listCursor = options.listCursor
    if (listCursor !== undefined && focusElement === undefined) {
      if (listCursor.kind !== "list" || screen.list === undefined || !isUInt16(listCursor.row) || !isUInt16(listCursor.column)) {
        throw functionRefused({ kind: "function", value: { kind: "notOffered" } })
      }
      target = { row: listCursor.row, col: listCursor.column, containers: Array.from(InputFocus.containerIDs) }
      listFocus = new InputFocus(listCursor.row, listCursor.column)
    }
    // Whether a function number went as an OK-code (R-CI-20), which carries no cursor.
    let firedAsOKCode = false
    switch (trigger.kind) {
      case "enter":
        enter(screen, step, readings, target)
        break
      case "okCode":
        if (trigger.value.length === 0) enter(screen, step, readings, target)
        else setCommand(screen, trigger.value, step, readings.okCodeCarrier)
        break
      case "virtualKey": {
        const number = trigger.value
        if (!isUInt8(number)) throw functionRefused({ kind: "function", value: { kind: "virtualKeyOutOfRange", value: number } })
        checkDeclared(screen, number)
        firedAsOKCode = fire(screen, number, step, readings, target)
        break
      }
      case "function": {
        const chosen = trigger.value
        const offered = screen.functions.find(candidate => candidate.id === chosen.id)
        if (offered === undefined) throw functionRefused({ kind: "function", value: { kind: "notOffered" } })
        if (!offered.isEnabled) throw functionRefused({ kind: "function", value: { kind: "disabled" } })
        if (offered.kind.kind === "pushButton" && offered.code !== undefined) {
          setCommand(screen, offered.code, step, readings.okCodeCarrier)
        } else if (offered.virtualKey !== undefined && isUInt8(offered.virtualKey)) {
          firedAsOKCode = fire(screen, offered.virtualKey, step, readings, target)
        } else if (offered.code !== undefined) {
          setCommand(screen, offered.code, step, readings.okCodeCarrier)
        } else {
          throw functionRefused({ kind: "specGap", issue: CodecSpecGap.functionTrigger })
        }
        break
      }
      case "scrollTable":
        scroll(screen, trigger.id, trigger.firstRow, step, readings)
        break
      case "valueHelp": {
        const field = screen.element(trigger.value)
        if (field === undefined) throw new ScreenInputError({ kind: "unknownElement", value: trigger.value })
        if (!field.hasValueHelp) throw new ScreenInputError({ kind: "notOffered", value: trigger.value })
        switch (readings.valueHelp) {
          case "functionKey4":
            checkDeclared(screen, ValueHelpReading.functionNumber)
            focusElement = field
            listFocus = undefined
            target = targetOf(field, readings)
            firedAsOKCode = fire(screen, ValueHelpReading.functionNumber, step, readings, target)
            break
          case "valueHelpEvent":
          case "specGap":
            throw functionRefused({ kind: "specGap", issue: CodecSpecGap.valueHelp })
        }
        break
      }
      case "choose": {
        checkDeclared(screen, ListFunctionNumber.choose)
        const pick = trigger.value
        switch (pick.kind) {
          case "element": {
            const chosen = screen.element(pick.value)
            if (chosen === undefined) throw new ScreenInputError({ kind: "unknownElement", value: pick.value })
            focusElement = chosen
            listFocus = undefined
            target = targetOf(chosen, readings)
            break
          }
          case "list": {
            if (screen.list === undefined || !isUInt16(pick.row) || !isUInt16(pick.column)) {
              throw functionRefused({ kind: "function", value: { kind: "notOffered" } })
            }
            // A list position is in area 0 (R-EL-12): the one container id 0.
            focusElement = undefined
            target = { row: pick.row, col: pick.column, containers: Array.from(InputFocus.containerIDs) }
            listFocus = new InputFocus(pick.row, pick.column)
            break
          }
        }
        firedAsOKCode = fire(screen, ListFunctionNumber.choose, step, readings, target)
        break
      }
      case "elementFunction": {
        const changed = screen.element(trigger.value)
        if (changed === undefined) throw new ScreenInputError({ kind: "unknownElement", value: trigger.value })
        const code = changed.firesFunction
        if (code === undefined || code.length === 0) throw new ScreenInputError({ kind: "notOffered", value: trigger.value })
        if (changed.isProtected) throw functionRefused({ kind: "function", value: { kind: "disabled" } })
        switch (readings.elementValues.function) {
          case "okCode":
            setCommand(screen, code, step, readings.okCodeCarrier)
            break
          case "stateChangedEvent":
          case "specGap": {
            const issue = changed.kind.kind === "dropdown" ? CodecSpecGap.dropdownValues : CodecSpecGap.toggleElements
            throw functionRefused({ kind: "specGap", issue })
          }
        }
        break
      }
    }
    const uiEvent = step.uiEvent
    if (uiEvent !== undefined && bytesEqual(uiEvent, UIEventFunctionKey.multipleLogonEnter) && focusElement !== undefined) {
      const chosen = focusElement
      step.focus = new InputFocus(chosen.atom.row, chosen.atom.col, 0, Uint8Array.from(target.containers))
      step.envelope = step.envelope | InputEnvelope.focus
      return step
    }
    const hasCursor = listFocus !== undefined || focusElement !== undefined
    const window = screen.diagnostics.plainListWindow
    if (listFocus !== undefined && step.fieldCount === 0 && window !== undefined) {
      // provenance: PV-1026 — live Display/F2 validation: plain list state and LIST_FOCUS.
      step.listFocus = new ListFocus({ version: 1, row: listFocus.row, col: listFocus.col })
      step.plainListWindow = window
      return step
    }
    const listCommandCursor = listCursor !== undefined && listFocus !== undefined && uiEvent === undefined
    if (!listCommandCursor && !sendsFocus(step, readings, firedAsOKCode && hasCursor)) return step
    step.envelope = step.envelope | InputEnvelope.focus
    if (listFocus !== undefined) {
      step.focus = listFocus
    } else if (focusElement !== undefined) {
      const field = focusElement
      if (field.isEditable) {
        focus(screen, field, edits, target.containers, step)
      } else if (trigger.kind === "choose") {
        // F2 on an output or a table cell: the cursor there (R-EL-12).
        step.focus = new InputFocus(field.atom.row, field.atom.col, 0, Uint8Array.from(target.containers))
      } else if (firedAsOKCode) {
        // The cursor on an output: where the UI event of R-CI-10 would have reported it.
        step.focus = new InputFocus(field.atom.row, field.atom.col, 0, Uint8Array.from(target.containers))
      }
    }
    return step
  },

  /**
   * The function code of `screen`'s push button or tab that stands for GUI-status function `number`
   * (Reading R-CI-20): the first enabled one, in screen order, whose caption equals the caption of an
   * entry of the GUI status with that number, both without their leading icon markup (R-DA-10) and
   * surrounding spaces; undefined when there is none. A status entry carries a function number but
   * no function code (PV-0791), while a push button's code travels as its OK-code (PV-0773);
   * open-diag-go's client pairs them by caption (PV-0789). The standard toolbar's labels are
   * Swooey's own and never match. (Swift `statusButtonCode(forFunction:)`.)
   */
  statusButtonCode(screen: Screen, number: number): string | undefined {
    const captions = new Set<string>()
    for (const function_ of screen.functions) {
      if (function_.kind.kind !== "applicationToolbar" && function_.kind.kind !== "menu") continue
      if (function_.virtualKey !== number || function_.text === undefined) continue
      const text = caption(function_.text)
      if (text !== undefined) captions.add(text)
    }
    if (captions.size === 0) return undefined
    const button = screen.functions.find(function_ => {
      if (function_.kind.kind !== "pushButton" || !function_.isEnabled || function_.code === undefined || function_.code.length === 0) return false
      const text = function_.text === undefined ? undefined : caption(function_.text)
      return text !== undefined && captions.has(text)
    })
    return button?.code
  }
} as const

/**
 * Whether the step sends a DYNT_FOCUS_1 for the cursor, when there is one: when the envelope holds
 * `InputEnvelope.focus` (R-CI-16); with a UI event under `focusAndCursorField` (R-CI-21); and
 * whenever a function number went as an OK-code with a cursor (R-CI-20), since the command carries
 * no position while the UI event it replaces carried the cursor's; ODG's builder sends the focus item
 * whenever there is a cursor (PV-0792). A typed command, an element's own code or a step without a
 * cursor stays the command step that works live (PV-0787).
 */
function sendsFocus(step: ClientInputStep, readings: FunctionReadings, firedAsOKCode: boolean): boolean {
  if (InputEnvelope.contains(readings.envelope, InputEnvelope.focus)) return true
  if (step.uiEvent !== undefined) return readings.uiEventCursor === "focusAndCursorField"
  return firedAsOKCode
}

/**
 * Refuses function `number` when the screen declares it and offers every declaration disabled (for
 * example Save on a screen whose GUI status binds no 11).
 */
function checkDeclared(screen: Screen, number: number): void {
  const declared = screen.functions.filter(function_ => function_.virtualKey === number)
  if (declared.length > 0 && !declared.some(function_ => function_.isEnabled)) {
    throw functionRefused({ kind: "function", value: { kind: "disabled" } })
  }
}

/**
 * The row record of a scroll request (Reading R-EL-9): table `id` must be the screen's first table,
 * and `firstRow` from 1 to 65,535. No function goes with it.
 */
function scroll(screen: Screen, id: number, firstRow: number, step: ClientInputStep, readings: FunctionReadings): void {
  switch (readings.tableScroll) {
    case "keysAndRowRecord":
      if (screen.tables[0]?.id !== id || !isUInt16(firstRow) || firstRow < 1) {
        throw functionRefused({ kind: "function", value: { kind: "notOffered" } })
      }
      step.tableRowRecord = new TableRowRecord({ firstRow })
      break
    case "keysOnly":
    case "specGap":
      throw functionRefused({ kind: "specGap", issue: CodecSpecGap.tableControlItems })
  }
}

/**
 * The focus item for the cursor field `field` (Reading R-CI-16), with the container ids of Reading
 * R-EL-17, and on a UI event with no edited field that field as received (PV-0779).
 */
function focus(screen: Screen, field: ScreenElement, edits: FieldEdits, containers: readonly number[], step: ClientInputStep): void {
  let characters: number
  if (field.isPassword) {
    characters = 0
  } else {
    const edited = edits.text(field.id)
    if (edited !== undefined) characters = characterCount(ScreenTextDecoding.trimmingPadding(edited))
    else characters = field.text === undefined ? 0 : characterCount(field.text)
  }
  step.focus = new InputFocus(field.atom.row, field.atom.col, clampU16(characters), Uint8Array.from(containers))
  if (step.uiEvent === undefined || step.fieldCount !== 0 || field.isPassword) return
  const bytes = ScreenInput.encode(screen, field.text ?? "", field.id)
  try {
    step.appendField(ReturnedField.received(field.atom), bytes)
  } catch (error) {
    if (error instanceof ClientInputError) throw new ScreenInputError({ kind: "field", value: field.id, error: error.info })
    throw error
  }
}

/**
 * The multiple-logon question `screen` asks when every one of its buttons is a native numeric radio
 * (PV-1028); undefined otherwise. (Swift inlines `MultipleLogonQuestion(self)` with
 * `question.buttons.values.allSatisfy { element($0)?.nativeRadioCaption != nil }`.)
 */
function nativeLogonQuestion(screen: Screen): MultipleLogonQuestion | undefined {
  const question = MultipleLogonQuestion.of(screen)
  if (question === undefined) return undefined
  for (const id of question.buttons.values()) if (screen.element(id)?.nativeRadioCaption === undefined) return undefined
  return question
}

function enter(screen: Screen, step: ClientInputStep, readings: FunctionReadings, target: FunctionTarget): void {
  // provenance: PV-1028 — fields alone change the choice but do not confirm this question.
  if (nativeLogonQuestion(screen) !== undefined) {
    if (readings.functionKey === "refused") throw functionRefused({ kind: "specGap", issue: CodecSpecGap.functionTrigger })
    step.setUIEventSource(UIEventFunctionKey.multipleLogonEnter)
    return
  }
  switch (readings.enter) {
    case "fieldsOnly":
      break
    case "functionKeyZero":
      fire(screen, GUIFunctionNumber.enter, step, readings, target, true)
      break
  }
}

/**
 * Fires function number `key` (0 is Enter, per `FunctionReadings.enter`). A page key on a list
 * screen goes as the list status's code unless `FunctionReadings.listPaging` says otherwise (Reading
 * R-EL-12). Returns whether the function went as an OK-code, which carries no cursor (R-CI-20).
 */
function fire(screen: Screen, key: number, step: ClientInputStep, readings: FunctionReadings, target: FunctionTarget, isEnter = false): boolean {
  if (key === GUIFunctionNumber.enter && !isEnter) {
    enter(screen, step, readings, target)
    return false
  }
  const page = PageKey.fromRaw(key)
  if (screen.list !== undefined && readings.listPaging === "okCodes" && page !== undefined) {
    setCommand(screen, PageKey.listOKCode(page), step, readings.okCodeCarrier)
    return true
  }
  if (isEnter) {
    // FunctionReadings' `functionKeyZero` Enter names the UI event, whatever the key reading.
    if (readings.functionKey === "refused") throw functionRefused({ kind: "specGap", issue: CodecSpecGap.functionTrigger })
    setEvent(key, step, readings, target)
    return false
  }
  switch (readings.functionKey) {
    case "okCode":
    case "okCodeOrUIEvent": {
      const code = FunctionTriggerStep.statusButtonCode(screen, key)
      if (code !== undefined) {
        setCommand(screen, code, step, readings.okCodeCarrier)
        return true
      } else if (readings.functionKey === "okCode") {
        setCommand(screen, FunctionKeyOKCode.text(key), step, readings.okCodeCarrier)
        return true
      } else {
        setEvent(key, step, readings, target)
        return false
      }
    }
    case "uiEventSource":
      setEvent(key, step, readings, target)
      return false
    case "refused":
      throw functionRefused({ kind: "specGap", issue: CodecSpecGap.functionTrigger })
  }
}

/** The UI_EVENT_SOURCE function-key event for `key` (Reading R-CI-10). */
function setEvent(key: number, step: ClientInputStep, readings: FunctionReadings, target: FunctionTarget): void {
  const value = new ByteWriter()
  // One container id: appendFunctionKey fails only above 65 535 ids.
  try {
    UIEventFunctionKey.appendFunctionKey(
      key,
      {
        width: readings.eventDataWidth,
        controlType: readings.eventControlType,
        controlRow: target.row,
        controlCol: target.col,
        containerIDs: target.containers
      },
      value
    )
  } catch (error) {
    if (!(error instanceof ScreenValueEncodingError)) throw error
  }
  step.setUIEventSource(value.toBytes())
}

/**
 * A caption as Reading R-CI-20 compares it: without its leading icon markup and without surrounding
 * spaces; undefined when nothing is left.
 */
function caption(text: string): string | undefined {
  const scalars = TextMarkup.parse(text).caption
  let start = 0
  let end = scalars.length
  while (start < end && scalars.charCodeAt(start) === 0x20) start += 1
  while (end > start && scalars.charCodeAt(end - 1) === 0x20) end -= 1
  return start === end ? undefined : scalars.slice(start, end)
}

function setCommand(screen: Screen, command: string, step: ClientInputStep, carrier: ClientInputStepFunctionTrigger): void {
  const bytes = ScreenInput.encode(screen, command, undefined)
  try {
    step.setFunctionCode(bytes, carrier)
  } catch (error) {
    if (error instanceof ClientInputError) throw functionRefused(error.info)
    throw error
  }
}
