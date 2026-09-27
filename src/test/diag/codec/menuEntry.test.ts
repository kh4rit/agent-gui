// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/MenuEntryTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  MenuEntries,
  MenuEntryCodes,
  MenuEntryFields,
  MenuEntryFlags,
  MenuEntryWalkError,
  MenuEntryWalker,
  ScreenValueEncodingError,
  type MenuEntryPart
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo, written } from "../../support/codecTestSupport.js"
import { rawMenuEntry } from "../../support/screenTestSupport.js"

/**
 * MNUENTRY values (server-screen.md §8.1): the entry layout, the walk of R-SS-8 and IMPL-SS-5, and
 * the encoder, against entries written by hand.
 */
describe("Menu entries", () => {
  const first = rawMenuEntry({
    text: ascii("Feed the Ducks"),
    accelerator: ascii("F"),
    info: ascii("Bread only"),
    positions: [1, 2, 3, 4],
    flags: 0x12,
    virtualKey: 5,
    returnCodes: [1, 2, 3, 4, 5, 6],
    functionCodes: [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6]
  })
  const second = rawMenuEntry({ text: ascii("Waddle Away"), positions: [2, 0, 0, 0], flags: 0xff, virtualKey: 15 })

  test("walkReadsEveryField", () => {
    const value = cat(first, second)
    const walk = MenuEntries.walk(value)
    assert.equal(walk.error, undefined)
    assert.equal(walk.entries.length, 2)
    const entry = walk.entries[0]
    assert.ok(entry.index === 1 && entry.offset === 0 && entry.length === first.length && entry.endOffset === first.length)
    const fields = entry.fields
    assert.ok(fields.position1 === 1 && fields.position2 === 2 && fields.position3 === 3 && fields.position4 === 4)
    assert.equal(fields.flags, MenuEntryFlags.sel | MenuEntryFlags.vkey)
    assert.deepEqual(MenuEntryFlags.names(fields.flags), ["SEL", "VKEY"])
    assert.equal(fields.virtualKey, 5)
    assert.deepEqual(fields.returnCodes.bytes, bytes(1, 2, 3, 4, 5, 6))
    assert.deepEqual(fields.functionCodes.bytes, bytes(0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6))
    assert.deepEqual(entry.text.of(value), ascii("Feed the Ducks"))
    assert.deepEqual(entry.accelerator.of(value), ascii("F"))
    assert.deepEqual(entry.info.of(value), ascii("Bread only"))
    const next = walk.entries[1]
    assert.ok(next.index === 2 && next.offset === first.length && next.endOffset === value.length)
    assert.deepEqual(MenuEntryFlags.names(next.fields.flags), ["UNK1", "SEL", "MEN", "SEP", "VKEY", "UNK6", "UNK7", "UNK8"])
    assert.ok(next.accelerator.isEmpty && next.info.isEmpty)
  })

  test("emptyValueHasNoEntries", () => {
    const walker = new MenuEntryWalker()
    assert.equal(walker.next(new Uint8Array(0)), undefined)
    assert.ok(walker.entryCount === 0 && walker.error === undefined && walker.offset === 0)
  })

  /** PV-0721: the eight masks in ascending order, each with its name. */
  test("flagMasks", () => {
    const masks = [
      MenuEntryFlags.unknown1,
      MenuEntryFlags.sel,
      MenuEntryFlags.men,
      MenuEntryFlags.sep,
      MenuEntryFlags.vkey,
      MenuEntryFlags.unknown6,
      MenuEntryFlags.unknown7,
      MenuEntryFlags.unknown8
    ]
    assert.deepEqual(masks, [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80])
    assert.deepEqual(
      MenuEntryFlags.named.map(entry => entry.flag),
      masks
    )
    assert.equal(MenuEntryFlags.names(0).length, 0)
  })

  test("codesAreSixBytes", () => {
    assert.ok(MenuEntryCodes.of([1, 2, 3, 4, 5]) === undefined && MenuEntryCodes.of([1, 2, 3, 4, 5, 6, 7]) === undefined)
    const codes = MenuEntryCodes.of([9, 8, 7, 6, 5, 4])
    assert.ok(codes)
    assert.ok(codes.get(0) === 9 && codes.get(5) === 4)
    codes.set(2, 0xff)
    assert.deepEqual(codes.bytes, bytes(9, 8, 0xff, 6, 5, 4))
    codes.set(2, 0)
    assert.deepEqual(codes.bytes, bytes(9, 8, 0, 6, 5, 4))
    assert.deepEqual(new MenuEntryCodes().bytes, bytes(0, 0, 0, 0, 0, 0))
    assert.equal(MenuEntryCodes.count, 6)
  })

  // MARK: Stops (IMPL-SS-5)

  test("stopsReportTheEntryAndThePart", () => {
    // Fewer than 20 bytes for the fixed part.
    for (let count = 1; count < 20; count++) {
      const walk = MenuEntries.walk(first.slice(0, count))
      assert.equal(walk.entries.length, 0)
      assert.deepEqual(walk.error?.info, { kind: "truncated", entryIndex: 1, entryOffset: 0, part: "fixedFields" })
    }
    // A string without its zero byte, one part at a time.
    const text = 20 + 14
    const accelerator = text + 1 + 1
    const info = accelerator + 1 + 10
    const parts: [number, MenuEntryPart][] = [
      [20, "text"],
      [text, "text"],
      [text + 1, "accelerator"],
      [accelerator, "accelerator"],
      [accelerator + 1, "info"],
      [info, "info"]
    ]
    for (const [count, part] of parts)
      assert.deepEqual(MenuEntries.walk(first.slice(0, count)).error?.info, { kind: "truncated", entryIndex: 1, entryOffset: 0, part }, `${count}`)
    // A good entry, then a second one cut short: the first still counts.
    const walk = MenuEntries.walk(cat(first, second.slice(0, 25)))
    assert.equal(walk.entries.length, 1)
    assert.deepEqual(walk.error?.info, { kind: "truncated", entryIndex: 2, entryOffset: first.length, part: "text" })
    assert.ok(walk.error?.entryIndex === 2 && walk.error?.entryOffset === first.length)
    assert.equal(walk.error?.specGapIssue, 39)
  })

  /** R-SS-8: a length field that differs from the parts stops the walk; neither reading of the next entry is taken (#50). */
  test("lengthMismatchStopsTheWalk", () => {
    for (const declared of [0, 19, 20, second.length - 1, second.length + 1, 0xffff]) {
      const value = cat(first, rawMenuEntry({ text: ascii("Waddle Away"), declaredLength: declared }))
      const walk = MenuEntries.walk(value)
      assert.equal(walk.entries.length, 1)
      assert.deepEqual(walk.error?.info, { kind: "lengthMismatch", entryIndex: 2, entryOffset: first.length, declared, actual: second.length })
      assert.equal(walk.error?.specGapIssue, 50)
    }
  })

  test("errorsAreSticky", () => {
    const walker = new MenuEntryWalker()
    const value = cat(first, [0x00])
    assert.notEqual(walker.next(value), undefined)
    const stop = { kind: "truncated", entryIndex: 2, entryOffset: first.length, part: "fixedFields" } as const
    throwsInfo(() => walker.next(value), MenuEntryWalkError, stop)
    throwsInfo(() => walker.next(first), MenuEntryWalkError, stop)
    assert.ok(walker.entryCount === 1 && walker.offset === first.length)
  })

  // MARK: Encoder

  test("encoderWritesTheLengthOfItsParts", () => {
    const entry = MenuEntries.walk(first).entries[0]
    assert.ok(entry)
    assert.deepEqual(
      written(output => MenuEntries.appendEntry(entry.fields, ascii("Feed the Ducks"), ascii("F"), ascii("Bread only"), output)),
      first
    )
    const empty = new Uint8Array(0)
    assert.deepEqual(
      written(output => MenuEntries.appendEntry(new MenuEntryFields(), empty, empty, empty, output)),
      cat([0, 23], repeated(0, 18), [0, 0, 0])
    )
  })

  test("encoderRefusesWhatItCannotWrite", () => {
    const output = new ByteWriter()
    output.u8(0xee)
    const empty = new Uint8Array(0)
    throwsInfo(() => MenuEntries.appendEntry(new MenuEntryFields(), ascii("a"), empty, bytes(0x41, 0), output), ScreenValueEncodingError, {
      kind: "zeroByteInString",
      index: 2
    })
    const longest = repeated(0x51, 65_535 - 23)
    throwsInfo(() => MenuEntries.appendEntry(new MenuEntryFields(), cat(longest, [0x51]), empty, empty, output), ScreenValueEncodingError, {
      kind: "tooLong",
      length: 65_536,
      limit: 65_535
    })
    assert.deepEqual(output.toBytes(), bytes(0xee), "nothing is appended on failure")
    MenuEntries.appendEntry(new MenuEntryFields(), longest, empty, empty, output)
    const walk = MenuEntries.walk(output.toBytes().subarray(1))
    assert.ok(walk.error === undefined && walk.entries[0]?.length === 65_535)
  })
})
