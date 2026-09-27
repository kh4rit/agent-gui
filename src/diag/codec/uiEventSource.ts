// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/UIEventSource.swift (MIT).

// The UI_EVENT_SOURCE item (id 0x0F, sid 0x01; docs/protocol/client-input.md §7.2, §7.3): the
// interaction that triggered a dialog step. Both sources agree on the fixed leading fields and,
// when NAVIGATION_DATA is set, on everything after them; with NAVIGATION_DATA clear they disagree
// on the width of the event-data field (#56), so everything after control_type stays opaque
// (R-CI-7). Whether a client must send this item to trigger a function is #55.
//
// UIEventFunctionKey.swift extends UIEventSource with the function-key form; those members are
// statics of `UIEventFunctionKey` (uiEventFunctionKey.ts), except the two control types it adds to
// `UIControlType` (`field`, `dynpro`), which are constants of the object below.

import { WireBytes, type ByteWriter } from "../wire/index.js"
import { ByteRange, CodecSpecGap, ItemPayloadError } from "./diagCodec.js"
import { ScreenValueEncodingError } from "./screenListValues.js"
import { ScreenSpecGapError } from "./screenValues.js"

/**
 * The valid-flags byte at offset 0 of UI_EVENT_SOURCE (PV-0763): four bits both sources name (masks
 * from Wireshark). pysap names the other four bits unused. A value is the byte itself (Swift
 * `OptionSet`).
 */
export type UIEventValidFlags = number

export const UIEventValidFlags = {
  /** The menu position is valid. */
  menuPosition: 0x01, // provenance: PV-0763
  /** The control row and column are valid. */
  controlPosition: 0x02, // provenance: PV-0763
  /** The navigation-data field is valid. */
  navigationData: 0x04, // provenance: PV-0763
  /** The function-key data field is valid. */
  functionKeyData: 0x08, // provenance: PV-0763

  /** The four named bits with the names the spec's table writes, in ascending mask order. */
  named: [
    { flag: 0x01, name: "MENU_POS" },
    { flag: 0x02, name: "CONTROL_POS" },
    { flag: 0x04, name: "NAVIGATION_DATA" },
    { flag: 0x08, name: "FUNCTIONKEY_DATA" }
  ] as readonly { readonly flag: number; readonly name: string }[],

  /** Names of the named bits that are set, in ascending mask order. Unnamed bits are not listed. */
  names(flags: UIEventValidFlags): string[] {
    return UIEventValidFlags.named.filter(entry => (flags & entry.flag) !== 0).map(entry => entry.name)
  }
} as const

/**
 * The event_type field of UI_EVENT_SOURCE, u16 BE (PV-0764), with the names both sources give
 * (PV-0766). Values without a name (0x04, 0x05 and others) are kept. A value is the number itself
 * (Swift `RawRepresentable`).
 */
export type UIEventType = number

export const UIEventType = {
  /** A function-key press (informative: client-input.md §7.3). */
  functionKey: 0x07, // provenance: PV-0766

  names: [
    { value: 0x01, name: "SELECT" }, // provenance: PV-0766
    { value: 0x02, name: "HE" }, // provenance: PV-0766
    { value: 0x03, name: "VALUEHELP" }, // provenance: PV-0766
    { value: 0x06, name: "RESIZE" }, // provenance: PV-0766
    { value: 0x07, name: "FUNCTIONKEY" }, // provenance: PV-0766
    { value: 0x08, name: "SCROLL" }, // provenance: PV-0766
    { value: 0x09, name: "BUTTONPRESSED" }, // provenance: PV-0766
    { value: 0x0a, name: "VALUECHANGED" }, // provenance: PV-0766
    { value: 0x0b, name: "STATECHANGED" }, // provenance: PV-0766
    { value: 0x0c, name: "NAVIGATION" } // provenance: PV-0766
  ] as readonly { readonly value: number; readonly name: string }[],

  /** The value's name in the table of PV-0766, or undefined. */
  name(type: UIEventType): string | undefined {
    return UIEventType.names.find(entry => entry.value === type)?.name
  }
} as const

/**
 * The control_type field of UI_EVENT_SOURCE, u16 BE (PV-0764), with the names both sources give
 * (PV-0767). Values without a name (0x0C and others) are kept. A value is the number itself (Swift
 * `RawRepresentable`).
 */
export type UIControlType = number

export const UIControlType = {
  /** The command field as a control type (informative: client-input.md §7.3). */
  okcode: 0x14, // provenance: PV-0767
  /**
   * A field: where the cursor stood when the function fired, in ODG's sample (PV-0767, PV-0771).
   * (Declared in UIEventFunctionKey.swift, `extension UIControlType`.)
   */
  field: 0x01, // provenance: PV-0767
  /**
   * The screen as a whole: the control type pysap's example server expects with a function key
   * (PV-0725). (Declared in UIEventFunctionKey.swift, `extension UIControlType`.)
   */
  dynpro: 0x0a, // provenance: PV-0767

  names: [
    { value: 0x00, name: "NONE" }, // provenance: PV-0767
    { value: 0x01, name: "FIELD" }, // provenance: PV-0767
    { value: 0x02, name: "RADIOBUTTON" }, // provenance: PV-0767
    { value: 0x03, name: "CHECKBUTTON" }, // provenance: PV-0767
    { value: 0x04, name: "MENUBUTTON" }, // provenance: PV-0767
    { value: 0x05, name: "TOOLBARBUTTON" }, // provenance: PV-0767
    { value: 0x06, name: "STANDARDTOOLBARBUTTON" }, // provenance: PV-0767
    { value: 0x07, name: "PUSHBUTTON" }, // provenance: PV-0767
    { value: 0x08, name: "TABLEVIEW" }, // provenance: PV-0767
    { value: 0x09, name: "TABSTRIP" }, // provenance: PV-0767
    { value: 0x0a, name: "DYNPRO" }, // provenance: PV-0767
    { value: 0x0b, name: "CUSTOM_CONTROL" }, // provenance: PV-0767
    { value: 0x0d, name: "FRAME" }, // provenance: PV-0767
    { value: 0x0e, name: "TABLEVIEW_COLSEL_BUTTON" }, // provenance: PV-0767
    { value: 0x0f, name: "TABLEVIEW_ROWSEL_BUTTON" }, // provenance: PV-0767
    { value: 0x10, name: "TABLEVIEW_CELL" }, // provenance: PV-0767
    { value: 0x11, name: "CONTEXTMENU" }, // provenance: PV-0767
    { value: 0x12, name: "SPLITTER" }, // provenance: PV-0767
    { value: 0x13, name: "MESSAGE" }, // provenance: PV-0767
    { value: 0x14, name: "OKCODE" }, // provenance: PV-0767
    { value: 0x15, name: "ACC_CONTAINER" } // provenance: PV-0767
  ] as readonly { readonly value: number; readonly name: string }[],

  /** The value's name in the table of PV-0767, or undefined. */
  name(type: UIControlType): string | undefined {
    return UIControlType.names.find(entry => entry.value === type)?.name
  }
} as const

/**
 * The one-byte navigation_data field, present when NAVIGATION_DATA is set (PV-0768 names). A value
 * is the byte itself (Swift `RawRepresentable`).
 */
export type UINavigationData = number

export const UINavigationData = {
  names: [
    { value: 0x01, name: "TAB" }, // provenance: PV-0768
    { value: 0x02, name: "TAB_BACK" }, // provenance: PV-0768
    { value: 0x03, name: "JUMP_OVER" }, // provenance: PV-0768
    { value: 0x04, name: "JUMP_OVER_BACK" }, // provenance: PV-0768
    { value: 0x05, name: "JUMP_OUT" }, // provenance: PV-0768
    { value: 0x06, name: "JUMP_OUT_BACK" }, // provenance: PV-0768
    { value: 0x07, name: "JUMP_SECTION" }, // provenance: PV-0768
    { value: 0x08, name: "JUMP_SECTION_BACK" }, // provenance: PV-0768
    { value: 0x09, name: "FIRST_FIELD" }, // provenance: PV-0768
    { value: 0x0a, name: "LAST_FIELD" } // provenance: PV-0768
  ] as readonly { readonly value: number; readonly name: string }[],

  /** The value's name in the table of PV-0768, or undefined. */
  name(data: UINavigationData): string | undefined {
    return UINavigationData.names.find(entry => entry.value === data)?.name
  }
} as const

/**
 * The part of UI_EVENT_SOURCE after control_type when NAVIGATION_DATA is set: the navigation data,
 * the control position and the container ids (R-CI-7).
 */
export class UIEventNavigation {
  readonly navigationData: UINavigationData
  /** Decoded whatever the CONTROL_POS flag says; Wireshark notes they are ignored unless it is set (PV-0765). */
  readonly controlRow: number
  readonly controlCol: number
  /** The container ids, one byte each, as many as the u16 BE count says (PV-0770, PV-0765). Offsets into the value. */
  readonly containerIDs: ByteRange

  constructor(fields: { navigationData: UINavigationData; controlRow: number; controlCol: number; containerIDs: ByteRange }) {
    this.navigationData = fields.navigationData
    this.controlRow = fields.controlRow
    this.controlCol = fields.controlCol
    this.containerIDs = fields.containerIDs
  }
}

/**
 * What follows control_type.
 * - `navigation`: NAVIGATION_DATA is set: decoded (R-CI-7).
 * - `undecoded`: NAVIGATION_DATA is clear: the event-data width is a conflict between the sources
 *   (#56), so nothing after control_type can be located. The bytes stay opaque.
 */
export type UIEventDetail = { readonly kind: "navigation"; readonly value: UIEventNavigation } | { readonly kind: "undecoded"; readonly value: ByteRange }

/** The fields of a UI_EVENT_SOURCE value with NAVIGATION_DATA set, for `UIEventSource.append`. */
export interface UIEventSourceContent {
  validFlags: UIEventValidFlags
  eventType: UIEventType
  controlType: UIControlType
  navigationData: UINavigationData
  controlRow: number
  controlCol: number
  containerIDs: Uint8Array
}

/**
 * The value of `UI_EVENT UI_EVENT_SOURCE` (0x0F/0x01) (client-input.md §7.2).
 *
 * Layout: the valid-flags byte (PV-0763), event_type and control_type as u16 BE (PV-0764); then,
 * when NAVIGATION_DATA is set, the u8 navigation data, control_row and control_col as u16 BE
 * (PV-0765), a u16 BE container count (PV-0770) and that many one-byte container ids. A value
 * shorter than its layout needs is `truncated`; bytes after the counted container ids are
 * `overlong`, the provisional length policy of #39 applied as IMPL-SS-3 applies it to IMODEUUIDS2.
 * With NAVIGATION_DATA clear, only the first five bytes are checked.
 */
export class UIEventSource {
  static readonly Offset = {
    validFlags: 0, // provenance: PV-0763
    eventType: 1, // provenance: PV-0764
    controlType: 3, // provenance: PV-0764
    /** The middle field: navigation data when NAVIGATION_DATA is set. */
    detail: 5, // provenance: PV-0764
    controlRow: 6, // provenance: PV-0765
    controlCol: 8, // provenance: PV-0765
    containerCount: 10, // provenance: PV-0770
    containerIDs: 12 // provenance: PV-0770
  } as const

  /** The valid flags, event_type and control_type. */
  static readonly fixedSize = UIEventSource.Offset.detail
  /** Most container ids the u16 count can declare. */
  static readonly maxContainerCount = 0xffff // provenance: PV-0770

  readonly validFlags: UIEventValidFlags
  readonly eventType: UIEventType
  readonly controlType: UIControlType
  readonly detail: UIEventDetail

  constructor(fields: { validFlags: UIEventValidFlags; eventType: UIEventType; controlType: UIControlType; detail: UIEventDetail }) {
    this.validFlags = fields.validFlags
    this.eventType = fields.eventType
    this.controlType = fields.controlType
    this.detail = fields.detail
  }

  /** Decodes a UI_EVENT_SOURCE value (R-CI-7). */
  static decode(value: Uint8Array): UIEventSource {
    const offset = UIEventSource.Offset
    if (!(value.length >= UIEventSource.fixedSize))
      throw new ItemPayloadError({ kind: "truncated", needed: UIEventSource.fixedSize, available: value.length })
    const validFlags = value[offset.validFlags]
    const eventType = WireBytes.u16BigEndian(value, offset.eventType) // provenance: PV-0764
    const controlType = WireBytes.u16BigEndian(value, offset.controlType) // provenance: PV-0764
    if ((validFlags & UIEventValidFlags.navigationData) === 0)
      return new UIEventSource({ validFlags, eventType, controlType, detail: { kind: "undecoded", value: new ByteRange(UIEventSource.fixedSize, value.length) } })
    if (!(value.length >= offset.containerIDs)) throw new ItemPayloadError({ kind: "truncated", needed: offset.containerIDs, available: value.length })
    const count = WireBytes.u16BigEndian(value, offset.containerCount) // provenance: PV-0770
    const needed = offset.containerIDs + count
    if (!(value.length >= needed)) throw new ItemPayloadError({ kind: "truncated", needed, available: value.length })
    if (value.length !== needed) throw new ItemPayloadError({ kind: "overlong", expected: needed, actual: value.length })
    const navigation = new UIEventNavigation({
      navigationData: value[offset.detail],
      controlRow: WireBytes.u16BigEndian(value, offset.controlRow), // provenance: PV-0765
      controlCol: WireBytes.u16BigEndian(value, offset.controlCol), // provenance: PV-0765
      containerIDs: new ByteRange(offset.containerIDs, needed)
    })
    return new UIEventSource({ validFlags, eventType, controlType, detail: { kind: "navigation", value: navigation } })
  }

  /**
   * The navigation part. Throws `ScreenSpecGapError` with issue 56 when NAVIGATION_DATA is clear:
   * then the event-data width is a conflict and nothing after control_type can be read.
   */
  navigation(): UIEventNavigation {
    if (this.detail.kind !== "navigation") throw new ScreenSpecGapError({ kind: "specGap", issue: CodecSpecGap.uiEventDataWidth })
    return this.detail.value
  }

  /**
   * Appends a UI_EVENT_SOURCE value with NAVIGATION_DATA set, the only form whose layout both
   * sources agree on. `validFlags` must contain `navigationData`: without it the event-data width
   * is #56, and the call fails with `ScreenValueEncodingError` `specGap`. Whether a real server acts
   * on the item, and which item triggers a function, is #55; this is the layout only. Nothing is
   * appended when it throws.
   */
  static append(event: UIEventSourceContent, output: ByteWriter): void {
    if ((event.validFlags & UIEventValidFlags.navigationData) === 0)
      throw new ScreenValueEncodingError({ kind: "specGap", issue: CodecSpecGap.uiEventDataWidth })
    if (!(event.containerIDs.length <= UIEventSource.maxContainerCount))
      throw new ScreenValueEncodingError({ kind: "tooManyEntries", count: event.containerIDs.length, limit: UIEventSource.maxContainerCount })
    output.u8(event.validFlags)
    output.u16be(event.eventType) // provenance: PV-0764
    output.u16be(event.controlType) // provenance: PV-0764
    output.u8(event.navigationData)
    output.u16be(event.controlRow) // provenance: PV-0765
    output.u16be(event.controlCol) // provenance: PV-0765
    output.u16be(event.containerIDs.length) // provenance: PV-0770
    output.bytes(event.containerIDs)
  }
}
