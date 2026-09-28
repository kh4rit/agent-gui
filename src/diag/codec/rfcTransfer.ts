// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/RFCTransfer.swift (MIT).

// What a client without controls reads of the server's Control Framework traffic
// (docs/protocol/controls/transport.md §2.3, rfc-tr.md): the RFC_TR items of a server message, a
// call assembled from its parts, a structural summary of the call's RFC item stream, and whether a
// message is an interim message the server follows with another one on its own.
//
// Nothing here interprets a call's data. The summary keeps item ids, counts and lengths; the one
// text it may show is the called function's name, and only when the spec lists that name as a
// protocol identifier (`RFCStreamSummary.listedFunctionNames`).

import { ByteWriter, WireBytes } from "../wire/index.js"
import { ApplSID, type ApplSIDRfcTr } from "./applRegistry.js"
import { ByteRange } from "./diagCodec.js"
import { DiagItemWalkError, DiagItemWalker, type DiagItem } from "./diagItem.js"
import { applItemCarriesDyntAtoms } from "./dyntAtom.js"
import { RFCTextForm } from "./rfcText.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/**
 * What the DIAG header's msg_info byte says about a server message (transport.md §2.3, Reading
 * R-CT-22). Nothing more of msg_info is known (#6).
 */
export const ServerMessageInfo = {
  /**
   * The bit the owner's server set on the messages it sent one after another without waiting for
   * the client, and ODG saw on the status frames that redraw nothing (PV-0904).
   */
  interimBit: 0x02, // provenance: PV-0904
  /**
   * The bit of the messages after which the server waited for the client: every screen and the
   * message that carried a control call part (PV-0904, PV-0905).
   */
  waitsBit: 0x01, // provenance: PV-0904

  /**
   * Reading R-CT-22: a message with `interimBit` set and `waitsBit` clear is an interim message.
   * The server sends the next message without the client's input, so the client neither answers
   * it nor draws it as the screen.
   */
  isInterim(msgInfo: number): boolean {
    return (msgInfo & ServerMessageInfo.interimBit) !== 0 && (msgInfo & ServerMessageInfo.waitsBit) === 0
  }
} as const

/** `0x0C`: a byte as two uppercase hex digits after `0x`. */
function hexByteText(byte: number): string {
  return "0x" + (byte & 0xff).toString(16).toUpperCase().padStart(2, "0") // not-protocol: two hex digits
}

/**
 * One RFC_TR item (APPL 0x08, PV-0900) of a server message: its sid and where its value lies in
 * the message's item sequence.
 */
export class RFCTransferItem {
  constructor(
    /** The sid byte; the registry names 0x00–0x0B (PV-0457). */
    readonly sid: number,
    /** The value's range in the item sequence. */
    readonly valueRange: ByteRange
  ) {}

  /** The registry's sid, or undefined for a sid it does not list. */
  get knownSID(): ApplSIDRfcTr | undefined {
    return ApplSID.RfcTr.fromRaw(this.sid)
  }

  /** The value's length in bytes. */
  get length(): number {
    return this.valueRange.count
  }

  /** `RFC_TR_MOR`, or `RFC_TR sid 0x0C` for a sid the registry does not list. */
  get name(): string {
    const known = this.knownSID
    return known !== undefined ? ApplSID.RfcTr.name(known) : "RFC_TR sid " + RFCTransferItem.hex(this.sid)
  }

  static hex(byte: number): string {
    return hexByteText(byte)
  }
}

/** Swift `try? walker.next(in:)`: the next item, or undefined at the end or when the walk stops. */
function nextItem(walker: DiagItemWalker, items: Uint8Array): DiagItem | undefined {
  try {
    return walker.next(items)
  } catch (error) {
    if (error instanceof DiagItemWalkError) return undefined
    throw error
  }
}

/**
 * What the control transport reads of one server message's items, in one tolerant walk: its
 * RFC_TR items in order, whether it carries screen content, and whether it carries ST_R3INFO
 * STOP_TRANS. A walk that stops keeps what it found before the stop.
 */
export class ControlItemScan {
  /** The RFC_TR items, in item order. */
  readonly rfcItems: RFCTransferItem[] = []
  /**
   * Whether the message carries anything a screen is drawn from: DYNT atoms (DYNT_ATOM or
   * DYNT_TABSTRIP_BUTTONS), VARINFO AREASIZE or a MNUENTRY menu. The ST_R3INFO identity block alone
   * is no screen: the owner's server sent it with a call part (PV-0905).
   */
  carriesScreen = false
  /**
   * Whether the message carries ST_R3INFO STOP_TRANS (0x06/0x15, PV-0455), as the owner's interim
   * messages did (PV-0904).
   */
  stopTrans = false

  /** An empty scan, or (Swift `init(items:)`) the scan of `items`. */
  constructor(items?: Uint8Array) {
    if (items === undefined) return
    const walker = new DiagItemWalker()
    for (let item = nextItem(walker, items); item !== undefined; item = nextItem(walker, items)) {
      const appl = item.appl
      if (appl === undefined) continue
      if (appl.kind === "rfcTR") {
        this.rfcItems.push(new RFCTransferItem(ApplSID.RfcTr.rawValue(appl.sid), item.valueRange))
      } else if (appl.kind === "unknownSID" && appl.applID === "rfcTR") {
        this.rfcItems.push(new RFCTransferItem(appl.sid, item.valueRange))
      } else if (appl.kind === "stSystemInfo" && appl.sid === "stopTrans") {
        this.stopTrans = true
      } else if ((appl.kind === "varInfo" && appl.sid === "areaSize") || appl.kind === "mnuEntry") {
        this.carriesScreen = true
      } else if (applItemCarriesDyntAtoms(appl)) {
        this.carriesScreen = true
      }
    }
  }
}

/** What one appended part did (Swift `RFCCallAssembler.Outcome`). */
export type RFCCallAssemblerOutcome =
  /** More parts are to come. */
  | { readonly kind: "more"; readonly parts: number; readonly bytes: number }
  /** The call is complete. */
  | { readonly kind: "complete"; readonly value: RFCCall }
  /** The call grew past `maxCallBytes`; its bytes were dropped. */
  | { readonly kind: "tooLarge"; readonly parts: number; readonly bytes: number }

/**
 * A server call assembled from its parts (transport.md §2.3, Reading R-CT-23): the values of the
 * RFC_TR_MOR items that announce more, then the value of RFC_TR_REQ or the one-way RFC_TR_RNB
 * (Reading R-CT-42) that ends the call, concatenated in arrival order. One assembler per mode.
 */
export class RFCCallAssembler {
  /** The most bytes one call may hold; more ends the call as `tooLarge`. */
  static readonly maxCallBytes = 64 * 1024 * 1024 // not-protocol: a memory cap, 64 MiB

  private _parts = 0
  private bytes = new ByteWriter()

  /** This assembler's cap: `maxCallBytes` unless given. */
  constructor(readonly maxBytes: number = RFCCallAssembler.maxCallBytes) {}

  /** Parts appended since the last call ended. */
  get parts(): number {
    return this._parts
  }

  /** The bytes appended since the last call ended. */
  get byteCount(): number {
    return this.bytes.length
  }

  /** Whether a call is under way: a part arrived and its end did not. */
  get isAssembling(): boolean {
    return this._parts > 0
  }

  /** Appends one part's value; `final` for the part that ends the call. */
  append(value: Uint8Array, final: boolean): RFCCallAssemblerOutcome {
    this._parts += 1
    const total = this.bytes.length + value.length
    if (!(total <= this.maxBytes)) {
      const parts = this._parts
      this.reset()
      return { kind: "tooLarge", parts, bytes: total }
    }
    this.bytes.bytes(value)
    if (!final) return { kind: "more", parts: this._parts, bytes: this.bytes.length }
    const call = new RFCCall(this._parts, this.bytes.toBytes())
    this.reset()
    return { kind: "complete", value: call }
  }

  /** Forgets a call under way. */
  reset(): void {
    this._parts = 0
    this.bytes = new ByteWriter()
  }

  /** A copy, the call under way included (Swift copies the struct on assignment). */
  clone(): RFCCallAssembler {
    const copy = new RFCCallAssembler(this.maxBytes)
    copy._parts = this._parts
    copy.bytes.bytes(this.bytes.toBytes())
    return copy
  }
}

/**
 * A complete server call: its parts and bytes. The bytes are the server's data and are never
 * printed; `summary` holds what a report may show.
 */
export class RFCCall {
  constructor(
    /** How many RFC_TR items it came in. */
    readonly parts: number,
    /** The call's value, all parts concatenated. */
    readonly bytes: Uint8Array
  ) {}

  /** The structure of its RFC item stream (`RFCStreamSummary`). */
  get summary(): RFCStreamSummary {
    return new RFCStreamSummary(this.bytes)
  }

  /** Counts only: the bytes are the server's data. */
  get description(): string {
    return `RFCCall(parts: ${this.parts}, bytes: ${this.bytes.length})`
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

// MARK: - RFC item stream

/**
 * One item of an RFC item stream (rfc-tr.md §3, PV-0910): a two-byte id, a u16 BE length, the value
 * and a trailing id pair. Scalar parameters may extend the length with PV-1022's u32.
 */
export interface RFCItem {
  /** The id, id1 then id2, as one u16 BE number. */
  readonly id: number
  /** The value's range in the stream. */
  readonly valueRange: ByteRange
  /** Whether the trailing pair repeats the id (PV-0919); undefined when the stream ended before it. */
  readonly trailerMatches: boolean | undefined
}

/** Why an RFC item walk stopped (IMPL-CT-2). */
export type RFCItemWalkErrorInfo =
  /** The input ends inside the id, the length or the value of item `itemIndex` (from 1). */
  { readonly kind: "truncated"; readonly itemIndex: number }

export class RFCItemWalkError extends Error {
  constructor(readonly info: RFCItemWalkErrorInfo) {
    super(`RFC item walk: truncated in item ${info.itemIndex}`)
    this.name = "RFCItemWalkError"
  }
}

/**
 * Walks an RFC item stream as IMPL-CT-2 says: the id, the u16 BE length, the value and the two
 * trailing bytes, repeated. It stops after the item with id `FF FF` (PV-0911), whose length, value
 * and trailing pair it still reads when present, or at the end of the input. The trailing pair is
 * not checked; a pair that is not the item's id is reported (`RFCItem.trailerMatches`), not
 * rejected.
 */
export class RFCItemWalker {
  /** The end-of-message id (PV-0911). */
  static readonly endID = 0xffff // provenance: PV-0911
  /** Bytes of an id or of a length field (PV-0910). */
  static readonly fieldSize = 2 // provenance: PV-0910

  private offset = 0
  private index = 0
  private ended = false

  /** The next item, or undefined at the end of the input or after the end item. Throws `RFCItemWalkError`. */
  next(stream: Uint8Array): RFCItem | undefined {
    if (this.ended || !(this.offset < stream.length)) return undefined
    this.index += 1
    const size = RFCItemWalker.fieldSize
    if (!(stream.length - this.offset >= size)) throw new RFCItemWalkError({ kind: "truncated", itemIndex: this.index })
    const id = WireBytes.u16BigEndian(stream, this.offset) // provenance: PV-0910
    const lengthOffset = this.offset + size
    if (id === RFCItemWalker.endID) {
      this.ended = true
      // The end item's length, value and trailer are read when present.
      if (!(stream.length - lengthOffset >= size)) {
        this.offset = stream.length
        return { id, valueRange: new ByteRange(lengthOffset, lengthOffset), trailerMatches: undefined }
      }
    }
    if (!(stream.length - lengthOffset >= size)) throw new RFCItemWalkError({ kind: "truncated", itemIndex: this.index })
    let length = WireBytes.u16BigEndian(stream, lengthOffset) // provenance: PV-0910
    let valueOffset = lengthOffset + size
    // Long scalar parameters use FFFF followed by a u32 BE byte length. Other item
    // kinds retain their ordinary u16 lengths; no broader escape rule is inferred.
    // provenance: PV-1022
    if (id === 0x0203 && length === 0xffff) {
      if (!(stream.length - valueOffset >= 4)) throw new RFCItemWalkError({ kind: "truncated", itemIndex: this.index })
      length = WireBytes.u32BigEndian(stream, valueOffset)
      valueOffset += 4
    }
    if (!(length <= stream.length - valueOffset)) {
      if (this.ended) {
        this.offset = stream.length
        return { id, valueRange: new ByteRange(valueOffset, stream.length), trailerMatches: undefined }
      }
      throw new RFCItemWalkError({ kind: "truncated", itemIndex: this.index })
    }
    const trailerOffset = valueOffset + length
    let matches: boolean | undefined
    if (stream.length - trailerOffset >= size) {
      matches = WireBytes.u16BigEndian(stream, trailerOffset) === id // provenance: PV-0919
      this.offset = trailerOffset + size
    } else {
      this.offset = stream.length
    }
    return { id, valueRange: new ByteRange(valueOffset, trailerOffset), trailerMatches: matches }
  }
}

/** An id and how often it came (Swift `RFCStreamSummary.IDCount`). */
export interface RFCStreamIDCount {
  readonly id: number
  readonly count: number
}

/**
 * The structure of a call's RFC item stream, for the session report (transport.md §2.3,
 * IMPL-CT-11): how many items, which ids in first-seen order with their counts, whether the end item
 * came, where the walk stopped, and the called function's name when the spec lists it. No value is
 * kept.
 *
 * The stream is walked from its first byte (Reading R-CT-6, #79). A stream that is no RFC item
 * stream at all stops early and says so; nothing depends on the walk.
 */
export class RFCStreamSummary {
  /**
   * The function names the spec states as protocol identifiers: the automation queue's flush call
   * (rfc-tr.md §7.1), the progress indicator (transport.md §2.1), and the GUI-core blob parser
   * (transport.md §9), and the frontend data request (data-provider.md §5). Any other name is
   * reported by its length only. The blob parser's name is `GUIBlob.functionName`, written out here
   * because guiBlob.ts imports this file.
   */
  static readonly listedFunctionNames: ReadonlySet<string> = new Set([
    "OLE_FLUSH_CALL",
    "SAPGUI_PROGRESS_INDICATOR",
    "GUICORE_BLOB_DIAG_PARSER", // GUIBlob.functionName, provenance: PV-1020
    "DP_GET_CLIENT_TABLE45A" // provenance: PV-1021
  ])
  /** The RFC item id of a function name (PV-0912). */
  static readonly functionNameID = 0x0102 // provenance: PV-0912

  /** Items walked. */
  itemCount = 0
  /** Each id in the order it first came, with its count. */
  ids: RFCStreamIDCount[] = []
  /** Whether the end item `FF FF` came (PV-0911). */
  reachedEnd = false
  /** The item the walk stopped in, when it did (IMPL-CT-2). */
  stop: RFCItemWalkErrorInfo | undefined = undefined
  /** Items whose trailing pair is not their id (PV-0919). */
  mismatchedTrailers = 0
  /** The first function-name item's text when it is one of `listedFunctionNames`. */
  functionName: string | undefined = undefined
  /** The first function-name item's length when its text is not listed. */
  withheldFunctionNameLength: number | undefined = undefined
  /**
   * The first function-name item's form on the wire (issue #150): ASCII, zero-padded, UTF-16LE or
   * UTF-16BE; undefined when it is no text.
   */
  functionNameForm: RFCTextForm | undefined = undefined
  /** The first function-name item's length. */
  functionNameLength: number | undefined = undefined
  /** Bytes after the end item. */
  trailingBytes = 0

  constructor(stream: Uint8Array) {
    const walker = new RFCItemWalker()
    const counts = new Map<number, number>()
    const order: number[] = []
    let consumed = 0
    try {
      for (let item = walker.next(stream); item !== undefined; item = walker.next(stream)) {
        this.itemCount += 1
        if (!counts.has(item.id)) order.push(item.id)
        counts.set(item.id, (counts.get(item.id) ?? 0) + 1)
        if (item.trailerMatches === false) this.mismatchedTrailers += 1
        consumed = item.valueRange.upperBound + (item.trailerMatches === undefined ? 0 : RFCItemWalker.fieldSize)
        if (item.id === RFCStreamSummary.functionNameID && this.functionName === undefined && this.withheldFunctionNameLength === undefined)
          this.readFunctionName(item.valueRange.of(stream))
        if (item.id === RFCItemWalker.endID) this.reachedEnd = true
      }
    } catch (error) {
      if (!(error instanceof RFCItemWalkError)) throw error
      this.stop = error.info
    }
    this.ids = order.map(id => ({ id, count: counts.get(id) ?? 0 }))
    if (this.reachedEnd) this.trailingBytes = Math.max(stream.length - consumed, 0)
  }

  private readFunctionName(value: Uint8Array): void {
    this.functionNameForm = RFCTextForm.of(value)
    this.functionNameLength = value.length
    let text = ""
    for (let index = 0; index < value.length; index++) {
      const byte = value[index]
      // Printable ASCII only, trailing spaces and zero bytes cut.
      if (!(byte >= 0x20 && byte < 0x7f)) {
        // not-protocol: printable ASCII
        if (byte === 0) continue
        this.withheldFunctionNameLength = value.length
        return
      }
      text += String.fromCharCode(byte)
    }
    while (text.endsWith(" ")) text = text.slice(0, -1)
    if (RFCStreamSummary.listedFunctionNames.has(text)) this.functionName = text
    else this.withheldFunctionNameLength = value.length
  }

  /** One line: items, ids, end, stop, and the function name as far as it may be shown. */
  get description(): string {
    const parts = [`${this.itemCount} RFC item(s)`]
    if (this.ids.length > 0)
      parts.push("ids " + this.ids.map(entry => RFCStreamSummary.hex(entry.id) + (entry.count > 1 ? ` ×${entry.count}` : "")).join(", "))
    if (this.functionName !== undefined) {
      parts.push(`function ${this.functionName}` + this.formText)
    } else if (this.withheldFunctionNameLength !== undefined) {
      parts.push(`a function name of ${this.withheldFunctionNameLength} bytes (not one the spec lists; withheld)` + this.formText)
    }
    parts.push(this.reachedEnd ? "end item FF FF" : "no end item")
    if (this.stop?.kind === "truncated")
      parts.push(`the walk stopped in item ${this.stop.itemIndex} (not an RFC item stream from its first byte, or cut short; #79)`)
    if (this.mismatchedTrailers > 0) parts.push(`${this.mismatchedTrailers} trailing pair(s) not the item's id`)
    if (this.trailingBytes > 0) parts.push(`${this.trailingBytes} byte(s) after the end item`)
    return parts.join("; ")
  }

  toString(): string {
    return this.description
  }

  /** The function name's form and length when it is not plain ASCII (issue #150). */
  get formText(): string {
    const form = this.functionNameForm
    if (form === undefined || form === "ascii" || this.functionNameLength === undefined) return ""
    return ` (${RFCTextForm.rawValue(form)}, ${this.functionNameLength} bytes)`
  }

  /** An id as its two bytes: `01 02`. */
  static hex(id: number): string {
    const padded = (id & 0xffff).toString(16).toUpperCase().padStart(4, "0") // not-protocol: four hex digits
    return padded.slice(0, 2) + " " + padded.slice(2) // not-protocol: two bytes, as id1 id2
  }
}

/**
 * An RFC_TR item a client sends (transport.md §2.3, §2.5): its sid and value. The value of
 * Swooey's answer echoes the server's call, so no description shows it.
 */
export class RFCTransferValue {
  constructor(
    public sid: ApplSIDRfcTr,
    public value: Uint8Array = new Uint8Array(0)
  ) {}

  /** A copy (Swift copies the struct on assignment). */
  clone(): RFCTransferValue {
    return new RFCTransferValue(this.sid, this.value.slice())
  }

  /** The sid and the value's length only. */
  get description(): string {
    return `RFCTransferValue(${ApplSID.RfcTr.name(this.sid)}, ${this.value.length} bytes)`
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

