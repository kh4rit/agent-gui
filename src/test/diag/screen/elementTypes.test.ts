// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ElementTypesTests.swift (MIT).

// The pinned model types of the mock-apps work (docs/protocol/elements.md; design §5): public
// initialisers, derived properties, defaults and switches, the new triggers on a screen without
// the elements, and that every screen of the fake server's older scenarios decodes with the new
// properties empty, as before elements.md, and every screen of every scenario cleanly. The
// decoding itself is tested in ElementDecodingTests and ElementInputStepTests.
//
// The tests that compiled every scenario in process (FakeScenarios' `ScenarioLibrary`) and read
// the gate from it run against the real fake server over TCP (src/test/support/screenSession.ts)
// and skip without it. The scenario screens are the ones a client receives: each scenario's reply
// to the first message and, when that is the logon program, its reply to the logon step (see
// `scenarioScreens`).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ComFlag, DyntElementType, DyntToggle, ElementValueReading, ScrollInfos, StatusMessageType, TableScrollState } from "../../../diag/codec/index.js"
import {
  FieldEdits,
  FunctionReadings,
  FunctionTrigger,
  GridPoint,
  GridRect,
  ListColor,
  Screen,
  ScreenCursor,
  ScreenDropdown,
  ScreenDropdownOption,
  ScreenElementID,
  ScreenElementKind,
  ScreenInputError,
  ScreenList,
  ScreenListLine,
  ScreenListScroll,
  ScreenListSegment,
  ScreenMessageType,
  ScreenPick,
  ScreenPopup,
  ScreenPresentation,
  ScreenRadioGroup,
  ScreenRadioGroupID,
  ScreenReadings,
  ScreenStatusMessage,
  ScreenStatusMessageID,
  ScreenTab,
  ScreenTable,
  ScreenTableCell,
  ScreenTableColumn,
  ScreenTableRow,
  ScreenTableScroll,
  ScreenTableSelection,
  ScreenTabstrip,
  type ScreenInputErrorInfo
} from "../../../diag/screen/index.js"
import { LogonStepError, type ServerMessage } from "../../../diag/session/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { Pond, fakeServerScenarios, messageItems, skipWithoutFakeServer } from "../../support/screenSession.js"

const elementA = new ScreenElementID({ block: 21, row: 5, column: 4, elementType: 129 })
const elementB = new ScreenElementID({ block: 21, row: 6, column: 4, elementType: 129 })

// MARK: - Real screens (over TCP)

/** One screen a scenario sent: `scenario/screen` and its item sequence. */
interface ScenarioScreen {
  name: string
  items: Uint8Array
}

/** What `scenarioScreens` read: the screens, and the scenarios the fake server could not run. */
interface ScenarioScreens {
  screens: ScenarioScreen[]
  notRun: string[]
}

/**
 * The name of the screen `message` is, from the server's log (`#1 sent screen pond-lobby
 * (returned 3 field(s)), 1397 bytes`: the log names structure only), matched by its frame's
 * length; `fallback` when no line matches.
 */
async function sentScreenName(pond: Pond, message: ServerMessage, fallback: string): Promise<string> {
  const bytes = `, ${message.payload.length} bytes`
  await pond.waitForLog(" sent screen ", bytes)
  const line = pond.logLines(" sent screen ", bytes).at(-1)
  return / sent screen ([^,\s(]+)/.exec(line ?? "")?.[1] ?? fallback
}

/**
 * The item sequence of `message` when it is a screen of the scenario (Swift took the item sequence
 * of each screen message the scenario defines); undefined for the server's closing messages (the
 * logoff message and a server error, both with EOC) and for a message with no items to read. A
 * message the session dropped because its item walk stopped gives its items up to the stop, as
 * `Screen.fromMessage` reads it (`lobby-with-unknown-type` of `unknown-item`).
 */
function screenItems(message: ServerMessage): Uint8Array | undefined {
  if (((message.header?.comFlag ?? 0) & ComFlag.eoc) !== 0) return undefined
  const screen = message.screen
  if (screen !== undefined) return screen.isServerError ? undefined : messageItems(message)
  const recovered = message.problem?.kind === "items" ? Screen.itemBytes(message.payload) : undefined
  return recovered === undefined || recovered.isServerError ? undefined : recovered.items
}

/** `promise`'s value, or undefined when the session ended first (the scenario closes) or `tolerated` is thrown. */
async function unlessClosed<Value>(promise: Promise<Value>, tolerated?: abstract new (...args: never[]) => Error): Promise<Value | undefined> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof assert.AssertionError && error.message.includes("the session ended first")) return undefined
    if (tolerated !== undefined && error instanceof tolerated) return undefined
    throw error
  }
}

let collected: Promise<ScenarioScreens> | undefined

/**
 * The screens a client receives from every scenario the fake server knows (Swift's
 * `scenarioScreens()`, which compiled every scenario of Tests/Scenarios in process and took every
 * screen message it defines). Over TCP only the screens a scenario's rules send can be read, so each
 * scenario is run once and gives its reply to the first message and, when that is the logon
 * program, its reply to the logon step (`Pond.logOn`, which reads past the control traffic the
 * session answers by itself). A scenario whose first reply is no screen (`server-error`) gives none;
 * one whose reply to the logon step is no screen (the logoff of `logoff` and `knock-knock`, the
 * server error of `logon-error`), which closes instead (`drop-mid-step`, `drop-mid-frame`), or whose
 * gate the logon step cannot fill (`tolerance`'s minimal gate has no client field: LogonStepError)
 * gives only the first. A scenario the fake server refuses to load is listed in `notRun`. Fetched
 * once per test file.
 */
function scenarioScreens(): Promise<ScenarioScreens> {
  collected ??= collectScenarioScreens()
  return collected
}

async function collectScenarioScreens(): Promise<ScenarioScreens> {
  const screens: ScenarioScreen[] = []
  const notRun: string[] = []
  for (const scenario of fakeServerScenarios()) {
    let pond: Pond
    try {
      pond = await Pond.open(scenario)
    } catch (error) {
      // The fake server exits when it cannot load the scenario file.
      if (error instanceof Error && error.message.startsWith("fake server exited")) {
        notRun.push(`${scenario}: ${error.message}`)
        continue
      }
      throw error
    }
    try {
      const first = await unlessClosed(pond.first())
      const firstItems = first === undefined ? undefined : screenItems(first)
      if (first === undefined || firstItems === undefined) continue
      screens.push({ name: `${scenario}/${await sentScreenName(pond, first, "first")}`, items: firstItems })
      if (!Screen.fromItems(firstItems).isLogonScreen) continue
      const reply = await unlessClosed(pond.logOn(first), LogonStepError)
      const replyItems = reply === undefined ? undefined : screenItems(reply)
      if (reply === undefined || replyItems === undefined) continue
      screens.push({ name: `${scenario}/${await sentScreenName(pond, reply, "after-logon")}`, items: replyItems })
    } finally {
      await pond.close()
    }
  }
  return { screens, notRun }
}

/**
 * The scenarios that existed before elements.md: their screens carry none of its markers.
 * Scenarios added since (the mock apps) are checked by `scenarioScreensDecodeCleanly`.
 */
const scenariosBeforeElements: ReadonlySet<string> = new Set([
  "drop-mid-frame",
  "drop-mid-step",
  "duck-pond-control",
  "duck-pond-incognito",
  "duck-pond-logon",
  "duck-pond-nameless",
  "duck-pond-new-quack",
  "duck-pond-progress",
  "duck-pond-wrong-quack",
  "keep-alive",
  "knock-knock",
  "logoff",
  "logon-error",
  "server-error",
  "tolerance",
  "unknown-item"
])

describe("Screen elements: pinned model types", () => {
  // MARK: Layout and controls

  /** GridRect: containment of points and rectangles, description */
  test("gridRect", () => {
    const tabstrip = new GridRect(new GridPoint(5, 1), 22, 116)
    const page = new GridRect(new GridPoint(7, 2), 19, 114)
    assert.ok(tabstrip.containsRect(page))
    assert.ok(!page.containsRect(tabstrip))
    assert.ok(tabstrip.contains(new GridPoint(5, 1)))
    assert.ok(!tabstrip.contains(new GridPoint(27, 1)))
    assert.ok(!tabstrip.contains(new GridPoint(5, 117)))
    assert.equal(tabstrip.description, "r5 c1 22x116")
  })

  /** Dropdowns, radio groups and tabstrips build from their public initialisers */
  test("controls", () => {
    const dropdown = new ScreenDropdown({
      options: [new ScreenDropdownOption({ key: "MALL", text: "Mallard" }), new ScreenDropdownOption({ key: "RUBR", text: "Rubber (honorary)" })],
      selectedKey: "RUBR",
      allowsEmpty: false
    })
    assert.equal(dropdown.selectedOption?.text, "Rubber (honorary)")
    assert.deepEqual(
      dropdown.options.map(option => option.id),
      ["MALL", "RUBR"]
    )
    assert.equal(new ScreenDropdown({ options: dropdown.options, selectedKey: "SWAN", allowsEmpty: true }).selectedOption, undefined)

    const group = new ScreenRadioGroup({
      id: new ScreenRadioGroupID(0, DyntToggle.radioGroupKey(21, 1)),
      members: [elementA, elementB],
      selected: elementB
    })
    assert.equal(group.id.key, 0x1501)
    assert.equal(group.id.description, "radio group a0 k5377")
    assert.ok(ScreenRadioGroupID.compare(new ScreenRadioGroupID(0, 9), new ScreenRadioGroupID(1, 0)) < 0)
    assert.ok(ScreenRadioGroupID.compare(new ScreenRadioGroupID(1, 2), new ScreenRadioGroupID(1, 3)) < 0)

    const tab = new ScreenTab({
      id: new ScreenElementID({ area: 3, block: 1, row: 0, column: 2, elementType: 116 }),
      caption: "Personal",
      functionCode: "=ZZTAB_PERS",
      pageID: 1,
      isActive: true
    })
    assert.ok(!tab.isDisabled)
    assert.equal(tab.icon, undefined)
    assert.equal(tab.tooltip, undefined)
    const tabstrip = new ScreenTabstrip({ id: 3, frame: new GridRect(new GridPoint(5, 1), 22, 116), tabs: [tab], activeIndex: 0, pageArea: 4 })
    assert.equal(tabstrip.paging, "server")
    assert.deepEqual(tabstrip.activeTab, tab)
    assert.equal(new ScreenTabstrip({ id: 3, frame: tabstrip.frame, tabs: [tab], activeIndex: 5, pageArea: undefined }).activeTab, undefined)
    assert.equal(new ScreenTabstrip({ id: 3, frame: tabstrip.frame, tabs: [], activeIndex: undefined, pageArea: undefined, paging: "local" }).activeTab, undefined)
  })

  /** Table controls: columns, rows, cells, key columns and the codec's scroll state */
  test("tables", () => {
    const columns = [
      new ScreenTableColumn({ index: 0, title: "Spot", fieldName: "ZZSPOT-ID", width: 5, kind: ScreenElementKind.output, isKey: true }),
      new ScreenTableColumn({ index: 1, title: "Spot name", fieldName: "ZZSPOT-NAME", width: 24, kind: ScreenElementKind.input, isKey: false }),
      new ScreenTableColumn({ index: 2, title: "Water", fieldName: "ZZSPOT-WATER", width: 14, kind: ScreenElementKind.dropdown, isKey: false })
    ]
    const row = new ScreenTableRow({
      line: 46,
      block: 1,
      cells: [new ScreenElementID({ area: 2, block: 1, row: 1, column: 2, elementType: 131 }), undefined, undefined],
      isSelected: true,
      selector: new ScreenElementID({ area: 2, block: 1, row: 1, column: 0, elementType: 128 })
    })
    const scroll = ScreenTableScroll.fromState(
      TableScrollState.fromScrollInfos(new ScrollInfos({ totalHeight: 1000, totalWidth: 138, dataHeight: 15, dataWidth: 108, heightOffset: 45, widthOffset: 0 }))
    )
    assert.deepEqual(scroll, new ScreenTableScroll({ firstRow: 46, totalRows: 1000, visibleRows: 15, totalWidth: 138, viewportWidth: 108 }))
    const table = new ScreenTable({
      id: 2,
      frame: new GridRect(new GridPoint(4, 1), 16, 108),
      name: "ZZV_POND_SPOTS",
      columns,
      rows: [row],
      scroll,
      selection: new ScreenTableSelection("multiple")
    })
    assert.deepEqual(
      table.keyColumns.map(column => column.id),
      [0]
    )
    assert.deepEqual(
      table.rows.map(tableRow => tableRow.id),
      [46]
    )
    assert.deepEqual(new ScreenTableCell({ table: 2, line: 46, column: 1 }), new ScreenTableCell({ table: 2, line: 46, column: 1 }))
    assert.notDeepEqual(new ScreenTableSelection("none"), table.selection)
  })

  /** Lists: colours in FORMAT COLOR numbering, segments, lines and scroll state */
  test("lists", () => {
    assert.deepEqual(
      ListColor.allCases.map(color => ListColor.rawValue(color)),
      [0, 1, 2, 3, 4, 5, 6, 7]
    )
    assert.equal(ListColor.fromRaw(4), "key")
    assert.equal(ListColor.fromRaw(8), undefined)
    const segment = new ScreenListSegment({ column: 0, width: 13, text: "Puddles McGee", color: "key", isHotspot: true })
    assert.ok(!segment.isIntensified)
    assert.ok(!segment.isInverse)
    assert.equal(segment.icon, undefined)
    const list = new ScreenList({
      frame: new GridRect(new GridPoint(0, 0), 23, 80),
      headerLines: [new ScreenListLine({ index: 0, row: 0, segments: [] })],
      lines: [new ScreenListLine({ index: 21, row: 3, segments: [segment] })],
      scroll: new ScreenListScroll({ firstLine: 21, totalLines: 220, visibleLines: 20, width: 80 })
    })
    assert.deepEqual(
      list.lines.map(line => line.id),
      [21]
    )
    assert.equal(list.scroll.totalLines, 220)
  })

  /** Popups, messages and the cursor */
  test("popupsAndMessages", () => {
    const popup = new ScreenPopup({ level: 2, frame: new GridRect(new GridPoint(4, 9), 8, 50), title: "Drain Spots" })
    assert.notDeepEqual(ScreenPresentation.popup(popup), ScreenPresentation.main)
    const message = new ScreenStatusMessage({
      type: ScreenMessageType.error,
      text: "Quack rejected: too many vowels.",
      id: new ScreenStatusMessageID({ messageClass: "ZZQUACK", number: "042" })
    })
    assert.equal(message.id?.number, "042")
    assert.equal(new ScreenStatusMessage({ type: ScreenMessageType.none, text: "Mind the swan" }).id, undefined)
    const dialogs = [
      ScreenMessageType.success,
      ScreenMessageType.information,
      ScreenMessageType.warning,
      ScreenMessageType.error,
      ScreenMessageType.abort,
      ScreenMessageType.exit,
      ScreenMessageType.none,
      ScreenMessageType.unknown(0x51)
    ].filter(type => ScreenMessageType.showsAsDialog(type))
    assert.deepEqual(dialogs, [ScreenMessageType.information, ScreenMessageType.abort])
    const codec: StatusMessageType[] = [
      StatusMessageType.of("success"),
      StatusMessageType.of("information"),
      StatusMessageType.of("warning"),
      StatusMessageType.of("error"),
      StatusMessageType.of("abort"),
      StatusMessageType.of("exit"),
      StatusMessageType.unknown(0x51)
    ]
    assert.deepEqual(
      codec.map(type => ScreenMessageType.of(type)),
      [
        ScreenMessageType.success,
        ScreenMessageType.information,
        ScreenMessageType.warning,
        ScreenMessageType.error,
        ScreenMessageType.abort,
        ScreenMessageType.exit,
        ScreenMessageType.unknown(0x51)
      ]
    )
    const cursor = new ScreenCursor({ element: elementA, position: new GridPoint(5, 4) })
    assert.equal(cursor.area, 0)
    assert.equal(cursor.offset, 0)
  })

  /** ScreenElementKind: dropdown is named, but the etype alone never makes one (R-EL-3) */
  test("dropdownKind", () => {
    assert.equal(ScreenElementKind.description(ScreenElementKind.dropdown), "dropdown")
    assert.deepEqual(ScreenElementKind.of(DyntElementType.of("combobox1")), ScreenElementKind.other(DyntElementType.of("combobox1")))
    assert.deepEqual(ScreenElementKind.of(DyntElementType.of("combobox")), ScreenElementKind.other(DyntElementType.of("combobox")))
  })

  // MARK: Switches

  /** The Readings' defaults are the first cases, and beforeElements is every fallback */
  test("readings", () => {
    const screen = new ScreenReadings()
    assert.equal(screen.checkbox, "pv0655")
    assert.equal(screen.radioGroups, "areaBlockGroup")
    assert.equal(screen.dropdown, "zzValueList")
    assert.equal(screen.tabstrip, "serverPaged")
    assert.equal(screen.table, "headerBlockZero")
    assert.equal(screen.tableScrollState, "scrollInfosAfterContainer")
    assert.equal(screen.fieldMarkers, "flag1Bits")
    assert.equal(screen.list, "runsWithCHL")
    assert.equal(screen.popup, "sesModalNumber")
    assert.equal(screen.messageType, "mestype2")
    const before = ScreenReadings.beforeElements
    assert.equal(before.checkbox, "specGap")
    assert.equal(before.radioGroups, "specGap")
    assert.equal(before.dropdown, "specGap")
    assert.equal(before.tabstrip, "specGap")
    assert.equal(before.table, "specGap")
    assert.equal(before.tableScrollState, "none")
    assert.equal(before.fieldMarkers, "specGap")
    assert.equal(before.list, "specGap")
    assert.equal(before.popup, "never")
    assert.equal(before.messageType, "messageOnly")
    assert.equal(before.buttonStrings, screen.buttonStrings)
    assert.ok(before.menuEntryPadding)
    assert.ok(before.menuEnabledBySEL)
    const readings = new FunctionReadings()
    assert.deepEqual(readings.elementValues, new ElementValueReading())
    assert.equal(readings.tableScroll, "keysAndRowRecord")
    assert.equal(readings.valueHelp, "functionKey4")
    assert.equal(readings.cursorContainers, "area")
    assert.equal(readings.listPaging, "okCodes")
  })

  // MARK: Input side

  /** FieldEdits keep checkbox, radio, dropdown and row edits apart from field texts */
  test("elementEdits", () => {
    const edits = new FieldEdits()
    assert.ok(!edits.hasElementEdits)
    edits.setChecked(true, elementA)
    assert.equal(edits.isChecked(elementA), true)
    assert.equal(edits.isChecked(elementB), undefined)
    edits.select(elementB)
    assert.equal(edits.isChecked(elementB), true)
    edits.setChecked(false, elementB)
    assert.equal(edits.isChecked(elementB), false)
    edits.setDropdownKey(undefined, new ScreenElementID({ block: 1, row: 2, column: 70, elementType: 126 }))
    edits.setTableRowSelected(true, 46, 2)
    assert.ok(edits.hasElementEdits)
    assert.ok(edits.isEmpty)
    assert.equal(edits.count, 0)
    assert.equal(edits.description, "FieldEdits(0 fields)")
  })

  /** The new triggers on the gate, which has none of the elements: refused with what it lacks */
  test("triggersOnPlainScreen", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const field = Fixtures.input(gate, gate.inputs[0].row).id
    const cases: [FunctionTrigger, ScreenInputErrorInfo][] = [
      [FunctionTrigger.scrollTable(2, 31), { kind: "functionCode", value: { kind: "function", value: { kind: "notOffered" } } }],
      [FunctionTrigger.valueHelp(field), { kind: "notOffered", value: field }],
      // The gate's GUI status offers F2 disabled.
      [FunctionTrigger.choose(ScreenPick.element(field)), { kind: "functionCode", value: { kind: "function", value: { kind: "disabled" } } }],
      [FunctionTrigger.choose(ScreenPick.list(3, 0)), { kind: "functionCode", value: { kind: "function", value: { kind: "disabled" } } }],
      [FunctionTrigger.elementFunction(field), { kind: "notOffered", value: field }]
    ]
    for (const [trigger, error] of cases) {
      throwsInfo(() => gate.inputStep(new FieldEdits(), trigger), ScreenInputError, error, trigger.kind)
    }
    assert.notDeepEqual(ScreenPick.list(3, 0), ScreenPick.element(field))
    const notOffered: ScreenInputErrorInfo = { kind: "notOffered", value: field }
    const unknownElement: ScreenInputErrorInfo = { kind: "unknownElement", value: field }
    assert.notDeepEqual(notOffered, unknownElement)
  })

  // MARK: Real screens

  // The guard for Phase 1 ("real screens without the invented markers decode exactly as today"):
  // the same elements with every Reading at its default and at its fallback, and none of the
  // invented structures.

  /** Every scenario screen from before elements.md decodes with the new properties empty */
  test("scenarioScreensDecodeAsBefore", { skip: skipWithoutFakeServer }, async t => {
    const { screens: all, notRun } = await scenarioScreens()
    for (const scenario of notRun) t.diagnostic(`not run: ${scenario}`)
    const screens = all.filter(screen => scenariosBeforeElements.has(screen.name.split("/")[0]))
    // Swift compiled every screen message these scenarios define (at least 20). Over TCP only the
    // first reply and the reply to the logon step are read (`scenarioScreens`): 24 of them here,
    // two of each scenario but one of drop-mid-frame, drop-mid-step, knock-knock, logoff,
    // logon-error and tolerance, and none of server-error. So Swift's bound still holds.
    t.diagnostic(`${screens.length} screens: ${screens.map(screen => screen.name).join(", ")}`)
    assert.ok(screens.length >= 20, `${screens.length} screens: ${screens.map(screen => screen.name).join(", ")}`)
    for (const { name, items } of screens) {
      const screen = Screen.fromItems(items)
      const before = Screen.fromItems(items, { readings: ScreenReadings.beforeElements })
      assert.ok(screen.radioGroups.length === 0 && screen.tabstrips.length === 0 && screen.tables.length === 0, name)
      assert.ok(screen.list === undefined && screen.presentation.kind === "main", name)
      // A type-less MESSAGE may become a statusMessage of type .none (R-EL-14); never a typed one.
      assert.ok(screen.statusMessage === undefined || screen.statusMessage.type.kind === "none", name)
      assert.deepEqual(
        screen.elements.map(element => element.kind),
        before.elements.map(element => element.kind),
        name
      )
      assert.deepEqual(
        screen.elements.map(element => element.id),
        before.elements.map(element => element.id),
        name
      )
      assert.deepEqual(
        screen.elements.map(element => element.text),
        before.elements.map(element => element.text),
        name
      )
      assert.deepEqual(
        screen.elements.map(element => element.placement),
        before.elements.map(element => element.placement),
        name
      )
      assert.equal(screen.message, before.message, name)
      for (const element of screen.elements) {
        assert.ok(!ScreenElementKind.equals(element.kind, ScreenElementKind.dropdown), `${name} ${element.id.description}`)
        assert.ok(element.dropdown === undefined && element.radioGroup === undefined && element.table === undefined && element.tabstripPage === undefined, name)
        // The invented markers never appear on these screens (their flag1 bytes are zero).
        assert.ok(!element.isRequired && element.inputFormat !== "date" && element.firesFunction === undefined, name)
      }
      const diagnostics = screen.diagnostics
      assert.ok(diagnostics.undecodedElements === 0 && diagnostics.unmatchedTableAtoms === 0, name)
      assert.ok(diagnostics.unmatchedListLines === 0 && diagnostics.duplicateRadioSelections === 0, name)
    }
  })

  // Every screen of every scenario decodes without an element a Reading could not read: what the
  // fake server sends through the shared encoders, the model reads back (design §3.1).

  /** Every scenario screen decodes cleanly under the element Readings */
  test("scenarioScreensDecodeCleanly", { skip: skipWithoutFakeServer }, async t => {
    const { screens, notRun } = await scenarioScreens()
    for (const scenario of notRun) t.diagnostic(`not run: ${scenario}`)
    t.diagnostic(`${screens.length} screens`)
    for (const { name, items } of screens) {
      const screen = Screen.fromItems(items)
      const diagnostics = screen.diagnostics
      // The paddling duck's radio buttons have bodies Reading R-EL-1 does not read, on purpose
      // (`unread-body`, issue #149): the only elements left undecoded.
      const unread = screen.elements.filter(element => element.kind.kind === "radioButton" && element.isChecked === undefined).length
      const paddling = name.startsWith("duck-pond-paddling/") || name.startsWith("duck-pond-pond-rules/")
      assert.ok(diagnostics.undecodedElements === unread && (unread === 0 || paddling), `${name}: ${diagnostics.undecodedElements} undecoded, ${unread} unread radios`)
      assert.equal(diagnostics.unmatchedTableAtoms, 0, name)
      assert.ok(diagnostics.unmatchedListLines === 0 && diagnostics.duplicateRadioSelections === 0, name)
      assert.ok(diagnostics.atomsWithoutContainer === 0 && diagnostics.stoppedAtomWalks === 0, name)
      for (const group of screen.radioGroups) {
        assert.ok(group.members.length >= 1, `${name} ${group.id.description}`)
      }
      for (const element of screen.elements.filter(candidate => ScreenElementKind.equals(candidate.kind, ScreenElementKind.dropdown))) {
        assert.ok(element.dropdown !== undefined, `${name} ${element.id.description}`)
      }
    }
  })
})
