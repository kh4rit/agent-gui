// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ServerErrorTextTests.swift (MIT).

import assert from "node:assert/strict"
import { inspect } from "node:util"
import { describe, test } from "node:test"
import { CodePage, DiagErrorBody, ServerErrorText, TextEncoding } from "../../../diag/codec/index.js"
import { ascii, bytes, cat } from "../../support/codecTestSupport.js"

/** UTF-16 little-endian bytes of an invented text. */
function utf16LE(text: string): Uint8Array {
  const output: number[] = []
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    output.push(unit & 0xff, unit >> 8)
  }
  return Uint8Array.from(output)
}

/** UTF-16 big-endian bytes of an invented text. */
function utf16BE(text: string): Uint8Array {
  const output: number[] = []
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    output.push(unit >> 8, unit & 0xff)
  }
  return Uint8Array.from(output)
}

const fromBody = ServerErrorText.fromErrorBody
const fromText = ServerErrorText.fromTextBytes

/**
 * The error-text decoder for the user's own screen (diag-header.md, "Error messages" and "Observed
 * error after the logon step"; PV-0727, PV-0308, R-DH-6): the code page in force first, a
 * plausibility check, then UTF-8, ISO 8859-1, UTF-16LE and UTF-16BE. Every text is invented (D15).
 */
describe("Server error text", () => {
  const waffle = "ZZ_WAFFLE: the waffle iron declines your logon, try syrup"
  /** Like the live error after the logon step (PV-0308): single-byte text with an odd byte count. */
  const pond = "Honk: the pond keeper has never met this duck, sorry."
  const fffd = "\u{FFFD}"

  // MARK: Which encoding

  /**
   * The live case (PV-0308): the screens declared 4110, and the error text after the logon step
   * was UTF-8 with an odd byte count. Read as UTF-16LE it was CJK-looking with a U+FFFD at the end;
   * read in the code page in force it is the text.
   */
  test("oddLengthUTF8InTheCodePageInForce", () => {
    const input = ascii(pond)
    assert.equal(input.length % 2, 1)
    const decoded = fromBody(cat(input, [0x0c]), CodePage.utf8)
    assert.equal(decoded.text, pond)
    assert.ok(decoded.encoding === "utf8" && !decoded.isGuessed)
    assert.deepEqual(decoded.notes, ["decoded as UTF-8 (code page in force)"])
    assert.ok(!decoded.hasOddByte && decoded.byteCount === input.length)
  })

  /** Non-ASCII UTF-8 in the code page in force. */
  test("nonASCIIUTF8InTheCodePageInForce", () => {
    const text = "Zürich duck 🦆 says grüezi: no logon without bread crumbs"
    const decoded = fromText(ascii(text), CodePage.utf8)
    assert.ok(decoded.text === text && !decoded.isGuessed)
  })

  /**
   * The same live bytes with UTF-16LE in force: odd, and CJK letters from printable ASCII, so the
   * reading is implausible and UTF-8 is chosen.
   */
  test("singleByteTextUnderUTF16InForceFallsBackToUTF8", () => {
    for (const text of [pond, pond + "!"]) {
      // odd and even byte counts
      const decoded = fromText(ascii(text), CodePage.utf16LittleEndian)
      assert.equal(decoded.text, text)
      assert.ok(decoded.encoding === "utf8" && decoded.isGuessed)
      assert.deepEqual(decoded.notes, ["decoded as UTF-8 (guessed)"])
    }
  })

  /**
   * Wireshark's reading (PV-0727): UTF-16LE text, as the fake server sends it by default. In force
   * before any declaration is CONNECT's code page (1100 for the reference identity, 0 for the
   * placeholder): the single-byte readings hold NULs, so UTF-16LE is chosen.
   */
  test("UTF-16LE text under a single-byte or unknown code page is guessed", () => {
    for (const codePage of [CodePage.latin1, CodePage.utf8, 0]) {
      const text = utf16LE(waffle)
      assert.equal(text.length, 114)
      const decoded = fromBody(cat(text, [0x0c]), codePage)
      assert.equal(decoded.text, waffle)
      assert.ok(decoded.encoding === "utf16LittleEndian" && decoded.isGuessed)
      assert.deepEqual(decoded.notes, ["decoded as UTF-16LE (guessed)"])
      assert.equal(decoded.byteCount, 114)
      assert.ok(!decoded.missingTerminator && !decoded.hasOddByte && decoded.byteOrderMark === undefined)
      assert.ok(decoded.invalidSequenceCount === 0 && decoded.controlCharacterCount === 0)
    }
  })

  test("utf16InTheCodePageInForce", () => {
    const le = fromText(utf16LE("Grüße vom Teich"), CodePage.utf16LittleEndian)
    assert.ok(le.text === "Grüße vom Teich" && le.encoding === "utf16LittleEndian" && !le.isGuessed)
    const be = fromText(utf16BE("Big-endian biscuits"), CodePage.utf16BigEndian)
    assert.ok(be.text === "Big-endian biscuits" && be.encoding === "utf16BigEndian" && !be.isGuessed)
    // Big-endian text with little-endian in force: the order is guessed.
    const swapped = fromText(utf16BE("Big-endian biscuits"), CodePage.utf16LittleEndian)
    assert.ok(swapped.text === "Big-endian biscuits" && swapped.encoding === "utf16BigEndian" && swapped.isGuessed)
  })

  /**
   * ISO 8859-1 in force (1100, the reference identity's CONNECT code page): plain ASCII and Latin-1
   * text stay in it; bytes that are valid UTF-8 with non-ASCII in them are UTF-8.
   */
  test("latin1InForce", () => {
    const plain = fromText(ascii(pond), CodePage.latin1)
    assert.ok(plain.text === pond && plain.encoding === "latin1" && !plain.isGuessed)
    const latin1 = fromText(TextEncoding.encode("latin1", "Grüße aus Zürich")!, CodePage.latin1)
    assert.ok(latin1.text === "Grüße aus Zürich" && latin1.encoding === "latin1" && !latin1.isGuessed)
    const utf8 = fromText(ascii("Grüße aus Zürich"), CodePage.latin1)
    assert.ok(utf8.text === "Grüße aus Zürich" && utf8.encoding === "utf8" && utf8.isGuessed)
  })

  /** With UTF-8 in force, bytes that are not UTF-8 fall back to ISO 8859-1. */
  test("invalidUTF8FallsBackToLatin1", () => {
    const input = TextEncoding.encode("latin1", "Entenstraße gesperrt")!
    const decoded = fromText(input, CodePage.utf8)
    assert.equal(decoded.text, "Entenstraße gesperrt")
    assert.ok(decoded.encoding === "latin1" && decoded.isGuessed)
    assert.equal(decoded.invalidSequenceCount, 0)
  })

  /** A code page Swooey does not know gives no reading: UTF-8 is the first guess. */
  test("unknownCodePageGuessesUTF8First", () => {
    const decoded = fromText(ascii(pond), 0)
    assert.ok(decoded.text === pond && decoded.encoding === "utf8" && decoded.isGuessed)
    assert.equal(decoded.codePage, 0)
  })

  /** When no reading is plausible, the least implausible wins, the code page in force on a tie. */
  test("nothingPlausibleKeepsTheLeastImplausible", () => {
    // One ESC in an otherwise clean UTF-8 text: every reading has at least one sign.
    const decoded = fromText(ascii("\u{1B}Quack"), CodePage.utf8)
    assert.ok(decoded.encoding === "utf8" && !decoded.isGuessed)
    assert.equal(decoded.text, fffd + "Quack")
    assert.equal(decoded.controlCharacterCount, 1)
  })

  // MARK: Layout

  /** R-DH-6: the text ends at the first 0x0C; items after it are not read. */
  test("itemsAfterTheTerminatorAreIgnored", () => {
    const body = cat(ascii("Quack."), [0x0c], [0x10, 0x06, 0x02, 0x00, 0x02, 0x5a, 0x5a], [0x0c])
    const decoded = fromBody(body, CodePage.utf8)
    assert.equal(decoded.text, "Quack.")
    assert.equal(decoded.byteCount, 6)
    assert.ok(!decoded.missingTerminator)
  })

  test("splitTextGivesTheSameResult", () => {
    const body = cat(utf16LE(waffle), [0x0c, 0x0c])
    const split = DiagErrorBody.split(body)
    assert.deepEqual(fromText(split.textRange.of(body).slice(), CodePage.latin1), fromBody(body, CodePage.latin1))
    assert.equal(fromText(split.textRange.of(body), CodePage.latin1).text, waffle)
  })

  test("emptyText", () => {
    const decoded = fromBody(bytes(0x0c), CodePage.utf8)
    assert.ok(decoded.text === "" && decoded.byteCount === 0 && !decoded.missingTerminator)
    assert.ok(!decoded.isGuessed)
    assert.equal(fromText(new Uint8Array(0), 0).text, "")
  })

  /** IMPL-DH-7 fails the split; the display decodes the whole body and says so. */
  test("missingTerminatorDecodesEverything", () => {
    const decoded = fromBody(ascii("No terminator, no toast"), CodePage.utf8)
    assert.equal(decoded.text, "No terminator, no toast")
    assert.ok(decoded.missingTerminator)
    assert.ok(fromBody(new Uint8Array(0), CodePage.utf8).missingTerminator)
  })

  /** An odd byte after UTF-16LE text: every reading is implausible (NULs, or the U+FFFD), and UTF-16LE is the least so. */
  test("oddByteAfterUTF16Text", () => {
    const decoded = fromBody(cat(utf16LE("Crumbs"), [0x21, 0x0c]), CodePage.utf16LittleEndian)
    assert.equal(decoded.text, "Crumbs" + fffd)
    assert.ok(decoded.hasOddByte && decoded.byteCount === 13)
    assert.ok(!decoded.isGuessed)
    assert.equal(decoded.invalidSequenceCount, 0)
  })

  test("littleEndianByteOrderMarkIsStripped", () => {
    const decoded = fromBody(cat([0xff, 0xfe], utf16LE("Pancakes pending"), [0x0c]), CodePage.utf8)
    assert.equal(decoded.text, "Pancakes pending")
    assert.ok(decoded.byteOrderMark === "littleEndian" && decoded.encoding === "utf16LittleEndian")
    assert.equal(decoded.byteCount, 34)
    // A mark alone.
    assert.equal(fromText(bytes(0xff, 0xfe), CodePage.utf16LittleEndian).text, "")
  })

  test("bigEndianByteOrderMarkPicksBigEndian", () => {
    const decoded = fromBody(cat([0xfe, 0xff], utf16BE("Big-endian biscuits"), [0x0c]), CodePage.utf16LittleEndian)
    assert.equal(decoded.text, "Big-endian biscuits")
    assert.ok(decoded.byteOrderMark === "bigEndian" && decoded.encoding === "utf16BigEndian")
  })

  test("nonASCIIAndSurrogatePairs", () => {
    const text = "Zürich duck 🦆 says grüezi"
    assert.equal(fromBody(cat(utf16LE(text), [0x0c]), CodePage.utf16LittleEndian).text, text)
  })

  test("invalidSequencesAreReplaced", () => {
    // UTF-16LE in force: "AB", a lone high surrogate, "CD", a lone low surrogate. Every reading is
    // implausible (big-endian by its swapped ASCII); the one in force is kept.
    const input = bytes(0x41, 0x00, 0x42, 0x00, 0x3d, 0xd8, 0x43, 0x00, 0x44, 0x00, 0x86, 0xde)
    const decoded = fromText(input, CodePage.utf16LittleEndian)
    assert.equal(decoded.text, "AB" + fffd + "CD" + fffd)
    assert.ok(decoded.invalidSequenceCount === 2 && decoded.encoding === "utf16LittleEndian" && !decoded.isGuessed)
    // Ill-formed UTF-8 in force, where ISO 8859-1 would show a C1 control instead.
    const utf8 = fromText(bytes(0x41, 0x85, 0x42), CodePage.utf8)
    assert.ok(utf8.text === "A" + fffd + "B" && utf8.invalidSequenceCount === 1 && utf8.encoding === "utf8")
  })

  /** An escape sequence from the server must not reach the owner's terminal as one. */
  test("controlCharactersAreReplaced", () => {
    const decoded = fromBody(cat(ascii("\u{1B}[31mRed alert: toast\u{7}\u{85}\n"), [0x0c]), CodePage.utf8)
    assert.equal(decoded.encoding, "utf8")
    assert.equal(decoded.text, fffd + "[31mRed alert: toast" + fffd + fffd + fffd)
    assert.equal(decoded.controlCharacterCount, 4)
    for (const character of decoded.text) {
      const scalar = character.codePointAt(0)!
      assert.ok(!(scalar < 0x20 || (scalar >= 0x7f && scalar <= 0x9f)))
    }
    // A tab and NUL are controls too, whatever the reading.
    assert.equal(fromText(bytes(0x09, 0x00, 0x00, 0x00), CodePage.utf16LittleEndian).controlCharacterCount, 2)
  })

  /**
   * R-DH-6 cuts at the first byte 0x0C even inside a code unit: U+010C is `0C 01` in little-endian.
   * Whether a real text can hold one is an open question of #8.
   */
  test("terminatorByteInsideACodeUnitCutsTheText", () => {
    const decoded = fromBody(cat(utf16LE("Mo\u{010C}ha"), [0x0c]), CodePage.utf16LittleEndian)
    assert.equal(decoded.text, "Mo")
    assert.equal(decoded.byteCount, 4)
  })

  /** The decoder's findings in words: the encoding first, then one note per flag, in a fixed order. */
  test("notesNameEveryFlag", () => {
    assert.deepEqual(fromBody(cat(ascii(pond), [0x0c]), CodePage.utf8).notes, ["decoded as UTF-8 (code page in force)"])
    assert.deepEqual(fromBody(ascii("No toast"), CodePage.latin1).notes, [
      "decoded as ISO 8859-1 (code page in force)",
      "no 0x0C terminator: the whole error body was decoded"
    ])
    assert.deepEqual(fromText(bytes(0xff, 0xfe, 0x41, 0x00), CodePage.utf16LittleEndian).notes, [
      "decoded as UTF-16LE (code page in force)",
      "a little-endian byte-order mark (FF FE) was stripped"
    ])
    assert.deepEqual(fromText(bytes(0xfe, 0xff, 0x00, 0x41), CodePage.utf16LittleEndian).notes, [
      "decoded as UTF-16BE (guessed)",
      "a big-endian byte-order mark (FE FF) was stripped"
    ])
    const everything = fromBody(bytes(0xff, 0xfe, 0x3d, 0xd8, 0x1b, 0x00, 0x09, 0x00, 0x41), CodePage.utf16LittleEndian)
    assert.deepEqual(everything.notes, [
      "decoded as UTF-16LE (code page in force)",
      "no 0x0C terminator: the whole error body was decoded",
      "a little-endian byte-order mark (FF FE) was stripped",
      "an odd number of bytes: the last one is shown as U+FFFD",
      "1 invalid byte sequence(s) shown as U+FFFD",
      "2 control character(s) shown as U+FFFD"
    ])
    assert.deepEqual(fromText(bytes(0x41, 0x85, 0x42), CodePage.utf8).notes, [
      "decoded as UTF-8 (code page in force)",
      "1 invalid byte sequence(s) shown as U+FFFD"
    ])
  })

  /** The text reaches no description: only `ServerErrorText.text` shows it (IMPL-DH-8). */
  test("descriptionsWithholdTheText", () => {
    const decoded = fromBody(utf16LE(waffle), CodePage.latin1)
    for (const view of [String(decoded), `${decoded}`, inspect(decoded), inspect({ nested: decoded }), JSON.stringify(decoded)])
      assert.ok(!view.includes("waffle"), view)
    assert.equal(
      decoded.description,
      "ServerErrorText(114 bytes, text withheld; decoded as UTF-16LE (guessed); no 0x0C terminator: the whole error body was decoded)"
    )
    assert.equal(fromText(bytes(0x41), CodePage.utf8).description, "ServerErrorText(1 bytes, text withheld; decoded as UTF-8 (code page in force))")
    assert.equal(decoded.debugDescription, decoded.description)
  })
})
