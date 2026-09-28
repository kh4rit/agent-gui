// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/GUIBlob.swift (MIT).

import { ascii } from "../wire/index.js"
import { ApplID, ApplItem } from "./applRegistry.js"
import { DiagItemWalkError, DiagItemWalker } from "./diagItem.js"
import { RFCTextEncoding, RFCTextForm } from "./rfcText.js"
import { RFCItemWalkError, RFCItemWalker, type RFCItem } from "./rfcTransfer.js"
import { LogonFieldStructure, ScreenIdentityError } from "./screenIdentity.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/** Why a call is no GUI-core blob call Swooey reads (Swift `GUIBlob.ReadError`). */
export type GUIBlobReadErrorInfo =
  | { readonly kind: "notBlobCall" }
  | { readonly kind: "malformedCall" }
  | { readonly kind: "parameter" }
  | { readonly kind: "items" }

export class GUIBlobReadError extends Error {
  constructor(readonly info: GUIBlobReadErrorInfo) {
    super(`GUI blob: ${info.kind}`)
    this.name = "GUIBlobReadError"
  }
}

function fail(kind: GUIBlobReadErrorInfo["kind"]): never {
  throw new GUIBlobReadError({ kind })
}

/**
 * The DIAG item stream in a GUI-core blob call. R-CT-44, issue #180.
 * Only the exact named parameter is considered; no byte-offset guessing or recursion.
 */
export class GUIBlob {
  // provenance: PV-1020
  static readonly functionName = "GUICORE_BLOB_DIAG_PARSER"
  static readonly parameterName = "STREAM"

  private constructor(
    readonly items: Uint8Array,
    readonly itemCount: number
  ) {}

  /** Reads a blob call (Swift `init(reading:)`); throws `GUIBlobReadError`. */
  static read(call: Uint8Array): GUIBlob {
    const walker = new RFCItemWalker()
    let functionSeen = false
    let parameterSeen = false
    let value: Uint8Array | undefined
    let ended = false
    // RFC names/values and end framing: PV-0910, PV-0911, PV-0912, PV-0927.
    try {
      for (let item: RFCItem | undefined = walker.next(call); item !== undefined; item = walker.next(call)) {
        if (item.trailerMatches !== true) fail("malformedCall")
        const bytes = item.valueRange.of(call)
        switch (item.id) {
          case 0x0102: {
            if (functionSeen) fail("malformedCall")
            const encoding = GUIBlob.encoding(bytes)
            if (encoding === undefined || !RFCTextEncoding.matches(encoding, call, item.valueRange, ascii(GUIBlob.functionName)))
              fail("notBlobCall")
            functionSeen = true
            break
          }
          case 0x0201: {
            const encoding = GUIBlob.encoding(bytes)
            if (
              !(
                functionSeen &&
                !parameterSeen &&
                encoding !== undefined &&
                RFCTextEncoding.matches(encoding, call, item.valueRange, ascii(GUIBlob.parameterName))
              )
            )
              fail("parameter")
            parameterSeen = true
            break
          }
          case 0x0203:
            if (!(parameterSeen && value === undefined)) fail("parameter")
            value = item.valueRange.of(call).slice()
            break
          case 0xffff:
            if (!(bytes.length === 0 && item.valueRange.upperBound + RFCItemWalker.fieldSize === call.length)) fail("malformedCall")
            ended = true
            break
          default:
            if (parameterSeen) fail("parameter")
        }
      }
    } catch (error) {
      if (error instanceof GUIBlobReadError) throw error
      if (error instanceof RFCItemWalkError) fail("malformedCall")
      throw error
    }
    if (!functionSeen) fail("notBlobCall")
    if (!ended) fail("malformedCall")
    if (value === undefined || value.length === 0) fail("parameter")
    const diag = new DiagItemWalker()
    try {
      for (let item = diag.next(value); item !== undefined; item = diag.next(value)) {
        if (item.type === "eom" && item.endOffset !== value.length) fail("items")
        // Nested calls are not part of this bounded screen transport.
        if (item.appl !== undefined && ApplItem.id(item.appl) === ApplID.rawValue("rfcTR")) fail("items")
      }
      LogonFieldStructure.decode(value)
    } catch (error) {
      if (error instanceof GUIBlobReadError || error instanceof DiagItemWalkError || error instanceof ScreenIdentityError) fail("items")
      throw error
    }
    return new GUIBlob(value, diag.itemCount)
  }

  /** The encoding of a text value's form (Swift `RFCTextForm(bytes)?.encoding`). */
  private static encoding(bytes: Uint8Array): RFCTextEncoding | undefined {
    const form = RFCTextForm.of(bytes)
    return form === undefined ? undefined : RFCTextForm.encoding(form)
  }

  /** Counts only: no screen text, input value, payload byte or offset is reported. */
  get summary(): string {
    return `GUI blob STREAM: ${this.itemCount} valid DIAG items (R-CT-44)`
  }

  get description(): string {
    return this.summary
  }

  toString(): string {
    return this.summary
  }

  toJSON(): string {
    return this.summary
  }

  [INSPECT](): string {
    return this.summary
  }
}
