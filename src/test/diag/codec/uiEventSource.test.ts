// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/UIEventSourceTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ItemPayloadError,
  ScreenSpecGapError,
  ScreenValueEncodingError,
  UIControlType,
  UIEventSource,
  UIEventType,
  UIEventValidFlags,
  UINavigationData,
  byteRange
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { bytes, cat, throwsInfo, written } from "../../support/codecTestSupport.js"
import { u16BE } from "../../support/dyntTestSupport.js"

/** UI_EVENT_SOURCE (client-input.md §7.2, §7.3): the fields both sources agree on, and the typed gap #56 when NAVIGATION_DATA is clear. */
describe("UI event source", () => {
  /**
   * A navigation event: valid flags NAVIGATION_DATA | CONTROL_POS, event_type NAVIGATION,
   * control_type FIELD, navigation data TAB, row 258, col 20, two container ids.
   */
  const navigation = cat([0x06], u16BE(0x0c), u16BE(0x01), [0x01], u16BE(258), u16BE(20), u16BE(2), [7, 9])

  test("navigationEventDecodes", () => {
    const event = UIEventSource.decode(navigation)
    assert.equal(event.validFlags, UIEventValidFlags.navigationData | UIEventValidFlags.controlPosition)
    assert.deepEqual(UIEventValidFlags.names(event.validFlags), ["CONTROL_POS", "NAVIGATION_DATA"])
    assert.ok(UIEventType.name(event.eventType) === "NAVIGATION" && UIControlType.name(event.controlType) === "FIELD")
    const decoded = event.navigation()
    assert.ok(UINavigationData.name(decoded.navigationData) === "TAB" && decoded.controlRow === 258 && decoded.controlCol === 20)
    assert.deepEqual(decoded.containerIDs, byteRange(12, 14))
    assert.deepEqual(decoded.containerIDs.of(navigation), bytes(7, 9))
    const encoded = written(output =>
      UIEventSource.append(
        {
          validFlags: event.validFlags,
          eventType: event.eventType,
          controlType: event.controlType,
          navigationData: decoded.navigationData,
          controlRow: 258,
          controlCol: 20,
          containerIDs: bytes(7, 9)
        },
        output
      )
    )
    assert.deepEqual(encoded, navigation)
  })

  /**
   * R-CI-7: a value shorter than its layout is truncated; bytes after the counted container ids are
   * overlong (#39, as IMPL-SS-3 treats IMODEUUIDS2).
   */
  test("navigationEventLengths", () => {
    for (let count = 0; count < 5; count++)
      throwsInfo(() => UIEventSource.decode(navigation.slice(0, count)), ItemPayloadError, { kind: "truncated", needed: 5, available: count })
    for (let count = 5; count < 12; count++)
      throwsInfo(() => UIEventSource.decode(navigation.slice(0, count)), ItemPayloadError, { kind: "truncated", needed: 12, available: count })
    throwsInfo(() => UIEventSource.decode(navigation.slice(0, -1)), ItemPayloadError, { kind: "truncated", needed: 14, available: 13 })
    throwsInfo(() => UIEventSource.decode(cat(navigation, [0])), ItemPayloadError, { kind: "overlong", expected: 14, actual: 15 })
  })

  /** #56: with NAVIGATION_DATA clear the event-data width is a conflict, so nothing after control_type is located, and no such value is written. */
  test("functionKeyEventStaysOpaque", () => {
    const value = cat([0x08], u16BE(0x07), u16BE(0x0a), [0x0f, 0, 0, 0], u16BE(0), u16BE(0), u16BE(0))
    const event = UIEventSource.decode(value)
    assert.ok(event.validFlags === UIEventValidFlags.functionKeyData && event.eventType === UIEventType.functionKey)
    assert.equal(UIControlType.name(event.controlType), "DYNPRO")
    assert.deepEqual(event.detail, { kind: "undecoded", value: byteRange(5, value.length) })
    throwsInfo(() => event.navigation(), ScreenSpecGapError, { kind: "specGap", issue: 56 })
    assert.deepEqual(UIEventSource.decode(value.slice(0, 5)).detail, { kind: "undecoded", value: byteRange(5, 5) })
    const output = new ByteWriter()
    output.u8(0xee)
    throwsInfo(
      () =>
        UIEventSource.append(
          {
            validFlags: UIEventValidFlags.functionKeyData,
            eventType: UIEventType.functionKey,
            controlType: UIControlType.okcode,
            navigationData: 0,
            controlRow: 0,
            controlCol: 0,
            containerIDs: new Uint8Array(0)
          },
          output
        ),
      ScreenValueEncodingError,
      { kind: "specGap", issue: 56 }
    )
    throwsInfo(
      () =>
        UIEventSource.append(
          {
            validFlags: UIEventValidFlags.navigationData,
            eventType: UIEventType.functionKey,
            controlType: UIControlType.okcode,
            navigationData: 1,
            controlRow: 0,
            controlCol: 0,
            containerIDs: new Uint8Array(65_536).fill(1)
          },
          output
        ),
      ScreenValueEncodingError,
      { kind: "tooManyEntries", count: 65_536, limit: 65_535 }
    )
    assert.deepEqual(output.toBytes(), bytes(0xee), "nothing is appended on failure")
  })

  /** PV-0763, PV-0766–PV-0768: masks and names as the spec's tables list them. */
  test("valueTables", () => {
    assert.deepEqual(
      UIEventValidFlags.named.map(entry => entry.flag),
      [0x01, 0x02, 0x04, 0x08]
    )
    assert.equal(UIEventValidFlags.names(0xf0).length, 0)
    const events = new Map<number, string>([
      [0x01, "SELECT"],
      [0x02, "HE"],
      [0x03, "VALUEHELP"],
      [0x06, "RESIZE"],
      [0x07, "FUNCTIONKEY"],
      [0x08, "SCROLL"],
      [0x09, "BUTTONPRESSED"],
      [0x0a, "VALUECHANGED"],
      [0x0b, "STATECHANGED"],
      [0x0c, "NAVIGATION"]
    ])
    for (let value = 0; value <= 0x20; value++) assert.equal(UIEventType.name(value), events.get(value), `${value}`)
    assert.ok(UIControlType.name(0x0c) === undefined && UIControlType.name(0x16) === undefined)
    assert.ok(UIControlType.name(0x00) === "NONE" && UIControlType.name(0x15) === "ACC_CONTAINER")
    assert.equal(UIControlType.name(UIControlType.okcode), "OKCODE")
    let named = 0
    for (let value = 0; value <= 0x15; value++) if (UIControlType.name(value) !== undefined) named += 1
    assert.equal(named, 21)
    assert.ok(UINavigationData.name(0) === undefined && UINavigationData.name(0x0b) === undefined)
    assert.deepEqual(
      Array.from({ length: 10 }, (_, index) => UINavigationData.name(index + 1)),
      ["TAB", "TAB_BACK", "JUMP_OVER", "JUMP_OVER_BACK", "JUMP_OUT", "JUMP_OUT_BACK", "JUMP_SECTION", "JUMP_SECTION_BACK", "FIRST_FIELD", "LAST_FIELD"]
    )
  })
})
