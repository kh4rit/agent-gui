// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/UIEventFunctionKey.swift (MIT).

// The function-key form of UI_EVENT_SOURCE (docs/protocol/client-input.md §7.5): the item a GUI
// sends when a function key, a toolbar button or a menu item bound to a function number fires. With
// NAVIGATION_DATA clear, the width of the event-data field is a conflict between pysap (1 byte) and
// Wireshark (4 bytes), #56. ODG's observation of a real GUI's function-key event fits Wireshark's
// width (PV-0771), so Reading R-CI-9 takes it, switchable to pysap's. Every source puts the function
// number at offset 5 (PV-0772), so reading the number needs no choice.
//
// Swift's `extension UIEventSource` of this file (`functionKeyFlags`, `firedFunctionNumber(in:)`,
// `appendFunctionKey(...)` and the field sizes) is statics of `UIEventFunctionKey`: a TypeScript
// class cannot be extended from another module, and uiEventSource.ts cannot import this file
// without an import cycle. `extension UIControlType` (`field`, `dynpro`) is in uiEventSource.ts.

import { WireBytes, type ByteWriter } from "../wire/index.js"
import { ByteRange, ItemPayloadError } from "./diagCodec.js"
import { ScreenValueEncodingError } from "./screenListValues.js"
import { UIControlType, UIEventSource, UIEventType, UIEventValidFlags } from "./uiEventSource.js"

/**
 * The width of the event-data field of UI_EVENT_SOURCE when NAVIGATION_DATA is clear (#56).
 * - `fourBytes`: four bytes, as Wireshark reads them and as ODG's observed sample fits (Reading
 *   R-CI-9, PV-0771). The default.
 * - `oneByte`: one byte, as pysap reads it (client-input.md §7.2).
 */
export type UIEventDataWidth = "fourBytes" | "oneByte"

export const UIEventDataWidth = {
  allCases: ["fourBytes", "oneByte"] as readonly UIEventDataWidth[],

  /** The field's byte count. */
  byteCount(width: UIEventDataWidth): number {
    return width === "fourBytes" ? UIEventFunctionKey.wiresharkEventDataSize : 1
  }
} as const

/** The optional fields of a function-key event for `UIEventFunctionKey.appendFunctionKey`. */
export interface UIEventFunctionKeyOptions {
  /** The event-data width; `fourBytes` by default. */
  width?: UIEventDataWidth
  /** FIELD by default, where the cursor stood in a field. */
  controlType?: UIControlType
  controlRow?: number
  controlCol?: number
  /** One id 0 by default, as in ODG's sample. */
  containerIDs?: ArrayLike<number>
}

/**
 * A function-key event of UI_EVENT_SOURCE with NAVIGATION_DATA clear, decoded under one
 * `UIEventDataWidth`: the fired function number, the cursor position and the container ids.
 */
export class UIEventFunctionKey {
  /** Four bytes of event data under Wireshark's reading (PV-0771). */
  static readonly wiresharkEventDataSize = 4 // provenance: PV-0771
  /** The one container id ODG's sample carries: 0 (PV-0771). */
  static readonly sampleContainerID = 0 // provenance: PV-0771

  // Swift's `extension UIEventSource`:

  /** control_row and control_col, u16 BE each (PV-0765). (Swift `UIEventSource.controlFieldSize`.) */
  static readonly controlFieldSize = 2 // provenance: PV-0765
  /** (Swift `UIEventSource.controlPositionSize`.) */
  static readonly controlPositionSize = UIEventFunctionKey.controlFieldSize * 2 // provenance: PV-0765
  /** The container count, u16 BE (PV-0770). (Swift `UIEventSource.containerCountSize`.) */
  static readonly containerCountSize = 2 // provenance: PV-0770
  /**
   * The valid flags of a function-key event as a GUI sends it: FUNCTIONKEY_DATA and CONTROL_POS
   * (PV-0771). (Swift `UIEventSource.functionKeyFlags`.)
   */
  static readonly functionKeyFlags: UIEventValidFlags = UIEventValidFlags.functionKeyData | UIEventValidFlags.controlPosition

  /** The fired function number: the first event-data byte, at offset 5 (PV-0772). */
  readonly functionNumber: number
  /** The event-data bytes, offsets into the value; the first is `functionNumber`. */
  readonly eventData: ByteRange
  /** The cursor's row and column (PV-0765); a GUI sets CONTROL_POS with them (PV-0771). */
  readonly controlRow: number
  readonly controlCol: number
  /** The container ids, one byte each, offsets into the value (PV-0770, PV-0765). */
  readonly containerIDs: ByteRange

  constructor(fields: { functionNumber: number; eventData: ByteRange; controlRow: number; controlCol: number; containerIDs: ByteRange }) {
    this.functionNumber = fields.functionNumber
    this.eventData = fields.eventData
    this.controlRow = fields.controlRow
    this.controlCol = fields.controlCol
    this.containerIDs = fields.containerIDs
  }

  /**
   * Decodes the part after control_type of a UI_EVENT_SOURCE value whose NAVIGATION_DATA is clear,
   * with the event data `width` wide. A value shorter than the layout needs is `truncated`; bytes
   * after the counted container ids are `overlong` (#39's provisional policy, as for the navigation
   * form). Whether the value is a function-key event at all is the caller's check
   * (`firedFunctionNumber`). (Swift `init(value:width:)`.)
   */
  static decode(value: Uint8Array, width: UIEventDataWidth = "fourBytes"): UIEventFunctionKey {
    const detail = UIEventSource.Offset.detail
    const rowOffset = detail + UIEventDataWidth.byteCount(width)
    const countOffset = rowOffset + UIEventFunctionKey.controlPositionSize
    const idsOffset = countOffset + UIEventFunctionKey.containerCountSize
    if (!(value.length >= idsOffset)) throw new ItemPayloadError({ kind: "truncated", needed: idsOffset, available: value.length })
    const count = WireBytes.u16BigEndian(value, countOffset) // provenance: PV-0770
    const needed = idsOffset + count
    if (!(value.length >= needed)) throw new ItemPayloadError({ kind: "truncated", needed, available: value.length })
    if (value.length !== needed) throw new ItemPayloadError({ kind: "overlong", expected: needed, actual: value.length })
    return new UIEventFunctionKey({
      functionNumber: value[detail],
      eventData: new ByteRange(detail, rowOffset),
      controlRow: WireBytes.u16BigEndian(value, rowOffset), // provenance: PV-0765
      controlCol: WireBytes.u16BigEndian(value, rowOffset + UIEventFunctionKey.controlFieldSize), // provenance: PV-0765
      containerIDs: new ByteRange(idsOffset, needed)
    })
  }

  /**
   * The function number a UI_EVENT_SOURCE value fires, or undefined when it is no function-key
   * event: FUNCTIONKEY_DATA must be set, NAVIGATION_DATA clear, event_type FUNCTIONKEY, and the
   * value long enough to hold offset 5. The number is at offset 5 under both sources' readings and
   * in ODG's sample (PV-0772), so no width is chosen here. (Swift
   * `UIEventSource.firedFunctionNumber(in:)`.)
   */
  static firedFunctionNumber(value: Uint8Array): number | undefined {
    const offset = UIEventSource.Offset
    if (!(value.length > offset.detail)) return undefined
    const flags = value[offset.validFlags]
    if (
      (flags & UIEventValidFlags.functionKeyData) === 0 ||
      (flags & UIEventValidFlags.navigationData) !== 0 ||
      WireBytes.u16BigEndian(value, offset.eventType) !== UIEventType.functionKey // provenance: PV-0764
    )
      return undefined
    return value[offset.detail]
  }

  /**
   * Appends the UI_EVENT_SOURCE value of a function-key event, the form ODG observed a GUI send and
   * its client sends (PV-0771): the valid flags `functionKeyFlags`, event_type FUNCTIONKEY,
   * `controlType` (FIELD in the sample, where the cursor stood in a field), the event data `width`
   * wide with the function number in its first byte and zeros after it, the cursor's row and
   * column, and `containerIDs` (one id 0 in the sample). With the default four-byte width and a row
   * and column below 256 the bytes are exactly the sample's; the one-byte width is pysap's reading
   * (#56). Nothing is appended when it throws. (Swift
   * `UIEventSource.appendFunctionKey(_:width:controlType:controlRow:controlCol:containerIDs:to:)`.)
   */
  static appendFunctionKey(number: number, options: UIEventFunctionKeyOptions, output: ByteWriter): void {
    const containerIDs = options.containerIDs ?? [UIEventFunctionKey.sampleContainerID]
    if (!(containerIDs.length <= UIEventSource.maxContainerCount))
      throw new ScreenValueEncodingError({ kind: "tooManyEntries", count: containerIDs.length, limit: UIEventSource.maxContainerCount })
    output.u8(UIEventFunctionKey.functionKeyFlags)
    output.u16be(UIEventType.functionKey) // provenance: PV-0764
    output.u16be(options.controlType ?? UIControlType.field) // provenance: PV-0764
    output.u8(number)
    output.repeat(0, UIEventDataWidth.byteCount(options.width ?? "fourBytes") - 1)
    output.u16be(options.controlRow ?? 0) // provenance: PV-0765
    output.u16be(options.controlCol ?? 0) // provenance: PV-0765
    output.u16be(containerIDs.length) // provenance: PV-0770
    output.bytes(containerIDs)
  }
}
