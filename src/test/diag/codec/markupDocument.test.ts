// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/MarkupDocumentTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ClientDataManager,
  MarkupDocument,
  MarkupError,
  type MarkupElement,
  type MarkupErrorReason,
  type MarkupNode
} from "../../../diag/codec/index.js"
import { ascii, bytes, cat, thrownInfo, throwsInfo } from "../../support/codecTestSupport.js"

function read(text: string): MarkupDocument {
  return MarkupDocument.read(ascii(text))
}

function element(node: MarkupNode | undefined): MarkupElement | undefined {
  return node?.kind === "element" ? node.value : undefined
}

function name(element: MarkupElement | undefined): string | undefined {
  return element === undefined ? undefined : new TextDecoder().decode(element.name)
}

/** Swift `Array(text.utf8).flatMap { [$0, 0] }` (`zeroFirst` false) or `{ [0, $0] }` (true). */
function widened(text: string, zeroFirst: boolean): Uint8Array {
  return Uint8Array.from(Array.from(ascii(text)).flatMap(byte => (zeroFirst ? [0, byte] : [byte, 0])))
}

describe("An XMLBLOB value read as a document for its structure", () => {
  /** Swooey's own bare client document: the declaration and one empty root element */
  test("bare", () => {
    const document = MarkupDocument.read(ClientDataManager.bareDocument)
    assert.equal(document.form, "singleByte")
    assert.deepEqual(
      document.declaration?.map(attribute => new TextDecoder().decode(attribute.name)),
      ["version", "encoding"]
    )
    assert.deepEqual(document.declaration?.[document.declaration.length - 1]?.value, ascii("sap*"))
    assert.ok(name(document.root) === "DATAMANAGER" && document.root?.children.length === 0)
  })

  /** nested elements, both quotes, self-closing tags, text, a comment and a CDATA section */
  test("nested", () => {
    const document = read(`<POND><!-- ducks --><NEST SIZE='2' KIND="reed"><DUCK NAME="Mel"/>quack<![CDATA[<honk>]]></NEST><EMPTY></EMPTY></POND>`)
    const pond = document.root
    assert.ok(pond !== undefined)
    assert.equal(document.declaration, undefined)
    assert.equal(pond.children.length, 3)
    assert.deepEqual(pond.children[0], { kind: "comment", length: 7 })
    const nest = element(pond.children[1])
    assert.ok(nest !== undefined)
    assert.deepEqual(nest.attribute("SIZE"), ascii("2"))
    assert.deepEqual(nest.attribute("KIND"), ascii("reed"))
    assert.equal(nest.attribute("COLOUR"), undefined)
    assert.equal(name(element(nest.children[0])), "DUCK")
    assert.deepEqual(nest.children[1], { kind: "text", value: ascii("quack") })
    assert.deepEqual(nest.children[2], { kind: "text", value: ascii("<honk>") })
    assert.equal(name(element(pond.children[2])), "EMPTY")
  })

  /** UTF-16 of either byte order is narrowed, one byte per character */
  test("wide", () => {
    const text = `<?xml version="1.0"?><POND DEPTH="3"/>`
    const little = MarkupDocument.read(widened(text, false))
    assert.equal(little.form, "utf16LittleEndian")
    assert.deepEqual(little.root?.attribute("DEPTH"), ascii("3"))
    const big = MarkupDocument.read(cat([0xfe, 0xff], widened(text, true)))
    assert.equal(big.form, "utf16BigEndian")
    assert.equal(name(big.root), "POND")
    // A character beyond one byte counts as non-ASCII.
    const swan = MarkupDocument.read(cat([0xff, 0xfe], widened('<A B="', false), [0x22, 0x21], widened('"/>', false)))
    assert.deepEqual(swan.root?.attribute("B"), bytes(0x80))
  })

  /** a value that is not a document says where and why */
  test("malformed", () => {
    const cases: [string, MarkupErrorReason][] = [
      ["<POND>", "unclosedElement"],
      ["<POND></NEST>", "mismatchedEnd"],
      ["<POND DEPTH=3/>", "quoteExpected"],
      ['<POND DEPTH="3"NAME="x"/>', "spaceExpected"],
      ["<POND DEPTH/>", "equalsExpected"],
      ["<POND/>quack", "textOutsideElement"],
      ['<POND DEPTH="<"/>', "lessThanInValue"],
      ["<POND", "unexpectedEnd"],
      ['<?xml version="1.0"><POND/>', "declarationEndExpected"],
      ["<!-- a comment that never ends", "unexpectedEnd"],
      ["< POND/>", "nameExpected"]
    ]
    for (const [text, reason] of cases) {
      const error = thrownInfo(() => read(text), MarkupError)
      assert.ok(error !== undefined, text)
      assert.equal(error?.reason, reason, `${text}: ${JSON.stringify(error)}`)
    }
    const deep = "<A>".repeat(MarkupDocument.maxDepth + 1) + "</A>".repeat(MarkupDocument.maxDepth + 1)
    throwsInfo(() => read(deep), MarkupError, { offset: MarkupDocument.maxDepth * 3 + 3, reason: "tooDeep" })
  })
})
