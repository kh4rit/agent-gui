// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/UIEventFunctionKeyTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientIdentity,
  ClientInput,
  ClientInputStep,
  ClientMessageEncoder,
  DiagHeader,
  ItemPayloadError,
  ReturnedField,
  ScreenValueEncodingError,
  SupportBits,
  UIControlType,
  UIEventDataWidth,
  UIEventFunctionKey,
  UIEventSource,
  UIEventValidFlags,
  byteRange,
  type ClientInputErrorInfo,
  type FunctionRefusal
} from "../../../diag/codec/index.js"
import { ByteWriter, DPTerminalName } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, throwsInfo, walkItems, written } from "../../support/codecTestSupport.js"

/**
 * The function-key event of UI_EVENT_SOURCE (client-input.md §7.5): ODG's observed bytes (PV-0771),
 * the function number at offset 5 (PV-0772), both event-data widths of #56 (Reading R-CI-9), and
 * the input step that sends it (Reading R-CI-10).
 */
describe("UI_EVENT_SOURCE function keys", () => {
  /**
   * ODG's function-key sample with function 8, the cursor at row 5 and column 12: its client's
   * template `0a 00 07 00 01 NN 00 00 00 00 RR 00 CC 00 01 00` (row and column below 256).
   */
  const sample = bytes(0x0a, 0x00, 0x07, 0x00, 0x01, 8, 0, 0, 0, 0, 5, 0, 12, 0, 1, 0)

  test("encodesTheSample", () => {
    const value = written(output => UIEventFunctionKey.appendFunctionKey(8, { controlRow: 5, controlCol: 12 }, output))
    assert.deepEqual(value, sample)
    assert.equal(UIEventFunctionKey.functionKeyFlags, 0x0a)
    assert.deepEqual(UIEventValidFlags.names(UIEventFunctionKey.functionKeyFlags), ["CONTROL_POS", "FUNCTIONKEY_DATA"])
  })

  test("encodesTheOtherReading", () => {
    const value = written(output =>
      UIEventFunctionKey.appendFunctionKey(
        15,
        { width: "oneByte", controlType: UIControlType.dynpro, controlRow: 0x0102, controlCol: 3, containerIDs: [7, 9] },
        output
      )
    )
    assert.deepEqual(value, bytes(0x0a, 0x00, 0x07, 0x00, 0x0a, 15, 0x01, 0x02, 0x00, 0x03, 0x00, 0x02, 7, 9))
    assert.ok(UIEventDataWidth.byteCount("fourBytes") === 4 && UIEventDataWidth.byteCount("oneByte") === 1)
    assert.equal(UIEventDataWidth.allCases.length, 2)
    assert.ok(UIControlType.name(UIControlType.field) === "FIELD" && UIControlType.name(UIControlType.dynpro) === "DYNPRO")
  })

  test("tooManyContainers", () => {
    const output = new ByteWriter()
    const ids = new Uint8Array(UIEventSource.maxContainerCount + 1)
    throwsInfo(() => UIEventFunctionKey.appendFunctionKey(1, { containerIDs: ids }, output), ScreenValueEncodingError, {
      kind: "tooManyEntries",
      count: ids.length,
      limit: UIEventSource.maxContainerCount
    })
    assert.equal(output.length, 0)
  })

  test("firedFunctionNumber", () => {
    assert.equal(UIEventFunctionKey.firedFunctionNumber(sample), 8)
    const oneByte = written(output => UIEventFunctionKey.appendFunctionKey(3, { width: "oneByte" }, output))
    assert.equal(UIEventFunctionKey.firedFunctionNumber(oneByte), 3)
    assert.equal(UIEventFunctionKey.firedFunctionNumber(sample.slice(0, 6)), 8)
    assert.equal(UIEventFunctionKey.firedFunctionNumber(sample.slice(0, 5)), undefined, "too short")
    const noKey = sample.slice()
    noKey[0] = UIEventValidFlags.controlPosition
    assert.equal(UIEventFunctionKey.firedFunctionNumber(noKey), undefined, "FUNCTIONKEY_DATA clear")
    const navigation = sample.slice()
    navigation[0] |= UIEventValidFlags.navigationData
    assert.equal(UIEventFunctionKey.firedFunctionNumber(navigation), undefined, "NAVIGATION_DATA set")
    const select = sample.slice()
    select[2] = 0x01
    assert.equal(UIEventFunctionKey.firedFunctionNumber(select), undefined, "event_type SELECT")
  })

  test("decodes", () => {
    const event = UIEventFunctionKey.decode(sample)
    assert.equal(event.functionNumber, 8)
    assert.deepEqual(event.eventData, byteRange(5, 9))
    assert.ok(event.controlRow === 5 && event.controlCol === 12)
    assert.deepEqual(event.containerIDs, byteRange(15, 16))
    assert.deepEqual(event.containerIDs.of(sample), bytes(0))
    const oneByte = written(output =>
      UIEventFunctionKey.appendFunctionKey(6, { width: "oneByte", controlRow: 7, controlCol: 8, containerIDs: [] }, output)
    )
    const narrow = UIEventFunctionKey.decode(oneByte, "oneByte")
    assert.ok(narrow.functionNumber === 6 && narrow.controlRow === 7 && narrow.controlCol === 8)
    assert.deepEqual(narrow.eventData, byteRange(5, 6))
    assert.ok(narrow.containerIDs.isEmpty)
    throwsInfo(() => UIEventFunctionKey.decode(sample.slice(0, 14)), ItemPayloadError, { kind: "truncated", needed: 15, available: 14 })
    throwsInfo(() => UIEventFunctionKey.decode(sample.slice(0, 15)), ItemPayloadError, { kind: "truncated", needed: 16, available: 15 })
    throwsInfo(() => UIEventFunctionKey.decode(cat(sample, [0])), ItemPayloadError, { kind: "overlong", expected: 16, actual: 17 })
    // Read under pysap's width, ODG's sample puts the row into the count (the #56 derivation).
    throwsInfo(() => UIEventFunctionKey.decode(sample, "oneByte"), ItemPayloadError, { kind: "truncated", needed: 12 + 0x0500, available: 16 })
  })

  // MARK: The input step

  /** The suite's static helper (Swift `Self.encoder()`). */
  const Self = {
    encoder(): ClientMessageEncoder {
      return new ClientMessageEncoder(
        new ClientIdentity({ codePage: 0, wsType: 0, supportData: new SupportBits() }),
        DPTerminalName.fromHostName("puddle")
      )
    }
  }

  /** a step with a function key sends UI_EVENT_SOURCE as APPL after the fields, before EOM (R-CI-10) */
  test("inputStepWithFunctionKey", () => {
    const step = new ClientInputStep()
    step.appendField(new ReturnedField({ block: 1, row: 4, col: 18, mlen: 12, maxNrChars: 12 }), ascii("QUACK"))
    step.setFunctionKey(8, { row: 5, col: 12 })
    assert.deepEqual(step.uiEvent, sample)
    assert.equal(step.items.length, 1, "the event is no ClientItem")
    assert.equal(step.description, "ClientInputStep(fields: 1, SES: no, DYNN CHL: no, UI_EVENT_SOURCE: yes)")
    const encoder = Self.encoder()
    const body = ClientInput.inputMessage(encoder, step).slice(DiagHeader.size)
    const walk = walkItems(body)
    assert.equal(walk.error, undefined)
    assert.deepEqual(
      walk.items.map(item => item.appl),
      [ApplItem.stUser("dialogStepNumber"), ApplItem.dynt("atom"), ApplItem.uiEvent("uiEventSource"), undefined]
    )
    assert.equal(walk.items[2].type, "appl")
    assert.deepEqual(walk.items[2].valueRange.of(body), sample)
    assert.equal(walk.items[walk.items.length - 1]?.type, "eom")
  })

  /** a raw event value, and one next to a command: the command first, as the items order them */
  test("rawEventAndCommand", () => {
    const step = new ClientInputStep()
    step.setUIEventSource(bytes(1, 2, 3))
    step.setFunctionCode(ascii("=ZZASK"), "varInfoOKCode")
    assert.equal(step.description, "ClientInputStep(fields: 0, SES: no, DYNN CHL: no, OKCODE: yes, UI_EVENT_SOURCE: yes)")
    const encoder = Self.encoder()
    const body = ClientInput.inputMessage(encoder, step).slice(DiagHeader.size)
    const walk = walkItems(body)
    assert.deepEqual(
      walk.items.map(item => item.appl),
      [ApplItem.stUser("dialogStepNumber"), ApplItem.varInfo("okcode"), ApplItem.uiEvent("uiEventSource"), undefined]
    )
    assert.deepEqual(walk.items[2].valueRange.of(body), bytes(1, 2, 3))
    assert.equal(ClientInput.inputMessage(encoder, step, 1)[0], 1, "a later mode's step carries its mode byte (R-MO-2)")
    const outOfRange: ClientInputErrorInfo = { kind: "function", value: { kind: "virtualKeyOutOfRange", value: 300 } }
    const disabled: ClientInputErrorInfo = { kind: "function", value: { kind: "disabled" } }
    assert.notDeepEqual(outOfRange, disabled)
    const notOffered: FunctionRefusal = { kind: "notOffered" }
    assert.notDeepEqual(notOffered, { kind: "disabled" } satisfies FunctionRefusal)
  })
})
