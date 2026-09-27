// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/RFCTablesTests.swift (MIT).

// Table content inside an RFC item stream (docs/protocol/controls/rfc-tr.md §4, §5): the rows of
// consecutive 03 05 items joined up to the 03 06 end item (IMPL-CT-3), and the prefix of
// compressed table content read and its data decompressed (IMPL-CT-4). Contents are invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ByteRange,
  CompressionHeader,
  Decompressor,
  RFCCompressedTable,
  RFCCompressedTableError,
  RFCTableContent,
  RFCTableError
} from "../../../diag/codec/index.js"
import { CompressedDataError, LZHEncoder } from "../../../diag/compression/index.js"
import { ascii, bytes, cat, u32BE, throwsInfo } from "../../support/codecTestSupport.js"
import { rfcEnd, rfcItem } from "../../support/rfcTestSupport.js"

/** RFCTablesTests.item: RFCTransferTests.rfcItem. */
const item = rfcItem

const pondNews = ascii("Duck 0001 reports: the pond is wet.")
const moreNews = ascii(" Duck 0002 reports: so is the duck.")

/**
 * Compressed table content as rfc-tr.md §5 lays it out: a tag, a u32 BE length, the v1
 * header, the LZH data and zero padding.
 */
function compressed(data: Uint8Array, padding = 0): { content: Uint8Array; header: Uint8Array } {
  const body = new LZHEncoder().encode(data)
  const header = CompressionHeader.lzh(data.length).bytes
  const length = header.length + body.length
  const content = cat([0x00, 0x00, 0x03, 0x05], u32BE(length), header, body, new Uint8Array(padding))
  return { content, header }
}

describe("RFC tables: table content in rows (IMPL-CT-3) and its compressed prefix (IMPL-CT-4)", () => {
  /** consecutive 03 05 rows are joined up to 03 06; trailing pairs are stepped over unchecked; what follows is trailing */
  test("reassembly", () => {
    const end = rfcEnd()
    const stream = cat(item(0x0305, pondNews), item(0x0305, moreNews, 0x1234), item(0x0306, []), end)
    const table = RFCTableContent.reassemble(stream)
    assert.deepEqual(table.bytes, cat(pondNews, moreNews))
    assert.equal(table.rows.length, 2)
    assert.deepEqual(table.rows[0], new ByteRange(4, 4 + pondNews.length))
    assert.deepEqual(table.rows[1].of(stream), moreNews)
    assert.equal(table.endLength, 0)
    // The end item's length field ends at its value: the empty value, its trailing pair and the
    // end item follow.
    assert.equal(table.endOffset, stream.length - 2 - end.length)
    assert.equal(table.trailingByteCount, 2 + end.length)
    assert.equal(table.description, `RFCTableContent(rows: 2, bytes: ${table.bytes.length}, endLength: 0)`)
    assert.equal(String(table), table.description)
    assert.equal(inspect(table), table.description)
  })

  /** an end item with a length is read and discarded (PV-0914); its value counts as trailing */
  test("endWithLength", () => {
    const stream = cat(item(0x0305, [1, 2, 3]), item(0x0306, [9, 9]))
    const table = RFCTableContent.reassemble(stream)
    assert.deepEqual(table.bytes, bytes(1, 2, 3))
    assert.equal(table.endLength, 2)
    assert.equal(table.trailingByteCount, 4)
  })

  /** bad-table-item: the input does not start with 03 05, or the rows are followed by another id */
  test("badTableItem", () => {
    throwsInfo(() => RFCTableContent.reassemble(item(0x0301, [1])), RFCTableError, { kind: "badTableItem", id: 0x0301, offset: 0 })
    throwsInfo(
      () => RFCTableContent.reassemble(item(0x0306, [])),
      RFCTableError,
      { kind: "badTableItem", id: 0x0306, offset: 0 },
      "an end item without content is no table"
    )
    const row = item(0x0305, [1, 2])
    throwsInfo(() => RFCTableContent.reassemble(cat(row, rfcEnd())), RFCTableError, { kind: "badTableItem", id: 0xffff, offset: row.length })
  })

  /** truncated: the input ends inside an id, a length, a value, a trailing pair or before the end item's length */
  test("truncated", () => {
    const row = item(0x0305, [1, 2, 3, 4])
    throwsInfo(() => RFCTableContent.reassemble(bytes(0x03)), RFCTableError, { kind: "truncated", offset: 0 })
    throwsInfo(() => RFCTableContent.reassemble(bytes(0x03, 0x05, 0x00)), RFCTableError, { kind: "truncated", offset: 2 })
    throwsInfo(() => RFCTableContent.reassemble(row.slice(0, 6)), RFCTableError, { kind: "truncated", offset: 4 })
    throwsInfo(
      () => RFCTableContent.reassemble(row.slice(0, row.length - 1)),
      RFCTableError,
      { kind: "truncated", offset: 4 },
      "the trailing pair is missing"
    )
    throwsInfo(() => RFCTableContent.reassemble(row), RFCTableError, { kind: "truncated", offset: row.length })
    throwsInfo(() => RFCTableContent.reassemble(cat(row, [0x03, 0x06, 0x00])), RFCTableError, { kind: "truncated", offset: row.length + 2 })
  })

  /** the prefix: the tag, the u32 BE length at 4 unchecked, the v1 header at 8; the data decompresses, zero padding ignored */
  test("compressedPrefix", () => {
    const news = cat(...Array.from({ length: 12 }, () => cat(pondNews, moreNews)))
    const { content, header } = compressed(news, 7)
    const prefix = RFCCompressedTable.parse(content)
    assert.equal(prefix.tag, 0x0000_0305)
    assert.equal(prefix.declaredLength, content.length - 8 - 7)
    const decoded = CompressionHeader.decode(header)
    assert.deepEqual(prefix.header, decoded)
    assert.ok(prefix.header.algorithm === "lzh" && prefix.header.uncompressedLength === news.length)
    assert.deepEqual(prefix.dataRange, new ByteRange(RFCCompressedTable.prefixSize, content.length))
    const decompressor = new Decompressor()
    assert.deepEqual(prefix.decompress(content, decompressor), news)
    // Swift reads it again from a span; the port has one entry point.
    assert.deepEqual(RFCCompressedTable.parse(content), prefix)
  })

  /** fewer than 16 bytes are truncated; a header that fails the v1 checks is reported with its error */
  test("prefixErrors", () => {
    throwsInfo(() => RFCCompressedTable.parse(new Uint8Array(15)), RFCCompressedTableError, { kind: "truncated", available: 15 })
    const { content } = compressed(pondNews)
    content[13] = 0x00 // the first magic byte
    throwsInfo(() => RFCCompressedTable.parse(content), RFCCompressedTableError, {
      kind: "header",
      error: { kind: "badMagic", first: 0x00, second: 0x9d }
    })
    const { content: lying } = compressed(pondNews)
    lying[8] = 0xff // the uncompressed length no longer fits the data
    const prefix = RFCCompressedTable.parse(lying)
    const decompressor = new Decompressor(64)
    assert.throws(() => prefix.decompress(lying, decompressor), CompressedDataError)
  })
})
