// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/VectorFileTests.swift (MIT): the tests of the vector
// harness in src/test/vectors.

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { hexByte, hexText } from "../../../diag/wire/index.js"
import { Expectations } from "../../vectors/expectations.js"
import { PENDING_KINDS } from "../../vectors/kinds.js"
import { loadVector, repositoryRoot, vectorFiles, vectorsDirectory } from "../../vectors/paths.js"
import { runVector } from "../../vectors/registry.js"
import { VectorFile, VectorParseError, hexByteToken, isValidKey } from "../../vectors/vectorFile.js"

const header = `# source: spec
# spec: docs/protocol/items.md#xmlblob
# provenance: PV-0100, PV-0105
# kind: items
# description: A test.
# derivation: By hand.`

/** The .vec parser and helpers of src/test/vectors (test/vectors/README.md, "File format"). */
describe("Vector file format", () => {
  test("parsesTheReadmeExample", () => {
    const text = `# source: spec
# spec: docs/protocol/items.md#xmlblob
# provenance: PV-0100, PV-0105, PV-0106, PV-0107
# kind: items
# description: A single XMLBLOB with a 4-byte value.
# derivation: Type byte 0x11, u32 BE length 4, value bytes arbitrary.
# expect.items: 1
# expect.item.1.type: xmlblob
# expect.item.1.offset: 5
# expect.item.1.length: 4
# expect.error: none
hex:
11                     # type XMLBLOB
00 00 00 04            # length 4, u32 BE
A1 B2 C3 D4            # value (opaque)
`
    const vector = VectorFile.parse(text, "example")
    assert.equal(vector.source, "spec")
    assert.equal(vector.spec, "docs/protocol/items.md#xmlblob")
    assert.deepEqual(vector.provenance, ["PV-0100", "PV-0105", "PV-0106", "PV-0107"])
    assert.equal(vector.kind, "items")
    assert.equal(vector.description, "A single XMLBLOB with a 4-byte value.")
    assert.ok(vector.derivation.startsWith("Type byte 0x11"))
    assert.deepEqual(vector.bytes, Uint8Array.of(0x11, 0, 0, 0, 4, 0xa1, 0xb2, 0xc3, 0xd4))
    assert.equal(vector.expectations.size, 5)
    assert.equal(vector.expectations.get("expect.item.1.type"), "xmlblob")
    assert.equal(vector.header[0]?.key, "source")
    // Swift runs the items runner here and expects no failure; the items kind waits for the
    // DiagCodec port (PENDING_KINDS), so until then the vector is skipped, never failed.
    assert.notEqual(runVector(vector, PENDING_KINDS).status, "failed")
  })

  test("emptyHexSectionAndLowercaseHex", () => {
    assert.deepEqual(VectorFile.parse(header + "\nhex:\n").bytes, new Uint8Array(0))
    assert.deepEqual(VectorFile.parse(header + "\nhex:").bytes, new Uint8Array(0))
    assert.deepEqual(VectorFile.parse(header + "\nhex:\n\tab cd # x\n\n  # only a comment\nEF").bytes, Uint8Array.of(0xab, 0xcd, 0xef))
  })

  const malformed: [string, string][] = [
    ["no hex line", "# source: spec"],
    ["CRLF", header.replaceAll("\n", "\r\n") + "\r\nhex:\r\n"],
    ["blank header line", "# source: spec\n\n" + header.split("\n").slice(1).join("\n") + "\nhex:\n"],
    ["free comment in header", header + "\n# a comment without colon\nhex:\n"],
    ["no space after hash", header + "\n#expect.items: 1\nhex:\n"],
    ["no space after colon", header + "\n# expect.items:1\nhex:\n"],
    ["empty value", header + "\n# expect.items: \nhex:\n"],
    ["uppercase key", header + "\n# Expect.items: 1\nhex:\n"],
    ["key starting with dot", header + "\n# .items: 1\nhex:\n"],
    ["unknown non-expect key", header + "\n# author: someone\nhex:\n"],
    ["duplicate key", header + "\n# kind: items\nhex:\n"],
    ["missing required key", header.replace("# derivation: By hand.", "# expect.items: 0") + "\nhex:\n"],
    ["hex line with trailing text", header + "\nhex: 00\n"],
    ["odd hex token", header + "\nhex:\n0\n"],
    ["long hex token", header + "\nhex:\n000\n"],
    ["non-hex token", header + "\nhex:\nZZ\n"],
    ["0x-prefixed token", header + "\nhex:\n0x11\n"]
  ]
  for (const [label, text] of malformed) {
    test(`rejectsMalformedFiles(${label})`, () => {
      assert.throws(() => VectorFile.parse(text, label), VectorParseError, label)
    })
  }

  test("errorMessagesNameFileAndLine", () => {
    assert.throws(
      () => VectorFile.parse(header + "\nhex:\nGG\n", "x.vec"),
      (error: unknown) => {
        assert.ok(error instanceof VectorParseError)
        assert.equal(error.line, 8)
        assert.equal(error.message, "x.vec:8: bad hex token 'GG'")
        return true
      }
    )
    assert.equal(new VectorParseError("p", undefined, "m").message, "p: m")
  })

  test("keyGrammar", () => {
    assert.ok(isValidKey("expect.frame.1.offset"))
    assert.ok(isValidKey("0a_b-c"))
    assert.ok(!isValidKey(""))
    assert.ok(!isValidKey("_a"))
    assert.ok(!isValidKey("a b"))
    assert.ok(!isValidKey("aB"))
  })

  test("hexText", () => {
    assert.equal(hexText([]), "none")
    assert.equal(hexText([0x4e, 0x0a, 0xff]), "4E 0A FF")
    // Swift's HexText.byte (`0x5A`) has no counterpart in the port; hexByte gives the two digits.
    assert.equal(hexByte(0x5a), "5A")
    assert.equal(hexByteToken("aF"), 0xaf)
    assert.equal(hexByteToken("g0"), undefined)
  })

  test("loadReportsUnreadableFiles", () => {
    assert.throws(() => VectorFile.load("/nonexistent/swooey/none.vec"), VectorParseError)
    assert.throws(() => loadVector("test/vectors/does-not-exist.vec"), VectorParseError)
  })

  test("repositoryDiscovery", () => {
    // (Swift's findRoot(from:) has no counterpart: repositoryRoot() searches from its own file.)
    const root = repositoryRoot()
    assert.equal(vectorsDirectory(), join(root, "test", "vectors"))
    const files = vectorFiles()
    assert.ok(files.length >= 51)
    assert.deepEqual(files, [...files].sort())
    assert.ok(files.every(f => f.startsWith("test/vectors/") && f.endsWith(".vec")))
  })
})

describe("Expectation reader", () => {
  test("typedValuesAndConsumption", () => {
    const expect = new Expectations(
      new Map(
        Object.entries({
          "expect.n": "12",
          "expect.b": "0x5A",
          "expect.h": "4E 49",
          "expect.none": "none",
          "expect.names": "EOC,CAS",
          "expect.s": "text",
          "expect.unused": "x"
        })
      )
    )
    assert.ok(expect.has("expect.n"))
    assert.equal(expect.int("expect.n"), 12)
    assert.equal(expect.byte("expect.b"), 0x5a)
    assert.deepEqual(expect.hex("expect.h"), Uint8Array.of(0x4e, 0x49))
    assert.deepEqual(expect.hex("expect.none"), new Uint8Array(0))
    assert.deepEqual(expect.names("expect.names"), ["EOC", "CAS"])
    assert.equal(expect.string("expect.s"), "text")
    assert.deepEqual(expect.problems, [])
    assert.deepEqual(expect.unconsumedKeys, ["expect.unused"])
    expect.consumeAll()
    assert.deepEqual(expect.unconsumedKeys, [])
  })

  test("noneNamesAndMissingKeys", () => {
    const expect = new Expectations(new Map([["expect.names", "none"]]))
    assert.deepEqual(expect.names("expect.names"), [])
    assert.equal(expect.int("expect.missing"), undefined)
    assert.equal(expect.string("expect.optional", false), undefined)
    assert.deepEqual(expect.problems, ["missing required key expect.missing"])
  })

  const malformedValues: [string, string][] = [
    ["expect.int", "-1"],
    ["expect.int", "1_000"],
    ["expect.int", "0x10"],
    ["expect.int", "99999999999999999999"],
    ["expect.byte", "5A"],
    ["expect.byte", "0x5a"],
    ["expect.byte", "0x5"],
    ["expect.byte", "0xABC"],
    ["expect.hex", "4E  49"],
    ["expect.hex", "4E,49"],
    ["expect.hex", "4"],
    ["expect.names", "EOC, CAS"],
    ["expect.names", "EOC,,CAS"]
  ]
  // Swift's `Int(text)` rejects a value beyond Int.max; Expectations.int rejects a value beyond
  // Number.MAX_SAFE_INTEGER.
  for (const [key, value] of malformedValues) {
    test(`malformedValuesAreProblems(${key}, ${value})`, () => {
      const expect = new Expectations(new Map([[key, value]]))
      switch (key) {
        case "expect.int":
          assert.equal(expect.int(key), undefined)
          break
        case "expect.byte":
          assert.equal(expect.byte(key), undefined)
          break
        case "expect.hex":
          assert.equal(expect.hex(key), undefined)
          break
        default:
          assert.equal(expect.names(key), undefined)
      }
      assert.equal(expect.problems.length, 1)
    })
  }
})
