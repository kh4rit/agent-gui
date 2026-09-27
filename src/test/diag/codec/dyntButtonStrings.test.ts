// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DyntButtonStringsTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  DyntAtomEncodingError,
  DyntAtomHeader,
  DyntButtonStringReading,
  DyntButtonStrings,
  DyntElementType,
  DyntPushButton,
  DyntSpecGapError,
  byteRange,
  type ByteRange,
  type DyntAtom,
  type DyntPushButtonStrings
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo, written } from "../../support/codecTestSupport.js"
import { field2Content, rawAtom, u16BE, walkAtoms } from "../../support/dyntTestSupport.js"

/**
 * Push-button and radio-button strings (dynt-atoms.md, "Button strings"): Reading R-DA-9 and its
 * alternatives for push buttons (PV-0658), the agreed radio-button text (PV-0659), and the
 * push-button encoder.
 */
describe("DYNT button strings", () => {
  /**
   * A push-button payload written by hand: vlength, vheight, the function-code offset and the text
   * offset (u16 BE each, from the atom's first byte), then the two strings.
   */
  function pushContent(fields: { text: string; code: string; textOffset?: number; codeOffset?: number; tail?: number[] }): Uint8Array {
    const text = ascii(fields.text)
    const textAt = fields.textOffset ?? 19
    const codeAt = fields.codeOffset ?? 19 + text.length + 1
    return cat([16, 1], u16BE(codeAt), u16BE(textAt), text, [0], ascii(fields.code), [0], fields.tail ?? [])
  }

  function button(content: Uint8Array, prefix: Uint8Array = new Uint8Array(0)): { button: DyntPushButton; value: Uint8Array } {
    const value = cat(prefix, rawAtom(115, { content, row: 9, col: 4 }))
    const atom = walkAtoms(value).atoms.at(-1)
    assert.ok(atom)
    assert.equal(atom.payload.kind, "pushButton", `not a push button: ${JSON.stringify(atom.payload)}`)
    if (atom.payload.kind !== "pushButton") throw new DyntSpecGapError({ kind: "specGap", issue: 35 })
    return { button: atom.payload.value, value }
  }

  /** The strings under `reading`. */
  function raw(pushButton: DyntPushButton, value: Uint8Array, reading: DyntButtonStringReading = "agreed"): DyntPushButtonStrings | undefined {
    return DyntButtonStrings.pushButtonStrings(pushButton, value, reading)
  }

  function text(atom: DyntAtom, reading: DyntButtonStringReading, value: Uint8Array): ByteRange | undefined {
    return DyntButtonStrings.textRange(atom, reading, value)
  }

  function strings(pushButton: DyntPushButton, value: Uint8Array, reading: DyntButtonStringReading): string[] | undefined {
    const found = DyntButtonStrings.pushButtonStrings(pushButton, value, reading)
    if (found === undefined) return undefined
    const decoder = new TextDecoder()
    return [decoder.decode(found.text.of(value)), decoder.decode(found.functionCode.of(value))]
  }

  test("agreedStrings", () => {
    // A leading atom moves the button away from offset 0 of the value.
    const { button: pushButton, value } = button(
      pushContent({ text: "Ask the Duck", code: "=ZZASK" }),
      rawAtom(132, { content: field2Content(ascii("Hi")) })
    )
    assert.ok(pushButton.textOffset === 19 && pushButton.functionCodeOffset === 32)
    for (const reading of ["agreed", "sequential", "offsets"] as const) assert.deepEqual(strings(pushButton, value, reading), ["Ask the Duck", "=ZZASK"], reading)
    assert.equal(raw(pushButton, value, "opaque"), undefined)
    assert.equal(DyntButtonStringReading.allCases.length, 4)
    assert.equal(DyntButtonStrings.stringsAtomOffset, 19)
    throwsInfo(() => pushButton.textRange(), DyntSpecGapError, { kind: "specGap", issue: 35 }, "the walker's accessor keeps the gap")
  })

  test("disagreeingOffsets", () => {
    // The strings "Squeak" and "=ZZSQUEAK", but the text offset points at the function code.
    const content = pushContent({ text: "Squeak", code: "=ZZSQUEAK", textOffset: 26, codeOffset: 26 })
    const { button: pushButton, value } = button(content)
    assert.equal(strings(pushButton, value, "agreed"), undefined)
    assert.deepEqual(strings(pushButton, value, "sequential"), ["Squeak", "=ZZSQUEAK"])
    assert.deepEqual(strings(pushButton, value, "offsets"), ["=ZZSQUEAK", "=ZZSQUEAK"])
    const codeOnly = pushContent({ text: "Squeak", code: "=ZZSQUEAK", codeOffset: 19 })
    const other = button(codeOnly)
    assert.equal(strings(other.button, other.value, "agreed"), undefined, "the function-code offset disagrees")
  })

  test("zeroOffsets", () => {
    const { button: pushButton, value } = button(pushContent({ text: "Honk", code: "=ZZHONK", textOffset: 0, codeOffset: 0 }))
    assert.deepEqual(strings(pushButton, value, "agreed"), ["Honk", "=ZZHONK"])
    assert.equal(strings(pushButton, value, "offsets"), undefined, "offset 0 lies in the header")
  })

  test("malformed", () => {
    const short = button(bytes(7, 1, 0, 0, 0, 0, 0x51, 0))
    assert.equal(strings(short.button, short.value, "agreed"), undefined)
    assert.equal(strings(short.button, short.value, "sequential"), undefined)
    const none = button(bytes(7, 1, 0, 0, 0, 0, 0x51))
    assert.equal(strings(none.button, none.value, "sequential"), undefined)
    const far = button(pushContent({ text: "Waddle", code: "=ZZ", textOffset: 200 }))
    assert.equal(strings(far.button, far.value, "offsets"), undefined)
    const unterminated = pushContent({ text: "Waddle", code: "=ZZ", codeOffset: 29, tail: [] })
    const cut = button(unterminated.slice(0, -1))
    assert.equal(strings(cut.button, cut.value, "offsets"), undefined, "the function code has no zero byte")
    assert.equal(raw(far.button, far.value.slice(0, 10)), undefined, "the value is shorter than the atom")
    const odd = new DyntPushButton({ vLength: 1, vHeight: 1, functionCodeOffset: 0, textOffset: 0, stringsRange: byteRange(3, 5) })
    assert.equal(raw(odd, repeated(0, 5)), undefined, "a strings range that starts inside a header")
  })

  test("encoder", () => {
    const header = new DyntAtomHeader({ etype: DyntElementType.of("pushbutton2"), block: 1, row: 9, col: 4 })
    const value = written(output =>
      DyntButtonStrings.appendPushButton(header, { vLength: 16, vHeight: 1, text: ascii("Ask the Duck"), functionCode: ascii("=ZZASK") }, output)
    )
    assert.deepEqual(value, rawAtom(115, { content: pushContent({ text: "Ask the Duck", code: "=ZZASK" }), row: 9, col: 4 }))
    const { button: pushButton } = button(pushContent({ text: "Ask the Duck", code: "=ZZASK" }))
    assert.deepEqual(strings(pushButton, value, "agreed"), ["Ask the Duck", "=ZZASK"])
    const untouched = new ByteWriter()
    throwsInfo(
      () =>
        DyntButtonStrings.appendPushButton(
          new DyntAtomHeader({ etype: DyntElementType.of("pushbutton1") }),
          { vLength: 1, vHeight: 1, text: ascii("A"), functionCode: ascii("B") },
          untouched
        ),
      DyntAtomEncodingError,
      { kind: "wrongElementType", value: DyntElementType.of("pushbutton1") }
    )
    throwsInfo(
      () => DyntButtonStrings.appendPushButton(header, { vLength: 1, vHeight: 1, text: bytes(0x41, 0), functionCode: ascii("B") }, untouched),
      DyntAtomEncodingError,
      { kind: "zeroByteInString", value: "text" }
    )
    throwsInfo(
      () => DyntButtonStrings.appendPushButton(header, { vLength: 1, vHeight: 1, text: ascii("A"), functionCode: bytes(0) }, untouched),
      DyntAtomEncodingError,
      { kind: "zeroByteInString", value: "functionCode" }
    )
    const huge = repeated(0x41, 70_000)
    throwsInfo(
      () => DyntButtonStrings.appendPushButton(header, { vLength: 1, vHeight: 1, text: huge, functionCode: ascii("B") }, untouched),
      DyntAtomEncodingError,
      { kind: "atomTooLong", length: 13 + 6 + 70_000 + 1 + 2 }
    )
    assert.equal(untouched.length, 0)
  })

  test("radioText", () => {
    // button, label length, event id offset, event id length, text offset, text length, text.
    function radio(eventIDLength: number, textLength: number, radioText: string): { atom: DyntAtom; value: Uint8Array } {
      const content = cat([1], u16BE(6), u16BE(0), [eventIDLength], u16BE(0), u16BE(textLength), ascii(radioText))
      const value = rawAtom(129, { content })
      const atom = walkAtoms(value).atoms[0]
      assert.ok(atom)
      return { atom, value }
    }
    const agreed = radio(0, 6, "Mallar")
    assert.equal(agreed.atom.payload.kind, "radioButton", "not a radio button")
    if (agreed.atom.payload.kind !== "radioButton") return
    const range = DyntButtonStrings.agreedTextRange(agreed.atom.payload.value)
    assert.ok(range)
    assert.equal(new TextDecoder().decode(range.of(agreed.value)), "Mallar")
    assert.deepEqual(text(agreed.atom, "agreed", agreed.value), range)
    assert.equal(text(agreed.atom, "opaque", agreed.value), undefined)
    const longer = radio(0, 4, "Mallard")
    assert.equal(longer.atom.payload.kind, "radioButton", "not a radio button")
    if (longer.atom.payload.kind !== "radioButton") return
    assert.equal(DyntButtonStrings.agreedTextRange(longer.atom.payload.value), undefined, "pysap reads 4 bytes, Wireshark 7")
    const withEvent = radio(2, 5, "Mallard")
    assert.equal(withEvent.atom.payload.kind, "radioButton", "not a radio button")
    if (withEvent.atom.payload.kind !== "radioButton") return
    assert.equal(DyntButtonStrings.agreedTextRange(withEvent.atom.payload.value), undefined, "an event id: the sources' texts differ in meaning")
  })

  test("textWithReading", () => {
    const { value } = button(pushContent({ text: "Quack", code: "=ZZQ" }))
    const atoms = walkAtoms(value).atoms
    const push = atoms[0]
    assert.ok(push)
    const caption = text(push, "agreed", value)
    assert.ok(caption)
    assert.equal(new TextDecoder().decode(caption.of(value)), "Quack")
    assert.equal(text(push, "opaque", value), undefined)
    const label = rawAtom(132, { content: field2Content(ascii("Pond")) })
    const field = walkAtoms(label).atoms[0]
    assert.ok(field)
    assert.deepEqual(text(field, "opaque", label), field.textRange)
  })
})
