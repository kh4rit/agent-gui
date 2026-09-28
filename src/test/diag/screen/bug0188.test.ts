// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0188Tests.swift (MIT).

// source: fake — invented nested pond panels, with no live text or dimensions.
//
// Swift's `ScreenPlacementTests.Items` and `.Atoms` are `ElementItems` (the same encoders) and the
// `label` below, the one member of `.Atoms` this file uses.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DyntAtomEncoder, DyntAtomHeader, DyntAttributes, DyntElementType } from "../../../diag/codec/index.js"
import { GridPoint, Screen, ScreenReadings } from "../../../diag/screen/index.js"
import { ElementAtoms, ElementItems } from "../../support/elementScreenBuilder.js"

/** A keyword label (Swift `ScreenPlacementTests.Atoms.label(row:col:mlen:_:)`). */
function label(atoms: ElementAtoms, row: number, col: number, text: string): void {
  const bytes = new TextEncoder().encode(text)
  DyntAtomEncoder.appendField(
    new DyntAtomHeader({ etype: DyntElementType.of("keyword2"), area: 0, block: 1, row, col, attributes: DyntAttributes.protected | DyntAttributes.propFont }),
    { mlen: 18, maxNrChars: bytes.length, text: bytes },
    atoms.writer
  )
}

describe("Issue #188: containers within subscreens retain their offsets", () => {
  /** nested controls and tabstrips count from the nearest enclosing subscreen (bug #188) */
  test("nestedOrigins", () => {
    const items = new ElementItems()
    items.reset()
    items.container("subscreen", { id: 1, row: 4, col: 3, width: 90, height: 30 })
    items.container("subscreen", { id: 2, row: 2, col: 1, width: 80, height: 20 })
    items.container("tabstrip", { id: 1, row: 1, col: 2, width: 70, height: 16 })
    items.container("tabstripPage", { id: 2, row: 2, col: 1, width: 68, height: 13 })
    items.container("subscreen", { id: 1, row: 1, col: 0, width: 68, height: 12 })
    items.container("control", { id: 1, row: 0, col: 1, width: 66, height: 10 })
    const atoms = new ElementAtoms()
    label(atoms, 1, 2, "Pond depth")
    items.atoms(atoms)
    items.reset()
    items.container("subscreen", { id: 1, row: 40, col: 0, width: 90, height: 15 })
    items.container("control", { id: 1, row: 2, col: 1, width: 85, height: 12 })
    const screen = Screen.fromItems(items.bytes, { readings: new ScreenReadings({ nestedSubscreens: true }) })
    assert.deepEqual(
      screen.containers.map(container => container.origin),
      [
        new GridPoint(4, 3),
        new GridPoint(6, 4),
        new GridPoint(7, 6),
        new GridPoint(9, 7),
        new GridPoint(10, 7),
        new GridPoint(10, 8),
        new GridPoint(40, 0),
        new GridPoint(42, 1)
      ]
    )
    assert.deepEqual(screen.labels[0]?.placement, new GridPoint(11, 9))
    assert.equal(screen.labels[0]?.atom.row, 1)
    assert.equal(screen.labels[0]?.atom.col, 2)
    assert.equal(screen.labels[0]?.atom.area, 0)
    assert.deepEqual(screen.tabstrips[0]?.frame.origin, new GridPoint(7, 6))
  })

  /** the nested reading stays opt-in; controls do not become enclosing subscreens (bug #188) */
  test("optInAndSiblingControls", () => {
    const items = new ElementItems()
    items.reset()
    items.container("subscreen", { id: 1, row: 5, col: 3, width: 80, height: 20 })
    items.container("control", { id: 1, row: 1, col: 1, width: 70, height: 2 })
    items.container("control", { id: 2, row: 4, col: 1, width: 70, height: 8 })
    const legacy = Screen.fromItems(items.bytes)
    assert.deepEqual(legacy.containers[1].origin, new GridPoint(1, 1))
    const nested = Screen.fromItems(items.bytes, { readings: new ScreenReadings({ nestedSubscreens: true }) })
    assert.deepEqual(nested.containers[1].origin, new GridPoint(6, 4))
    assert.deepEqual(nested.containers[2].origin, new GridPoint(9, 4))
  })
})
