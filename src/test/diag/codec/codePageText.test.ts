// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/CodePageTextTests.swift (MIT).

import assert from "node:assert/strict"
import { inspect } from "node:util"
import { describe, test } from "node:test"
import { CodePage, DyntText, DyntTextError, Secret, TextEncoding, secretTranscoded } from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, throwsInfo } from "../../support/codecTestSupport.js"
import { field2Content, rawAtom, walkAtoms } from "../../support/dyntTestSupport.js"

/** The code pages Swooey knows (session.md §6.4, PV-0130–PV-0134) and text in them. Texts are invented (D15). */
describe("Code pages: numbers, decoding and encoding", () => {
  const pond = "Grüße vom Ententeich ☕"

  const decode = (encoding: TextEncoding, input: ArrayLike<number>) => TextEncoding.decode(encoding, Uint8Array.from(input))
  const repair = (encoding: TextEncoding, input: ArrayLike<number>) => TextEncoding.decodeRepairing(encoding, Uint8Array.from(input))
  const isASCII = (input: ArrayLike<number>) => CodePage.isASCII(Uint8Array.from(input))
  const transcode = (encoding: TextEncoding, input: ArrayLike<number>, output: ByteWriter) =>
    TextEncoding.transcode(encoding, Uint8Array.from(input), output)

  /** A test secret's bytes (invented passwords only). */
  const secretBytes = (secret: Secret): Uint8Array => secret.withBytes(view => view.slice())

  test("numbersAndCharacterSets", () => {
    assert.equal(CodePage.utf8, 4110)
    assert.equal(CodePage.utf16BigEndian, 4102)
    assert.equal(CodePage.utf16LittleEndian, 4103)
    assert.equal(CodePage.latin1, 1100)
    assert.equal(DyntText.utf8CodePage, CodePage.utf8)
    assert.deepEqual(TextEncoding.allCases.map(TextEncoding.codePage), [4110, 4102, 4103, 1100])
    for (const encoding of TextEncoding.allCases) assert.equal(TextEncoding.fromCodePage(TextEncoding.codePage(encoding)), encoding)
    for (const unknown of [0, 1160, 4101, 4109, 4111, 8000, 0xffffffff]) assert.equal(TextEncoding.fromCodePage(unknown), undefined)
    assert.deepEqual(TextEncoding.allCases.map(TextEncoding.description), ["UTF-8", "UTF-16BE", "UTF-16LE", "ISO 8859-1"])
    assert.deepEqual(TextEncoding.allCases.map(TextEncoding.isASCIICompatible), [true, false, false, true])
  })

  test("utf8", () => {
    const encoded = ascii(pond)
    assert.equal(decode("utf8", encoded), pond)
    assert.deepEqual(TextEncoding.encode("utf8", pond), encoded)
    assert.equal(decode("utf8", [0xc3, 0x28]), undefined)
    assert.equal(repair("utf8", [0x41, 0xc3, 0x28]), "A\u{FFFD}(")
    assert.equal(repair("utf8", encoded), pond)
  })

  test("utf16BothByteOrders", () => {
    const little = TextEncoding.encode("utf16LittleEndian", pond)
    const big = TextEncoding.encode("utf16BigEndian", pond)
    assert.ok(little && big)
    assert.deepEqual(little.subarray(0, 4), bytes(0x47, 0x00, 0x72, 0x00))
    assert.deepEqual(big.subarray(0, 4), bytes(0x00, 0x47, 0x00, 0x72))
    assert.equal(little.length, pond.length * 2)
    assert.equal(decode("utf16LittleEndian", little), pond)
    assert.equal(decode("utf16BigEndian", big), pond)
    assert.equal(decode("utf16BigEndian", []), "")
    // An odd byte count, and an unpaired surrogate, are not UTF-16.
    assert.equal(decode("utf16LittleEndian", [0x41, 0x00, 0x42]), undefined)
    assert.equal(decode("utf16BigEndian", [0xd8, 0x00, 0x00, 0x41]), undefined)
    assert.equal(repair("utf16LittleEndian", [0x41, 0x00, 0x42]), "A\u{FFFD}")
    assert.equal(repair("utf16BigEndian", [0xd8, 0x00, 0x00, 0x41]), "\u{FFFD}A")
    assert.equal(repair("utf16BigEndian", [0x00, 0x41]), "A")
    // A character outside the Basic Multilingual Plane takes a surrogate pair.
    assert.deepEqual(TextEncoding.encode("utf16BigEndian", "🦆"), bytes(0xd8, 0x3e, 0xdd, 0x86))
    assert.equal(decode("utf16BigEndian", [0xd8, 0x3e, 0xdd, 0x86]), "🦆")
  })

  test("latin1", () => {
    const input = bytes(0x47, 0x72, 0xfc, 0xdf, 0x65, 0xff)
    assert.equal(decode("latin1", input), "Grüßeÿ")
    assert.equal(repair("latin1", input), "Grüßeÿ")
    assert.deepEqual(TextEncoding.encode("latin1", "Grüßeÿ"), input)
    assert.equal(TextEncoding.encode("latin1", "Taler €"), undefined, "€ is above U+00FF")
    const every = Uint8Array.from({ length: 256 }, (_, index) => index)
    assert.deepEqual(TextEncoding.encode("latin1", decode("latin1", every) ?? ""), every)
  })

  test("isASCII", () => {
    assert.ok(isASCII(ascii("ZZ_DUCK 0100")))
    assert.ok(isASCII([]))
    assert.ok(isASCII([0x7f]))
    assert.ok(!isASCII([0x41, 0x80]))
  })

  test("transcodeFromUTF8", () => {
    const source = ascii(pond)
    for (const encoding of ["utf8", "utf16BigEndian", "utf16LittleEndian"] as TextEncoding[]) {
      const output = new ByteWriter()
      assert.ok(transcode(encoding, source, output))
      assert.deepEqual(output.toBytes(), TextEncoding.encode(encoding, pond))
    }
    let latin = new ByteWriter()
    assert.ok(transcode("latin1", ascii("Grüße"), latin))
    assert.deepEqual(latin.toBytes(), bytes(0x47, 0x72, 0xfc, 0xdf, 0x65))
    latin = new ByteWriter()
    assert.ok(!transcode("latin1", ascii("Taler €"), latin))
    // Invalid UTF-8 fails in every encoding.
    for (const encoding of TextEncoding.allCases) assert.ok(!transcode(encoding, [0x41, 0xc3, 0x28], new ByteWriter()), encoding)
  })

  test("secretTranscoding", () => {
    const secret = new Secret(ascii("Schwan-ß"))
    const little = secretTranscoded(secret, "utf16LittleEndian")
    assert.ok(little)
    assert.deepEqual(secretBytes(little), TextEncoding.encode("utf16LittleEndian", "Schwan-ß"))
    const latin = secretTranscoded(secret, "latin1")
    assert.ok(latin)
    assert.deepEqual(secretBytes(latin), TextEncoding.encode("latin1", "Schwan-ß"))
    const same = secretTranscoded(secret, "utf8")
    assert.ok(same)
    assert.deepEqual(secretBytes(same), ascii("Schwan-ß"))
    assert.equal(secretTranscoded(new Secret(ascii("Taler €")), "latin1"), undefined)
    assert.equal(secretTranscoded(new Secret([0xff]), "utf16BigEndian"), undefined)
    // Swift's placeholder is "Secret(withheld)"; the port's is "Secret(redacted)" (docs/porting.md).
    assert.equal(`${little}`, "Secret(redacted)")
    assert.equal(inspect(little), "Secret(redacted)")
    assert.equal(JSON.stringify({ little }), '{"little":"Secret(redacted)"}')
  })

  test("dyntTextInEveryKnownCodePage", () => {
    for (const encoding of TextEncoding.allCases) {
      const text = TextEncoding.encode(encoding, "Entenstraße")
      assert.ok(text)
      const value = rawAtom(132, { content: field2Content(text) })
      const atom = walkAtoms(value).atoms[0]
      assert.ok(atom)
      assert.equal(DyntText.decode(atom, value, TextEncoding.codePage(encoding)), "Entenstraße")
      assert.equal(DyntText.decode(atom, value, encoding), "Entenstraße")
    }
  })

  test("dyntTextWithAnEncodingChecksLikeTheCodePageVariant", () => {
    const hidden = rawAtom(130, { content: field2Content(ascii("duckduckgoose")), attr: 0x02 })
    const password = walkAtoms(hidden).atoms[0]
    assert.ok(password)
    throwsInfo(() => DyntText.decode(password, hidden, "latin1"), DyntTextError, { kind: "passwordField" })

    const field = rawAtom(130, { content: field2Content(ascii("QUAK")) })
    const atom = walkAtoms(field).atoms[0]
    assert.ok(atom)
    throwsInfo(() => DyntText.decode(atom, field, "utf8", "functionCode"), DyntTextError, { kind: "noText" })
    throwsInfo(() => DyntText.decode(atom, field.slice(0, 10), "utf8"), DyntTextError, { kind: "outOfRange" })

    const odd = rawAtom(130, { content: field2Content(cat([0x41, 0x00, 0x42])) })
    const oddAtom = walkAtoms(odd).atoms[0]
    assert.ok(oddAtom)
    throwsInfo(() => DyntText.decode(oddAtom, odd, "utf16LittleEndian"), DyntTextError, { kind: "invalidText" })
    throwsInfo(() => DyntText.decode(oddAtom, odd, CodePage.utf16LittleEndian), DyntTextError, { kind: "invalidText" })
  })
})
