// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/GridRows.swift (MIT).
//
// Swift's `extension String` of this file (`trimmingSpaces`, `trimmingTrailingSpaces`, internal to
// the module) is the two free functions at the end, kept to this file: DiagCodec already exports a
// `trimmingSpaces` of its own.

import { swiftCompare, type GridColumn, type GridModel } from "./controlModels.js"

/**
 * The client's own work on a grid's delivered rows (core-uses.md §3: sorting, filtering and find
 * work locally and instantly on the rows already delivered; the server's ALV functions stay for
 * larger data sets). Pure functions of the grid.
 */
export const GridRows = {
  /**
   * `rows` sorted by the column at `position`: numbers by value (a trailing minus is a sign,
   * separators as the column writes them), other texts by their characters without regard to
   * case; equal cells keep the rows' order.
   */
  sorted(grid: GridModel, rows: readonly number[], position: number, numeric: boolean, ascending: boolean): number[] {
    const keyed = rows.map((row, offset) => ({ offset, row, text: grid.text(row, position) }))
    keyed.sort((left, right) => {
      const order = GridRows.compare(left.text, right.text, numeric)
      if (order === 0) return left.offset - right.offset
      return ascending ? order : -order
    })
    return keyed.map(entry => entry.row)
  },

  /** -1, 0 or 1. */
  compare(a: string, b: string, numeric: boolean): number {
    if (numeric) {
      const x = GridRows.number(a)
      const y = GridRows.number(b)
      if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0
    }
    return swiftCompare(trimmingSpaces(a).toLowerCase(), trimmingSpaces(b).toLowerCase())
  },

  /**
   * A cell's number: digits with `.` or `,` separators, an optional sign before or (as the
   * system writes it) after. When both separators occur, the last is the decimal mark; one
   * separator occurring once with other than three digits after it is the decimal mark.
   */
  number(text: string): number | undefined {
    let body = trimmingSpaces(text)
    if (body.length === 0) return undefined
    let negative = false
    if (body.endsWith("-")) {
      negative = true
      body = body.slice(0, -1)
    } else if (body.startsWith("-")) {
      negative = true
      body = body.slice(1)
    } else if (body.startsWith("+")) {
      body = body.slice(1)
    }
    if (body.length === 0 || !/^[0-9.,]+$/.test(body)) return undefined
    const dots = body.split(".").length - 1
    const commas = body.split(",").length - 1
    let decimal: string | undefined
    if (dots > 0 && commas > 0) {
      decimal = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ","
    } else if (dots + commas === 1) {
      const separator = dots === 1 ? "." : ","
      const parts = body.split(separator)
      if (parts[parts.length - 1].length !== 3) decimal = separator
    }
    let normalized = ""
    for (const character of body) {
      if (character === decimal) normalized += "."
      else if (character >= "0" && character <= "9") normalized += character
    }
    // Swift `Double(text)`: nothing and a lone point are no number.
    if (normalized.length === 0 || normalized === ".") return undefined
    const value = Number(normalized)
    if (Number.isNaN(value)) return undefined
    return negative ? -value : value
  },

  /**
   * The rows with a cell that contains `text`, without regard to case (find, core-uses.md §3).
   * An empty text keeps every row.
   */
  filtered(grid: GridModel, rows: readonly number[], text: string): number[] {
    const wanted = trimmingSpaces(text).toLowerCase()
    if (wanted.length === 0) return rows.slice()
    return rows.filter(row => Array.from(grid.cells.get(row)?.values() ?? []).some(cell => cell.toLowerCase().includes(wanted)))
  },

  /** The cells of `rows` in the columns' order, for copying as tab-separated text. */
  cells(grid: GridModel, rows: readonly number[], columns: readonly GridColumn[]): string[][] {
    return rows.map(row => columns.map(column => trimmingTrailingSpaces(grid.text(row, column.position))))
  }
} as const

/** `text` without the spaces at both ends. (Swift: this file's `extension String`, `text.trimmingSpaces`.) */
function trimmingSpaces(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && text[start] === " ") start += 1
  while (end > start && text[end - 1] === " ") end -= 1
  return text.slice(start, end)
}

/** `text` without its trailing spaces. (Swift: this file's `extension String`, `text.trimmingTrailingSpaces`.) */
function trimmingTrailingSpaces(text: string): string {
  let end = text.length
  while (end > 0 && text[end - 1] === " ") end -= 1
  return text.slice(0, end)
}
