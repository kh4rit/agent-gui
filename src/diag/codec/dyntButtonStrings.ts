// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DyntButtonStrings.swift (MIT).

// The strings of push-button (115) and radio-button (129) atoms (docs/protocol/dynt-atoms.md,
// "Button strings"). The pinned sources conflict on them (#35); ODG's decoder of real GUI traffic
// sides with Wireshark for push buttons and gives the two offset fields a meaning (PV-0658), so
// Reading R-DA-9 decodes them, switchable. A radio button's text is decoded only where pysap and
// Wireshark read the same bytes (PV-0659). The walker still reports both payloads as fixed fields
// plus an opaque range (IMPL-DA-2); these functions read the strings on demand.
//
// Swift declares them as extensions of DyntPushButton, DyntRadioButton, DyntAtom and
// DyntAtomEncoder (dyntAtom.ts, dyntAtomEncoder.ts). A TypeScript class cannot be extended from
// another module, so they are the members of `DyntButtonStrings`, named after this file; each says
// which Swift member it is.

import type { ByteWriter } from "../wire/index.js"
import { ByteRange } from "./diagCodec.js"
import {
  DyntAtomLayout,
  DyntElementType,
  DyntPayloadLayout,
  type DyntAtom,
  type DyntAtomHeader,
  type DyntPushButton,
  type DyntRadioButton
} from "./dyntAtom.js"
import { DyntAtomEncoder, DyntAtomEncodingError } from "./dyntAtomEncoder.js"

/**
 * How a push button's two strings, the caption and then the function code, are found (#35).
 * - `agreed`: Reading R-DA-9, the default: two zero-terminated strings from payload offset 6, as
 *   Wireshark reads them, and where the two offset fields are not zero they must point at the same
 *   two places, counted from the atom's first byte, as ODG reads them (PV-0658).
 * - `sequential`: Wireshark's reading alone: two zero-terminated strings from payload offset 6; the
 *   offset fields are ignored.
 * - `offsets`: ODG's reading alone: each string starts at its offset field, counted from the atom's
 *   first byte, and ends at a zero byte.
 * - `opaque`: the gap: the strings stay opaque (IMPL-DA-2).
 */
export type DyntButtonStringReading = "agreed" | "sequential" | "offsets" | "opaque"
export const DyntButtonStringReading = {
  allCases: ["agreed", "sequential", "offsets", "opaque"] as readonly DyntButtonStringReading[]
} as const

/**
 * A push button's caption and function code, offset ranges into the item value, without their zero
 * bytes. The function code is what a click sends in VARINFO OKCODE, verbatim (PV-0773).
 */
export class DyntPushButtonStrings {
  readonly text: ByteRange
  readonly functionCode: ByteRange

  constructor(fields: { text: ByteRange; functionCode: ByteRange }) {
    this.text = fields.text
    this.functionCode = fields.functionCode
  }
}

/** The fields of a push-button atom for `DyntButtonStrings.appendPushButton`. */
export interface DyntPushButtonContent {
  vLength: number
  vHeight: number
  text: Uint8Array
  functionCode: Uint8Array
}

export const DyntButtonStrings = {
  /**
   * The offset of the first string byte from the atom's first byte: the header and the six fixed
   * bytes (PV-0658; ODG saw a caption offset of 19 on every button it decoded). (Swift
   * `DyntPushButton.stringsAtomOffset`.)
   */
  stringsAtomOffset: DyntAtomLayout.headerSize + DyntPayloadLayout.pushFixedSize, // provenance: PV-0658

  /**
   * The caption and the function code under `reading`, or undefined when the payload does not fit
   * it: a string without its zero byte before the end of the atom, an offset outside the strings,
   * the offsets and the zero bytes disagreeing (`agreed`), or `opaque`. `value` is the item value
   * the atom was walked in. (Swift `button.strings(in:reading:)`.)
   */
  pushButtonStrings(button: DyntPushButton, value: Uint8Array, reading: DyntButtonStringReading = "agreed"): DyntPushButtonStrings | undefined {
    const strings = button.stringsRange
    if (!(strings.upperBound <= value.length && strings.lowerBound >= DyntButtonStrings.stringsAtomOffset)) return undefined
    const atomStart = strings.lowerBound - DyntButtonStrings.stringsAtomOffset
    switch (reading) {
      case "opaque":
        return undefined
      case "sequential":
      case "agreed": {
        const text = DyntButtonStrings.zeroTerminated(value, strings.lowerBound, strings.upperBound)
        if (text === undefined) return undefined
        const code = DyntButtonStrings.zeroTerminated(value, text.upperBound + 1, strings.upperBound)
        if (code === undefined) return undefined
        if (reading === "agreed") {
          if (button.textOffset !== 0 && atomStart + button.textOffset !== text.lowerBound) return undefined
          if (button.functionCodeOffset !== 0 && atomStart + button.functionCodeOffset !== code.lowerBound) return undefined
        }
        return new DyntPushButtonStrings({ text, functionCode: code })
      }
      case "offsets": {
        const text = stringAt(button, button.textOffset, atomStart, value)
        if (text === undefined) return undefined
        const code = stringAt(button, button.functionCodeOffset, atomStart, value)
        if (code === undefined) return undefined
        return new DyntPushButtonStrings({ text, functionCode: code })
      }
    }
  },

  /**
   * `start ..< z` where `z` is the first zero byte in `start ..< end`, or undefined without one.
   * (Swift `DyntPushButton.zeroTerminated(in:from:end:)`, internal.)
   */
  zeroTerminated(value: Uint8Array, start: number, end: number): ByteRange | undefined {
    for (let index = start; index < end; index++) if (value[index] === DyntPayloadLayout.stringTerminator) return new ByteRange(start, index)
    return undefined
  },

  /**
   * The text, where both sources read the same bytes (PV-0659): event_id_len is 0 and text_length
   * equals the rest of the atom, so pysap's `event_id_len + text_length` bytes and Wireshark's rest
   * of the atom are one range. Undefined otherwise: the conflict of #35 stays. (Swift
   * `button.agreedTextRange`.)
   */
  agreedTextRange(button: DyntRadioButton): ByteRange | undefined {
    if (!(button.eventIDLength === 0 && button.textLength === button.restRange.count)) return undefined
    return button.restRange
  },

  /**
   * The range of the atom's text, as `DyntAtom.textRange` gives it, plus a push button's caption
   * under `reading` and a radio button's text where the sources agree (PV-0658, PV-0659). (Swift
   * `atom.range(ofTextWith:in:)`.)
   */
  textRange(atom: DyntAtom, reading: DyntButtonStringReading, value: Uint8Array): ByteRange | undefined {
    switch (atom.payload.kind) {
      case "pushButton":
        return DyntButtonStrings.pushButtonStrings(atom.payload.value, value, reading)?.text
      case "radioButton":
        return reading === "opaque" ? undefined : DyntButtonStrings.agreedTextRange(atom.payload.value)
      default:
        return atom.textRange
    }
  },

  /**
   * Appends a push-button atom (115) in the layout of Reading R-DA-9 (PV-0657, PV-0658): the fixed
   * fields, then the caption and the function code, each followed by a zero byte, with text_offset
   * and function_code_offset pointing at them from the atom's first byte. Both sources' sequential
   * reading and ODG's offsets then find the same strings. Nothing is appended when it throws.
   * (Swift `DyntAtomEncoder.appendPushButton(_:vLength:vHeight:text:functionCode:to:)`.)
   */
  appendPushButton(header: DyntAtomHeader, button: DyntPushButtonContent, output: ByteWriter): void {
    if (DyntElementType.fromRaw(DyntElementType.rawValue(header.etype)).kind !== "pushbutton2")
      throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    const { text, functionCode } = button
    if (DyntButtonStrings.zeroTerminated(text, 0, text.length) !== undefined) throw new DyntAtomEncodingError({ kind: "zeroByteInString", value: "text" })
    if (DyntButtonStrings.zeroTerminated(functionCode, 0, functionCode.length) !== undefined)
      throw new DyntAtomEncodingError({ kind: "zeroByteInString", value: "functionCode" })
    // Each string is followed by its zero byte; the counts are bounded by the arrays' sizes.
    const strings = text.length + functionCode.length + 2 // not-protocol: two terminators
    const length = DyntAtomEncoder.atomLength(DyntPayloadLayout.pushFixedSize + strings)
    const textOffset = DyntButtonStrings.stringsAtomOffset
    const codeOffset = textOffset + text.length + 1
    DyntAtomEncoder.appendHeader(header, length, output)
    output.u8(button.vLength)
    output.u8(button.vHeight)
    // The atom is at most 65 535 bytes long (checked above), so both offsets fit.
    output.u16be(codeOffset) // provenance: PV-0657
    output.u16be(textOffset) // provenance: PV-0657
    output.bytes(text)
    output.u8(DyntPayloadLayout.stringTerminator)
    output.bytes(functionCode)
    output.u8(DyntPayloadLayout.stringTerminator)
  }
} as const

/** The zero-terminated string an offset field points at, inside the strings range. */
function stringAt(button: DyntPushButton, offset: number, atomStart: number, value: Uint8Array): ByteRange | undefined {
  const start = atomStart + offset
  if (!(start >= button.stringsRange.lowerBound && start < button.stringsRange.upperBound)) return undefined
  return DyntButtonStrings.zeroTerminated(value, start, button.stringsRange.upperBound)
}
