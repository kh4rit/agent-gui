// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/RFCTextTests.swift (MIT).

// The texts of an RFC item stream (docs/protocol/controls/rfc-tr.md §7.8, Readings R-CT-36 and
// R-CT-37, issue #150): the three encodings, the form of a text on the wire, the kind of a withheld
// text, the code-page descriptor `01 06`, what a report may say of a value, and the head of a
// stream in structure, with planted addresses, host names, users and client numbers that never show.
// Every value is invented; the addresses are of the documentation ranges (RFC 5737).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  RFCCodePageDescriptor,
  RFCHead,
  RFCTextEncoding,
  RFCTextForm,
  RFCTextKind,
  RFCValueDescription,
  byteRange
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat } from "../../support/codecTestSupport.js"
import { InventedFlushCall as Call } from "../../support/inventedFlushCall.js"
import { wideDescriptor } from "../../support/rfcTestSupport.js"

// MARK: The head

/*
 * Planted values that must never show: an address, a host name, a client number, a user, a
 * numeric user, and a binary address whose four bytes are digits.
 */
const address = "198.51.100.231"
const host = "puddle-7.pond.example"
const client = "867"
const user = "ZZMALLARD"
const numericUser = "4711"
const digitAddress = (): Uint8Array => bytes(0x35, 0x32, 0x30, 0x31)

/** A call head with the planted values, in `encoding`, then the function name and the end. */
function plantedCall(encoding: RFCTextEncoding): Uint8Array {
  const text = (value: string): Uint8Array => RFCTextEncoding.encode(encoding, ascii(value))
  return cat(
    Call.item(0x0101, [0x00, 0x42, 0x13, 0x07, 0, 0, 0, 1]),
    Call.item(0x0103, [0x00, 0x00, 0x0d, 0x0c]),
    Call.item(0x0106, wideDescriptor()),
    Call.item(0x0015, [0xc6, 0x33, 0x64, 0xe7]),
    Call.item(0x0007, text(address + " ")),
    Call.item(0x0018, text(address)),
    Call.item(0x0008, text(host)),
    Call.item(0x0011, text("3")),
    Call.item(0x0013, text("7890")),
    Call.item(0x0012, text("7890")),
    Call.item(0x0006, text("ZZDEST")),
    Call.item(0x0111, text(user)),
    Call.item(0x0114, text(client)),
    Call.item(0x0009, text(numericUser + "        ")),
    Call.item(0x0134, text(client)),
    Call.item(0x0102, text("OLE_FLUSH_CALL")),
    Call.item(0x0114, text(client)),
    [0xff, 0xff, 0x00, 0x00, 0xff, 0xff]
  )
}

/** Texts no head line may hold, in any scope. */
const leaks = [address, "198.51", "100.231", host, "puddle", "pond.example", client, user, "MALLARD", "ZZDEST", numericUser, "5201"]

describe("RFC texts: encodings, forms, kinds and the code-page descriptor (R-CT-36, R-CT-37)", () => {
  /** the three encodings: bytes per character, encoding, narrowing, and names with padding */
  test("encodings", () => {
    assert.ok(RFCTextEncoding.bytesPerCharacter("singleByte") === 1 && RFCTextEncoding.bytesPerCharacter("utf16BigEndian") === 2)
    assert.deepEqual(RFCTextEncoding.encode("utf16LittleEndian", ascii("VARS")), bytes(0x56, 0, 0x41, 0, 0x52, 0, 0x53, 0))
    assert.deepEqual(RFCTextEncoding.encode("utf16BigEndian", ascii("E")), bytes(0, 0x45))
    assert.deepEqual(RFCTextEncoding.encode("singleByte", ascii("E")), bytes(0x45))
    const spaces = new ByteWriter()
    RFCTextEncoding.appendSpaces("utf16LittleEndian", 2, spaces)
    RFCTextEncoding.appendSpaces("utf16LittleEndian", 0, spaces)
    assert.deepEqual(spaces.toBytes(), bytes(0x20, 0, 0x20, 0))
    const wide = bytes(0x41, 0x00, 0xe9, 0x00, 0x42, 0x30, 0x43)
    assert.deepEqual(
      RFCTextEncoding.narrow("utf16LittleEndian", wide),
      bytes(0x41, RFCTextEncoding.nonASCII, RFCTextEncoding.nonASCII),
      "é and a CJK unit are no ASCII; the odd last byte is left out"
    )
    assert.deepEqual(RFCTextEncoding.narrow("utf16BigEndian", bytes(0x00, 0x41, 0x00, 0x7f)), bytes(0x41, 0x7f))
    assert.deepEqual(RFCTextEncoding.narrow("singleByte", bytes(0xe9)), bytes(0xe9), "single-byte text comes back unchanged")

    const name = ascii("OLE_FLUSH_CALL")
    const reading = (value: Uint8Array): RFCTextEncoding | undefined => RFCTextEncoding.reading(value, byteRange(0, value.length), name)
    assert.equal(reading(name), "singleByte")
    assert.ok(reading(cat(name, [0x20, 0x20])) === "singleByte" && reading(cat(name, [0, 0, 0])) === "singleByte")
    assert.equal(reading(RFCTextEncoding.encode("utf16LittleEndian", name)), "utf16LittleEndian")
    assert.equal(reading(cat(RFCTextEncoding.encode("utf16LittleEndian", cat(name, [0x20])), [0, 0])), "utf16LittleEndian")
    assert.equal(reading(cat(RFCTextEncoding.encode("utf16BigEndian", name), [0, 0])), "utf16BigEndian")
    assert.equal(reading(cat(RFCTextEncoding.encode("utf16LittleEndian", name), [0])), undefined, "half a character")
    assert.ok(reading(cat(name, [0x58])) === undefined && reading(name.slice(0, name.length - 1)) === undefined)
    assert.equal(
      reading(cat(RFCTextEncoding.encode("utf16LittleEndian", name), [0x20, 0x30])),
      undefined,
      "a padding unit that is no space"
    )
  })

  /** the form of a text on the wire */
  test("forms", () => {
    const form = (value: Uint8Array): RFCTextForm | undefined => RFCTextForm.of(value)
    assert.equal(form(ascii("VARS")), "ascii")
    assert.equal(form(cat(ascii("VARS"), [0, 0])), "zeroPadded")
    assert.ok(form(bytes(0x56, 0, 0x41, 0)) === "utf16LittleEndian" && form(bytes(0x56, 0, 0x41)) === "utf16LittleEndian")
    assert.equal(form(bytes(0x56, 0, 0x41, 0, 0, 0, 0, 0)), "utf16LittleEndian", "UTF-16LE padded with zero characters")
    assert.equal(form(bytes(0, 0x56, 0, 0x41, 0, 0)), "utf16BigEndian")
    assert.ok(form(bytes(0x56, 0, 0, 0x41)) === "otherZeros" && form(bytes(0, 0x56, 0x41)) === "otherZeros")
    assert.ok(
      form(bytes()) === undefined &&
        form(bytes(0, 0)) === undefined &&
        form(bytes(0x41, 0x0a)) === undefined &&
        form(bytes(0x41, 0xc3)) === undefined
    )
    assert.ok(RFCTextForm.encoding("zeroPadded") === "singleByte" && RFCTextForm.encoding("ascii") === "singleByte")
    assert.ok(RFCTextForm.encoding("utf16BigEndian") === "utf16BigEndian" && RFCTextForm.encoding("otherZeros") === undefined)
    assert.deepEqual(RFCTextForm.characters(bytes(0x56, 0, 0x41, 0)), ascii("VA"))
  })

  /** the kind of a withheld text, never the text */
  test("kinds", () => {
    const kind = (text: string): RFCTextKind => RFCTextKind.of(ascii(text))
    assert.ok(kind("867") === "digits" && kind("4110") === "digits")
    assert.ok(kind("198.51.100.231") === "dottedIPv4" && kind("0.0.0.0") === "dottedIPv4")
    assert.ok(kind("198.51.100") !== "dottedIPv4" && kind("1234.1.1.1") !== "dottedIPv4" && kind("a.b.c.d") !== "dottedIPv4")
    assert.ok(kind("ZZMALLARD") === "upperCaseWord" && kind("ZZ_POND_7") === "upperCaseWord")
    assert.ok(kind("puddle-7.pond.example") === "hostName" && kind("Quackmore") === "hostName" && kind("POND-NEST-12") === "hostName")
    assert.ok(kind("a pond") === "mixed" && kind("pond_keeper") === "mixed" && kind("") === "mixed" && kind("-.-") === "mixed")
  })

  /** the code-page descriptor: its shape, Swooey's own, and its summary */
  test("codePageDescriptor", () => {
    const parsed = RFCCodePageDescriptor.of(wideDescriptor())
    assert.ok(parsed !== undefined)
    const descriptor = parsed
    assert.ok(descriptor.codePage === 4103 && !descriptor.asciiDigits && descriptor.bytesPerCharacter === 2 && descriptor.replacement === 0x23)
    assert.deepEqual(descriptor.unknown, bytes(0x00, 0x2a))
    assert.equal(descriptor.summary, 'code page 4103, 2 byte(s) per character, replacement character "#", bytes 4-5 hex 00 2A')
    const asciiDigits = cat(ascii("1100"), [0x01, 0x02, 1, 0, 0, 0, 0x3f])
    const parsedLatin = RFCCodePageDescriptor.of(asciiDigits)
    assert.ok(parsedLatin !== undefined)
    const latin = parsedLatin
    assert.ok(latin.codePage === 1100 && latin.asciiDigits && latin.summary.startsWith("code page 1100 (ASCII digits), 1 byte(s)"))
    for (const broken of [
      wideDescriptor().slice(0, 10),
      bytes(4, 1, 10, 3, 0, 0, 2, 0, 0, 0, 0x23),
      bytes(4, 1, 0, 3, 0, 0, 3, 0, 0, 0, 0x23),
      bytes(4, 1, 0, 3, 0, 0, 2, 0, 1, 0, 0x23),
      bytes(4, 1, 0, 3, 0, 0, 2, 0, 0, 0, 0x0a),
      bytes(4, 0x31, 0, 3, 0, 0, 2, 0, 0, 0, 0x23)
    ]) {
      assert.equal(RFCCodePageDescriptor.of(broken), undefined, `${Array.from(broken)}`)
    }
    assert.deepEqual(
      RFCCodePageDescriptor.replacing(wideDescriptor(), 4110, 1),
      bytes(4, 1, 1, 0, 0x00, 0x2a, 1, 0, 0, 0, 0x23),
      "the digits and byte 6 change, the rest is the call's"
    )
    assert.deepEqual(RFCCodePageDescriptor.replacing(asciiDigits, 4110, 1), cat(ascii("4110"), asciiDigits.slice(-7)))
    assert.equal(RFCCodePageDescriptor.replacing(wideDescriptor(), 10_000, 1), undefined)
    assert.equal(RFCCodePageDescriptor.replacing(ascii("QUACKQUACK1"), 4110, 1), undefined)
  })

  /**
   * what a report says of a value: four digits only in 00 13 and 00 12, never a possible address;
   * withheld texts by kind; the descriptor as R-CT-36 reads it
   */
  test("descriptions", () => {
    const describeValue = (value: Uint8Array, id?: number): string => RFCValueDescription.describe(value, id)
    const wide: RFCTextEncoding = "utf16LittleEndian"
    // The releases (PV-0798): four digits show, in any encoding; any other text there by its kind.
    assert.ok(describeValue(ascii("4110"), 0x0013) === '"4110"' && describeValue(ascii("7890"), 0x0012) === '"7890"')
    assert.equal(
      describeValue(RFCTextEncoding.encode(wide, ascii("4103")), 0x0013),
      '"4103" (text with a zero byte after each character (UTF-16LE-like))'
    )
    assert.equal(describeValue(ascii("DUCK"), 0x0012), "text, 4 bytes, not shown; kind: upper-case word", "a release item is a text, no address")
    assert.equal(describeValue(ascii("867"), 0x0013), "text, 3 bytes, not shown; kind: digits")
    // Anywhere else four digits are withheld: a numeric user, a company code, a plant, a year.
    const withheld = "text, 4 bytes, not shown (such a value may be an address)"
    assert.ok(describeValue(ascii("4110")) === withheld && describeValue(ascii("2026"), 0x0203) === withheld)
    assert.equal(describeValue(ascii("4711        "), 0x0111), "text, 12 bytes, not shown; kind: digits, then 8 spaces")
    assert.equal(
      describeValue(RFCTextEncoding.encode(wide, ascii("2026")), 0x0203),
      "text with a zero byte after each character (UTF-16LE-like), 8 bytes, not shown; kind: digits"
    )
    assert.equal(
      describeValue(bytes(0x31, 0, 0, 0x30, 0x30, 0, 0x30), 0x0203),
      "text with zero bytes, 7 bytes, not shown; kind: digits",
      "digits that zero bytes separate do not merge into four digits"
    )
    // Three or four bytes that are no small number may be an IPv4 address: no text and no kind.
    assert.equal(describeValue(bytes(0x35, 0x32, 0x30, 0x31), 0x0015), withheld, 'a binary address whose four bytes are digits is no "5201"')
    assert.ok(describeValue(ascii("O123")) === withheld && describeValue(ascii("X   ")) === withheld, "a handle or a flag of four bytes")
    assert.equal(describeValue(ascii("867")), "text, 3 bytes, not shown (such a value may be an address)")
    assert.equal(
      describeValue(RFCTextEncoding.encode(wide, ascii("12"))),
      "text with a zero byte after each character (UTF-16LE-like), 4 bytes, not shown (such a value may be an address)"
    )
    assert.equal(describeValue(cat(ascii("42"), [0, 0])), '"42" (text padded with zero bytes)', "a small number in either byte order is no address")
    assert.equal(describeValue(ascii("VARS")), '"VARS"', "a protocol identifier shows")
    assert.equal(describeValue(ascii("41100")), "text, 5 bytes, not shown; kind: digits")
    assert.equal(describeValue(ascii("198.51.100.231 ")), "text, 15 bytes, not shown; kind: dotted IPv4 shape, then 1 space")
    assert.equal(
      describeValue(wideDescriptor(), 0x0106),
      'binary, 11 bytes; as R-CT-36 reads it: code page 4103, 2 byte(s) per character, replacement character "#", bytes 4-5 hex 00 2A'
    )
    assert.equal(describeValue(ascii("\u{01}DUCKHEAD01"), 0x0106), "binary, 11 bytes; not a code-page descriptor as R-CT-36 reads one")
    assert.equal(describeValue(wideDescriptor()), "binary, 11 bytes", "only the item 01 06 is read as a descriptor")
    assert.ok(
      RFCValueDescription.isFourDigits("0000") && !RFCValueDescription.isFourDigits("4l10") && !RFCValueDescription.isFourDigits("٤١١٠")
    )
  })

  // MARK: The head

  /** the report's head: only the items R-CT-28 and R-CT-36 use are described; kinds, releases, relations and the encoding */
  for (const encoding of RFCTextEncoding.allCases) {
    test(`plantedHead(${encoding})`, () => {
      const call = plantedCall(encoding)
      const head = new RFCHead(call, "report")
      const width = RFCTextEncoding.bytesPerCharacter(encoding)
      assert.deepEqual(
        head.items.map(item => item.id),
        [0x0101, 0x0103, 0x0106, 0x0015, 0x0007, 0x0018, 0x0008, 0x0011, 0x0013, 0x0012, 0x0006, 0x0111, 0x0114, 0x0009, 0x0134]
      )
      assert.ok(head.encoding === encoding && head.functionNameLength === 14 * width)
      const lines = head.lines("  ")
      const text = [head.encodingText, ...lines].join("\n")
      assert.equal(head.encodingText, `text encoding ${RFCTextEncoding.rawValue(encoding)} (by its function name 01 02, ${14 * width} bytes)`)
      assert.ok(text.includes("not shown; kind: dotted IPv4 shape, then 1 space"))
      assert.ok(
        text.includes(`item 6: 00 18, length ${14 * width}; `) &&
          text.includes("the same characters as item 5 (00 07), padded or encoded differently")
      )
      assert.ok(text.includes(`item 11: 00 06, length ${6 * width}; `) && text.includes("kind: upper-case word"))
      assert.ok(text.includes(`item 9: 00 13, length ${4 * width}; "7890"`), "a release of four digits shows")
      assert.ok(text.includes(`item 10: 00 12, length ${4 * width}; "7890"`) && text.includes("; = item 9 (00 13)"))
      assert.ok(text.includes("as R-CT-36 reads it: code page 4103"))
      assert.ok(text.includes(`function name 01 02, length ${14 * width}; "OLE_FLUSH_CALL"`))
      // Every other head item by its id and length only: the binary 00 15, the host, the user and the client.
      assert.ok(lines.includes("  item 4: 00 15, length 4; value not described"))
      assert.ok(lines.includes(`  item 7: 00 08, length ${21 * width}; value not described`))
      assert.ok(lines.includes(`  item 12: 01 11, length ${9 * width}; value not described`))
      assert.ok(lines.includes(`  item 13: 01 14, length ${3 * width}; value not described`))
      assert.ok(lines.includes(`  item 14: 00 09, length ${12 * width}; value not described`))
      assert.ok(lines.includes(`  item 15: 01 34, length ${3 * width}; value not described`))
      for (const withheld of ["host-name shape", "kind: digits", "binary, 4 bytes", "(01 11)", "(01 14)", "(00 09)", "(00 08)"]) {
        assert.ok(!text.includes(withheld), `${withheld} in the report`)
      }
      for (const leak of leaks) {
        assert.ok(!text.includes(leak), `${leak} leaked`)
      }
    })
  }

  /** diagctl's head: every item but the user and client described; no planted value shows */
  for (const encoding of RFCTextEncoding.allCases) {
    test(`summaryHead(${encoding})`, () => {
      const call = plantedCall(encoding)
      const head = new RFCHead(call, "summary")
      const width = RFCTextEncoding.bytesPerCharacter(encoding)
      const lines = head.lines("")
      const text = lines.join("\n")
      assert.ok(lines.includes("item 4: 00 15, length 4; binary, 4 bytes, not shown (such a value may be an address)"))
      assert.ok(text.includes(`item 7: 00 08, length ${21 * width}; `) && text.includes("not shown; kind: host-name shape"))
      assert.ok(text.includes(`item 10: 00 12, length ${4 * width}; "7890"`) && text.includes("; = item 9 (00 13)"))
      for (const [index, id, characters] of [
        [12, "01 11", 9],
        [13, "01 14", 3],
        [14, "00 09", 12],
        [15, "01 34", 3]
      ] as const) {
        assert.ok(lines.includes(`item ${index}: ${id}, length ${characters * width}; value not described (the connection's user or client)`))
      }
      for (const withheld of ["kind: digits", "(01 11)", "(01 14)", "(00 09)"]) {
        assert.ok(!text.includes(withheld), `${withheld} in the summary`)
      }
      for (const leak of leaks) {
        assert.ok(!text.includes(leak), `${leak} leaked`)
      }
    })
  }

  /** a numeric user in 01 11 and 00 09 and a binary address of digit octets in 00 15 never show */
  for (const encoding of RFCTextEncoding.allCases) {
    test(`numericUser(${encoding})`, () => {
      const text = (value: string): Uint8Array => RFCTextEncoding.encode(encoding, ascii(value))
      const userText = text(numericUser + "        ")
      const call = cat(
        Call.item(0x0101, [0x00, 0x42, 0x13, 0x07, 0, 0, 0, 1]),
        Call.item(0x0015, digitAddress()),
        Call.item(0x0006, text("ZZDEST")),
        Call.item(0x0111, userText),
        Call.item(0x0114, text(client)),
        Call.item(0x0009, userText),
        Call.item(0x0134, text(client)),
        Call.item(0x0102, text("OLE_FLUSH_CALL")),
        [0xff, 0xff, 0x00, 0x00, 0xff, 0xff]
      )
      const report = new RFCHead(call, "report").lines("")
      const summary = new RFCHead(call, "summary").lines("")
      const width = RFCTextEncoding.bytesPerCharacter(encoding)
      assert.ok(report.includes("item 2: 00 15, length 4; value not described"))
      assert.ok(summary.includes("item 2: 00 15, length 4; text, 4 bytes, not shown (such a value may be an address)"))
      assert.ok(report.includes(`item 4: 01 11, length ${12 * width}; value not described`))
      assert.ok(summary.includes(`item 6: 00 09, length ${12 * width}; value not described (the connection's user or client)`))
      const joined = [...report, ...summary].join("\n")
      for (const leak of [numericUser, "5201", client, "= item", "the same characters", "kind: digits"]) {
        assert.ok(!joined.includes(leak), `${leak} leaked`)
      }
    })
  }

  /** a head without a function name: the encoding by its texts, or none */
  test("answerHead", () => {
    const wide: RFCTextEncoding = "utf16BigEndian"
    const answer = cat(
      Call.item(0x0101, [1, 2]),
      Call.item(0x0007, RFCTextEncoding.encode(wide, ascii("0.0.0.0"))),
      Call.item(0x0011, RFCTextEncoding.encode(wide, [0x45])),
      Call.item(0x0500, []),
      Call.item(0x0201, RFCTextEncoding.encode(wide, ascii("ZZ_QUACK"))),
      [0xff, 0xff, 0x00, 0x00, 0xff, 0xff]
    )
    const head = new RFCHead(answer, "summary")
    assert.ok(head.items.length === 4 && head.functionNameLength === undefined && head.encoding === "utf16BigEndian")
    assert.equal(head.encodingText, "text encoding UTF-16BE (by its 1 head text(s))")
    const mixed = cat(Call.item(0x0007, ascii("ZZ")), Call.item(0x0018, RFCTextEncoding.encode(wide, ascii("ZZ"))), [0xff, 0xff, 0x00, 0x00, 0xff, 0xff])
    assert.equal(new RFCHead(mixed, "summary").encoding, undefined)
    assert.ok(new RFCHead(mixed, "summary").encodingText.startsWith("text encoding not shown"))
    const padded = cat(Call.item(0x0102, cat(ascii("OLE_FLUSH_CALL"), [0, 0])), [0xff, 0xff, 0x00, 0x00, 0xff, 0xff])
    assert.equal(
      new RFCHead(padded, "report").encodingText,
      "text encoding single-byte, zero-padded (by its function name 01 02, 16 bytes)"
    )
  })
})
