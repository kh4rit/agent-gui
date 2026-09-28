// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0185Tests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ListWindowState } from "../../../diag/codec/index.js"
import { ElementItems } from "../../support/elementScreenBuilder.js"

describe("Bug #185: received blank list lines", () => {
  /** A sparse page holds interior and trailing blank rows, bounded by its total (bug #185) */
  test("blanks", () => {
    const items = new ElementItems()
    items.run(0, 0, "ZZ heading")
    items.run(1, 0, "ZZ first")
    items.run(3, 0, "ZZ third")
    items.window(ListWindowState.fromWindow({ totalLines: 8, firstLine: 5, visibleLines: 6, windowRows: 7, width: 40, visibleWidth: 40 }))
    const list = items.screen().list
    assert.ok(list !== undefined, "the screen has a list")
    assert.deepEqual(
      list.lines.map(line => line.index),
      [5, 6, 7, 8]
    )
    assert.deepEqual(
      list.lines.map(line => line.row),
      [1, 2, 3, 4]
    )
    assert.deepEqual(
      list.lines.filter(line => line.segments.length === 0).map(line => line.index),
      [6, 8]
    )
  })
})
