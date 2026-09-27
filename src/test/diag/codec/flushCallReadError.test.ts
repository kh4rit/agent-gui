// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/FlushCallReadErrorTests.swift (MIT).

// Every requirement of Reading R-CT-28 that a call can fail, each with its reason (Reading R-CT-35,
// docs/protocol/controls/rfc-tr.md §7.8): the session then sends the empty RFC_TR_RET and the
// report names the reason, in structure only. The calls are invented (D15).
//
// Swift's `static let pond` is a value each test copies; the port builds a fresh pond call per
// test (`pond()`).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ControlHandleCounter,
  FlushCallAnswerBuilder,
  FlushCallReadError,
  RFCCallAssembler,
  RFCStreamSummary,
  type FlushCallReadErrorInfo,
  type FlushTable
} from "../../../diag/codec/index.js"
import { concatBytes } from "../../../diag/wire/index.js"
import { ascii } from "../../support/codecTestSupport.js"
import { InventedFlushCall, InventedFlushCallTable, type InventedFlushCallTable as Table } from "../../support/inventedFlushCall.js"
import { itemCount, readError } from "../../support/rfcTestSupport.js"
import { SeededGenerator } from "../../support/seededGenerator.js"

const Call = InventedFlushCall
const pond = (): InventedFlushCall => Call.pond()
const end = (): Uint8Array => Uint8Array.of(0xff, 0xff, 0x00, 0x00, 0xff, 0xff)

describe("Calls Swooey does not answer with its own answer (R-CT-35)", () => {
  /** The pond call reads. */
  test("reads", () => {
    assert.equal(readError(pond()), undefined)
  })

  /** No RFC item stream, no end item, a trailing pair that is not the id. */
  test("framing", () => {
    assert.deepEqual(readError(pond().bytes.slice(0, 10)), { kind: "notAnItemStream", error: { kind: "truncated", itemIndex: 1 } })
    const open = pond()
    open.endItem = undefined
    assert.deepEqual(readError(open), { kind: "noEndItem" })
    const bytes = pond().bytes
    bytes[13] = 0x02 // the first item's trailing pair: 01 02 instead of 01 01
    assert.deepEqual(readError(bytes), { kind: "trailingPair", item: 1 })
    const cutEnd = pond()
    cutEnd.endItem = Uint8Array.of(0xff, 0xff, 0x00, 0x00)
    assert.deepEqual(readError(cutEnd), { kind: "trailingPair", item: itemCount(pond()) }, "an end item without its trailing pair")
    const trailing = pond()
    trailing.afterEnd = Uint8Array.of(0x51)
    assert.equal(readError(trailing), undefined, "bytes after the call's end item are no requirement of R-CT-28")
  })

  /** Another function, or none. */
  test("function", () => {
    const feed = pond()
    feed.function = "ZZ_POND_FEED_THE_DUCKS"
    assert.deepEqual(readError(feed), { kind: "notAFlushCall" })
    const padded = pond()
    padded.function = "OLE_FLUSH_CALL  "
    assert.equal(readError(padded), undefined, "trailing spaces after the name are cut")
    const headOnly = concatBytes(Call.item(0x0101, ascii("QUACKRFC")), end())
    assert.deepEqual(readError(headOnly), { kind: "notAFlushCall" })
  })

  /** A head item missing or twice before the function name. */
  test("headItems", () => {
    const missing = pond()
    missing.head = missing.head.filter(entry => entry.id !== 0x0106)
    assert.deepEqual(readError(missing), { kind: "headItem", id: 0x0106, count: 0 })
    const twice = pond()
    twice.head.push({ id: 0x0007, value: ascii("QUACK-QUACK-002") })
    assert.deepEqual(readError(twice), { kind: "headItem", id: 0x0007, count: 2 })
  })

  /** Not exactly one export parameter besides IMPORT_XML, EXPORT_XML and SVARS. */
  test("parameters", () => {
    const none = pond()
    none.parameters = ["IMPORT_XML", "SVARS", "EXPORT_XML", "SVARS"]
    assert.deepEqual(readError(none), { kind: "parameterCount", value: 0 })
    const two = pond()
    two.parameters.push("ZZ_SECOND_QUACK")
    assert.deepEqual(readError(two), { kind: "parameterCount", value: 2 })
  })

  /** A table name without its table info. */
  test("tableInfo", () => {
    const lost = pond()
    lost.endItem = undefined
    lost.afterEnd = concatBytes(Call.item(0x0301, ascii("ZZ_LOST_TABLE")), Call.item(0x0017, []), end())
    assert.equal(readError(lost)?.kind, "tableInfo", `expected tableInfo: ${JSON.stringify(readError(lost))}`)
    const short = pond()
    short.endItem = undefined
    short.afterEnd = concatBytes(Call.item(0x0301, ascii("ZZ_SHORT_INFO")), Call.item(0x0302, [0, 0, 0, 1, 0, 0, 0]), end())
    assert.equal(readError(short)?.kind, "tableInfo", `expected tableInfo: ${JSON.stringify(readError(short))}`)
  })

  /** A table missing or twice, and a table of the wrong width. */
  test("tableCount", () => {
    for (const [name, table] of [
      ["VARS", "values"],
      ["VERBS", "verbs"],
      ["XML_DATA_STREAM", "xmlDataStream"]
    ] as [string, FlushTable][]) {
      const renamed = pond()
      renamed.table(name, candidate => {
        candidate.name = ascii("ZZ_RENAMED")
      })
      assert.deepEqual(readError(renamed), { kind: "tableCount", table, count: 0 }, name)
    }
    const noSlots = pond()
    noSlots.table("ZZ_DUCK_SLOTS", table => {
      table.width = 45
      table.rows = []
    })
    assert.deepEqual(readError(noSlots), { kind: "tableCount", table: "descriptors", count: 0 })
    const twoSlots = pond()
    twoSlots.tables.push(new InventedFlushCallTable("ZZ_MORE_SLOTS", 44))
    assert.deepEqual(readError(twoSlots), { kind: "tableCount", table: "descriptors", count: 2 })
    const narrow = pond()
    narrow.table("VARS", table => {
      table.width = 336
      table.rows = []
    })
    assert.deepEqual(readError(narrow), { kind: "tableWidth", table: "values", width: 336, expected: 337 })
    const shortVerbs = pond()
    shortVerbs.table("VERBS", table => {
      table.width = 52
      table.rows = []
    })
    assert.deepEqual(readError(shortVerbs), { kind: "tableWidth", table: "verbs", width: 52, expected: 53 })
    const xml = pond()
    xml.table("XML_DATA_STREAM", table => {
      table.rows = [new Uint8Array(255).fill(0x3c)]
    })
    assert.deepEqual(readError(xml), { kind: "xmlDataStreamRows", value: 1 })
  })

  /** Table content that does not decode to row width × row count bytes. */
  test("tableContent", () => {
    const broken = (change: (table: Table) => void, table = "ZZ_DUCK_SLOTS"): FlushCallReadErrorInfo | undefined => {
      const call = pond()
      call.table(table, change)
      return readError(call)
    }
    const rows = concatBytes(...Call.pondDescriptors)
    const good = Call.compressed(rows, 1)
    assert.deepEqual(
      broken(table => {
        table.content = concatBytes(Call.item(0x0305, [1, 2, 3, 4, 5]), Call.item(0x0337, []))
      }),
      { kind: "tableContent", table: "descriptors", problem: { kind: "reassembly", error: { kind: "badTableItem", id: 0x0337, offset: 11 } } }
    )
    assert.deepEqual(
      broken(table => {
        table.content = Call.contentItems(Uint8Array.of(1, 2, 3))
      }),
      { kind: "tableContent", table: "descriptors", problem: { kind: "prefix", error: { kind: "truncated", available: 3 } } }
    )
    const badMagic = good.slice()
    badMagic[13] = 0
    assert.deepEqual(
      broken(table => {
        table.content = Call.contentItems(badMagic)
      }),
      {
        kind: "tableContent",
        table: "descriptors",
        problem: { kind: "prefix", error: { kind: "header", error: { kind: "badMagic", first: 0, second: 0x9d } } }
      }
    )
    assert.deepEqual(
      broken(table => {
        table.declaredRows = rows.length / 44 + 1
      }),
      { kind: "tableContent", table: "descriptors", problem: { kind: "declaredLength", declared: rows.length, expected: rows.length + 44 } }
    )
    const decompression = broken(table => {
      table.content = Call.contentItems(good.slice(0, 20))
    })
    assert.ok(
      decompression?.kind === "tableContent" && decompression.table === "descriptors" && decompression.problem.kind === "decompression",
      "expected a decompression failure"
    )
    assert.deepEqual(
      broken(table => {
        table.raw = true
        table.declaredRows = 1
        table.content = Call.item(0x0304, new Uint8Array(45).fill(0x41))
      }),
      { kind: "tableContent", table: "descriptors", problem: { kind: "rawRowTooLong", row: 1 } }
    )
    assert.deepEqual(
      broken(table => {
        table.raw = true
        table.declaredRows = 20
      }),
      { kind: "tableContent", table: "descriptors", problem: { kind: "length", found: 19 * 44, expected: 20 * 44 } }
    )
    assert.deepEqual(
      broken(table => {
        table.raw = true
        table.declaredRows = 18
      }),
      { kind: "tableContent", table: "descriptors", problem: { kind: "length", found: 19 * 44, expected: 18 * 44 } },
      "more raw rows than declared"
    )
    assert.deepEqual(
      broken(table => {
        table.rows = []
        table.declaredRows = 2
      }),
      { kind: "tableContent", table: "descriptors", problem: { kind: "length", found: 0, expected: 88 } }
    )
    assert.deepEqual(
      broken(table => {
        table.rows = []
        table.declaredRows = 100_000
      }, "VARS"),
      { kind: "tableContent", table: "values", problem: { kind: "tooLarge", value: 33_700_000 } }
    )
  })

  /** Memory caps: a call longer than Swooey reads, and raw rows far beyond the declared count, are refused before they are kept. */
  test("memoryCaps", () => {
    const many = pond()
    many.table("VARS", table => {
      table.raw = true
      table.declaredRows = 1
      table.content = concatBytes(...Array.from({ length: 100_000 }, () => Call.item(0x0304, [])))
    })
    assert.deepEqual(
      readError(many),
      { kind: "tableContent", table: "values", problem: { kind: "length", found: 100_000 * 337, expected: 337 } },
      "100 000 empty raw rows for one declared row: refused by their count, before 33 MB of padded rows"
    )
    const pondBytes = pond().bytes
    const longest = pond()
    longest.afterEnd = new Uint8Array(FlushCallAnswerBuilder.maxCallBytes - pondBytes.length).fill(0x51)
    assert.equal(readError(longest), undefined, "a call of exactly the cap reads")
    longest.afterEnd = concatBytes(longest.afterEnd, [0x51])
    assert.deepEqual(readError(longest), { kind: "callTooLong", bytes: FlushCallAnswerBuilder.maxCallBytes + 1 })
    assert.ok(FlushCallAnswerBuilder.maxCallBytes === 4 * 1024 * 1024 && FlushCallAnswerBuilder.maxCallBytes <= RFCCallAssembler.maxCallBytes)
  })

  /** An answer longer than one APPL item carries. */
  test("answerTooLong", () => {
    const generator = new SeededGenerator(0x0b16_d0c4)
    const records = Array.from({ length: 200 }, () =>
      Call.value("", "000000000" + String.fromCharCode(...Array.from(generator.bytes(290), byte => 0x41 + (byte % 26))))
    )
    const call = new Call({ values: records })
    call.table("VARS", table => {
      table.raw = true
    })
    const reason = readError(call)
    assert.ok(reason?.kind === "answerTooLong", `expected answerTooLong: ${JSON.stringify(reason)}`)
    assert.ok(reason.bytes > 65_535)
  })

  /** Mutated calls never trap: each gets a reason, or an answer that is an RFC item stream within one APPL item. */
  test("robustness", () => {
    const generator = new SeededGenerator(0xf1_05_c4_11)
    const calls = [pond().bytes, Call.pond("long").bytes, new Call().bytes]
    let answered = 0
    for (let round = 0; round < 3_000; round++) {
      const mutated = generator.mutate(calls[round % calls.length])
      let answer
      try {
        answer = FlushCallAnswerBuilder.answer(mutated, new ControlHandleCounter())
      } catch (error) {
        if (error instanceof FlushCallReadError) continue
        throw error
      }
      answered += 1
      const summary = new RFCStreamSummary(answer.value)
      assert.ok(summary.reachedEnd && summary.trailingBytes === 0 && summary.mismatchedTrailers === 0 && summary.stop === undefined)
      assert.ok(answer.value.length <= FlushCallAnswerBuilder.maxAnswerBytes)
    }
    assert.ok(answered > 0, "some mutations leave a call that still reads")
  })

  /** Every reason reads in structure: numbers, ids and the protocol identifiers, never a value. */
  test("descriptions", () => {
    const reasons: [FlushCallReadErrorInfo, string][] = [
      [{ kind: "callTooLong", bytes: 5_000_000 }, "the call is 5000000 bytes, more than Swooey reads"],
      [{ kind: "notAnItemStream", error: { kind: "truncated", itemIndex: 3 } }, "the call is no RFC item stream: the walk stopped in item 3"],
      [{ kind: "noEndItem" }, "the call has no end item FF FF"],
      [{ kind: "trailingPair", item: 9 }, "item 9's trailing pair does not repeat its id"],
      [{ kind: "notAFlushCall" }, "the call is not OLE_FLUSH_CALL"],
      [{ kind: "headItem", id: 0x0106, count: 0 }, "the head has 0 item(s) 01 06, not one"],
      [{ kind: "parameterCount", value: 2 }, "the call names 2 export parameter(s) besides IMPORT_XML, EXPORT_XML and SVARS, not one"],
      [{ kind: "tableInfo", item: 40 }, "table name item 40 is not followed by an 8-byte table info"],
      [{ kind: "tableCount", table: "descriptors", count: 2 }, "the call has 2 of the 44-wide descriptor table, not one"],
      [{ kind: "tableWidth", table: "verbs", width: 52, expected: 53 }, "VERBS is 52 bytes wide, not 53"],
      [
        { kind: "mixedEncoding", item: 40, id: 0x0205, form: "ascii", expected: "utf16LittleEndian" },
        "the call mixes text encodings: item 40 (02 05) is ASCII text, the function name UTF-16LE"
      ],
      [{ kind: "tableContent", table: "values", problem: { kind: "rawRowSplitsACharacter", row: 3 } }, "VARS does not decode: raw row 3 ends inside a character"],
      [{ kind: "xmlDataStreamRows", value: 1 }, "XML_DATA_STREAM carries 1 row(s), whose answer is not known"],
      [{ kind: "answerTooLong", bytes: 70_000 }, "the answer would be 70000 bytes, more than one APPL item carries"],
      [{ kind: "encoding", value: "x" }, "the answer could not be encoded: x"],
      [
        { kind: "tableContent", table: "values", problem: { kind: "reassembly", error: { kind: "badTableItem", id: 0x0337, offset: 1 } } },
        "VARS does not decode: an item 03 37 inside its content"
      ],
      [
        { kind: "tableContent", table: "values", problem: { kind: "reassembly", error: { kind: "truncated", offset: 1 } } },
        "VARS does not decode: its content is cut short"
      ],
      [
        { kind: "tableContent", table: "values", problem: { kind: "prefix", error: { kind: "truncated", available: 3 } } },
        "VARS does not decode: its content is 3 bytes, shorter than the compressed-table prefix"
      ],
      [
        { kind: "tableContent", table: "values", problem: { kind: "declaredLength", declared: 5, expected: 6 } },
        "VARS does not decode: its compression header declares 5 bytes, not 6"
      ],
      [{ kind: "tableContent", table: "values", problem: { kind: "rawRowTooLong", row: 2 } }, "VARS does not decode: raw row 2 is longer than the row width"],
      [{ kind: "tableContent", table: "values", problem: { kind: "length", found: 1, expected: 2 } }, "VARS does not decode: 1 bytes of rows, not 2"],
      [{ kind: "tableContent", table: "values", problem: { kind: "tooLarge", value: 9 } }, "VARS does not decode: 9 bytes of rows, more than Swooey reads"]
    ]
    for (const [reason, text] of reasons) {
      assert.equal(new FlushCallReadError(reason).description, text)
      assert.equal(FlushCallReadError.describe(reason), text)
    }
    assert.ok(
      FlushCallReadError.describe({
        kind: "tableContent",
        table: "verbs",
        problem: { kind: "prefix", error: { kind: "header", error: { kind: "badMagic", first: 0, second: 1 } } }
      }).startsWith("VERBS does not decode: its compression header does not read (")
    )
    assert.ok(
      FlushCallReadError.describe({ kind: "tableContent", table: "verbs", problem: { kind: "decompression", error: { kind: "dataTruncated" } } }).startsWith(
        "VERBS does not decode: its data does not decompress ("
      )
    )
  })
})
