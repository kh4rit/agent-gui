// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/FlushAnswerHeadTests.swift (MIT).

// The head items SAP GUI fills with values of its own (docs/protocol/controls/rfc-tr.md §7.8,
// Reading R-CT-36): Swooey's own code-page descriptor in `01 06`, its own address text in `00 07`
// and `00 18`, or the call's values; each text in the call's encoding (R-CT-37). And the calls
// R-CT-37 does not read: mixed encodings, and a raw row that ends inside a character. The calls
// are invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  CodePage,
  ControlHandleCounter,
  FlushAnswerHead,
  FlushCallAnswerBuilder,
  FlushCallReadError,
  RFCTextEncoding,
  type FlushAnswerSummary
} from "../../../diag/codec/index.js"
import { concatBytes } from "../../../diag/wire/index.js"
import { ascii } from "../../support/codecTestSupport.js"
import { InventedFlushCall, type InventedFlushCallText } from "../../support/inventedFlushCall.js"
import { decodeAnswer, flushHeadIDs, readError, wideDescriptor } from "../../support/rfcTestSupport.js"

const Call = InventedFlushCall

/** The pond call with `01 06` in the descriptor's shape. */
function pond(text: InventedFlushCallText = "singleByte", descriptor: Uint8Array = wideDescriptor()): InventedFlushCall {
  const call = Call.pond()
  call.text = text
  const entry = call.head.find(item => item.id === 0x0106)
  if (entry !== undefined) entry.value = descriptor
  return call
}

function head(call: InventedFlushCall, own: FlushAnswerHead): { values: Uint8Array[]; summary: FlushAnswerSummary } {
  const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter(), own)
  const decoded = decodeAnswer(answer.value)
  return { values: decoded.values.slice(0, 11), summary: answer.summary }
}

describe("The answer's head: Swooey's own values (R-CT-36) and the call's encoding (R-CT-37)", () => {
  /** 01 06: Swooey's code page and bytes per character in the call's descriptor; the rest echoed. */
  test("ownCodePage", () => {
    const call = pond()
    const latin = head(call, new FlushAnswerHead({ codePage: 1100 }))
    assert.deepEqual(latin.values[2], Uint8Array.of(1, 1, 0, 0, 0x00, 0x2a, 1, 0, 0, 0, 0x23))
    const utf8 = head(call, new FlushAnswerHead({ codePage: CodePage.utf8 }))
    assert.deepEqual(utf8.values[2], Uint8Array.of(4, 1, 1, 0, 0x00, 0x2a, 1, 0, 0, 0, 0x23), "UTF-8: one byte per character at least")
    const wide = head(call, new FlushAnswerHead({ codePage: CodePage.utf16LittleEndian }))
    assert.deepEqual(wide.values[2], wideDescriptor(), "4103 and 2 bytes per character: the call's own descriptor")
    flushHeadIDs.forEach((id, index) => {
      if ([0x0007, 0x0018, 0x0013, 0x0012].includes(id)) assert.deepEqual(utf8.values[index], call.headValue(id), `${id} echoed`)
    })
    assert.ok(utf8.summary.headNotes.length === 0)
    assert.deepEqual(utf8.summary.ownHeadIDs, [0x0106, 0x0011])
    assert.ok(utf8.summary.description.endsWith("; texts single-byte; own head items 01 06, 00 11 (R-CT-36)"))
    const lines = utf8.summary.headLines("")
    assert.ok(
      lines.includes(
        "item 3: 01 06, length 11, Swooey's own; binary, 11 bytes; as R-CT-36 reads it: code page 4110, " +
          '1 byte(s) per character, replacement character "#", bytes 4-5 hex 00 2A'
      )
    )
    assert.ok(lines.includes('item 6: 00 11, length 1, Swooey\'s own; "E"'))
    assert.ok(lines.includes("item 10: 00 17, length 0, empty; empty") && lines.some(line => line.startsWith("item 4: 00 07, length 15, the call's; ")))
    for (const leak of ["QUACK", "POND", "DUCK", "MOAT", "WADDLE"]) assert.ok(!lines.join("").includes(leak), leak)
  })

  /** 01 06 that is no descriptor, or a code page of five digits: the call's value, with a note. */
  test("descriptorEchoed", () => {
    const odd = head(Call.pond(), new FlushAnswerHead({ codePage: 4110 }))
    assert.deepEqual(odd.values[2], Call.pond().headValue(0x0106))
    assert.deepEqual(odd.summary.ownHeadIDs, [0x0011])
    assert.deepEqual(odd.summary.headNotes, [
      "01 06: the call's value is no code-page descriptor as R-CT-36 reads one, or code page 4110 has more than four digits; the call's value went out"
    ])
    const oddLines = odd.summary.headLines("  ")
    assert.equal(oddLines[oddLines.length - 1], "  note: " + odd.summary.headNotes[0])
    const long = head(pond(), new FlushAnswerHead({ codePage: 41_100 }))
    assert.ok(long.summary.headNotes.length === 1)
    assert.deepEqual(long.values[2], wideDescriptor())
    const echo = head(pond(), FlushAnswerHead.echo)
    assert.deepEqual(echo.values[2], wideDescriptor())
    assert.ok(echo.summary.headNotes.length === 0)
    assert.deepEqual(echo.summary.ownHeadIDs, [0x0011])
  })

  /** 00 07 and 00 18: the unspecified address, 00 07 padded to 15 characters, in the call's encoding. */
  for (const text of ["singleByte", "utf16LittleEndian", "utf16BigEndian"] as InventedFlushCallText[]) {
    test(`ownAddress(${text})`, () => {
      const call = pond(text)
      const own = head(call, new FlushAnswerHead({ codePage: 4110, ownAddress: true }))
      assert.deepEqual(own.values[3], call.encoded(ascii("0.0.0.0        ")))
      assert.deepEqual(own.values[4], call.encoded(ascii("0.0.0.0")))
      assert.deepEqual(own.values[5], call.encoded(ascii("E")))
      assert.deepEqual(own.values[2], Uint8Array.of(4, 1, 1, 0, 0x00, 0x2a, 1, 0, 0, 0, 0x23), "binary: the same in every encoding")
      assert.deepEqual(own.values[6], call.sentHeadValue(0x0013))
      assert.deepEqual(own.values[7], call.sentHeadValue(0x0012))
      assert.deepEqual(own.values[8], call.sentHeadValue(0x0006))
      assert.deepEqual(own.summary.ownHeadIDs, [0x0106, 0x0007, 0x0018, 0x0011])
      const lines = own.summary.headLines("").join("\n")
      assert.ok(
        lines.includes(`item 4: 00 07, length ${15 * call.bytesPerCharacter}, Swooey's own; `) && lines.includes("kind: dotted IPv4 shape, then 8 spaces")
      )
      assert.ok(lines.includes("the same characters as item 4 (00 07), padded or encoded differently"))
      assert.ok(
        FlushAnswerHead.bytesPerCharacter(CodePage.utf16BigEndian) === 2 &&
          FlushAnswerHead.bytesPerCharacter(1100) === 1 &&
          FlushAnswerHead.bytesPerCharacter(9999) === 1
      )
    })
  }

  /** Names padded with zero bytes read as their names. */
  test("paddedNames", () => {
    const call = Call.pond()
    call.parameters = ["IMPORT_XML\u{0}\u{0}", "SVARS  ", "ZZ_QUACK_REPORT", "EXPORT_XML", "SVARS\u{0}"]
    call.table("VARS", table => {
      table.name = concatBytes(ascii("VARS"), [0, 0, 0])
    })
    call.table("VERBS", table => {
      table.name = concatBytes(ascii("VERBS"), [0x20])
    })
    const answer = FlushCallAnswerBuilder.answer(call.bytes, new ControlHandleCounter())
    const plain = FlushCallAnswerBuilder.answer(Call.pond().bytes, new ControlHandleCounter())
    assert.ok(answer.summary.recordsKept === plain.summary.recordsKept && answer.summary.descriptorRowsKept === plain.summary.descriptorRowsKept)
    assert.equal(answer.summary.recordsWithHandle, 3)
    assert.deepEqual(
      answer.summary.tables.map(table => table.table),
      ["descriptors", "values", "xmlDataStream"]
    )
  })

  /** A call that mixes encodings, or whose raw row ends inside a character, gets R-CT-35 with the reason. */
  test("unreadable", () => {
    const mixed = Call.pond()
    mixed.functionBytes = RFCTextEncoding.encode("utf16LittleEndian", ascii("OLE_FLUSH_CALL"))
    const mixedReason = readError(mixed)
    assert.ok(
      mixedReason?.kind === "mixedEncoding" && mixedReason.id === 0x0205 && mixedReason.form === "ascii" && mixedReason.expected === "utf16LittleEndian",
      `expected mixedEncoding: ${JSON.stringify(mixedReason)}`
    )
    const wideNameOnly = pond("utf16BigEndian")
    wideNameOnly.functionBytes = concatBytes(ascii("OLE_FLUSH_CALL"), [0, 0])
    const wideReason = readError(wideNameOnly)
    assert.ok(
      wideReason?.kind === "mixedEncoding" && wideReason.id === 0x0205 && wideReason.form === "utf16BigEndian" && wideReason.expected === "singleByte",
      `expected mixedEncoding: ${JSON.stringify(wideReason)}`
    )
    const split = pond("utf16LittleEndian")
    split.table("ZZ_DUCK_SLOTS", table => {
      table.raw = true
      table.declaredRows = 1
      table.content = Call.item(0x0304, [0x31, 0x00, 0x20])
    })
    assert.deepEqual(readError(split), { kind: "tableContent", table: "descriptors", problem: { kind: "rawRowSplitsACharacter", row: 1 } })
    const narrowValues = pond("utf16LittleEndian")
    narrowValues.table("VARS", table => {
      table.rows = []
      table.declaredRows = 0
    })
    assert.equal(readError(narrowValues.bytes), undefined, "an empty VARS 674 wide reads")
    assert.equal(
      new FlushCallReadError({ kind: "mixedEncoding", item: 9, id: 0x0301, form: "zeroPadded", expected: "utf16BigEndian" }).description,
      "the call mixes text encodings: item 9 (03 01) is zero-padded text, the function name UTF-16BE"
    )
  })

  /** The one-line summary names the encoding and Swooey's own head items. */
  test("summaryLine", () => {
    const answer = FlushCallAnswerBuilder.answer(
      pond("utf16LittleEndian").bytes,
      new ControlHandleCounter(),
      new FlushAnswerHead({ codePage: 4110, ownAddress: true })
    )
    assert.equal(answer.summary.textEncoding, "utf16LittleEndian")
    assert.ok(answer.summary.description.endsWith("; texts UTF-16LE; own head items 01 06, 00 07, 00 18, 00 11 (R-CT-36)"))
    assert.equal(answer.summary.head.length, 11)
  })
})
