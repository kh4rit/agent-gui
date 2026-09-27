// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ElementRealScreenTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DyntCombobox, DyntToggle, FieldMarkers, TabstripButtons } from "../../../diag/codec/index.js"
import { ZZScreen, walkAtoms } from "../../support/dyntTestSupport.js"
import { loadVector, vectorFiles } from "../../vectors/paths.js"

/**
 * Screens without the invented markers of elements.md decode as before: none of the new decoders
 * finds a dropdown, a toggle, a tab, a required or date field or a typed message in the spec
 * vectors' atoms and items, which are built from the spec, not from Swooey's Readings.
 */
describe("Screen elements: real screens decode as before", () => {
  /** The atom values of every `dynt-atoms` vector that walks cleanly. */
  function atomValues(): { path: string; bytes: Uint8Array }[] {
    const values: { path: string; bytes: Uint8Array }[] = []
    for (const path of vectorFiles()) {
      const vector = loadVector(path)
      if (vector.kind !== "dynt-atoms" || (vector.value("expect.error") ?? "none") !== "none") continue
      values.push({ path, bytes: vector.bytes })
    }
    return values
  }

  /** What the new decoders find in one atom value: dropdowns, tabs with the active flag, fields with the invented flag1 bits. */
  function findings(value: Uint8Array): { dropdowns: number; activeTabs: number; markedFields: number; toggles: number } {
    const result = { dropdowns: 0, activeTabs: 0, markedFields: 0, toggles: 0 }
    for (const atom of walkAtoms(value).atoms) {
      if (DyntCombobox.fromAtom(atom, value) !== undefined) result.dropdowns += 1
      if (DyntToggle.fromAtom(atom, value) !== undefined) result.toggles += 1
      if (
        atom.payload.kind === "field" &&
        (FieldMarkers.of(atom.payload.value.flag1, atom.attributes) & (FieldMarkers.required | FieldMarkers.date)) !== 0
      )
        result.markedFields += 1
    }
    result.activeTabs = TabstripButtons.fromValue(value)?.tabs.filter(tab => tab.isActive).length ?? 0
    return result
  }

  test("vectorsDecodeAsBefore", () => {
    const values = atomValues()
    assert.ok(values.length >= 5)
    for (const { path, bytes } of values) {
      const found = findings(bytes)
      assert.equal(found.dropdowns, 0, path)
      assert.equal(found.toggles, 0, path)
      assert.equal(found.activeTabs, 0, path)
      assert.equal(found.markedFields, 0, path)
    }
  })

  test("zzScreen", () => {
    const found = findings(ZZScreen.atoms)
    assert.ok(found.dropdowns === 0 && found.toggles === 0 && found.activeTabs === 0 && found.markedFields === 0)
  })
})
