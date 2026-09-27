// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DiagItem.swift (MIT).

import { ByteWriter, WireBytes } from "../wire/index.js"
import { ApplItem } from "./applRegistry.js"
import { ByteRange, CodecSpecGap, isUInt32 } from "./diagCodec.js"

/** Field offsets and widths of the item layer (docs/protocol/items.md). */
export const DiagItemLayout = {
  /** Every item starts with a one-byte type (PV-0100). */
  typeSize: 1, // provenance: PV-0100
  /** APPL and APPL4: the id right after the type byte. */
  idOffset: 1, // provenance: PV-0400
  /** APPL and APPL4: the sid right after the id. */
  sidOffset: 2, // provenance: PV-0401
  /** APPL and APPL4: the length right after the sid. */
  applLengthOffset: 3, // provenance: PV-0102, PV-0104
  /** APPL4's and XMLBLOB's length field: u32 BE. */
  u32LengthSize: 4, // provenance: PV-0104, PV-0106
  /** Offset of an APPL value: the item is 5 + length bytes. */
  applValueOffset: 5, // provenance: PV-0402
  /** Offset of an APPL4 value: the item is 7 + length bytes. */
  appl4ValueOffset: 7, // provenance: PV-0403
  /** XMLBLOB: the length follows the type byte directly (no id, no sid). */
  xmlblobLengthOffset: 1, // provenance: PV-0106
  /** Offset of an XMLBLOB value. */
  xmlblobValueOffset: 5, // provenance: PV-0106
  /** Largest value an APPL item can carry: its length field is 16 bits wide (R-IT-4). */
  applMaxValueLength: 0xffff // provenance: PV-0102
} as const

/**
 * The fourteen item types both sources name (docs/protocol/items.md, "Item types", PV-0417).
 * `DiagItemType.rawValue` is the type byte. Every other byte is an unknown type (IMPL-IT-2).
 */
const ITEM_TYPES = {
  ses: 0x01, // provenance: PV-0405
  ico: 0x02, // provenance: PV-0406
  tit: 0x03, // provenance: PV-0407
  /** The type both sources name "DiagMessage" and mark as an old format. */
  diagMessage: 0x07, // provenance: PV-0408
  /** Named, but its value size is unknown (#30): the walker stops at it (IMPL-IT-8). */
  okc: 0x08, // provenance: PV-0409
  chl: 0x09, // provenance: PV-0410
  sfe: 0x0a, // provenance: PV-0411
  sba: 0x0b, // provenance: PV-0412
  eom: 0x0c, // provenance: PV-0413
  appl: 0x10, // provenance: PV-0101
  /** Named DIAG_XMLBLOB in the sources. */
  xmlblob: 0x11, // provenance: PV-0105
  appl4: 0x12, // provenance: PV-0103
  slc: 0x13, // provenance: PV-0414
  sba2: 0x15 // provenance: PV-0415
} as const

export type DiagItemType = keyof typeof ITEM_TYPES

const ITEM_TYPE_CASES = Object.keys(ITEM_TYPES) as DiagItemType[]
const ITEM_TYPE_BY_BYTE = new Map<number, DiagItemType>(ITEM_TYPE_CASES.map(type => [ITEM_TYPES[type], type]))

const ITEM_TYPE_NAMES: Record<DiagItemType, string> = {
  ses: "SES",
  ico: "ICO",
  tit: "TIT",
  diagMessage: "DiagMessage",
  okc: "OKC",
  chl: "CHL",
  sfe: "SFE",
  sba: "SBA",
  eom: "EOM",
  appl: "APPL",
  xmlblob: "XMLBLOB",
  appl4: "APPL4",
  slc: "SLC",
  sba2: "SBA2"
}

const SIMPLE_VALUE_SIZES: Partial<Record<DiagItemType, number>> = {
  ses: 16, // provenance: PV-0110
  ico: 20, // provenance: PV-0111
  tit: 3, // provenance: PV-0112
  diagMessage: 76, // provenance: PV-0113
  chl: 22, // provenance: PV-0114
  sfe: 3, // provenance: PV-0115
  sba: 2, // provenance: PV-0116
  eom: 0, // provenance: PV-0117
  slc: 2, // provenance: PV-0118
  sba2: 36 // provenance: PV-0416
}

export const DiagItemType = {
  /** The fourteen types in type-byte order (Swift `CaseIterable`). */
  allCases: ITEM_TYPE_CASES as readonly DiagItemType[],

  /** The type of a type byte, or undefined for an unknown type (Swift `init?(rawValue:)`). */
  fromRaw(byte: number): DiagItemType | undefined {
    return ITEM_TYPE_BY_BYTE.get(byte)
  },

  /** The type byte. */
  rawValue(type: DiagItemType): number {
    return ITEM_TYPES[type]
  },

  /** The type byte. */
  typeByte(type: DiagItemType): number {
    return ITEM_TYPES[type]
  },

  /** The type's name as the spec's type table writes it. */
  name(type: DiagItemType): string {
    return ITEM_TYPE_NAMES[type]
  },

  /**
   * For a simple type of known size, the size of its value: the bytes after the type byte, which
   * the item's total size excludes (PV-0404). Undefined for the length-prefixed types and for OKC,
   * whose size is unknown (#30).
   */
  simpleValueSize(type: DiagItemType): number | undefined {
    return SIMPLE_VALUE_SIZES[type]
  },

  /** APPL, APPL4 and XMLBLOB carry an explicit length, so a decoder can always step over them. */
  isLengthPrefixed(type: DiagItemType): boolean {
    return type === "appl" || type === "appl4" || type === "xmlblob"
  },

  /** APPL and APPL4 carry an (id, sid) pair. */
  carriesApplItem(type: DiagItemType): boolean {
    return type === "appl" || type === "appl4"
  }
} as const

/** The fields of a `DiagItem`. */
export interface DiagItemFields {
  index: number
  type: DiagItemType
  offset: number
  valueRange: ByteRange
  appl?: ApplItem
}

/**
 * One item of an item sequence: where it sits, never a copy of its value (IMPL-IT-6). Offsets are
 * relative to the start of the item sequence the walker was given.
 */
export class DiagItem {
  /** 1-based position of the item in the sequence. */
  readonly index: number
  /** The item type. The walker never yields `okc`. */
  readonly type: DiagItemType
  /** Offset of the item's type byte. */
  readonly offset: number
  /**
   * Where the value bytes are: the declared length (APPL, APPL4, XMLBLOB) or the fixed size
   * (simple items; empty for EOM).
   */
  readonly valueRange: ByteRange
  /**
   * APPL and APPL4: the (id, sid) pair, the same whichever carrier brought it (IMPL-IT-9).
   * Undefined for the other types.
   */
  readonly appl: ApplItem | undefined

  constructor(fields: DiagItemFields) {
    this.index = fields.index
    this.type = fields.type
    this.offset = fields.offset
    this.valueRange = fields.valueRange
    this.appl = fields.appl
  }

  /** Offset of the first value byte. */
  get valueOffset(): number {
    return this.valueRange.lowerBound
  }

  /** Value length (R-IT-3: a length field counts the value bytes only). */
  get valueLength(): number {
    return this.valueRange.count
  }

  /** Offset of the byte after the item, where the next item starts. */
  get endOffset(): number {
    return this.valueRange.upperBound
  }
}

/** The part of an item a truncated sequence ended in (IMPL-IT-5). */
export type DiagItemField = "id" | "sid" | "length" | "value"

/**
 * Why a walk stopped. Each aborts the message only (IMPL-IT-2, IMPL-IT-5); the items produced
 * before it are still valid views. The vector error class is given in brackets.
 */
export type DiagItemWalkErrorInfo =
  /**
   * The sequence ends inside an item's id, sid, length field or value (IMPL-IT-5); a declared
   * length beyond the bytes left is never shortened. [`truncated`]
   */
  | { readonly kind: "truncated"; readonly itemIndex: number; readonly itemOffset: number; readonly field: DiagItemField }
  /**
   * The type byte is none of the fourteen known types, or it is OKC (0x08), whose size is unknown
   * (IMPL-IT-2, IMPL-IT-8). No item of unknown size can be stepped over, so the message stops
   * here. [`unknown-simple-type`]
   */
  | { readonly kind: "unknownType"; readonly typeByte: number; readonly itemIndex: number; readonly itemOffset: number }

export class DiagItemWalkError extends Error {
  constructor(readonly info: DiagItemWalkErrorInfo) {
    super(
      info.kind === "truncated"
        ? `item ${info.itemIndex} at offset ${info.itemOffset} truncated in its ${info.field}`
        : `item ${info.itemIndex} at offset ${info.itemOffset} has unknown type ${info.typeByte}`
    )
    this.name = "DiagItemWalkError"
  }

  /** 1-based index of the item being read when the walk stopped. */
  get itemIndex(): number {
    return this.info.itemIndex
  }

  /** Offset of the type byte of the item being read when the walk stopped. */
  get itemOffset(): number {
    return this.info.itemOffset
  }

  /** The name of a named type that stopped the walk, for the diagnostic: "OKC" (IMPL-IT-8). */
  get typeName(): string | undefined {
    if (this.info.kind !== "unknownType") return undefined
    const type = DiagItemType.fromRaw(this.info.typeByte)
    return type === undefined ? undefined : DiagItemType.name(type)
  }

  /**
   * The spec-gap issue behind the stop, if any: OKC's size is #30. Other unknown types are no gap:
   * the spec defines them as unknown.
   */
  get specGapIssue(): number | undefined {
    if (this.info.kind !== "unknownType" || this.info.typeByte !== ITEM_TYPES.okc) return undefined
    return CodecSpecGap.okcSize
  }
}

/**
 * Walks an item sequence (docs/protocol/items.md, "Walking an item sequence").
 *
 * Index-based: the walker holds only its position, and every call to `next` gets the same
 * sequence. The sequence runs to the end of the bytes and the walker does not stop at EOM
 * (R-IT-1). Lengths are compared with the bytes left before any value is touched, without
 * overflow (IMPL-IT-5). Errors are sticky: after one, every call throws it again. Unknown
 * (id, sid) pairs are stepped over by their length like any other APPL or APPL4 item (IMPL-IT-1);
 * counting them is the caller's job.
 */
export class DiagItemWalker {
  private _offset: number
  private _itemCount = 0
  private _error: DiagItemWalkError | undefined

  /** A walker that starts at `startingAt` (0: the start of the sequence). */
  constructor(startingAt = 0) {
    this._offset = Math.max(startingAt, 0)
  }

  /** Offset of the next item's type byte. */
  get offset(): number {
    return this._offset
  }

  /** Number of items produced so far. */
  get itemCount(): number {
    return this._itemCount
  }

  /** The error the walk stopped with, if any. */
  get error(): DiagItemWalkError | undefined {
    return this._error
  }

  /** A copy of this walker (Swift copies the struct on assignment). */
  clone(): DiagItemWalker {
    const copy = new DiagItemWalker(this._offset)
    copy._itemCount = this._itemCount
    copy._error = this._error
    return copy
  }

  /** Returns the next item, or undefined at the end of the sequence. */
  next(items: Uint8Array): DiagItem | undefined {
    if (this._error) throw this._error
    if (!(this._offset < items.length)) return undefined
    const itemOffset = this._offset
    const index = this._itemCount + 1
    const remaining = items.length - itemOffset
    const typeByte = items[itemOffset]
    const type = DiagItemType.fromRaw(typeByte)
    if (type === undefined) return this.fail({ kind: "unknownType", typeByte, itemIndex: index, itemOffset })
    let valueOffset: number
    let declared: number
    let appl: ApplItem | undefined
    switch (type) {
      case "appl":
      case "appl4": {
        if (!(remaining > DiagItemLayout.idOffset)) return this.fail({ kind: "truncated", itemIndex: index, itemOffset, field: "id" })
        if (!(remaining > DiagItemLayout.sidOffset)) return this.fail({ kind: "truncated", itemIndex: index, itemOffset, field: "sid" })
        const lengthOffset = itemOffset + DiagItemLayout.applLengthOffset
        if (type === "appl") {
          if (!(remaining >= DiagItemLayout.applValueOffset))
            return this.fail({ kind: "truncated", itemIndex: index, itemOffset, field: "length" })
          declared = WireBytes.u16BigEndian(items, lengthOffset) // provenance: PV-0102
          valueOffset = itemOffset + DiagItemLayout.applValueOffset
        } else {
          if (!(remaining >= DiagItemLayout.appl4ValueOffset))
            return this.fail({ kind: "truncated", itemIndex: index, itemOffset, field: "length" })
          declared = WireBytes.u32BigEndian(items, lengthOffset) // provenance: PV-0104
          valueOffset = itemOffset + DiagItemLayout.appl4ValueOffset
        }
        appl = ApplItem.of(items[itemOffset + DiagItemLayout.idOffset], items[itemOffset + DiagItemLayout.sidOffset])
        break
      }
      case "xmlblob":
        if (!(remaining >= DiagItemLayout.xmlblobValueOffset))
          return this.fail({ kind: "truncated", itemIndex: index, itemOffset, field: "length" })
        declared = WireBytes.u32BigEndian(items, itemOffset + DiagItemLayout.xmlblobLengthOffset) // provenance: PV-0106
        valueOffset = itemOffset + DiagItemLayout.xmlblobValueOffset
        break
      case "okc":
        // IMPL-IT-8: OKC's size is unknown (#30), so it is handled like an unknown type.
        return this.fail({ kind: "unknownType", typeByte, itemIndex: index, itemOffset })
      case "ses":
      case "ico":
      case "tit":
      case "diagMessage":
      case "chl":
      case "sfe":
      case "sba":
      case "eom":
      case "slc":
      case "sba2":
        // PV-0404: the fixed value size excludes the type byte.
        declared = DiagItemType.simpleValueSize(type) ?? 0
        valueOffset = itemOffset + DiagItemLayout.typeSize
        break
    }
    // Compare the length with what is left instead of computing valueOffset + length, so a u32
    // length can neither overflow nor reach past the input (IMPL-IT-5).
    const length = declared
    if (!(length <= items.length - valueOffset)) return this.fail({ kind: "truncated", itemIndex: index, itemOffset, field: "value" })
    const item = new DiagItem({ index, type, offset: itemOffset, valueRange: new ByteRange(valueOffset, valueOffset + length), appl })
    this._offset = item.endOffset
    this._itemCount = index
    return item
  }

  private fail(info: DiagItemWalkErrorInfo): never {
    this._error = new DiagItemWalkError(info)
    throw this._error
  }
}

// MARK: - Encoding items

/** Values the item encoder cannot write. */
export type DiagItemEncodingErrorInfo =
  /**
   * The value does not fit the type's length field: 65 535 bytes for APPL (R-IT-4), the u32
   * range for APPL4 and XMLBLOB.
   */
  | { readonly kind: "valueTooLong"; readonly type: DiagItemType; readonly length: number }
  /** A simple item's value does not have the type's fixed size. */
  | { readonly kind: "wrongValueSize"; readonly type: DiagItemType; readonly expected: number; readonly actual: number }
  /** The type has no fixed value size: OKC (#30) or a length-prefixed type. */
  | { readonly kind: "notASimpleType"; readonly type: DiagItemType }

export class DiagItemEncodingError extends Error {
  constructor(readonly info: DiagItemEncodingErrorInfo) {
    super(`item encoder: ${JSON.stringify(info)}`)
    this.name = "DiagItemEncodingError"
  }
}

/**
 * Appends items in the layouts of items.md. This is the plain layout, with no policy: which items
 * a client may send (IMPL-IT-10) is `ClientMessageEncoder`'s business, which uses this.
 */
export const DiagItemEncoder = {
  /** Appends an APPL item: `10`, id, sid, u16 BE length, value (PV-0400–PV-0402). */
  appendAPPL(item: ApplItem, value: Uint8Array, output: ByteWriter): void {
    if (!(value.length <= DiagItemLayout.applMaxValueLength))
      throw new DiagItemEncodingError({ kind: "valueTooLong", type: "appl", length: value.length })
    output.u8(ITEM_TYPES.appl)
    output.u8(ApplItem.id(item))
    output.u8(ApplItem.sid(item))
    output.u16be(value.length) // provenance: PV-0102
    output.bytes(value)
  },

  /** Appends an APPL4 item: `12`, id, sid, u32 BE length, value (PV-0400, PV-0401, PV-0403). */
  appendAPPL4(item: ApplItem, value: Uint8Array, output: ByteWriter): void {
    if (!isUInt32(value.length)) throw new DiagItemEncodingError({ kind: "valueTooLong", type: "appl4", length: value.length })
    output.u8(ITEM_TYPES.appl4)
    output.u8(ApplItem.id(item))
    output.u8(ApplItem.sid(item))
    WireBytes.appendU32BigEndian(value.length, output) // provenance: PV-0104
    output.bytes(value)
  },

  /**
   * Appends an XMLBLOB item: `11`, u32 BE length, value (PV-0105, PV-0106). Clients send no
   * XMLBLOB until #20 is resolved (IMPL-IT-10); the fake server and tests may.
   */
  appendXMLBLOB(value: Uint8Array, output: ByteWriter): void {
    if (!isUInt32(value.length)) throw new DiagItemEncodingError({ kind: "valueTooLong", type: "xmlblob", length: value.length })
    output.u8(ITEM_TYPES.xmlblob)
    WireBytes.appendU32BigEndian(value.length, output) // provenance: PV-0106
    output.bytes(value)
  },

  /** Appends a simple item: its type byte, then exactly its fixed-size value (PV-0404). */
  appendSimple(type: DiagItemType, value: Uint8Array, output: ByteWriter): void {
    const size = DiagItemType.simpleValueSize(type)
    if (size === undefined) throw new DiagItemEncodingError({ kind: "notASimpleType", type })
    if (value.length !== size) throw new DiagItemEncodingError({ kind: "wrongValueSize", type, expected: size, actual: value.length })
    output.u8(ITEM_TYPES[type])
    output.bytes(value)
  },

  /** Appends EOM: the single byte `0C` (PV-0413, PV-0117). */
  appendEOM(output: ByteWriter): void {
    output.u8(ITEM_TYPES.eom)
  }
} as const
