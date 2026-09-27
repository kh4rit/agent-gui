// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ElementInputStepTests.swift (MIT).
//
// The screens come from the builders of ElementDecodingTests.swift (`controlsScreen()`,
// `TableDecodingTests.tableScreen()`, `ListDecodingTests.listScreen()`), repeated at the end of this
// file: a node:test file cannot import another test file without running its tests too.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientInput,
  DiagHeader,
  DiagItemWalker,
  DyntAttributes,
  DyntCombobox,
  DyntDialogFlags,
  DyntElementType,
  DyntFocus,
  DyntToggle,
  DyntToggleReturn,
  ElementValueReading,
  FieldMarkers,
  InputEnvelope,
  InputFocus,
  ListRunFlags,
  ListWindowState,
  PageKey,
  PopupWindow,
  SESValue,
  TableRowRecord,
  ZZValueList,
  type ValueHelpReading
} from "../../../diag/codec/index.js"
import {
  FieldEdits,
  FunctionReadings,
  FunctionTrigger,
  Screen,
  ScreenElementID,
  ScreenInputError,
  ScreenListSegment,
  ScreenPick,
  ScreenReadings,
  type ScreenInputErrorInfo
} from "../../../diag/screen/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { ElementAtoms, ElementItems, FiredEvent, ReturnedAtoms, elementAt } from "../../support/elementScreenBuilder.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const etype = DyntElementType.of

/**
 * The input side of docs/protocol/elements.md (design §5.6): checkbox, radio, dropdown and
 * row-mark returns (Readings R-EL-4, R-EL-10), table scrolling (R-EL-9), value help (R-EL-15),
 * choosing (R-EL-12), element functions (R-EL-4) and the cursor's container ids (R-EL-17), each
 * with its switch. The returned bytes are read back with DiagCodec's decoders.
 */
describe("Screen elements: the input step", () => {
  /** Function numbers as UI events (Reading R-CI-10), which these Readings' events are checked in. */
  const events = new FunctionReadings({ functionKey: "uiEventSource" })

  const controls = (): Screen => controlsScreen().screen()

  // MARK: Checkboxes

  /** A changed checkbox goes back as its etype with state, visible length, zeros and one more zero byte */
  test("checkbox", () => {
    const screen = controls()
    const waterproof = elementAt(screen, 1, 2)
    const blame = elementAt(screen, 2, 2)
    const edits = new FieldEdits()
    edits.setChecked(false, waterproof.id)
    edits.setChecked(false, blame.id)
    const step = screen.inputStep(edits, FunctionTrigger.enter)
    const returned = new ReturnedAtoms(step)
    assert.equal(returned.atoms.length, 1, "the unchanged checkbox stays out")
    assert.equal(step.fieldCount, 1)
    const atom = returned.atoms[0]
    assert.deepEqual(atom.etype, etype("checkbutton3"))
    assert.equal(atom.row, 1)
    assert.equal(atom.col, 2)
    assert.equal(atom.block, 1)
    assert.deepEqual(atom.dialogFlags, waterproof.atom.dialogFlags)
    assert.deepEqual(returned.payload(0), Uint8Array.of(0x20, 0, 18, 0, 0, 0, 0, 0, 0, 0, 0))
    assert.deepEqual(returned.toggle(0), new DyntToggleReturn({ isChecked: false, visibleLength: 18 }))

    const short = screen.inputStep(edits, FunctionTrigger.enter, {
      readings: new FunctionReadings({ elementValues: new ElementValueReading({ trailingZero: false }) })
    })
    assert.deepEqual(new ReturnedAtoms(short).payload(0), Uint8Array.of(0x20, 0, 18, 0, 0, 0, 0, 0, 0, 0))
    const changed = screen.inputStep(edits, FunctionTrigger.enter, { readings: new FunctionReadings({ envelope: InputEnvelope.chlStage }) })
    assert.notEqual(new ReturnedAtoms(changed).atoms[0].dialogFlags.flag2 & DyntDialogFlags.changedBitOfFlag2, 0)
    throwsInfo(() => screen.inputStep(edits, FunctionTrigger.enter, { flags: "markedChanged" }), ScreenInputError, {
      kind: "field",
      value: waterproof.id,
      error: { kind: "specGap", issue: 34 }
    })
    throwsInfo(() => screen.inputStep(edits, { functionCode: "=ZZOPEN", trigger: "varInfoOKCode", flags: "markedChanged" }), ScreenInputError, {
      kind: "field",
      value: waterproof.id,
      error: { kind: "specGap", issue: 34 }
    })
  })

  /** Checkbox edits that cannot go back are refused */
  test("checkboxRefusals", () => {
    const screen = controls()
    const unknown = new ScreenElementID({ block: 9, row: 9, column: 9, elementType: 128 })
    const cases: [ScreenElementID, ScreenInputErrorInfo][] = [
      [elementAt(screen, 3, 2).id, { kind: "notEditable", value: elementAt(screen, 3, 2).id }],
      [elementAt(screen, 6, 2).id, { kind: "notEditable", value: elementAt(screen, 6, 2).id }],
      [unknown, { kind: "unknownElement", value: unknown }]
    ]
    for (const [id, error] of cases) {
      const edits = new FieldEdits()
      edits.setChecked(true, id)
      throwsInfo(() => screen.inputStep(edits, FunctionTrigger.enter), ScreenInputError, error)
    }
    const opaque = controlsScreen().screen(ScreenReadings.beforeElements)
    const edits = new FieldEdits()
    const checkbox = elementAt(opaque, 1, 2).id
    edits.setChecked(false, checkbox)
    throwsInfo(() => opaque.inputStep(edits, FunctionTrigger.enter), ScreenInputError, {
      kind: "field",
      value: checkbox,
      error: { kind: "specGap", issue: 107 }
    })
    const refused = new FieldEdits()
    refused.setChecked(false, elementAt(screen, 1, 2).id)
    throwsInfo(
      () => screen.inputStep(refused, FunctionTrigger.enter, { readings: new FunctionReadings({ elementValues: ElementValueReading.specGap }) }),
      ScreenInputError,
      { kind: "field", value: elementAt(screen, 1, 2).id, error: { kind: "specGap", issue: 107 } }
    )
  })

  // MARK: Radio buttons

  const radioEdits = (screen: Screen, rows: number[]): FieldEdits => {
    const edits = new FieldEdits()
    for (const row of rows) edits.select(elementAt(screen, row, 2).id)
    return edits
  }

  /** A moved radio selection returns the new button (X, 0x80) and the old one (space, 0x80 cleared) */
  test("radios", () => {
    const screen = controls()
    // Glossy, then Moulting: the latest selection wins.
    const edits = radioEdits(screen, [5, 7])
    const returned = new ReturnedAtoms(screen.inputStep(edits, FunctionTrigger.enter))
    assert.deepEqual(
      returned.atoms.map(atom => atom.row),
      [6, 7],
      "screen order: Fluffy (deselected) before Moulting"
    )
    assert.equal(returned.toggle(0)?.isChecked, false)
    assert.equal(returned.atoms[0].dialogFlags.flag2 & DyntToggle.selectedRadioFlag, 0)
    assert.equal(returned.toggle(1)?.isChecked, true)
    assert.notEqual(returned.atoms[1].dialogFlags.flag2 & DyntToggle.selectedRadioFlag, 0)
    assert.ok(
      returned.atoms.every(
        atom => DyntElementType.rawValue(atom.etype) === DyntElementType.rawValue(etype("radiobutton3")) && atom.group === DyntToggle.radioGroupByte && atom.block === 21
      )
    )
    assert.equal(returned.toggle(1)?.visibleLength, 27)

    const selected = new ReturnedAtoms(
      screen.inputStep(edits, FunctionTrigger.enter, { readings: new FunctionReadings({ elementValues: new ElementValueReading({ radios: "selectedOnly" }) }) })
    )
    assert.deepEqual(
      selected.atoms.map(atom => atom.row),
      [7]
    )
    const whole = new ReturnedAtoms(
      screen.inputStep(edits, FunctionTrigger.enter, { readings: new FunctionReadings({ elementValues: new ElementValueReading({ radios: "wholeGroup" }) }) })
    )
    assert.deepEqual(
      whole.atoms.map(atom => atom.row),
      [5, 6, 7]
    )
    assert.deepEqual(
      [0, 1, 2].map(index => whole.toggle(index)?.isChecked),
      [false, false, true]
    )

    const unchanged = screen.inputStep(radioEdits(screen, [6]), FunctionTrigger.enter)
    assert.equal(Fixtures.atomValue(unchanged), undefined, "selecting the selected button changes nothing")
    const checkboxEdit = new FieldEdits()
    checkboxEdit.select(elementAt(screen, 1, 2).id)
    throwsInfo(() => screen.inputStep(checkboxEdit, FunctionTrigger.enter), ScreenInputError, { kind: "notEditable", value: elementAt(screen, 1, 2).id })
  })

  /** Ungrouped radio buttons (grouping switched off) return the selected button alone */
  test("ungroupedRadio", () => {
    const screen = controlsScreen().screen(new ScreenReadings({ radioGroups: "specGap" }))
    const returned = new ReturnedAtoms(screen.inputStep(radioEdits(screen, [5, 6]), FunctionTrigger.enter))
    assert.deepEqual(
      returned.atoms.map(atom => atom.row),
      [5]
    )
  })

  // MARK: Dropdowns

  /** A changed dropdown goes back as 126 with its received _2 body and the key */
  test("dropdown", () => {
    const screen = controls()
    const species = elementAt(screen, 9, 20)
    const edits = new FieldEdits()
    edits.setDropdownKey("EIDR", species.id)
    const returned = new ReturnedAtoms(screen.inputStep(edits, FunctionTrigger.enter))
    const body = returned.dropdown(0)
    assert.ok(body !== undefined)
    assert.deepEqual(returned.atoms[0].etype, etype("combobox1"))
    assert.equal(returned.atoms[0].attributes, DyntCombobox.attributes)
    assert.equal(body.field.mlen, 20)
    assert.equal(body.field.maxNrChars, 4)
    assert.equal(body.field.flag1, 0)
    assert.equal(returned.text(body.field.textRange), "EIDR")

    const empty = new FieldEdits()
    empty.setDropdownKey(undefined, species.id)
    const cleared = new ReturnedAtoms(screen.inputStep(empty, FunctionTrigger.enter)).dropdown(0)
    assert.ok(cleared !== undefined)
    assert.equal(cleared.field.dlen, 0)

    const same = new FieldEdits()
    same.setDropdownKey("RUBR", species.id)
    assert.equal(Fixtures.atomValue(screen.inputStep(same, FunctionTrigger.enter)), undefined)
    const unknown = new FieldEdits()
    unknown.setDropdownKey("SWAN", species.id)
    throwsInfo(() => screen.inputStep(unknown, FunctionTrigger.enter), ScreenInputError, { kind: "notOffered", value: species.id })
    const notDropdown = new FieldEdits()
    const name = elementAt(screen, 10, 20).id
    notDropdown.setDropdownKey("X", name)
    throwsInfo(() => screen.inputStep(notDropdown, FunctionTrigger.enter), ScreenInputError, { kind: "notEditable", value: name })
    throwsInfo(
      () => screen.inputStep(edits, FunctionTrigger.enter, { readings: new FunctionReadings({ elementValues: ElementValueReading.specGap }) }),
      ScreenInputError,
      { kind: "field", value: species.id, error: { kind: "specGap", issue: 108 } }
    )
  })

  /** A dropdown without an empty entry refuses one; an unknown element is refused */
  test("dropdownRefusals", () => {
    const items = new ElementItems()
    const atoms = new ElementAtoms()
    atoms.dropdown({
      row: 1,
      col: 1,
      mlen: 8,
      flag1: FieldMarkers.requiredFlag1Bit,
      key: "EN",
      list: new ZZValueList({
        values: [
          { key: "EN", text: "English" },
          { key: "DK", text: "Duck" }
        ]
      })
    })
    items.atoms(atoms)
    const screen = items.screen()
    const language = elementAt(screen, 1, 1)
    assert.ok(language.isRequired)
    const edits = new FieldEdits()
    edits.setDropdownKey(undefined, language.id)
    throwsInfo(() => screen.inputStep(edits, FunctionTrigger.enter), ScreenInputError, { kind: "notOffered", value: language.id })
    const duck = new FieldEdits()
    duck.setDropdownKey("DK", language.id)
    const body = new ReturnedAtoms(screen.inputStep(duck, FunctionTrigger.enter)).dropdown(0)
    assert.ok(body !== undefined)
    assert.equal(body.field.flag1, FieldMarkers.requiredFlag1Bit, "flag1 goes back as received")
    const missing = new ScreenElementID({ block: 1, row: 7, column: 7, elementType: 126 })
    const stray = new FieldEdits()
    stray.setDropdownKey("DK", missing)
    throwsInfo(() => screen.inputStep(stray, FunctionTrigger.enter), ScreenInputError, { kind: "unknownElement", value: missing })
    const strayRadio = new FieldEdits()
    strayRadio.select(missing)
    throwsInfo(() => screen.inputStep(strayRadio, FunctionTrigger.enter), ScreenInputError, { kind: "unknownElement", value: missing })
  })

  // MARK: Screen order and fields

  /** Fields and elements go back together, in screen order */
  test("screenOrder", () => {
    const screen = controls()
    const edits = radioEdits(screen, [5])
    edits.setText("Sir Quacksalot", elementAt(screen, 10, 20).id)
    edits.setChecked(false, elementAt(screen, 1, 2).id)
    edits.setDropdownKey("MALL", elementAt(screen, 9, 20).id)
    const step = screen.inputStep(edits, FunctionTrigger.enter)
    const returned = new ReturnedAtoms(step)
    assert.deepEqual(
      returned.atoms.map(atom => atom.row),
      [1, 5, 6, 9, 10]
    )
    assert.deepEqual(
      returned.atoms.map(atom => atom.etype),
      [etype("checkbutton3"), etype("radiobutton3"), etype("radiobutton3"), etype("combobox1"), etype("efield2")]
    )
    assert.equal(step.fieldCount, 5)
    assert.ok(!edits.isEmpty)
    assert.ok(edits.hasElementEdits)
  })

  // MARK: Element functions

  /** A checkbox's function goes in OKCODE with its new state in the same step */
  test("elementFunction", () => {
    const screen = controls()
    const blame = elementAt(screen, 2, 2)
    const edits = new FieldEdits()
    edits.setChecked(true, blame.id)
    const step = screen.inputStep(edits, FunctionTrigger.elementFunction(blame.id))
    assert.deepEqual(step.functionCode, utf8("=ZZBLAME"))
    assert.equal(step.uiEvent, undefined)
    assert.equal(new ReturnedAtoms(step).toggle(0)?.isChecked, true)
    const species = elementAt(screen, 9, 20)
    assert.deepEqual(screen.inputStep(new FieldEdits(), FunctionTrigger.elementFunction(species.id)).functionCode, utf8("=ZZSPECIES"))

    const waterproof = elementAt(screen, 1, 2).id
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.elementFunction(waterproof)), ScreenInputError, {
      kind: "notOffered",
      value: waterproof
    })
    const missing = new ScreenElementID({ block: 1, row: 30, column: 1, elementType: 128 })
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.elementFunction(missing)), ScreenInputError, {
      kind: "unknownElement",
      value: missing
    })
    for (const function_ of ["stateChangedEvent", "specGap"] as const) {
      const readings = new FunctionReadings({ elementValues: new ElementValueReading({ function: function_ }) })
      throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.elementFunction(blame.id), { readings }), ScreenInputError, {
        kind: "functionCode",
        value: { kind: "specGap", issue: 107 }
      })
      throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.elementFunction(species.id), { readings }), ScreenInputError, {
        kind: "functionCode",
        value: { kind: "specGap", issue: 108 }
      })
    }
  })

  /** A PROTECTED element's function is disabled */
  test("protectedFunction", () => {
    const items = new ElementItems()
    const atoms = new ElementAtoms()
    atoms.toggle({ row: 1, col: 1, attributes: DyntAttributes.protected, checked: false, visible: 4, code: "=ZZMUTE" }, "Mute")
    items.atoms(atoms)
    const screen = items.screen()
    const mute = elementAt(screen, 1, 1)
    assert.equal(mute.firesFunction, "=ZZMUTE")
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.elementFunction(mute.id)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "disabled" } }
    })
  })

  // MARK: Value help

  /** F4 on a field with value help: function 4 with the cursor on it, the focus there; R-EL-15 */
  test("valueHelp", () => {
    const screen = controls()
    const department = elementAt(screen, 13, 20)
    const step = screen.inputStep(new FieldEdits(), FunctionTrigger.valueHelp(department.id), {
      readings: new FunctionReadings({ functionKey: "uiEventSource", envelope: InputEnvelope.stateStage })
    })
    const event = new FiredEvent(step)
    assert.equal(event.number, 4)
    assert.equal(event.row, 13)
    assert.equal(event.col, 20)
    assert.deepEqual(event.containers, [0])
    assert.deepEqual(step.focus, new InputFocus(13, 20, 4))
    assert.equal(step.functionCode, undefined)

    const name = elementAt(screen, 10, 20).id
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.valueHelp(name)), ScreenInputError, { kind: "notOffered", value: name })
    const missing = new ScreenElementID({ block: 1, row: 40, column: 1, elementType: 130 })
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.valueHelp(missing)), ScreenInputError, { kind: "unknownElement", value: missing })
    for (const reading of ["valueHelpEvent", "specGap"] as ValueHelpReading[]) {
      throwsInfo(
        () => screen.inputStep(new FieldEdits(), FunctionTrigger.valueHelp(department.id), { readings: new FunctionReadings({ valueHelp: reading }) }),
        ScreenInputError,
        { kind: "functionCode", value: { kind: "specGap", issue: 114 } }
      )
    }
  })

  // MARK: Tables

  /** A scroll request carries the row record after the atoms, and no function; R-EL-9 */
  test("scrollTable", () => {
    const screen = tableScreen().screen()
    const name = elementAt(screen, 1, 8, { area: 2 })
    const edits = new FieldEdits()
    edits.setText("Lily pad", name.id)
    const step = screen.inputStep(edits, FunctionTrigger.scrollTable(2, 500))
    assert.deepEqual(step.tableRowRecord, new TableRowRecord({ firstRow: 500 }))
    assert.equal(step.uiEvent, undefined)
    assert.equal(step.functionCode, undefined)
    assert.equal(step.fieldCount, 1)
    assert.equal(step.items.length, 1, "the record is no ClientItem: the message encoder writes it")
    assert.ok(step.description.includes("row record: yes"), step.description)

    // The message: the record's APPL item follows the DYNT_ATOM item, in both envelopes.
    for (const envelope of [InputEnvelope.minimal, InputEnvelope.chlStage]) {
      const encoder = Fixtures.encoder()
      const sent = step.clone()
      sent.envelope = envelope
      const payload = ClientInput.inputMessage(encoder, sent)
      const items = payload.slice(DiagHeader.size)
      const walker = new DiagItemWalker()
      const appls: ApplItem[] = []
      let record = new Uint8Array(0)
      for (let item = walker.next(items); item !== undefined; item = walker.next(items)) {
        const appl = item.appl
        if (appl === undefined) continue
        appls.push(appl)
        if (ApplItem.equals(appl, TableRowRecord.item)) record = item.valueRange.of(items).slice()
      }
      const atomIndex = appls.findIndex(appl => ApplItem.equals(appl, ApplItem.dynt("atom")))
      assert.ok(atomIndex >= 0)
      assert.deepEqual(appls[atomIndex + 1], TableRowRecord.item, InputEnvelope.name(envelope))
      assert.deepEqual(TableRowRecord.decode(record), new TableRowRecord({ firstRow: 500 }))
    }

    const cases: [FunctionTrigger, FunctionReadings, ScreenInputErrorInfo][] = [
      [FunctionTrigger.scrollTable(7, 1), new FunctionReadings(), { kind: "functionCode", value: { kind: "function", value: { kind: "notOffered" } } }],
      [FunctionTrigger.scrollTable(2, 0), new FunctionReadings(), { kind: "functionCode", value: { kind: "function", value: { kind: "notOffered" } } }],
      [FunctionTrigger.scrollTable(2, 70_000), new FunctionReadings(), { kind: "functionCode", value: { kind: "function", value: { kind: "notOffered" } } }],
      [FunctionTrigger.scrollTable(2, 5), new FunctionReadings({ tableScroll: "keysOnly" }), { kind: "functionCode", value: { kind: "specGap", issue: 110 } }],
      [FunctionTrigger.scrollTable(2, 5), new FunctionReadings({ tableScroll: "specGap" }), { kind: "functionCode", value: { kind: "specGap", issue: 110 } }]
    ]
    for (const [trigger, readings, error] of cases) {
      throwsInfo(() => screen.inputStep(new FieldEdits(), trigger, { readings }), ScreenInputError, error)
    }
  })

  /** Page keys report the cursor's table as the container id; the fallback sends 0; R-EL-17 */
  test("pageKeysInTable", () => {
    const screen = tableScreen().screen()
    const cell = elementAt(screen, 2, 8, { area: 2 })
    const step = screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(PageKey.rawValue("next")), {
      readings: new FunctionReadings({ functionKey: "uiEventSource", envelope: InputEnvelope.stateStage }),
      cursor: cell.id
    })
    const event = new FiredEvent(step)
    assert.equal(event.number, 82)
    assert.equal(event.row, 2)
    assert.equal(event.col, 8)
    assert.deepEqual(event.containers, [2])
    assert.deepEqual(step.focus, new InputFocus(2, 8, 13, Uint8Array.of(2)))
    assert.equal(step.focus?.bytes.length, DyntFocus.fixedSize + 1)
    const zero = screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(82), {
      readings: new FunctionReadings({ functionKey: "uiEventSource", cursorContainers: "alwaysZero" }),
      cursor: cell.id
    })
    assert.deepEqual(new FiredEvent(zero).containers, [0])
    assert.deepEqual(new FiredEvent(screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(82), { readings: events })).containers, [0])
  })

  /** Row marks go back as selector checkbox changes; rows not held are refused; R-EL-10 */
  test("rowMarks", () => {
    const screen = tableScreen().screen()
    const edits = new FieldEdits()
    edits.setTableRowSelected(true, 46, 2)
    edits.setTableRowSelected(true, 47, 2)
    edits.setTableRowSelected(false, 48, 2)
    const returned = new ReturnedAtoms(screen.inputStep(edits, FunctionTrigger.enter))
    assert.deepEqual(
      returned.atoms.map(atom => atom.row),
      [1]
    )
    assert.equal(returned.atoms[0].col, 0)
    assert.equal(returned.atoms[0].area, 2)
    assert.deepEqual(returned.toggle(0), new DyntToggleReturn({ isChecked: true, visibleLength: 1 }))
    // A row mark wins over a checkbox edit of the same selector.
    const both = new FieldEdits()
    both.setChecked(true, elementAt(screen, 3, 0, { area: 2 }).id)
    both.setTableRowSelected(false, 48, 2)
    assert.equal(Fixtures.atomValue(screen.inputStep(both, FunctionTrigger.enter)), undefined)

    for (const [line, table] of [
      [49, 2],
      [46, 5]
    ]) {
      const missing = new FieldEdits()
      missing.setTableRowSelected(true, line, table)
      throwsInfo(() => screen.inputStep(missing, FunctionTrigger.enter), ScreenInputError, { kind: "specGap", issue: 110 })
    }
  })

  /** F2 on a table cell: function 2 with the cursor there, and the focus on an output cell; R-EL-12 */
  test("chooseElement", () => {
    const screen = tableScreen().screen()
    const spot = elementAt(screen, 3, 2, { area: 2 })
    const step = screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.element(spot.id)), {
      readings: new FunctionReadings({ functionKey: "uiEventSource", envelope: InputEnvelope.stateStage })
    })
    const event = new FiredEvent(step)
    assert.equal(event.number, 2)
    assert.equal(event.row, 3)
    assert.equal(event.col, 2)
    assert.deepEqual(event.containers, [2])
    assert.deepEqual(step.focus, new InputFocus(3, 2, 0, Uint8Array.of(2)))
    const plain = screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.element(spot.id)), { readings: events })
    assert.equal(plain.focus, undefined)
    const missing = new ScreenElementID({ area: 2, block: 9, row: 9, column: 9, elementType: 131 })
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.element(missing))), ScreenInputError, {
      kind: "unknownElement",
      value: missing
    })
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.list(3, 0))), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "notOffered" } }
    })
  })

  // MARK: Lists

  /** F2 on a list line: function 2 at the SBA row and column, area 0, and the focus there; R-EL-12 */
  test("chooseListLine", () => {
    const screen = listScreen().screen()
    const step = screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.list(3, 0)), {
      readings: new FunctionReadings({ functionKey: "uiEventSource", envelope: InputEnvelope.stateStage })
    })
    const event = new FiredEvent(step)
    assert.equal(event.number, 2)
    assert.equal(event.row, 3)
    assert.equal(event.col, 0)
    assert.deepEqual(event.containers, [0])
    assert.deepEqual(step.focus, new InputFocus(3, 0))
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.list(-1, 0))), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "notOffered" } }
    })
  })

  /** List page keys: the list status's codes by default, the function numbers when switched */
  test("listPaging", () => {
    const screen = listScreen().screen()
    for (const key of PageKey.allCases) {
      for (const readings of [new FunctionReadings(), events]) {
        const step = screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(PageKey.rawValue(key)), { readings })
        const message = "P-- to P++ in OKCODE, as both MIT clients page"
        assert.deepEqual(step.functionCode, utf8(PageKey.listOKCode(key)), message)
        assert.equal(step.uiEvent, undefined, message)
      }
    }
    // Swift's `var numbers = Self.events` copies the struct.
    const numbers = events.clone()
    numbers.listPaging = "functionKeys"
    assert.equal(new FiredEvent(screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(82), { readings: numbers })).number, 82)
    numbers.functionKey = "okCode"
    assert.deepEqual(
      screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(82), { readings: numbers }).functionCode,
      utf8("/82"),
      "the number, as Reading R-CI-20 sends it"
    )
    const form = controlsScreen().screen()
    assert.deepEqual(form.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(82)).functionCode, utf8("/82"), "no list: the key")
  })

  /** A value-help popup: a level-1 popup whose list is picked with F2 on a line; R-EL-13, R-EL-15 */
  test("valueHelpPopup", () => {
    const items = new ElementItems()
    items.text(ApplItem.varInfo("sessionTitle"), "Quack Styles (5 entries)")
    items.ses(new PopupWindow({ level: 1, row: 4, column: 20, rows: 14, columns: 50 }).applied(new SESValue({ eventArray: 1 })))
    const styles: [string, string][] = [
      ["QUACK", "Classic quack"],
      ["HONK", "Honk (goose impression)"],
      ["PEEP", "Peep"]
    ]
    styles.forEach(([key, text], index) => {
      items.run(index, 0, key, { color: 4, flags: ListRunFlags.hotspot })
      items.run(index, 8, text)
    })
    items.window(ListWindowState.fromWindow({ totalLines: 3, firstLine: 1, visibleLines: 12, windowRows: 12, width: 48, visibleWidth: 48 }))
    const popup = items.screen()
    const presentation = popup.presentation
    if (presentation.kind !== "popup") assert.fail("not a popup")
    const window = presentation.value
    assert.equal(window.level, 1)
    assert.equal(window.title, "Quack Styles (5 entries)")
    const list = popup.list
    assert.ok(list !== undefined)
    assert.equal(list.headerLines.length, 0)
    assert.deepEqual(
      list.lines.map(line => line.index),
      [1, 2, 3]
    )
    assert.deepEqual(list.lines[1].segments[0], new ScreenListSegment({ column: 0, width: 4, text: "HONK", color: "key", isHotspot: true }))
    const step = popup.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.list(1, 0)), { readings: events })
    const event = new FiredEvent(step)
    assert.equal(event.number, 2)
    assert.equal(event.row, 1)
    assert.equal(event.col, 0)
    assert.equal(step.focus, undefined, "the minimal envelope sends no focus")
    const okCode = popup.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.list(1, 0)))
    assert.deepEqual(okCode.functionCode, utf8("/02"), "Reading R-CI-20: the position as focus")
    assert.deepEqual(okCode.focus, new InputFocus(1, 0), "Reading R-CI-20: the position as focus")
  })
})

// MARK: - The screens of ElementDecodingTests.swift

/** Swift `ElementDecodingTests.species`. */
const species = new ZZValueList({
  values: [
    { key: "MALL", text: "Mallard" },
    { key: "RUBR", text: "Rubber (honorary)" },
    { key: "EIDR", text: "Eider" }
  ],
  allowsEmpty: true,
  functionCode: "=ZZSPECIES"
})

/**
 * A screen with a checkbox row, a radio group of three, a second group, a dropdown and field
 * markers. (Swift `ElementDecodingTests.controlsScreen()`.)
 */
function controlsScreen(): ElementItems {
  const items = new ElementItems()
  items.text(ApplItem.stSystemInfo("dynproName"), "ZZ_DUCK_PERSONNEL")
  const atoms = new ElementAtoms()
  atoms.toggle({ row: 1, col: 2, checked: true, visible: 18 }, "Waterproof")
  atoms.child(etype("fname"), { row: 1, col: 2 }, "ZZDUCK-WATERPROOF")
  atoms.toggle({ row: 2, col: 2, checked: false, visible: 18, code: "=ZZBLAME" }, "Auto-blame the swan")
  atoms.toggle({ row: 3, col: 2, attributes: DyntAttributes.protected, checked: false, visible: 18 }, "Allergic to bread")
  atoms.radio({ block: 21, row: 5, col: 2, selected: false, fname: "ZZDUCK-PLUMAGE" }, "Glossy")
  atoms.radio({ block: 21, row: 6, col: 2, selected: true, fname: "ZZDUCK-PLUMAGE" }, "Fluffy")
  atoms.radio({ block: 21, row: 7, col: 2, selected: false, fname: "ZZDUCK-PLUMAGE" }, "Moulting, please don't look")
  atoms.radio({ block: 22, row: 5, col: 40, selected: true, fname: "ZZDUCK-SHIFT" }, "Dawn chorus")
  atoms.radio({ block: 22, row: 6, col: 40, selected: false, fname: "ZZDUCK-SHIFT" }, "Night owl (reluctantly)")
  atoms.dropdown({ row: 9, col: 20, mlen: 20, key: "RUBR", list: species, tooltip: "Pick a species", fname: "ZZDUCK-SPECIES" })
  atoms.input({ row: 10, col: 20, mlen: 30, flag1: FieldMarkers.requiredFlag1Bit }, "Puddles McGee")
  atoms.input({ row: 11, col: 20, mlen: 10, flag1: FieldMarkers.requiredFlag1Bit | FieldMarkers.dateFlag1Bit }, "01.04.2019")
  atoms.input({ row: 12, col: 20, mlen: 2, attributes: DyntAttributes.yes3D | DyntAttributes.justRight }, "7")
  atoms.input({ row: 13, col: 20, mlen: 10, attributes: DyntAttributes.yes3D | DyntAttributes.matchCode }, "POND")
  atoms.output({ row: 14, col: 20, mlen: 7 }, "12.5 %")
  atoms.button({ row: 16, col: 2, code: "=ZZPREV", attributes: DyntAttributes.protected }, "@0G@ Back")
  atoms.button({ row: 16, col: 20, code: "=ZZNEXT" }, "Continue @0F@")
  items.atoms(atoms)
  return items
}

/**
 * The pond spots table: container 2 at r4 c1, 108 × 4 (header and three rows), rows 46 to 48 of
 * 1,000, a selector column, the columns Spot (output, key), Spot name (input), Heated (checkbox) and
 * Water (dropdown). (Swift `TableDecodingTests.tableScreen(scroll:header:)`.)
 */
function tableScreen(scroll = true, header = true): ElementItems {
  const items = new ElementItems()
  items.reset()
  items.container("table", { id: 2, row: 4, col: 1, width: 108, height: 4 })
  items.containerName("", "ZZV_POND_SPOTS", "0100")
  if (scroll) items.scrollInfos({ total: 1000, first: 46, visible: 3, totalWidth: 138, viewport: 108 })
  const atoms = new ElementAtoms()
  if (header) {
    const columns: [number, string, number, string][] = [
      [2, "Spot", 5, "ZZSPOT-ID"],
      [8, "Spot name", 24, "ZZSPOT-NAME"],
      [33, "Heated", 1, "ZZSPOT-HEATED"],
      [35, "Water", 14, "ZZSPOT-WATER"]
    ]
    for (const [column, title, width, fname] of columns) {
      atoms.label({ area: 2, block: 0, row: 0, col: column, mlen: width }, title)
      atoms.child(etype("fname"), { area: 2, block: 0, row: 0, col: column }, fname)
    }
  }
  const water = new ZZValueList({
    values: [
      { key: "FRESH", text: "Fresh" },
      { key: "MUD", text: "Mostly mud" }
    ]
  })
  for (let line = 1; line <= 3; line++) {
    const block = line
    const row = line
    atoms.toggle({ area: 2, block, row, col: 0, checked: line === 2, visible: 1 }, "")
    atoms.child(etype("fname"), { area: 2, block, row, col: 0 }, "ZZSPOT-MARK")
    atoms.output({ area: 2, block, row, col: 2, mlen: 5 }, `S00${45 + line}`)
    atoms.input({ area: 2, block, row, col: 8, mlen: 24 }, `Reed corner ${line}`)
    atoms.toggle({ area: 2, block, row, col: 33, checked: line !== 2, visible: 1 }, "")
    atoms.dropdown({ area: 2, block, row, col: 35, mlen: 14, key: "MUD", list: water, fname: "ZZSPOT-WATER" })
  }
  items.atoms(atoms)
  return items
}

/** Three header lines and three body lines of a 220-line list, the page from line 21. (Swift `ListDecodingTests.listScreen(window:)`.) */
function listScreen(window = true): ElementItems {
  const items = new ElementItems()
  items.text(ApplItem.stSystemInfo("dynproName"), "ZZ_BREADCRUMB_REPORT")
  items.run(0, 0, "Breadcrumb Report - Pond 314 - 2/11", { color: 1, flags: ListRunFlags.intensified })
  items.run(1, 0, "Ducks D0001 to D0012", { color: 1 })
  items.run(2, 0, "Duck         Date        Crumbs", { color: 1 })
  items.run(3, 0, "Puddles McGee", { color: 4, flags: ListRunFlags.hotspot })
  items.run(3, 13, "  2026-09-01  12", { color: 2 })
  items.run(4, 0, "@0A@Subtotal", { color: 3, flags: ListRunFlags.intensified })
  items.run(5, 0, "*** Record: 42 croissants ***", { color: 5, flags: ListRunFlags.inverse })
  if (window) items.window(ListWindowState.fromWindow({ totalLines: 220, firstLine: 21, visibleLines: 20, windowRows: 23, width: 80, visibleWidth: 80 }))
  return items
}
