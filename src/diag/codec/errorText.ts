// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ErrorText.swift (MIT).

// A server error text decoded for the user's own screen (docs/protocol/diag-header.md, "Error
// messages", "Error body layout" and "Observed error after the logon step"; IMPL-DH-8). Not on the
// hot path: a server error ends the exchange it answers.

import { CodePage, TextEncoding, codeUnits, decodeUTF16, decodeUTF8, scalarsToString } from "./codePageText.js"
import { DiagErrorBody } from "./diagMessage.js"

/** Node's `util.inspect.custom`, without importing `node:util` (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/**
 * A byte-order mark found at the start of the text and stripped by a UTF-16 reading: `littleEndian`
 * is `FF FE` (the text was read as UTF-16LE), `bigEndian` is `FE FF` (read as UTF-16BE).
 */
export type ByteOrderMark = "littleEndian" | "bigEndian"

/**
 * A server's error text, decoded for display on the **user's own screen only**: the owner's
 * terminal in diagctl's live mode, the app's status line.
 *
 * An error text comes from the server and may name the system, so it never goes into the debug
 * log, a dump, a fixture or anything committed (D12, D21); the scrubbed log keeps its byte count.
 * Its descriptions (`toString()`, `toJSON()`, `util.inspect`) withhold the text and give the byte
 * count and the decoder's `notes` only: the text is shown only where `text` is read on purpose.
 *
 * **Encoding.** The text is decoded in the session's code page in force (session.md §6.3, Reading
 * R-SE-9): the one CONNECT requested until the server declares one in CODEPAGE_DIAG_GUI, then the
 * declared one. Wireshark reads error texts as UTF-16LE (PV-0727), but a live system that had
 * declared 4110 sent one as UTF-8 with an odd byte count (trial-derived, PV-0308), so the sources
 * disagree (#8) and the result is checked. A reading looks wrong when it holds replacement
 * characters, control characters other than tab and line breaks, or noncharacters; when most of
 * its letters are not Latin while the bytes are mostly printable ASCII (UTF-16 read from
 * single-byte text); when most of its UTF-16 code units are ASCII with the bytes swapped (UTF-16
 * read in the wrong byte order); or when it is ISO 8859-1 read from bytes that are valid UTF-8 with
 * non-ASCII bytes in them. Then UTF-8, ISO 8859-1, UTF-16LE and UTF-16BE are tried in that order
 * and the first plausible reading wins; when none is plausible, the least implausible one does,
 * the code page in force winning a tie. A code page Swooey does not know gives no reading of its
 * own. A text that starts with a UTF-16 byte-order mark is read in the byte order the mark
 * declares, whatever the code page in force. `encoding` and `isGuessed` say which was used, and the
 * first of the `notes` says it in words.
 *
 * Decoding is tolerant, because its only use is showing the owner what the server said:
 * - the text ends at the first byte 0x0C of the error body (R-DH-6, PV-0303); what follows is not
 *   looked at. A body without 0x0C is decoded whole (`missingTerminator`). Where a UTF-16 code unit
 *   holds a byte 0x0C (for example U+010C) the text is cut there too: that is R-DH-6's open
 *   question on #8, and the reason the whole text is not trusted for anything but display;
 * - a byte-order mark is stripped: `FF FE` little-endian, `FE FF` big-endian (no source shows
 *   either; #8 asks whether one occurs);
 * - an odd trailing byte of a UTF-16 reading, an invalid byte sequence (ill-formed UTF-8, an
 *   unpaired surrogate) and a control character (C0, DEL, C1, which could drive the terminal) are
 *   each replaced by U+FFFD and counted.
 */
export class ServerErrorText {
  /** The decoded text, safe to print on a terminal. */
  readonly text: string
  /** The number of text bytes decoded: the bytes before the terminator, BOM included. */
  readonly byteCount: number
  /**
   * True when the error body held no byte 0x0C, so all of it was decoded (IMPL-DH-7 fails the
   * split; this display does not).
   */
  readonly missingTerminator: boolean
  /** The session's code page in force the text was decoded for (Reading R-SE-9). */
  readonly codePage: number
  /** The character set the text was read in. */
  readonly encoding: TextEncoding
  /**
   * False when `encoding` is the code page in force's; true when the decoder chose another one,
   * because that reading looked wrong or Swooey does not know the code page in force.
   */
  readonly isGuessed: boolean
  /** The byte-order mark that was stripped, if any. */
  readonly byteOrderMark: ByteOrderMark | undefined
  /** True when a UTF-16 reading had an odd number of bytes (after any BOM); the last byte became U+FFFD. */
  readonly hasOddByte: boolean
  /** Invalid byte sequences replaced by U+FFFD: ill-formed UTF-8, or unpaired surrogates. */
  readonly invalidSequenceCount: number
  /** Control characters (U+0000–U+001F, U+007F–U+009F) replaced by U+FFFD. */
  readonly controlCharacterCount: number

  /**
   * Decodes the text of an error body: the bytes after the DIAG header of a message with err_no ≠ 0
   * and compress 0, or the decompressed data of one with compress 1 (IMPL-DH-6). The text is what
   * comes before the first byte 0x0C (R-DH-6). `codePage` is the session's code page in force
   * (Reading R-SE-9). (Swift `init(errorBody:codePage:)`.)
   */
  static fromErrorBody(errorBody: Uint8Array, codePage: number): ServerErrorText {
    let end = 0
    while (end < errorBody.length && errorBody[end] !== DiagErrorBody.terminator) end += 1
    return new ServerErrorText(errorBody.subarray(0, end), end === errorBody.length, codePage)
  }

  /**
   * Decodes text bytes that are already split from their error body, for example with
   * `DiagErrorBody.textRange`. (Swift `init(textBytes:codePage:)`.)
   */
  static fromTextBytes(textBytes: Uint8Array, codePage: number): ServerErrorText {
    return new ServerErrorText(textBytes, false, codePage)
  }

  private constructor(bytes: Uint8Array, missingTerminator: boolean, codePage: number) {
    const inForce = TextEncoding.fromCodePage(codePage)
    const order: TextEncoding[] = inForce === undefined ? [] : [inForce]
    for (const candidate of ServerErrorText.fallbackOrder) if (!order.includes(candidate)) order.push(candidate)
    let chosen: Reading
    const marked = Reading.byteOrderMarkEncoding(bytes)
    if (marked !== undefined) {
      chosen = new Reading(bytes, marked)
    } else {
      const readings = order.map(encoding => new Reading(bytes, encoding))
      const leastImplausible = readings.slice(1).reduce((best, reading) => (reading.badness < best.badness ? reading : best), readings[0])
      chosen = readings.find(reading => reading.badness === 0) ?? leastImplausible
    }

    const scalars: number[] = []
    let controls = 0
    for (const scalar of chosen.scalars) {
      if (ServerErrorText.isControl(scalar)) {
        controls += 1
        scalars.push(ServerErrorText.replacement)
      } else {
        scalars.push(scalar)
      }
    }
    this.text = scalarsToString(scalars)
    this.byteCount = bytes.length
    this.missingTerminator = missingTerminator
    this.codePage = codePage
    this.encoding = chosen.encoding
    this.isGuessed = chosen.encoding !== inForce
    this.byteOrderMark = chosen.mark
    this.hasOddByte = chosen.oddByte
    this.invalidSequenceCount = chosen.invalid
    this.controlCharacterCount = controls
  }

  /**
   * What the decoder found besides the text, in words, for a line next to it: the character set it
   * read the text in and whether that was the code page in force or a guess; then a missing
   * terminator, a byte-order mark, an odd byte, invalid sequences and control characters.
   */
  get notes(): string[] {
    const notes = [`decoded as ${TextEncoding.description(this.encoding)} (${this.isGuessed ? "guessed" : "code page in force"})`]
    if (this.missingTerminator) notes.push("no 0x0C terminator: the whole error body was decoded")
    switch (this.byteOrderMark) {
      case "littleEndian":
        notes.push("a little-endian byte-order mark (FF FE) was stripped")
        break
      case "bigEndian":
        notes.push("a big-endian byte-order mark (FE FF) was stripped")
        break
      case undefined:
        break
    }
    if (this.hasOddByte) notes.push("an odd number of bytes: the last one is shown as U+FFFD")
    if (this.invalidSequenceCount > 0) notes.push(`${this.invalidSequenceCount} invalid byte sequence(s) shown as U+FFFD`)
    if (this.controlCharacterCount > 0) notes.push(`${this.controlCharacterCount} control character(s) shown as U+FFFD`)
    return notes
  }

  /** The readings tried after the code page in force's, in order. */
  static readonly fallbackOrder: readonly TextEncoding[] = ["utf8", "latin1", "utf16LittleEndian", "utf16BigEndian"]
  static readonly replacement = 0xfffd

  /** C0 controls, DEL and C1 controls: what a terminal may act on instead of showing. */
  static isControl(scalar: number): boolean {
    return scalar < 0x20 || (scalar >= 0x7f && scalar <= 0x9f) // not-protocol: Unicode control ranges
  }

  /** The byte count and the decoder's notes; never the text (Swift `description`). */
  get description(): string {
    return `ServerErrorText(${this.byteCount} bytes, text withheld; ` + this.notes.join("; ") + ")"
  }

  /** Swift `debugDescription`: the same as `description`. */
  get debugDescription(): string {
    return this.description
  }

  toString(): string {
    return this.description
  }

  /** The description, so that `JSON.stringify` writes no text. */
  toJSON(): string {
    return this.description
  }

  /** The description for `util.inspect` and `console.log`: no text. */
  [INSPECT](): string {
    return this.description
  }
}

const UNIT_SIZE = 2 // not-protocol: bytes per UTF-16 code unit
const MARK_LOW = 0xff // not-protocol: low byte of the Unicode byte-order mark U+FEFF
const MARK_HIGH = 0xfe // not-protocol: high byte of the Unicode byte-order mark U+FEFF
const FIRST_NON_ASCII = 0x80 // not-protocol: the first non-ASCII byte value

/** One reading of the text bytes in one character set, and how implausible it looks. */
class Reading {
  /**
   * The scalars read, U+FFFD for each invalid sequence and for an odd last UTF-16 byte; control
   * characters are still in (`ServerErrorText` replaces them).
   */
  scalars: number[] = []
  mark: ByteOrderMark | undefined
  oddByte = false
  invalid = 0
  /** 0 for a plausible reading; otherwise the number of signs that it is wrong. */
  badness = 0

  constructor(
    bytes: Uint8Array,
    readonly encoding: TextEncoding
  ) {
    switch (encoding) {
      case "utf8": {
        const decoded = decodeUTF8(bytes)
        this.scalars = decoded.scalars
        this.invalid = decoded.errors
        break
      }
      case "latin1":
        for (let index = 0; index < bytes.length; index++) this.scalars.push(bytes[index])
        break
      case "utf16LittleEndian":
      case "utf16BigEndian":
        this.readUTF16(bytes, encoding === "utf16BigEndian")
        break
    }
    this.badness += Reading.badness(this.scalars, bytes, encoding)
  }

  /** The UTF-16 byte order a leading byte-order mark declares, or undefined. */
  static byteOrderMarkEncoding(bytes: Uint8Array): TextEncoding | undefined {
    if (bytes.length < UNIT_SIZE) return undefined
    if (bytes[0] === MARK_LOW && bytes[1] === MARK_HIGH) return "utf16LittleEndian"
    if (bytes[0] === MARK_HIGH && bytes[1] === MARK_LOW) return "utf16BigEndian"
    return undefined
  }

  private readUTF16(bytes: Uint8Array, bigEndian: boolean): void {
    let start = 0
    if (bytes.length >= UNIT_SIZE) {
      // U+FEFF in this reading's byte order.
      const [first, second] = bigEndian ? [MARK_HIGH, MARK_LOW] : [MARK_LOW, MARK_HIGH]
      if (bytes[0] === first && bytes[1] === second) {
        this.mark = bigEndian ? "bigEndian" : "littleEndian"
        start = UNIT_SIZE
      }
    }
    const units = codeUnits(bytes.subarray(start), bigEndian)
    // ASCII with its bytes swapped (U+xx00, xx printable): the other byte order's text.
    let swapped = 0
    for (const unit of units) if ((unit & 0xff) === 0 && unit >> 8 >= 0x20 && unit >> 8 <= 0x7e) swapped += 1 // not-protocol: printable ASCII
    if (swapped * 2 > units.length) this.badness += swapped // not-protocol: "most" is more than half
    const decoded = decodeUTF16(units)
    this.scalars.push(...decoded.scalars)
    this.invalid += decoded.errors
    if ((bytes.length - start) % UNIT_SIZE !== 0) {
      this.oddByte = true
      this.scalars.push(ServerErrorText.replacement)
    }
  }

  /**
   * The signs that a reading is wrong: every replacement character, control character other than
   * tab and line breaks, and noncharacter; each non-Latin letter when most letters are non-Latin
   * and the bytes are mostly printable ASCII; each non-ASCII byte when ISO 8859-1 reads bytes that
   * are valid UTF-8. (A UTF-16 reading adds its swapped ASCII units.)
   */
  private static badness(scalars: readonly number[], bytes: Uint8Array, encoding: TextEncoding): number {
    let badness = 0
    let letters = 0
    let nonLatin = 0
    for (const scalar of scalars) {
      if (Reading.isSuspicious(scalar)) badness += 1
      if (isAlphabetic(scalar)) {
        letters += 1
        if (!Reading.isLatin(scalar)) nonLatin += 1
      }
    }
    if (nonLatin * 2 > letters && Reading.isMostlyPrintableASCII(bytes)) badness += nonLatin // not-protocol: "most" is more than half
    if (encoding === "latin1" && !CodePage.isASCII(bytes) && TextEncoding.decode("utf8", bytes) !== undefined) {
      for (let index = 0; index < bytes.length; index++) if (bytes[index] >= FIRST_NON_ASCII) badness += 1
    }
    return badness
  }

  private static isSuspicious(scalar: number): boolean {
    switch (scalar) {
      case 0x09:
      case 0x0a:
      case 0x0d:
        return false // not-protocol: tab, line feed and carriage return are plausible text
      case ServerErrorText.replacement:
        return true
      default:
        return ServerErrorText.isControl(scalar) || isNoncharacter(scalar)
    }
  }

  /** Basic Latin to Latin Extended-B, and Latin Extended Additional. */
  private static isLatin(scalar: number): boolean {
    return scalar < 0x0250 || (scalar >= 0x1e00 && scalar <= 0x1eff) // not-protocol: Unicode Latin blocks
  }

  /** At least three quarters of the bytes are printable ASCII, tab or a line break. */
  private static isMostlyPrintableASCII(bytes: Uint8Array): boolean {
    if (bytes.length === 0) return false
    let printable = 0
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]
      if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable += 1 // not-protocol: printable ASCII, tab, line breaks
    }
    return printable * 4 >= bytes.length * 3 // not-protocol: "mostly" is three quarters
  }
}

const ALPHABETIC = /^\p{Alphabetic}$/u

/** Swift `Unicode.Scalar.Properties.isAlphabetic`. */
function isAlphabetic(scalar: number): boolean {
  return ALPHABETIC.test(String.fromCodePoint(scalar))
}

/** Swift `Unicode.Scalar.Properties.isNoncharacterCodePoint`: U+FDD0–U+FDEF and U+xxFFFE, U+xxFFFF. */
function isNoncharacter(scalar: number): boolean {
  return (scalar >= 0xfdd0 && scalar <= 0xfdef) || (scalar & 0xfffe) === 0xfffe // not-protocol: Unicode noncharacters
}
