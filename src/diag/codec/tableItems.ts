// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/TableItems.swift (MIT).

// Table controls (docs/protocol/elements.md §6): the structure Reading R-EL-7, the scroll state
// R-EL-8 (SCROLL_INFOS after the TABLE container, PV-0714), the scroll request R-EL-9 (page keys and
// the DYNT 09/05 row record, PV-0968) and row selection R-EL-10. The table's atoms are ordinary DYNT
// atoms; what this file adds is the record, the scroll state and the switches.

import { ByteWriter, WireBytes } from "../wire/index.js"
import { ApplItem } from "./applRegistry.js"
import { FixedSize } from "./diagCodec.js"
import { DiagItemEncoder } from "./diagItem.js"
import { ScrollInfos } from "./screenValues.js"

/**
 * How table controls are read (elements.md Readings R-EL-7 and R-EL-10, #110).
 * - `headerBlockZero`: the default: header labels in block 0, data rows in blocks 1 and up, a
 *   selector checkbox at column 0 (`TableLayout`).
 * - `specGap`: the fallback: the table's atoms stay placed elements, as before elements.md.
 */
export type TableReading = "headerBlockZero" | "specGap"
export const TableReading = { allCases: ["headerBlockZero", "specGap"] as readonly TableReading[] } as const

/**
 * How a table's scroll state is read (elements.md Reading R-EL-8, #110).
 * - `scrollInfosAfterContainer`: the default: the SCROLL_INFOS after the TABLE container (and its
 *   NAME), before the next RESET or geometry container, describes that table.
 * - `none`: the fallback: the total is unknown and the first row is 1.
 */
export type TableScrollStateReading = "scrollInfosAfterContainer" | "none"
export const TableScrollStateReading = { allCases: ["scrollInfosAfterContainer", "none"] as readonly TableScrollStateReading[] } as const

/**
 * How the client scrolls a table (elements.md Reading R-EL-9, #110).
 * - `keysAndRowRecord`: the default: page keys 80–83, and the DYNT 09/05 row record for a position.
 * - `keysOnly`: page keys only; a position request is refused.
 * - `specGap`: refused with gap #110.
 */
export type TableScrollReading = "keysAndRowRecord" | "keysOnly" | "specGap"
export const TableScrollReading = { allCases: ["keysAndRowRecord", "keysOnly", "specGap"] as readonly TableScrollReading[] } as const

/** The function number of each page key (PV-0731). */
const PAGE_KEYS = {
  /** Ctrl+PageUp: the first page. */
  first: 80, // provenance: PV-0731
  /** PageUp: the previous page. */
  previous: 81, // provenance: PV-0731
  /** PageDown: the next page. */
  next: 82, // provenance: PV-0731
  /** Ctrl+PageDown: the last page. */
  last: 83 // provenance: PV-0731
} as const

/**
 * The page keys of tables and lists (PV-0731, PV-0969): function numbers, sent as any function
 * number is (client-input.md R-CI-20 or R-CI-10); a list pages with `PageKey.listOKCode` by default.
 * `PageKey.rawValue` is the function number.
 */
export type PageKey = keyof typeof PAGE_KEYS

const PAGE_KEY_CASES = Object.keys(PAGE_KEYS) as PageKey[]

export const PageKey = {
  allCases: PAGE_KEY_CASES as readonly PageKey[],

  /** The function number. */
  rawValue(key: PageKey): number {
    return PAGE_KEYS[key]
  },

  /** The page key of a function number, or undefined (Swift `init?(rawValue:)`). */
  fromRaw(number: number): PageKey | undefined {
    return PAGE_KEY_CASES.find(key => PAGE_KEYS[key] === number)
  },

  /**
   * The function code the standard list status binds to the key (PV-0976), which both MIT clients
   * send as an OK-code to page a list (`ListPagingReading` `okCodes`, the default).
   */
  listOKCode(key: PageKey): string {
    switch (key) {
      case "first":
        return "P--"
      case "previous":
        return "P-"
      case "next":
        return "P+"
      case "last":
        return "P++"
    }
  }
} as const

/** Where Reading R-EL-7 puts a table's parts (invented: no source says where headers and the selector travel, #110). */
export const TableLayout = {
  /** The block of the header labels, one KEYWORD_2 per column at row 0. */
  headerBlock: 0,
  /** The block of the first visible data row; visible row i is block i. */
  firstDataBlock: 1,
  /** The column of the row-selector checkbox in each data row. */
  selectorColumn: 0
} as const

/**
 * The row record of DYNT 09/05 (TABLE_ROW_DAT_INPUT_DUMMY in pysap's names), which non-ALV table
 * controls page with (PV-0968): 4 bytes. Swooey reads them as a u16 BE first row, from 1, and a u16
 * BE flag word, 0 when the client sends it (Reading R-EL-9; the split is Swooey's).
 */
export class TableRowRecord {
  /** The value size (PV-0968). */
  static readonly size = 4 // provenance: PV-0968
  /** The item that carries it (PV-0458); the client sends it as APPL after its DYNT_ATOM item. */
  static readonly item: ApplItem = ApplItem.dynt("tableRowDatInputDummy")

  static readonly Offset = {
    firstRow: 0, // not-protocol: Swooey Reading R-EL-9 (the 2 + 2 split is ours)
    flags: 2 // not-protocol: Swooey Reading R-EL-9 (the 2 + 2 split is ours)
  } as const

  /** The first row to show, from 1. */
  readonly firstRow: number
  /** The flag word; 0 from the client. */
  readonly flags: number

  constructor(fields: { firstRow: number; flags?: number }) {
    this.firstRow = fields.firstRow
    this.flags = fields.flags ?? 0
  }

  /** Decodes exactly 4 value bytes. */
  static decode(value: Uint8Array): TableRowRecord {
    FixedSize.check(value, TableRowRecord.size)
    return new TableRowRecord({
      firstRow: WireBytes.u16BigEndian(value, TableRowRecord.Offset.firstRow), // not-protocol: Swooey Reading R-EL-9
      flags: WireBytes.u16BigEndian(value, TableRowRecord.Offset.flags) // not-protocol: Swooey Reading R-EL-9
    })
  }

  /** Appends the 4 value bytes. */
  append(output: ByteWriter): void {
    output.u16be(this.firstRow) // not-protocol: Swooey Reading R-EL-9
    output.u16be(this.flags) // not-protocol: Swooey Reading R-EL-9
  }

  /** The value bytes. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(TableRowRecord.size)
    this.append(output)
    return output.toBytes()
  }

  /** Appends the whole item: APPL DYNT 09/05 with the record. */
  appendItem(output: ByteWriter): void {
    DiagItemEncoder.appendAPPL(TableRowRecord.item, this.bytes, output)
  }
}

/** Swift `UInt32(clamping:)`. */
function clampU32(value: number): number {
  return Math.min(Math.max(value, 0), 0xffffffff)
}

/** The fields of a `TableScrollState`. */
export interface TableScrollStateFields {
  totalRows: number | undefined
  firstRow: number
  visibleRows: number
  totalWidth: number | undefined
  viewportWidth: number
}

/** A table control's scroll state in Reading R-EL-8's terms, and its SCROLL_INFOS value (PV-0714). */
export class TableScrollState implements TableScrollStateFields {
  /** All rows of the table (total_height); undefined when not known. */
  readonly totalRows: number | undefined
  /** The absolute line of the first visible row, from 1 (height_offset + 1). */
  readonly firstRow: number
  /** The rows the table shows (data_height). */
  readonly visibleRows: number
  /** The cells of all columns (total_width); undefined when not known. */
  readonly totalWidth: number | undefined
  /** The cells the table shows (data_width). */
  readonly viewportWidth: number

  constructor(fields: TableScrollStateFields) {
    this.totalRows = fields.totalRows
    this.firstRow = fields.firstRow
    this.visibleRows = fields.visibleRows
    this.totalWidth = fields.totalWidth
    this.viewportWidth = fields.viewportWidth
  }

  /** The state a SCROLL_INFOS value describes under R-EL-8 (Swift `init(scrollInfos:)`). */
  static fromScrollInfos(scrollInfos: ScrollInfos): TableScrollState {
    return new TableScrollState({
      totalRows: scrollInfos.totalHeight,
      firstRow: scrollInfos.heightOffset + 1,
      visibleRows: scrollInfos.dataHeight,
      totalWidth: scrollInfos.totalWidth,
      viewportWidth: scrollInfos.dataWidth
    })
  }

  /** The state without a SCROLL_INFOS (`TableScrollStateReading` `none`): total unknown, first row 1. */
  static unknown(visibleRows: number, viewportWidth: number): TableScrollState {
    return new TableScrollState({ totalRows: undefined, firstRow: 1, visibleRows, totalWidth: undefined, viewportWidth })
  }

  /**
   * The SCROLL_INFOS value of R-EL-8 (width_offset 0); unknown totals are written as the visible
   * values, and every number is clamped to the u32 range.
   */
  get scrollInfos(): ScrollInfos {
    return new ScrollInfos({
      totalHeight: clampU32(this.totalRows ?? this.visibleRows),
      totalWidth: clampU32(this.totalWidth ?? this.viewportWidth),
      dataHeight: clampU32(this.visibleRows),
      dataWidth: clampU32(this.viewportWidth),
      heightOffset: clampU32(this.firstRow - 1),
      widthOffset: 0
    })
  }
}
