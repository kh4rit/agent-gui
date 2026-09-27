// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/GUIStatusTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplSID,
  GUIFunctionNumber,
  GUIStatus,
  GUIStatusPart,
  GUIVirtualKey,
  MenuEntries,
  MenuEntryFields,
  MenuEntryFlags,
  MenuEntryWalker
} from "../../../diag/codec/index.js"
import { ascii, cat } from "../../support/codecTestSupport.js"
import { rawMenuEntry } from "../../support/screenTestSupport.js"

/**
 * The GUI status meanings of server-screen.md §8.7 (Readings R-SS-10 to R-SS-13), the virtual-key
 * table (PV-0731) and the zero-padding walk of Reading R-SS-8a.
 */
describe("GUI status", () => {
  test("parts", () => {
    assert.deepEqual(ApplSID.MnuEntry.allCases.map(GUIStatus.part), ["menuBar", "menuItems", "applicationToolbar", "functionKeys"])
    assert.equal(GUIStatusPart.allCases.length, 4)
  })

  test("menuPosition", () => {
    assert.deepEqual(GUIStatus.menuPosition(new MenuEntryFields({ position1: 1 })), [1])
    assert.deepEqual(GUIStatus.menuPosition(new MenuEntryFields({ position1: 2, position2: 3, position3: 1 })), [2, 3, 1])
    assert.deepEqual(GUIStatus.menuPosition(new MenuEntryFields({ position1: 2, position2: 3, position3: 1, position4: 9 })), [2, 3, 1, 9])
    assert.deepEqual(GUIStatus.menuPosition(new MenuEntryFields({ position1: 1, position2: 0, position3: 2 })), [1])
    assert.deepEqual(GUIStatus.menuPosition(new MenuEntryFields({ position2: 4 })), [])
  })

  test("flags", () => {
    const title = new MenuEntryFields({ flags: MenuEntryFlags.sel | MenuEntryFlags.men | MenuEntryFlags.vkey })
    assert.ok(GUIStatus.isSelectable(title) && GUIStatus.opensMenu(title) && !GUIStatus.isSeparator(title))
    const separator = new MenuEntryFields({ flags: MenuEntryFlags.sep | MenuEntryFlags.men })
    assert.ok(GUIStatus.isSeparator(separator) && !GUIStatus.opensMenu(separator) && !GUIStatus.isSelectable(separator))
    const disabled = new MenuEntryFields({ flags: MenuEntryFlags.vkey })
    assert.ok(!GUIStatus.isSelectable(disabled) && !GUIStatus.opensMenu(disabled))
  })

  test("functionNumber", () => {
    assert.equal(GUIStatus.functionNumber(new MenuEntryFields({ virtualKey: 5 })), 5)
    assert.equal(GUIStatus.functionNumber(new MenuEntryFields({ virtualKey: 255 })), 255)
    assert.equal(GUIStatus.functionNumber(new MenuEntryFields({ virtualKey: GUIFunctionNumber.unbound })), undefined)
    assert.equal(GUIStatus.functionNumber(new MenuEntryFields({ virtualKey: 0 })), undefined)
    assert.ok(GUIFunctionNumber.unbound === 100 && GUIFunctionNumber.enter === 0)
  })

  test("keyCombinations", () => {
    const expected = new Map<number, string>([
      [0, "Enter"],
      [11, "Ctrl+S"],
      [22, "Shift+Ctrl+0"]
    ])
    for (let key = 1; key <= 12; key++) if (key !== 11) expected.set(key, `F${key}`)
    for (let key = 1; key <= 12; key++) {
      if (key !== 10) expected.set(12 + key, `Shift+F${key}`)
      expected.set(24 + key, `Ctrl+F${key}`)
      expected.set(36 + key, `Ctrl+Shift+F${key}`)
    }
    const extras = [
      "Ctrl+E",
      "Ctrl+F",
      "Ctrl+/",
      "Ctrl+\\",
      "Ctrl+N",
      "Ctrl+O",
      "Ctrl+X",
      "Ctrl+C",
      "Ctrl+V",
      "Ctrl+Z",
      "Ctrl+PageUp",
      "PageUp",
      "PageDown",
      "Ctrl+PageDown",
      "Ctrl+G",
      "Ctrl+R",
      "Ctrl+P"
    ]
    extras.forEach((name, offset) => expected.set(70 + offset, name))
    for (let value = 0; value <= 255; value++) assert.equal(GUIVirtualKey.keyCombination(value), expected.get(value), `${value}`)
    assert.equal(expected.size, 66)
  })

  test("namedKeys", () => {
    const named: [GUIVirtualKey, string][] = [
      [GUIVirtualKey.enter, "Enter"],
      [GUIVirtualKey.f1, "F1"],
      [GUIVirtualKey.f2, "F2"],
      [GUIVirtualKey.f3, "F3"],
      [GUIVirtualKey.f4, "F4"],
      [GUIVirtualKey.f8, "F8"],
      [GUIVirtualKey.ctrlS, "Ctrl+S"],
      [GUIVirtualKey.f12, "F12"],
      [GUIVirtualKey.shiftF3, "Shift+F3"],
      [GUIVirtualKey.ctrlF, "Ctrl+F"],
      [GUIVirtualKey.ctrlPageUp, "Ctrl+PageUp"],
      [GUIVirtualKey.pageUp, "PageUp"],
      [GUIVirtualKey.pageDown, "PageDown"],
      [GUIVirtualKey.ctrlPageDown, "Ctrl+PageDown"],
      [GUIVirtualKey.ctrlG, "Ctrl+G"],
      [GUIVirtualKey.ctrlP, "Ctrl+P"]
    ]
    for (const [key, name] of named) assert.equal(GUIVirtualKey.keyCombination(key), name)
    assert.equal(GUIVirtualKey.plainFunctionKey(GUIVirtualKey.f3), 3)
    assert.equal(GUIVirtualKey.plainFunctionKey(GUIVirtualKey.f12), 12)
    assert.equal(GUIVirtualKey.plainFunctionKey(GUIVirtualKey.ctrlS), undefined)
    assert.equal(GUIVirtualKey.plainFunctionKey(GUIVirtualKey.enter), undefined)
    assert.equal(GUIVirtualKey.plainFunctionKey(GUIVirtualKey.shiftF3), undefined)
    assert.ok(GUIVirtualKey.f3 < GUIVirtualKey.shiftF3)
    assert.equal(GUIVirtualKey.description(GUIVirtualKey.f3), "3 (F3)")
    assert.equal(GUIVirtualKey.description(60), "60")
  })

  // MARK: Zero padding (R-SS-8a)

  /** An entry whose length field declares `padding` more bytes than its strings take, followed by those bytes. */
  function padded(text: string, padding: number[], virtualKey = 5): Uint8Array {
    const strings = ascii(text).length + 3
    const length = 20 + strings + padding.length
    return cat(rawMenuEntry({ text: ascii(text), virtualKey, declaredLength: length }), padding)
  }

  test("zeroPadding", () => {
    const first = padded("Feed Ducks", [0, 0, 0])
    const second = rawMenuEntry({ text: ascii("Count Ducks"), virtualKey: 6 })
    const value = cat(first, second)
    const walk = MenuEntries.walk(value, true)
    assert.equal(walk.error, undefined)
    assert.equal(walk.entries.length, 2)
    assert.ok(walk.entries[0].length === first.length && walk.entries[0].endOffset === first.length)
    assert.deepEqual(walk.entries[0].text.of(value), ascii("Feed Ducks"))
    assert.ok(walk.entries[1].offset === first.length && walk.entries[1].fields.virtualKey === 6)
    const walker = new MenuEntryWalker(true)
    assert.ok(walker.allowsZeroPadding)
    assert.equal(walker.next(value)?.length, first.length)
  })

  test("paddingRefused", () => {
    const zeros = padded("Feed Ducks", [0, 0])
    const actual = zeros.length - 2
    assert.deepEqual(MenuEntries.walk(zeros).error?.info, { kind: "lengthMismatch", entryIndex: 1, entryOffset: 0, declared: zeros.length, actual })
    assert.ok(!new MenuEntryWalker().allowsZeroPadding)
    const junk = padded("Feed Ducks", [0, 7])
    assert.deepEqual(MenuEntries.walk(junk, true).error?.info, { kind: "lengthMismatch", entryIndex: 1, entryOffset: 0, declared: junk.length, actual })
    const short = zeros.slice(0, -1)
    assert.deepEqual(MenuEntries.walk(short, true).error?.info, { kind: "lengthMismatch", entryIndex: 1, entryOffset: 0, declared: zeros.length, actual })
    const tooShort = rawMenuEntry({ text: ascii("Waddle"), declaredLength: 20 })
    assert.deepEqual(MenuEntries.walk(tooShort, true).error?.info, {
      kind: "lengthMismatch",
      entryIndex: 1,
      entryOffset: 0,
      declared: 20,
      actual: tooShort.length
    })
  })
})
