// SPDX-License-Identifier: MIT
// Where a step puts the cursor on a classic list: the part of Swooey's SwooeyApp ListData.swift
// (`ListLineCache.pick`) and SessionElements.swift (`currentListCursor`) that agent-gui keeps (MIT).

import { ScreenPick, type ScreenList, type ScreenListLine } from "../diag/screen/index.js"

export const ListData = {
  /**
   * Where choosing `line` puts the cursor (R-EL-12): the supplied column inside a hotspot, else its
   * first hotspot, non-box segment (R-EL-20), or first segment, in that order (Swift
   * `ListLineCache.pick(on:column:)`).
   */
  pick(line: ScreenListLine, column?: number): ScreenPick {
    if (
      column !== undefined &&
      column >= 0 &&
      line.segments.some(s => s.isHotspot && column >= s.column && column - s.column < Math.max(s.width, s.text.length))
    ) {
      return ScreenPick.list(line.row, column)
    }
    const segment = line.segments.find(s => s.isHotspot) ?? line.segments.find(s => !s.isBox) ?? line.segments[0]
    return ScreenPick.list(line.row, segment?.column ?? 0)
  },

  /**
   * The list cursor a step carries when nothing else has the cursor (issues #184, #186; Swift
   * `currentListCursor`): `line` (the list's first body line when undefined) at `column` (0), as
   * received. Undefined when the screen has no list or the list no line.
   */
  cursor(list: ScreenList | undefined, line?: ScreenListLine, column?: number): ScreenPick | undefined {
    const held = line ?? list?.lines[0]
    if (list === undefined || held === undefined) return undefined
    return ScreenPick.list(held.row, Math.max(column ?? 0, 0))
  }
} as const
