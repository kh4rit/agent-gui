// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/SimpleItemValues.swift (MIT).

// Value codecs of the simple items whose layout the spec states (docs/protocol/items.md, "Simple
// item layouts"): SES, SFE, SBA and SLC, plus EOM, which has no value. What the fields mean is
// spec gap #32; the codecs only split and join the bytes. ICO, TIT, DiagMessage, CHL and SBA2
// values stay opaque (#32).

import { ByteWriter, WireBytes } from "../wire/index.js"
import { CodecSpecGap, FixedSize, ItemPayloadError } from "./diagCodec.js"
import { DiagItemLayout, DiagItemType } from "./diagItem.js"

/** The fields of an SES value; every field defaults to 0. */
export interface SESValueFields {
  eventArray: number
  eventID1: number
  eventID2: number
  eventID3: number
  eventID4: number
  eventID5: number
  screenFlag: number
  modalNumber: number
  xPos: number
  yPos: number
  imode: number
  flag1: number
  dimRow: number
  dimCol: number
}

/**
 * The 16-byte SES value (PV-0420; both sources). All fields are one unsigned byte; bytes 12–13 are
 * a filler that decoders ignore and encoders write as `00 00` (R-IT-12).
 */
export class SESValue implements SESValueFields {
  /** The value size (PV-0110). */
  static readonly size = DiagItemType.simpleValueSize("ses")!

  static readonly Offset = {
    eventArray: 0, // provenance: PV-0420
    eventID1: 1, // provenance: PV-0420
    eventID2: 2, // provenance: PV-0420
    eventID3: 3, // provenance: PV-0420
    eventID4: 4, // provenance: PV-0420
    eventID5: 5, // provenance: PV-0420
    screenFlag: 6, // provenance: PV-0420
    modalNumber: 7, // provenance: PV-0420
    xPos: 8, // provenance: PV-0420
    yPos: 9, // provenance: PV-0420
    imode: 10, // provenance: PV-0420
    flag1: 11, // provenance: PV-0420
    fillerSize: 2, // provenance: PV-0420
    dimRow: 14, // provenance: PV-0420
    dimCol: 15 // provenance: PV-0420
  } as const

  readonly eventArray: number
  readonly eventID1: number
  readonly eventID2: number
  readonly eventID3: number
  readonly eventID4: number
  readonly eventID5: number
  readonly screenFlag: number
  readonly modalNumber: number
  readonly xPos: number
  readonly yPos: number
  readonly imode: number
  readonly flag1: number
  readonly dimRow: number
  readonly dimCol: number

  constructor(fields: Partial<SESValueFields> = {}) {
    this.eventArray = fields.eventArray ?? 0
    this.eventID1 = fields.eventID1 ?? 0
    this.eventID2 = fields.eventID2 ?? 0
    this.eventID3 = fields.eventID3 ?? 0
    this.eventID4 = fields.eventID4 ?? 0
    this.eventID5 = fields.eventID5 ?? 0
    this.screenFlag = fields.screenFlag ?? 0
    this.modalNumber = fields.modalNumber ?? 0
    this.xPos = fields.xPos ?? 0
    this.yPos = fields.yPos ?? 0
    this.imode = fields.imode ?? 0
    this.flag1 = fields.flag1 ?? 0
    this.dimRow = fields.dimRow ?? 0
    this.dimCol = fields.dimCol ?? 0
  }

  /** Decodes exactly 16 value bytes; the filler is ignored (R-IT-12). */
  static decode(value: Uint8Array): SESValue {
    FixedSize.check(value, SESValue.size)
    const offset = SESValue.Offset
    return new SESValue({
      eventArray: value[offset.eventArray],
      eventID1: value[offset.eventID1],
      eventID2: value[offset.eventID2],
      eventID3: value[offset.eventID3],
      eventID4: value[offset.eventID4],
      eventID5: value[offset.eventID5],
      screenFlag: value[offset.screenFlag],
      modalNumber: value[offset.modalNumber],
      xPos: value[offset.xPos],
      yPos: value[offset.yPos],
      imode: value[offset.imode],
      flag1: value[offset.flag1],
      dimRow: value[offset.dimRow],
      dimCol: value[offset.dimCol]
    })
  }

  /** Appends the 16 value bytes in offset order, the filler as `00 00` (R-IT-12). */
  append(output: ByteWriter): void {
    output.u8(this.eventArray)
    output.u8(this.eventID1)
    output.u8(this.eventID2)
    output.u8(this.eventID3)
    output.u8(this.eventID4)
    output.u8(this.eventID5)
    output.u8(this.screenFlag)
    output.u8(this.modalNumber)
    output.u8(this.xPos)
    output.u8(this.yPos)
    output.u8(this.imode)
    output.u8(this.flag1)
    output.repeat(0, SESValue.Offset.fillerSize)
    output.u8(this.dimRow)
    output.u8(this.dimCol)
  }
}

/** The 3-byte SFE value: format, color, extended, one byte each (PV-0421; Wireshark only). */
export class SFEValue {
  /** The value size (PV-0115). */
  static readonly size = DiagItemType.simpleValueSize("sfe")!

  static readonly Offset = {
    format: 0, // provenance: PV-0421
    color: 1, // provenance: PV-0421
    extended: 2 // provenance: PV-0421
  } as const

  readonly format: number
  readonly color: number
  readonly extended: number

  constructor(fields: { format: number; color: number; extended: number }) {
    this.format = fields.format
    this.color = fields.color
    this.extended = fields.extended
  }

  /** Decodes exactly 3 value bytes. */
  static decode(value: Uint8Array): SFEValue {
    FixedSize.check(value, SFEValue.size)
    return new SFEValue({
      format: value[SFEValue.Offset.format],
      color: value[SFEValue.Offset.color],
      extended: value[SFEValue.Offset.extended]
    })
  }

  /** Appends the 3 value bytes. */
  append(output: ByteWriter): void {
    output.u8(this.format)
    output.u8(this.color)
    output.u8(this.extended)
  }
}

/** The 2-byte SBA value: y, then x, one byte each (PV-0422; Wireshark only). */
export class SBAValue {
  /** The value size (PV-0116). */
  static readonly size = DiagItemType.simpleValueSize("sba")!

  static readonly Offset = {
    y: 0, // provenance: PV-0422
    x: 1 // provenance: PV-0422
  } as const

  readonly y: number
  readonly x: number

  constructor(fields: { y: number; x: number }) {
    this.y = fields.y
    this.x = fields.x
  }

  /** Decodes exactly 2 value bytes. */
  static decode(value: Uint8Array): SBAValue {
    FixedSize.check(value, SBAValue.size)
    return new SBAValue({ y: value[SBAValue.Offset.y], x: value[SBAValue.Offset.x] })
  }

  /** Appends the 2 value bytes, y first. */
  append(output: ByteWriter): void {
    output.u8(this.y)
    output.u8(this.x)
  }
}

/** The 2-byte SLC value: one field length counted in characters, u16 BE (PV-0423; Wireshark only). */
export class SLCValue {
  /** The value size (PV-0118). */
  static readonly size = DiagItemType.simpleValueSize("slc")!

  readonly fieldLength: number

  constructor(fields: { fieldLength: number }) {
    this.fieldLength = fields.fieldLength
  }

  /** Decodes exactly 2 value bytes as a u16 BE. */
  static decode(value: Uint8Array): SLCValue {
    FixedSize.check(value, SLCValue.size)
    return new SLCValue({ fieldLength: WireBytes.u16BigEndian(value, 0) }) // provenance: PV-0423
  }

  /** Appends the 2 value bytes, most significant first. */
  append(output: ByteWriter): void {
    output.u16be(this.fieldLength) // provenance: PV-0423
  }
}

/** The decoded value of one simple item of a type whose layout is specified. */
export type SimpleItemValue =
  | { readonly kind: "ses"; readonly value: SESValue }
  | { readonly kind: "sfe"; readonly value: SFEValue }
  | { readonly kind: "sba"; readonly value: SBAValue }
  | { readonly kind: "slc"; readonly value: SLCValue }
  /** EOM has no value (PV-0117). */
  | { readonly kind: "eom" }

export const SimpleItemValue = {
  ses: (value: SESValue): SimpleItemValue => ({ kind: "ses", value }),
  sfe: (value: SFEValue): SimpleItemValue => ({ kind: "sfe", value }),
  sba: (value: SBAValue): SimpleItemValue => ({ kind: "sba", value }),
  slc: (value: SLCValue): SimpleItemValue => ({ kind: "slc", value }),
  eom: { kind: "eom" } as SimpleItemValue,

  /**
   * Decodes the value of an item of `type` (for example a `DiagItem`'s value).
   *
   * Fails with `specGap` for ICO, TIT, DiagMessage, CHL and SBA2, whose layouts are #32, and for
   * OKC, whose size is #30; with `notASimpleItem` for APPL, APPL4 and XMLBLOB.
   */
  decode(type: DiagItemType, value: Uint8Array): SimpleItemValue {
    switch (type) {
      case "ses":
        return { kind: "ses", value: SESValue.decode(value) }
      case "sfe":
        return { kind: "sfe", value: SFEValue.decode(value) }
      case "sba":
        return { kind: "sba", value: SBAValue.decode(value) }
      case "slc":
        return { kind: "slc", value: SLCValue.decode(value) }
      case "eom":
        FixedSize.check(value, 0)
        return { kind: "eom" }
      case "ico":
      case "tit":
      case "diagMessage":
      case "chl":
      case "sba2":
        throw new ItemPayloadError({ kind: "specGap", issue: CodecSpecGap.simpleItemLayouts })
      case "okc":
        throw new ItemPayloadError({ kind: "specGap", issue: CodecSpecGap.okcSize })
      case "appl":
      case "appl4":
      case "xmlblob":
        throw new ItemPayloadError({ kind: "notASimpleItem", typeByte: DiagItemType.rawValue(type) })
    }
  },

  /** Decodes one whole simple item: its type byte, then exactly its value (Swift `init(item:)`). */
  decodeItem(item: Uint8Array): SimpleItemValue {
    if (item.length === 0) throw new ItemPayloadError({ kind: "notASimpleItem", typeByte: undefined })
    const type = DiagItemType.fromRaw(item[0])
    if (type === undefined) throw new ItemPayloadError({ kind: "notASimpleItem", typeByte: item[0] })
    return SimpleItemValue.decode(type, item.subarray(DiagItemLayout.typeSize))
  },

  /** The item type. */
  type(value: SimpleItemValue): DiagItemType {
    return value.kind
  },

  /** Appends the whole item: the type byte, then the value (PV-0404). */
  appendItem(value: SimpleItemValue, output: ByteWriter): void {
    output.u8(DiagItemType.rawValue(value.kind))
    switch (value.kind) {
      case "ses":
      case "sfe":
      case "sba":
      case "slc":
        value.value.append(output)
        break
      case "eom":
        break
    }
  }
} as const
