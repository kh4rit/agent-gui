// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/ControlTraffic.swift (MIT).

// The session's side of the Control Framework transport (docs/protocol/controls/transport.md
// §2.3, §2.5): interim messages, a server call in parts, and the automatic replies by which the
// server goes on to its screen: after a part the empty RFC_TR_MOR SAP GUI sends (Reading R-CT-27),
// and after a complete `OLE_FLUSH_CALL` Swooey's own answer (rfc-tr.md §7.8, R-CT-28), each in
// SAP GUI's three-item reply message (R-CT-26). Every choice the spec leaves open is a switchable
// Reading (`ControlReadings`); the session answers by itself because the server waits for the
// answer before it sends anything else (PV-0903, PV-0905).
//
// Swift's nested types are top-level here: `ControlReadings.ReplyShape` is
// `ControlReadingsReplyShape`, `ControlTraffic.Item` is `ControlTrafficItem`, and so on.

import {
  ApplSID,
  CodePage,
  ControlHandleCounter,
  ControlItemScan,
  FlushAnswerHead,
  FlushCallAnswerBuilder,
  FlushCallReadError,
  InputEnvelope,
  RFCCallAssembler,
  RFCHead,
  RFCStreamSummary,
  RFCTextEncoding,
  RFCTransferValue,
  ServerMessageInfo,
  type ApplSIDRfcTr,
  type ClientIdentity,
  type FlushAnswerSummary,
  type FlushCallReadErrorInfo,
  type RFCCall,
  type RFCTransferItem
} from "../codec/index.js"
import type { ServerMessage } from "./serverMessage.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

// MARK: - Readings

/**
 * The DIAG message every automatic reply is (Reading R-CT-26; Swift `ControlReadings.ReplyShape`).
 * - `threeItems`: Reading R-CT-26, the default: SAP GUI's reply, msg_info 0x01 and exactly
 *   DIALOG_STEP_NUMBER (the replied message's step), the RFC_TR item and EOM (PV-0906, PV-0908).
 * - `envelope`: the reply table of transport.md §2.3: the input envelope's echoes, DYNN CHL and
 *   DYNT_NOFOCUS around the RFC_TR item, msg_info 0, as Swooey replied until 2026-09-25 and the
 *   owner's server went on after (PV-0948).
 */
export type ControlReadingsReplyShape = "threeItems" | "envelope"

export const ControlReadingsReplyShape = {
  allCases: ["threeItems", "envelope"] as readonly ControlReadingsReplyShape[],

  rawValue(shape: ControlReadingsReplyShape): string {
    return shape === "threeItems" ? "three-items" : "envelope"
  },

  fromRawValue(raw: string): ControlReadingsReplyShape | undefined {
    return ControlReadingsReplyShape.allCases.find(shape => ControlReadingsReplyShape.rawValue(shape) === raw)
  },

  /** The choice in words, for a picker and the session report. */
  title(shape: ControlReadingsReplyShape): string {
    switch (shape) {
      case "threeItems":
        return "three items, as SAP GUI replies (R-CT-26)"
      case "envelope":
        return "the input envelope's items (transport.md §2.3)"
    }
  }
} as const

/**
 * What the session sends after a message whose call part announces more (RFC_TR_MOR, Reading
 * R-CT-23), so that the server sends the next part (Swift `ControlReadings.PartReply`). The default
 * is SAP GUI's reply (Reading R-CT-27); the others follow, the envelope alone first (tried live,
 * R-CT-24), then in sid order, which is no ranking.
 * - `emptyMore`: Reading R-CT-27, the default: an empty RFC_TR_MOR item (sid 0x04), as SAP GUI
 *   answered each part (PV-0907).
 * - `envelopeOnly`: Reading R-CT-24: the reply without any RFC_TR item, always in the envelope
 *   shape (the input envelope's items, msg_info 0), whatever `ControlReadingsReplyShape` says, as
 *   the run behind issue #133 sent it; the server went on after it too. The three-item shape has no
 *   message without an RFC_TR item.
 * - `emptyRequest`: an empty RFC_TR_RQT item (sid 0x03). No source shows the sid in either
 *   direction.
 * - `emptyMoreBack`: an empty RFC_TR_MOB item (sid 0x05), the registry's partner of MOR. No source
 *   shows it.
 * - `none`: no reply: the session waits, and so does the server (Reading R-CT-1).
 */
export type ControlReadingsPartReply = "emptyMore" | "envelopeOnly" | "emptyRequest" | "emptyMoreBack" | "none"

export const ControlReadingsPartReply = {
  allCases: ["emptyMore", "envelopeOnly", "emptyRequest", "emptyMoreBack", "none"] as readonly ControlReadingsPartReply[],

  rawValue(reply: ControlReadingsPartReply): string {
    switch (reply) {
      case "emptyMore":
        return "empty-mor"
      case "envelopeOnly":
        return "envelope-only"
      case "emptyRequest":
        return "empty-rqt"
      case "emptyMoreBack":
        return "empty-mob"
      case "none":
        return "none"
    }
  },

  fromRawValue(raw: string): ControlReadingsPartReply | undefined {
    return ControlReadingsPartReply.allCases.find(reply => ControlReadingsPartReply.rawValue(reply) === raw)
  },

  /** The RFC_TR sid the reply carries, undefined for none. */
  sid(reply: ControlReadingsPartReply): ApplSIDRfcTr | undefined {
    switch (reply) {
      case "emptyRequest":
        return "rqt"
      case "emptyMore":
        return "mor"
      case "emptyMoreBack":
        return "mob"
      case "envelopeOnly":
      case "none":
        return undefined
    }
  },

  /** The choice in words, for a picker and the session report. */
  title(reply: ControlReadingsPartReply): string {
    switch (reply) {
      case "emptyMore":
        return "an empty RFC_TR_MOR, as SAP GUI replies (R-CT-27)"
      case "envelopeOnly":
        return "the envelope alone, no RFC_TR (R-CT-24)"
      case "emptyRequest":
        return "an empty RFC_TR_RQT"
      case "emptyMoreBack":
        return "an empty RFC_TR_MOB"
      case "none":
        return "nothing (the server keeps waiting)"
    }
  }
} as const

/**
 * What the session sends once a call is complete (RFC_TR_REQ; Swift `ControlReadings.CallAnswer`).
 * - `built`: Reading R-CT-28, the default: Swooey's own answer to an `OLE_FLUSH_CALL`, built from
 *   the call (rfc-tr.md §7.8, IMPL-CT-14), in an RFC_TR_RET item; a call Swooey cannot read gets the
 *   empty RFC_TR_RET of Reading R-CT-35.
 * - `emptyReturn`: Reading R-CT-25: an RFC_TR_RET item with an empty value, which is no RFC item
 *   stream. The owner's server went on after it, then dumped (PV-0951).
 * - `emptyError`: an RFC_TR_ERR item with an empty value: "this client cannot run the call".
 * - `none`: no answer: the session waits, and so does the server (Reading R-CT-1).
 */
export type ControlReadingsCallAnswer = "built" | "emptyReturn" | "emptyError" | "none"

export const ControlReadingsCallAnswer = {
  allCases: ["built", "emptyReturn", "emptyError", "none"] as readonly ControlReadingsCallAnswer[],

  rawValue(answer: ControlReadingsCallAnswer): string {
    switch (answer) {
      case "built":
        return "built"
      case "emptyReturn":
        return "empty-ret"
      case "emptyError":
        return "empty-err"
      case "none":
        return "none"
    }
  },

  fromRawValue(raw: string): ControlReadingsCallAnswer | undefined {
    return ControlReadingsCallAnswer.allCases.find(answer => ControlReadingsCallAnswer.rawValue(answer) === raw)
  },

  /** The RFC_TR sid the answer carries, undefined for none. */
  sid(answer: ControlReadingsCallAnswer): ApplSIDRfcTr | undefined {
    switch (answer) {
      case "built":
      case "emptyReturn":
        return "ret"
      case "emptyError":
        return "err"
      case "none":
        return undefined
    }
  },

  /** The choice in words, for a picker and the session report. */
  title(answer: ControlReadingsCallAnswer): string {
    switch (answer) {
      case "built":
        return "Swooey's own answer (R-CT-28)"
      case "emptyReturn":
        return "an empty RFC_TR_RET (R-CT-25)"
      case "emptyError":
        return "an empty RFC_TR_ERR"
      case "none":
        return "nothing (the server keeps waiting)"
    }
  }
} as const

/**
 * What Swooey's own answer writes in the head items SAP GUI fills with values of its own (rfc-tr.md
 * §7.8, Reading R-CT-36; issue #150; Swift `ControlReadings.HeadValues`). The default declares
 * Swooey's own code page in `01 06` and echoes the rest; the others follow in the order a run would
 * try them.
 * - `ownCodePage`: Reading R-CT-36, the default: `01 06` Swooey's own code-page descriptor, the code
 *   page in force (the one the server declared in CODEPAGE_DIAG_GUI) and its bytes per character;
 *   `00 07`, `00 18`, `00 13` and `00 12` the call's.
 * - `ownCodePage1100`: as the default, with code page 1100 (single-byte, ISO 8859-1-like) in
 *   `01 06` whatever the code page in force.
 * - `ownCodePageAndAddress`: as the default, and `00 07` and `00 18` Swooey's own address text, the
 *   unspecified address `0.0.0.0` (`00 07` padded to 15 characters).
 * - `echo`: every one of them the call's value: the answer Swooey 0.0.82 sent (Reading R-CT-29 as
 *   first written).
 */
export type ControlReadingsHeadValues = "ownCodePage" | "ownCodePage1100" | "ownCodePageAndAddress" | "echo"

export const ControlReadingsHeadValues = {
  allCases: ["ownCodePage", "ownCodePage1100", "ownCodePageAndAddress", "echo"] as readonly ControlReadingsHeadValues[],

  rawValue(values: ControlReadingsHeadValues): string {
    switch (values) {
      case "ownCodePage":
        return "own-code-page"
      case "ownCodePage1100":
        return "own-code-page-1100"
      case "ownCodePageAndAddress":
        return "own-address"
      case "echo":
        return "echo"
    }
  },

  fromRawValue(raw: string): ControlReadingsHeadValues | undefined {
    return ControlReadingsHeadValues.allCases.find(values => ControlReadingsHeadValues.rawValue(values) === raw)
  },

  /** The choice in words, for a picker and the session report. */
  title(values: ControlReadingsHeadValues): string {
    switch (values) {
      case "ownCodePage":
        return "own code page in 01 06, the rest echoed (R-CT-36)"
      case "ownCodePage1100":
        return "own code page 1100 in 01 06, the rest echoed"
      case "ownCodePageAndAddress":
        return "own code page and address 0.0.0.0, the rest echoed"
      case "echo":
        return "every value echoed from the call (0.0.82)"
    }
  },

  /** The builder's head for a session whose code page in force is `codePage`. */
  head(values: ControlReadingsHeadValues, codePage: number): FlushAnswerHead {
    switch (values) {
      case "ownCodePage":
        return new FlushAnswerHead({ codePage })
      case "ownCodePage1100":
        return new FlushAnswerHead({ codePage: CodePage.latin1 })
      case "ownCodePageAndAddress":
        return new FlushAnswerHead({ codePage, ownAddress: true })
      case "echo":
        return FlushAnswerHead.echo
    }
  }
} as const

/** The options of `ControlReadings` (Swift's `init(partReply:callAnswer:replyShape:envelope:headValues:)`). */
export interface ControlReadingsOptions {
  partReply?: ControlReadingsPartReply
  callAnswer?: ControlReadingsCallAnswer
  replyShape?: ControlReadingsReplyShape
  envelope?: InputEnvelope
  headValues?: ControlReadingsHeadValues
}

/**
 * How a session answers the server's control traffic where the spec is open (transport.md §2.3,
 * §2.5). A Swift struct: `clone()` copies it.
 */
export class ControlReadings {
  replyShape: ControlReadingsReplyShape
  partReply: ControlReadingsPartReply
  callAnswer: ControlReadingsCallAnswer
  headValues: ControlReadingsHeadValues
  /**
   * The input envelope the replies are built from: with the three-item shape only its echoes decide
   * the header's mode_stat; with the envelope shape its `InputEnvelope.controlReply` parts go out.
   * Undefined: the session identity's default (`InputEnvelope.default(identity)`).
   */
  envelope: InputEnvelope | undefined

  constructor(options: ControlReadingsOptions = {}) {
    this.partReply = options.partReply ?? "emptyMore"
    this.callAnswer = options.callAnswer ?? "built"
    this.replyShape = options.replyShape ?? "threeItems"
    this.envelope = options.envelope
    this.headValues = options.headValues ?? "ownCodePage"
  }

  /** A copy of the readings. */
  clone(): ControlReadings {
    return new ControlReadings({
      partReply: this.partReply,
      callAnswer: this.callAnswer,
      replyShape: this.replyShape,
      envelope: this.envelope,
      headValues: this.headValues
    })
  }
}

// MARK: - Traffic

/** One RFC_TR item as the message carried it (Swift `ControlTraffic.Item`). */
export interface ControlTrafficItem {
  /** The sid byte (PV-0457). */
  readonly sid: number
  /** The value's length in bytes. */
  readonly length: number
  /** `RFC_TR_MOR`, or the sid in hex for one the registry does not list. */
  readonly name: string
}

/** Where the message left the server's call (Swift `ControlTraffic.CallProgress`). */
export type ControlTrafficCallProgress =
  /** A part that announces more (RFC_TR_MOR, Reading R-CT-23): the parts and bytes so far. */
  | { readonly kind: "part"; readonly parts: number; readonly bytes: number }
  /** The part that ends the call (RFC_TR_REQ): the call's parts, bytes and structure. */
  | { readonly kind: "complete"; readonly parts: number; readonly bytes: number; readonly summary: RFCStreamSummary }
  /** A call that expects no answer (RFC_TR_RNB, Reading R-CT-23): its bytes and structure. */
  | { readonly kind: "oneWay"; readonly bytes: number; readonly summary: RFCStreamSummary }
  /** The call grew past `RFCCallAssembler.maxCallBytes` and was dropped. */
  | { readonly kind: "tooLarge"; readonly parts: number; readonly bytes: number }

/**
 * Why a reply went out (Swift `ControlTraffic.Reply.Kind`).
 * - `partReply`: after a call part, for the next part (Readings R-CT-27, R-CT-24).
 * - `callAnswer`: after a complete call (Readings R-CT-28, R-CT-25).
 */
export type ControlTrafficReplyKind =
  | { readonly kind: "partReply"; readonly value: ControlReadingsPartReply }
  | { readonly kind: "callAnswer"; readonly value: ControlReadingsCallAnswer }

/**
 * What became of Swooey's own answer (`ControlReadingsCallAnswer` `built`; Swift
 * `ControlTraffic.Reply.Answer`).
 * - `built`: Swooey built it (Reading R-CT-28): its structure.
 * - `fallback`: Swooey could not read the call and sent the empty RFC_TR_RET instead (Reading
 *   R-CT-35): the requirement that failed.
 */
export type ControlTrafficReplyAnswer =
  | { readonly kind: "built"; readonly summary: FlushAnswerSummary }
  | { readonly kind: "fallback"; readonly error: FlushCallReadErrorInfo }

/** The fields of a `ControlTrafficReply` (Swift's `init(kind:sid:stepNumber:payload:answer:shape:)`). */
export interface ControlTrafficReplyFields {
  kind: ControlTrafficReplyKind
  sid: ApplSIDRfcTr | undefined
  stepNumber: number
  payload: Uint8Array
  answer?: ControlTrafficReplyAnswer
  shape?: ControlReadingsReplyShape
}

/** What the session sent in reply (Swift `ControlTraffic.Reply`). */
export class ControlTrafficReply {
  /** Why it went out. */
  readonly kind: ControlTrafficReplyKind
  /** The RFC_TR item it carried, undefined for the envelope alone. */
  readonly sid: ApplSIDRfcTr | undefined
  /** The step number it carried. */
  readonly stepNumber: number
  /** The payload as written: the RFC_TR item and what the reply shape adds, no user input. */
  readonly payload: Uint8Array
  /** Swooey's own answer, when the Readings asked for one; undefined otherwise. */
  readonly answer: ControlTrafficReplyAnswer | undefined
  /** The reply's shape (Reading R-CT-26). */
  readonly shape: ControlReadingsReplyShape

  constructor(fields: ControlTrafficReplyFields) {
    this.kind = fields.kind
    this.sid = fields.sid
    this.stepNumber = fields.stepNumber
    this.payload = fields.payload
    this.answer = fields.answer
    this.shape = fields.shape ?? "threeItems"
  }

  /** The RFC_TR item in words: its sid and what its value is, never a byte of it. (Swift internal.) */
  get itemText(): string {
    const sid = this.sid
    if (sid === undefined) return "no RFC_TR item"
    const name = ApplSID.RfcTr.name(sid)
    const answer = this.answer
    if (answer === undefined) return `${name}, empty`
    switch (answer.kind) {
      case "built":
        return `${name}, Swooey's answer (R-CT-28): ${answer.summary.description}`
      case "fallback":
        return `${name}, empty (R-CT-35: ${FlushCallReadError.describe(answer.error)})`
    }
  }

  /** The step, the sid and the length: never a byte of the payload. */
  get description(): string {
    return `ControlTraffic.Reply(step ${this.stepNumber}, ${this.sid === undefined ? "no RFC_TR" : ApplSID.RfcTr.name(this.sid)}, ${this.payload.length} bytes)`
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

/**
 * What one server message was to the control transport, and what the session did about it
 * (`ServerMessage.control`). Structure only: sids, counts and lengths, never a value.
 */
export class ControlTraffic {
  /** The most bytes of a call `callBytes` keeps for the developer dump. */
  static readonly keptCallBytes = 8 << 20 // not-protocol: a memory cap, 8 MiB

  /**
   * The complete or one-way call's value, kept for the developer dump (Session ▸ Copy Control
   * Traffic Dump) when it is at most `keptCallBytes`; undefined otherwise. It holds the server's
   * verbs and values verbatim: the session report never shows it.
   */
  callBytes: Uint8Array | undefined = undefined
  /** Reading R-CT-22: msg_info says the server goes on without the client (`ServerMessageInfo.isInterim`). */
  readonly isInterim: boolean
  /** The message carried ST_R3INFO STOP_TRANS. */
  readonly stopTrans: boolean
  /** The message carried screen content (`ControlItemScan.carriesScreen`). */
  readonly carriesScreen: boolean
  /** The RFC_TR items in order. */
  readonly items: readonly ControlTrafficItem[]
  /** The server's call after this message; undefined when the message carried no call part. */
  call: ControlTrafficCallProgress | undefined = undefined
  /**
   * The head of a complete or one-way call in structure (`RFCHead` in its report scope, issue #150):
   * each head item's id and length, what the report may say of the items Readings R-CT-28 and
   * R-CT-36 use, and the call's text encoding.
   */
  callHead: RFCHead | undefined = undefined
  /** What the session sent, when it sent something. */
  reply: ControlTrafficReply | undefined = undefined
  /** What the session did not understand or chose not to answer, in words (no value). */
  notes: string[] = []

  constructor(fields: { isInterim: boolean; stopTrans: boolean; carriesScreen: boolean; items: readonly ControlTrafficItem[] }) {
    this.isInterim = fields.isInterim
    this.stopTrans = fields.stopTrans
    this.carriesScreen = fields.carriesScreen
    this.items = fields.items
  }

  /**
   * Whether the server goes on by itself after this message, so a window keeps waiting for it: an
   * interim message, or one the session answered.
   */
  get serverContinues(): boolean {
    return this.isInterim || this.reply !== undefined
  }

  /** Whether the message is to be drawn as the screen: it carries screen content and is no interim message (Reading R-CT-22). */
  get showsScreen(): boolean {
    return this.carriesScreen && !this.isInterim
  }

  /** One line for a status bar: what arrived and what was sent, in counts. */
  get progressText(): string {
    if (this.isInterim && this.items.length === 0)
      return "The server is busy (an interim message" + (this.stopTrans ? ", STOP_TRANS" : "") + ")…"
    const call = this.call
    if (call === undefined) return `The server sent control data (${this.items.map(item => item.name).join(", ")})…`
    switch (call.kind) {
      case "part":
        return `Receiving control data: part ${call.parts}, ${ControlTraffic.size(call.bytes)} so far…`
      case "complete": {
        let answered: string
        switch (this.reply?.answer?.kind) {
          case "built":
            answered = "answered with Swooey's own answer"
            break
          case "fallback":
            answered = "answered empty: Swooey could not read the call"
            break
          case undefined:
            answered = "answered as a client without controls"
            break
        }
        return `Control data received (${call.parts} part(s), ${ControlTraffic.size(call.bytes)}); ${answered}…`
      }
      case "oneWay":
        return `The server sent control data that needs no answer (${ControlTraffic.size(call.bytes)})…`
      case "tooLarge":
        return "The server's control data is larger than Swooey keeps; it was dropped."
    }
  }

  /** A size for a status line: bytes below 1 KiB, else rounded KB. */
  static size(bytes: number): string {
    return bytes < 1024 ? `${bytes} bytes` : `${Math.floor((bytes + 512) / 1024)} KB` // not-protocol: display rounding
  }

  /**
   * The report's lines under `summary`: the call's head and text encoding, and the head of Swooey's
   * own answer (IMPL-CT-11, issue #150). Only the head items Readings R-CT-28 and R-CT-36 use are
   * described, by docs/capture.md's rules: protocol identifiers, one character, one or two digits,
   * handles, the releases of `00 13` and `00 12` when four digits, and the code-page descriptor
   * show; every other text by its form, length and kind; every other head item (the user, the
   * client, the host, `00 15`) by its id and length only.
   */
  get detailLines(): string[] {
    const lines: string[] = []
    const callHead = this.callHead
    if (callHead !== undefined) {
      lines.push("call head (items before the function name): " + callHead.encodingText)
      lines.push(...callHead.lines("  "))
    }
    const answer = this.reply?.answer
    if (answer?.kind === "built") {
      lines.push(`answer head (Swooey's, texts ${RFCTextEncoding.rawValue(answer.summary.textEncoding)}):`)
      lines.push(...answer.summary.headLines("  "))
    }
    return lines
  }

  /** A report line: the items, the call and the reply, in structure. */
  get summary(): string {
    const parts: string[] = []
    if (this.isInterim) parts.push("interim message (msg_info, R-CT-22)")
    if (this.stopTrans) parts.push("STOP_TRANS")
    if (this.items.length > 0) parts.push("RFC_TR: " + this.items.map(item => `${item.name} ${item.length} bytes`).join(", "))
    const call = this.call
    if (call !== undefined) {
      switch (call.kind) {
        case "part":
          parts.push(`call part ${call.parts}, ${call.bytes} bytes so far`)
          break
        case "complete":
          parts.push(`call complete: ${call.parts} part(s), ${call.bytes} bytes; ${call.summary.description}`)
          break
        case "oneWay":
          parts.push(`one-way call: ${call.bytes} bytes; ${call.summary.description}`)
          break
        case "tooLarge":
          parts.push(`call dropped after ${call.parts} part(s), ${call.bytes} bytes: too large`)
          break
      }
    }
    if (this.reply !== undefined) parts.push(`replied: step ${this.reply.stepNumber}, ${this.reply.itemText}`)
    parts.push(...this.notes)
    return parts.join("; ")
  }
}

// MARK: - The transport's state

/**
 * The reply the control transport asks for (`ControlTransport.read`): its RFC_TR item, its kind and
 * shape, and for Swooey's own answer the handle counter after it, which the session keeps once the
 * reply is written (`ControlTransport.commit`). (Swift internal.)
 */
export interface PlannedControlReply {
  /** The RFC_TR item, undefined for the envelope alone, whose shape is always the envelope's. */
  readonly transfer: RFCTransferValue | undefined
  readonly kind: ControlTrafficReplyKind
  readonly shape: ControlReadingsReplyShape
  /** The envelope the reply is built from. */
  readonly envelope: InputEnvelope
  readonly answer: ControlTrafficReplyAnswer | undefined
  /** The handle counter after a built answer. */
  readonly handles: ControlHandleCounter | undefined
}

/**
 * The control transport's state on one connection, kept by `SessionMachine`: a call under way per
 * mode, and the connection's handle counter (Reading R-CT-34: one per connection, for all its
 * modes). (Swift internal; a struct: `clone()` copies it.)
 */
export class ControlTransport {
  readings = new ControlReadings()
  private calls = new Map<number, RFCCallAssembler>()
  private _handles = new ControlHandleCounter()

  /** The handles Swooey's answers hand out on this connection. */
  get handles(): ControlHandleCounter {
    return this._handles.clone()
  }

  /** A copy: the readings, the calls under way and the handle counter. */
  clone(): ControlTransport {
    const copy = new ControlTransport()
    copy.readings = this.readings.clone()
    for (const [mode, assembler] of this.calls) copy.calls.set(mode, assembler.clone())
    copy._handles = this._handles.clone()
    return copy
  }

  /**
   * Reads `message`'s control traffic, or undefined when it has none: not an interim message and no
   * RFC_TR item. Returns the traffic and, when the Readings ask for a reply, the reply to send.
   */
  read(message: ServerMessage, identity: ClientIdentity): { traffic: ControlTraffic; reply: PlannedControlReply | undefined } | undefined {
    const header = message.header
    if (header === undefined || header.isError || message.screen === undefined) return undefined
    const scan = message.withItems(items => new ControlItemScan(items)) ?? new ControlItemScan()
    const interim = ServerMessageInfo.isInterim(header.msgInfo)
    if (!(interim || scan.rfcItems.length > 0)) return undefined
    const values: { item: RFCTransferItem; value: Uint8Array }[] =
      message.withItems(items => scan.rfcItems.map(item => ({ item, value: item.valueRange.of(items).slice() }))) ?? []
    const traffic = new ControlTraffic({
      isInterim: interim,
      stopTrans: scan.stopTrans,
      carriesScreen: scan.carriesScreen,
      items: scan.rfcItems.map(item => ({ sid: item.sid, length: item.length, name: item.name }))
    })
    const mode = header.mode
    let complete: RFCCall | undefined
    let announcesMore = false
    for (const { item, value } of values) {
      const sid = item.knownSID
      if (sid === "mor" && value.length === 0) {
        // Only a client sends an empty RFC_TR_MOR (PV-0907): from the server it is no part.
        traffic.notes.push("an empty RFC_TR_MOR from the server is no call part; not answered (R-CT-27)")
      } else if (sid === "mor" || sid === "req") {
        const final = sid === "req"
        let assembler = this.calls.get(mode)
        if (assembler === undefined) {
          assembler = new RFCCallAssembler()
          this.calls.set(mode, assembler)
        }
        const outcome = assembler.append(value, final)
        switch (outcome.kind) {
          case "more":
            traffic.call = { kind: "part", parts: outcome.parts, bytes: outcome.bytes }
            announcesMore = true
            break
          case "complete": {
            const call = outcome.value
            traffic.call = { kind: "complete", parts: call.parts, bytes: call.bytes.length, summary: call.summary }
            traffic.callHead = new RFCHead(call.bytes, "report")
            traffic.callBytes = call.bytes.length <= ControlTraffic.keptCallBytes ? call.bytes : undefined
            complete = call
            announcesMore = false
            break
          }
          case "tooLarge":
            traffic.call = { kind: "tooLarge", parts: outcome.parts, bytes: outcome.bytes }
            traffic.notes.push("the call was dropped: larger than Swooey keeps")
            announcesMore = false
            break
        }
      } else if (sid === "rnb") {
        traffic.call = { kind: "oneWay", bytes: value.length, summary: new RFCStreamSummary(value) }
        traffic.callHead = new RFCHead(value, "report")
        traffic.callBytes = value.length <= ControlTraffic.keptCallBytes ? value : undefined
      } else {
        traffic.notes.push(`${item.name} from the server is not understood; not answered`)
      }
    }
    if (interim) {
      if (complete !== undefined || announcesMore) traffic.notes.push("an interim message carried a call part; not answered (R-CT-22)")
      return { traffic, reply: undefined }
    }
    const readings = this.readings
    const envelope = readings.envelope ?? InputEnvelope.default(identity)
    if (complete !== undefined) {
      if (readings.callAnswer === "none") {
        traffic.notes.push("the call is not answered: the Readings say none")
        return { traffic, reply: undefined }
      }
      const answerSID = ControlReadingsCallAnswer.sid(readings.callAnswer)
      let transfer = answerSID === undefined ? undefined : new RFCTransferValue(answerSID)
      let answer: ControlTrafficReplyAnswer | undefined
      let counter: ControlHandleCounter | undefined
      if (readings.callAnswer === "built") {
        try {
          const head = ControlReadingsHeadValues.head(readings.headValues, message.codePage)
          const built = FlushCallAnswerBuilder.answer(complete.bytes, this._handles, head)
          transfer = new RFCTransferValue("ret", built.value)
          answer = { kind: "built", summary: built.summary }
          counter = built.handles
        } catch (error) {
          if (!(error instanceof FlushCallReadError)) throw error
          answer = { kind: "fallback", error: error.info }
          traffic.notes.push(`Swooey could not read the call (${error.message}); answered with an empty RFC_TR_RET (R-CT-35)`)
        }
      }
      return {
        traffic,
        reply: {
          transfer,
          kind: { kind: "callAnswer", value: readings.callAnswer },
          shape: readings.replyShape,
          envelope,
          answer,
          handles: counter
        }
      }
    }
    if (announcesMore) {
      if (readings.partReply === "none") {
        traffic.notes.push("the part is not acknowledged: the Readings say none")
        return { traffic, reply: undefined }
      }
      const partSID = ControlReadingsPartReply.sid(readings.partReply)
      const transfer = partSID === undefined ? undefined : new RFCTransferValue(partSID)
      return {
        traffic,
        reply: {
          transfer,
          kind: { kind: "partReply", value: readings.partReply },
          shape: transfer === undefined ? "envelope" : readings.replyShape,
          envelope,
          answer: undefined,
          handles: undefined
        }
      }
    }
    if (traffic.call === undefined || !scan.carriesScreen) traffic.notes.push("nothing to answer; if the server waits, Enter sends the screen again")
    return { traffic, reply: undefined }
  }

  /**
   * Keeps the handle counter of a reply that was written (Reading R-CT-34: a number a written answer
   * handed out is never used again; one of an answer that was not written never went out).
   */
  commit(reply: PlannedControlReply): void {
    if (reply.handles !== undefined) this._handles = reply.handles.clone()
  }

  /** Forgets the calls of `mode`, which ended. The handle counter belongs to the connection and stays. */
  end(mode: number): void {
    this.calls.delete(mode)
  }
}
