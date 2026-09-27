// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/OtherContainerItemTests.swift (MIT).
//
// The Duck Pond gate comes from the real fake server over TCP (src/test/support/screenSession.ts):
// the tests skip without it.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, DiagItemEncoder } from "../../../diag/codec/index.js"
import { Screen, ScreenContainerItem } from "../../../diag/screen/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/**
 * CONTAINER items the decoder does not read (SPLITTER, XMLPROP, …) are kept in structure, so
 * that the session report shows them: issue #155 asked what a SUBSCREEN item carries on a screen
 * whose tabstrip page was drawn from the screen's origin, and the report of #162 answered it
 * (Reading R-SS-16).
 */
describe("Container items the decoder does not read are kept in structure", () => {
  /** a SPLITTER item after the gate's containers: its kind, length and bytes; a long XMLPROP value keeps its length only */
  test("splitterItem", { skip: skipWithoutFakeServer }, async () => {
    // Swift's `var items` is a copy of the fixture: the writer copies the cached bytes.
    const items = new ByteWriter()
    items.bytes(await Fixtures.items("pond-gate"))
    const geometry = Uint8Array.of(0x03, 0x00, 0x05, 0x00, 0x01, 0x00, 0x5a, 0x00, 0x0c)
    DiagItemEncoder.appendAPPL(ApplItem.container("splitter"), geometry, items)
    const long = new Uint8Array(120).fill(0x41)
    DiagItemEncoder.appendAPPL(ApplItem.container("xmlprop"), long, items)
    const screen = Screen.fromItems(items.toBytes())
    assert.ok(screen.diagnostics.isClean)
    assert.equal(screen.containers.length, 2, "the geometry containers are unchanged")
    assert.deepEqual(screen.otherContainerItems, [
      new ScreenContainerItem({ kind: "splitter", byteCount: 9, bytes: geometry }),
      new ScreenContainerItem({ kind: "xmlprop", byteCount: 120, bytes: [] })
    ])
    assert.equal(screen.otherContainerItems[0].description, "splitter 9 byte(s) hex 03 00 05 00 01 00 5a 00 0c")
    assert.equal(screen.otherContainerItems[1].description, "xmlprop 120 byte(s)")
  })

  /** a screen without such items has none */
  test("none", { skip: skipWithoutFakeServer }, async () => {
    assert.equal((await Fixtures.gate()).otherContainerItems.length, 0)
  })
})
