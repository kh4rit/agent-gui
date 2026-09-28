// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/FrontendTableReply.swift (MIT).

import { ascii, ByteWriter } from "../wire/index.js"
import { INT_MAX } from "./diagCodec.js"
import { DataField, type DataObject } from "./dataProviderQueue.js"
import { FlushAnswerHead, FlushAnswerSummary, FlushCallAnswerBuilder, FlushCallReadError, type FlushCallReadErrorInfo } from "./flushCallAnswer.js"
import { FrontendTableRegistry } from "./frontendTableRegistry.js"
import { FrontendTableRequest, FrontendTableRequestProblem, type FrontendTableRequestProblemInfo } from "./frontendTableRequest.js"
import { RFCItemEncoder, RFCItemEncodingError, RFCTableContentEncoder, RFCTableEncodingError } from "./rfcEncoding.js"
import type { RFCItem } from "./rfcTransfer.js"

/** Why no reply is encoded (Swift `FrontendTableReply.Problem`). */
export type FrontendTableReplyProblemInfo =
  | { readonly kind: "request"; readonly error: FrontendTableRequestProblemInfo }
  | { readonly kind: "framing"; readonly error: FlushCallReadErrorInfo }
  | { readonly kind: "head" }
  | { readonly kind: "schema" }
  | { readonly kind: "unsupportedEncoding" }
  | { readonly kind: "tooLarge" }
  | { readonly kind: "encoding" }

export class FrontendTableReplyProblem extends Error {
  constructor(readonly info: FrontendTableReplyProblemInfo) {
    super(`frontend table reply: ${info.kind}`)
    this.name = "FrontendTableReplyProblem"
  }
}

function fail(info: FrontendTableReplyProblemInfo): never {
  throw new FrontendTableReplyProblem(info)
}

/**
 * Candidate direct-table reply for an explicitly enabled interoperability experiment.
 * No session calls this encoder by default. The RFC return head and table grammar
 * reuse PV-0927–PV-0929, PV-0934 and PV-0958; applying them to this function, and
 * omitting its descriptive metadata exports, remain unverified (#171/#192).
 */
export const FrontendTableReply = {
  /** The reply to `bytes`, a frontend table request, with `table`'s rows; throws `FrontendTableReplyProblem`. */
  experimental(bytes: Uint8Array, table: DataObject, own: FlushAnswerHead = FlushAnswerHead.echo): Uint8Array {
    const Builder = FlushCallAnswerBuilder
    let request: FrontendTableRequest
    try {
      request = FrontendTableRequest.read(bytes)
    } catch (error) {
      if (error instanceof FrontendTableRequestProblem) fail({ kind: "request", error: error.info })
      throw error
    }
    // Binary FORMAT records and the exported ASCII keys have only been observed
    // with single-byte request texts. Do not infer a UTF-16 table conversion.
    if (request.encoding !== "singleByte") fail({ kind: "unsupportedEncoding" })
    if (
      !(
        table.url === request.url &&
        DataField.listsEqual(table.fields, request.fields) &&
        table.rowWidth === request.rowWidth &&
        table.type === "APPLICATION" &&
        table.subtype === "X-R3TABLE" &&
        (request.type.length === 0 || request.type.toUpperCase() === table.type) &&
        (request.subtype.length === 0 || request.subtype.toUpperCase() === table.subtype) &&
        table.rows.every(row => row.length === table.rowWidth)
      )
    )
      fail({ kind: "schema" })
    // Swift multiplies with overflow reporting; a product past the port's exact integers counts as
    // an overflow (INT_MAX, diagCodec.ts).
    const product = BigInt(table.rowWidth) * BigInt(table.rows.length)
    const overflow = product > BigInt(INT_MAX)
    if (overflow || !(Number(product) <= Builder.maxStreamBytes) || !(table.rows.length <= FrontendTableRegistry.rowLimit)) fail({ kind: "tooLarge" })
    let items: RFCItem[]
    try {
      items = Builder.walk(bytes)
    } catch (error) {
      if (error instanceof FlushCallReadError) fail({ kind: "framing", error: error.info })
      throw error
    }
    const functionIndex = items.findIndex(item => item.id === Builder.functionNameID)
    if (functionIndex < 0) fail({ kind: "head" })
    const head = new Map<number, RFCItem>()
    for (const id of Builder.echoedHeadIDs) {
      const found = items.slice(0, functionIndex).filter(item => item.id === id)
      if (found.length !== 1) fail({ kind: "head" })
      head.set(id, found[0])
    }
    const result = new ByteWriter(1024)
    const summary = new FlushAnswerSummary()
    try {
      for (const id of Builder.answerHeadIDs) {
        const value = Builder.ownValue(id, head, bytes, request.encoding, own, summary)
        const item = head.get(id)
        if (value !== undefined) {
          RFCItemEncoder.append(id, value, result)
        } else if (item !== undefined) {
          RFCItemEncoder.append(id, item.valueRange.of(bytes), result)
        } else {
          RFCItemEncoder.append(id, new Uint8Array(0), result)
        }
      }
      // PV-1021 names these exports; PV-1002 establishes the typed-table MIME.
      // This experiment returns only known data metadata, not guessed DATE,
      // TIME, DESCRIPTION or PLATTFORM widths. TOTALSIZE is omitted too until
      // the direct return's interpretation has been verified.
      for (const [name, value] of [
        ["TYPE", table.type],
        ["SUBTYPE", table.subtype]
      ]) {
        RFCItemEncoder.append(Builder.importParameterID, utf8(name), result)
        RFCItemEncoder.append(Builder.parameterValueID, utf8(value), result)
      }
      const rows = new ByteWriter(table.rowWidth * table.rows.length)
      for (const row of table.rows) rows.bytes(row)
      appendTable("DATAASC", table.rowWidth, table.rows.length, rows.toBytes(), result)
      appendTable("FORMAT", DataField.recordWidth, request.fields.length, request.formatRows, result)
      appendTable("PROPS", DataField.recordWidth, 0, new Uint8Array(0), result)
    } catch (error) {
      if (error instanceof RFCItemEncodingError || error instanceof RFCTableEncodingError) fail({ kind: "encoding" })
      throw error
    }
    RFCItemEncoder.appendEnd(result)
    if (!(result.length <= Builder.maxAnswerBytes)) fail({ kind: "tooLarge" })
    return result.toBytes()
  }
} as const

/**
 * Raw rows avoid introducing unverified compressed-return details. A too-large
 * answer fails instead of fragmenting with an unverified client protocol.
 */
function appendTable(name: string, width: number, count: number, rows: Uint8Array, result: ByteWriter): void {
  const bigEndian = (number: number): number[] => {
    const value = number >>> 0
    return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff)
  }
  RFCItemEncoder.append(FlushCallAnswerBuilder.tableNameID, ascii(name), result)
  RFCItemEncoder.append(FlushCallAnswerBuilder.tableInfoID, Uint8Array.from([...bigEndian(width), ...bigEndian(count)]), result)
  if (count > 0) RFCTableContentEncoder.appendRaw(rows, width, result)
}

/** Swift `Array(text.utf8)`. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
