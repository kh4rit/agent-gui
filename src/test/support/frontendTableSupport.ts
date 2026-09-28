// SPDX-License-Identifier: MIT
// Helpers the Swift frontend-table tests share through each other's static members (Swooey
// Tests/DiagCodecTests/FrontendTableRequestTests.swift: FrontendTableRequestTests.request; MIT).
// A node:test file cannot import another test file without running its tests again, so it lives
// here. source: fake — invented URLs and table schemas.

import { FrontendTableRequest, RFCTextEncoding } from "../../diag/codec/index.js"
import { concatBytes } from "../../diag/wire/index.js"
import { InventedDataObject, InventedField } from "./inventedDataObject.js"
import { InventedFlushCall, utf8 } from "./inventedFlushCall.js"

/** The options of `frontendTableRequest` (Swift's labelled parameters and their defaults). */
export interface FrontendTableRequestOptions {
  fields?: InventedField[]
  encoding?: RFCTextEncoding
  parameters?: [string, string][]
  formatRows?: Uint8Array[]
  formatCount?: number
  dataRows?: Uint8Array[]
}

/**
 * A `DP_GET_CLIENT_TABLE45A` request in the tests' own framing: the function name, the import
 * pairs, the DATAASC, FORMAT and PROPS tables with raw rows, and the end item (Swift
 * `FrontendTableRequestTests.request`).
 */
export function frontendTableRequest(options: FrontendTableRequestOptions = {}): Uint8Array {
  const fields = options.fields ?? [InventedField.text(12)]
  const encoding = options.encoding ?? "singleByte"
  const parameters = options.parameters ?? [
    ["INSUBTYPE", " "],
    ["INTREP", "LIT"],
    ["INTYPE", " "],
    ["INURL", "sapr3://ZZ_DUCK_EXPORT"]
  ]
  const dataRows = options.dataRows ?? []
  const item = InventedFlushCall.item
  const encode = (text: string): Uint8Array => RFCTextEncoding.encode(encoding, utf8(text))
  const object = new InventedDataObject("sapr3://ZZ_DUCK_EXPORT", fields, [])
  const parts: Uint8Array[] = [item(0x0102, encode(FrontendTableRequest.functionName))]
  for (const [name, value] of parameters) parts.push(item(0x0201, encode(name)), item(0x0203, encode(value)))
  const formatRows = options.formatRows ?? object.formatRows
  const tables: [string, number, Uint8Array[], number][] = [
    ["DATAASC", object.layout.width, dataRows, dataRows.length],
    ["FORMAT", 80, formatRows, options.formatCount ?? formatRows.length],
    ["PROPS", 80, [], 0]
  ]
  for (const [name, width, rows, count] of tables) {
    parts.push(item(0x0301, encode(name)))
    parts.push(item(0x0302, concatBytes(InventedFlushCall.u32(width), InventedFlushCall.u32(count))))
    for (const row of rows) parts.push(item(0x0304, row))
  }
  return concatBytes(...parts, item(0xffff, []))
}
