// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DyntText.swift (MIT).

// Swift's `extension DyntAtom` of this file (`atom.range(of:)`) is `DyntText.range(atom, part)`:
// a TypeScript class cannot be extended from another module, so the members an extension adds to a
// type of another file live in a const object named after the Swift file that declares them.

import { CodePage, TextEncoding } from "./codePageText.js"
import { ByteRange, CodecSpecGap } from "./diagCodec.js"
import type { DyntAtom } from "./dyntAtom.js"

/**
 * The text parts an atom can have: the text of FNAME, XMLPROP, the field variants, the frame
 * caption and the tabstrip-button caption, plus the function code and id of a tabstrip button.
 */
export type DyntTextPart = "text" | "functionCode" | "id"
export const DyntTextPart = { allCases: ["text", "functionCode", "id"] as readonly DyntTextPart[] } as const

/** Why an atom's text was not decoded. */
export type DyntTextErrorInfo =
  /**
   * The atom is a password field (INVISIBLE, PV-0621). Its value never becomes a `string`: it
   * travels as a non-printable secret (IMPL-DA-1, docs/architecture.md §5).
   */
  | { readonly kind: "passwordField" }
  /**
   * The atom's payload has no decoded text of that part: an opaque payload (IMPL-DA-2), the
   * strings of a push or radio button (#35), a dlen mismatch (#36) or a malformed payload.
   */
  | { readonly kind: "noText" }
  /** The text's range lies outside the value given: the atom came from another item value. */
  | { readonly kind: "outOfRange" }
  /**
   * The code page is none Swooey knows (#18): only 4110, 4102, 4103 and 1100 are (session.md
   * §6.4, `TextEncoding`).
   */
  | { readonly kind: "specGap"; readonly issue: number }
  /** The bytes are not valid text in the code page. */
  | { readonly kind: "invalidText" }

export class DyntTextError extends Error {
  constructor(readonly info: DyntTextErrorInfo) {
    super(describeDyntTextError(info))
    this.name = "DyntTextError"
  }
}

function describeDyntTextError(info: DyntTextErrorInfo): string {
  switch (info.kind) {
    case "passwordField":
      return "DYNT text: a password field is never decoded"
    case "noText":
      return "DYNT text: the atom has no text of that part"
    case "outOfRange":
      return "DYNT text: the text lies outside the value given"
    case "specGap":
      return `DYNT text: code page not specified (spec gap #${info.issue})`
    case "invalidText":
      return "DYNT text: the bytes are not valid in the code page"
  }
}

/**
 * Decodes atom text on demand (dynt-atoms.md, R-DA-5 and R-DA-6; IMPL-DA-5).
 *
 * The walker never decodes text: it yields byte ranges. A caller decodes only the atoms it needs,
 * for example the fields that changed since the last screen (docs/architecture.md §3), with the
 * code page in force: the one the server declared in CODEPAGE_DIAG_GUI, or before that the one
 * requested in CONNECT (session.md §6.3, Reading R-SE-9).
 */
export const DyntText = {
  /**
   * The code-page number of UTF-8, the one a Unicode system declares in CODEPAGE_DIAG_GUI
   * (PV-0130). The other numbers Swooey knows are in `CodePage` (session.md §6.4).
   */
  utf8CodePage: CodePage.utf8,

  /**
   * The range of one text part within the item value, or undefined when the atom has none: only a
   * tabstrip button has a function code and an id. (Swift: `extension DyntAtom`,
   * `atom.range(of:)`.)
   */
  range(atom: DyntAtom, part: DyntTextPart): ByteRange | undefined {
    if (part === "text") return atom.textRange
    if (atom.payload.kind !== "tabstripButton") return undefined
    return part === "functionCode" ? atom.payload.value.functionCodeRange : atom.payload.value.idRange
  },

  /**
   * Decodes one text part of `atom`, which the walker produced from `value`: with a number, in the
   * code page in force, `codePage`; with a `TextEncoding`, in that encoding, for a caller that has
   * chosen the encoding itself, such as the ISO 8859-1 stand-in for a code page Swooey does not
   * know (session.md §6.4). (Swift's `decode(_:of:in:codePage:)` and `decode(_:of:in:encoding:)`.)
   *
   * Checks, in this order: a password field is refused (`passwordField`); the part must exist
   * (`noText`) and lie inside `value` (`outOfRange`); the code page must be one Swooey knows
   * (`specGap` with #18; `TextEncoding.fromCodePage`); the bytes must be valid in it
   * (`invalidText`). Invalid bytes are never repaired or replaced.
   */
  decode(atom: DyntAtom, value: Uint8Array, codePageOrEncoding: number | TextEncoding, part: DyntTextPart = "text"): string {
    if (atom.isPasswordField) throw new DyntTextError({ kind: "passwordField" })
    const range = DyntText.range(atom, part)
    if (range === undefined) throw new DyntTextError({ kind: "noText" })
    if (!(range.lowerBound >= 0 && range.upperBound <= value.length)) throw new DyntTextError({ kind: "outOfRange" })
    const bytes = range.of(value)
    if (typeof codePageOrEncoding === "number") return DyntText.decodeBytes(bytes, codePageOrEncoding)
    const text = TextEncoding.decode(codePageOrEncoding, bytes)
    if (text === undefined) throw new DyntTextError({ kind: "invalidText" })
    return text
  },

  /** Decodes bytes with the code page in force. Strict: invalid bytes throw. (Swift `decode(_:codePage:)`, internal.) */
  decodeBytes(bytes: Uint8Array, codePage: number): string {
    const encoding = TextEncoding.fromCodePage(codePage)
    if (encoding === undefined) throw new DyntTextError({ kind: "specGap", issue: CodecSpecGap.codePageValues })
    const text = TextEncoding.decode(encoding, bytes)
    if (text === undefined) throw new DyntTextError({ kind: "invalidText" })
    return text
  }
} as const
