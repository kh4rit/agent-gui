// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/MessageItems.swift (MIT).

// Typed status messages (docs/protocol/elements.md §9, Reading R-EL-14): the VARINFO MESTYPE2 value
// in open-diag-go's layout (PV-0973), with Wireshark's reading as zero-terminated strings as the
// fallback (#113), and the message types (PV-0974).

import { ByteWriter } from "../wire/index.js"
import { ApplItem } from "./applRegistry.js"
import { ByteRange, ItemPayloadError } from "./diagCodec.js"
import { DiagItemEncoder, DiagItemEncodingError } from "./diagItem.js"

/**
 * How a screen's status message is read (elements.md Reading R-EL-14, #113).
 * - `mestype2`: the default: the typed message from MESTYPE2, else ST_R3INFO MESSAGE without a
 *   type.
 * - `messageOnly`: the fallback: ST_R3INFO MESSAGE alone, without a type, as before elements.md.
 */
export type MessageTypeReading = "mestype2" | "messageOnly"
export const MessageTypeReading = { allCases: ["mestype2", "messageOnly"] as readonly MessageTypeReading[] } as const

/** The type letters of PV-0974, by type. */
const TYPE_LETTERS = {
  /** `S`: status bar, processing goes on. */
  success: 0x53, // not-protocol: ASCII "S" (PV-0974's letter)
  /** `I`: a dialog box, then processing goes on. */
  information: 0x49, // not-protocol: ASCII "I" (PV-0974's letter)
  /** `W`: status bar, input ready, the user may continue. */
  warning: 0x57, // not-protocol: ASCII "W" (PV-0974's letter)
  /** `E`: status bar, the fields ready for input again. */
  error: 0x45, // not-protocol: ASCII "E" (PV-0974's letter)
  /** `A`: a dialog box, then the program ends. */
  abort: 0x41, // not-protocol: ASCII "A" (PV-0974's letter)
  /** `X`: a runtime error. */
  exit: 0x58 // not-protocol: ASCII "X" (PV-0974's letter)
} as const

/** A status-message type with a letter of its own (PV-0974). */
export type KnownStatusMessageType = keyof typeof TYPE_LETTERS

const KNOWN_TYPES = Object.keys(TYPE_LETTERS) as KnownStatusMessageType[]

/**
 * The type of a status message (PV-0974): its letter is MESTYPE2's byte 0. Any other byte is
 * `unknown` and kept. Swift's `.error` is `StatusMessageType.of("error")`, `{ kind: "error" }`.
 */
export type StatusMessageType = { readonly kind: KnownStatusMessageType } | { readonly kind: "unknown"; readonly value: number }

export const StatusMessageType = {
  /** A known type by kind. */
  of(kind: KnownStatusMessageType): StatusMessageType {
    return { kind }
  },

  /** Any other byte (Swift `.unknown(byte)`). */
  unknown(value: number): StatusMessageType {
    return { kind: "unknown", value }
  },

  /** The type of a type byte (Swift `init(byte:)`). */
  fromByte(byte: number): StatusMessageType {
    const kind = KNOWN_TYPES.find(type => TYPE_LETTERS[type] === byte)
    return kind === undefined ? { kind: "unknown", value: byte } : { kind }
  },

  /** The type byte. */
  byte(type: StatusMessageType): number {
    return type.kind === "unknown" ? type.value : TYPE_LETTERS[type.kind]
  }
} as const

/** The fields of a MESTYPE2 value (Swift `StatusMessageValue.Field`). */
export type StatusMessageValueField = "messageClass" | "number" | "text"
export const StatusMessageValueField = { allCases: ["messageClass", "number", "text"] as readonly StatusMessageValueField[] } as const

/**
 * How a MESTYPE2 value was read (Swift `StatusMessageValue.Layout`).
 * - `fixedPositions`: open-diag-go's fixed positions (PV-0973): the value has at least 29 bytes and
 *   zeros at 1, 22, 26 and 28.
 * - `strings`: Wireshark's reading: zero-terminated strings, type, class, number and text (#113).
 */
export type StatusMessageValueLayout = "fixedPositions" | "strings"

/** Values the MESTYPE2 encoder cannot write. Nothing is appended when one is thrown. */
export type StatusMessageEncodingErrorInfo =
  /** The message class is longer than its 20 characters (PV-0973). */
  | { readonly kind: "classTooLong"; readonly length: number }
  /** The number is not exactly three characters (PV-0973). */
  | { readonly kind: "numberNotThreeCharacters"; readonly length: number }
  /** A field holds a zero byte, which would end it early under Wireshark's reading. */
  | { readonly kind: "zeroByte"; readonly value: StatusMessageValueField }
  /** The value does not fit an APPL item. */
  | { readonly kind: "item"; readonly value: DiagItemEncodingError }

export class StatusMessageEncodingError extends Error {
  constructor(readonly info: StatusMessageEncodingErrorInfo) {
    super(info.kind === "item" ? `MESTYPE2 encoder: ${info.value.message}` : `MESTYPE2 encoder: ${JSON.stringify(info)}`)
    this.name = "StatusMessageEncodingError"
  }
}

/** The fields of a status message for `StatusMessageValue.append`. */
export interface StatusMessageContent {
  type: StatusMessageType
  messageClass: Uint8Array
  number: Uint8Array
  text: Uint8Array
}

/**
 * The value of VARINFO MESTYPE2 (0x0C/0x03). Ranges are offsets into the value; the texts are in
 * the code page in force and padded as received (a reader trims them, R-SS-4).
 */
export class StatusMessageValue {
  /** The item that carries it (PV-0462). */
  static readonly item: ApplItem = ApplItem.varInfo("mestype2")

  static readonly Offset = {
    type: 0, // provenance: PV-0973
    classStart: 2, // provenance: PV-0973
    classLength: 20, // provenance: PV-0973
    numberStart: 23, // provenance: PV-0973
    numberLength: 3, // provenance: PV-0973
    space: 27, // provenance: PV-0973
    textStart: 29, // provenance: PV-0973
    /** The four zero bytes of the fixed layout. */
    zeros: [1, 22, 26, 28] as readonly number[] // provenance: PV-0973
  } as const

  /** The pad of the class field and the byte at 27 (PV-0973). */
  static readonly space = 0x20 // not-protocol: ASCII space

  /** Byte 0: the type letter. */
  readonly typeByte: number
  readonly classRange: ByteRange
  readonly numberRange: ByteRange
  /** The text, without the zero byte that may end it. */
  readonly textRange: ByteRange
  readonly layout: StatusMessageValueLayout

  constructor(fields: {
    typeByte: number
    classRange: ByteRange
    numberRange: ByteRange
    textRange: ByteRange
    layout: StatusMessageValueLayout
  }) {
    this.typeByte = fields.typeByte
    this.classRange = fields.classRange
    this.numberRange = fields.numberRange
    this.textRange = fields.textRange
    this.layout = fields.layout
  }

  /** The type of `typeByte` (PV-0974). */
  get type(): StatusMessageType {
    return StatusMessageType.fromByte(this.typeByte)
  }

  /**
   * Decodes a MESTYPE2 value: open-diag-go's positions when they fit, else Wireshark's strings. An
   * empty value is `truncated`.
   */
  static decode(value: Uint8Array): StatusMessageValue {
    const offset = StatusMessageValue.Offset
    if (!(value.length >= 1)) throw new ItemPayloadError({ kind: "truncated", needed: 1, available: 0 })
    if (value.length >= offset.textStart && offset.zeros.every(index => value[index] === 0))
      return new StatusMessageValue({
        typeByte: value[offset.type],
        classRange: new ByteRange(offset.classStart, offset.classStart + offset.classLength),
        numberRange: new ByteRange(offset.numberStart, offset.numberStart + offset.numberLength),
        textRange: new ByteRange(offset.textStart, zeroOrEnd(value, offset.textStart)),
        layout: "fixedPositions"
      })
    const strings: ByteRange[] = []
    let start = 0
    while (start <= value.length && strings.length < 4) { // not-protocol: Wireshark's four strings (#113)
      const end = zeroOrEnd(value, start)
      strings.push(new ByteRange(start, end))
      start = end + 1
    }
    const empty = new ByteRange(value.length, value.length)
    const first = strings[0]
    return new StatusMessageValue({
      typeByte: first.isEmpty ? 0 : value[first.lowerBound],
      classRange: strings.length > 1 ? strings[1] : empty,
      numberRange: strings.length > 2 ? strings[2] : empty, // not-protocol: the third string
      textRange: strings.length > 3 ? strings[3] : empty, // not-protocol: the fourth string
      layout: "strings"
    })
  }

  /**
   * Appends a MESTYPE2 value of R-EL-14: open-diag-go's layout (PV-0973), the class padded with
   * spaces to 20 characters, then the text and one zero byte, so that Wireshark's reading finds the
   * same fields.
   */
  static append(message: StatusMessageContent, output: ByteWriter): void {
    const { messageClass, number, text } = message
    const offset = StatusMessageValue.Offset
    if (!(messageClass.length <= offset.classLength)) throw new StatusMessageEncodingError({ kind: "classTooLong", length: messageClass.length })
    if (number.length !== offset.numberLength) throw new StatusMessageEncodingError({ kind: "numberNotThreeCharacters", length: number.length })
    if (messageClass.includes(0)) throw new StatusMessageEncodingError({ kind: "zeroByte", value: "messageClass" })
    if (number.includes(0)) throw new StatusMessageEncodingError({ kind: "zeroByte", value: "number" })
    if (text.includes(0)) throw new StatusMessageEncodingError({ kind: "zeroByte", value: "text" })
    output.u8(StatusMessageType.byte(message.type))
    output.u8(0)
    output.bytes(messageClass)
    output.repeat(StatusMessageValue.space, offset.classLength - messageClass.length)
    output.u8(0)
    output.bytes(number)
    output.u8(0)
    output.u8(StatusMessageValue.space)
    output.u8(0)
    output.bytes(text)
    output.u8(0)
  }

  /** Appends the whole item: APPL VARINFO MESTYPE2 with the value of `append`. Nothing is appended when it throws. */
  static appendItem(message: StatusMessageContent, output: ByteWriter): void {
    const value = new ByteWriter()
    StatusMessageValue.append(message, value)
    try {
      DiagItemEncoder.appendAPPL(StatusMessageValue.item, value.toBytes(), output)
    } catch (error) {
      if (!(error instanceof DiagItemEncodingError)) throw error
      throw new StatusMessageEncodingError({ kind: "item", value: error })
    }
  }
}

function zeroOrEnd(value: Uint8Array, start: number): number {
  let index = start
  while (index < value.length && value[index] !== 0) index += 1
  return index
}
