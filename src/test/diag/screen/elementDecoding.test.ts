// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ElementDecodingTests.swift (MIT).

// Decoding the screen elements of docs/protocol/elements.md into the model (design §5): each
// screen is written with DiagCodec's encoders, the pair the fake server shares, and decoded with
// every Reading at its default and at its fallback. Invented texts (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  DyntAtomEncoder,
  DyntAttributes,
  DyntElementType,
  DyntToggle,
  FieldMarkers,
  ListRun,
  ListRunFlags,
  ListWindowState,
  PopupWindow,
  SESValue,
  StatusMessageType,
  StatusMessageValue,
  ZZValueList
} from "../../../diag/codec/index.js"
import {
  FieldEdits,
  FunctionTrigger,
  GridPoint,
  GridRect,
  ScreenCursor,
  ScreenElementKind,
  ScreenIcon,
  ScreenInputError,
  ScreenListScroll,
  ScreenMessageType,
  ScreenPopup,
  ScreenPresentation,
  ScreenRadioGroupID,
  ScreenReadings,
  ScreenStatusMessage,
  ScreenStatusMessageID,
  ScreenTableCell,
  ScreenTableScroll
} from "../../../diag/screen/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { ElementAtoms, ElementItems, elementAt } from "../../support/elementScreenBuilder.js"

const etype = DyntElementType.of
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
/** Swift's `Array(a ... b)`. */
const closedRange = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index)

// MARK: - ElementDecodingTests

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
 * markers.
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

describe("Screen elements: decoding checkboxes, radios, dropdowns, markers and buttons", () => {
  /** Checkboxes: state, caption, the function of their event id, width; R-EL-1 */
  test("checkboxes", () => {
    const screen = controlsScreen().screen()
    const waterproof = elementAt(screen, 1, 2)
    assert.deepEqual(waterproof.kind, ScreenElementKind.checkbox)
    assert.equal(waterproof.isChecked, true)
    assert.equal(waterproof.caption, "Waterproof")
    assert.equal(waterproof.fieldName, "ZZDUCK-WATERPROOF")
    assert.equal(waterproof.width, 18)
    assert.equal(waterproof.firesFunction, undefined)
    const blame = elementAt(screen, 2, 2)
    assert.equal(blame.isChecked, false)
    assert.equal(blame.firesFunction, "=ZZBLAME")
    assert.equal(blame.caption, "Auto-blame the swan")
    assert.ok(elementAt(screen, 3, 2).isProtected)
    assert.equal(screen.diagnostics.undecodedElements, 0)
    assert.equal(screen.diagnostics.codec.atoms.opaquePayloads, 0, "decoded checkboxes are no longer opaque")
    assert.ok(waterproof.description.includes("checked"), waterproof.description)
    assert.ok(blame.description.includes("unchecked fires =ZZBLAME"), blame.description)
  })

  /** Checkbox Readings: ODG's split reads a body without event id; the fallback keeps it opaque */
  test("checkboxReadings", () => {
    const items = controlsScreen()
    const odg = items.screen(new ScreenReadings({ checkbox: "odgSplit" }))
    assert.equal(elementAt(odg, 1, 2).isChecked, true)
    assert.equal(elementAt(odg, 1, 2).caption, "Waterproof")
    assert.equal(elementAt(odg, 2, 2).isChecked, undefined, "an event id does not fit ODG's count")
    assert.equal(odg.diagnostics.undecodedElements, 1)
    const before = items.screen(ScreenReadings.beforeElements)
    const checkbox = elementAt(before, 1, 2)
    assert.deepEqual(checkbox.kind, ScreenElementKind.checkbox)
    assert.equal(checkbox.isChecked, undefined)
    assert.equal(checkbox.text, undefined)
    assert.equal(checkbox.width, undefined)
    assert.equal(before.radioGroups.length, 0)
    assert.equal(before.diagnostics.undecodedElements, 0)
  })

  /** A body that fits no Reading stays opaque and is counted */
  test("undecodableToggle", () => {
    const items = new ElementItems()
    const atoms = new ElementAtoms()
    // A state byte that is neither X nor space.
    DyntAtomEncoder.appendAtom(
      ElementAtoms.header(etype("checkbutton3"), { row: 1, col: 1 }),
      Uint8Array.from([0x41, 0, 5, 0, 0, 0, 0, 0, 0, 0]),
      atoms.writer
    )
    items.atoms(atoms)
    const screen = items.screen()
    assert.equal(screen.elements[0]?.isChecked, undefined)
    assert.equal(screen.diagnostics.undecodedElements, 1)
  })

  /** Radio groups by area, block and group byte; the selected button; R-EL-2 */
  test("radioGroups", () => {
    const screen = controlsScreen().screen()
    assert.equal(screen.radioGroups.length, 2)
    const plumage = screen.radioGroups[0]
    assert.deepEqual(plumage.id, new ScreenRadioGroupID(0, DyntToggle.radioGroupKey(21, 1)))
    assert.deepEqual(
      plumage.members.map(member => member.row),
      [5, 6, 7]
    )
    assert.equal(plumage.selected?.row, 6)
    const fluffy = elementAt(screen, 6, 2)
    assert.deepEqual(fluffy.kind, ScreenElementKind.radioButton)
    assert.equal(fluffy.caption, "Fluffy")
    assert.deepEqual(fluffy.radioGroup, plumage.id)
    assert.equal(fluffy.isChecked, true)
    assert.equal(screen.radioGroups[1].members.length, 2)
    assert.equal(screen.radioGroups[1].selected?.row, 5)
    assert.equal(screen.diagnostics.duplicateRadioSelections, 0)
  })

  /** Radio Readings: shared field names group too; the fallback leaves radios ungrouped */
  test("radioReadings", () => {
    const items = controlsScreen()
    const named = items.screen(new ScreenReadings({ radioGroups: "sharedFieldName" }))
    assert.deepEqual(
      named.radioGroups.map(group => group.members.length),
      [3, 2]
    )
    assert.deepEqual(
      named.radioGroups.map(group => group.id.key),
      [1, 2]
    )
    const ungrouped = items.screen(new ScreenReadings({ radioGroups: "specGap" }))
    assert.equal(ungrouped.radioGroups.length, 0)
    assert.ok(ungrouped.elements.every(element => element.radioGroup === undefined))
  })

  /** Two selected buttons in a group: the first counts, the second is counted */
  test("duplicateSelection", () => {
    const items = new ElementItems()
    const atoms = new ElementAtoms()
    atoms.radio({ block: 21, row: 1, col: 1, selected: true, fname: "ZZVOL" }, "Whisper")
    atoms.radio({ block: 21, row: 2, col: 1, selected: true, fname: "ZZVOL" }, "Wake the neighbours")
    // A radio button without an FNAME joins no named group.
    atoms.toggle({ etype: etype("radiobutton3"), block: 23, group: 1, row: 3, col: 1, checked: false, visible: 5 }, "Loud")
    items.atoms(atoms)
    const screen = items.screen()
    assert.equal(screen.radioGroups[0]?.selected?.row, 1)
    assert.equal(screen.diagnostics.duplicateRadioSelections, 1)
    assert.equal(items.screen(new ScreenReadings({ radioGroups: "sharedFieldName" })).radioGroups.length, 1)
  })

  /** Dropdowns: a COMBOBOX with a ZZValueList; options, key, empty entry, function, tooltip; R-EL-3 */
  test("dropdowns", () => {
    const screen = controlsScreen().screen()
    const element = elementAt(screen, 9, 20)
    assert.deepEqual(element.kind, ScreenElementKind.dropdown)
    assert.equal(element.text, "RUBR")
    assert.equal(element.width, 20)
    assert.equal(element.maxLength, 4)
    const dropdown = element.dropdown
    assert.ok(dropdown !== undefined, "the element has a dropdown")
    assert.deepEqual(
      dropdown.options.map(option => option.key),
      ["MALL", "RUBR", "EIDR"]
    )
    assert.equal(dropdown.selectedOption?.text, "Rubber (honorary)")
    assert.ok(dropdown.allowsEmpty)
    assert.equal(element.firesFunction, "=ZZSPECIES")
    assert.equal(element.tooltip, "Pick a species")
    assert.equal(element.fieldName, "ZZDUCK-SPECIES")
    assert.ok(element.description.includes("3 options"), element.description)
    assert.equal(screen.diagnostics.undecodedElements, 0)
  })

  /** A COMBOBOX without a ZZValueList, COMBOSTYLE alone and the fallback stay as before */
  test("notDropdowns", () => {
    const items = new ElementItems()
    const atoms = new ElementAtoms()
    atoms.dropdown({ row: 1, col: 1, mlen: 8, key: "HONK", list: undefined, tooltip: "Only a tooltip" })
    atoms.dropdown({ row: 2, col: 1, mlen: 8, key: "", list: new ZZValueList({ values: [] }) })
    atoms.input({ row: 3, col: 1, mlen: 8, attributes: DyntAttributes.yes3D | DyntAttributes.comboStyle }, "ZZ_PROG")
    DyntAtomEncoder.appendAtom(ElementAtoms.header(etype("combobox"), { row: 4, col: 1 }), Uint8Array.from([1, 2]), atoms.writer)
    items.atoms(atoms)
    const screen = items.screen()
    assert.ok(ScreenElementKind.equals(elementAt(screen, 1, 1).kind, ScreenElementKind.other(etype("combobox1"))), ScreenElementKind.description(elementAt(screen, 1, 1).kind))
    assert.equal(elementAt(screen, 1, 1).text, undefined)
    assert.equal(screen.elements[0].tooltip, "Only a tooltip")
    const empty = elementAt(screen, 2, 1)
    assert.deepEqual(empty.kind, ScreenElementKind.dropdown)
    assert.equal(empty.dropdown?.selectedKey, undefined)
    assert.equal(empty.dropdown?.options.length === 0, true)
    assert.equal(empty.firesFunction, undefined)
    assert.deepEqual(elementAt(screen, 3, 1).kind, ScreenElementKind.input)
    assert.ok(ScreenElementKind.equals(elementAt(screen, 4, 1).kind, ScreenElementKind.other(etype("combobox"))), ScreenElementKind.description(elementAt(screen, 4, 1).kind))
    assert.equal(screen.diagnostics.undecodedElements, 2)
    const before = items.screen(ScreenReadings.beforeElements)
    assert.ok(before.elements.every(element => !ScreenElementKind.equals(element.kind, ScreenElementKind.dropdown)))
    assert.equal(before.diagnostics.undecodedElements, 0)
  })

  /** Field markers: required and date from flag1, numeric JUSTRIGHT, value help MATCHCODE; R-EL-16 */
  test("markers", () => {
    const items = controlsScreen()
    const screen = items.screen()
    const name = elementAt(screen, 10, 20)
    assert.ok(name.isRequired)
    assert.equal(name.inputFormat, "text")
    assert.ok(!name.hasValueHelp)
    const hatched = elementAt(screen, 11, 20)
    assert.ok(hatched.isRequired)
    assert.equal(hatched.inputFormat, "date")
    assert.ok(hatched.description.includes("required date"), hatched.description)
    const level = elementAt(screen, 12, 20)
    assert.ok(!level.isRequired)
    assert.equal(level.inputFormat, "numeric")
    const department = elementAt(screen, 13, 20)
    assert.ok(department.hasValueHelp)
    assert.ok(department.description.includes("F4"), department.description)
    assert.equal(elementAt(screen, 14, 20).inputFormat, "text")
    assert.equal(elementAt(screen, 9, 20).isRequired, false)

    const attributesOnly = items.screen(new ScreenReadings({ fieldMarkers: "attributesOnly" }))
    assert.ok(!elementAt(attributesOnly, 10, 20).isRequired)
    assert.equal(elementAt(attributesOnly, 11, 20).inputFormat, "text")
    assert.equal(elementAt(attributesOnly, 12, 20).inputFormat, "numeric")
    const none = items.screen(new ScreenReadings({ fieldMarkers: "specGap" }))
    assert.ok(none.elements.every(element => !element.isRequired && element.inputFormat === "text" && !element.hasValueHelp && !element.isDisabled))
  })

  /** flag1 bits are read on the _2 form only: a _1 field's byte is no marker */
  test("oneByteFlag", () => {
    const items = new ElementItems()
    const atoms = new ElementAtoms()
    atoms.field(etype("efield1"), { row: 1, col: 1, attributes: DyntAttributes.yes3D, flag1: 0x03, mlen: 5 }, "QUACK")
    items.atoms(atoms)
    const field = items.screen().elements[0]
    assert.ok(field !== undefined, "the screen has an element")
    assert.deepEqual(field.kind, ScreenElementKind.input)
    assert.ok(!field.isRequired)
    assert.equal(field.inputFormat, "text")
  })

  /** A PROTECTED push button is disabled and its function too; R-EL-19 */
  test("disabledButton", () => {
    const screen = controlsScreen().screen()
    const back = elementAt(screen, 16, 2)
    assert.ok(back.isDisabled)
    assert.ok(back.description.includes("disabled"), back.description)
    const backFunction = screen.functions.find(candidate => candidate.code === "=ZZPREV")
    assert.ok(backFunction !== undefined, "the screen offers =ZZPREV")
    assert.ok(!backFunction.isEnabled)
    throwsInfo(() => screen.inputStep(new FieldEdits(), FunctionTrigger.function(backFunction)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "disabled" } }
    })
    assert.equal(screen.functions.find(candidate => candidate.code === "=ZZNEXT")?.isEnabled, true)
    const before = controlsScreen().screen(new ScreenReadings({ fieldMarkers: "specGap" }))
    assert.equal(before.functions.find(candidate => candidate.code === "=ZZPREV")?.isEnabled, true)
  })
})

// MARK: - TabstripDecodingTests

/**
 * The duck file's tabstrip: container 3 at r5 c1 116 × 22, page 4 below the tab row (row 2,
 * column 1 of the tabstrip, Reading R-SS-15), four tabs (the second active), the page's fields
 * in area 4.
 */
function tabstripScreen(activeFlag = true): ElementItems {
  const items = new ElementItems()
  items.reset()
  items.container("tabstrip", { id: 3, row: 5, col: 1, width: 116, height: 22 })
  items.container("tabstripPage", { id: 4, row: 2, col: 1, width: 114, height: 19 })
  items.containerName("", "ZZ_DUCK_PERSONNEL", "0210")
  const tabs = new ElementAtoms()
  tabs.tab({ area: 3, col: 1, page: 1, code: "=ZZTAB_PERS" }, "Personal")
  tabs.tab({ area: 3, col: 12, page: 2, code: "=ZZTAB_JOB", active: activeFlag }, "@10@Job")
  tabs.tab({ area: 3, col: 20, page: 3, code: "=ZZTAB_PAY", attributes: DyntAttributes.protected }, "Pay")
  tabs.tab({ area: 3, col: 26, page: 4, code: "=ZZTAB_NOTES" }, "Notes")
  items.tabs(tabs)
  const page = new ElementAtoms()
  page.label({ area: 4, row: 1, col: 1, mlen: 10 }, "Job title")
  page.input({ area: 4, row: 1, col: 14, mlen: 20 }, "Rubber Duck Debugger")
  items.atoms(page)
  const main = new ElementAtoms()
  main.output({ row: 1, col: 2, mlen: 20 }, "Puddles McGee")
  items.atoms(main)
  return items
}

/** Tabstrips (Reading R-EL-5). */
describe("Screen elements: tabstrips", () => {
  /** Tabs, the active one, the page area and its elements */
  test("tabstrip", () => {
    const screen = tabstripScreen().screen()
    const tabstrip = screen.tabstrips[0]
    assert.ok(tabstrip !== undefined, "the screen has a tabstrip")
    assert.equal(screen.tabstrips.length, 1)
    assert.equal(tabstrip.id, 3)
    assert.deepEqual(tabstrip.frame, new GridRect(new GridPoint(5, 1), 22, 116))
    assert.deepEqual(
      tabstrip.tabs.map(tab => tab.caption),
      ["Personal", "Job", "Pay", "Notes"]
    )
    assert.deepEqual(
      tabstrip.tabs.map(tab => tab.functionCode),
      ["=ZZTAB_PERS", "=ZZTAB_JOB", "=ZZTAB_PAY", "=ZZTAB_NOTES"]
    )
    assert.deepEqual(
      tabstrip.tabs.map(tab => tab.pageID),
      [1, 2, 3, 4]
    )
    assert.equal(tabstrip.activeIndex, 1)
    assert.deepEqual(tabstrip.activeTab?.icon, new ScreenIcon("10"))
    assert.deepEqual(
      tabstrip.tabs.map(tab => tab.isDisabled),
      [false, false, true, false]
    )
    assert.equal(tabstrip.pageArea, 4)
    assert.equal(tabstrip.paging, "server")
    const jobTitle = elementAt(screen, 1, 14, { area: 4 })
    assert.equal(jobTitle.tabstripPage, 3)
    assert.deepEqual(jobTitle.placement, new GridPoint(8, 16))
    assert.equal(elementAt(screen, 1, 2).tabstripPage, undefined)
    assert.equal(screen.functions.find(candidate => candidate.code === "=ZZTAB_PAY")?.isEnabled, false, "a disabled tab is not fired")
  })

  /** Without an active flag the first tab is active; the fallback makes no tabstrip */
  test("fallbacks", () => {
    const items = tabstripScreen(false)
    assert.equal(items.screen().tabstrips[0]?.activeIndex, 0)
    const before = items.screen(ScreenReadings.beforeElements)
    assert.equal(before.tabstrips.length, 0)
    assert.ok(before.elements.every(element => element.tabstripPage === undefined))
    assert.equal(before.elements.filter(element => ScreenElementKind.equals(element.kind, ScreenElementKind.tab)).length, 4)
  })

  /** A TABSTRIP without tabs or page, and a page outside the tabstrip */
  test("emptyTabstrip", () => {
    const items = new ElementItems()
    items.container("tabstrip", { id: 5, row: 0, col: 0, width: 10, height: 5 })
    items.container("tabstripPage", { id: 6, row: 20, col: 0, width: 10, height: 5 })
    const tabstrip = items.screen().tabstrips[0]
    assert.ok(tabstrip !== undefined, "the screen has a tabstrip")
    assert.equal(tabstrip.tabs.length, 0)
    assert.equal(tabstrip.activeIndex, undefined)
    assert.equal(tabstrip.pageArea, undefined)
  })
})

// MARK: - TableDecodingTests

/**
 * The pond spots table: container 2 at r4 c1, 108 × 4 (header and three rows), rows 46 to 48 of
 * 1,000, a selector column, the columns Spot (output, key), Spot name (input), Heated
 * (checkbox) and Water (dropdown).
 */
function tableScreen(options: { scroll?: boolean; header?: boolean } = {}): ElementItems {
  const scroll = options.scroll ?? true
  const header = options.header ?? true
  const items = new ElementItems()
  items.reset()
  items.container("table", { id: 2, row: 4, col: 1, width: 108, height: 4 })
  items.containerName("", "ZZV_POND_SPOTS", "0100")
  if (scroll) {
    items.scrollInfos({ total: 1000, first: 46, visible: 3, totalWidth: 138, viewport: 108 })
  }
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

/** Table controls (Readings R-EL-7, R-EL-8, R-EL-10). */
describe("Screen elements: table controls", () => {
  /** Columns from the block-0 labels, rows from blocks 1 and up, the selector, cells and scroll state */
  test("table", () => {
    const screen = tableScreen().screen()
    const table = screen.tables[0]
    assert.ok(table !== undefined, "the screen has a table")
    assert.equal(screen.tables.length, 1)
    assert.equal(table.id, 2)
    assert.equal(table.name, "ZZV_POND_SPOTS")
    assert.deepEqual(table.frame, new GridRect(new GridPoint(4, 1), 4, 108))
    assert.deepEqual(
      table.columns.map(column => column.title),
      ["Spot", "Spot name", "Heated", "Water"]
    )
    assert.deepEqual(
      table.columns.map(column => column.fieldName),
      ["ZZSPOT-ID", "ZZSPOT-NAME", "ZZSPOT-HEATED", "ZZSPOT-WATER"]
    )
    assert.deepEqual(
      table.columns.map(column => column.width),
      [5, 24, 1, 14]
    )
    assert.deepEqual(
      table.columns.map(column => column.kind),
      [ScreenElementKind.output, ScreenElementKind.input, ScreenElementKind.checkbox, ScreenElementKind.dropdown]
    )
    assert.deepEqual(
      table.columns.map(column => column.isKey),
      [true, false, false, false]
    )
    assert.deepEqual(
      table.keyColumns.map(column => column.index),
      [0]
    )
    assert.deepEqual(table.scroll, new ScreenTableScroll({ firstRow: 46, totalRows: 1000, visibleRows: 3, totalWidth: 138, viewportWidth: 108 }))
    assert.deepEqual(
      table.rows.map(row => row.line),
      [46, 47, 48]
    )
    assert.deepEqual(
      table.rows.map(row => row.block),
      [1, 2, 3]
    )
    assert.deepEqual(
      table.rows.map(row => row.isSelected),
      [false, true, false]
    )
    assert.equal(table.selection.mode, "multiple")
    const second = table.rows[1]
    assert.deepEqual(second.selector, elementAt(screen, 2, 0, { area: 2 }).id)
    assert.equal(second.cells.filter(cell => cell !== undefined).length, 4)
    const name = elementAt(screen, 2, 8, { area: 2 })
    assert.deepEqual(second.cells[1], name.id)
    assert.deepEqual(name.table, new ScreenTableCell({ table: 2, line: 47, column: 1 }))
    assert.equal(elementAt(screen, 2, 0, { area: 2 }).table, undefined, "the selector is no cell")
    assert.equal(elementAt(screen, 0, 2, { area: 2, kind: ScreenElementKind.label }).table, undefined, "a header label is no cell")
    assert.equal(screen.diagnostics.unmatchedTableAtoms, 0)
  })

  /** Without SCROLL_INFOS the total is unknown and the first row 1; the fallback makes no table */
  test("fallbacks", () => {
    const unknown = tableScreen({ scroll: false }).screen().tables[0]
    assert.ok(unknown !== undefined, "the screen has a table")
    assert.deepEqual(unknown.scroll, new ScreenTableScroll({ firstRow: 1, totalRows: undefined, visibleRows: 3, totalWidth: undefined, viewportWidth: 108 }))
    assert.deepEqual(
      unknown.rows.map(row => row.line),
      [1, 2, 3]
    )
    const ignored = tableScreen()
      .screen(new ScreenReadings({ tableScrollState: "none" }))
      .tables[0]
    assert.ok(ignored !== undefined, "the screen has a table")
    assert.equal(ignored.scroll.totalRows, undefined)
    const before = tableScreen().screen(ScreenReadings.beforeElements)
    assert.equal(before.tables.length, 0)
    assert.ok(before.elements.every(element => element.table === undefined))
  })

  /** Without header labels the columns come from the first row, untitled */
  test("noHeader", () => {
    const table = tableScreen({ header: false }).screen().tables[0]
    assert.ok(table !== undefined, "the screen has a table")
    assert.deepEqual(
      table.columns.map(column => column.title),
      [undefined, undefined, undefined, undefined]
    )
    assert.deepEqual(
      table.columns.map(column => column.fieldName),
      [undefined, undefined, undefined, "ZZSPOT-WATER"]
    )
    assert.deepEqual(
      table.columns.map(column => column.width),
      [5, 24, 1, 14]
    )
    assert.ok(table.rows.every(row => row.selector !== undefined))
  })

  /** Atoms that fit no column, or a second atom in a column, are counted; a TABLE without atoms is no table */
  test("unmatched", () => {
    const items = new ElementItems()
    items.container("table", { id: 2, row: 0, col: 0, width: 40, height: 3 })
    const atoms = new ElementAtoms()
    atoms.label({ area: 2, block: 0, row: 0, col: 1, mlen: 5 }, "Nest")
    atoms.output({ area: 2, block: 0, row: 0, col: 20, mlen: 5 }, "stray")
    atoms.output({ area: 2, block: 1, row: 1, col: 1, mlen: 5 }, "N-0001")
    atoms.output({ area: 2, block: 1, row: 1, col: 3, mlen: 2 }, "xx")
    atoms.output({ area: 2, block: 1, row: 1, col: 30, mlen: 2 }, "yy")
    items.atoms(atoms)
    items.container("table", { id: 7, row: 10, col: 0, width: 40, height: 3 })
    const screen = items.screen()
    assert.equal(screen.tables.length, 1)
    assert.equal(screen.diagnostics.unmatchedTableAtoms, 3)
    const table = screen.tables[0]
    assert.ok(table !== undefined, "the screen has a table")
    assert.equal(table.selection.mode, "none")
    assert.equal(table.columns[0]?.isKey, true)
  })
})

// MARK: - ListDecodingTests

/** Three header lines and three body lines of a 220-line list, the page from line 21. */
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
  if (window) {
    items.window(ListWindowState.fromWindow({ totalLines: 220, firstLine: 21, visibleLines: 20, windowRows: 23, width: 80, visibleWidth: 80 }))
  }
  return items
}

/** The runs of `listScreen(false)` with the window state in other items. */
function runs(add: (items: ElementItems) => void): ElementItems {
  const items = listScreen(false)
  add(items)
  return items
}

/** Runs on rows 0 to `rows` − 1, one per row, and the window items `add` appends. */
function tallPage(rows: number, add: (items: ElementItems) => void): ElementItems {
  const items = new ElementItems()
  for (let row = 0; row < rows; row++) {
    items.run(row, 0, `Crumb ${row + 1} of a very long pond report`, { color: row < 3 ? 1 : 2 })
  }
  add(items)
  return items
}

/** Classic lists (Reading R-EL-11). */
describe("Screen elements: classic lists", () => {
  /** Header and body lines, segments with colour, flags and icons, and the window state */
  test("list", () => {
    const screen = listScreen().screen()
    const list = screen.list
    assert.ok(list !== undefined, "the screen has a list")
    assert.deepEqual(
      list.headerLines.map(line => line.row),
      [0, 1, 2]
    )
    assert.ok(list.headerLines.every(line => line.index === 0))
    assert.deepEqual(
      list.lines.map(line => line.index),
      [21, 22, 23]
    )
    assert.deepEqual(
      list.lines.map(line => line.row),
      [3, 4, 5]
    )
    assert.deepEqual(list.scroll, new ScreenListScroll({ firstLine: 21, totalLines: 220, visibleLines: 20, width: 80 }))
    assert.deepEqual(list.frame, new GridRect(new GridPoint(0, 0), 23, 80))
    const title = list.headerLines[0]?.segments[0]
    assert.ok(title !== undefined, "the first header line has a segment")
    assert.equal(title.color, "heading")
    assert.ok(title.isIntensified)
    assert.ok(!title.isHotspot)
    const duck = list.lines[0].segments
    assert.deepEqual(
      duck.map(segment => segment.column),
      [0, 13]
    )
    assert.equal(duck[0].text, "Puddles McGee")
    assert.equal(duck[0].color, "key")
    assert.ok(duck[0].isHotspot)
    assert.equal(duck[0].width, 13)
    assert.equal(duck[1].text, "  2026-09-01  12")
    assert.equal(duck[1].color, "normal")
    const subtotal = list.lines[1].segments[0]
    assert.ok(subtotal !== undefined, "the second line has a segment")
    assert.deepEqual(subtotal.icon, new ScreenIcon("0A"))
    assert.equal(subtotal.text, "Subtotal")
    assert.equal(subtotal.color, "total")
    assert.equal(list.lines[2].segments[0]?.isInverse, true)
    assert.equal(list.lines[2].segments[0]?.color, "positive")
    assert.equal(screen.elements.length, 0)
    assert.equal(screen.tables.length, 0)
  })

  /** Runs only: no header split, the total unknown; the fallback makes no list */
  test("readings", () => {
    const items = listScreen()
    const runsOnly = items.screen(new ScreenReadings({ list: "runsOnly" })).list
    assert.ok(runsOnly !== undefined, "the screen has a list")
    assert.equal(runsOnly.headerLines.length, 0)
    assert.deepEqual(
      runsOnly.lines.map(line => line.index),
      [1, 2, 3, 4, 5, 6]
    )
    assert.deepEqual(runsOnly.scroll, new ScreenListScroll({ firstLine: 1, totalLines: undefined, visibleLines: 6, width: undefined }))
    assert.equal(runsOnly.frame.columns, 35)
    assert.equal(items.screen(ScreenReadings.beforeElements).list, undefined)
    const noWindow = listScreen(false).screen().list
    assert.ok(noWindow !== undefined, "the screen has a list")
    assert.equal(noWindow.headerLines.length, 0)
  })

  /** A list window lower on the screen: its top is the first row its runs use */
  test("placedWindow", () => {
    const items = new ElementItems()
    items.run(2, 1, "Nest monitor", { color: 1 })
    items.run(3, 1, "N-0001", { color: 4, flags: ListRunFlags.hotspot })
    items.run(4, 3, "Egg rolled away")
    items.window(ListWindowState.fromWindow({ totalLines: 40, firstLine: 11, visibleLines: 10, windowRows: 11, width: 60, visibleWidth: 60 }))
    const list = items.screen().list
    assert.ok(list !== undefined, "the screen has a list")
    assert.deepEqual(
      list.headerLines.map(line => line.row),
      [2]
    )
    assert.deepEqual(
      list.lines.map(line => line.index),
      [11, 12]
    )
    assert.deepEqual(
      list.lines.map(line => line.row),
      [3, 4]
    )
    assert.deepEqual(list.frame, new GridRect(new GridPoint(2, 1), 11, 60))
    const runsOnly = items.screen(new ScreenReadings({ list: "runsOnly" })).list
    assert.ok(runsOnly !== undefined, "the screen has a list")
    assert.deepEqual(
      runsOnly.lines.map(line => line.index),
      [1, 2, 3]
    )
    assert.deepEqual(runsOnly.frame, new GridRect(new GridPoint(2, 1), 3, 17))
  })

  /** Runs below the window, unknown colours, runs without SBA and a message without runs */
  test("edges", () => {
    const items = new ElementItems()
    items.run(0, 0, "Heading", { color: 1 })
    items.run(9, 0, "Beyond the window")
    items.run(1, 0, "Odd colour", { color: 9 })
    items.raw(ListRun.textItem, utf8("No position"))
    items.window(ListWindowState.fromWindow({ totalLines: 1, firstLine: 1, visibleLines: 1, windowRows: 2, width: 20, visibleWidth: 20 }))
    const list = items.screen().list
    assert.ok(list !== undefined, "the screen has a list")
    assert.deepEqual(
      list.lines.map(line => line.row),
      [1]
    )
    assert.deepEqual(new Set(list.lines[0].segments.map(segment => segment.text)), new Set(["Odd colour", "No position"]))
    assert.deepEqual(
      list.lines[0].segments.map(segment => segment.color),
      ["normal", "normal"]
    )
    assert.equal(items.screen().diagnostics.unmatchedListLines, 1)
    assert.equal(controlsScreen().screen().list, undefined)
  })

  // MARK: The window without DYNN CHL (R-EL-21)

  /** Without DYNN CHL a plain CHL gives the window at DYNN CHL's positions (R-EL-21) */
  test("plainCHLWindow", () => {
    const items = runs(items => {
      items.plainWindow(ListWindowState.fromWindow({ totalLines: 153, firstLine: 16, visibleLines: 15, windowRows: 18, width: 100, visibleWidth: 81 }))
    })
    const screen = items.screen()
    const list = screen.list
    assert.ok(list !== undefined, "the screen has a list")
    assert.equal(list.windowSource, "plainCHL")
    assert.deepEqual(
      list.headerLines.map(line => line.row),
      [0, 1, 2]
    )
    assert.deepEqual(
      list.lines.map(line => line.index),
      [16, 17, 18]
    )
    assert.deepEqual(list.scroll, new ScreenListScroll({ firstLine: 16, totalLines: undefined, visibleLines: 15, width: 100 }), "no total: no page on its own")
    assert.deepEqual(list.frame, new GridRect(new GridPoint(0, 0), 18, 81))
    assert.equal(screen.diagnostics.plainListWindow?.maxListRow, 153)
    assert.equal(screen.diagnostics.implausibleListWindows, 0)
    const before = items.screen(new ScreenReadings({ listWindow: "dynnCHLOnly" })).list
    assert.ok(before !== undefined, "the screen has a list")
    assert.equal(before.windowSource, undefined, "as before R-EL-21")
    assert.equal(before.headerLines.length, 0, "as before R-EL-21")
    assert.equal(before.scroll.totalLines, undefined, "as before R-EL-21")
    assert.equal(items.screen(new ScreenReadings({ list: "runsOnly" })).list?.windowSource, undefined)
  })

  /** Without any CHL a SCROLL_INFOS outside a table gives the first line, page and widths, no header lines and no total (R-EL-21) */
  test("scrollInfosWindow", () => {
    const items = runs(items => {
      items.scrollInfos({ total: 153, first: 1, visible: 15, totalWidth: 100, viewport: 81 })
    })
    const screen = items.screen()
    const list = screen.list
    assert.ok(list !== undefined, "the screen has a list")
    assert.equal(list.windowSource, "scrollInfos")
    assert.equal(list.headerLines.length, 0)
    assert.deepEqual(
      list.lines.map(line => line.index),
      [1, 2, 3, 4, 5, 6]
    )
    assert.deepEqual(list.scroll, new ScreenListScroll({ firstLine: 1, totalLines: undefined, visibleLines: 15, width: 100 }), "no total: no page on its own")
    assert.deepEqual(list.frame, new GridRect(new GridPoint(0, 0), 6, 81))
    assert.equal(screen.diagnostics.listScrollInfos?.totalHeight, 153)
    assert.equal(screen.diagnostics.plainListWindow, undefined)
  })

  /** DYNN CHL first; a plain CHL that would hide lines falls back to SCROLL_INFOS; a table's SCROLL_INFOS is not the list's */
  test("windowPrecedence", () => {
    const plain = ListWindowState.fromWindow({ totalLines: 153, firstLine: 1, visibleLines: 15, windowRows: 18, width: 100, visibleWidth: 81 })
    assert.ok(plain !== undefined, "a window state")
    const both = runs(items => {
      items.plainWindow(plain)
      items.scrollInfos({ total: 99, first: 1, visible: 15, totalWidth: 90, viewport: 81 })
      items.window(ListWindowState.fromWindow({ totalLines: 220, firstLine: 21, visibleLines: 20, windowRows: 23, width: 80, visibleWidth: 80 }))
    })
    assert.equal(both.screen().list?.windowSource, "dynnCHL")
    assert.equal(both.screen().list?.scroll.totalLines, 220)
    const plainFirst = runs(items => {
      items.scrollInfos({ total: 99, first: 1, visible: 15, totalWidth: 90, viewport: 81 })
      items.plainWindow(plain)
    })
    assert.equal(plainFirst.screen().list?.windowSource, "plainCHL")
    // Too few lines in total for the ones shown, and a window that would cut the last runs off.
    const wrongs = [
      ListWindowState.fromWindow({ totalLines: 2, firstLine: 1, visibleLines: 3, windowRows: 6, width: 80, visibleWidth: 80 }),
      ListWindowState.fromWindow({ totalLines: 50, firstLine: 1, visibleLines: 2, windowRows: 4, width: 80, visibleWidth: 80 }),
      new ListWindowState({ dimListRow: 0, dimRow: 0, maxListRow: 0 })
    ]
    for (const wrong of wrongs) {
      const items = runs(items => {
        items.plainWindow(wrong)
        items.scrollInfos({ total: 99, first: 1, visible: 15, totalWidth: 90, viewport: 81 })
      })
      const screen = items.screen()
      assert.equal(screen.list?.windowSource, "scrollInfos")
      assert.equal(screen.list?.scroll.width, 90)
      assert.equal(screen.diagnostics.implausibleListWindows, 1)
      assert.equal(screen.diagnostics.unmatchedListLines, 0)
      const alone = runs(items => items.plainWindow(wrong)).screen()
      assert.equal(alone.list?.windowSource, undefined)
      assert.equal(alone.list?.lines.length, 6)
      assert.equal(alone.diagnostics.implausibleListWindows, 1)
    }
    const table = runs(items => {
      items.reset()
      items.container("table", { id: 2, row: 10, col: 1, width: 40, height: 5 })
      items.scrollInfos({ total: 99, first: 1, visible: 5, totalWidth: 40, viewport: 40 })
    })
    assert.equal(table.screen().list?.windowSource, undefined, "a SCROLL_INFOS after a TABLE container is the table's")
    assert.equal(new ScreenReadings().listWindow, "chlOrScrollInfos")
    assert.equal(ScreenReadings.beforeElements.listWindow, "dynnCHLOnly")
  })

  /** A page with more rows than the window item's page holds is not taken: it must have header lines the item does not say (R-EL-21) */
  test("pageTallerThanItsWindow", () => {
    // §7.3's numbers: 153 × 100 in all, 15 × 81 of data, and a page of 20 rows.
    const scrollInfos = tallPage(20, items => {
      items.scrollInfos({ total: 153, first: 1, visible: 15, totalWidth: 100, viewport: 81 })
    })
    const screen = scrollInfos.screen()
    const list = screen.list
    assert.ok(list !== undefined, "the screen has a list")
    assert.equal(list.windowSource, undefined)
    assert.equal(list.headerLines.length, 0)
    assert.deepEqual(
      list.lines.map(line => line.index),
      closedRange(1, 20)
    )
    assert.equal(list.scroll.totalLines, undefined, "no total, so no page is fetched on its own")
    assert.equal(screen.diagnostics.implausibleListWindows, 1)
    assert.equal(screen.diagnostics.unmatchedListLines, 0)
    assert.equal(screen.diagnostics.listScrollInfos?.dataHeight, 15, "the report still shows the numbers")
    const before = scrollInfos.screen(new ScreenReadings({ listWindow: "dynnCHLOnly" })).list
    assert.ok(before !== undefined, "the screen has a list")
    assert.deepEqual(before.lines, list.lines, "as Swooey 0.0.67")
    assert.deepEqual(before.scroll, list.scroll, "as Swooey 0.0.67")

    // A plain CHL without a window row count holds dimlistrow body rows per page, no more.
    const flat = ListWindowState.fromWindow({ totalLines: 153, firstLine: 1, visibleLines: 15, windowRows: 15, width: 100, visibleWidth: 81 })
    assert.ok(flat !== undefined, "a window state")
    const noDimRow = new ListWindowState({ ...flat, dimRow: 0 })
    const plain = tallPage(20, items => items.plainWindow(noDimRow)).screen()
    assert.equal(plain.list?.windowSource, undefined)
    assert.equal(plain.list?.lines.length, 20)
    assert.equal(plain.diagnostics.implausibleListWindows, 1)
    const both = tallPage(20, items => {
      items.plainWindow(noDimRow)
      items.scrollInfos({ total: 153, first: 1, visible: 15, totalWidth: 100, viewport: 81 })
    }).screen()
    assert.equal(both.list?.windowSource, undefined)
    assert.equal(both.diagnostics.implausibleListWindows, 2)

    // A page of exactly data_height rows is taken; a plain CHL that says the header lines fits a taller page.
    const exact = tallPage(15, items => {
      items.scrollInfos({ total: 153, first: 1, visible: 15, totalWidth: 100, viewport: 81 })
    }).screen()
    assert.equal(exact.list?.windowSource, "scrollInfos")
    assert.deepEqual(
      exact.list?.lines.map(line => line.index),
      closedRange(1, 15)
    )
    const headed = ListWindowState.fromWindow({ totalLines: 153, firstLine: 1, visibleLines: 15, windowRows: 22, width: 100, visibleWidth: 81 })
    assert.ok(headed !== undefined, "a window state")
    const withHeader = tallPage(20, items => {
      items.plainWindow(headed)
      items.scrollInfos({ total: 153, first: 1, visible: 15, totalWidth: 100, viewport: 81 })
    }).screen()
    const split = withHeader.list
    assert.ok(split !== undefined, "the screen has a list")
    assert.equal(split.windowSource, "plainCHL")
    assert.deepEqual(
      split.headerLines.map(line => line.row),
      closedRange(0, 6)
    )
    assert.deepEqual(
      split.lines.map(line => line.index),
      closedRange(1, 13)
    )
    assert.equal(split.scroll.totalLines, undefined)
  })
})

// MARK: - PopupMessageDecodingTests

/** Popups, typed messages and the cursor (Readings R-EL-13, R-EL-14, R-EL-17). */
describe("Screen elements: popups, messages and the cursor", () => {
  /** SES modal_number makes a popup with its level, position and size; R-EL-13 */
  test("popup", () => {
    const items = new ElementItems()
    items.text(ApplItem.varInfo("sessionTitle"), "Drain Spots")
    items.ses(new PopupWindow({ level: 2, row: 5, column: 10, rows: 8, columns: 50 }).applied(new SESValue({ eventArray: 1 })))
    const screen = items.screen()
    assert.deepEqual(
      screen.presentation,
      ScreenPresentation.popup(new ScreenPopup({ level: 2, frame: new GridRect(new GridPoint(4, 9), 8, 50), title: "Drain Spots" }))
    )
    assert.deepEqual(items.screen(ScreenReadings.beforeElements).presentation, ScreenPresentation.main)

    const unplaced = new ElementItems()
    unplaced.ses(new SESValue({ modalNumber: 1 }))
    assert.deepEqual(unplaced.screen().presentation, ScreenPresentation.popup(new ScreenPopup({ level: 1, frame: undefined, title: undefined })))
    const main = new ElementItems()
    main.ses(new SESValue({ modalNumber: 0, xPos: 3, yPos: 3, dimRow: 4, dimCol: 4 }))
    assert.deepEqual(main.screen().presentation, ScreenPresentation.main)
    const deep = new ElementItems()
    deep.ses(new SESValue({ modalNumber: 10 }))
    assert.deepEqual(deep.screen().presentation, ScreenPresentation.main, "above nine levels is a main screen")
  })

  /** MESTYPE2 gives the typed message with class and number; MESSAGE alone is type-less; R-EL-14 */
  test("messages", () => {
    const types: [StatusMessageType, ScreenMessageType][] = [
      [StatusMessageType.of("success"), ScreenMessageType.success],
      [StatusMessageType.of("information"), ScreenMessageType.information],
      [StatusMessageType.of("warning"), ScreenMessageType.warning],
      [StatusMessageType.of("error"), ScreenMessageType.error],
      [StatusMessageType.of("abort"), ScreenMessageType.abort]
    ]
    for (const [codec, model] of types) {
      const items = new ElementItems()
      items.message(codec, "@1B@Quack rejected: too many vowels.")
      const message = items.screen().statusMessage
      assert.ok(message !== undefined, "the screen has a status message")
      assert.deepEqual(message.type, model)
      assert.equal(message.text, "Quack rejected: too many vowels.")
      assert.deepEqual(message.id, new ScreenStatusMessageID({ messageClass: "ZZQUACK", number: "042" }))
    }
    const both = new ElementItems()
    both.text(ApplItem.stSystemInfo("message"), "Mind the swan   ")
    both.message(StatusMessageType.of("warning"), "The pond is getting crowded.", { messageClass: "", number: "   " })
    const warned = both.screen()
    assert.deepEqual(warned.statusMessage, new ScreenStatusMessage({ type: ScreenMessageType.warning, text: "The pond is getting crowded." }))
    assert.equal(warned.message, "Mind the swan")
    const before = both.screen(ScreenReadings.beforeElements)
    assert.deepEqual(before.statusMessage, new ScreenStatusMessage({ type: ScreenMessageType.none, text: "Mind the swan" }))

    const strings = new ElementItems()
    strings.raw(StatusMessageValue.item, utf8("E\u{0}ZZ\u{0}001\u{0}Wireshark style"))
    assert.deepEqual(
      strings.screen().statusMessage,
      new ScreenStatusMessage({ type: ScreenMessageType.error, text: "Wireshark style", id: new ScreenStatusMessageID({ messageClass: "ZZ", number: "001" }) })
    )
    const empty = new ElementItems()
    empty.raw(StatusMessageValue.item, [])
    empty.text(ApplItem.stSystemInfo("message"), "")
    assert.equal(empty.screen().statusMessage, undefined)
  })

  /** DYNT_FOCUS_1 gives the cursor: element, position, container and caret; R-EL-17 */
  test("cursor", () => {
    const items = tableScreen()
    items.focus({ row: 2, col: 10, colOffset: 3, containers: [2] })
    const screen = items.screen()
    const cursor = screen.cursor
    assert.ok(cursor !== undefined, "the screen has a cursor")
    assert.deepEqual(cursor.element, elementAt(screen, 2, 8, { area: 2 }).id)
    assert.deepEqual(cursor.position, new GridPoint(2, 10))
    assert.equal(cursor.area, 2)
    assert.equal(cursor.offset, 3)

    const exact = tableScreen()
    exact.focus({ row: 1, col: 33, containers: [2] })
    assert.deepEqual(exact.screen().cursor?.element, elementAt(exact.screen(), 1, 33, { area: 2 }).id)
    const nowhere = new ElementItems()
    nowhere.focus({ row: 9, col: 9, containers: [] })
    assert.deepEqual(nowhere.screen().cursor, new ScreenCursor({ element: undefined, position: new GridPoint(9, 9) }))
    assert.equal(new ElementItems().screen().cursor, undefined)
  })
})
