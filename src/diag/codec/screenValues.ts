// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ScreenValues.swift (MIT).

// Value codecs of the fixed-size screen items of docs/protocol/server-screen.md §8 (window and
// area sizes, font metric, container geometry, scrolling, container loop, list focus). Every
// multi-byte field is big-endian (server-screen.md §8). Every codec decodes exactly its layout's
// size: a shorter value is `truncated`, a longer one `overlong` (IMPL-SS-3, the provisional policy
// of #39). A failing value leaves only its own item undecoded; the message stands.
//
// What the fields mean beyond their labels (units, how containers nest, what a focus version
// counts) is not stated (#33, #51); the codecs only split and join the bytes.
//
// This file's `extension CodecSpecGap` (itemValueLengthPolicy … uiEventDataWidth) is in
// diagCodec.ts, with the rest of `CodecSpecGap`.

import { ByteWriter, WireBytes } from "../wire/index.js"
import type { ApplItem } from "./applRegistry.js"
import { FixedSize } from "./diagCodec.js"

/**
 * A step the screen codecs cannot take because the spec does not state it; `issue` names the
 * spec-gap issue (docs/protocol/README.md, "How implementers use this spec").
 */
export type ScreenSpecGapErrorInfo = { readonly kind: "specGap"; readonly issue: number }

export class ScreenSpecGapError extends Error {
  constructor(readonly info: ScreenSpecGapErrorInfo) {
    super(`screen: not specified (spec gap #${info.issue})`)
    this.name = "ScreenSpecGapError"
  }
}

// MARK: - Window and area size

/**
 * The value of `VARINFO AREASIZE` (0x0C/0x07), `VARINFO AREA_PIXELSIZE` (0x0C/0x08) and `ST_USER
 * WSIZE` (0x04/0x0D): 16 bytes, four u32 BE in the order window_height, window_width, area_height,
 * area_width (PV-0704, PV-0705, PV-0706).
 *
 * pysap's renderer reads AREASIZE's window height and width as character cells; the pixel variant's
 * unit is named only by its item name (server-screen.md §8.3).
 */
export class AreaSize {
  /** The value size. */
  static readonly size = 16 // provenance: PV-0704, PV-0705, PV-0706

  static readonly Offset = {
    windowHeight: 0, // provenance: PV-0704
    windowWidth: 4, // provenance: PV-0704
    areaHeight: 8, // provenance: PV-0704
    areaWidth: 12 // provenance: PV-0704
  } as const

  readonly windowHeight: number
  readonly windowWidth: number
  readonly areaHeight: number
  readonly areaWidth: number

  constructor(fields: { windowHeight: number; windowWidth: number; areaHeight: number; areaWidth: number }) {
    this.windowHeight = fields.windowHeight
    this.windowWidth = fields.windowWidth
    this.areaHeight = fields.areaHeight
    this.areaWidth = fields.areaWidth
  }

  /** Decodes exactly 16 value bytes. */
  static decode(value: Uint8Array): AreaSize {
    FixedSize.check(value, AreaSize.size)
    return new AreaSize({
      windowHeight: WireBytes.u32BigEndian(value, AreaSize.Offset.windowHeight), // provenance: PV-0704
      windowWidth: WireBytes.u32BigEndian(value, AreaSize.Offset.windowWidth), // provenance: PV-0704
      areaHeight: WireBytes.u32BigEndian(value, AreaSize.Offset.areaHeight), // provenance: PV-0704
      areaWidth: WireBytes.u32BigEndian(value, AreaSize.Offset.areaWidth) // provenance: PV-0704
    })
  }

  /** Appends the 16 value bytes. */
  append(output: ByteWriter): void {
    WireBytes.appendU32BigEndian(this.windowHeight, output) // provenance: PV-0704
    WireBytes.appendU32BigEndian(this.windowWidth, output) // provenance: PV-0704
    WireBytes.appendU32BigEndian(this.areaHeight, output) // provenance: PV-0704
    WireBytes.appendU32BigEndian(this.areaWidth, output) // provenance: PV-0704
  }
}

// MARK: - Font metric

/**
 * The value of `ST_USER FONTMETRIC` (0x04/0x04): 8 bytes, four u16 BE labelled variable-font y,
 * variable-font x, fixed-font y, fixed-font x (PV-0728; Wireshark only).
 */
export class FontMetric {
  /** The value size. */
  static readonly size = 8 // provenance: PV-0728

  static readonly Offset = {
    variableY: 0, // provenance: PV-0728
    variableX: 2, // provenance: PV-0728
    fixedY: 4, // provenance: PV-0728
    fixedX: 6 // provenance: PV-0728
  } as const

  readonly variableY: number
  readonly variableX: number
  readonly fixedY: number
  readonly fixedX: number

  constructor(fields: { variableY: number; variableX: number; fixedY: number; fixedX: number }) {
    this.variableY = fields.variableY
    this.variableX = fields.variableX
    this.fixedY = fields.fixedY
    this.fixedX = fields.fixedX
  }

  /** Decodes exactly 8 value bytes. */
  static decode(value: Uint8Array): FontMetric {
    FixedSize.check(value, FontMetric.size)
    return new FontMetric({
      variableY: WireBytes.u16BigEndian(value, FontMetric.Offset.variableY), // provenance: PV-0728
      variableX: WireBytes.u16BigEndian(value, FontMetric.Offset.variableX), // provenance: PV-0728
      fixedY: WireBytes.u16BigEndian(value, FontMetric.Offset.fixedY), // provenance: PV-0728
      fixedX: WireBytes.u16BigEndian(value, FontMetric.Offset.fixedX) // provenance: PV-0728
    })
  }

  /** Appends the 8 value bytes. */
  append(output: ByteWriter): void {
    output.u16be(this.variableY) // provenance: PV-0728
    output.u16be(this.variableX) // provenance: PV-0728
    output.u16be(this.fixedY) // provenance: PV-0728
    output.u16be(this.fixedX) // provenance: PV-0728
  }
}

// MARK: - Container geometry

/**
 * The value of `CONTAINER` RESET (0x0A/0x01), LOOP (0x04), TABLE (0x05), TABSTRIP (0x08),
 * TABSTRIP_PAGE (0x09) and CONTROL (0x0A): 9 bytes, a u8 container id, then row, col, width and
 * height as u16 BE (PV-0712; Wireshark only).
 *
 * The geometry's units, how containers nest, and how their ids relate to the atoms' block, group
 * and area are not stated (#33).
 */
export class ContainerGeometry {
  /** The value size. */
  static readonly size = 9 // provenance: PV-0712

  static readonly Offset = {
    containerID: 0, // provenance: PV-0712
    row: 1, // provenance: PV-0712
    col: 3, // provenance: PV-0712
    width: 5, // provenance: PV-0712
    height: 7 // provenance: PV-0712
  } as const

  readonly containerID: number
  readonly row: number
  readonly col: number
  readonly width: number
  readonly height: number

  constructor(fields: { containerID: number; row: number; col: number; width: number; height: number }) {
    this.containerID = fields.containerID
    this.row = fields.row
    this.col = fields.col
    this.width = fields.width
    this.height = fields.height
  }

  /** Decodes exactly 9 value bytes. */
  static decode(value: Uint8Array): ContainerGeometry {
    FixedSize.check(value, ContainerGeometry.size)
    const offset = ContainerGeometry.Offset
    return new ContainerGeometry({
      containerID: value[offset.containerID],
      row: WireBytes.u16BigEndian(value, offset.row), // provenance: PV-0712
      col: WireBytes.u16BigEndian(value, offset.col), // provenance: PV-0712
      width: WireBytes.u16BigEndian(value, offset.width), // provenance: PV-0712
      height: WireBytes.u16BigEndian(value, offset.height) // provenance: PV-0712
    })
  }

  /** Appends the 9 value bytes. */
  append(output: ByteWriter): void {
    output.u8(this.containerID)
    output.u16be(this.row) // provenance: PV-0712
    output.u16be(this.col) // provenance: PV-0712
    output.u16be(this.width) // provenance: PV-0712
    output.u16be(this.height) // provenance: PV-0712
  }
}

// MARK: - Scrolling

/** The fields of a `ScrollInfos`. */
export interface ScrollInfosFields {
  totalHeight: number
  totalWidth: number
  dataHeight: number
  dataWidth: number
  heightOffset: number
  widthOffset: number
}

/**
 * The value of `VARINFO SCROLL_INFOS` (0x0C/0x02): 24 bytes, six u32 BE — total height, total
 * width, data height, data width, height offset, width offset (PV-0714; Wireshark only).
 */
export class ScrollInfos implements ScrollInfosFields {
  /** The value size. */
  static readonly size = 24 // provenance: PV-0714

  static readonly Offset = {
    totalHeight: 0, // provenance: PV-0714
    totalWidth: 4, // provenance: PV-0714
    dataHeight: 8, // provenance: PV-0714
    dataWidth: 12, // provenance: PV-0714
    heightOffset: 16, // provenance: PV-0714
    widthOffset: 20 // provenance: PV-0714
  } as const

  readonly totalHeight: number
  readonly totalWidth: number
  readonly dataHeight: number
  readonly dataWidth: number
  readonly heightOffset: number
  readonly widthOffset: number

  constructor(fields: ScrollInfosFields) {
    this.totalHeight = fields.totalHeight
    this.totalWidth = fields.totalWidth
    this.dataHeight = fields.dataHeight
    this.dataWidth = fields.dataWidth
    this.heightOffset = fields.heightOffset
    this.widthOffset = fields.widthOffset
  }

  /** Decodes exactly 24 value bytes. */
  static decode(value: Uint8Array): ScrollInfos {
    FixedSize.check(value, ScrollInfos.size)
    return ScrollInfos.fieldsOf(value)
  }

  /** The six fields from the first 24 bytes of `value`, which the caller has checked. */
  static fieldsOf(value: Uint8Array): ScrollInfos {
    const offset = ScrollInfos.Offset
    return new ScrollInfos({
      totalHeight: WireBytes.u32BigEndian(value, offset.totalHeight), // provenance: PV-0714
      totalWidth: WireBytes.u32BigEndian(value, offset.totalWidth), // provenance: PV-0714
      dataHeight: WireBytes.u32BigEndian(value, offset.dataHeight), // provenance: PV-0714
      dataWidth: WireBytes.u32BigEndian(value, offset.dataWidth), // provenance: PV-0714
      heightOffset: WireBytes.u32BigEndian(value, offset.heightOffset), // provenance: PV-0714
      widthOffset: WireBytes.u32BigEndian(value, offset.widthOffset) // provenance: PV-0714
    })
  }

  /** Appends the 24 value bytes. */
  append(output: ByteWriter): void {
    WireBytes.appendU32BigEndian(this.totalHeight, output) // provenance: PV-0714
    WireBytes.appendU32BigEndian(this.totalWidth, output) // provenance: PV-0714
    WireBytes.appendU32BigEndian(this.dataHeight, output) // provenance: PV-0714
    WireBytes.appendU32BigEndian(this.dataWidth, output) // provenance: PV-0714
    WireBytes.appendU32BigEndian(this.heightOffset, output) // provenance: PV-0714
    WireBytes.appendU32BigEndian(this.widthOffset, output) // provenance: PV-0714
  }
}

/**
 * The value of `VARINFO SCROLL_INFOS2` (0x0C/0x06): 33 bytes — the six fields of `ScrollInfos`,
 * then visible height and visible width (u32 BE), then a u8 scroll flag (PV-0715; Wireshark only).
 * What the flag's values mean is not stated.
 */
export class ScrollInfos2 {
  /** The value size. */
  static readonly size = 33 // provenance: PV-0715

  static readonly Offset = {
    visibleHeight: 24, // provenance: PV-0715
    visibleWidth: 28, // provenance: PV-0715
    scrollFlag: 32 // provenance: PV-0715
  } as const

  /** The six fields SCROLL_INFOS2 shares with SCROLL_INFOS, at the same offsets. */
  readonly scroll: ScrollInfos
  readonly visibleHeight: number
  readonly visibleWidth: number
  readonly scrollFlag: number

  constructor(fields: { scroll: ScrollInfos; visibleHeight: number; visibleWidth: number; scrollFlag: number }) {
    this.scroll = fields.scroll
    this.visibleHeight = fields.visibleHeight
    this.visibleWidth = fields.visibleWidth
    this.scrollFlag = fields.scrollFlag
  }

  /** Decodes exactly 33 value bytes. */
  static decode(value: Uint8Array): ScrollInfos2 {
    FixedSize.check(value, ScrollInfos2.size)
    return new ScrollInfos2({
      scroll: ScrollInfos.fieldsOf(value),
      visibleHeight: WireBytes.u32BigEndian(value, ScrollInfos2.Offset.visibleHeight), // provenance: PV-0715
      visibleWidth: WireBytes.u32BigEndian(value, ScrollInfos2.Offset.visibleWidth), // provenance: PV-0715
      scrollFlag: value[ScrollInfos2.Offset.scrollFlag]
    })
  }

  /** Appends the 33 value bytes. */
  append(output: ByteWriter): void {
    this.scroll.append(output)
    WireBytes.appendU32BigEndian(this.visibleHeight, output) // provenance: PV-0715
    WireBytes.appendU32BigEndian(this.visibleWidth, output) // provenance: PV-0715
    output.u8(this.scrollFlag)
  }
}

// MARK: - Container loop and list focus

/**
 * The value of `VARINFO CONTAINER_LOOP` (0x0C/0x0C): one u16 BE, labelled lines per loop row
 * (PV-0716; Wireshark only).
 */
export class ContainerLoop {
  /** The value size. */
  static readonly size = 2 // provenance: PV-0716

  readonly linesPerLoopRow: number

  constructor(fields: { linesPerLoopRow: number }) {
    this.linesPerLoopRow = fields.linesPerLoopRow
  }

  /** Decodes exactly 2 value bytes. */
  static decode(value: Uint8Array): ContainerLoop {
    FixedSize.check(value, ContainerLoop.size)
    return new ContainerLoop({ linesPerLoopRow: WireBytes.u16BigEndian(value, 0) }) // provenance: PV-0716
  }

  /** Appends the 2 value bytes. */
  append(output: ByteWriter): void {
    output.u16be(this.linesPerLoopRow) // provenance: PV-0716
  }
}

/**
 * The value of `VARINFO LIST_FOCUS` (0x0C/0x0D): 5 bytes, a u8 version, then row and column as u16
 * BE (PV-0717; Wireshark only). When a server sends it, and what the version counts, is #51.
 */
export class ListFocus {
  /** The value size. */
  static readonly size = 5 // provenance: PV-0717

  static readonly Offset = {
    version: 0, // provenance: PV-0717
    row: 1, // provenance: PV-0717
    col: 3 // provenance: PV-0717
  } as const

  readonly version: number
  readonly row: number
  readonly col: number

  constructor(fields: { version: number; row: number; col: number }) {
    this.version = fields.version
    this.row = fields.row
    this.col = fields.col
  }

  /** Decodes exactly 5 value bytes. */
  static decode(value: Uint8Array): ListFocus {
    FixedSize.check(value, ListFocus.size)
    return new ListFocus({
      version: value[ListFocus.Offset.version],
      row: WireBytes.u16BigEndian(value, ListFocus.Offset.row), // provenance: PV-0717
      col: WireBytes.u16BigEndian(value, ListFocus.Offset.col) // provenance: PV-0717
    })
  }

  /** Appends the 5 value bytes. */
  append(output: ByteWriter): void {
    output.u8(this.version)
    output.u16be(this.row) // provenance: PV-0717
    output.u16be(this.col) // provenance: PV-0717
  }
}

// MARK: - Dispatch by (id, sid)

/**
 * The fixed-size layouts of server-screen.md §8, and which (id, sid) pairs use each. Dispatch is
 * on (id, sid) alone, whichever carrier brought the item (IMPL-IT-9).
 * - `areaSize`: VARINFO AREASIZE, VARINFO AREA_PIXELSIZE, ST_USER WSIZE (`AreaSize`).
 * - `fontMetric`: ST_USER FONTMETRIC (`FontMetric`).
 * - `containerGeometry`: CONTAINER RESET, LOOP, TABLE, TABSTRIP, TABSTRIP_PAGE, CONTROL
 *   (`ContainerGeometry`).
 * - `scrollInfos`: VARINFO SCROLL_INFOS (`ScrollInfos`).
 * - `scrollInfos2`: VARINFO SCROLL_INFOS2 (`ScrollInfos2`).
 * - `containerLoop`: VARINFO CONTAINER_LOOP (`ContainerLoop`).
 * - `listFocus`: VARINFO LIST_FOCUS (`ListFocus`).
 */
export type ScreenValueLayout =
  | "areaSize"
  | "fontMetric"
  | "containerGeometry"
  | "scrollInfos"
  | "scrollInfos2"
  | "containerLoop"
  | "listFocus"

export const ScreenValueLayout = {
  allCases: [
    "areaSize",
    "fontMetric",
    "containerGeometry",
    "scrollInfos",
    "scrollInfos2",
    "containerLoop",
    "listFocus"
  ] as readonly ScreenValueLayout[],

  /**
   * The layout of `item`, or undefined when server-screen.md gives the pair no fixed-size layout.
   * CONTAINER DEFAULT, XMLPROP, SPLITTER and SPLITTER_CELL and VARINFO MAINAREA_PIXELSIZE are
   * decoded by neither source (#33) and have none; SUBSCREEN is a geometry (Reading R-SS-16,
   * trial-derived).
   */
  of(item: ApplItem): ScreenValueLayout | undefined {
    switch (item.kind) {
      case "varInfo":
        switch (item.sid) {
          case "areaSize":
          case "areaPixelSize":
            return "areaSize"
          case "scrollInfos":
            return "scrollInfos"
          case "scrollInfos2":
            return "scrollInfos2"
          case "containerLoop":
            return "containerLoop"
          case "listFocus":
            return "listFocus"
          default:
            return undefined
        }
      case "stUser":
        if (item.sid === "wsize") return "areaSize"
        if (item.sid === "fontMetric") return "fontMetric"
        return undefined
      case "container":
        switch (item.sid) {
          case "reset":
          case "loop":
          case "table":
          case "tabstrip":
          case "tabstripPage":
          case "control":
          case "subscreen":
            return "containerGeometry"
          default:
            return undefined
        }
      default:
        return undefined
    }
  },

  /** The exact value size of the layout. */
  size(layout: ScreenValueLayout): number {
    switch (layout) {
      case "areaSize":
        return AreaSize.size
      case "fontMetric":
        return FontMetric.size
      case "containerGeometry":
        return ContainerGeometry.size
      case "scrollInfos":
        return ScrollInfos.size
      case "scrollInfos2":
        return ScrollInfos2.size
      case "containerLoop":
        return ContainerLoop.size
      case "listFocus":
        return ListFocus.size
    }
  }
} as const

/** A decoded fixed-size screen value (server-screen.md §8). */
export type ScreenValue =
  | { readonly kind: "areaSize"; readonly value: AreaSize }
  | { readonly kind: "fontMetric"; readonly value: FontMetric }
  | { readonly kind: "containerGeometry"; readonly value: ContainerGeometry }
  | { readonly kind: "scrollInfos"; readonly value: ScrollInfos }
  | { readonly kind: "scrollInfos2"; readonly value: ScrollInfos2 }
  | { readonly kind: "containerLoop"; readonly value: ContainerLoop }
  | { readonly kind: "listFocus"; readonly value: ListFocus }

export const ScreenValue = {
  /** Decodes `value` in `layout`: exactly the layout's size, else `truncated` or `overlong` (IMPL-SS-3). */
  decode(layout: ScreenValueLayout, value: Uint8Array): ScreenValue {
    switch (layout) {
      case "areaSize":
        return { kind: "areaSize", value: AreaSize.decode(value) }
      case "fontMetric":
        return { kind: "fontMetric", value: FontMetric.decode(value) }
      case "containerGeometry":
        return { kind: "containerGeometry", value: ContainerGeometry.decode(value) }
      case "scrollInfos":
        return { kind: "scrollInfos", value: ScrollInfos.decode(value) }
      case "scrollInfos2":
        return { kind: "scrollInfos2", value: ScrollInfos2.decode(value) }
      case "containerLoop":
        return { kind: "containerLoop", value: ContainerLoop.decode(value) }
      case "listFocus":
        return { kind: "listFocus", value: ListFocus.decode(value) }
    }
  },

  /** The layout of this value. */
  layout(value: ScreenValue): ScreenValueLayout {
    return value.kind
  },

  /** Appends the value bytes (not the item header). */
  append(value: ScreenValue, output: ByteWriter): void {
    value.value.append(output)
  },

  /** The value bytes. */
  bytes(value: ScreenValue): Uint8Array {
    const output = new ByteWriter(ScreenValueLayout.size(value.kind))
    value.value.append(output)
    return output.toBytes()
  }
} as const
