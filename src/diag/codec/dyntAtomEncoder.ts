// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DyntAtomEncoder.swift (MIT).

import type { ByteWriter } from "../wire/index.js"
import { INT_MAX, isUInt16, isUInt8 } from "./diagCodec.js"
import {
  DyntAtomLayout,
  DyntElementType,
  DyntPayloadLayout,
  type DyntAtomHeader,
  type DyntTabstripString
} from "./dyntAtom.js"

/** Values the atom encoder cannot write. Nothing is appended when one is thrown. */
export type DyntAtomEncodingErrorInfo =
  /** The atom would be longer than atom_length's 16 bits can declare (PV-0602). */
  | { readonly kind: "atomTooLong"; readonly length: number }
  /** The header's element type has another payload layout than the function writes. */
  | { readonly kind: "wrongElementType"; readonly value: DyntElementType }
  /** A field text is longer than dlen's single byte can declare (PV-0651, PV-0653). */
  | { readonly kind: "textTooLong"; readonly length: number }
  /** A `_1` field's flag1 does not fit its single byte (PV-0653). */
  | { readonly kind: "flag1OutOfRange"; readonly value: number }
  /** A tabstrip-button string contains a zero byte, which would end it early (PV-0656). */
  | { readonly kind: "zeroByteInString"; readonly value: DyntTabstripString }

export class DyntAtomEncodingError extends Error {
  constructor(readonly info: DyntAtomEncodingErrorInfo) {
    super(`DYNT atom encoder: ${JSON.stringify(info)}`)
    this.name = "DyntAtomEncodingError"
  }
}

/** The fields of a tabstrip-button atom for `DyntAtomEncoder.appendTabstripButton`. */
export interface DyntTabstripButtonContent {
  vLength: number
  vHeight: number
  pageID: number
  functionCodeOffset: number
  textOffset: number
  idOffset: number
  text: Uint8Array
  functionCode: Uint8Array
  id: Uint8Array
}

/**
 * Writes atoms in the layouts of dynt-atoms.md: the 13-byte header, then the payload.
 *
 * This is the plain layout, with no policy, for the fake server, for tests, and for the returned
 * fields of the client's input step (`ClientInputStep`, client-input.md R-CI-3). It writes the
 * dlg_flag bytes as given: which bits mark user input as changed is spec gap #34, so the input step
 * carries the flags of the received field verbatim and cannot yet mark a field changed
 * (dynt-atoms.md, "User input"). It writes no push-button (115) or radio-button (129) strings, whose
 * layout is #35, except as raw content through `appendAtom`.
 */
export const DyntAtomEncoder = {
  /**
   * Appends an atom with `content` as its payload, written verbatim: atom_length = 13 + content
   * (PV-0603), then the header fields in order (PV-0141).
   */
  appendAtom(header: DyntAtomHeader, content: Uint8Array, output: ByteWriter): void {
    const length = DyntAtomEncoder.atomLength(content.length)
    DyntAtomEncoder.appendHeader(header, length, output)
    output.bytes(content)
  },

  /** Appends a FNAME (114) or XMLPROP (120) atom whose whole payload is `text` (PV-0650). */
  appendText(header: DyntAtomHeader, text: Uint8Array, output: ByteWriter): void {
    if (!DyntElementType.isChildMetadata(header.etype)) throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    DyntAtomEncoder.appendAtom(header, text, output)
  },

  /**
   * Appends a `_1` (121–123) or `_2` (130–132) field atom. dlen is the text's byte length and
   * nothing follows the text, as an encoder must (PV-0652, PV-0653). `flag1` defaults to 0.
   */
  appendField(
    header: DyntAtomHeader,
    field: { flag1?: number; mlen: number; maxNrChars: number; text: Uint8Array },
    output: ByteWriter
  ): void {
    const flag1 = field.flag1 ?? 0
    const text = field.text
    const form = DyntElementType.fieldForm(header.etype)
    if (form === undefined) throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    if (!isUInt8(text.length)) throw new DyntAtomEncodingError({ kind: "textTooLong", length: text.length })
    const dlen = text.length
    const fixed = form === "v1" ? DyntPayloadLayout.field1Text : DyntPayloadLayout.field2Text
    const length = DyntAtomEncoder.atomLength(fixed + text.length)
    switch (form) {
      case "v1":
        if (!isUInt8(flag1)) throw new DyntAtomEncodingError({ kind: "flag1OutOfRange", value: flag1 })
        DyntAtomEncoder.appendHeader(header, length, output)
        output.u8(flag1)
        output.u8(dlen)
        output.u8(field.mlen)
        output.u16be(field.maxNrChars) // provenance: PV-0653
        break
      case "v2":
        DyntAtomEncoder.appendHeader(header, length, output)
        output.u16be(flag1) // provenance: PV-0651
        output.u8(dlen)
        output.u8(field.mlen)
        output.u16be(field.maxNrChars) // provenance: PV-0651
        break
    }
    output.bytes(text)
  },

  /** Appends a frame atom (127): drows, dcols, then the caption (PV-0654). */
  appendFrame(header: DyntAtomHeader, drows: number, dcols: number, text: Uint8Array, output: ByteWriter): void {
    if (DyntElementType.fromRaw(DyntElementType.rawValue(header.etype)).kind !== "frame1")
      throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    const length = DyntAtomEncoder.atomLength(DyntPayloadLayout.frameText + text.length)
    DyntAtomEncoder.appendHeader(header, length, output)
    output.u16be(drows) // provenance: PV-0654
    output.u16be(dcols) // provenance: PV-0654
    output.bytes(text)
  },

  /**
   * Appends a tabstrip-button atom (116): the fixed fields, then the text, the function code and the
   * id, each followed by a zero byte (PV-0656). The offsets are written as given.
   */
  appendTabstripButton(header: DyntAtomHeader, button: DyntTabstripButtonContent, output: ByteWriter): void {
    if (DyntElementType.fromRaw(DyntElementType.rawValue(header.etype)).kind !== "tabstripButton")
      throw new DyntAtomEncodingError({ kind: "wrongElementType", value: header.etype })
    if (containsZero(button.text)) throw new DyntAtomEncodingError({ kind: "zeroByteInString", value: "text" })
    if (containsZero(button.functionCode)) throw new DyntAtomEncodingError({ kind: "zeroByteInString", value: "functionCode" })
    if (containsZero(button.id)) throw new DyntAtomEncodingError({ kind: "zeroByteInString", value: "id" })
    // Each string is followed by its zero byte; the counts are bounded by the arrays' sizes.
    const strings = button.text.length + button.functionCode.length + button.id.length + 3 // not-protocol: three terminators
    const length = DyntAtomEncoder.atomLength(DyntPayloadLayout.tabStrings + strings)
    DyntAtomEncoder.appendHeader(header, length, output)
    output.u8(button.vLength)
    output.u8(button.vHeight)
    output.u8(button.pageID)
    output.u16be(button.functionCodeOffset) // provenance: PV-0656
    output.u16be(button.textOffset) // provenance: PV-0656
    output.u16be(button.idOffset) // provenance: PV-0656
    output.bytes(button.text)
    output.u8(DyntPayloadLayout.stringTerminator)
    output.bytes(button.functionCode)
    output.u8(DyntPayloadLayout.stringTerminator)
    output.bytes(button.id)
    output.u8(DyntPayloadLayout.stringTerminator)
  },

  // MARK: Internals

  /**
   * atom_length for a payload of `payload` bytes, checked against the u16 field (PV-0602). A sum
   * past 2^53 − 1 (Swift: past `Int.max`) is reported with that length.
   */
  atomLength(payload: number): number {
    const total = DyntAtomLayout.headerSize + payload
    const overflow = !Number.isSafeInteger(total)
    if (overflow || !isUInt16(total)) throw new DyntAtomEncodingError({ kind: "atomTooLong", length: overflow ? INT_MAX : total })
    return total
  },

  /** The header in the order of PV-0141, with atom_length first. */
  appendHeader(header: DyntAtomHeader, length: number, output: ByteWriter): void {
    output.u16be(length) // provenance: PV-0602
    output.u8(header.dialogFlags.flag1)
    output.u8(header.dialogFlags.flag2)
    output.u8(DyntElementType.rawValue(header.etype))
    output.u8(header.area)
    output.u8(header.block)
    output.u8(header.group)
    output.u16be(header.row) // provenance: PV-0610
    output.u16be(header.col) // provenance: PV-0611
    output.u8(header.attributes)
  }
} as const

function containsZero(bytes: Uint8Array): boolean {
  return bytes.includes(DyntPayloadLayout.stringTerminator)
}
