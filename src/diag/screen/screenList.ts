// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenList.swift (MIT).

// The model of classic list output (docs/protocol/elements.md §7, Readings R-EL-11, R-EL-12,
// R-EL-20 and R-EL-21). Pinned API of the mock-apps work.
//
// Swift's `extension ListLineElement` (`element.arms`) is the function `listLineElementArms`.

import { ListLineElement } from "../codec/index.js"
import type { GridRect, ScreenIcon } from "./screenLayout.js"

/**
 * The item a list's window state came from (elements.md Readings R-EL-11 and R-EL-21).
 * - `dynnCHL`: APPL DYNN CHL (R-EL-11), as the fake server sends it.
 * - `plainCHL`: the plain CHL simple item, read at DYNN CHL's positions (R-EL-21).
 * - `scrollInfos`: VARINFO SCROLL_INFOS outside a table: no header lines, and no more rows than
 *   data_height (R-EL-21).
 */
export type ScreenListWindowSource = "dynnCHL" | "plainCHL" | "scrollInfos"

/**
 * The eight list colours, in the numbering of ABAP's FORMAT COLOR that SFE byte 1 carries (PV-0971):
 * the raw value is the colour number.
 */
export type ListColor = "background" | "heading" | "normal" | "total" | "key" | "positive" | "negative" | "group"

const LIST_COLORS: readonly ListColor[] = ["background", "heading", "normal", "total", "key", "positive", "negative", "group"]

export const ListColor = {
  /** The colours in raw-value order (Swift `CaseIterable`). */
  allCases: LIST_COLORS,

  /** The colour number (Swift `rawValue`). */
  rawValue(color: ListColor): number {
    return LIST_COLORS.indexOf(color)
  },

  /** The colour of a number, or undefined (Swift `init?(rawValue:)`). */
  fromRaw(value: number): ListColor | undefined {
    return Number.isInteger(value) && value >= 0 && value < LIST_COLORS.length ? LIST_COLORS[value] : undefined
  }
} as const

/**
 * The directions a line element's lines leave its cell's centre in; each reaches the cell's edge, so
 * that neighbouring cells join into one frame (elements.md Reading R-EL-20). Geometry only, no
 * protocol value. A value is the option bits (Swift `OptionSet`).
 */
export type ListLineArms = number

export const ListLineArms = {
  up: 1 << 0, // not-protocol: option bit
  down: 1 << 1, // not-protocol: option bit
  left: 1 << 2, // not-protocol: option bit
  right: 1 << 3 // not-protocol: option bit
} as const

/**
 * The element's arms: a corner two, a line two opposite ones, a T three, the cross four (SAP's
 * descriptions of the elements, PV-0978). (Swift: this file's `extension ListLineElement`,
 * `element.arms`.)
 */
export function listLineElementArms(element: ListLineElement): ListLineArms {
  const { up, down, left, right } = ListLineArms
  switch (element) {
    case "topLeftCorner":
      return right | down
    case "bottomLeftCorner":
      return right | up
    case "topRightCorner":
      return left | down
    case "bottomRightCorner":
      return left | up
    case "horizontalLine":
      return left | right
    case "verticalLine":
      return up | down
    case "leftMiddle":
      return up | down | right
    case "rightMiddle":
      return up | down | left
    case "bottomMiddle":
      return left | right | up
    case "topMiddle":
      return left | right | down
    case "cross":
      return up | down | left | right
  }
}

/** The fields of a `ScreenListSegment` (Swift `init(column:width:text:icon:color:…)`). */
export interface ScreenListSegmentFields {
  column: number
  width: number
  text: string
  icon?: ScreenIcon | undefined
  color: ListColor
  isIntensified?: boolean
  isInverse?: boolean
  isHotspot?: boolean
  isBox?: boolean
}

/** One text run of a list line (PV-0970), with its style (PV-0971; the flags are R-EL-11's invented ones). */
export class ScreenListSegment {
  /** The SBA column as received, from 0. */
  readonly column: number
  /** The SLC length in cells (PV-0423). */
  readonly width: number
  /**
   * The text, with a leading icon markup split off per R-DA-10. A box segment's text holds one
   * character per cell: the box-drawing character of each line element (R-EL-20), any other
   * character as it came.
   */
  readonly text: string
  readonly icon: ScreenIcon | undefined
  readonly color: ListColor
  readonly isIntensified: boolean
  readonly isInverse: boolean
  /** A single click acts as F2 (the list status's PICK). Never on a box segment. */
  readonly isHotspot: boolean
  /** A box run (SFE byte 2 = 0x08, PV-0972): its cells are line elements, drawn as lines (elements.md Reading R-EL-20). */
  readonly isBox: boolean

  constructor(fields: ScreenListSegmentFields) {
    const isBox = fields.isBox ?? false
    this.column = fields.column
    this.width = fields.width
    this.text = fields.text
    this.icon = fields.icon
    this.color = fields.color
    this.isIntensified = fields.isIntensified ?? false
    this.isInverse = fields.isInverse ?? false
    this.isHotspot = (fields.isHotspot ?? false) && !isBox
    this.isBox = isBox
  }

  /**
   * The arms of a box segment's character: the directions its line leaves the cell's centre in, or
   * undefined for a character that is no line element (drawn as text, R-EL-20). (Swift
   * `lineArms(of:)`.)
   */
  static lineArms(character: string): ListLineArms | undefined {
    const element = ListLineElement.fromGlyph(character)
    return element === undefined ? undefined : listLineElementArms(element)
  }
}

/** One list line: the segments of one SBA row. */
export class ScreenListLine {
  /** The absolute body line, from 1; 0 for a header line. */
  readonly index: number
  /** The SBA row as received, from 0 in the list window (PV-0970). */
  readonly row: number
  /** The segments, left to right. */
  readonly segments: readonly ScreenListSegment[]

  constructor(fields: { index: number; row: number; segments: readonly ScreenListSegment[] }) {
    this.index = fields.index
    this.row = fields.row
    this.segments = fields.segments
  }

  /** The index (Swift `Identifiable`). */
  get id(): number {
    return this.index
  }
}

/** A list window's scroll state (elements.md Reading R-EL-11). */
export class ScreenListScroll {
  /** The first body line shown, from 1: DYNN CHL listrowoffset + 1. */
  readonly firstLine: number
  /**
   * All body lines (maxlistrow); undefined when not known (`ListReading` `runsOnly`) or when the
   * window came from R-EL-21's plain CHL or SCROLL_INFOS, whose header split is not confirmed (#111).
   * Without a total the list view fetches no next page on its own.
   */
  readonly totalLines: number | undefined
  /** Body rows per page (dimlistrow). */
  readonly visibleLines: number
  /** The list's width in columns (maxlistcol); undefined when not known. */
  readonly width: number | undefined

  constructor(fields: { firstLine: number; totalLines: number | undefined; visibleLines: number; width: number | undefined }) {
    this.firstLine = fields.firstLine
    this.totalLines = fields.totalLines
    this.visibleLines = fields.visibleLines
    this.width = fields.width
  }
}

/**
 * A classic list: fixed header lines, the body lines this screen carries, and the window's scroll
 * state (elements.md Readings R-EL-11 and R-EL-21).
 */
export class ScreenList {
  /** The list window on the whole screen. */
  readonly frame: GridRect
  /** The header lines, fixed at the top and not scrolled (dimrow − dimlistrow of DYNN CHL). */
  readonly headerLines: readonly ScreenListLine[]
  /** The body lines this screen carries, in order. */
  readonly lines: readonly ScreenListLine[]
  readonly scroll: ScreenListScroll
  /** The item the window state came from; undefined when the message had none that fits (R-EL-21). */
  readonly windowSource: ScreenListWindowSource | undefined

  constructor(fields: {
    frame: GridRect
    headerLines: readonly ScreenListLine[]
    lines: readonly ScreenListLine[]
    scroll: ScreenListScroll
    windowSource?: ScreenListWindowSource | undefined
  }) {
    this.frame = fields.frame
    this.headerLines = fields.headerLines
    this.lines = fields.lines
    this.scroll = fields.scroll
    this.windowSource = fields.windowSource
  }
}
