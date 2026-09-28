// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/FrontendTableRequest.swift (MIT).

import { ascii } from "../wire/index.js"
import { DataField } from "./dataProviderQueue.js"
import { FlushCallAnswerBuilder, FlushCallReadError, type FlushCallReadErrorInfo, type FlushCallTable } from "./flushCallAnswer.js"
import { RFCTextEncoding } from "./rfcText.js"
import type { RFCItem } from "./rfcTransfer.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/** Why a request does not read (Swift `FrontendTableRequest.Problem`). */
export type FrontendTableRequestProblemInfo =
  | { readonly kind: "framing"; readonly error: FlushCallReadErrorInfo }
  | { readonly kind: "function" }
  | { readonly kind: "parameters" }
  | { readonly kind: "representation" }
  | { readonly kind: "tables" }
  | { readonly kind: "format" }

export class FrontendTableRequestProblem extends Error {
  constructor(readonly info: FrontendTableRequestProblemInfo) {
    super(
      info.kind === "framing"
        ? `frontend table request: framing (${FlushCallReadError.describe(info.error)})`
        : `frontend table request: ${info.kind}`
    )
    this.name = "FrontendTableRequestProblem"
  }
}

function fail(info: FrontendTableRequestProblemInfo): never {
  throw new FrontendTableRequestProblem(info)
}

/** Runs `body`; a `FlushCallReadError` becomes `framing`. */
function framing<T>(body: () => T): T {
  try {
    return body()
  } catch (error) {
    if (error instanceof FlushCallReadError) fail({ kind: "framing", error: error.info })
    throw error
  }
}

/**
 * A direct request for a table registered by the frontend (PV-1021, PV-1035).
 * Reading a request does not implement or claim a successful reply.
 */
export class FrontendTableRequest {
  static readonly functionName = "DP_GET_CLIENT_TABLE45A" // provenance: PV-1021
  static readonly fieldLimit = 128 // not-protocol: bounded schema size

  private constructor(
    readonly url: string,
    readonly type: string,
    readonly subtype: string,
    readonly encoding: RFCTextEncoding,
    readonly rowWidth: number,
    readonly fields: readonly DataField[],
    /** Keep the received FORMAT bytes for a reply; structure names are not logged. */
    readonly formatRows: Uint8Array
  ) {}

  /** Reads a request (Swift `init(reading:)`); throws `FrontendTableRequestProblem`. */
  static read(bytes: Uint8Array): FrontendTableRequest {
    const B = FlushCallAnswerBuilder
    if (!(bytes.length <= B.maxCallBytes)) fail({ kind: "framing", error: { kind: "callTooLong", bytes: bytes.length } })
    const items = framing(() => B.walk(bytes))
    const names = items.filter(item => item.id === B.functionNameID)
    const functionIndex = names.length === 1 ? items.indexOf(names[0]) : -1
    const encoding =
      functionIndex < 0 ? undefined : RFCTextEncoding.reading(bytes, names[0].valueRange, ascii(FrontendTableRequest.functionName))
    if (encoding === undefined) fail({ kind: "function" })
    // provenance: PV-1021 — four import pairs and three named tables.
    const allowed = new Set(["INSUBTYPE", "INTREP", "INTYPE", "INURL"])
    const parameters = new Map<string, string>()
    items.forEach((item, index) => {
      if (item.id !== B.importParameterID) return
      if (!(index > functionIndex && index + 1 < items.length && items[index + 1].id === B.parameterValueID)) fail({ kind: "parameters" })
      const name = FrontendTableRequest.text(items[index], bytes, encoding)
      if (name === undefined || !allowed.has(name) || parameters.has(name)) fail({ kind: "parameters" })
      const value = FrontendTableRequest.text(items[index + 1], bytes, encoding)
      if (value === undefined) fail({ kind: "parameters" })
      parameters.set(name, value)
    })
    const url = parameters.get("INURL")
    if (!(parameters.size === allowed.size && url !== undefined && url.length > 0)) fail({ kind: "parameters" })
    if (parameters.get("INTREP") !== "LIT") fail({ kind: "representation" })
    const type = parameters.get("INTYPE")!
    const subtype = parameters.get("INSUBTYPE")!

    const tables = framing(() => B.readTables(items, bytes))
    if (tables.length !== 3) fail({ kind: "tables" })
    const table = (name: string): FlushCallTable | undefined => {
      const found = tables.filter(candidate => RFCTextEncoding.matches(encoding, bytes, candidate.name, ascii(name)))
      return found.length === 1 ? found[0] : undefined
    }
    const data = table("DATAASC")
    const format = table("FORMAT")
    const props = table("PROPS")
    if (
      !(
        data !== undefined &&
        format !== undefined &&
        props !== undefined &&
        data.width > 0 &&
        data.width <= B.maxStreamBytes &&
        data.rows === 0 &&
        format.width === DataField.recordWidth &&
        format.rows > 0 &&
        format.rows <= FrontendTableRequest.fieldLimit &&
        props.width === DataField.recordWidth &&
        props.rows === 0
      )
    )
      fail({ kind: "tables" })
    // Validate content even when its declared row count is zero.
    const formatRows = framing(() => {
      B.rows(data, "dataObjects", bytes, encoding)
      B.rows(props, "dataObjects", bytes, encoding)
      return B.rows(format, "dataObjects", bytes, encoding)
    })
    const fields: DataField[] = []
    let previousEnd = 0
    // provenance: PV-1004 — integer widths and their aligned offsets.
    for (let offset = 0; offset < formatRows.length; offset += DataField.recordWidth) {
      const field = DataField.of(formatRows.subarray(offset, offset + DataField.recordWidth))
      const reserved = formatRows.subarray(offset + DataField.numbersOffset + 12, offset + DataField.typeOffset)
      if (
        !(
          field !== undefined &&
          reserved.every(byte => byte === 0) &&
          field.index === fields.length + 1 &&
          field.offset >= previousEnd &&
          field.length > 0 &&
          field.offset <= data.width &&
          field.length <= data.width - field.offset &&
          [DataField.text, DataField.integer, DataField.shortInteger].includes(field.type) &&
          (field.type !== DataField.integer || (field.length === 4 && field.offset % 4 === 0)) &&
          (field.type !== DataField.shortInteger || (field.length === 2 && field.offset % 2 === 0))
        )
      )
        fail({ kind: "format" })
      fields.push(field)
      previousEnd = field.offset + field.length
    }
    return new FrontendTableRequest(url, type, subtype, encoding, data.width, fields, formatRows)
  }

  /** Narrow only ASCII parameter names and values; do not replace unknown code units. */
  private static text(item: RFCItem, bytes: Uint8Array, encoding: RFCTextEncoding): string | undefined {
    if (item.valueRange.count % RFCTextEncoding.bytesPerCharacter(encoding) !== 0) return undefined
    const text = RFCTextEncoding.narrow(encoding, item.valueRange.of(bytes))
    if (!text.every(byte => byte === 0 || (byte >= 0x20 && byte < 0x7f))) return undefined
    let end = text.length
    while (end > 0 && (text[end - 1] === 0 || text[end - 1] === 0x20)) end -= 1
    const trimmed = text.subarray(0, end)
    if (trimmed.includes(0)) return undefined
    return new TextDecoder().decode(trimmed)
  }

  /** Counts only: the URL, the types and the structure names are withheld. */
  get description(): string {
    return `frontend table request: width ${this.rowWidth}, ${this.fields.length} field(s); values withheld`
  }

  toString(): string {
    return this.description
  }

  toJSON(): string {
    return this.description
  }

  [INSPECT](): string {
    return this.description
  }
}
