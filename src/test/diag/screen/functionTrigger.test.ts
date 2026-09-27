// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/FunctionTriggerTests.swift (MIT).
//
// The Duck Pond screens (Swift `Fixtures.items(_:)` and `Fixtures.items(screens:)`, which
// FakeScenarios built in process) come from the real fake server over TCP
// (src/test/support/screenSession.ts): the tests that read them skip without it. The form and the
// table of `positionalOKCodes` are the builders of ElementDecodingTests.swift, repeated at the end of
// this file (a node:test file cannot import another test file without running its tests too).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientInput,
  DiagHeader,
  DiagItemWalker,
  DyntAttributes,
  DyntElementType,
  FieldMarkers,
  InputEnvelope,
  InputFocus,
  UIControlType,
  UIEventFunctionKey,
  ZZValueList
} from "../../../diag/codec/index.js"
import {
  FieldEdits,
  FunctionReadings,
  FunctionTrigger,
  Screen,
  ScreenElementID,
  ScreenFunctionKind,
  ScreenInputError,
  ScreenPick,
  ScreenReadings,
  characterCount
} from "../../../diag/screen/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { ElementAtoms, ElementItems, elementAt } from "../../support/elementScreenBuilder.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const etype = DyntElementType.of

/**
 * The input step with a function trigger (client-input.md §7.5, §7.6): Enter (Reading R-CI-11), a
 * command in VARINFO OKCODE (R-CI-6), a function number in UI_EVENT_SOURCE (R-CI-9, R-CI-10) or as
 * an OK-code (R-CI-20, the default) and a push button's code in OKCODE (PV-0773), with the refusals
 * and the readings that switch them.
 */
describe("Function triggers", () => {
  const screenNamed = async (name: string): Promise<Screen> => Screen.fromItems(await Fixtures.items(name))

  /** Function numbers as UI events (Reading R-CI-10), Swooey's default up to 0.0.72. */
  const uiEvents = new FunctionReadings({ functionKey: "uiEventSource" })

  /** The UI_EVENT_SOURCE value of function `number` with the default readings. */
  const event = (number: number, row = 0, col = 0): Uint8Array => {
    const value = new ByteWriter()
    UIEventFunctionKey.appendFunctionKey(number, { controlRow: row, controlCol: col }, value)
    return value.toBytes()
  }

  /** Enter: the fields alone, or function number 0 when the reading says so */
  test("enter", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby")
    const plain = lobby.inputStep(new FieldEdits(), FunctionTrigger.enter)
    assert.equal(plain.items.length, 0)
    assert.equal(plain.uiEvent, undefined)
    const empty = lobby.inputStep(new FieldEdits(), FunctionTrigger.okCode(""))
    assert.equal(empty.items.length, 0)
    assert.equal(empty.uiEvent, undefined)
    const zero = lobby.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(0))
    assert.equal(zero.items.length, 0)
    assert.equal(zero.uiEvent, undefined)
    const readings = new FunctionReadings({ enter: "functionKeyZero" })
    assert.deepEqual(lobby.inputStep(new FieldEdits(), FunctionTrigger.enter, { readings }).uiEvent, event(0))
    assert.deepEqual(lobby.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(0), { readings }).uiEvent, event(0))
    const standardEnter = lobby.function("enter")
    assert.ok(standardEnter !== undefined)
    assert.equal(lobby.inputStep(new FieldEdits(), FunctionTrigger.function(standardEnter)).uiEvent, undefined)
  })

  /** a command travels in VARINFO OKCODE, unpadded; refused under the gap reading */
  test("command", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby")
    const step = lobby.inputStep(new FieldEdits(), FunctionTrigger.okCode("/nZZDUCK"))
    assert.deepEqual(step.items, [{ kind: "varInfoOKCode", text: utf8("/nZZDUCK") }])
    assert.equal(step.uiEvent, undefined)
    throwsInfo(
      () => lobby.inputStep(new FieldEdits(), FunctionTrigger.okCode("ZZDUCK"), { readings: new FunctionReadings({ okCodeCarrier: "specGap" }) }),
      ScreenInputError,
      { kind: "functionCode", value: { kind: "specGap", issue: 55 } }
    )
    const latin = Screen.fromItems(await Fixtures.items("pond-lobby"), { codePage: 1100 })
    throwsInfo(() => latin.inputStep(new FieldEdits(), FunctionTrigger.okCode("/n€")), ScreenInputError, { kind: "notEncodable", value: undefined })
  })

  /** a virtual key: its number in UI_EVENT_SOURCE, the cursor's place when given (R-CI-10) */
  test("virtualKey", { skip: skipWithoutFakeServer }, async () => {
    const duck = await screenNamed("pond-rubber-duck")
    const events = uiEvents
    const f8 = duck.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), { readings: events })
    assert.deepEqual(f8.uiEvent, event(8))
    assert.equal(f8.items.length, 0)
    const bug = duck.inputs[0]
    assert.ok(bug !== undefined)
    const edits = new FieldEdits()
    edits.setText("it only fails on Tuesdays", bug.id)
    const withCursor = duck.inputStep(edits, FunctionTrigger.virtualKey(8), { readings: events, cursor: bug.id })
    assert.deepEqual(withCursor.uiEvent, event(8, 4, 18))
    assert.equal(withCursor.fieldCount, 1)
    assert.deepEqual(
      duck.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), {
        readings: events,
        cursor: new ScreenElementID({ block: 9, row: 9, column: 9, elementType: 1 })
      }).uiEvent,
      event(8),
      "an unknown cursor element is no cursor"
    )
    assert.deepEqual(duck.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(42), { readings: events }).uiEvent, event(42), "undeclared keys fire")
    const narrow = new FunctionReadings({ functionKey: "uiEventSource", eventDataWidth: "oneByte", eventControlType: UIControlType.dynpro })
    const pysapStyle = duck.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(3), { readings: narrow })
    assert.deepEqual(pysapStyle.uiEvent, Uint8Array.of(0x0a, 0x00, 0x07, 0x00, 0x0a, 3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00))
    throwsInfo(
      () => duck.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(3), { readings: new FunctionReadings({ functionKey: "refused" }) }),
      ScreenInputError,
      { kind: "functionCode", value: { kind: "specGap", issue: 55 } }
    )
  })

  /** a key the screen declares only disabled, and a number that is no virtual key, are refused */
  test("refusedKeys", { skip: skipWithoutFakeServer }, async () => {
    const lobby = await screenNamed("pond-lobby")
    throwsInfo(() => lobby.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(20)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "disabled" } }
    })
    throwsInfo(
      () => lobby.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(11)),
      ScreenInputError,
      { kind: "functionCode", value: { kind: "function", value: { kind: "disabled" } } },
      "Save: the status declares no Ctrl+S"
    )
    throwsInfo(() => lobby.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(256)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "virtualKeyOutOfRange", value: 256 } }
    })
    throwsInfo(() => lobby.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(-1)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "virtualKeyOutOfRange", value: -1 } }
    })
  })

  /** a function: a push button sends its code, everything else its virtual key */
  test("functions", { skip: skipWithoutFakeServer }, async () => {
    const duck = await screenNamed("pond-rubber-duck")
    const ask = duck.functions.find(function_ => function_.code === "=ZZASK")
    assert.ok(ask !== undefined)
    const pressed = duck.inputStep(new FieldEdits(), FunctionTrigger.function(ask))
    assert.deepEqual(pressed.items, [{ kind: "varInfoOKCode", text: utf8("=ZZASK") }])
    assert.equal(pressed.uiEvent, undefined, "never both (PV-0773)")
    const squeak = duck.functionForVirtualKey(7)
    assert.ok(squeak !== undefined)
    assert.deepEqual(duck.inputStep(new FieldEdits(), FunctionTrigger.function(squeak), { readings: uiEvents }).uiEvent, event(7))
    const back = duck.function("back")
    assert.ok(back !== undefined)
    assert.deepEqual(duck.inputStep(new FieldEdits(), FunctionTrigger.function(back), { readings: uiEvents }).uiEvent, event(3))
    const lobby = await screenNamed("pond-lobby")
    const feed = lobby.functions.find(function_ => ScreenFunctionKind.equals(function_.kind, ScreenFunctionKind.menu(["Pond"])))
    assert.ok(feed !== undefined)
    assert.deepEqual(lobby.inputStep(new FieldEdits(), FunctionTrigger.function(feed), { readings: uiEvents }).uiEvent, event(5))
    // Reading R-CI-20, the default: the same functions as OK-codes.
    assert.deepEqual(
      duck.inputStep(new FieldEdits(), FunctionTrigger.function(squeak)).items,
      [{ kind: "varInfoOKCode", text: utf8("=ZZSQUEAK") }],
      "the Squeak push button stands for the Squeak entry"
    )
    const backStep = duck.inputStep(new FieldEdits(), FunctionTrigger.function(back))
    assert.deepEqual(backStep.functionCode, utf8("/03"))
    assert.equal(backStep.uiEvent, undefined)
    assert.deepEqual(lobby.inputStep(new FieldEdits(), FunctionTrigger.function(feed)).functionCode, utf8("/05"))
  })

  /** a function the screen does not offer, a disabled one, and one with no trigger are refused */
  test("refusedFunctions", { skip: skipWithoutFakeServer }, async () => {
    const duck = await screenNamed("pond-rubber-duck")
    const lobby = await screenNamed("pond-lobby")
    const ask = duck.functions.find(function_ => function_.code === "=ZZASK")
    assert.ok(ask !== undefined)
    throwsInfo(() => lobby.inputStep(new FieldEdits(), FunctionTrigger.function(ask)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "notOffered" } }
    })
    const swan = lobby.functionForVirtualKey(20)
    assert.ok(swan !== undefined)
    throwsInfo(() => lobby.inputStep(new FieldEdits(), FunctionTrigger.function(swan)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "disabled" } }
    })
    const opaque = Screen.fromItems(await Fixtures.items("pond-rubber-duck"), { readings: new ScreenReadings({ buttonStrings: "opaque" }) })
    const mute = opaque.functions.find(function_ => function_.kind.kind === "pushButton")
    assert.ok(mute !== undefined)
    throwsInfo(() => opaque.inputStep(new FieldEdits(), FunctionTrigger.function(mute)), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "function", value: { kind: "disabled" } }
    })
    const menuOnly = Screen.fromItems(
      await Fixtures.screens(`screen nest
  menu MENU_ACT
    entry "Nest" position 1 0 0 0 flags SEL,MEN
  menu MENU_MNU
    entry "Hatch" position 1 1 0 0 flags SEL vkey 100
end`)
    )
    const hatch = menuOnly.functions.find(function_ => function_.text === "Hatch")
    assert.ok(hatch !== undefined)
    throwsInfo(
      () => menuOnly.inputStep(new FieldEdits(), FunctionTrigger.function(hatch)),
      ScreenInputError,
      { kind: "functionCode", value: { kind: "specGap", issue: 55 } },
      "which item fires a menu-only item is open"
    )
  })

  /** an edited field and a function key make one message: fields, then the event, then EOM */
  test("message", { skip: skipWithoutFakeServer }, async () => {
    const duck = await screenNamed("pond-rubber-duck")
    const edits = new FieldEdits()
    const first = duck.inputs[0]
    assert.ok(first !== undefined)
    edits.setText("semicolon", first.id)
    const step = duck.inputStep(edits, FunctionTrigger.virtualKey(8), { readings: uiEvents })
    const encoder = Fixtures.encoder()
    const body = ClientInput.inputMessage(encoder, step).slice(DiagHeader.size)
    const walker = new DiagItemWalker()
    const appls: (ApplItem | undefined)[] = []
    for (let item = walker.next(body); item !== undefined; item = walker.next(body)) {
      appls.push(item.appl)
    }
    assert.deepEqual(appls, [ApplItem.stUser("dialogStepNumber"), ApplItem.dynt("atom"), ApplItem.uiEvent("uiEventSource"), undefined])
    assert.ok(step.description.includes("UI_EVENT_SOURCE: yes"), step.description)
    assert.ok(!step.description.includes("semicolon"))
  })

  /** Reading R-CI-20: F2 and F4 go as /02 and /04 with the focus on their element whatever the envelope; other keys at the cursor */
  test("positionalOKCodes", { skip: skipWithoutFakeServer }, async () => {
    const form = controlsScreen().screen()
    const department = elementAt(form, 13, 20)
    const help = form.inputStep(new FieldEdits(), FunctionTrigger.valueHelp(department.id))
    assert.deepEqual(help.functionCode, utf8("/04"))
    assert.equal(help.uiEvent, undefined)
    assert.deepEqual(help.focus, new InputFocus(13, 20, 4))
    assert.ok(InputEnvelope.contains(help.envelope, InputEnvelope.focus), "the command carries no position: the focus item does")
    assert.equal(help.fieldCount, 0, "no cursor field as received: that goes with a UI event only (PV-0779)")
    const table = tableScreen().screen()
    const spot = elementAt(table, 3, 2, { area: 2 })
    const echoes = new FunctionReadings()
    echoes.envelope = InputEnvelope.chlStage
    const chosen = table.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.element(spot.id)), { readings: echoes })
    assert.deepEqual(chosen.functionCode, utf8("/02"))
    assert.deepEqual(chosen.focus, new InputFocus(3, 2, 0, Uint8Array.of(2)))
    assert.equal(chosen.envelope, InputEnvelope.chlStage | InputEnvelope.focus)
    const duck = await screenNamed("pond-rubber-duck")
    const bug = duck.inputs[0]
    assert.ok(bug !== undefined)
    const f5 = duck.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(5), { readings: echoes, cursor: bug.id })
    assert.deepEqual(f5.functionCode, utf8("/05"))
    assert.deepEqual(
      f5.focus,
      new InputFocus(bug.atom.row, bug.atom.col, characterCount(bug.text ?? "")),
      "the cursor, which the UI event of R-CI-10 carried (#143)"
    )
    assert.equal(f5.envelope, InputEnvelope.chlStage | InputEnvelope.focus)
    const nowhere = duck.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(5), { readings: echoes })
    assert.equal(nowhere.focus, undefined, "no cursor: the command step of F5 (PV-0787)")
    assert.equal(nowhere.envelope, InputEnvelope.chlStage, "no cursor: the command step of F5 (PV-0787)")
  })

  /** Reading R-CI-20: a push button captioned like the status entry sends its code; an Enter as function key 0 stays a UI event */
  test("statusButtonCodes", { skip: skipWithoutFakeServer }, async () => {
    const screen = Screen.fromItems(
      await Fixtures.screens(`screen pier
  menu MENU_PFK
    entry "@0V@ Quack" info "Say it" flags SEL vkey 5 return 5
    entry "Honk" flags SEL vkey 6 return 6
  menu MENU_KYB
    entry "Honk Loudly" position 1 0 0 0 flags SEL vkey 6 return 6
  atoms
    button row 1 col 2 width 10 "Honk" function "=ZZMUTE" disabled
    button row 2 col 2 width 10 "Quack" function "=ZZQUACK"
    button row 3 col 2 width 10 "@0V@Honk Loudly" function "=ZZHONK"
end`)
    )
    assert.equal(screen.statusButtonCode(5), "=ZZQUACK", "the toolbar entry's caption, icon code left out")
    assert.equal(screen.statusButtonCode(6), "=ZZHONK", "a disabled button is passed over; the function-key list's caption")
    assert.equal(screen.statusButtonCode(7), undefined)
    assert.deepEqual(screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(6)).functionCode, utf8("=ZZHONK"))
    const zero = new FunctionReadings({ enter: "functionKeyZero" })
    const enter = screen.inputStep(new FieldEdits(), FunctionTrigger.enter, { readings: zero })
    assert.deepEqual(enter.uiEvent, event(0), "the Enter reading names the UI event")
    assert.equal(enter.functionCode, undefined, "the Enter reading names the UI event")
    throwsInfo(
      () => screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(5), { readings: new FunctionReadings({ okCodeCarrier: "specGap" }) }),
      ScreenInputError,
      { kind: "functionCode", value: { kind: "specGap", issue: 55 } }
    )
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
