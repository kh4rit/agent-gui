// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ClientMessages.swift (MIT).

// The client's messages (docs/protocol/session.md §1, §4; diag-header.md, "Client message
// headers"): the first message, dialog messages and the clean close. The encoder produces frame
// payloads; DiagWire's NIFrameEncoder adds the NI length.

import { LZHEncoder, LZHEncodingError } from "../compression/index.js"
import { ByteWriter, DPHeader, DPHeaderError, bytesEqual, type DPTerminalName } from "../wire/index.js"
import { ApplItem } from "./applRegistry.js"
import { CompressionHeader } from "./compressionHeader.js"
import { isUInt32 } from "./diagCodec.js"
import { DiagHeader } from "./diagHeader.js"
import { DiagItemEncoder, DiagItemEncodingError, DiagItemLayout, DiagItemType, type DiagItemEncodingErrorInfo } from "./diagItem.js"
import { DialogStepNumber, ProtocolVersion, SupportBits, UserConnect } from "./sessionItems.js"
import type { SESValue } from "./simpleItemValues.js"

/**
 * What the client declares about itself in its first message.
 *
 * None of these has a default, on purpose. They are project decisions of spike P1's ADR, not facts
 * the sources supply, and the client identifies itself honestly and declares only capabilities it
 * implements (CLEANROOM.md §1 rule 6, IMPL-IT-7):
 * - `codePage`: which code page an honest client requests is #18 (the reference client sends 1100,
 *   whose character set no source states);
 * - `wsType`: no source defines a value for a native Mac front end (#16);
 * - `supportData`: the capability mask (#17).
 *
 * The terminal name of the DP header is the machine's real host name (IMPL-DP-1), passed as a
 * `DPTerminalName`.
 *
 * A Swift struct: `clone()` copies it (the mask included) where Swift copies the value.
 */
export class ClientIdentity {
  codePage: number
  wsType: number
  supportData: SupportBits

  constructor(fields: { codePage: number; wsType: number; supportData: SupportBits }) {
    this.codePage = fields.codePage
    this.wsType = fields.wsType
    this.supportData = fields.supportData
  }

  /** A copy, the mask included. */
  clone(): ClientIdentity {
    return new ClientIdentity({ codePage: this.codePage, wsType: this.wsType, supportData: this.supportData.clone() })
  }

  /** Swift's `==`: the same code page, ws_type and mask. */
  equals(other: ClientIdentity): boolean {
    return this.codePage === other.codePage && this.wsType === other.wsType && bytesEqual(this.supportData.bytes, other.supportData.bytes)
  }
}

/**
 * The client's compression choice for a connection. It selects the CONNECT protocol_version and the
 * compress byte of later client messages (PV-0317). The first message and the close message are
 * never compressed.
 * - `off`: protocol_version 200; later messages carry compress 0. Swooey's setting until spike P4
 *   settles whether the server needs or accepts compressed client messages (IMPL-DH-4).
 * - `lzh`: protocol_version 100200; later messages carry compress 1 and an LZH body with byte 4 =
 *   0x12 and byte 7 = 2, as a compressing DIAG client writes them (PV-0316, IMPL-CH-7). Kept behind
 *   this flag until spike P4 (IMPL-DH-4).
 */
export type ClientCompression = "off" | "lzh"

export const ClientCompression = {
  /** The CONNECT protocol_version this choice declares (PV-0120, PV-0121, PV-0317). */
  protocolVersion(compression: ClientCompression): number {
    switch (compression) {
      case "off":
        return ProtocolVersion.uncompressed
      case "lzh":
        return ProtocolVersion.compressed
    }
  }
} as const

/**
 * The items a dialog message may carry between its DIALOG_STEP_NUMBER and its EOM, with the
 * carriers of R-IT-10. Nothing else is sent until #31 (carriers), #33 (payloads and the item set of
 * user input) and #20 (XMLBLOB) allow it (IMPL-IT-10); OKC and SBA2 are never sent.
 */
export type ClientItem =
  /** An SES simple item (PV-0420); the filler is written as `00 00` (R-IT-12). */
  | { readonly kind: "ses"; readonly value: SESValue }
  /** `DYNN CHL` (0x05/0x01) as APPL. Its value is opaque (#32); at most 65 535 bytes. */
  | { readonly kind: "dynnCHL"; readonly value: Uint8Array }
  /** `DYNT DYNT_ATOM` (0x09/0x02) as APPL4: an atom sequence (dynt-atoms.md). */
  | { readonly kind: "dyntAtom"; readonly value: Uint8Array }
  /**
   * `VARINFO OKCODE` (0x0c/0x04) as APPL, its whole value the text (PV-0708). Sent only under
   * client-input.md's unconfirmed Reading R-CI-6, when a caller opts in (ClientInputStep's
   * `varInfoOKCode` trigger); which trigger a real server needs is #55.
   */
  | { readonly kind: "varInfoOKCode"; readonly text: Uint8Array }

export const ClientItem = {
  ses: (value: SESValue): ClientItem => ({ kind: "ses", value }),
  dynnCHL: (value: Uint8Array): ClientItem => ({ kind: "dynnCHL", value }),
  dyntAtom: (value: Uint8Array): ClientItem => ({ kind: "dyntAtom", value }),
  varInfoOKCode: (text: Uint8Array): ClientItem => ({ kind: "varInfoOKCode", text })
} as const

/** Why a client message could not be built. Nothing is sent and the step counter is unchanged. */
export type ClientMessageErrorInfo =
  /**
   * The message needs a fact the spec does not state; `issue` names the gap. No path throws it since
   * modes other than 0 became Reading R-MO-2 (session.md §8); kept for the next gap.
   */
  | { readonly kind: "specGap"; readonly issue: number }
  /** An item value does not fit its carrier's length field. */
  | { readonly kind: "item"; readonly error: DiagItemEncodingErrorInfo }
  /**
   * The per-connection step counter is at its u32 maximum. What a server does with step numbers is
   * #15; Swooey does not wrap the counter.
   */
  | { readonly kind: "stepNumberExhausted" }
  /** The message is longer than a u32 length can declare. */
  | { readonly kind: "messageTooLong"; readonly byteCount: number }

export class ClientMessageError extends Error {
  constructor(readonly info: ClientMessageErrorInfo) {
    super(describeClientMessageError(info))
    this.name = "ClientMessageError"
  }
}

function describeClientMessageError(info: ClientMessageErrorInfo): string {
  switch (info.kind) {
    case "specGap":
      return `client message: spec gap #${info.issue}`
    case "item":
      return `client message: ${new DiagItemEncodingError(info.error).message}`
    case "stepNumberExhausted":
      return "client message: the step counter is at its u32 maximum"
    case "messageTooLong":
      return `client message: ${info.byteCount} bytes, longer than a u32 length`
  }
}

/** The options of `ClientMessageEncoder.composeDialogMessage` (Swift's internal `dialogMessage(mode:modeStat:…)`). */
export interface DialogMessageOptions {
  mode: number
  modeStat: number
  /** The server's step, echoed under client-input.md Reading R-CI-12; undefined for the next own step. */
  stepNumber: number | undefined
  /** The control-reply header (msg_info 0x01, Reading R-CT-26) instead of the later-message header. */
  controlReply?: boolean
  /** The step becomes `lastStepNumber` only when it is higher. */
  counterOnlyGrows?: boolean
}

/**
 * Builds the frame payloads of the client's messages on one connection, in the patterns of pysap's
 * client, the only public client (IMPL-DH-9, R-SE-1, R-SE-3):
 *
 * ```
 * first message    DP header (200) | 00 10 00 00 00 00 00 00 | APPL ST_USER CONNECT | APPL ST_USER SUPPORTDATA
 * dialog message   mm 00 00 00 00 00 00 cc | APPL ST_USER DIALOG_STEP_NUMBER | items … | EOM
 * close            00 02 00 00 00 00 00 00
 * ```
 *
 * `mm` is the mode the dialog message belongs to, 0 for the first (Reading R-MO-2, PV-0542). The step
 * counter is per connection: the first dialog message carries step 1, and each next one the previous
 * step + 1 (PV-0521). Whether a server checks it, or counts per mode, is #15.
 *
 * A Swift struct with mutating methods: `clone()` copies it where Swift copies the value.
 */
export class ClientMessageEncoder {
  /** DIAG part of the first message: header, CONNECT item (5 + 12) and SUPPORTDATA item (5 + 32). */
  static readonly firstMessageDiagSize = DiagHeader.size + DiagItemLayout.applValueOffset * 2 + UserConnect.size + SupportBits.byteCount // not-protocol: capacity hint

  readonly identity: ClientIdentity
  /** The step number of the last dialog message built; 0 before the first (PV-0521). */
  lastStepNumber = 0
  /** Created with the first compressed dialog message. */
  private lzh: LZHEncoder | undefined

  /**
   * An encoder for one connection. `compression` defaults to `off`, the only setting Swooey uses
   * until spike P4 (IMPL-DH-4). The identity is copied.
   */
  constructor(
    identity: ClientIdentity,
    readonly terminal: DPTerminalName,
    readonly compression: ClientCompression = "off"
  ) {
    this.identity = identity.clone()
  }

  /** A copy of this encoder, its step counter included. */
  clone(): ClientMessageEncoder {
    const copy = new ClientMessageEncoder(this.identity, this.terminal, this.compression)
    copy.lastStepNumber = this.lastStepNumber
    return copy
  }

  /**
   * The CONNECT value this encoder sends: the compression choice's protocol_version and the
   * identity's code page and ws_type.
   */
  get userConnect(): UserConnect {
    return new UserConnect({
      protocolVersion: ClientCompression.protocolVersion(this.compression),
      codePage: this.identity.codePage,
      wsType: this.identity.wsType
    })
  }

  /**
   * The payload of the client's first frame (session.md §1): the first-message DP header (IMPL-DP-2,
   * with the DP length of the DIAG part), the first-message DIAG header (PV-0300), then exactly two
   * APPL items, ST_USER CONNECT and ST_USER SUPPORTDATA, and no EOM (PV-0525). It is uncompressed
   * whatever the compression choice (PV-0127, PV-0317). Throws `ClientMessageError`.
   */
  firstMessage(): Uint8Array {
    const diag = new ByteWriter(ClientMessageEncoder.firstMessageDiagSize)
    DiagHeader.clientFirstMessage.serialize(diag)
    ClientMessageEncoder.appendAPPL(ApplItem.stUser("connect"), this.userConnect.bytes, diag)
    ClientMessageEncoder.appendAPPL(ApplItem.stUser("supportData"), this.identity.supportData.bytes, diag)
    try {
      return DPHeader.firstMessagePayload(this.terminal, diag.toBytes())
    } catch (error) {
      if (error instanceof DPHeaderError) throw new ClientMessageError({ kind: "messageTooLong", byteCount: diag.length })
      throw error
    }
  }

  /**
   * The payload of the next dialog message (session.md §4.2): the later-message DIAG header
   * (PV-0301), an APPL ST_USER DIALOG_STEP_NUMBER item first with the next step number, the given
   * items, and an EOM item last (PV-0524). With `lzh` the items are the LZH-compressed body after a
   * compression header (PV-0316).
   *
   * `mode` is the target mode, 0 for the first: the header's mode byte names it (Reading R-MO-2,
   * PV-0542; session.md §8). Throws `ClientMessageError`.
   */
  dialogMessage(items: readonly ClientItem[], mode = 0): Uint8Array {
    return this.dialogMessageWithEvent(items, undefined, mode)
  }

  /**
   * A dialog message whose items end with `UI_EVENT UI_EVENT_SOURCE` (0x0f/0x01) as APPL with
   * `uiEvent` as its value, when one is given: the event that fired a function (client-input.md
   * §7.5, Reading R-CI-10). Wireshark decodes the item under APPL only (§7.2). (Swift's internal
   * `dialogMessage(_:uiEvent:mode:)`.)
   */
  dialogMessageWithEvent(items: readonly ClientItem[], uiEvent: Uint8Array | undefined, mode: number): Uint8Array {
    return this.composeDialogMessage({ mode, modeStat: 0, stepNumber: undefined }, body => {
      for (const item of items) ClientMessageEncoder.appendClientItem(item, body)
      if (uiEvent !== undefined) ClientMessageEncoder.appendAPPL(ApplItem.uiEvent("uiEventSource"), uiEvent, body)
    })
  }

  /**
   * A dialog message: the later-message DIAG header with `modeStat`, DIALOG_STEP_NUMBER, the items
   * `appendItems` writes, EOM. The step is `stepNumber` when one is given (the server's, echoed
   * under client-input.md Reading R-CI-12), else the next per-connection step; either way it becomes
   * `lastStepNumber`, or with `counterOnlyGrows` only when it is higher. `modeStat` other than 0 is
   * the echo of R-CI-12 too. (Swift's internal `dialogMessage(mode:modeStat:stepNumber:…)`.)
   * `appendItems` throws `ClientMessageError` to refuse the message; the counter is then unchanged.
   */
  composeDialogMessage(options: DialogMessageOptions, appendItems: (body: ByteWriter) => void): Uint8Array {
    let step: number
    if (options.stepNumber !== undefined) {
      step = options.stepNumber
    } else {
      if (!(this.lastStepNumber < 0xffffffff)) throw new ClientMessageError({ kind: "stepNumberExhausted" })
      step = this.lastStepNumber + 1
    }
    const body = new ByteWriter()
    ClientMessageEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(step).bytes, body)
    appendItems(body)
    DiagItemEncoder.appendEOM(body)

    const header = (compressed: boolean): DiagHeader =>
      options.controlReply === true
        ? DiagHeader.clientControlReply(compressed, options.modeStat, options.mode)
        : DiagHeader.clientLaterMessage(compressed, options.modeStat, options.mode)
    const output = new ByteWriter(DiagHeader.size + body.length)
    switch (this.compression) {
      case "off":
        header(false).serialize(output)
        output.bytes(body.toBytes())
        break
      case "lzh": {
        if (!isUInt32(body.length)) throw new ClientMessageError({ kind: "messageTooLong", byteCount: body.length })
        header(true).serialize(output)
        CompressionHeader.clientLZH(body.length).serialize(output)
        this.lzh ??= new LZHEncoder()
        // The body holds at least the step item and EOM, so it is never empty (PV-0315); the encoder
        // refuses only inputs above 2 GiB.
        try {
          this.lzh.encodeInto(body.toBytes(), output)
        } catch (error) {
          if (error instanceof LZHEncodingError) throw new ClientMessageError({ kind: "messageTooLong", byteCount: body.length })
          throw error
        }
        break
      }
    }
    this.lastStepNumber = options.counterOnlyGrows === true ? Math.max(this.lastStepNumber, step) : step
    return output.toBytes()
  }

  /** The payload of the client's close message (PV-0302): the close header alone, no items. */
  static get closeMessage(): Uint8Array {
    return DiagHeader.clientClose.bytes
  }

  // MARK: Items

  static appendClientItem(item: ClientItem, output: ByteWriter): void {
    switch (item.kind) {
      case "ses":
        output.u8(DiagItemType.rawValue("ses"))
        item.value.append(output)
        return
      case "dynnCHL":
        ClientMessageEncoder.appendAPPL(ApplItem.dynn("chl"), item.value, output)
        return
      case "dyntAtom":
        try {
          DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), item.value, output)
        } catch (error) {
          if (error instanceof DiagItemEncodingError) throw new ClientMessageError({ kind: "item", error: error.info })
          throw error
        }
        return
      case "varInfoOKCode":
        ClientMessageEncoder.appendAPPL(ApplItem.varInfo("okcode"), item.text, output)
        return
    }
  }

  /** Appends an APPL item; a value its length field cannot declare throws `ClientMessageError.item`. (Swift: private.) */
  static appendAPPL(item: ApplItem, value: Uint8Array, output: ByteWriter): void {
    try {
      DiagItemEncoder.appendAPPL(item, value, output)
    } catch (error) {
      if (error instanceof DiagItemEncodingError) throw new ClientMessageError({ kind: "item", error: error.info })
      throw error
    }
  }
}
