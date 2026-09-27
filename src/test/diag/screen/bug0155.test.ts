// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0155Tests.swift (MIT).

// Issue #155: a tabstrip page's fields were drawn from the screen's origin, over the fields above
// the tabstrip. The owner's session report of the screen (2026-09-26, trial-derived, PV-1012) gave
// the shape rebuilt here with invented texts: the header in area 0; then groups of containers,
// each after a RESET: the TABSTRIP (row 3, column 0) with its tab buttons in its own area; the
// TABSTRIP again, its TABSTRIP_PAGE at row 2, column 1, and the page's fields as a subscreen in
// area 0; the TABSTRIP and its page again, and a CONTROL at row 24 of the page. The page's origin
// counts from the tabstrip's, the subscreen's area-0 atoms and the control from the page's, and a
// container declared again is the same container.
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
  TabstripButtons,
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

  label(place: { row: number; col?: number; mlen?: number; fname?: string }, text: string): void {
    const col = place.col ?? 1
    this.field(DyntElementType.of("keyword2"), {
      row: place.row,
      col,
      attributes: DyntAttributes.protected | DyntAttributes.propFont,
      mlen: place.mlen ?? 18,
      text: utf8(text)
    })
    if (place.fname !== undefined) this.child(DyntElementType.of("fname"), { area: 0, block: 1, row: place.row, col }, place.fname)
  }

  child(etype: DyntElementType, place: { area: number; block: number; row: number; col: number }, text: string): void {
    DyntAtomEncoder.appendText(new DyntAtomHeader({ etype, area: place.area, block: place.block, row: place.row, col: place.col }), utf8(text), this.writer)
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
 * The duck's record: two header rows, a tabstrip of two tabs, a page with two rows of fields
 * and a status control below them.
 */
function items(): Uint8Array {
  const items = new Items()
  items.text(ApplItem.stSystemInfo("dynproName"), "ZZ_DUCK_RECORD")
  items.text(ApplItem.stSystemInfo("dynproNumber"), "1100")
  items.reset()
  const header = new Atoms()
  header.label({ row: 0, col: 0 }, "Duck")
  header.label({ row: 1, col: 0 }, "Ruffled By")
  items.atoms(header)

  items.reset()
  items.container("tabstrip", { id: 1, row: 3, col: 0, width: 114, height: 19 })
  items.containerName("ZZ_DUCK_TABS", "ZZ_DUCK_RECORD", "1100")
  const buttons = new ByteWriter()
  ;["Pond", "Feathers"].forEach((caption, index) => {
    TabstripButtons.appendTab(
      new DyntAtomHeader({ etype: DyntElementType.of("tabstripButton"), area: 1, block: 1, row: 0, col: 1 + index * 8 }),
      {
        vLength: caption.length,
        vHeight: 1,
        pageID: 2,
        caption: utf8(caption),
        functionCode: utf8(`TAB${index}`),
        shortName: utf8(`T${index}`),
        fieldName: utf8(`T${index}`),
        isActive: index === 0
      },
      buttons
    )
  })
  DiagItemEncoder.appendAPPL4(ApplItem.dynt("tabstripButtons"), buttons.toBytes(), items.writer)

  items.reset()
  items.container("tabstrip", { id: 1, row: 3, col: 0, width: 114, height: 19 })
  items.containerName("ZZ_DUCK_TABS", "ZZ_DUCK_RECORD", "1100")
  items.container("tabstripPage", { id: 2, row: 2, col: 1, width: 112, height: 16 })
  items.containerName("ZZ_DUCK_PAGE", "ZZ_DUCK_RECORD", "1100")
  const page = new Atoms()
  page.frame({ row: 0, col: 0, rows: 8, cols: 83 }, "Pond")
  page.label({ row: 1, col: 1 }, "Pond Name")
  page.label({ row: 2, col: 1 }, "Depth")
  items.atoms(page)

  items.reset()
  items.container("tabstrip", { id: 1, row: 3, col: 0, width: 114, height: 19 })
  items.containerName("ZZ_DUCK_TABS", "ZZ_DUCK_RECORD", "1100")
  items.container("tabstripPage", { id: 2, row: 2, col: 1, width: 112, height: 16 })
  items.containerName("ZZ_DUCK_PAGE", "ZZ_DUCK_RECORD", "1100")
  items.container("control", { id: 1, row: 24, col: 0, width: 82, height: 2 })
  items.containerName("ZZ_DUCK_STATUS_BAR", "ZZ_DUCK_RECORD", "1100")
  return items.bytes
}

describe("Issue #155: a tabstrip page and its subscreen are placed inside the tabstrip", () => {
  /** the page's fields sit below the tab buttons, inside the tabstrip, not over the header (bug #155) */
  test("pagePlacement", () => {
    const screen = Screen.fromItems(items())
    assert.equal(screen.diagnostics.atomsWithoutContainer, 0)
    // Swift's `Dictionary(_:uniquingKeysWith: { first, _ in first })`.
    const labels = new Map<string | undefined, GridPoint>()
    for (const label of screen.labels) if (!labels.has(label.caption)) labels.set(label.caption, label.placement)
    assert.deepEqual(labels.get("Duck"), new GridPoint(0, 0))
    assert.deepEqual(labels.get("Ruffled By"), new GridPoint(1, 0))
    // The page counts from the tabstrip (3, 0) + (2, 1); its fields from the page.
    assert.deepEqual(labels.get("Pond Name"), new GridPoint(6, 2))
    assert.deepEqual(labels.get("Depth"), new GridPoint(7, 2))
    const frame = screen.elements.find(element => ScreenElementKind.equals(element.kind, ScreenElementKind.frame))
    assert.ok(frame !== undefined, "the screen has a frame")
    assert.deepEqual(frame.placement, new GridPoint(5, 1))
  })

  /** a container declared again is one container: one tabstrip, one page, the control inside the page (bug #155) */
  test("containersOnce", () => {
    const screen = Screen.fromItems(items())
    assert.deepEqual(
      screen.containers.map(container => container.kind),
      ["tabstrip", "tabstripPage", "control"]
    )
    assert.deepEqual(
      screen.containers.map(container => container.origin),
      [new GridPoint(3, 0), new GridPoint(5, 1), new GridPoint(29, 1)]
    )
    assert.equal(screen.tabstrips.length, 1)
    const tabstrip = screen.tabstrips[0]
    assert.ok(tabstrip !== undefined, "the screen has a tabstrip")
    assert.deepEqual(
      tabstrip.tabs.map(tab => tab.caption),
      ["Pond", "Feathers"]
    )
    assert.equal(tabstrip.pageArea, 2)
    const pageElements = screen.elements.filter(element => element.tabstripPage === 1)
    assert.equal(pageElements.length, 3, "the frame and the two labels belong to the page")
  })
})
