// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenTable.swift (MIT).

// The model of a table control (docs/protocol/elements.md §6, Readings R-EL-7 to R-EL-10). Pinned
// API of the mock-apps work. Step loops stay plain placed elements (R-SS-14); the cells of a table
// stay ordinary `ScreenElement`s with `ScreenElement.table` set, so focus, edits and the input step
// treat them like any field.

import type { TableScrollState } from "../codec/index.js"
import type { ScreenElementID, ScreenElementKind } from "./screenElement.js"
import type { GridRect } from "./screenLayout.js"

/** One column of a table control (elements.md Reading R-EL-7): from its header label in block 0. */
export class ScreenTableColumn {
  /** 0-based, left to right; the selector is not a column. */
  readonly index: number
  /** The header label's caption; undefined when the table has no header labels. */
  readonly title: string | undefined
  /** The header label's FNAME, the column's field name. */
  readonly fieldName: string | undefined
  /** The width in cells. */
  readonly width: number
  /** What the column's cells are: `input`, `output`, `checkbox` or `dropdown`. */
  readonly kind: ScreenElementKind
  /** In the leading run of protected columns: kept in view (R-EL-8). */
  readonly isKey: boolean

  constructor(fields: {
    index: number
    title: string | undefined
    fieldName: string | undefined
    width: number
    kind: ScreenElementKind
    isKey: boolean
  }) {
    this.index = fields.index
    this.title = fields.title
    this.fieldName = fields.fieldName
    this.width = fields.width
    this.kind = fields.kind
    this.isKey = fields.isKey
  }

  /** The index (Swift `Identifiable`). */
  get id(): number {
    return this.index
  }
}

/** One row of a table control that the screen carries. */
export class ScreenTableRow {
  /** The absolute line, from 1 (the scroll state's first row + the row's position). */
  readonly line: number
  /** The atoms' block: the loop line (R-SS-14). */
  readonly block: number
  /** The cell element of each column, by column index; undefined where the row has no atom. */
  readonly cells: readonly (ScreenElementID | undefined)[]
  /** The row is marked: its selector checkbox is checked (R-EL-10). */
  readonly isSelected: boolean
  /** The row-selector element, when the server sends one (R-EL-10). */
  readonly selector: ScreenElementID | undefined

  constructor(fields: {
    line: number
    block: number
    cells: readonly (ScreenElementID | undefined)[]
    isSelected: boolean
    selector: ScreenElementID | undefined
  }) {
    this.line = fields.line
    this.block = fields.block
    this.cells = fields.cells
    this.isSelected = fields.isSelected
    this.selector = fields.selector
  }

  /** The line (Swift `Identifiable`). */
  get id(): number {
    return this.line
  }
}

/** A table's scroll state (elements.md Reading R-EL-8). */
export class ScreenTableScroll {
  /** The absolute line of the first row the screen carries, from 1. */
  readonly firstRow: number
  /** All rows of the table; undefined when the server does not say (`TableScrollStateReading` `none`). */
  readonly totalRows: number | undefined
  /** The rows the table shows. */
  readonly visibleRows: number
  /** The cells of all columns (SCROLL_INFOS total_width); undefined when not known. */
  readonly totalWidth: number | undefined
  /** The cells the container shows. */
  readonly viewportWidth: number

  constructor(fields: {
    firstRow: number
    totalRows: number | undefined
    visibleRows: number
    totalWidth: number | undefined
    viewportWidth: number
  }) {
    this.firstRow = fields.firstRow
    this.totalRows = fields.totalRows
    this.visibleRows = fields.visibleRows
    this.totalWidth = fields.totalWidth
    this.viewportWidth = fields.viewportWidth
  }

  /** The model of the codec's scroll state (Swift `init(_ state:)`). */
  static fromState(state: TableScrollState): ScreenTableScroll {
    return new ScreenTableScroll({
      firstRow: state.firstRow,
      totalRows: state.totalRows,
      visibleRows: state.visibleRows,
      totalWidth: state.totalWidth,
      viewportWidth: state.viewportWidth
    })
  }
}

/**
 * How rows of a table are selected (Swift `ScreenTableSelection.Mode`).
 * - `none`: no selector column.
 * - `multiple`: a selector column: any set of rows may be marked.
 */
export type ScreenTableSelectionMode = "none" | "multiple"

/** How rows of a table are selected (elements.md Reading R-EL-10). */
export class ScreenTableSelection {
  /** `multiple` exactly when the rows have a selector checkbox. */
  constructor(readonly mode: ScreenTableSelectionMode) {}
}

/** Where an element sits in a table (on `ScreenElement.table`). */
export class ScreenTableCell {
  /** The table's id (its container id). */
  readonly table: number
  /** The row's absolute line, from 1. */
  readonly line: number
  /** The column index. */
  readonly column: number

  constructor(fields: { table: number; line: number; column: number }) {
    this.table = fields.table
    this.line = fields.line
    this.column = fields.column
  }
}

/** A table control: the TABLE container, its columns, the rows this screen carries (one page) and its scroll state (elements.md Reading R-EL-7). */
export class ScreenTable {
  /** The CONTAINER TABLE id: the cells' area. */
  readonly id: number
  /** The container's rectangle on the whole screen: the header row and the visible rows. */
  readonly frame: GridRect
  /** The CONTAINER NAME's container name, when one came. */
  readonly name: string | undefined
  /** The columns, left to right; the row selector is not a column. */
  readonly columns: readonly ScreenTableColumn[]
  /** The rows this screen carries, in line order. */
  readonly rows: readonly ScreenTableRow[]
  readonly scroll: ScreenTableScroll
  readonly selection: ScreenTableSelection

  constructor(fields: {
    id: number
    frame: GridRect
    name: string | undefined
    columns: readonly ScreenTableColumn[]
    rows: readonly ScreenTableRow[]
    scroll: ScreenTableScroll
    selection: ScreenTableSelection
  }) {
    this.id = fields.id
    this.frame = fields.frame
    this.name = fields.name
    this.columns = fields.columns
    this.rows = fields.rows
    this.scroll = fields.scroll
    this.selection = fields.selection
  }

  /** The columns kept in view while the rest scrolls horizontally: the leading run of key columns (R-EL-8). */
  get keyColumns(): ScreenTableColumn[] {
    const index = this.columns.findIndex(column => !column.isKey)
    return this.columns.slice(0, index < 0 ? this.columns.length : index)
  }
}
