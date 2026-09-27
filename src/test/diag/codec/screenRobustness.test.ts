// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ScreenRobustnessTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ContainerName,
  DyntFocus,
  InternalModeUUIDs,
  ItemPayloadError,
  LogonFieldStructure,
  MenuEntries,
  ScreenIdentity,
  ScreenIdentityError,
  ScreenIdentityText,
  ScreenValue,
  ScreenValueLayout,
  UIEventSource,
  byteRange,
  type InternalModeEntry,
  type ItemPayloadErrorInfo
} from "../../../diag/codec/index.js"
import { ByteWriter, bytesEqual } from "../../../diag/wire/index.js"
import { menuEntryWalkErrorClass, screenValueFields } from "../../vectors/screenValueRunners.js"
import { appl, appl4, attempt, cat, walkItems } from "../../support/codecTestSupport.js"
import { field1Content, field2Content, rawAtom, u16BE, walkAtoms } from "../../support/dyntTestSupport.js"
import { rawMenuEntry } from "../../support/screenTestSupport.js"
import { SeededGenerator } from "../../support/seededGenerator.js"

/**
 * Deterministic robustness runs for the server-screen and client-input codecs (docs/testing.md
 * §3): random, plausible and mutated values through every decoder, each checked against an
 * independent model written from the spec text (server-screen.md, client-input.md), never against
 * the decoder's own encoder. Nothing may throw anything but the codecs' own errors; every run must
 * reach both the accepting and the rejecting side of each decoder. Fixed seeds make every failure
 * reproducible.
 */
const inputCount = 20_000

/** Values seen and decoded per decoder. */
class Tally {
  private readonly seen = new Map<string, number>()
  private readonly decoded = new Map<string, number>()

  record(name: string, success: boolean): void {
    this.seen.set(name, (this.seen.get(name) ?? 0) + 1)
    if (success) this.decoded.set(name, (this.decoded.get(name) ?? 0) + 1)
  }

  /** Every decoder saw values it accepted and values it refused. */
  expectBothSides(names: readonly string[], floor: number): void {
    for (const name of names) {
      const decoded = this.decoded.get(name) ?? 0
      const refused = (this.seen.get(name) ?? 0) - decoded
      assert.ok(decoded >= floor && refused >= floor, `${name}: ${decoded} decoded, ${refused} refused`)
    }
  }
}

/** A random length near `size`: exact, a few bytes off either way, or anything up to twice it. */
function lengthNear(size: number, generator: SeededGenerator): number {
  switch (generator.intBelow(0, 4)) {
    case 0:
    case 1:
      return size
    case 2:
      return Math.max(0, size + generator.int(-3, 3))
    default:
      return generator.int(0, 2 * size + 2)
  }
}

// The helpers of CodecRobustnessTests that Swift shares with this suite (Swift
// `CodecRobustnessTests.nonzeroBytes`, `.bigEndian`, `.zeroTerminatedStrings`).

/** 0 to `upper` random bytes, none of them zero: the body of a zero-terminated string. */
function nonzeroBytes(lower: number, upper: number, generator: SeededGenerator): number[] {
  const count = generator.int(lower, upper)
  const output: number[] = []
  for (let index = 0; index < count; index++) output.push(generator.uint8(1, 0xff))
  return output
}

/** An unsigned big-endian number. */
function bigEndian(input: ArrayLike<number>): number {
  let value = 0
  for (let index = 0; index < input.length; index++) value = value * 256 + input[index]
  return value
}

/**
 * `count` zero-terminated strings from `start`: each string's range without its zero byte, and the
 * number of bytes after the last zero; undefined when a zero is missing.
 */
function zeroTerminatedStrings(raw: Uint8Array, start: number, count: number): { ranges: [number, number][]; trailing: number } | undefined {
  const ranges: [number, number][] = []
  let index = start
  for (let string = 0; string < count; string++) {
    if (index > raw.length) return undefined
    const zero = raw.indexOf(0, index)
    if (zero < 0) return undefined
    ranges.push([index, zero])
    index = zero + 1
  }
  return { ranges, trailing: raw.length - index }
}

/** Swift's `MutableCollection.shuffle(using:)`: a Fisher–Yates shuffle from the front. */
function shuffle<T>(array: T[], generator: SeededGenerator): void {
  let amount = array.length
  let current = 0
  while (amount > 1) {
    const random = generator.intBelow(0, amount)
    amount -= 1
    const other = current + random
    ;[array[current], array[other]] = [array[other], array[current]]
    current += 1
  }
}

/** Swift `try?` on an item value decoder. */
function tryDecode<T>(decode: () => T): T | undefined {
  return attempt(decode, ItemPayloadError)
}

// MARK: Fixed-size layouts (server-screen.md §8)

/** Field widths of each layout, in value order, from the spec's tables (§8.3–§8.6). */
const widths: Record<ScreenValueLayout, number[]> = {
  areaSize: [4, 4, 4, 4],
  fontMetric: [2, 2, 2, 2],
  containerGeometry: [1, 2, 2, 2, 2],
  scrollInfos: [4, 4, 4, 4, 4, 4],
  scrollInfos2: [4, 4, 4, 4, 4, 4, 4, 4, 1],
  containerLoop: [2],
  listFocus: [1, 2, 2]
}

// MARK: Menu entries (§8.1)

/**
 * The walk of the menu-entries kind (test/vectors/README.md), written out separately: the entries'
 * offsets, and the stop as a class and a 1-based entry index.
 */
function modelMenuWalk(raw: Uint8Array): { offsets: number[]; stop: [string, number] | undefined } {
  const offsets: number[] = []
  let p = 0
  while (p < raw.length) {
    const index = offsets.length + 1
    if (!(raw.length - p >= 20)) return { offsets, stop: ["truncated", index] }
    let end = p + 20
    for (let string = 0; string < 3; string++) {
      const zero = raw.indexOf(0, end)
      if (zero < 0) return { offsets, stop: ["truncated", index] }
      end = zero + 1
    }
    if (bigEndian(raw.subarray(p, p + 2)) !== end - p) return { offsets, stop: ["entry-length-mismatch", index] }
    offsets.push(p)
    p = end
  }
  return { offsets, stop: undefined }
}

function plausibleMenu(generator: SeededGenerator): Uint8Array {
  const entries: Uint8Array[] = []
  for (let count = generator.int(0, 3); count > 0; count--) {
    const text = nonzeroBytes(0, 12, generator)
    const accelerator = nonzeroBytes(0, 2, generator)
    const info = nonzeroBytes(0, 6, generator)
    const positions = Array.from(generator.bytes(4))
    const flags = generator.uint8()
    const virtualKey = generator.uint8()
    const returnCodes = Array.from(generator.bytes(6))
    const functionCodes = Array.from(generator.bytes(6))
    entries.push(rawMenuEntry({ text, accelerator, info, positions, flags, virtualKey, returnCodes, functionCodes }))
  }
  return cat(...entries)
}

// MARK: Screen identity (§7)

/** What a generated screen carries, recorded while it is built: the model the identity is checked against. */
interface ScreenModel {
  texts: Map<ScreenIdentityText, Uint8Array>
  /** undefined: no AREASIZE; an empty array: an AREASIZE that is present but not 16 bytes. */
  area: Uint8Array | undefined
  atoms: number
  inputs: number
  passwords: number
  menus: number
  menuEntries: number
  items: Uint8Array[]
}

/** An invented text: nonzero bytes, then trailing padding of spaces and zero bytes (PV-0726). */
function paddedText(generator: SeededGenerator): { text: Uint8Array; padded: Uint8Array } {
  const text = nonzeroBytes(0, 10, generator)
  while (text.length > 0 && text[text.length - 1] === 0x20) text.pop()
  const padding: number[] = []
  for (let count = generator.int(0, 4); count > 0; count--) padding.push(generator.bool() ? 0x20 : 0)
  return { text: Uint8Array.from(text), padded: cat(text, padding) }
}

function plausibleScreen(generator: SeededGenerator): ScreenModel {
  const model: ScreenModel = { texts: new Map(), area: undefined, atoms: 0, inputs: 0, passwords: 0, menus: 0, menuEntries: 0, items: [] }
  for (const field of ScreenIdentityText.allCases) {
    if (!generator.bool()) continue
    const { text, padded } = paddedText(generator)
    model.texts.set(field, text)
    const item = ScreenIdentityText.item(field)
    model.items.push(generator.bool() ? appl(ApplItem.id(item), ApplItem.sid(item), padded) : appl4(ApplItem.id(item), ApplItem.sid(item), padded))
  }
  if (generator.bool()) {
    const value = generator.bytes(generator.bool() ? 16 : generator.int(0, 20))
    // An empty model value stands for an AREASIZE that is present but not 16 bytes.
    model.area = value.length === 16 ? value : new Uint8Array(0)
    model.items.push(appl(0x0c, 0x07, value))
  }
  for (let items = generator.int(0, 2); items > 0; items--) {
    const atoms: Uint8Array[] = []
    for (let count = generator.int(0, 5); count > 0; count--) {
      const etype = [101, 114, 121, 122, 130, 132, 111][generator.intBelow(0, 7)]
      const attr = generator.uint8()
      const text = nonzeroBytes(0, 6, generator)
      const content = etype === 121 || etype === 122 ? field1Content(text) : etype === 130 || etype === 132 ? field2Content(text) : text
      atoms.push(rawAtom(etype, { content, attr }))
      model.atoms += 1
      if (etype === 101 || etype === 121 || etype === 130) {
        model.inputs += 1
        if ((attr & 0x02) !== 0) model.passwords += 1
      }
    }
    model.items.push(generator.bool() ? appl4(0x09, 0x02, cat(...atoms)) : appl(0x09, 0x02, cat(...atoms)))
  }
  for (let menus = generator.int(0, 2); menus > 0; menus--) {
    const menu = plausibleMenu(generator)
    model.menus += 1
    model.menuEntries += modelMenuWalk(menu).offsets.length
    model.items.push(appl4(0x0b, generator.uint8(1, 4), menu))
  }
  for (let others = generator.int(0, 3); others > 0; others--) {
    // Items that carry no identity: other registered pairs, and simple items.
    if (generator.bool()) {
      const sid = [0x21, 0x1f, 0x29, 0x11][generator.intBelow(0, 4)]
      model.items.push(appl(0x06, sid, generator.bytes(generator.int(0, 8))))
    } else {
      model.items.push(cat([0x0a], generator.bytes(3)))
    }
  }
  shuffle(model.items, generator)
  if (generator.bool()) model.items.unshift(appl(0x04, 0x26, generator.bytes(4)))
  if (generator.bool()) model.items.push(Uint8Array.of(0x0c))
  return model
}

describe("Screen robustness", () => {
  test("fixedValuesAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5cee_0001)
    const tally = new Tally()
    for (let iteration = 0; iteration < inputCount; iteration++) {
      const layout = ScreenValueLayout.allCases[generator.intBelow(0, ScreenValueLayout.allCases.length)]
      const fieldWidths = widths[layout]
      const size = fieldWidths.reduce((sum, width) => sum + width, 0)
      const raw = generator.bytes(lengthNear(size, generator))
      let value: ScreenValue | undefined
      let failure: ItemPayloadErrorInfo | undefined
      try {
        value = ScreenValue.decode(layout, raw)
      } catch (error) {
        if (!(error instanceof ItemPayloadError)) throw error
        failure = error.info
      }
      if (value !== undefined) {
        tally.record(layout, true)
        assert.equal(raw.length, size)
        // The model: the fields back to back, each big-endian.
        let offset = 0
        const model: number[] = []
        for (const width of fieldWidths) {
          model.push(bigEndian(raw.subarray(offset, offset + width)))
          offset += width
        }
        assert.deepEqual(
          screenValueFields(value).map(([, field]) => field),
          model
        )
        assert.ok(bytesEqual(ScreenValue.bytes(value), raw))
      } else {
        tally.record(layout, false)
        const expected: ItemPayloadErrorInfo =
          raw.length < size ? { kind: "truncated", needed: size, available: raw.length } : { kind: "overlong", expected: size, actual: raw.length }
        assert.deepEqual(failure, expected)
      }
    }
    tally.expectBothSides(ScreenValueLayout.allCases, 500)
  })

  // MARK: IMODEUUIDS2, DYNT_FOCUS_1, CONTAINER NAME (§5.2, §8.5, §8.6)

  test("contentSizedValuesAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5cee_0002)
    const tally = new Tally()
    for (let iteration = 0; iteration < inputCount; iteration++) {
      // IMODEUUIDS2: u8 count n, then n × (16-byte UUID, u8); exactly 1 + 17n bytes.
      const count = generator.int(0, 4)
      let raw: Uint8Array = cat([count], generator.bytes(lengthNear(17 * count, generator)))
      if (generator.intBelow(0, 10) === 0) raw = generator.bytes(generator.int(0, 3))
      const needed = raw.length === 0 ? 1 : 1 + 17 * raw[0]
      const uuids = tryDecode(() => InternalModeUUIDs.decode(raw))
      if (uuids !== undefined) {
        tally.record("imode-uuids", true)
        assert.ok(raw.length === needed && uuids.count === raw[0])
        const entries: InternalModeEntry[] = []
        for (let index = 0; index < uuids.count; index++) {
          const entry = uuids.entry(index, raw)
          assert.ok(bytesEqual(entry.uuid.bytes, raw.subarray(1 + 17 * index, 17 + 17 * index)) && entry.activeContext === raw[17 + 17 * index])
          entries.push(entry)
        }
        const encoded = new ByteWriter()
        InternalModeUUIDs.append(entries, encoded)
        assert.ok(bytesEqual(encoded.toBytes(), raw))
      } else {
        tally.record("imode-uuids", false)
        assert.notEqual(raw.length, needed)
      }

      // DYNT_FOCUS_1: 9 fixed bytes, then container ids to the end.
      const focusRaw = generator.bytes(lengthNear(11, generator))
      const focus = tryDecode(() => DyntFocus.decode(focusRaw))
      if (focus !== undefined) {
        tally.record("dynt-focus", true)
        assert.ok(focusRaw.length >= 9 && focus.row === bigEndian(focusRaw.subarray(1, 3)))
        assert.ok(focus.colOffset === bigEndian(focusRaw.subarray(7, 9)) && focus.areaID === focusRaw[0])
        assert.deepEqual(focus.containerIDs, byteRange(9, focusRaw.length))
      } else {
        tally.record("dynt-focus", false)
        assert.ok(focusRaw.length < 9)
      }

      // CONTAINER NAME: three zero-terminated strings, trailing bytes reported.
      let parts: number[] = []
      for (let string = 0; string < 3; string++) parts = [...parts, ...nonzeroBytes(0, 6, generator), 0]
      let nameRaw: Uint8Array = cat(parts, generator.bytes(generator.int(0, 2)))
      if (generator.bool()) nameRaw = generator.mutate(nameRaw)
      const model = zeroTerminatedStrings(nameRaw, 0, 3)
      const name = tryDecode(() => ContainerName.decode(nameRaw))
      tally.record("container-name", name !== undefined)
      assert.equal(name !== undefined, model !== undefined)
      if (name !== undefined && model !== undefined) {
        assert.deepEqual(
          [name.subscreenName, name.containerName, name.subdynproName],
          model.ranges.map(([lower, upper]) => byteRange(lower, upper))
        )
        assert.equal(name.trailingByteCount, model.trailing)
      }
    }
    tally.expectBothSides(["imode-uuids", "dynt-focus", "container-name"], 500)
  })

  test("menuEntriesAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5cee_0003)
    const tally = new Tally()
    for (let iteration = 0; iteration < inputCount; iteration++) {
      let raw: Uint8Array = plausibleMenu(generator)
      if (iteration % 2 === 1) raw = generator.mutate(raw)
      const walk = MenuEntries.walk(raw)
      const model = modelMenuWalk(raw)
      tally.record("menu-entries", walk.error === undefined)
      assert.deepEqual(
        walk.entries.map(entry => entry.offset),
        model.offsets
      )
      assert.deepEqual(walk.error ? [menuEntryWalkErrorClass(walk.error.info), walk.error.entryIndex] : undefined, model.stop)
      for (const entry of walk.entries) {
        const p = entry.offset
        assert.ok(entry.fields.virtualKey === raw[p + 7] && entry.fields.flags === raw[p + 6])
        assert.ok(bytesEqual(entry.fields.returnCodes.bytes, raw.subarray(p + 8, p + 14)))
        assert.ok(bytesEqual(entry.fields.functionCodes.bytes, raw.subarray(p + 14, p + 20)))
        assert.ok(entry.text.lowerBound === p + 20 && raw[entry.text.upperBound] === 0 && raw[entry.info.upperBound] === 0)
        const encoded = new ByteWriter()
        MenuEntries.appendEntry(entry.fields, entry.text.of(raw).slice(), entry.accelerator.of(raw).slice(), entry.info.of(raw).slice(), encoded)
        assert.ok(bytesEqual(encoded.toBytes(), raw.subarray(p, entry.endOffset)))
      }
    }
    tally.expectBothSides(["menu-entries"], 1_000)
  })

  // MARK: UI_EVENT_SOURCE (client-input.md §7.2)

  test("uiEventSourceAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5cee_0004)
    const tally = new Tally()
    for (let iteration = 0; iteration < inputCount; iteration++) {
      // Valid flags, event_type, control_type, navigation data, row, col, the count, the ids.
      const flags = generator.uint8(0, 0x0f)
      const count = generator.int(0, 3)
      const full = cat([flags], generator.bytes(9), u16BE(count), generator.bytes(count))
      let raw: Uint8Array = full.slice(0, lengthNear(full.length, generator))
      if (generator.intBelow(0, 4) === 0) raw = cat(full, generator.bytes(generator.int(1, 2)))
      // The model: 5 fixed bytes; with NAVIGATION_DATA (0x04) exactly 12 + count bytes.
      const accepted =
        raw.length < 5 ? false : (raw[0] & 0x04) === 0 ? true : raw.length >= 12 && raw.length === 12 + bigEndian(raw.subarray(10, 12))
      const event = tryDecode(() => UIEventSource.decode(raw))
      tally.record(raw.length >= 5 && (raw[0] & 0x04) !== 0 ? "navigation" : "other", event !== undefined)
      assert.equal(event !== undefined, accepted)
      if (event === undefined) continue
      assert.ok(event.validFlags === raw[0] && event.eventType === bigEndian(raw.subarray(1, 3)))
      assert.equal(event.controlType, bigEndian(raw.subarray(3, 5)))
      switch (event.detail.kind) {
        case "undecoded":
          assert.ok((raw[0] & 0x04) === 0)
          assert.deepEqual(event.detail.value, byteRange(5, raw.length))
          break
        case "navigation": {
          const navigation = event.detail.value
          assert.ok(navigation.navigationData === raw[5] && navigation.controlRow === bigEndian(raw.subarray(6, 8)))
          assert.equal(navigation.controlCol, bigEndian(raw.subarray(8, 10)))
          assert.deepEqual(navigation.containerIDs, byteRange(12, raw.length))
          const encoded = new ByteWriter()
          UIEventSource.append(
            {
              validFlags: event.validFlags,
              eventType: event.eventType,
              controlType: event.controlType,
              navigationData: navigation.navigationData,
              controlRow: navigation.controlRow,
              controlCol: navigation.controlCol,
              containerIDs: navigation.containerIDs.of(raw).slice()
            },
            encoded
          )
          assert.ok(bytesEqual(encoded.toBytes(), raw))
          break
        }
      }
    }
    tally.expectBothSides(["navigation", "other"], 300)
  })

  /**
   * Generated screens in any order, with or without a step item and EOM (R-SS-7, R-SE-2), against
   * the model recorded while building them; then the same screens mutated, whose identity must
   * agree with the item and atom walks.
   */
  test("screenIdentityAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5cee_0005)
    const tally = new Tally()
    for (let iteration = 0; iteration < inputCount / 4; iteration++) {
      const model = plausibleScreen(generator)
      const items = cat(...model.items)
      const structure = LogonFieldStructure.decode(items)
      const identity = structure.identity
      for (const field of ScreenIdentityText.allCases) assert.deepEqual(identity.text(field)?.of(items).slice(), model.texts.get(field), field)
      if (model.area === undefined) {
        assert.ok(identity.areaSize() === undefined && identity.areaSizeOccurrences === 0)
      } else if (model.area.length === 0) {
        assert.ok(identity.areaSize() === undefined && identity.diagnostics.undecodableValues === 1)
      } else {
        assert.equal(identity.areaSize()?.windowHeight, bigEndian(model.area.subarray(0, 4)))
      }
      assert.ok(identity.atomCount === model.atoms && identity.inputFieldCount === model.inputs && identity.passwordFieldCount === model.passwords)
      assert.ok(identity.menuCount === model.menus && identity.menuEntryCount === model.menuEntries)
      assert.ok(structure.inputFields.length === model.inputs && structure.passwordFields.length === model.passwords)

      // The walks fail in item order: the first DYNT_ATOM item whose atoms fail, or else the item
      // walk's own stop, drops the message.
      const mutated = generator.mutate(items)
      const walk = walkItems(mutated)
      const isAtomItem = (appl: ApplItem | undefined) => ApplItem.equals(appl, ApplItem.dynt("atom"))
      const atomFailure = walk.items.find(item => isAtomItem(item.appl) && walkAtoms(item.valueRange.of(mutated)).error !== undefined)
      try {
        const mutatedIdentity = ScreenIdentity.decode(mutated)
        tally.record("mutated screen", true)
        assert.ok(walk.error === undefined && atomFailure === undefined)
        const atoms = walk.items
          .filter(item => isAtomItem(item.appl))
          .map(item => walkAtoms(item.valueRange.of(mutated)).atoms.length)
          .reduce((sum, value) => sum + value, 0)
        assert.equal(mutatedIdentity.atomCount, atoms)
        assert.equal(mutatedIdentity.menuCount, walk.items.filter(item => item.appl !== undefined && ApplItem.id(item.appl) === 0x0b).length)
      } catch (error) {
        if (!(error instanceof ScreenIdentityError)) throw error
        tally.record("mutated screen", false)
        switch (error.info.kind) {
          case "items":
            assert.ok(atomFailure === undefined)
            assert.deepEqual(error.info.value.info, walk.error?.info)
            break
          case "atoms":
            assert.equal(atomFailure?.index, error.info.itemIndex)
            break
        }
      }
    }
    tally.expectBothSides(["mutated screen"], 500)
  })

  // MARK: Client input step (client-input.md §1, §2)

  // inputStepsRoundTrip: needs ClientInput.swift (next wave) and ClientMessages.swift (other wave):
  // it sends edited fields through `ClientInputStep` and `ClientMessageEncoder`.
})
