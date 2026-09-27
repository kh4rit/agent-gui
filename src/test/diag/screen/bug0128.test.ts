// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0128Tests.swift (MIT).

// Issue #128: a real server's runtime-error list showed its section frames as digits (the owner's
// run of Swooey 0.0.67, elements.md §7.3). The list here has the shape the owner described, with
// invented texts (D15): a coloured header line, a full-width rule, then a framed section.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ListLineElement, ListRun, ListRunFlags, ListRunStyle } from "../../../diag/codec/index.js"
import { ScreenReadings, type ScreenListSegment } from "../../../diag/screen/index.js"
import { ElementItems } from "../../support/elementScreenBuilder.js"

/** SFE `08 00 08`: a box run (PV-0972, PV-0981). */
const box = new ListRunStyle({ color: 0, isRuled: true, isBox: true })

function framedList(): ElementItems {
  const items = new ElementItems()
  items.run(0, 0, "The pond has stopped: a duck raised SYSTEM_QUACK", { color: 6 })
  ListRun.append(1, 0, box, "4".repeat(20), items.writer)
  ListRun.append(3, 0, box, "0444444444444442", items.writer)
  ListRun.append(4, 0, box, "5", items.writer)
  items.run(4, 2, "Short quack", { color: 1 })
  ListRun.append(4, 15, box, "5", items.writer)
  ListRun.append(5, 0, box, "1444444444444443", items.writer)
  return items
}

describe("Bug #128: box runs of a classic list", () => {
  /** A box run shows line glyphs, not its code digits (bug #128) */
  test("boxRunsShowGlyphs", () => {
    const screen = framedList().screen()
    const list = screen.list
    assert.ok(list !== undefined, "the screen has a list")
    // Swift's `Dictionary(uniqueKeysWithValues:)`: one line per row.
    const rows = new Map<number, readonly ScreenListSegment[]>(list.lines.map(line => [line.row, line.segments]))
    assert.equal(rows.size, list.lines.length, "one line per row")
    assert.equal(rows.get(1)?.[0]?.text, "\u{2500}".repeat(20), "the rule under the header")
    assert.equal(rows.get(3)?.[0]?.text, "\u{250C}" + "\u{2500}".repeat(14) + "\u{2510}")
    assert.deepEqual(
      rows.get(4)?.map(segment => segment.text),
      ["\u{2502}", "Short quack", "\u{2502}"]
    )
    assert.equal(rows.get(5)?.[0]?.text, "\u{2514}" + "\u{2500}".repeat(14) + "\u{2518}")
    // The box segments say so, keep their cells and colour, and are never hotspots.
    assert.deepEqual(
      rows.get(4)?.map(segment => segment.isBox),
      [true, false, true]
    )
    const first = rows.get(3)?.[0]
    assert.equal(first === undefined ? undefined : first.isBox && first.width === 16 && first.color === "background" && !first.isHotspot, true)
    assert.equal(screen.diagnostics.listBoxCells, 20 + 16 + 1 + 1 + 16)
    assert.equal(screen.diagnostics.unknownListBoxCodes, 0)
  })

  /** SFE byte 0 = 0x08 alone is text; byte 2 = 0x08 on byte 0 = 0x0A is a box run (PV-0981) (bug #128) */
  test("byteTwoDecides", () => {
    const items = new ElementItems()
    ListRun.append(0, 0, new ListRunStyle({ color: 2, isRuled: true }), "001", items.writer)
    ListRun.append(1, 0, new ListRunStyle({ color: 1, isBox: true }), "949", items.writer)
    const list = items.screen().list
    assert.ok(list !== undefined, "the screen has a list")
    assert.deepEqual(
      list.lines[0].segments.map(segment => segment.text),
      ["001"]
    )
    assert.deepEqual(
      list.lines[0].segments.map(segment => segment.isBox),
      [false]
    )
    assert.deepEqual(
      list.lines[1].segments.map(segment => segment.text),
      ["\u{252C}\u{2500}\u{252C}"]
    )
    assert.equal(list.lines[1].segments[0].color, "heading")
  })

  /** Every code, a space and an unknown character; the hotspot flag on a box run; the fallback shows the codes (R-EL-20) (bug #128) */
  test("codesAndFallback", () => {
    const items = new ElementItems()
    const all = ListLineElement.allCases.map(element => ListLineElement.code(element)).join("")
    ListRun.append(0, 0, new ListRunStyle({ color: 2, flags: ListRunFlags.hotspot, isRuled: true, isBox: true }), all + " 4?4", items.writer)
    const screen = items.screen()
    const segment = screen.list?.lines[0]?.segments[0]
    assert.ok(segment !== undefined, "the list has a segment")
    assert.equal(segment.text, "\u{250C}\u{2514}\u{2510}\u{2518}\u{2500}\u{2502}\u{251C}\u{2524}\u{2534}\u{252C}\u{253C} \u{2500}?\u{2500}")
    assert.ok(segment.isBox)
    assert.ok(!segment.isHotspot)
    assert.equal(screen.diagnostics.listBoxCells, 15)
    assert.equal(screen.diagnostics.unknownListBoxCodes, 1)
    const codes = items.screen(new ScreenReadings({ listBoxes: "codes" })).list?.lines[0]?.segments[0]
    assert.ok(codes !== undefined, "the list has a segment")
    assert.equal(codes.text, all + " 4?4", "Swooey 0.0.67's decode")
    assert.ok(!codes.isBox, "Swooey 0.0.67's decode")
    assert.ok(codes.isHotspot, "Swooey 0.0.67's decode")
    assert.equal(new ScreenReadings().listBoxes, "lineElements")
    assert.equal(ScreenReadings.beforeElements.listBoxes, "codes")
  })
})
