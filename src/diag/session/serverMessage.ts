// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/ServerMessage.swift (MIT).

import {
  ApplItem,
  ByteRange,
  DiagErrorBody,
  DiagErrorBodyError,
  DiagHeader,
  ServerErrorText,
  type CompressionHeaderDecodingErrorInfo,
  type DiagErrorBodyErrorInfo,
  type DiagHeaderErrorInfo,
  type LogonFieldStructure,
  type ScreenIdentity,
  type ScreenIdentityErrorInfo,
  type ScreenIdentityText
} from "../codec/index.js"
import type { CompressedDataErrorInfo } from "../compression/index.js"
import { readControlDocuments, type ControlDocument } from "./controlDocuments.js"
import type { ControlTraffic } from "./controlTraffic.js"
import { SessionCodePage } from "./sessionCodePage.js"
import type { ModeEvent } from "./sessionModes.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/**
 * Why a DIAG message from the server was dropped undecoded. Each drops that message only: the last
 * good screen stays and the session goes on (architecture.md §4, "Unknown data").
 *
 * The description names the class and the rule, never a payload byte or an offset: an offset after
 * a password field would give its length away (#40).
 */
export type MessageProblem =
  /** The DIAG header is truncated or its compress byte is 4–255 (IMPL-DH-1, IMPL-DH-2). */
  | { readonly kind: "header"; readonly error: DiagHeaderErrorInfo }
  /**
   * compress 2 or 3: an SNC frame, not decoded (IMPL-DH-3; encrypted connections are unsupported,
   * PLAN D4).
   */
  | { readonly kind: "snc" }
  /** compress 1, and the compression header fails its decoder (IMPL-CH-4). */
  | { readonly kind: "compressionHeader"; readonly error: CompressionHeaderDecodingErrorInfo }
  /** The compressed data does not decompress to its declared length (IMPL-CH-5, IMPL-CH-6). */
  | { readonly kind: "decompression"; readonly error: CompressedDataErrorInfo }
  /** err_no ≠ 0, and the error body has no 0x0C terminator (IMPL-DH-7): the items are not walked. */
  | { readonly kind: "errorBody"; readonly error: DiagErrorBodyErrorInfo }
  /** The item walk or the atom walk of a DYNT_ATOM item stopped (IMPL-IT-2, IMPL-IT-5, IMPL-DA-3). */
  | { readonly kind: "items"; readonly error: ScreenIdentityErrorInfo }

export const MessageProblem = {
  /** The problem in words (Swift `description`): the class and the rule, no byte and no offset. */
  describe(problem: MessageProblem): string {
    switch (problem.kind) {
      case "header":
        return problem.error.kind === "truncated"
          ? `the DIAG header is truncated: ${problem.error.availableByteCount} of ${DiagHeader.size} bytes (IMPL-DH-1)`
          : "the compress byte is none of 0-3 (IMPL-DH-2)"
      case "snc":
        return "an SNC frame (compress 2 or 3), not decoded: encrypted connections are unsupported (IMPL-DH-3)"
      case "compressionHeader":
        return "the compression header fails its decoder (IMPL-CH-4)"
      case "decompression":
        return "the compressed data does not decompress to its declared length (IMPL-CH-6)"
      case "errorBody":
        return "the error body has no 0x0C terminator (IMPL-DH-7)"
      case "items": {
        const error = problem.error
        if (error.kind === "atoms") return `the atom walk of item ${error.itemIndex} stopped (IMPL-DA-3)`
        const issue = error.value.specGapIssue
        return issue !== undefined
          ? `the item walk stopped at an item whose size is unknown (spec gap #${issue})`
          : "the item walk stopped: a truncated item or an unknown item type (IMPL-IT-2, IMPL-IT-5)"
      }
    }
  }
} as const

/**
 * Which buffer a screen's items lie in (Swift internal `ItemSource`).
 * - `payload`: the frame payload: an uncompressed message.
 * - `decompressed`: the decompressed data of a compressed message.
 */
export type ItemSource = "payload" | "decompressed"

/**
 * What one decoded server message shows: its header, the screen identity and the input fields
 * (server-screen.md §6, §7), read in one walk of its items (`LogonFieldStructure`).
 *
 * Identity texts are byte ranges into the item sequence; `ServerMessage.withItems` gives the
 * sequence and `ServerMessage.identityText` copies one trimmed text out.
 */
export class ServerScreen {
  constructor(
    /** The DIAG header. err_no ≠ 0 marks a server error (IMPL-DH-8). */
    readonly header: DiagHeader,
    /** The identity and every input field (EFIELD family) with its FNAME child. */
    readonly fields: LogonFieldStructure,
    /**
     * For a server error (err_no ≠ 0): the length of the error text before the 0x0C terminator. The
     * scrubbed debug view keeps only this count (IMPL-DH-8); the text itself is read with
     * `ServerMessage.withErrorText` or `ServerMessage.decodedErrorText()`.
     */
    readonly errorTextByteCount: number | undefined,
    /** Where the item sequence lies in `ServerMessage.payload` or the decompressed data (Swift internal). */
    readonly itemsRange: ByteRange,
    /** Swift internal. */
    readonly source: ItemSource
  ) {}

  /** Whether the message was compressed (compress 1); its items are then the decompressed data. */
  get wasCompressed(): boolean {
    return this.source === "decompressed"
  }

  /** The screen's identity. */
  get identity(): ScreenIdentity {
    return this.fields.identity
  }

  /** Whether the header carries a server error (err_no ≠ 0, PV-0054). */
  get isServerError(): boolean {
    return this.header.isError
  }
}

/**
 * What a DIAG message from the server turned out to be.
 * - `screen`: the item sequence was read: for an error message (err_no ≠ 0), the items after the
 *   error text (IMPL-DH-8). An empty sequence, such as a header-only message, reads as a screen with
 *   no identity and no fields.
 * - `notDecoded`: the message was dropped undecoded.
 */
export type ServerMessageContent =
  | { readonly kind: "screen"; readonly value: ServerScreen }
  | { readonly kind: "notDecoded"; readonly value: MessageProblem }

/**
 * Where the error body of a server error lies (diag-header.md, "Error body layout"): the bytes after
 * the DIAG header of an uncompressed message, or the decompressed data of a compressed one
 * (IMPL-DH-6). (Swift internal.)
 */
export interface ErrorBodyLocation {
  readonly range: ByteRange
  readonly source: ItemSource
}

/** The fields of a `ServerMessage` (Swift's internal memberwise init). */
export interface ServerMessageFields {
  number: number
  payload: Uint8Array
  header: DiagHeader | undefined
  content: ServerMessageContent
  decompressed: Uint8Array
  errorBody?: ErrorBodyLocation
  codePage: number
  declaredCodePage?: number
}

/**
 * One DIAG message received from the server, decoded as far as the spec allows.
 *
 * Its descriptions (`description`, `toString()`, `toJSON()`, `util.inspect`) name the number and the
 * content's class only: the payload, and with it any error text or screen text, is never shown by
 * default. The error text is read on purpose, for the user's own screen, with `withErrorText` or
 * `decodedErrorText()` (IMPL-DH-8).
 */
export class ServerMessage {
  /**
   * The message's number in arrival order among DIAG messages, from 1. Keep-alive and empty frames
   * are not numbered.
   */
  readonly number: number
  /** The frame payload as received: the DIAG header and its body. */
  readonly payload: Uint8Array
  /** The DIAG header, when at least 8 bytes arrived. */
  readonly header: DiagHeader | undefined
  /** What the message holds. */
  readonly content: ServerMessageContent
  /** The decompressed data of a compressed message; empty otherwise (Swift internal). */
  readonly decompressed: Uint8Array
  /**
   * The code page its texts are in (session.md §6.3, Reading R-SE-9): the one it declares in
   * ST_R3INFO CODEPAGE_DIAG_GUI, else the one in force before it, which is the code page CONNECT
   * requested until the server's first declaration. `isLogonProgram()` reads DYNPRONAME in it, and
   * `decodedErrorText()` a server error's text; for DYNPRONAME a number Swooey does not know is read
   * as ISO 8859-1 (§6.4).
   */
  readonly codePage: number
  /**
   * The code page this message declares in its first CODEPAGE_DIAG_GUI item that decodes (PV-0532),
   * or undefined. A message whose item walk stopped declares what came before the stop.
   */
  readonly declaredCodePage: number | undefined
  /**
   * The error body of a server error, when it was read: uncompressed, or decompressed without a
   * failure. It is kept whether or not the body has its 0x0C terminator (IMPL-DH-7). (Swift
   * internal.)
   */
  readonly errorBody: ErrorBodyLocation | undefined
  /**
   * What the message did to the connection's modes (session.md §8): it opened a mode, or ended one;
   * undefined for every other message. Set by `SessionMachine`.
   */
  modeEvent: ModeEvent | undefined = undefined
  /**
   * What the message was to the control transport (controls/transport.md §2.3): an interim message,
   * a server call's part, a complete call, and what the session sent in reply; undefined for a
   * message without either. Set by `SessionMachine`.
   */
  control: ControlTraffic | undefined = undefined

  constructor(fields: ServerMessageFields) {
    this.number = fields.number
    this.payload = fields.payload
    this.header = fields.header
    this.content = fields.content
    this.decompressed = fields.decompressed
    this.errorBody = fields.errorBody
    this.codePage = fields.codePage
    this.declaredCodePage = fields.declaredCodePage
  }

  /**
   * The mode (SAP session) the message belongs to: its DIAG header's mode byte (Reading R-MO-1,
   * session.md §8), or undefined when the header did not arrive.
   */
  get mode(): number | undefined {
    return this.header?.mode
  }

  /** The screen, when the items were read. */
  get screen(): ServerScreen | undefined {
    return this.content.kind === "screen" ? this.content.value : undefined
  }

  /** Why the message was dropped, when it was. */
  get problem(): MessageProblem | undefined {
    return this.content.kind === "notDecoded" ? this.content.value : undefined
  }

  /**
   * Runs `body` with the item sequence the screen was read from (the ranges of `ScreenIdentity` and
   * `LogonInputField` are offsets into it); undefined when the message was not decoded. The view is
   * valid only inside `body`.
   */
  withItems<Result>(body: (items: Uint8Array) => Result): Result | undefined {
    const screen = this.screen
    if (screen === undefined) return undefined
    const buffer = screen.source === "payload" ? this.payload : this.decompressed
    return body(screen.itemsRange.of(buffer))
  }

  /**
   * The bytes of an identity text, trimmed per R-SS-4 (IMPL-SS-4), or undefined when the message
   * carries no such item or was not decoded. Throws `ScreenSpecGapError` `specGap` with issue 54
   * when the message carries the item more than once.
   */
  identityText(field: ScreenIdentityText): Uint8Array | undefined {
    const screen = this.screen
    if (screen === undefined) return undefined
    const range = screen.identity.text(field)
    if (range === undefined) return undefined
    return this.withItems(items => range.of(items).slice())
  }

  /**
   * The XMLBLOB and CONTROL_PROPERTIES values of the message, in item order; empty when it carries
   * none or its items do not walk. (Swift: `extension ServerMessage` in ControlDocuments.swift.)
   */
  get controlDocuments(): ControlDocument[] {
    return readControlDocuments(this)
  }

  // MARK: Error text (IMPL-DH-8)

  /**
   * Runs `body` with the error text's bytes of a server error (err_no ≠ 0): the bytes of its error
   * body before the first 0x0C (R-DH-6), or the whole body when it has no 0x0C (IMPL-DH-7).
   * Undefined when the message is no server error, or its error body was not read (a compressed one
   * that failed to decompress, an SNC frame).
   *
   * The bytes come from the server and may name its system: they are for the user's own screen
   * only, never for a log, a dump, a fixture or anything committed (D12, D21).
   */
  withErrorText<Result>(body: (text: Uint8Array) => Result): Result | undefined {
    const errorBody = this.errorBody
    if (errorBody === undefined) return undefined
    const bytes = errorBody.range.of(errorBody.source === "payload" ? this.payload : this.decompressed)
    let textRange = new ByteRange(0, bytes.length)
    try {
      textRange = DiagErrorBody.split(bytes).textRange
    } catch (error) {
      if (!(error instanceof DiagErrorBodyError)) throw error
    }
    return body(textRange.of(bytes))
  }

  /**
   * The error text of a server error decoded for display on the user's own screen, or undefined
   * when `withErrorText` has no bytes. `ServerErrorText` reads it in `codePage`, the code page in
   * force for this message (Reading R-SE-9: CONNECT's until the server declares one), and falls back
   * to UTF-8, ISO 8859-1, UTF-16LE or UTF-16BE when that reading looks wrong, naming the one it used
   * in its notes (diag-header.md, "Observed error after the logon step"). A body without 0x0C is
   * decoded whole and flagged (`ServerErrorText.missingTerminator`). Never log the result
   * (IMPL-DH-8).
   */
  decodedErrorText(): ServerErrorText | undefined {
    const errorBody = this.errorBody
    if (errorBody === undefined) return undefined
    const buffer = errorBody.source === "payload" ? this.payload : this.decompressed
    return ServerErrorText.fromErrorBody(errorBody.range.of(buffer), this.codePage)
  }

  /**
   * Whether the screen is the logon program (R-SS-5): DYNPRONAME, decoded in `codePage` and then
   * trimmed per R-SS-4, is `SAPMSYST`, as ScreenModel's `Screen.isLogonScreen` reads it. Decoding
   * comes first, so that a UTF-16 name (4102, 4103) is compared as text and its padding is never cut
   * inside a code unit (session.md §6.4). The DYNPRONAME read is the top window's, the one
   * `ScreenIdentity` chose: in a message of several window sections the last section's (elements.md
   * Reading R-EL-23). False for a message that was not decoded or whose top window carries no
   * DYNPRONAME. Throws `ScreenSpecGapError` with issue 54 when DYNPRONAME repeats in that section.
   */
  isLogonProgram(): boolean {
    const screen = this.screen
    if (screen === undefined) return false
    const name = screen.identity.programName()
    if (name === undefined) return false
    const encoding = SessionCodePage.encoding(this.codePage)
    const result = this.withItems(items => {
      // The identity's range is trimmed by bytes; the whole value of the same item is decoded
      // instead. Trimming keeps a value's start, so the item is the one whose value starts there.
      const value = SessionCodePage.valueRange(ApplItem.stSystemInfo("dynproName"), name.lowerBound, items)
      if (value === undefined) return false
      return SessionCodePage.isLogonProgramName(value.of(items), encoding)
    })
    return result ?? false
  }

  /** The number and the content's class: no payload byte, no text and no length. */
  get description(): string {
    let content: string
    switch (this.content.kind) {
      case "screen": {
        const screen = this.content.value
        content = screen.isServerError ? `server error, err_no ${screen.header.errNo}` : "screen"
        break
      }
      case "notDecoded":
        content = `not decoded: ${MessageProblem.describe(this.content.value)}`
        break
    }
    return `ServerMessage(number: ${this.number}, ${content}; payload withheld)`
  }

  toString(): string {
    return this.description
  }

  /** The description, so that `JSON.stringify` writes no payload byte. */
  toJSON(): string {
    return this.description
  }

  /** The description, so that `util.inspect` shows no payload byte. */
  [INSPECT](): string {
    return this.description
  }
}
