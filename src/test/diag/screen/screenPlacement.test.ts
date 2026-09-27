// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ScreenPlacementTests.swift (MIT).
//
// `xmlpropTooltip` read an inline `.screens` text with Swift's `Fixtures.items(screens:)`, which
// built it in process; here the fake server builds and sends it over TCP
// (src/test/support/screenSession.ts), and the test skips without the server. Swift's `.bug(id: 104)`
// traits are noted in the doc comments.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ContainerGeometry,
  ContainerLoop,
  ContainerName,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntAttributes,
  DyntButtonStrings,
  DyntElementType,
  ScreenText,
  type ApplSIDContainer
} from "../../../diag/codec/index.js"
import { FieldEdits, GridPoint, Screen, ScreenContainer, ScreenElementID, ScreenElementKind, ScreenIcon, TextMarkup } from "../../../diag/screen/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

// MARK: Building blocks

/** Item sequences built with DiagCodec's encoders. */
class Items {
  /** Swift's `bytes`, which the encoders append to. */
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

  containerLoop(lines: number): void {
    const value = new ByteWriter()
    new ContainerLoop({ linesPerLoopRow: lines }).append(value)
    DiagItemEncoder.appendAPPL(ApplItem.varInfo("containerLoop"), value.toBytes(), this.writer)
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

/** The atoms of one DYNT_ATOM item. */
class Atoms {
  readonly writer = new ByteWriter()

  get bytes(): Uint8Array {
    return this.writer.toBytes()
  }

  field(
    etype: DyntElementType,
    fields: { area?: number; block?: number; row: number; col: number; attributes: DyntAttributes; mlen: number; maxNrChars?: number },
    text: Uint8Array
  ): void {
    DyntAtomEncoder.appendField(
      new DyntAtomHeader({ etype, area: fields.area ?? 0, block: fields.block ?? 1, row: fields.row, col: fields.col, attributes: fields.attributes }),
      { mlen: fields.mlen, maxNrChars: fields.maxNrChars ?? text.length, text },
      this.writer
    )
  }

  label(fields: { row: number; col?: number; mlen?: number; fname?: string }, text: string): void {
    const col = fields.col ?? 1
    this.field(
      DyntElementType.of("keyword2"),
      { row: fields.row, col, attributes: DyntAttributes.protected | DyntAttributes.propFont, mlen: fields.mlen ?? 18 },
      utf8(text)
    )
    if (fields.fname !== undefined) this.child(DyntElementType.of("fname"), { area: 0, block: 1, row: fields.row, col }, fields.fname)
  }

  input(fields: { row: number; mlen: number; max: number; text?: Uint8Array; invisible?: boolean }): void {
    this.field(
      DyntElementType.of("efield2"),
      {
        row: fields.row,
        col: 20,
        attributes: fields.invisible === true ? DyntAttributes.invisible | DyntAttributes.yes3D : DyntAttributes.yes3D,
        mlen: fields.mlen,
        maxNrChars: fields.max
      },
      fields.text ?? new Uint8Array(0)
    )
  }

  child(etype: DyntElementType, position: { area: number; block: number; row: number; col: number }, text: string): void {
    DyntAtomEncoder.appendText(
      new DyntAtomHeader({ etype, area: position.area, block: position.block, row: position.row, col: position.col }),
      utf8(text),
      this.writer
    )
  }

  frame(fields: { row: number; col: number; rows: number; cols: number }, caption: string): void {
    DyntAtomEncoder.appendFrame(
      new DyntAtomHeader({
        etype: DyntElementType.of("frame1"),
        block: 1,
        row: fields.row,
        col: fields.col,
        attributes: DyntAttributes.protected | DyntAttributes.propFont
      }),
      fields.rows,
      fields.cols,
      utf8(caption),
      this.writer
    )
  }
}

/** The notice board's lines, in loop order: the text and whether it is highlighted. */
const noticeLines: readonly { text: string; highlighted: boolean }[] = [
  { text: "@19@ WELCOME TO THE DUCK POND, WHERE EVERY DUCK IS A VIP", highlighted: true },
  { text: "Breadcrumb Edition 2026", highlighted: true },
  { text: "", highlighted: false },
  { text: "@5Y@ Pond details: DCK - waterline 42 centimetres", highlighted: false },
  { text: "", highlighted: false },
  { text: "@AF@ Ponds to paddle in", highlighted: false },
  { text: "@CG@ 314 - The big pond", highlighted: false },
  { text: "@CG@ 315 - The pond where the geese live", highlighted: false }
]

/** A text padded with spaces to `count` bytes, as the owner's info lines were (dlen 132). */
function padded(text: string, count: number): Uint8Array {
  const bytes = utf8(text)
  const result = new Uint8Array(Math.max(count, bytes.length)).fill(0x20)
  result.set(bytes)
  return result
}

/** The owner-shaped logon screen. */
function logonItems(): Uint8Array {
  const items = new Items()
  items.text(ApplItem.stSystemInfo("dynproName"), "SAPMSYST")
  items.text(ApplItem.stSystemInfo("dynproNumber"), "4242")
  items.reset()
  const main = new Atoms()
  main.label({ row: 0, fname: "ZZPOND-NUMBER" }, "@Q7@Pond")
  main.input({ row: 0, mlen: 3, max: 3, text: utf8("314") })
  main.frame({ row: 0, col: 35, rows: 19, cols: 56 }, "Pond Notice Board")
  main.child(DyntElementType.of("fname"), { area: 0, block: 1, row: 0, col: 35 }, "ZZNOTICE-FRAME")
  main.label({ row: 2 }, "Duck ID")
  // The user field arrives as twelve zero bytes (the owner's user field, dlen 12).
  main.input({ row: 2, mlen: 12, max: 12, text: new Uint8Array(12) })
  main.label({ row: 3 }, "@\\QAt most 40 quacks, beak-sensitive@Secret quack")
  main.input({ row: 3, mlen: 12, max: 40, invisible: true })
  main.label({ row: 5 }, "Quack dialect")
  main.input({ row: 5, mlen: 2, max: 2, text: Uint8Array.of(0, 0) })
  items.atoms(main)

  items.reset()
  items.container("loop", { id: 1, row: 1, col: 36, width: 54, height: 17 })
  items.containerLoop(1)
  items.containerName("", "ZZPONDNB", "0042")
  const notices = new Atoms()
  noticeLines.forEach((line, index) => {
    let attributes = DyntAttributes.protected | DyntAttributes.propFont
    if (line.highlighted) attributes |= DyntAttributes.intensify
    notices.field(
      DyntElementType.of("ofield2"),
      { area: 1, block: index + 1, row: index, col: 0, attributes, mlen: 54, maxNrChars: 132 },
      padded(line.text, 132)
    )
    if (index === 0) {
      notices.child(DyntElementType.of("fname"), { area: 1, block: 1, row: 0, col: 0 }, "ZZNOTICE-LINE")
    }
  })
  items.atoms(notices)

  items.reset()
  items.container("table", { id: 2, row: 8, col: 1, width: 31, height: 11 })
  items.containerName("", "ZZPONDNB", "0042")
  return items.bytes
}

/**
 * Placing atoms by their container, and the icon and tooltip markup of screen texts
 * (server-screen.md §8.6, Reading R-SS-14; dynt-atoms.md, "Icon and tooltip markup", Reading
 * R-DA-10).
 *
 * The first screen has the structure the owner's logon screen was seen to have (trial-derived,
 * PV-0732–PV-0736, in our own words): labels at column 1 and inputs at column 20 in the main area,
 * a 19 × 56 frame at row 0, column 35, then a step-loop container (id 1, row 1, column 36,
 * 54 × 17) whose one-line output fields sit at column 0 of the container, and a table container
 * (id 2) with no atoms. Every text is invented (D15).
 */
describe("Screen: placement by container, icon and tooltip markup", () => {
  // MARK: The owner-shaped logon screen

  /** Atoms of a loop container are placed at its origin; area 0 at the main origin (bug 104) */
  test("placement", () => {
    const screen = Screen.fromItems(logonItems())
    assert.ok(screen.diagnostics.isClean)
    assert.equal(screen.diagnostics.atomsWithoutContainer, 0)
    assert.equal(screen.elements.length, 17)

    assert.deepEqual(
      screen.labels.map(label => label.placement),
      [0, 2, 3, 5].map(row => new GridPoint(row, 1))
    )
    assert.deepEqual(
      screen.inputs.map(input => input.placement),
      [0, 2, 3, 5].map(row => new GridPoint(row, 20))
    )

    const frame = screen.elements.find(element => element.kind.kind === "frame")
    assert.ok(frame !== undefined)
    assert.deepEqual(frame.placement, new GridPoint(0, 35))
    assert.equal(frame.visibleWidth, 56)
    assert.equal(frame.height, 19)
    assert.equal(frame.caption, "Pond Notice Board")
    assert.equal(frame.fieldName, "ZZNOTICE-FRAME")

    const lines = screen.elements.filter(element => element.kind.kind === "output")
    assert.equal(lines.length, 8)
    // The received id keeps the area, block, row and column; the placement adds the origin.
    assert.deepEqual(
      lines.map(line => line.id),
      [0, 1, 2, 3, 4, 5, 6, 7].map(index => new ScreenElementID({ area: 1, block: index + 1, row: index, column: 0, elementType: 131 }))
    )
    assert.deepEqual(
      lines.map(line => line.placement),
      [0, 1, 2, 3, 4, 5, 6, 7].map(index => new GridPoint(1 + index, 36))
    )
    assert.ok(lines.every(line => line.visibleWidth === 54))
    assert.deepEqual(
      lines.map(line => line.isHighlighted),
      noticeLines.map(line => line.highlighted)
    )
    assert.equal(lines[0]?.fieldName, "ZZNOTICE-LINE")

    assert.deepEqual(screen.containers, [
      new ScreenContainer({ id: 1, kind: "loop", origin: new GridPoint(1, 36), width: 54, height: 17, linesPerLoopRow: 1 }),
      new ScreenContainer({ id: 2, kind: "table", origin: new GridPoint(8, 1), width: 31, height: 11 })
    ])
  })

  /** Icon codes and tooltips come off the captions; the raw text stays (bug 104) */
  test("markup", () => {
    const screen = Screen.fromItems(logonItems())
    const labels = screen.labels
    assert.deepEqual(
      labels.map(label => label.caption),
      ["Pond", "Duck ID", "Secret quack", "Quack dialect"]
    )
    assert.deepEqual(
      labels.map(label => label.icon),
      [new ScreenIcon("Q7"), undefined, undefined, undefined]
    )
    assert.deepEqual(
      labels.map(label => label.tooltip),
      [undefined, undefined, "At most 40 quacks, beak-sensitive", undefined]
    )
    assert.equal(labels[2].text, "@\\QAt most 40 quacks, beak-sensitive@Secret quack")
    // The label's dlen is its whole text; it shows in mlen cells.
    assert.deepEqual(
      labels.map(label => label.visibleWidth),
      [18, 18, 18, 18]
    )

    const lines = screen.elements.filter(element => element.kind.kind === "output")
    assert.deepEqual(
      lines.map(line => line.icon?.code),
      ["19", undefined, undefined, "5Y", undefined, "AF", "CG", "CG"]
    )
    assert.deepEqual(
      lines.map(line => line.caption),
      [
        " WELCOME TO THE DUCK POND, WHERE EVERY DUCK IS A VIP",
        "Breadcrumb Edition 2026",
        "",
        " Pond details: DCK - waterline 42 centimetres",
        "",
        " Ponds to paddle in",
        " 314 - The big pond",
        " 315 - The pond where the geese live"
      ]
    )
    assert.ok(lines.every(line => line.tooltip === undefined))
  })

  /** A field of zero bytes decodes as empty and is not returned unedited (bug 104) */
  test("zeroFilledFields", () => {
    const screen = Screen.fromItems(logonItems())
    const inputs = screen.inputs
    assert.deepEqual(
      inputs.map(input => input.text),
      ["314", "", undefined, ""]
    )
    assert.deepEqual(
      inputs.map(input => input.caption),
      ["314", "", undefined, ""]
    )
    assert.ok(inputs.every(input => input.icon === undefined && input.tooltip === undefined))
    assert.equal(screen.diagnostics.repairedTexts, 0)

    // Leaving the user field empty is no edit; typing a name returns it at its received place.
    const edits = new FieldEdits()
    edits.setText("", inputs[1].id)
    assert.equal(screen.inputStep(edits).items.length, 0)
    edits.setText("MALLARD", inputs[1].id)
    const { atoms, value } = Fixtures.returnedAtoms(screen.inputStep(edits))
    assert.deepEqual(
      atoms.map(atom => atom.area),
      [0]
    )
    assert.deepEqual(
      atoms.map(atom => atom.row),
      [2]
    )
    assert.deepEqual(
      atoms.map(atom => atom.col),
      [20]
    )
    const first = atoms[0]
    assert.ok(first !== undefined)
    assert.deepEqual(Fixtures.text(first, value), utf8("MALLARD"))
  })

  // MARK: Areas without a container

  /** An area no container declares is placed at the main origin and counted */
  test("areaWithoutContainer", () => {
    const items = new Items()
    const atoms = new Atoms()
    atoms.field(DyntElementType.of("ofield2"), { area: 3, row: 2, col: 4, attributes: DyntAttributes.protected, mlen: 10 }, utf8("Lost duck"))
    items.atoms(atoms)
    const screen = Screen.fromItems(items.bytes)
    const element = screen.elements[0]
    assert.ok(element !== undefined)
    assert.deepEqual(element.placement, new GridPoint(2, 4))
    assert.equal(screen.diagnostics.atomsWithoutContainer, 1)
    assert.ok(!screen.diagnostics.isClean)
    assert.equal(screen.containers.length, 0)
  })

  /** CONTAINER RESET clears the containers declared before it */
  test("resetClears", () => {
    const items = new Items()
    items.reset()
    items.container("loop", { id: 1, row: 5, col: 5, width: 20, height: 3 })
    items.reset()
    const atoms = new Atoms()
    atoms.field(DyntElementType.of("ofield2"), { area: 1, row: 0, col: 0, attributes: DyntAttributes.protected, mlen: 8 }, utf8("Orphan"))
    items.atoms(atoms)
    const screen = Screen.fromItems(items.bytes)
    assert.deepEqual(screen.elements[0]?.placement, new GridPoint(0, 0))
    assert.equal(screen.diagnostics.atomsWithoutContainer, 1)
    assert.equal(screen.containers.length, 1, "the list keeps every declaration, in item order")
  })

  /** Containers declared together before one atom item: every area finds its origin */
  test("containersBeforeAtoms", () => {
    const items = new Items()
    items.reset()
    items.container("loop", { id: 1, row: 1, col: 30, width: 20, height: 4 })
    items.container("table", { id: 2, row: 6, col: 2, width: 20, height: 4 })
    const atoms = new Atoms()
    atoms.field(DyntElementType.of("keyword2"), { row: 0, col: 1, attributes: DyntAttributes.protected, mlen: 6 }, utf8("Ducks"))
    atoms.field(DyntElementType.of("ofield2"), { area: 1, block: 2, row: 1, col: 3, attributes: DyntAttributes.protected, mlen: 6 }, utf8("Quack"))
    atoms.field(DyntElementType.of("ofield2"), { area: 2, row: 2, col: 4, attributes: DyntAttributes.protected, mlen: 6 }, utf8("Honk"))
    items.atoms(atoms)
    const screen = Screen.fromItems(items.bytes)
    assert.deepEqual(
      screen.elements.map(element => element.placement),
      [new GridPoint(0, 1), new GridPoint(2, 33), new GridPoint(8, 6)]
    )
    assert.ok(screen.diagnostics.isClean)
  })

  /** A CONTAINER geometry that is not 9 bytes is counted, and places nothing */
  test("badGeometry", () => {
    const items = new Items()
    DiagItemEncoder.appendAPPL(ApplItem.container("loop"), Uint8Array.of(1, 0, 1), items.writer)
    const atoms = new Atoms()
    atoms.field(DyntElementType.of("ofield2"), { area: 1, row: 0, col: 0, attributes: DyntAttributes.protected, mlen: 4 }, utf8("Mud"))
    items.atoms(atoms)
    const screen = Screen.fromItems(items.bytes)
    assert.equal(screen.diagnostics.codec.undecodableValues, 1)
    assert.equal(screen.diagnostics.atomsWithoutContainer, 1)
    assert.equal(screen.containers.length, 0)
  })

  // MARK: Markup

  /** Leading markup forms */
  const markupCases: readonly [string, string | undefined, string | undefined, string][] = [
    ["@0S@Info", "0S", undefined, "Info"],
    ["@0Y\\QHatch a duck@ Hatch", "0Y", "Hatch a duck", " Hatch"],
    ["@\\QPsst, the geese@Secret", undefined, "Psst, the geese", "Secret"],
    ["@12@", "12", undefined, ""],
    ["@q7@lower case", "q7", undefined, "lower case"],
    ["@\\Q@Plain", undefined, undefined, "Plain"]
  ]
  for (const [text, icon, tooltip, caption] of markupCases) {
    test(`markupForms(${JSON.stringify(text)}, ${JSON.stringify(icon)}, ${JSON.stringify(tooltip)}, ${JSON.stringify(caption)})`, () => {
      const markup = TextMarkup.parse(text)
      assert.ok(markup.hasMarkup)
      assert.equal(markup.icon?.code, icon)
      assert.equal(markup.tooltip, tooltip)
      assert.equal(markup.caption, caption)
    })
  }

  /** Texts without leading markup stay as they are */
  const noMarkupCases: readonly string[] = [
    "Pond",
    "",
    "@0S",
    "@@Twin",
    "@ABC@three",
    "@0S\\Xoops@x",
    "Pond @0S@ in the middle",
    " @0S@ after a space",
    "@0\\QTip@x",
    "@\\QNo end",
    "@0S\\Q unterminated"
  ]
  for (const text of noMarkupCases) {
    test(`noMarkup(${JSON.stringify(text)})`, () => {
      const markup = TextMarkup.parse(text)
      assert.ok(!markup.hasMarkup)
      assert.equal(markup.icon, undefined)
      assert.equal(markup.tooltip, undefined)
      assert.equal(markup.caption, text)
    })
  }

  /** Input fields keep their markup; buttons, tabs, frames and outputs lose it */
  test("markupByKind", () => {
    const items = new Items()
    const atoms = new Atoms()
    atoms.field(DyntElementType.of("efield2"), { row: 0, col: 0, attributes: DyntAttributes.yes3D, mlen: 10, maxNrChars: 20 }, utf8("@0S@Mine"))
    atoms.field(DyntElementType.of("ofield2"), { row: 1, col: 0, attributes: DyntAttributes.protected, mlen: 10 }, utf8("@0S@Yours"))
    DyntButtonStrings.appendPushButton(
      new DyntAtomHeader({ etype: DyntElementType.of("pushbutton2"), block: 1, row: 2, col: 0 }),
      { vLength: 10, vHeight: 1, text: utf8("@0Y\\QHatch a duck@Hatch"), functionCode: utf8("=ZZHATCH") },
      atoms.writer
    )
    atoms.frame({ row: 3, col: 0, rows: 4, cols: 20 }, "@AF@Nest")
    items.atoms(atoms)
    const screen = Screen.fromItems(items.bytes)
    assert.deepEqual(
      screen.elements.map(element => element.kind),
      [ScreenElementKind.input, ScreenElementKind.output, ScreenElementKind.button, ScreenElementKind.frame]
    )
    assert.deepEqual(
      screen.elements.map(element => element.caption),
      ["@0S@Mine", "Yours", "Hatch", "Nest"]
    )
    assert.deepEqual(
      screen.elements.map(element => element.icon?.code),
      [undefined, "0S", "0Y", "AF"]
    )
    assert.deepEqual(
      screen.elements.map(element => element.tooltip),
      [undefined, undefined, "Hatch a duck", undefined]
    )
    assert.equal(screen.elements[2].visibleWidth, 10)
  })

  /** An input's XMLPROP DefaultTooltip becomes its tooltip; a password field's is not read */
  test("xmlpropTooltip", { skip: skipWithoutFakeServer }, async () => {
    const items = await Fixtures.screens(`
screen nest
  atoms
    input row 1 col 8 mlen 12 max 12 "" fname "ZZNEST-DUCK" tooltip "Ducks &amp; ducklings"
    input row 2 col 8 mlen 12 max 40 invisible fname "ZZNEST-QUACK" tooltip "Whisper it"
end
`)
    const screen = Screen.fromItems(items)
    assert.deepEqual(
      screen.inputs.map(input => input.tooltip),
      ["Ducks & ducklings", undefined]
    )
  })
})
