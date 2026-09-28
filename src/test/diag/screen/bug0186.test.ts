// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0186Tests.swift (MIT).

// source: fake — the existing invented list, independent cursor coordinates.
//
// Swift's `ListDecodingTests.listScreen(window:)` (ElementDecodingTests.swift) is rebuilt below.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, InputEnvelope, ListFocus, ListRunFlags, ListWindowState } from "../../../diag/codec/index.js"
import { FieldEdits, FunctionReadings, FunctionTrigger, ScreenPick } from "../../../diag/screen/index.js"
import { ElementItems } from "../../support/elementScreenBuilder.js"

/** Three header lines and three body lines of a 220-line list, the page from line 21. (Swift `ListDecodingTests.listScreen(window:)`.) */
function listScreen(window = true): ElementItems {
  const items = new ElementItems()
  items.text(ApplItem.stSystemInfo("dynproName"), "ZZ_BREADCRUMB_REPORT")
  items.run(0, 0, "Breadcrumb Report - Pond 314 - 2/11", { color: 1, flags: ListRunFlags.intensified })
  items.run(1, 0, "Ducks D0001 to D0012", { color: 1 })
  items.run(2, 0, "Duck         Date        Crumbs", { color: 1 })
  items.run(3, 0, "Puddles McGee", { color: 4, flags: ListRunFlags.hotspot })
  items.run(3, 13, "  2026-09-01  12", { color: 2 })
  items.run(4, 0, "@0A@Subtotal", { color: 3, flags: ListRunFlags.intensified })
  items.run(5, 0, "*** Record: 42 croissants ***", { color: 5, flags: ListRunFlags.inverse })
  if (window) {
    items.window(ListWindowState.fromWindow({ totalLines: 220, firstLine: 21, visibleLines: 20, windowRows: 23, width: 80, visibleWidth: 80 }))
  }
  return items
}

describe("Bug #186: plain list cursor input", () => {
  /** Lists without plain CHL retain the previous input format (bug #186) */
  test("cursor", () => {
    const screen = listScreen().screen()
    const readings = new FunctionReadings({ envelope: InputEnvelope.chlStage })
    const command = screen.inputStep(new FieldEdits(), FunctionTrigger.okCode("=ZZDISPLAY"), { readings, listCursor: ScreenPick.list(7, 13) })
    assert.equal(command.listFocus, undefined)
    const choice = screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.list(3, 9)), { readings })
    assert.equal(choice.listFocus, undefined)
    const noCursor = screen.inputStep(new FieldEdits(), FunctionTrigger.enter)
    assert.equal(noCursor.listFocus, undefined)
  })

  /** Received plain CHL and LIST_FOCUS are the default for list commands (bug #186) */
  test("plainWindow", () => {
    const items = listScreen(false)
    const window = ListWindowState.fromWindow({ totalLines: 20, firstLine: 1, visibleLines: 8, windowRows: 8, width: 80, visibleWidth: 80 })
    assert.ok(window !== undefined, "a window state")
    window.appendPlainItem(items.writer)
    const screen = items.screen()
    const step = screen.inputStep(new FieldEdits(), FunctionTrigger.okCode("=ZZDISPLAY"), {
      readings: new FunctionReadings({ envelope: InputEnvelope.chlStage }),
      listCursor: ScreenPick.list(3, 9)
    })
    assert.deepEqual(step.plainListWindow, window)
    assert.equal(step.focus, undefined)
    assert.deepEqual(step.listFocus, new ListFocus({ version: 1, row: 3, col: 9 }))
    const choice = screen.inputStep(new FieldEdits(), FunctionTrigger.choose(ScreenPick.list(3, 9)))
    assert.deepEqual(choice.plainListWindow, window)
    assert.deepEqual(choice.listFocus, step.listFocus)
  })
})
