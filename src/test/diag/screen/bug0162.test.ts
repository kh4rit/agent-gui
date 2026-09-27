// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0162Tests.swift (MIT).

// Issue #162: a subscreen's frames and fields were drawn from the screen's origin, over the
// header fields above them. The owner's session report of a transaction display (2026-09-26,
// trial-derived, PV-1017) gave the shape rebuilt here with invented texts: the header and a frame
// of start options in area 0, rows 0 to 8; then, after a RESET, a CONTAINER SUBSCREEN whose
// 9-byte value is a container geometry (id 1, row 9, column 0, 65 × 12), its CONTAINER NAME, and
// a DYNT_ATOM item with the subscreen's frames and fields in area 0 from row 0. The screen's
// scroll info (21 rows) fits the subscreen's 12 rows below the header's 9.
//
// Swift's `ScreenPlacementTests.Items` and `.Atoms` (ScreenPlacementTests.swift) are rebuilt below
// with the members this file uses, since only this file may be written.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ContainerGeometry,
  ContainerName,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntAttributes,
  DyntElementType,
  ScreenText,
  type ApplSIDContainer
} from "../../../diag/codec/index.js"
import { GridPoint, Screen, ScreenElementKind } from "../../../diag/screen/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Item sequences built with DiagCodec's encoders (Swift `ScreenPlacementTests.Items`). */
class Items {
  readonly writer = new ByteWriter()

  get bytes(): Uint8Array {
    return this.writer.toBytes()
  }

  text(item: ApplItem, value: string): void {
    ScreenText.appendItem(item, utf8(value), this.writer)
  }

  container(sid: ApplSIDContainer, geometry: { id: number; row: number; col: number; width: number; height: number }): void {
    const value = new ByteWriter()
    new ContainerGeometry({ containerID: geometry.id, row: geometry.row, col: geometry.col, width: geometry.width, height: geometry.height }).append(value)
    DiagItemEncoder.appendAPPL(ApplItem.container(sid), value.toBytes(), this.writer)
  }

  reset(): void {
    this.container("reset", { id: 0, row: 0, col: 0, width: 0, height: 0 })
  }

  containerName(subscreen: string, container: string, subdynpro: string): void {
    const value = new ByteWriter()
    ContainerName.append(utf8(subscreen), utf8(container), utf8(subdynpro), value)
    DiagItemEncoder.appendAPPL(ApplItem.container("containerName"), value.toBytes(), this.writer)
  }

  atoms(atoms: Atoms): void {
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), atoms.bytes, this.writer)
  }
}

/** The atoms of one DYNT_ATOM item (Swift `ScreenPlacementTests.Atoms`). */
class Atoms {
  readonly writer = new ByteWriter()

  get bytes(): Uint8Array {
    return this.writer.toBytes()
  }

  field(
    etype: DyntElementType,
    field: { area?: number; block?: number; row: number; col: number; attributes: DyntAttributes; mlen: number; maxNrChars?: number; text: Uint8Array }
  ): void {
    DyntAtomEncoder.appendField(
      new DyntAtomHeader({ etype, area: field.area ?? 0, block: field.block ?? 1, row: field.row, col: field.col, attributes: field.attributes }),
      { mlen: field.mlen, maxNrChars: field.maxNrChars ?? field.text.length, text: field.text },
      this.writer
    )
  }

  label(place: { row: number; col?: number; mlen?: number }, text: string): void {
    this.field(DyntElementType.of("keyword2"), {
      row: place.row,
      col: place.col ?? 1,
      attributes: DyntAttributes.protected | DyntAttributes.propFont,
      mlen: place.mlen ?? 18,
      text: utf8(text)
    })
  }

  frame(frame: { row: number; col: number; rows: number; cols: number }, caption: string): void {
    DyntAtomEncoder.appendFrame(
      new DyntAtomHeader({
        etype: DyntElementType.of("frame1"),
        block: 1,
        row: frame.row,
        col: frame.col,
        attributes: DyntAttributes.protected | DyntAttributes.propFont
      }),
      frame.rows,
      frame.cols,
      utf8(caption),
      this.writer
    )
  }
}

/**
 * The pond register's display: three header rows, a frame of how the pond starts, and the
 * subscreen of how it is classified.
 */
function items(extraAtoms = false): Uint8Array {
  const items = new Items()
  items.text(ApplItem.stSystemInfo("dynproName"), "ZZ_POND_REGISTER")
  items.text(ApplItem.stSystemInfo("dynproNumber"), "0320")
  items.reset()
  const header = new Atoms()
  header.label({ row: 0, col: 0 }, "Pond Code")
  header.label({ row: 1, col: 0 }, "Flock")
  header.label({ row: 2, col: 0 }, "Pond Text")
  header.frame({ row: 3, col: 0, rows: 6, cols: 65 }, "Start Options")
  header.label({ row: 4, col: 1 }, "Launch Ramp")
  header.label({ row: 7, col: 1 }, "Permit Object")
  items.atoms(header)

  items.reset()
  items.container("subscreen", { id: 1, row: 9, col: 0, width: 65, height: 12 })
  items.containerName("ZZ_CLASSES_SUB", "ZZ_POND", "0321")
  const subscreen = new Atoms()
  subscreen.frame({ row: 0, col: 0, rows: 12, cols: 65 }, "Classification")
  subscreen.frame({ row: 1, col: 1, rows: 5, cols: 63 }, "Pond Class")
  subscreen.label({ row: 3, col: 32 }, "Paddle Service")
  subscreen.frame({ row: 6, col: 1, rows: 5, cols: 63 }, "Ripple Support")
  subscreen.label({ row: 7, col: 2 }, "Waves Allowed")
  items.atoms(subscreen)
  if (extraAtoms) {
    const main = new Atoms()
    main.label({ row: 21, col: 0 }, "Footnote")
    items.atoms(main)
  }
  return items.bytes
}

/** Swift's `Dictionary(_:uniquingKeysWith: { first, _ in first })`. */
function firstByKey<Key, Value>(pairs: [Key, Value][]): Map<Key, Value> {
  const map = new Map<Key, Value>()
  for (const [key, value] of pairs) if (!map.has(key)) map.set(key, value)
  return map
}

describe("Issue #162: a subscreen's fields are placed at the SUBSCREEN container's origin", () => {
  /** the subscreen's frames and fields sit below the header, from the SUBSCREEN container's row (bug #162) */
  test("subscreenPlacement", () => {
    const screen = Screen.fromItems(items())
    assert.equal(screen.diagnostics.atomsWithoutContainer, 0)
    const labels = firstByKey(screen.labels.map(label => [label.caption, label.placement]))
    assert.deepEqual(labels.get("Pond Code"), new GridPoint(0, 0))
    assert.deepEqual(labels.get("Permit Object"), new GridPoint(7, 1))
    assert.deepEqual(labels.get("Paddle Service"), new GridPoint(12, 32))
    assert.deepEqual(labels.get("Waves Allowed"), new GridPoint(16, 2))
    const frames = firstByKey(
      screen.elements
        .filter(element => ScreenElementKind.equals(element.kind, ScreenElementKind.frame))
        .map(element => [element.caption ?? "", element.placement])
    )
    assert.deepEqual(frames.get("Start Options"), new GridPoint(3, 0))
    assert.deepEqual(frames.get("Classification"), new GridPoint(9, 0))
    assert.deepEqual(frames.get("Pond Class"), new GridPoint(10, 1))
    assert.deepEqual(frames.get("Ripple Support"), new GridPoint(15, 1))
  })

  /** the SUBSCREEN is a container of the screen, and no longer an item the decoder does not read (bug #162) */
  test("subscreenContainer", () => {
    const screen = Screen.fromItems(items())
    const subscreen = screen.containers.find(container => container.kind === "subscreen")
    assert.ok(subscreen !== undefined, "the screen has a SUBSCREEN container")
    assert.equal(subscreen.id, 1)
    assert.deepEqual(subscreen.origin, new GridPoint(9, 0))
    assert.equal(subscreen.width, 65)
    assert.equal(subscreen.height, 12)
    assert.equal(subscreen.name, "ZZ_CLASSES_SUB")
    assert.equal(screen.otherContainerItems.length, 0)
  })

  /** only the atom item right after the SUBSCREEN is its subscreen; a later one is the main screen's */
  test("laterAtomsAreMain", () => {
    const screen = Screen.fromItems(items(true))
    const footnote = screen.labels.find(label => label.caption === "Footnote")
    assert.ok(footnote !== undefined, "the screen has the footnote")
    assert.deepEqual(footnote.placement, new GridPoint(21, 0))
  })
})
