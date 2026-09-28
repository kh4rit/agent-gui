// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ElementToggleTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  CheckboxReading,
  ClientInputError,
  ClientInputStep,
  DyntAtomEncodingError,
  DyntAttributes,
  DyntButtonStrings,
  DyntElementType,
  DyntToggle,
  DyntToggleKind,
  DyntToggleReturn,
  ElementValueReading,
  RadioGroupReading,
  byteRange
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, cat, throwsInfo } from "../../support/codecTestSupport.js"
import { field2Content, rawAtom, walkAtoms } from "../../support/dyntTestSupport.js"
import {
  bytesText,
  decodeReturn,
  decodeReturnPayload,
  decodeToggle,
  decodeTogglePayload,
  elementHeader,
  encodeReturn,
  encodeToggle,
  toggleContent,
  toggleFunctionCode
} from "../../support/elementTestSupport.js"

const etype = DyntElementType.of

/**
 * Checkboxes and radio buttons (elements.md §3): the body of Readings R-EL-1 and R-EL-2, its
 * switches, the returned atom of R-EL-4, and the fallback to the walker's opaque payload.
 */
describe("Screen elements: checkboxes and radio buttons", () => {
  /**
   * The checkbox "Waterproof (mostly)" with the function `=ZZWET`, checked, 19 cells, at row 3,
   * column 5, written byte by byte: state `X`, visible 19, event_id_off 0, event_id_len 6, text_off
   * 6, text_length 19, then the event id and the caption.
   */
  const waterproof = rawAtom(128, {
    content: cat([0x58, 0x00, 0x13, 0x00, 0x00, 0x06, 0x00, 0x06, 0x00, 0x13], ascii("=ZZWET"), ascii("Waterproof (mostly)")),
    row: 3,
    col: 5,
    attr: 0x40
  })

  test("encodesCheckbox", () => {
    const header = elementHeader(etype("checkbutton3"), 3, 5, { attributes: DyntAttributes.yes3D })
    const bytes = encodeToggle(header, { checked: true, visible: 19, code: "=ZZWET", caption: "Waterproof (mostly)" })
    assert.deepEqual(bytes, waterproof)
    assert.equal(bytes.length, 13 + 10 + 6 + 19)
  })

  test("decodesCheckbox", () => {
    const value = waterproof
    const toggle = decodeToggle(value)
    assert.ok(toggle)
    assert.ok(toggle.isChecked)
    assert.equal(toggle.stateByte, 0x58)
    assert.equal(toggle.visibleLength, 19)
    assert.equal(bytesText(value, toggle.eventIDRange), "=ZZWET")
    assert.equal(bytesText(value, toggle.captionRange), "Waterproof (mostly)")
    assert.equal(toggleFunctionCode(toggle, value), "=ZZWET")
  })

  test("decodesPlainCheckbox", () => {
    const value = rawAtom(128, { content: toggleContent({ state: " ", visible: 17, caption: "Allergic to bread" }) })
    const toggle = decodeToggle(value)
    assert.ok(toggle)
    assert.ok(!toggle.isChecked)
    assert.ok(toggle.eventIDRange.isEmpty)
    assert.equal(bytesText(value, toggle.captionRange), "Allergic to bread")
    assert.equal(toggleFunctionCode(toggle, value), undefined)
  })

  test("eventIDWithoutEquals", () => {
    const value = rawAtom(128, { content: toggleContent({ state: "X", visible: 4, eventID: "HD", caption: "Nap" }) })
    const toggle = decodeToggle(value)
    assert.ok(toggle)
    assert.equal(bytesText(value, toggle.eventIDRange), "HD")
    assert.equal(toggleFunctionCode(toggle, value), undefined)
  })

  for (const type of [104, 118, 124, 128, 105, 119, 125, 129])
    test(`toggleEtypes(${type})`, () => {
      const value = rawAtom(type, { content: toggleContent({ state: "X", visible: 5, caption: "Quack" }) })
      assert.notEqual(decodeToggle(value), undefined)
      assert.equal(DyntToggleKind.of(DyntElementType.fromRaw(type)), type % 2 === 0 ? "checkbox" : "radioButton")
    })

  test("otherEtypes", () => {
    const value = rawAtom(130, { content: toggleContent({ state: "X", visible: 5, caption: "Quack" }) })
    assert.equal(decodeToggle(value), undefined)
    assert.equal(DyntToggleKind.of(etype("efield2")), undefined)
    assert.deepEqual(DyntToggleKind.serverElementType("checkbox"), etype("checkbutton3"))
    assert.deepEqual(DyntToggleKind.serverElementType("radioButton"), etype("radiobutton3"))
  })

  test("misfits", () => {
    assert.equal(decodeTogglePayload([0x58, 0, 1]), undefined)
    assert.equal(decodeTogglePayload(toggleContent({ state: "Q", visible: 5, caption: "Quack" })), undefined)
    assert.equal(decodeTogglePayload(cat(toggleContent({ state: "X", visible: 5, caption: "Quack" }), [0])), undefined)
    assert.equal(decodeTogglePayload(toggleContent({ state: "X", visible: 5, caption: "Quack" }).slice(0, -1)), undefined)
  })

  test("odgSplit", () => {
    const plain = toggleContent({ state: "X", visible: 9, caption: "Webbed feet" })
    const toggle = decodeTogglePayload(plain, "odgSplit")
    assert.ok(toggle)
    assert.ok(toggle.isChecked)
    assert.deepEqual(toggle.captionRange, byteRange(10, plain.length))
    assert.ok(toggle.eventIDRange.isEmpty)
    assert.equal(decodeTogglePayload(toggleContent({ state: "X", visible: 9, eventID: "=ZZ", caption: "Webbed feet" }), "odgSplit"), undefined)
  })

  test("specGap", () => {
    assert.equal(decodeToggle(waterproof, "specGap"), undefined)
    assert.equal(CheckboxReading.allCases[0], "pv0655")
    assert.equal(RadioGroupReading.allCases[0], "areaBlockGroup")
  })

  test("radioAgreesWithWalker", () => {
    const value = rawAtom(129, { content: toggleContent({ state: "X", visible: 6, caption: "Fluffy" }), flags: [0, 0x80], group: 1 })
    const atom = walkAtoms(value).atoms[0]
    assert.ok(atom)
    assert.equal(atom.payload.kind, "radioButton", "the walker does not see a radio button")
    if (atom.payload.kind !== "radioButton") return
    const toggle = decodeToggle(value)
    assert.ok(toggle)
    assert.deepEqual(DyntButtonStrings.agreedTextRange(atom.payload.value), toggle.captionRange)
    assert.ok(toggle.isChecked)
    assert.notEqual(atom.dialogFlags.flag2 & DyntToggle.selectedRadioFlag, 0)
    assert.equal(atom.group, DyntToggle.radioGroupByte)
  })

  test("radioGroupKey", () => {
    assert.equal(DyntToggle.radioGroupKey(21, 1), 0x1501)
    assert.equal(DyntToggle.radioGroupKey(0, 0), 0)
    assert.ok(DyntToggle.radioGroupKey(22, 1) > DyntToggle.radioGroupKey(21, 1))
  })

  test("encoderRefusals", () => {
    throwsInfo(() => encodeToggle(elementHeader(etype("efield2"), 1, 1), { checked: true, visible: 1, caption: "X" }), DyntAtomEncodingError, {
      kind: "wrongElementType",
      value: etype("efield2")
    })
    throwsInfo(
      () => encodeToggle(elementHeader(etype("checkbutton3"), 1, 1), { checked: true, visible: 1, code: "Q".repeat(256), caption: "" }),
      DyntAtomEncodingError,
      { kind: "textTooLong", length: 256 }
    )
    assert.throws(
      () => encodeToggle(elementHeader(etype("checkbutton3"), 1, 1), { checked: true, visible: 1, caption: "Q".repeat(65_530) }),
      DyntAtomEncodingError
    )
  })

  /** Native radio states are numeric and independent of the selected header flag (bug #149) */
  test("nativeRadioStates", () => {
    for (const state of [0, 1]) {
      const body = toggleContent({ state: "X", visible: 9, caption: "ZZ Pond  " })
      body[0] = state
      const radio = rawAtom(129, { content: body, flags: [0, state === 0 ? 0x80 : 0] })
      const decoded = decodeToggle(radio)
      assert.ok(decoded)
      assert.equal(decoded.isChecked, state === 1)
      assert.equal(bytesText(radio, decoded.captionRange), "ZZ Pond  ")
      assert.equal(decodeToggle(rawAtom(128, { content: body })), undefined)
      assert.equal(decodeToggle(radio, "specGap"), undefined)
    }
  })

  /** Native numeric layout rejects events, offsets, unknown states and mismatched widths (bug #149) */
  test("nativeRadioBounds", () => {
    const valid = toggleContent({ state: "X", visible: 5, caption: "ZZabc" })
    valid[0] = 1
    for (const offset of [0, 2, 3, 4, 5, 6, 7, 9]) {
      const invalid = valid.slice()
      invalid[offset] = 2
      assert.equal(decodeToggle(rawAtom(129, { content: invalid })), undefined, `offset ${offset}`)
    }
    assert.equal(decodeToggle(rawAtom(129, { content: valid }), "odgSplit"), undefined)
  })

  /** Native radio reply preserves caption bytes and refuses wrong types and oversized bodies (bug #148) */
  test("nativeRadioReturn", () => {
    const caption = Uint8Array.of(0x5a, 0x5a, 0xe9, 0x20, 0x20)
    const output = new ByteWriter()
    const header = elementHeader(etype("radiobutton3"), 6, 4, { group: 1, flags: [0, 0x81] })
    DyntToggleReturn.appendNativeRadio(header, true, caption, output)
    assert.deepEqual(output.toBytes(), rawAtom(105, { content: cat([1], caption), group: 1, row: 6, col: 4 }))
    const before = output.toBytes()
    assert.throws(() => DyntToggleReturn.appendNativeRadio(elementHeader(etype("checkbutton3"), 1, 1), false, caption, output), DyntAtomEncodingError)
    const oversized = new Uint8Array(65535).fill(0x20)
    assert.throws(() => DyntToggleReturn.appendNativeRadio(header, false, oversized, output), DyntAtomEncodingError)
    assert.deepEqual(output.toBytes(), before)
    const step = new ClientInputStep()
    assert.throws(() => step.appendNativeRadio(elementHeader(etype("checkbutton3"), 1, 1), false, caption), ClientInputError)
    assert.equal(step.fieldCount, 0)
  })

  // MARK: Returned toggles (R-EL-4, PV-0963)

  test("encodesReturn", () => {
    const header = elementHeader(etype("radiobutton3"), 6, 4, { group: 1, flags: [0, 0x81] })
    const bytes = encodeReturn(header, { checked: true, visible: 71 })
    assert.deepEqual(bytes, rawAtom(129, { content: [0x58, 0x00, 0x47, 0, 0, 0, 0, 0, 0, 0, 0], flags: [0, 0x81], group: 1, row: 6, col: 4 }))
    const plain = encodeReturn(elementHeader(etype("checkbutton3"), 2, 2), { checked: false, visible: 1, trailingZero: false })
    assert.deepEqual(plain, rawAtom(128, { content: [0x20, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0], row: 2, col: 2 }))
    throwsInfo(() => encodeReturn(elementHeader(etype("combobox1"), 1, 1), { checked: true, visible: 1 }), DyntAtomEncodingError, {
      kind: "wrongElementType",
      value: etype("combobox1")
    })
  })

  test("decodesReturn", () => {
    const returned = decodeReturn(encodeReturn(elementHeader(etype("checkbutton3"), 2, 2), { checked: true, visible: 12 }))
    assert.ok(returned)
    assert.ok(returned.isChecked)
    assert.equal(returned.visibleLength, 12)
    assert.deepEqual(returned, new DyntToggleReturn({ isChecked: true, visibleLength: 12 }))
    const echoed = decodeReturn(waterproof)
    assert.ok(echoed)
    assert.ok(echoed.isChecked && echoed.visibleLength === 19)
    assert.equal(decodeReturnPayload([0x58, 0]), undefined)
    assert.equal(decodeReturnPayload([0x00, 0, 1]), undefined)
    assert.equal(decodeReturn(rawAtom(130, { content: field2Content(ascii("X")) })), undefined)
  })

  test("elementValueReading", () => {
    const reading = new ElementValueReading()
    assert.equal(reading.returns, "changedAtoms")
    assert.equal(reading.radios, "changedButtons")
    assert.ok(reading.trailingZero)
    assert.equal(reading.function, "okCode")
    assert.equal(ElementValueReading.specGap.returns, "specGap")
    assert.equal(ElementValueReading.specGap.function, "specGap")
    assert.equal(ElementValueReading.Radios.allCases[0], "changedButtons")
  })
})
