// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/RFCEncodingTests.swift (MIT).

// Swooey's RFC item encoder (IMPL-CT-12) and table content encoder (IMPL-CT-13), round-tripped
// through the existing decoders: the RFC item walk (IMPL-CT-2), table reassembly (IMPL-CT-3), the
// compressed-table prefix (IMPL-CT-4) and the v1 LZH decoder (docs/protocol/controls/rfc-tr.md
// §7.8, Reading R-CT-31). Rows are invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  Decompressor,
  RFCCompressedTable,
  RFCItemEncoder,
  RFCItemEncodingError,
  RFCItemWalker,
  RFCStreamSummary,
  RFCTableContent,
  RFCTableContentEncoder,
  RFCTableEncodingError
} from "../../../diag/codec/index.js"
import { LZHEncoder } from "../../../diag/compression/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo } from "../../support/codecTestSupport.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"
import { rfcEnd, rfcItem } from "../../support/rfcTestSupport.js"
import { SeededGenerator } from "../../support/seededGenerator.js"

/** Checks the compressed items of `rows` as R-CT-31 and IMPL-CT-13 say and returns the prefix. */
function checkCompressed(rows: Uint8Array, tag: number): RFCCompressedTable {
  const encoder = new LZHEncoder()
  const stream = new ByteWriter()
  const items = RFCTableContentEncoder.appendCompressed(rows, tag, encoder, stream)
  const table = RFCTableContent.reassemble(stream.toBytes())
  assert.ok(
    table.rows.length === items && table.rows.every(row => row.count === 250),
    "every 03 05 item carries 250 bytes, the last one too"
  )
  assert.ok(table.endLength === 0 && table.trailingByteCount === 2, "03 06 with length 0 and its trailing pair, nothing after")
  const content = table.bytes
  const prefix = RFCCompressedTable.parse(content)
  const length = prefix.declaredLength
  assert.equal(prefix.tag, tag, "the tag echoed")
  assert.ok(length <= content.length && content.length === 250 * Math.floor((length + 249) / 250), "L counts from offset 0; padded to 250")
  assert.ok(
    content.subarray(length).every(byte => byte === 0),
    "zero padding after L"
  )
  assert.ok(prefix.header.algorithm === "lzh" && prefix.header.level === 2 && prefix.header.version === 1)
  assert.equal(prefix.header.uncompressedLength, rows.length)
  const decompressor = new Decompressor()
  assert.deepEqual(prefix.decompress(content, decompressor), rows, "the rows come back")
  // L is 16 + the data's length: the data alone, from offset 16 to L, decompresses too.
  const exactContent = content.slice(0, length)
  const exact = new Decompressor()
  assert.deepEqual(RFCCompressedTable.parse(exactContent).decompress(exactContent, exact), rows)
  assert.deepEqual(RFCTableContentEncoder.compressedContent(rows, tag, encoder), content)
  return prefix
}

describe("RFC encoders: items (IMPL-CT-12) and table content (IMPL-CT-13)", () => {
  /** extended parameter framing starts at the reserved length marker (bug #180) */
  for (const count of [65_534, 65_535, 65_536, 90_000]) {
    test(`extendedParameterLength(${count})`, () => {
      const value = repeated(0x51, count)
      const stream = new ByteWriter()
      RFCItemEncoder.append(0x0203, value, stream)
      const extended = count >= 65_535
      const prefix = extended ? [2, 3, 255, 255, 0, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff] : [2, 3, 255, 254]
      const bytes = stream.toBytes()
      assert.deepEqual(bytes, cat(prefix, value, [2, 3]))
      const walker = new RFCItemWalker()
      const item = walker.next(bytes)
      assert.ok(item !== undefined)
      assert.ok(item.trailerMatches === true)
      assert.deepEqual(item.valueRange.of(bytes), value)
    })
  }

  /** extended parameter output has a bounded size and leaves the destination unchanged on failure (bug #180) */
  test("parameterOutputLimit", () => {
    const value = new Uint8Array(RFCItemEncoder.maxParameterValueLength + 1)
    const stream = new ByteWriter()
    stream.u8(0x51)
    throwsInfo(() => RFCItemEncoder.append(0x0203, value, stream), RFCItemEncodingError, { kind: "valueTooLong", id: 0x0203, length: value.length })
    assert.deepEqual(stream.toBytes(), bytes(0x51))
  })

  // MARK: Items

  /** an item is the id, the u16 BE length, the value and the id again; the end item is FF FF 00 00 FF FF */
  test("itemBytes", () => {
    const stream = new ByteWriter()
    RFCItemEncoder.append(0x0201, ascii("QUACK"), stream)
    assert.deepEqual(stream.toBytes(), cat([0x02, 0x01, 0x00, 0x05], ascii("QUACK"), [0x02, 0x01]))
    RFCItemEncoder.append(0x0017, new Uint8Array(0), stream)
    RFCItemEncoder.appendEnd(stream)
    assert.deepEqual(stream.toBytes().slice(-12), bytes(0x00, 0x17, 0x00, 0x00, 0x00, 0x17, 0xff, 0xff, 0x00, 0x00, 0xff, 0xff))
    assert.deepEqual(RFCItemEncoder.endItem, bytes(0xff, 0xff, 0x00, 0x00, 0xff, 0xff))
    assert.deepEqual(
      stream.toBytes(),
      cat(rfcItem(0x0201, ascii("QUACK")), rfcItem(0x0017, []), rfcEnd()),
      "the same bytes as the tests' own framing"
    )
  })

  /** every item walks back with IMPL-CT-2 to the same ids and values, the longest value included */
  test("itemRoundTrip", () => {
    const generator = new SeededGenerator(0x0ddc_0ffe)
    const values: [number, Uint8Array][] = [
      [0x0101, new Uint8Array(0)],
      [0x0102, ascii("OLE_FLUSH_CALL")],
      [0x3c05, generator.bytes(300)]
    ]
    values.push([0x0305, generator.bytes(RFCItemEncoder.maxValueLength)])
    const writer = new ByteWriter()
    for (const [id, value] of values) {
      RFCItemEncoder.append(id, value, writer)
    }
    RFCItemEncoder.appendEnd(writer)
    const stream = writer.toBytes()
    const walker = new RFCItemWalker()
    const found: [number, Uint8Array][] = []
    for (let item = walker.next(stream); item !== undefined; item = walker.next(stream)) {
      assert.equal(item.trailerMatches, true)
      found.push([item.id, item.valueRange.of(stream).slice()])
    }
    assert.deepEqual(
      found.map(entry => entry[0]),
      [...values.map(entry => entry[0]), 0xffff]
    )
    // Swift's zip: the pairs up to the shorter list.
    assert.deepEqual(
      found.slice(0, values.length).map(entry => entry[1]),
      values.map(entry => entry[1])
    )
    assert.deepEqual(found[found.length - 1]?.[1], new Uint8Array(0))
    const summary = new RFCStreamSummary(stream)
    assert.ok(summary.reachedEnd && summary.trailingBytes === 0 && summary.mismatchedTrailers === 0)
  })

  /** a value longer than 65 535 bytes is refused and nothing is written */
  test("itemTooLong", () => {
    const stream = new ByteWriter()
    stream.bytes([1, 2])
    const long = repeated(0x51, RFCItemEncoder.maxValueLength + 1)
    throwsInfo(() => RFCItemEncoder.append(0x0305, long, stream), RFCItemEncodingError, { kind: "valueTooLong", id: 0x0305, length: 65_536 })
    assert.deepEqual(stream.toBytes(), bytes(1, 2))
  })

  // MARK: Raw rows

  /** raw rows: one 03 04 item per row, a blank row as one space, every other row whole at the row width, no 03 06 (PV-0934) */
  test("rawRows", () => {
    const full = repeated(0x51, 44)
    const rows = cat(
      InventedFlushCall.descriptor(""),
      InventedFlushCall.descriptor("1 12 _RESULT 3"),
      InventedFlushCall.descriptor(" 7 duck "),
      full
    )
    const writer = new ByteWriter()
    RFCTableContentEncoder.appendRaw(rows, 44, writer)
    const stream = writer.toBytes()
    assert.deepEqual(
      stream,
      cat(
        rfcItem(0x0304, [0x20]),
        rfcItem(0x0304, InventedFlushCall.descriptor("1 12 _RESULT 3")),
        rfcItem(0x0304, InventedFlushCall.descriptor(" 7 duck")),
        rfcItem(0x0304, full)
      ),
      "the trailing spaces of a row that is not blank stay: every such row SAP GUI's session showed was full width"
    )
    // Round trip: the walk, each row padded to the width (Reading R-CT-28).
    const walker = new RFCItemWalker()
    const back: Uint8Array[] = []
    for (let item = walker.next(stream); item !== undefined; item = walker.next(stream)) {
      assert.ok(item.id === 0x0304 && item.trailerMatches === true)
      back.push(InventedFlushCall.padded(item.valueRange.of(stream), 44))
    }
    assert.deepEqual(cat(...back), rows)

    const nothing = new ByteWriter()
    RFCTableContentEncoder.appendRaw(new Uint8Array(0), 44, nothing)
    assert.equal(nothing.length, 0, "0 rows: no content item")
    throwsInfo(() => RFCTableContentEncoder.appendRaw(repeated(0x41, 45), 44, nothing), RFCTableEncodingError, {
      kind: "notWholeRows",
      bytes: 45,
      width: 44
    })
    throwsInfo(() => RFCTableContentEncoder.appendRaw(new Uint8Array(0), 0, nothing), RFCTableEncodingError, {
      kind: "notWholeRows",
      bytes: 0,
      width: 0
    })
    throwsInfo(() => RFCTableContentEncoder.appendRaw(repeated(0x41, 70_000), 70_000, nothing), RFCTableEncodingError, {
      kind: "item",
      error: { kind: "valueTooLong", id: 0x0304, length: 70_000 }
    })
  })

  // MARK: Compressed content

  /** compressed: the tag, L from offset 0, the LZH header with level 2 and width × count, the data, zero padding, 250-byte items, 03 06 */
  test("compressedRoundTrip", () => {
    const records = Array.from({ length: 145 }, (_, index) => {
      const number = index + 1
      return InventedFlushCall.value(number % 7 === 0 ? "_RESULT" : "", `000000000 Duck ${number} paddles in circle ${number % 3}`)
    })
    checkCompressed(cat(...records), 0x5155_4143)
    checkCompressed(InventedFlushCall.descriptor("1 12 #1 2"), 0x7b02_00ea)
    const generator = new SeededGenerator(0xd0c4)
    for (const size of [1, 53, 250, 251, 999, 4_096]) {
      checkCompressed(generator.bytes(size), size)
    }
  })

  /** compressed content of no rows is refused: a table of 0 rows has no content */
  test("compressedEmpty", () => {
    const encoder = new LZHEncoder()
    const stream = new ByteWriter()
    throwsInfo(() => RFCTableContentEncoder.appendCompressed(new Uint8Array(0), 1, encoder, stream), RFCTableEncodingError, {
      kind: "tooLong",
      bytes: 0
    })
    assert.equal(stream.length, 0)
  })
})
