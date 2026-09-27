// SPDX-License-Identifier: MIT
// Helpers the Swift RFC and flush-call tests share through each other's static members
// (Swooey Tests/DiagCodecTests: RFCTransferTests.rfcItem and .end, RFCTextTests.wideDescriptor,
// FlushCallAnswerTests.decode, .answer, .headIDs, .info, .expectedValues, .itemCount,
// FlushCallReadErrorTests.read, Bug0150Tests.decode; MIT). A node:test file cannot import another
// test file without running its tests again, so they live here.

import assert from "node:assert/strict"
import {
  ControlHandleCounter,
  Decompressor,
  FlushCallAnswerBuilder,
  FlushCallReadError,
  RFCCompressedTable,
  RFCItemWalker,
  RFCStreamSummary,
  RFCTableContent,
  type FlushCallAnswer,
  type FlushCallReadErrorInfo,
  type RFCItem
} from "../../diag/codec/index.js"
import { concatBytes } from "../../diag/wire/index.js"
import { InventedFlushCall } from "./inventedFlushCall.js"

// MARK: RFCTransferTests

/** An RFC item as rfc-tr.md §3 frames it, the id again as its trailing pair (PV-0910, PV-0919). */
export function rfcItem(id: number, value: ArrayLike<number>, trailer?: number): Uint8Array {
  const pair = trailer ?? id
  return concatBytes([id >> 8, id & 0xff, (value.length >> 8) & 0xff, value.length & 0xff], value, [pair >> 8, pair & 0xff])
}

/** The end item `FF FF 00 00 FF FF` (a fresh copy). */
export const rfcEnd = (): Uint8Array => Uint8Array.of(0xff, 0xff, 0x00, 0x00, 0xff, 0xff)

// MARK: RFCTextTests

/**
 * A descriptor in Reading R-CT-36's shape: code page 4103 as digit values, two invented bytes, 2
 * bytes per character, the replacement character `#` (a fresh copy).
 */
export const wideDescriptor = (): Uint8Array => Uint8Array.of(4, 1, 0, 3, 0x00, 0x2a, 2, 0, 0, 0, 0x23)

// MARK: FlushCallAnswerTests

/** The answer's head ids, in order (PV-0921). */
export const flushHeadIDs: readonly number[] = [0x0101, 0x0103, 0x0106, 0x0007, 0x0018, 0x0011, 0x0013, 0x0012, 0x0006, 0x0017, 0x0500]

/** A table info value: width and rows as u32 BE. */
export const tableInfo = (width: number, rows: number): Uint8Array => concatBytes(InventedFlushCall.u32(width), InventedFlushCall.u32(rows))

/** What each value record of the pond call's answer holds. */
export function expectedPondValues(firstHandle: number): Uint8Array[] {
  const values = InventedFlushCall.pondValues
  const blank = new Uint8Array(337).fill(0x20)
  const out = (name: string, text: string) => InventedFlushCall.value(name, "000000000" + text)
  return [
    values[0],
    blank,
    out("_RESULT", `O${firstHandle}`),
    blank,
    blank,
    out("_RESULT", `O${firstHandle + 1}`),
    blank,
    out("_RESULT", " 1"),
    out("ZZ_PUDDLE_DEPTHS1", `O${firstHandle + 2}`),
    blank,
    out("_RESULT", ""),
    blank,
    values[12],
    blank,
    out("_RESULT", " 0"),
    out("_RESULT", ""),
    values[16]
  ]
}

/** One table of a decoded answer. */
export interface DecodedTable {
  name: Uint8Array
  info: Uint8Array
  rows: Uint8Array
  raw: boolean
  tag: number | undefined
}

/** An answer as the existing decoders read it: its items, and each table's rows. */
export class DecodedAnswer {
  ids: number[] = []
  values: Uint8Array[] = []
  tables: DecodedTable[] = []

  /** The table named `name` (ASCII, or the bytes as sent). */
  table(name: string | Uint8Array): DecodedTable | undefined {
    const bytes = typeof name === "string" ? new TextEncoder().encode(name) : name
    return this.tables.find(table => table.name.length === bytes.length && table.name.every((byte, index) => byte === bytes[index]))
  }
}

/**
 * Reads an answer back with the existing decoders only (FlushCallAnswerTests.decode and, with
 * `space`, Bug0150Tests.decode): a raw row is padded with `space` (the call's space character) to
 * the row width.
 */
export function decodeAnswer(answer: Uint8Array, space: Uint8Array = Uint8Array.of(0x20)): DecodedAnswer {
  const decoded = new DecodedAnswer()
  const walker = new RFCItemWalker()
  const items: RFCItem[] = []
  for (let item = walker.next(answer); item !== undefined; item = walker.next(answer)) {
    assert.equal(item.trailerMatches, true)
    items.push(item)
    decoded.ids.push(item.id)
    decoded.values.push(item.valueRange.of(answer).slice())
  }
  const last = items[items.length - 1]
  assert.ok(last?.id === 0xffff && last.valueRange.upperBound === answer.length - 2, "nothing after the end item")
  for (let index = 0; index < items.length; index++) {
    if (items[index].id !== 0x0301) continue
    const info = decoded.values[index + 1]
    const width = ((info[0] << 24) | (info[1] << 16) | (info[2] << 8) | info[3]) >>> 0
    const next = index + 2
    if (items[next].id === 0x0305) {
      const content = RFCTableContent.reassemble(answer.subarray(items[next].valueRange.lowerBound - 4))
      const prefix = RFCCompressedTable.parse(content.bytes)
      const rows = prefix.decompress(content.bytes, new Decompressor())
      decoded.tables.push({ name: decoded.values[index], info, rows, raw: false, tag: prefix.tag })
    } else {
      const rows: Uint8Array[] = []
      let raw = next
      while (items[raw].id === 0x0304) {
        let row = decoded.values[raw]
        while (row.length < width) row = concatBytes(row, space)
        rows.push(row)
        raw += 1
      }
      decoded.tables.push({ name: decoded.values[index], info, rows: concatBytes(...rows), raw: raw > next, tag: undefined })
    }
  }
  return decoded
}

/** Swooey's answer to `call` with `handles` (a fresh counter by default). */
export function answerTo(call: InventedFlushCall, handles: ControlHandleCounter = new ControlHandleCounter()): FlushCallAnswer {
  return FlushCallAnswerBuilder.answer(call.bytes, handles)
}

/** The number of RFC items of `call`, its end item included (FlushCallAnswerTests.itemCount). */
export function itemCount(call: InventedFlushCall): number {
  return new RFCStreamSummary(call.bytes).itemCount
}

// MARK: FlushCallReadErrorTests

/** Why Swooey does not answer `call`, or undefined when it does (FlushCallReadErrorTests.read). */
export function readError(call: InventedFlushCall | Uint8Array): FlushCallReadErrorInfo | undefined {
  try {
    FlushCallAnswerBuilder.answer(call instanceof Uint8Array ? call : call.bytes, new ControlHandleCounter())
    return undefined
  } catch (error) {
    if (error instanceof FlushCallReadError) return error.info
    throw error
  }
}
