// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ElementItemTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  AreaSize,
  DiagItemWalker,
  ItemPayloadError,
  ListBoxReading,
  ListFunctionNumber,
  ListLineElement,
  ListPagingReading,
  ListReading,
  ListRunFlags,
  ListRunStyle,
  ListWindowReading,
  ListWindowState,
  MessageTypeReading,
  PageKey,
  PopupReading,
  PopupWindow,
  SESValue,
  SFEValue,
  ScrollInfos,
  StatusMessageEncodingError,
  StatusMessageType,
  TableLayout,
  TableReading,
  TableRowRecord,
  TableScrollReading,
  TableScrollState,
  TableScrollStateReading,
  byteRange,
  type KnownStatusMessageType
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { appl, appl4, ascii, bytes, cat, repeated, throwsInfo, written } from "../../support/codecTestSupport.js"
import {
  appendRun,
  bytesText,
  decodeMessage,
  decodeRowRecord,
  decodeWindowState,
  encodeMessage,
  encodeMessageItem,
  listRuns
} from "../../support/elementTestSupport.js"

/**
 * Table controls (elements.md §6), lists (§7), popups (§8) and typed messages (§9): the item values
 * of Readings R-EL-8, R-EL-9, R-EL-11, R-EL-13 and R-EL-14, byte by byte.
 */
describe("Screen elements: tables, lists, popups, messages", () => {
  // MARK: Tables (R-EL-8, R-EL-9)

  test("rowRecord", () => {
    const record = new TableRowRecord({ firstRow: 31 })
    assert.deepEqual(record.bytes, bytes(0x00, 0x1f, 0x00, 0x00))
    assert.deepEqual(
      written(output => record.appendItem(output)),
      bytes(0x10, 0x09, 0x05, 0x00, 0x04, 0x00, 0x1f, 0x00, 0x00)
    )
    assert.deepEqual(decodeRowRecord([0x01, 0xf4, 0x00, 0x02]), new TableRowRecord({ firstRow: 500, flags: 2 }))
    throwsInfo(() => decodeRowRecord([0, 1, 0]), ItemPayloadError, { kind: "truncated", needed: 4, available: 3 })
    throwsInfo(() => decodeRowRecord([0, 1, 0, 0, 0]), ItemPayloadError, { kind: "overlong", expected: 4, actual: 5 })
    assert.equal(TableScrollReading.allCases[0], "keysAndRowRecord")
    assert.equal(TableReading.allCases[0], "headerBlockZero")
    assert.equal(TableScrollStateReading.allCases[0], "scrollInfosAfterContainer")
  })

  test("scrollState", () => {
    const infos = new ScrollInfos({ totalHeight: 1000, totalWidth: 138, dataHeight: 15, dataWidth: 108, heightOffset: 45, widthOffset: 0 })
    const state = TableScrollState.fromScrollInfos(infos)
    assert.deepEqual(state, new TableScrollState({ totalRows: 1000, firstRow: 46, visibleRows: 15, totalWidth: 138, viewportWidth: 108 }))
    assert.deepEqual(state.scrollInfos, infos)
    const unknown = TableScrollState.unknown(12, 116)
    assert.ok(unknown.totalRows === undefined && unknown.firstRow === 1)
    assert.deepEqual(
      unknown.scrollInfos,
      new ScrollInfos({ totalHeight: 12, totalWidth: 116, dataHeight: 12, dataWidth: 116, heightOffset: 0, widthOffset: 0 })
    )
    assert.equal(
      new TableScrollState({ totalRows: undefined, firstRow: 0, visibleRows: -1, totalWidth: undefined, viewportWidth: 1 }).scrollInfos.heightOffset,
      0
    )
  })

  test("pageKeys", () => {
    assert.deepEqual(PageKey.allCases.map(PageKey.rawValue), [80, 81, 82, 83])
    assert.deepEqual(PageKey.allCases.map(PageKey.listOKCode), ["P--", "P-", "P+", "P++"])
    assert.deepEqual([ListFunctionNumber.choose, ListFunctionNumber.back, ListFunctionNumber.find, ListFunctionNumber.print], [2, 3, 71, 86])
    assert.ok(TableLayout.headerBlock === 0 && TableLayout.firstDataBlock === 1 && TableLayout.selectorColumn === 0)
    assert.equal(ListPagingReading.allCases[0], "okCodes", "the default first")
  })

  // MARK: Lists (R-EL-11)

  test("encodesRun", () => {
    const items = written(output => appendRun(4, 2, new ListRunStyle({ color: 4, flags: ListRunFlags.hotspot }), "Puddles", output))
    assert.deepEqual(items, cat([0x0b, 4, 2, 0x0a, 0x0a, 0x44, 0x00, 0x13, 0x00, 0x07, 0x10, 0x0c, 0x0b, 0x00, 0x07], ascii("Puddles")))
  })

  test("styles", () => {
    const style = ListRunStyle.fromSFE(new SFEValue({ format: 0x08, color: 0x76, extended: 0x08 }))
    assert.deepEqual(style, new ListRunStyle({ color: 6, flags: ListRunFlags.all, isRuled: true, isBox: true }))
    assert.deepEqual(style.sfe, new SFEValue({ format: 0x08, color: 0x76, extended: 0x08 }))
    assert.deepEqual(ListRunStyle.fromSFE(new SFEValue({ format: 0x0a, color: 0x76, extended: 0 }), "specGap"), new ListRunStyle({ color: 0x76 }))
    assert.deepEqual(ListRunStyle.fromSFE(new SFEValue({ format: 0x0a, color: 0x04, extended: 0 }), "runsOnly"), new ListRunStyle({ color: 4 }))
    assert.ok(new ListRunStyle({ color: 7 }).isKnownColor)
    assert.ok(!ListRunStyle.fromSFE(new SFEValue({ format: 0x0a, color: 0x0f, extended: 0 })).isKnownColor)
    assert.deepEqual(new ListRunStyle({ color: 2 }).sfe, new SFEValue({ format: 0x0a, color: 0x02, extended: 0 }))
    assert.equal(ListReading.allCases[0], "runsWithCHL")
    assert.deepEqual(
      new ListRunStyle({ color: 3, isRuled: true, isBox: true }).sfe,
      new SFEValue({ format: 0x08, color: 0x03, extended: 0x08 }),
      "a box run as the fake server writes it, as ULINE came (PV-0981)"
    )
    assert.ok(!ListRunStyle.fromSFE(new SFEValue({ format: 0x08, color: 0x02, extended: 0 })).isBox, "byte 0 alone makes no box run")
    assert.ok(ListRunStyle.fromSFE(new SFEValue({ format: 0x0a, color: 0x02, extended: 0x08 })).isBox)
  })

  test("lineElements", () => {
    assert.deepEqual(
      ListLineElement.allCases.map(ListLineElement.rawValue),
      Array.from({ length: 11 }, (_, index) => 0x30 + index)
    )
    assert.equal(ListLineElement.allCases.map(ListLineElement.code).join(""), "0123456789:")
    assert.equal(
      ListLineElement.allCases.map(ListLineElement.glyph).join(""),
      "\u{250C}\u{2514}\u{2510}\u{2518}\u{2500}\u{2502}\u{251C}\u{2524}\u{2534}\u{252C}\u{253C}"
    )
    for (let byte = 0; byte <= 0xff; byte++) {
      const element = ListLineElement.fromCode(String.fromCodePoint(byte))
      assert.equal(element !== undefined, byte >= 0x30 && byte <= 0x3a, `byte ${byte}`)
    }
    assert.ok(ListLineElement.fromCode("\u{2500}") === undefined && ListLineElement.fromCode("\u{1F986}") === undefined)
    for (const element of ListLineElement.allCases) {
      assert.equal(ListLineElement.fromGlyph(ListLineElement.glyph(element)), element)
      assert.equal(ListLineElement.fromCode(ListLineElement.code(element)), element)
    }
    assert.ok(ListLineElement.fromGlyph("4") === undefined && ListLineElement.fromGlyph("-") === undefined)
    assert.ok(ListBoxReading.allCases[0] === "lineElements" && ListWindowReading.allCases[0] === "chlOrScrollInfos")
  })

  test("walksRuns", () => {
    const output = new ByteWriter()
    appendRun(0, 0, new ListRunStyle({ color: 1, flags: ListRunFlags.intensified }), "Crumbs", output)
    output.bytes(cat([0x01], repeated(0, 16))) // an SES between runs, stepped over
    output.bytes(cat([0x0a, 0x0a, 0x02, 0x00], [0x13, 0x00, 0x03], appl(0x0c, 0x0b, ascii("Oat"))))
    output.bytes(cat(appl(0x0c, 0x0a, ascii("not a run")), appl4(0x0c, 0x0b, ascii("Pea"))))
    const items = output.toBytes()
    const { runs, walker } = listRuns(items)
    assert.equal(runs.length, 3)
    assert.equal(walker.runsWithoutPosition, 2)
    assert.equal(walker.error, undefined)
    assert.ok(runs[0].hasOwnPosition && runs[0].row === 0 && runs[0].length === 6)
    assert.deepEqual(runs[0].style(), new ListRunStyle({ color: 1, flags: ListRunFlags.intensified }))
    assert.ok(!runs[1].hasOwnPosition && runs[1].row === 0 && runs[1].column === 0 && runs[1].length === 3)
    assert.equal(runs[1].style().color, 2)
    assert.equal(bytesText(items, runs[1].textRange), "Oat")
    assert.ok(runs[2].length === undefined && runs[2].style().color === 2)
    assert.equal(bytesText(items, runs[2].textRange), "Pea")
    assert.deepEqual(
      runs.map(run => run.itemIndex),
      [4, 8, 10]
    )
  })

  test("walkerEdges", () => {
    const items = cat(appl(0x0c, 0x0b, ascii("Bare")), [0x0b, 0x01])
    const { runs, walker } = listRuns(items)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].sfe, undefined)
    assert.deepEqual(runs[0].style(), new ListRunStyle({ color: 0 }))
    assert.notEqual(walker.error, undefined)
    assert.equal(listRuns(new Uint8Array(0)).runs.length, 0)
  })

  /**
   * The window of a 220-line report: 20 body rows per page from line 21, 3 header lines, 80
   * columns, the cursor at row 5, column 3.
   */
  const window = bytes(0, 0, 0, 0, 5, 3, 0, 20, 80, 0, 23, 80, 0x00, 0xdc, 0x00, 0x14, 80, 0, 0, 0, 0, 0)

  test("windowState", () => {
    const state = ListWindowState.fromWindow({
      totalLines: 220,
      firstLine: 21,
      visibleLines: 20,
      windowRows: 23,
      width: 80,
      visibleWidth: 80,
      cursorRow: 5,
      cursorColumn: 3
    })
    assert.ok(state)
    assert.deepEqual(state.bytes, window)
    assert.ok(state.headerLines === 3 && state.firstLine === 21 && state.totalLines === 220 && state.visibleLines === 20 && state.width === 80)
    assert.deepEqual(decodeWindowState(window), state)
    assert.deepEqual(
      written(output => state.appendItem(output)),
      cat([0x10, 0x05, 0x01, 0x00, 0x16], window)
    )
    const odd = decodeWindowState(cat([0x12, 0x34, 0x56, 0x78], repeated(1, 14), [0xde, 0xad, 0xbe, 0xef]))
    assert.ok(odd.scrollFlags === 0x1234 && odd.chlFlags === 0x5678 && odd.undecoded === 0xdeadbeef)
    assert.deepEqual(odd.bytes, cat([0x12, 0x34, 0x56, 0x78], repeated(1, 14), [0xde, 0xad, 0xbe, 0xef]))
    assert.equal(new ListWindowState({ dimListRow: 30, dimRow: 20 }).headerLines, 0)
    const plain = written(output => state.appendPlainItem(output))
    assert.deepEqual(plain, cat([0x09], window), "the plain CHL simple item (R-EL-21)")
    const walked = new DiagItemWalker().next(plain)
    assert.ok(walked)
    assert.ok(walked.type === "chl")
    assert.deepEqual(walked.valueRange, byteRange(1, 23))
    throwsInfo(() => decodeWindowState(window.slice(0, -1)), ItemPayloadError, { kind: "truncated", needed: 22, available: 21 })
  })

  /** Total lines, first line, visible lines, window rows: each row has one value out of range. */
  for (const values of [
    [70_000, 1, 20, 23],
    [10, 0, 20, 23],
    [10, 1, 300, 300],
    [10, 1, 20, 19]
  ])
    test(`windowStateLimits(${JSON.stringify(values)})`, () => {
      assert.equal(
        ListWindowState.fromWindow({
          totalLines: values[0],
          firstLine: values[1],
          visibleLines: values[2],
          windowRows: values[3],
          width: 80,
          visibleWidth: 80
        }),
        undefined
      )
    })

  // MARK: Popups (R-EL-13)

  test("popupWindow", () => {
    const ses = new SESValue({ eventArray: 1, modalNumber: 2, xPos: 10, yPos: 5, dimRow: 8, dimCol: 50 })
    const popup = PopupWindow.fromSES(ses)
    assert.ok(popup)
    assert.deepEqual(popup, new PopupWindow({ level: 2, row: 5, column: 10, rows: 8, columns: 50 }))
    assert.deepEqual(popup.applied(new SESValue({ eventArray: 1 })), ses)
    assert.deepEqual(popup.areaSize, new AreaSize({ windowHeight: 8, windowWidth: 50, areaHeight: 8, areaWidth: 50 }))
    assert.deepEqual(
      written(output => popup.applied().append(output)),
      bytes(0, 0, 0, 0, 0, 0, 0, 2, 10, 5, 0, 0, 0, 0, 8, 50)
    )
    assert.equal(PopupWindow.fromSES(new SESValue({ modalNumber: 0 })), undefined)
    assert.notEqual(PopupWindow.fromSES(new SESValue({ modalNumber: 9 })), undefined)
    assert.equal(PopupWindow.fromSES(new SESValue({ modalNumber: 10 })), undefined)
    assert.equal(PopupWindow.fromSES(ses, "never"), undefined)
    assert.equal(PopupReading.allCases[0], "sesModalNumber")
  })

  // MARK: Messages (R-EL-14)

  /** E, class ZZQUACK padded to 20, number 042, the space, the text and its zero byte. */
  const vowels = cat([0x45, 0], ascii("ZZQUACK"), repeated(0x20, 13), [0], ascii("042"), [0, 0x20, 0], ascii("Too many vowels"), [0])

  test("encodesMessage", () => {
    assert.deepEqual(encodeMessage(StatusMessageType.of("error"), "ZZQUACK", "042", "Too many vowels"), vowels)
    assert.equal(vowels.length, 45)
    assert.deepEqual(encodeMessageItem(StatusMessageType.of("error"), "ZZQUACK", "042", "Too many vowels"), cat([0x10, 0x0c, 0x03, 0x00, 0x2d], vowels))
    // Wireshark's reading of the same bytes: type, class, number, the single space, then the text.
    const strings = new TextDecoder().decode(vowels).split("\u{0}")
    assert.deepEqual(strings, ["E", "ZZQUACK             ", "042", " ", "Too many vowels", ""])
  })

  test("decodesFixedMessage", () => {
    const message = decodeMessage(vowels)
    assert.equal(message.layout, "fixedPositions")
    assert.deepEqual(message.type, StatusMessageType.of("error"))
    assert.equal(bytesText(vowels, message.classRange), "ZZQUACK             ")
    assert.equal(bytesText(vowels, message.numberRange), "042")
    assert.equal(bytesText(vowels, message.textRange), "Too many vowels")
    const unterminated = decodeMessage(vowels.slice(0, -1))
    assert.deepEqual(unterminated.textRange, byteRange(29, 44))
  })

  test("decodesStringMessage", () => {
    const value = cat(ascii("W"), [0], ascii("ZZDUCK"), [0], ascii("007"), [0], ascii("Mind the swan"))
    const message = decodeMessage(value)
    assert.equal(message.layout, "strings")
    assert.deepEqual(message.type, StatusMessageType.of("warning"))
    assert.equal(bytesText(value, message.classRange), "ZZDUCK")
    assert.equal(bytesText(value, message.numberRange), "007")
    assert.equal(bytesText(value, message.textRange), "Mind the swan")
    const short = decodeMessage(ascii("I"))
    assert.deepEqual(short.type, StatusMessageType.of("information"))
    assert.ok(short.classRange.isEmpty && short.numberRange.isEmpty && short.textRange.isEmpty)
    assert.deepEqual(decodeMessage([0, 0x41]).type, StatusMessageType.unknown(0))
    throwsInfo(() => decodeMessage([]), ItemPayloadError, { kind: "truncated", needed: 1, available: 0 })
    assert.equal(MessageTypeReading.allCases[0], "mestype2")
  })

  test("messageRefusals", () => {
    const success = StatusMessageType.of("success")
    throwsInfo(() => encodeMessage(success, "Z".repeat(21), "001", ""), StatusMessageEncodingError, { kind: "classTooLong", length: 21 })
    throwsInfo(() => encodeMessage(success, "ZZ", "42", ""), StatusMessageEncodingError, { kind: "numberNotThreeCharacters", length: 2 })
    throwsInfo(() => encodeMessage(success, "Z\u{0}Z", "001", ""), StatusMessageEncodingError, { kind: "zeroByte", value: "messageClass" })
    throwsInfo(() => encodeMessage(success, "ZZ", "0\u{0}1", ""), StatusMessageEncodingError, { kind: "zeroByte", value: "number" })
    throwsInfo(() => encodeMessage(success, "ZZ", "001", "a\u{0}b"), StatusMessageEncodingError, { kind: "zeroByte", value: "text" })
    assert.throws(() => encodeMessageItem(success, "ZZ", "001", "q".repeat(70_000)), StatusMessageEncodingError)
  })

  const letters: [KnownStatusMessageType | number, string][] = [
    ["success", "S"],
    ["information", "I"],
    ["warning", "W"],
    ["error", "E"],
    ["abort", "A"],
    ["exit", "X"],
    [0x51, "Q"]
  ]
  for (const [kind, letter] of letters)
    test(`messageTypes(${kind}, ${letter})`, () => {
      const type = typeof kind === "number" ? StatusMessageType.unknown(kind) : StatusMessageType.of(kind)
      const byte = letter.charCodeAt(0)
      assert.equal(StatusMessageType.byte(type), byte)
      assert.deepEqual(StatusMessageType.fromByte(byte), type)
    })
})
