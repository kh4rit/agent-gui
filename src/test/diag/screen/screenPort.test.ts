// SPDX-License-Identifier: MIT
// Tests of the TypeScript port of Swooey's ScreenModel core that Swift's value types made
// unnecessary: copies (Swift structs are copied on assignment), map keys (Swift `Hashable`), Swift's
// `String.count` and the printing of the edits. Invented texts (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import { ApplItem, PopupWindow, Secret, StatusMessageType } from "../../../diag/codec/index.js"
import {
  FieldEdits,
  GridPoint,
  Screen,
  ScreenElementID,
  ScreenTextDecoding,
  TextMarkup,
  WindowLevelCarry,
  WindowLevelCarryNote,
  characterCount
} from "../../../diag/screen/index.js"
import { ElementAtoms, ElementItems } from "../../support/elementScreenBuilder.js"

/** A small screen with a label, an input, a button and a message. */
function pondScreen(): Screen {
  const items = new ElementItems()
  items.text(ApplItem.stSystemInfo("dynproName"), "ZZ_POND")
  items.text(ApplItem.varInfo("sessionTitle"), "The Pond")
  items.message(StatusMessageType.of("success"), "Quack")
  const atoms = new ElementAtoms()
  atoms.label({ row: 1, col: 2, mlen: 10 }, "Duck")
  atoms.input({ row: 1, col: 14, mlen: 8 }, "DONALD")
  atoms.button({ row: 3, col: 2, code: "=ZZQUACK" }, "Quack")
  items.atoms(atoms)
  return items.screen()
}

describe("ScreenModel in TypeScript: values, keys and texts", () => {
  test("screenCloneIsIndependent", () => {
    const screen = pondScreen()
    const copy = screen.clone()
    assert.deepEqual(copy, screen)
    copy.identity.title = "Another Pond"
    copy.elements.pop()
    copy.functions.pop()
    copy.diagnostics.unknownItems += 1
    assert.equal(screen.identity.title, "The Pond")
    assert.equal(screen.elements.length, 3)
    assert.equal(screen.functions.length, copy.functions.length + 1)
    assert.equal(screen.diagnostics.unknownItems, 0)
    // adoptStatus changes the screen it is called on only.
    const adopted = screen.clone()
    adopted.adoptStatus([])
    assert.deepEqual(screen, pondScreen())
  })

  test("carryCloneIsIndependent", () => {
    const carry = new WindowLevelCarry()
    carry.carry(pondScreen(), 1)
    const copy = carry.clone()
    assert.deepEqual(copy, carry)
    // A popup of level 1 opens a level in the copy only.
    const items = new ElementItems()
    items.ses(new PopupWindow({ level: 1, row: 3, column: 5, rows: 4, columns: 30 }).applied())
    items.text(ApplItem.varInfo("sessionTitle"), "Really, duck?")
    const popup = items.screen()
    assert.equal(WindowLevelCarry.level(popup), 1)
    copy.carry(popup, 2)
    assert.notDeepEqual(copy, carry)
    assert.deepEqual(carry.carry(popup.clone(), 3), new WindowLevelCarryNote())
  })

  test("fieldEditsCloneAndPrinting", () => {
    const screen = pondScreen()
    const input = screen.inputs[0]
    const edits = new FieldEdits()
    edits.setText("DAISY", input.id)
    const copy = edits.clone()
    copy.setText("SCROOGE", input.id)
    copy.setSecret(new Secret(new TextEncoder().encode("quack-quack")), new ScreenElementID({ block: 1, row: 9, column: 9, elementType: 130 }))
    assert.equal(edits.text(input.id), "DAISY")
    assert.equal(edits.count, 1)
    assert.equal(copy.count, 2)
    for (const printed of [String(copy), JSON.stringify(copy), inspect(copy, { showHidden: true, depth: 8 }), inspect({ copy }, { depth: 8 })]) {
      assert.ok(!printed.includes("SCROOGE") && !printed.includes("quack"), printed)
    }
    assert.equal(String(copy), "FieldEdits(2 fields)")
    // Two edits with the same values compare equal: their values are private.
    assert.deepEqual(new FieldEdits(), new FieldEdits())
  })

  test("elementIDKeysAndOrder", () => {
    const first = new ScreenElementID({ block: 1, row: 2, column: 3, elementType: 130 })
    const same = new ScreenElementID({ area: 0, block: 1, row: 2, column: 3, elementType: 130, occurrence: 0 })
    const later = new ScreenElementID({ block: 1, row: 2, column: 3, elementType: 130, occurrence: 1 })
    const otherArea = new ScreenElementID({ area: 1, block: 0, row: 0, column: 0, elementType: 101 })
    assert.equal(first.mapKey, same.mapKey)
    assert.notEqual(first.mapKey, later.mapKey)
    assert.ok(ScreenElementID.equals(first, same))
    assert.deepEqual(
      [otherArea, later, first].sort(ScreenElementID.compare),
      [first, later, otherArea]
    )
    const edits = new FieldEdits()
    edits.setText("A", first)
    edits.setText("B", same)
    assert.equal(edits.count, 1, "an id keys the edits by value, as Swift's Hashable does")
    assert.equal(edits.text(first), "B")
  })

  test("swiftStringCount", () => {
    assert.equal(characterCount("Quack"), 5)
    assert.equal(characterCount("Enté"), 4, "a combining mark joins its letter")
    assert.equal(characterCount("\r\n"), 1, "CR LF is one character")
    assert.equal(characterCount("🦆🦆"), 2)
    assert.equal(ScreenTextDecoding.trimmingPadding("Duck \0 \0"), "Duck")
    assert.equal(ScreenTextDecoding.trimmingTrailingSpaces("Duck \0 "), "Duck \0")
    assert.equal(TextMarkup.parse("@0V\\QQuack loudly@🦆 Honk").caption, "🦆 Honk")
    assert.equal(TextMarkup.parse("@0V\\QQuack loudly@🦆 Honk").tooltip, "Quack loudly")
    assert.ok(GridPoint.compare(new GridPoint(1, 9), new GridPoint(2, 0)) < 0)
  })
})
