// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DiagMessage.swift (MIT).

import { CompressionHeader, CompressionHeaderDecodingError, type CompressionHeaderDecodingErrorInfo } from "./compressionHeader.js"
import { ByteRange } from "./diagCodec.js"
import { DiagHeader, DiagHeaderError, type DiagBodyClass, type DiagHeaderErrorInfo } from "./diagHeader.js"

/**
 * Where the body of a DIAG message sits in its frame payload (docs/protocol/diag-header.md,
 * "Body classification"). Ranges are offsets into the payload.
 */
export type DiagMessageBody =
  /** err_no 0, compress 0: an item sequence from offset 8 to the end (possibly empty). */
  | { readonly kind: "items"; readonly range: ByteRange }
  /**
   * compress 1: a compression header, then compressed data from offset 16 to the end of the frame
   * (R-CH-1). The decompressed data is an item sequence, or an error body when `isErrorBody`
   * (err_no ≠ 0, IMPL-DH-6).
   */
  | { readonly kind: "compressed"; readonly header: CompressionHeader; readonly data: ByteRange; readonly isErrorBody: boolean }
  /**
   * err_no ≠ 0, compress 0: an error body from offset 8 to the end: text, 0x0C, items. Split it
   * with `DiagErrorBody.split`.
   */
  | { readonly kind: "errorBody"; readonly range: ByteRange }
  /** compress 2 or 3: an SNC frame, not decoded (IMPL-DH-3). */
  | { readonly kind: "snc"; readonly range: ByteRange }

export const DiagMessageBody = {
  /** The class of this body. */
  bodyClass(body: DiagMessageBody): DiagBodyClass {
    switch (body.kind) {
      case "items":
        return "items"
      case "compressed":
        return body.isErrorBody ? "compressedErrorBody" : "compressed"
      case "errorBody":
        return "errorBody"
      case "snc":
        return "snc"
    }
  },

  /** All body bytes after the DIAG header (for a compressed body, including the compression header). */
  range(body: DiagMessageBody): ByteRange {
    switch (body.kind) {
      case "items":
      case "errorBody":
      case "snc":
        return body.range
      case "compressed":
        return new ByteRange(body.data.lowerBound - CompressionHeader.size, body.data.upperBound)
    }
  }
} as const

/** Failures of message decoding. Each drops that message only (IMPL-DH-2, IMPL-CH-6). */
export type DiagMessageDecodingErrorInfo =
  /** The DIAG header is truncated or its compress byte is 4–255. */
  | { readonly kind: "header"; readonly error: DiagHeaderErrorInfo }
  /** compress 1, and the compression header fails the decoder (IMPL-CH-4). */
  | { readonly kind: "compressionHeader"; readonly error: CompressionHeaderDecodingErrorInfo }

export class DiagMessageDecodingError extends Error {
  constructor(readonly info: DiagMessageDecodingErrorInfo) {
    super(`DIAG message: ${info.kind} error ${JSON.stringify(info.error)}`)
    this.name = "DiagMessageDecodingError"
  }
}

/**
 * One DIAG message received from the server: its header and where its body is (spec v1).
 *
 * The DIAG header starts at offset 0 of the frame payload (R-DH-1): a client never receives a DP
 * header (R-DP-1). For a compressed body the compression header is decoded too; the compressed
 * data is left to a `Decompressor`. For an error body, `DiagErrorBody` splits the text from the
 * items.
 */
export class DiagMessage {
  private constructor(
    readonly header: DiagHeader,
    readonly body: DiagMessageBody
  ) {}

  /** Lays out a frame payload classified as a DIAG message (ni-framing.md, rule 5). */
  static parse(payload: Uint8Array): DiagMessage {
    let header: DiagHeader
    let bodyClass: DiagBodyClass
    try {
      header = DiagHeader.parse(payload)
      bodyClass = header.bodyClass()
    } catch (error) {
      if (error instanceof DiagHeaderError) throw new DiagMessageDecodingError({ kind: "header", error: error.info })
      throw error
    }
    const rest = new ByteRange(DiagHeader.size, payload.length)
    let body: DiagMessageBody
    switch (bodyClass) {
      case "items":
        body = { kind: "items", range: rest }
        break
      case "errorBody":
        body = { kind: "errorBody", range: rest }
        break
      case "snc":
        body = { kind: "snc", range: rest }
        break
      case "compressed":
      case "compressedErrorBody": {
        let compression: CompressionHeader
        try {
          compression = CompressionHeader.decode(rest.of(payload))
        } catch (error) {
          if (error instanceof CompressionHeaderDecodingError)
            throw new DiagMessageDecodingError({ kind: "compressionHeader", error: error.info })
          throw error
        }
        const data = new ByteRange(rest.lowerBound + CompressionHeader.size, payload.length)
        body = { kind: "compressed", header: compression, data, isErrorBody: bodyClass === "compressedErrorBody" }
        break
      }
    }
    return new DiagMessage(header, body)
  }
}

// MARK: - Error body

/** Failures of the error-body split. */
export type DiagErrorBodyErrorInfo =
  /**
   * The error body contains no byte 0x0C (IMPL-DH-7). The session reports a server error with
   * err_no, keeps the raw bytes for the debug view and walks no items. [`missing-terminator`]
   */
  { readonly kind: "missingTerminator"; readonly byteCount: number }

export class DiagErrorBodyError extends Error {
  constructor(readonly info: DiagErrorBodyErrorInfo) {
    super(`error body without a 0x0C terminator (${info.byteCount} bytes)`)
    this.name = "DiagErrorBodyError"
  }
}

/**
 * An error body split into its parts (docs/protocol/diag-header.md, "Error body layout"): the
 * error text, one terminator byte 0x0C, then an item sequence, possibly empty (PV-0303). The
 * input is the bytes after the DIAG header of a message with err_no ≠ 0 and compress 0, or the
 * decompressed data of one with compress 1. Ranges are offsets into that input.
 */
export class DiagErrorBody {
  /** The terminator that ends the text. */
  static readonly terminator = 0x0c // provenance: PV-0303

  private constructor(
    /**
     * The error text's bytes, before the terminator. Decode them for the user's own screen with
     * `ServerErrorText.fromTextBytes` in the session's code page in force, which checks the
     * reading and falls back when it looks wrong (#8, PV-0727, PV-0308); a log keeps only their
     * count (IMPL-DH-8).
     */
    readonly textRange: ByteRange,
    /** The item sequence after the terminator; walk it with `DiagItemWalker` (IMPL-DH-8). */
    readonly itemsRange: ByteRange
  ) {}

  /**
   * Finds the first 0x0C byte of the body, at any offset (R-DH-6). The text is what comes before
   * it and the items are what follows it.
   */
  static split(body: Uint8Array): DiagErrorBody {
    let index = 0
    while (index < body.length && body[index] !== DiagErrorBody.terminator) index += 1
    if (index >= body.length) throw new DiagErrorBodyError({ kind: "missingTerminator", byteCount: body.length })
    return new DiagErrorBody(new ByteRange(0, index), new ByteRange(index + 1, body.length))
  }
}
