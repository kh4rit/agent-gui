// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/PopupItems.swift (MIT).

// Popups (docs/protocol/elements.md §8, Reading R-EL-13): a popup screen's level, position and size
// in the SES value (PV-0420), up to nine levels (PV-0975), and its AREASIZE.

import { AreaSize } from "./screenValues.js"
import { SESValue } from "./simpleItemValues.js"

/**
 * How popups are recognised (elements.md Reading R-EL-13, #112).
 * - `sesModalNumber`: the default: an SES whose modal_number is 1–9 makes the message a popup of
 *   that level.
 * - `never`: the fallback: every message is a main screen, as before elements.md.
 */
export type PopupReading = "sesModalNumber" | "never"
export const PopupReading = { allCases: ["sesModalNumber", "never"] as readonly PopupReading[] } as const

/**
 * A popup window as R-EL-13 reads it from SES: modal_number = the level, x_pos and y_pos = the start
 * column and row (from 1, cells of the level-0 window, as `STARTING AT`), dim_row and dim_col = the
 * size.
 */
export class PopupWindow {
  /** The deepest popup level (PV-0975). */
  static readonly maxLevel = 9 // provenance: PV-0975

  /** 1 = on the main screen, 2 = on a popup, …, at most `maxLevel`. */
  readonly level: number
  /** The start row and column, from 1. */
  readonly row: number
  readonly column: number
  /** The size in rows and columns. */
  readonly rows: number
  readonly columns: number

  constructor(fields: { level: number; row: number; column: number; rows: number; columns: number }) {
    this.level = fields.level
    this.row = fields.row
    this.column = fields.column
    this.rows = fields.rows
    this.columns = fields.columns
  }

  /**
   * The popup an SES value describes, or undefined for a main screen: modal_number 0 or above
   * `maxLevel`, or `never`. (Swift `init?(ses:reading:)`.)
   */
  static fromSES(ses: SESValue, reading: PopupReading = "sesModalNumber"): PopupWindow | undefined {
    if (reading !== "sesModalNumber" || !(ses.modalNumber >= 1 && ses.modalNumber <= PopupWindow.maxLevel)) return undefined
    return new PopupWindow({ level: ses.modalNumber, row: ses.yPos, column: ses.xPos, rows: ses.dimRow, columns: ses.dimCol })
  }

  /** `base` with the popup's fields set: modal_number, x_pos, y_pos, dim_row and dim_col. `base` itself is not changed. */
  applied(base: SESValue = new SESValue()): SESValue {
    return new SESValue({
      ...base,
      modalNumber: this.level,
      xPos: this.column,
      yPos: this.row,
      dimRow: this.rows,
      dimCol: this.columns
    })
  }

  /** The popup's AREASIZE under R-EL-13: its own size as window and area. */
  get areaSize(): AreaSize {
    return new AreaSize({ windowHeight: this.rows, windowWidth: this.columns, areaHeight: this.rows, areaWidth: this.columns })
  }
}
