// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0143Tests.swift (MIT).

// Issue #143: on the owner's popup every function key (Execute, Cancel, save as variant) went out as
// a UI_EVENT_SOURCE event (Reading R-CI-10) and the server answered each as Enter (PV-0786), while
// commands in VARINFO OKCODE work (PV-0787). Neither MIT client sends that event; they fire a
// function through the OK-code (PV-0789). Reading R-CI-20 (client-input.md §7.6), the default: a
// function goes as VARINFO OKCODE text, the code of the screen's push button captioned like the
// function when there is one, else `/` and its number (PV-0790). The UI event stays selectable, and
// Reading R-CI-21 sends the cursor with it as a witnessed GUI does.
//
// The Beaver Dam popup (duck-pond-dam) and the inline `.screens` texts come from the real fake server
// over TCP (src/test/support/screenSession.ts), and the tests skip without it.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientInput,
  DiagHeader,
  DiagItemType,
  DiagItemWalkError,
  DiagItemWalker,
  FunctionKeyOKCode,
  InputEnvelope,
  InputFocus,
  ServerEcho,
  UIEventFunctionKey,
  type DiagItem
} from "../../../diag/codec/index.js"
import { FieldEdits, FunctionReadings, FunctionTrigger, Screen, ScreenInputError } from "../../../diag/screen/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Swift `Bug0142Tests.damScreen`: a screen of duck-pond-dam. */
async function damScreen(name: string): Promise<Screen> {
  return Screen.fromItems(await Fixtures.items(name, "duck-pond-dam"))
}

/** Swift `FunctionTriggerTests.event`: the UI_EVENT_SOURCE value of function key `number`. */
function event(number: number, row = 0, col = 0): Uint8Array {
  const value = new ByteWriter()
  UIEventFunctionKey.appendFunctionKey(number, { controlRow: row, controlCol: col }, value)
  return value.toBytes()
}

/** The suite's static members (Swift `Self.defaults`, `Self.checkScreen`, `Self.itemNames`). */
const Self = {
  defaults: new FunctionReadings(),

  /** A popup whose toolbar Check has a push button captioned Check on the screen. */
  async checkScreen(): Promise<Screen> {
    return Screen.fromItems(
      await Fixtures.screens(`screen check
  window popup level 1 row 3 col 5 rows 6 cols 40
  menu MENU_PFK
    entry "@15@" info "Open the sluice" flags SEL vkey 8 return 8
    entry "@38@ Check" info "Check the dam" flags SEL vkey 19 return 19
    entry "@0W@" info "Paddle away" flags SEL vkey 12 return 12
  atoms
    label row 1 col 2 mlen 10 "Dam" fname "ZZDAM-ID"
    input row 1 col 14 mlen 4 max 4 "" pad 4 fname "ZZDAM-ID"
    button row 3 col 2 width 12 "Check" function "=ZZCHECK"
end`)
    )
  },

  /** Each item of a message body by its registry name, or its type for a simple item. */
  itemNames(body: Uint8Array): string[] {
    const walker = new DiagItemWalker()
    const names: string[] = []
    for (;;) {
      let item: DiagItem | undefined
      try {
        item = walker.next(body)
      } catch (error) {
        if (!(error instanceof DiagItemWalkError)) throw error
        break
      }
      if (item === undefined) break
      names.push(item.appl !== undefined ? ApplItem.displayName(item.appl) : DiagItemType.name(item.type))
    }
    return names
  }
}

describe("Function keys go as OK-codes", () => {
  for (const key of [8, 12, 32]) {
    /** the dam popup: Execute, Cancel and save as variant go as /08, /12 and /32 in VARINFO OKCODE, with no UI event (bug #143) */
    test(`damPopupFunctions(${key})`, { skip: skipWithoutFakeServer }, async () => {
      const popup = await damScreen("dam-select")
      const code = utf8(FunctionKeyOKCode.text(key))
      assert.equal(code.length, 3)
      const fn = popup.functionForVirtualKey(key)
      assert.ok(fn !== undefined)
      const step = popup.inputStep(new FieldEdits(), FunctionTrigger.function(fn), { readings: Self.defaults })
      assert.deepEqual(step.functionCode, code)
      assert.equal(step.uiEvent, undefined, "never both (PV-0773)")
      const pressed = popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(key), { readings: Self.defaults })
      assert.deepEqual(pressed.functionCode, code, "the key itself")
      assert.equal(pressed.uiEvent, undefined)
    })
  }

  /** Enter stays the fields alone; a key the popup does not declare goes too (bug #143) */
  test("enterAndUndeclared", { skip: skipWithoutFakeServer }, async () => {
    const popup = await damScreen("dam-select")
    const enter = popup.inputStep(new FieldEdits(), FunctionTrigger.enter, { readings: Self.defaults })
    assert.equal(enter.functionCode, undefined)
    assert.equal(enter.uiEvent, undefined, "Enter stays the fields alone (R-CI-11)")
    const undeclared = popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(5), { readings: Self.defaults })
    assert.deepEqual(undeclared.functionCode, utf8("/05"), "the server decides")
    throwsInfo(
      () => popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(3), { readings: Self.defaults }),
      ScreenInputError,
      { kind: "functionCode", value: { kind: "function", value: { kind: "disabled" } } },
      "Back: the popup's status offers no 3"
    )
  })

  /** a push button captioned like the function sends its code; otherwise /NN (bug #143) */
  test("pushButtonCaption", { skip: skipWithoutFakeServer }, async () => {
    const screen = await Self.checkScreen()
    const check = screen.functionForVirtualKey(19)
    assert.ok(check !== undefined)
    assert.deepEqual(screen.inputStep(new FieldEdits(), FunctionTrigger.function(check)).functionCode, utf8("=ZZCHECK"))
    assert.deepEqual(screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(19)).functionCode, utf8("=ZZCHECK"))
    const execute = screen.functionForVirtualKey(8)
    assert.ok(execute !== undefined)
    assert.deepEqual(screen.inputStep(new FieldEdits(), FunctionTrigger.function(execute)).functionCode, utf8("/08"), "an icon alone matches no caption")
  })

  /** the other choices: the button's code else the UI event; the UI event always; refused (bug #143) */
  test("otherChoices", { skip: skipWithoutFakeServer }, async () => {
    const screen = await Self.checkScreen()
    const check = screen.functionForVirtualKey(19)
    assert.ok(check !== undefined)
    const execute = screen.functionForVirtualKey(8)
    assert.ok(execute !== undefined)
    const buttonFirst = new FunctionReadings({ functionKey: "okCodeOrUIEvent" })
    assert.deepEqual(screen.inputStep(new FieldEdits(), FunctionTrigger.function(check), { readings: buttonFirst }).functionCode, utf8("=ZZCHECK"))
    const fallback = screen.inputStep(new FieldEdits(), FunctionTrigger.function(execute), { readings: buttonFirst })
    const eight = event(8)
    assert.equal(fallback.functionCode, undefined)
    assert.deepEqual(fallback.uiEvent, eight)
    const eventReadings = new FunctionReadings({ functionKey: "uiEventSource" })
    const old = screen.inputStep(new FieldEdits(), FunctionTrigger.function(check), { readings: eventReadings })
    const nineteen = event(19)
    assert.equal(old.functionCode, undefined, "Reading R-CI-10, as Swooey 0.0.72 sent it")
    assert.deepEqual(old.uiEvent, nineteen, "Reading R-CI-10, as Swooey 0.0.72 sent it")
    throwsInfo(
      () => screen.inputStep(new FieldEdits(), FunctionTrigger.function(execute), { readings: new FunctionReadings({ functionKey: "refused" }) }),
      ScreenInputError,
      { kind: "functionCode", value: { kind: "specGap", issue: 55 } }
    )
  })

  /** the OK-code step is the command step: echoes, OKCODE, DYNN CHL, DYNT_NOFOCUS, EOM (bug #143) */
  test("okCodeStepItems", { skip: skipWithoutFakeServer }, async () => {
    const popup = await damScreen("dam-select")
    const readings = Self.defaults.clone()
    readings.envelope = InputEnvelope.chlStage
    const dam = popup.inputs[0]
    assert.ok(dam !== undefined)
    const step = popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), { readings, cursor: dam.id })
    const encoder = Fixtures.encoder()
    const damItems = await Fixtures.items("dam-select", "duck-pond-dam")
    const echo = new ServerEcho(damItems)
    echo.stepNumber = 7
    echo.codepageDiagGUI = Uint8Array.of(0x00, 0x00, 0x10, 0x0e)
    const body = ClientInput.inputMessage(encoder, step, 0, echo).slice(DiagHeader.size)
    assert.deepEqual(Self.itemNames(body), [
      "ST_USER DIALOG_STEP_NUMBER",
      "SES",
      "ST_R3INFO CODEPAGE_DIAG_GUI",
      "VARINFO OKCODE",
      "DYNN CHL",
      "DYNT DYNT_NOFOCUS",
      "DYNT DYNT_FOCUS_1",
      "EOM"
    ])
    assert.deepEqual(step.focus, new InputFocus(dam.atom.row, dam.atom.col, 1), "the cursor, which the command does not carry")
    const nowhere = popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), { readings })
    const bare = ClientInput.inputMessage(encoder, nowhere, 0, echo).slice(DiagHeader.size)
    assert.deepEqual(
      Self.itemNames(bare),
      ["ST_USER DIALOG_STEP_NUMBER", "SES", "ST_R3INFO CODEPAGE_DIAG_GUI", "VARINFO OKCODE", "DYNN CHL", "DYNT DYNT_NOFOCUS", "EOM"],
      "no cursor: the command step as it works live (PV-0787)"
    )
    assert.equal(nowhere.focus, undefined)
  })

  /** a function number sent as an OK-code carries the cursor in a DYNT_FOCUS_1, whatever the envelope and the trigger (bug #143) */
  test("okCodeCarriesTheCursor", { skip: skipWithoutFakeServer }, async () => {
    const screen = Screen.fromItems(
      await Fixtures.screens(`screen lodge
  menu MENU_PFK
    entry "@15@" info "Open the sluice" flags SEL vkey 8 return 8
    entry "@38@ Check" info "Check the dam" flags SEL vkey 19 return 19
  menu MENU_KYB
    entry "Pick a Beaver" position 1 0 0 0 flags SEL vkey 2 return 2
  atoms
    label row 1 col 2 mlen 10 "Lodge" fname "ZZLODGE-ID"
    input row 1 col 14 mlen 4 max 4 "" pad 4 fname "ZZLODGE-ID"
    label row 2 col 2 mlen 10 "Dam" fname "ZZDAM-ID"
    input row 2 col 14 mlen 4 max 4 "" pad 4 fname "ZZDAM-ID"
    button row 3 col 2 width 12 "Check" function "=ZZCHECK"
end`)
    )
    const dam = screen.inputs[screen.inputs.length - 1]
    assert.ok(dam !== undefined)
    assert.ok(dam.atom.row === 2 && dam.atom.col === 14, "the cursor on the second input")
    const readings = Self.defaults.clone()
    readings.envelope = InputEnvelope.chlStage
    const expected = new InputFocus(dam.atom.row, dam.atom.col)
    // F2 on a plain field goes as the key, not as a choice (SessionKeyRouting): the UI event of
    // R-CI-10 carried the cursor's row and column, so the OK-code step must too.
    const choose = screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(2), { readings, cursor: dam.id })
    assert.deepEqual(choose.functionCode, utf8("/02"))
    assert.equal(choose.uiEvent, undefined)
    assert.deepEqual(choose.focus, expected)
    assert.ok(InputEnvelope.contains(choose.envelope, InputEnvelope.focus))
    const execute = screen.functionForVirtualKey(8)
    assert.ok(execute !== undefined)
    const toolbar = screen.inputStep(new FieldEdits(), FunctionTrigger.function(execute), { readings, cursor: dam.id })
    assert.deepEqual(toolbar.functionCode, utf8("/08"), "a toolbar function reads the cursor too")
    assert.deepEqual(toolbar.focus, expected, "a toolbar function reads the cursor too")
    const check = screen.functionForVirtualKey(19)
    assert.ok(check !== undefined)
    const paired = screen.inputStep(new FieldEdits(), FunctionTrigger.function(check), { readings, cursor: dam.id })
    assert.deepEqual(paired.functionCode, utf8("=ZZCHECK"), "the function's button code, fired by its number")
    assert.deepEqual(paired.focus, expected, "the function's button code, fired by its number")
    const other = screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(19), { readings, cursor: dam.id })
    assert.deepEqual(other.focus, expected)
    const edits = new FieldEdits()
    edits.setText("42", dam.id)
    const typed = screen.inputStep(edits, FunctionTrigger.virtualKey(8), { readings, cursor: dam.id })
    assert.deepEqual(typed.focus, new InputFocus(dam.atom.row, dam.atom.col, 2), "after the typed text")
    assert.equal(typed.fieldCount, 1)
    assert.equal(screen.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), { readings }).focus, undefined, "no cursor: no focus")
    const command = screen.inputStep(new FieldEdits(), FunctionTrigger.okCode("/nZZDAM_MON"), { readings, cursor: dam.id })
    assert.equal(command.focus, undefined, "a typed command is no function number: the command step as it works live (PV-0787)")
  })

  /** Reading R-CI-21: a UI-event step sends the cursor field as received and a DYNT_FOCUS_1, whatever the envelope (bug #143) */
  test("uiEventCursor", { skip: skipWithoutFakeServer }, async () => {
    const popup = await damScreen("dam-select")
    const dam = popup.inputs[0]
    assert.ok(dam !== undefined)
    const readings = new FunctionReadings({ functionKey: "uiEventSource" })
    readings.envelope = InputEnvelope.chlStage
    const plain = popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), { readings, cursor: dam.id })
    assert.ok(plain.focus === undefined && plain.fieldCount === 0, "Swooey 0.0.72: DYNT_NOFOCUS, no focus item")
    readings.uiEventCursor = "focusAndCursorField"
    const witnessed = popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), { readings, cursor: dam.id })
    assert.deepEqual(witnessed.focus, new InputFocus(dam.atom.row, dam.atom.col, 1))
    assert.equal(witnessed.fieldCount, 1, "the cursor field as received (PV-0779)")
    assert.ok(InputEnvelope.contains(witnessed.envelope, InputEnvelope.focus))
    const encoder = Fixtures.encoder()
    const body = ClientInput.inputMessage(encoder, witnessed, 0, new ServerEcho()).slice(DiagHeader.size)
    const names = Self.itemNames(body)
    const tail = names.slice(-4)
    assert.deepEqual(tail, ["DYNT DYNT_ATOM", "UI_EVENT UI_EVENT_SOURCE", "DYNT DYNT_FOCUS_1", "EOM"])
    // An OK-code step is not a UI-event step: no cursor field added; the focus goes as for any
    // function number sent as an OK-code (R-CI-20).
    readings.functionKey = "okCode"
    const okCode = popup.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8), { readings, cursor: dam.id })
    assert.equal(okCode.fieldCount, 0)
    assert.deepEqual(okCode.focus, new InputFocus(dam.atom.row, dam.atom.col, 1))
  })
})
