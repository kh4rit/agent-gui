// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0152Tests.swift (MIT).

// source: fake — invented list runs isolate the box branch that skips R-DA-10.
// The original popup's exact run boundaries still require live verification.
//
// Swift's `Bug0128Tests.box` is rebuilt below.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ListRun, ListRunFlags, ListRunStyle } from "../../../diag/codec/index.js"
import { ElementItems } from "../../support/elementScreenBuilder.js"

/** SFE `08 00 08`: a box run (PV-0972, PV-0981). (Swift `Bug0128Tests.box`.) */
const box = new ListRunStyle({ color: 0, isRuled: true, isBox: true })

describe("Bug #152: leading icon markup in box-styled list text", () => {
  /** Markup is decoded before box codes, preserving caption digits and the next run (bug #152) */
  for (const prefix of ["@0S\\QZZ_TOOLTIP@", "@0S@", "@\\QZZ_TOOLTIP@"]) {
    test(`markedHeader(${prefix})`, () => {
      const items = new ElementItems()
      const text = new TextEncoder().encode(prefix + " 42 ducks")
      const style = new ListRunStyle({ color: 1, flags: ListRunFlags.intensified | ListRunFlags.hotspot, isRuled: true, isBox: true })
      ListRun.append(0, 0, style, text, 10, items.writer)
      items.run(0, 12, "ZZ_NEXT")
      ListRun.append(1, 0, box, "0442", items.writer)
      const screen = items.screen()
      const segments = screen.list?.lines[0]?.segments
      assert.ok(segments !== undefined, "the first line has segments")
      assert.equal(segments.length, 2)
      const header = segments[0]
      assert.equal(header.text, " 42 ducks")
      assert.equal(header.icon?.code, prefix.startsWith("@0S") ? "0S" : undefined)
      assert.ok(!header.isBox && !header.isHotspot)
      assert.ok(header.column === 0 && header.width === 10 && header.color === "heading" && header.isIntensified)
      assert.ok(segments[1].column === 12 && segments[1].text === "ZZ_NEXT")
      assert.equal(screen.list?.lines.at(-1)?.segments[0]?.text, "┌──┐")
      assert.ok(screen.diagnostics.listBoxCells === 4 && screen.diagnostics.unknownListBoxCodes === 0)
    })
  }

  /** Malformed markup retains the existing box fallback (bug #152) */
  test("malformed", () => {
    const items = new ElementItems()
    ListRun.append(0, 0, box, "@ZZ\\Qunfinished", items.writer)
    const segment = items.screen().list?.lines[0]?.segments[0]
    assert.ok(segment !== undefined, "the first line has a segment")
    assert.ok(segment.isBox && segment.icon === undefined && segment.text === "@ZZ\\Qunfinished")
  })
})
