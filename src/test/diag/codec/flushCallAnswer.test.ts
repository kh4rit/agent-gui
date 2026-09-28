// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/FlushCallAnswerTests.swift (MIT).

// Swooey's answer to a complete OLE_FLUSH_CALL (docs/protocol/controls/rfc-tr.md §7.8,
// IMPL-CT-14): the call reader of Reading R-CT-28, the head (R-CT-29), the parameter (R-CT-30), the
// tables and their content (R-CT-31), the descriptor rows (R-CT-32), the value records (R-CT-33),
// the results and handles (R-CT-34), and every reason a call does not read (R-CT-35). The calls
// are invented (D15) and written by the tests' own framing (InventedFlushCall); the answers are
// read back with the existing decoders only.
//
// The Swift suite's static helpers (decode, answer, headIDs, info, expectedValues) are in
// src/test/support/rfcTestSupport.ts, which the other flush-call tests share.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import { AutomationValueKind, ControlHandleCounter, FlushAnswerSummary } from "../../../diag/codec/index.js"
import { concatBytes } from "../../../diag/wire/index.js"
import { ascii } from "../../support/codecTestSupport.js"
import { InventedFlushCall, type InventedFlushCallForm } from "../../support/inventedFlushCall.js"
import { answerTo, decodeAnswer, expectedPondValues, flushHeadIDs, tableInfo } from "../../support/rfcTestSupport.js"

type Call = InventedFlushCall
const Call = InventedFlushCall

/** The pond call with its verb records renamed to `name`, flags kept (Swift's `extension InventedFlushCall`). */
function renameVerbs(call: Call, name: string): void {
  call.table("VERBS", table => {
    table.rows = table.rows.map(row => concatBytes(row.subarray(0, 10), Call.padded(ascii(name), 42), [row[52]]))
  })
}

const spaces = (count: number): Uint8Array => new Uint8Array(count).fill(0x20)

describe("The answer to an OLE_FLUSH_CALL (R-CT-28 to R-CT-35)", () => {
  // MARK: The answer's items

  /** Long and short form: the head, the parameter, three tables in the call's order and the end item, nothing else. */
  for (const form of ["long", "short"] as InventedFlushCallForm[]) {
    test(`itemOrder(${form})`, () => {
      const call = Call.pond(form)
      const answer = answerTo(call)
      const decoded = decodeAnswer(answer.value)
      const start = decoded.ids.indexOf(0x0301)
      const rest = start < 0 ? [] : decoded.ids.slice(start)
      const end = rest.indexOf(0xffff)
      const tables = end < 0 ? rest : rest.slice(0, end)
      assert.deepEqual(decoded.ids.slice(0, 13), [...flushHeadIDs, 0x0201, 0x0203])
      assert.ok(decoded.ids[decoded.ids.length - 1] === 0xffff && decoded.ids.length === 13 + tables.length + 1)
      assert.ok(tables.filter(id => id === 0x0301).length === 3 && tables.filter(id => id === 0x0302).length === 3)
      assert.ok(tables.every(id => [0x0301, 0x0302, 0x0305, 0x0306].includes(id)))
      assert.deepEqual(
        decoded.tables.map(table => new TextDecoder().decode(table.name)),
        ["ZZ_DUCK_SLOTS", "VARS", "XML_DATA_STREAM"],
        "the call's order, never the other three"
      )
      for (const id of [0x0102, 0x0205, 0x0213, 0x0161, 0x0015, 0x0127, 0x0020, 0x0021, 0x0008, 0x0130, 0x0136, 0x0502, 0x0512, 0x3c05])
        assert.ok(!decoded.ids.includes(id), `no ${id} in the answer`)
      assert.deepEqual(answer.value.slice(-6), Uint8Array.of(0xff, 0xff, 0x00, 0x00, 0xff, 0xff))
      assert.ok(answer.summary.answerBytes === answer.value.length && answer.summary.answerItems === decoded.ids.length)
    })
  }

  /** The head: the eight items echoed byte for byte, E, two empty items; the same for both forms (R-CT-29). */
  test("head", () => {
    const long = decodeAnswer(answerTo(Call.pond("long")).value)
    const short = decodeAnswer(answerTo(Call.pond("short")).value)
    const call = Call.pond()
    flushHeadIDs.forEach((id, index) => {
      switch (id) {
        case 0x0011:
          assert.deepEqual(long.values[index], ascii("E"), "E, where the call has 3")
          break
        case 0x0017:
        case 0x0500:
          assert.equal(long.values[index].length, 0)
          break
        default:
          assert.deepEqual(long.values[index], call.headValue(id), `${id} echoed`)
      }
    })
    assert.deepEqual(long.values.slice(0, 11), short.values.slice(0, 11), "the same head after either form")
  })

  /** The parameter: the call's one other export parameter, byte for byte, and 256 spaces; never EXPORT_XML (R-CT-30). */
  test("parameter", () => {
    const call = Call.pond()
    renameVerbs(call, "RegisterEvent")
    const decoded = decodeAnswer(answerTo(call).value)
    assert.deepEqual(decoded.values[11], ascii("ZZ_QUACK_REPORT"))
    assert.deepEqual(decoded.values[12], spaces(256))
    const names = ["EXPORT_XML", "IMPORT_XML", "SVARS"].map(name => new TextDecoder().decode(ascii(name)))
    assert.ok(
      decoded.values.every(value => !names.includes(new TextDecoder().decode(value))),
      "a call with an event-registration verb gets no EXPORT_XML either"
    )
    assert.notEqual(decoded.table("XML_DATA_STREAM"), undefined)
  })

  /** The tables: the call's 03 01 and 03 02 bytes, the call's tag, no content for 0 rows (R-CT-31). */
  test("tables", () => {
    const call = Call.pond()
    call.table("VARS", table => {
      table.tag = 0x4455_434b
    })
    const decoded = decodeAnswer(answerTo(call).value)
    const descriptors = decoded.table("ZZ_DUCK_SLOTS")
    assert.ok(descriptors !== undefined)
    assert.ok(descriptors.tag === 0x5155_4143 && !descriptors.raw)
    assert.deepEqual(descriptors.info, tableInfo(44, Call.pondDescriptors.length))
    const values = decoded.table("VARS")
    assert.ok(values !== undefined)
    assert.deepEqual(values.info, tableInfo(337, Call.pondValues.length))
    assert.equal(values.tag, 0x4455_434b)
    const xml = decoded.table("XML_DATA_STREAM")
    assert.ok(xml !== undefined)
    assert.deepEqual(xml.info, tableInfo(255, 0))
    assert.ok(xml.rows.length === 0 && xml.tag === undefined)
    assert.equal(decoded.ids.indexOf(0xffff), decoded.ids.lastIndexOf(0x0302) + 1, "no content after XML_DATA_STREAM's info")
  })

  // MARK: Rows and records

  /** descriptor rows: inputs blank, object result types corrected, other rows kept (R-CT-32) */
  test("descriptorRows", () => {
    const answer = answerTo(Call.pond())
    const table = decodeAnswer(answer.value).table("ZZ_DUCK_SLOTS")
    assert.ok(table !== undefined)
    const blank = new Set([1, 3, 4, 6, 9, 11, 13, 14, 16, 18])
    Call.pondDescriptors.forEach((call, index) => {
      const row = table.rows.slice(index * 44, (index + 1) * 44)
      let expected: Uint8Array
      switch (index + 1) {
        case 2:
          expected = Call.descriptor("1  9 _RESULT 3")
          break
        case 5:
          expected = Call.descriptor("2  9 _RESULT 6")
          break
        default:
          expected = blank.has(index + 1) ? spaces(44) : call
      }
      assert.deepEqual(row, expected, `row ${index + 1}`)
    })
    assert.ok(
      answer.summary.descriptorRowsBlanked === 10 && answer.summary.descriptorRowsKept === 7 && answer.summary.objectDescriptorsRewritten === 2
    )
  })

  /** Value records: references kept, inputs blank, outputs with a handle, an integer, empty or not written (R-CT-33, R-CT-34). */
  test("valueRecords", () => {
    const answer = answerTo(Call.pond())
    const table = decodeAnswer(answer.value).table("VARS")
    assert.ok(table !== undefined)
    const rows = table.rows
    assert.equal(rows.length, Call.pondValues.length * 337, "the call's record count")
    const expected = expectedPondValues(1)
    for (let index = 0; index < Call.pondValues.length; index++)
      assert.deepEqual(rows.slice(index * 337, (index + 1) * 337), expected[index], `record ${index + 1}`)
    const summary = answer.summary
    assert.ok(summary.recordsKept === 3 && summary.recordsBlanked === 7)
    assert.ok(summary.recordsWithHandle === 3 && summary.recordsWithInteger === 2 && summary.recordsEmpty === 1 && summary.recordsNotWritten === 1)
    assert.equal(summary.unplacedResults, 1, "a result slot on an input record has no place")
    assert.ok(summary.firstHandle === 1 && summary.lastHandle === 3 && summary.handles === 3 && summary.verbs === 12)
  })

  /** A shared slot keeps the last result, a handle or an integer; an input descriptor never makes a verb write. */
  test("sharedSlots", () => {
    const descriptors = ["1 12 _RESULT 1", "2 12 _RESULT 1", "3 12 _RESULT 2", "4 12 _RESULT 2", "5 3 #1 3"].map(Call.descriptor)
    const values = [Call.value("_RESULT", "000000000"), Call.value("_RESULT", "000000000"), Call.value("_RESULT", "000000000")]
    const verbs = (
      [
        [1, "GetTable", "C"],
        [1, "SetGrid", "C"],
        [1, "PublishUrl", "C"],
        [1, "GetServiceByName", "C"],
        [1, "CreateObject", "C"]
      ] as [number, string, string][]
    ).map(([object, name, flag]) => Call.verb(object, name, flag))
    const answer = answerTo(new Call({ descriptors, values, verbs }), new ControlHandleCounter(7))
    const table = decodeAnswer(answer.value).table("VARS")
    assert.ok(table !== undefined)
    const rows = table.rows
    assert.deepEqual(rows.slice(0, 337), Call.value("_RESULT", "000000000 0"), "GetTable's handle, then SetGrid's 0")
    assert.deepEqual(rows.slice(337, 674), Call.value("_RESULT", "000000000O8"), "PublishUrl's 0, then GetServiceByName's handle")
    assert.deepEqual(rows.slice(674), Call.value("_RESULT", "000000000"), "CreateObject's input points here: not written")
    assert.ok(answer.summary.firstHandle === 7 && answer.summary.lastHandle === 8, "GetTable's handle was used, then overwritten")
    assert.deepEqual(
      answer.summary.handlesByVerb,
      new Map([
        [1, 7],
        [4, 8]
      ]),
      "each handle by its verb's number (issue #167)"
    )
    assert.equal(answer.handles.next, 9, "CreateObject had no result slot: no number used")
  })

  /** Raw rows in the call: the answer sends that table as raw rows too, a blank row as one space, the others whole (R-CT-31). */
  test("rawRows", () => {
    const call = new Call({
      descriptors: ["1 12 #1 2", "1 12 _RESULT 3"].map(Call.descriptor),
      values: [Call.value("", "000000000O7"), Call.value("", "000000000 12"), Call.value("_RESULT", "000000000")],
      verbs: [Call.verb(1, "CreateControl2", "C")]
    })
    call.table("ZZ_DUCK_SLOTS", table => {
      table.raw = true
    })
    call.table("VERBS", table => {
      table.raw = true
    })
    const answer = answerTo(call)
    const decoded = decodeAnswer(answer.value)
    const slots = decoded.table("ZZ_DUCK_SLOTS")
    assert.ok(slots !== undefined)
    assert.ok(slots.raw)
    assert.deepEqual(slots.rows, concatBytes(spaces(44), Call.descriptor("1  9 _RESULT 3")))
    const first = decoded.ids.indexOf(0x0304)
    assert.ok(first >= 0)
    assert.deepEqual(decoded.values[first], Uint8Array.of(0x20))
    assert.deepEqual(decoded.values[first + 1], Call.descriptor("1  9 _RESULT 3"))
    assert.ok(!decoded.ids.includes(0x0306) || decoded.ids.filter(id => id === 0x0306).length === 1, "only VARS ends with 03 06")
    const values = decoded.table("VARS")
    assert.ok(values !== undefined)
    assert.ok(!values.raw)
    assert.deepEqual(values.rows, concatBytes(Call.value("", "000000000O7"), spaces(337), Call.value("_RESULT", "000000000O1")))
    assert.deepEqual(
      answer.summary.tables.map(table => table.form),
      [{ kind: "raw" }, { kind: "compressed", items: 1 }, { kind: "none" }]
    )

    call.table("VARS", table => {
      table.raw = true
    })
    const allRaw = decodeAnswer(answerTo(call).value)
    assert.ok(allRaw.table("VARS")?.raw === true && !allRaw.ids.includes(0x0306))
  })

  /** Raw rows the server shortens read as whole rows, each padded with spaces to the row width (R-CT-28). */
  test("shortenedRawRows", () => {
    const whole = new Call({
      descriptors: ["1 12 #1 2", "1 12 _RESULT 3", ""].map(Call.descriptor),
      values: [Call.value("", "000000000O7"), Call.value("", "000000000 12"), Call.value("_RESULT", "000000000")],
      verbs: [Call.verb(1, "CreateControl2", "C")]
    })
    whole.table("ZZ_DUCK_SLOTS", table => {
      table.raw = true
    })
    const short = whole.clone()
    short.table("ZZ_DUCK_SLOTS", table => {
      table.content = concatBytes(Call.item(0x0304, ascii("1 12 #1 2")), Call.item(0x0304, ascii("1 12 _RESULT 3")), Call.item(0x0304, [0x20]))
    })
    assert.ok(short.bytes.length < whole.bytes.length)
    assert.deepEqual(answerTo(short).value, answerTo(whole).value)
  })

  /** A call without verbs: the skeleton, byte for byte (head, parameter, three tables of 0 rows, end). */
  test("skeleton", () => {
    const call = new Call()
    const answer = answerTo(call, new ControlHandleCounter(5))
    const parts: Uint8Array[] = []
    for (const id of flushHeadIDs) parts.push(Call.item(id, id === 0x0011 ? ascii("E") : (call.headValue(id) ?? [])))
    parts.push(Call.item(0x0201, ascii("ZZ_QUACK_REPORT")), Call.item(0x0203, spaces(256)))
    parts.push(Call.item(0x0301, ascii("ZZ_DUCK_SLOTS")), Call.item(0x0302, tableInfo(44, 0)))
    parts.push(Call.item(0x0301, ascii("VARS")), Call.item(0x0302, tableInfo(337, 0)))
    parts.push(Call.item(0x0301, ascii("XML_DATA_STREAM")), Call.item(0x0302, tableInfo(255, 0)))
    parts.push(Uint8Array.of(0xff, 0xff, 0x00, 0x00, 0xff, 0xff))
    assert.deepEqual(answer.value, concatBytes(...parts))
    assert.ok(answer.handles.next === 5 && answer.summary.handles === 0)
    assert.ok(answer.summary.tables.every(table => table.form.kind === "none" && table.rows === 0))
  })

  // MARK: Handles

  /** Handles: O1 first, the counter goes on from answer to answer, a new counter starts again, no number twice (R-CT-34). */
  test("handles", () => {
    const first = answerTo(Call.pond())
    assert.equal(first.handles.next, 4)
    const second = answerTo(Call.pond("long"), first.handles)
    const secondRows = decodeAnswer(second.value).table("VARS")?.rows
    assert.ok(secondRows !== undefined)
    assert.deepEqual(secondRows, concatBytes(...expectedPondValues(4)))
    assert.ok(second.summary.firstHandle === 4 && second.handles.next === 7)
    assert.equal(first.handles.next, 4, "the answer's counter is a value: the next answer does not move it")
    const fresh = answerTo(Call.pond())
    assert.deepEqual(fresh.value, first.value, "a new connection's counter starts at O1 again; the builder is pure")
    const seen = new Set<string>()
    const values = Call.pondValues
    for (const answer of [first, second]) {
      const rows = decodeAnswer(answer.value).table("VARS")?.rows
      assert.ok(rows !== undefined)
      for (let index = 0; index < rows.length / 337; index++) {
        const field = rows.slice(index * 337 + 41, (index + 1) * 337)
        const end = field.indexOf(0x20)
        const value = end < 0 ? field : field.slice(0, end)
        if (!(value[0] === 0x4f && AutomationValueKind.of(values[index]) === "output")) continue
        const text = new TextDecoder().decode(value)
        assert.ok(!seen.has(text), "no handle twice")
        seen.add(text)
      }
    }
    assert.deepEqual(seen, new Set(["O1", "O2", "O3", "O4", "O5", "O6"]))
  })

  // MARK: The summary

  /** The summary shows counts, widths and handles, never a value of the call or the answer. */
  test("summary", () => {
    const answer = answerTo(Call.pond())
    const text = answer.summary.description
    assert.ok(text.includes("descriptor rows: 7 kept, 10 blank"))
    assert.ok(
      text.includes(
        "value records: 3 kept, 7 blank, 3 with a handle, 2 with an integer, 0 with a string, 1 empty, 1 not written, 1 result(s) without an output record"
      )
    )
    assert.ok(text.includes("handles O1 to O3"))
    assert.ok(text.includes("tables the 44-wide descriptor table 19 × 44, compressed in "))
    assert.ok(text.includes("; VARS 17 × 337, compressed in ") && text.includes("; XML_DATA_STREAM 0 × 255, no content"))
    for (const secret of ["QUACK", "DUCK", "POND", "Pond", "ZZ_", "WADDLE", "MOAT", "DPC"]) assert.ok(!text.includes(secret), secret)
    assert.ok(String(answer) === `FlushCallAnswer(${text})` && answer.description === String(answer))
    assert.equal(inspect(answer), String(answer), "no byte in a dump")
    const single = new FlushAnswerSummary()
    single.firstHandle = 9
    single.lastHandle = 9
    assert.ok(single.description.endsWith("; handle O9; texts single-byte") && new FlushAnswerSummary().description.endsWith("; no handle; texts single-byte"))
  })
})
