// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ScreenDecodingTests.swift (MIT).
//
// The tests that read a screen of a scenario (Swift's `Fixtures.gate()`, `Fixtures.items(_:)`,
// `Fixtures.message(_:)`, `Fixtures.items(screens:)`, which compiled the scenario in process) get it
// from the real fake server over TCP (src/test/support/screenSession.ts) and skip without it.
// `Fixtures.message("pond-gate")`, the gate's whole message payload, is the payload of the first
// message the fake server sends on a new connection (`ServerMessage.payload`); the test feeds it to a
// SessionMachine of its own, as the Swift test does.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ApplItem,
  DiagItemEncoder,
  DiagItemWalkError,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntAttributes,
  DyntElementType,
  DyntText,
  MenuEntryFlags,
  ScreenText,
  type KnownDyntElementKind
} from "../../../diag/codec/index.js"
import {
  GridPoint,
  Screen,
  ScreenContainer,
  ScreenDecodingError,
  ScreenElementID,
  ScreenElementKind,
  ScreenIcon,
  ScreenIdentityTexts,
  ScreenSize
} from "../../../diag/screen/index.js"
import { SessionMachine } from "../../../diag/session/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer, withPond } from "../../support/screenSession.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const etype = (kind: KnownDyntElementKind): DyntElementType => DyntElementType.of(kind)

describe("Screen: decoding the fake server's screens", () => {
  /** The Duck Pond gate: identity, size and menus */
  test("gateIdentity", { skip: skipWithoutFakeServer }, async () => {
    const screen = await Fixtures.gate()
    assert.equal(screen.identity.title, "Welcome to the Duck Pond")
    assert.equal(screen.identity.program, "SAPMSYST")
    assert.equal(screen.identity.screenNumber, "4242")
    assert.equal(screen.identity.transaction, "ZZPOND")
    assert.equal(screen.identity.guiProgram, "SAPMSYST")
    assert.equal(screen.identity.guiStatus, "ZZWADDLE")
    assert.equal(screen.identity.systemName, "DCK")
    assert.equal(screen.identity.client, "314")
    assert.deepEqual(screen.size, new ScreenSize({ rows: 18, columns: 64, windowRows: 18, windowColumns: 64 }))
    assert.ok(screen.isLogonScreen)
    assert.ok(!screen.isServerError)
    assert.ok(!screen.hasOKCodeItem)
    assert.equal(screen.message, undefined)
    assert.equal(screen.codePage, DyntText.utf8CodePage)
    assert.ok(screen.diagnostics.isClean)

    assert.deepEqual(
      screen.menus.map(menu => menu.kind),
      ["menuAct", "menuPfk", "menuKyb"]
    )
    assert.ok(screen.menus.every(menu => !menu.isTruncated))
    const act = screen.menus[0]?.entries[0]
    assert.ok(act !== undefined)
    assert.equal(act.text, "Welcome to the Duck Pond")
    assert.equal(act.accelerator, "W")
    assert.equal(act.info, undefined)
    assert.equal(act.fields.flags, MenuEntryFlags.sel | MenuEntryFlags.vkey)
    const pfk = screen.menus[1].entries[0]
    assert.ok(pfk !== undefined)
    assert.equal(pfk.text, "New Secret Quack")
    assert.equal(pfk.info, "New Secret Quack")
    assert.equal(pfk.virtualKey, 5)
    assert.deepEqual(
      screen.menus[2].entries.map(entry => entry.text),
      ["New Secret Quack", "Fly South for the Winter"]
    )
    assert.deepEqual(
      screen.menus[2].entries.map(entry => entry.virtualKey),
      [5, 15]
    )
  })

  /** The Duck Pond gate: labels and inputs in screen order, with a password field */
  test("gateElements", { skip: skipWithoutFakeServer }, async () => {
    const screen = await Fixtures.gate()
    const K = ScreenElementKind
    assert.deepEqual(
      screen.elements.map(element => element.kind),
      [K.label, K.input, K.label, K.input, K.label, K.input, K.label, K.input, K.label, K.frame, ...Array<ScreenElementKind>(8).fill(K.output)]
    )
    assert.deepEqual(
      screen.labels.map(label => label.caption),
      ["Pond", "Duck ID", "Secret quack", "Quack dialect", "Welcome to the Duck Pond"]
    )
    assert.deepEqual(
      screen.labels.map(label => label.icon),
      [new ScreenIcon("08"), undefined, undefined, undefined, undefined]
    )
    assert.deepEqual(
      screen.labels.map(label => label.tooltip),
      [undefined, undefined, "Up to 40 quacks, and the beak is case-sensitive", undefined, undefined]
    )
    assert.deepEqual(
      screen.labels.map(label => label.text),
      ["@08@Pond", "Duck ID", "@\\QUp to 40 quacks, and the beak is case-sensitive@Secret quack", "Quack dialect", "Welcome to the Duck Pond"]
    )
    assert.deepEqual(
      screen.labels.map(label => label.row),
      [2, 4, 6, 8, 11]
    )
    assert.ok(screen.labels.every(label => label.column === 2 && label.isProtected && !label.isEditable))
    assert.deepEqual(
      screen.labels.map(label => label.width),
      [14, 14, 14, 14, 24]
    )
    assert.equal(screen.labels[0]?.fieldName, "ZZPOND-NUMBER")
    assert.equal(screen.labels[screen.labels.length - 1]?.fieldName, undefined)

    const inputs = screen.inputs
    assert.deepEqual(
      inputs.map(input => input.row),
      [2, 4, 6, 8]
    )
    assert.ok(inputs.every(input => input.column === 18 && input.isEditable && input.atom.etype.kind === "efield2"))
    assert.deepEqual(
      inputs.map(input => input.width),
      [3, 12, 12, 2]
    )
    assert.deepEqual(
      inputs.map(input => input.maxLength),
      [3, 12, 40, 2]
    )
    assert.deepEqual(
      inputs.map(input => input.text),
      ["314", "", undefined, ""]
    )
    assert.deepEqual(
      inputs.map(input => input.isPassword),
      [false, false, true, false]
    )
    // The password field's FNAME child repeats INVISIBLE, so it is not decoded either.
    assert.deepEqual(
      inputs.map(input => input.fieldName),
      ["ZZPOND-NUMBER", "ZZPOND-DUCKID", undefined, "ZZPOND-DIALECT"]
    )
    assert.deepEqual(
      inputs.map(input => input.id),
      [
        new ScreenElementID({ block: 1, row: 2, column: 18, elementType: 130 }),
        new ScreenElementID({ block: 1, row: 4, column: 18, elementType: 130 }),
        new ScreenElementID({ block: 1, row: 6, column: 18, elementType: 130 }),
        new ScreenElementID({ block: 1, row: 8, column: 18, elementType: 130 })
      ]
    )
    assert.equal(inputs[2].id.description, "b1 r6 c18 t130")
    assert.deepEqual(screen.element(inputs[1].id), inputs[1])
    assert.equal(screen.element(new ScreenElementID({ block: 9, row: 9, column: 9, elementType: 130 })), undefined)
  })

  /** The Duck Pond gate: a notice board in a frame, its lines placed by their loop container */
  test("gateNoticeBoard", { skip: skipWithoutFakeServer }, async () => {
    const screen = await Fixtures.gate()
    assert.ok(screen.diagnostics.isClean)
    assert.deepEqual(screen.containers, [
      new ScreenContainer({ id: 1, kind: "loop", origin: new GridPoint(2, 33), width: 29, height: 12, linesPerLoopRow: 1 }),
      new ScreenContainer({ id: 2, kind: "table", origin: new GridPoint(13, 2), width: 28, height: 3 })
    ])
    const frame = screen.elements.find(element => element.kind.kind === "frame")
    assert.ok(frame !== undefined)
    assert.deepEqual(frame.placement, new GridPoint(1, 32))
    assert.equal(frame.visibleWidth, 31)
    assert.equal(frame.height, 14)
    assert.equal(frame.caption, "Pond Notice Board")

    const lines = screen.elements.filter(element => element.kind.kind === "output")
    assert.deepEqual(
      lines.map(line => line.id.area),
      Array<number>(8).fill(1)
    )
    assert.deepEqual(
      lines.map(line => line.id.block),
      [1, 2, 3, 4, 5, 6, 7, 8]
    )
    assert.deepEqual(
      lines.map(line => line.placement),
      [0, 1, 2, 3, 4, 5, 6, 7].map(index => new GridPoint(2 + index, 33))
    )
    assert.ok(lines.every(line => line.visibleWidth === 29 && line.atom.etype.kind === "ofield2"))
    assert.deepEqual(
      lines.map(line => line.isHighlighted),
      [true, true, false, false, false, false, false, false]
    )
    assert.deepEqual(
      lines.map(line => line.icon?.code),
      ["19", undefined, undefined, "5Y", undefined, "AF", "CG", "CG"]
    )
    assert.deepEqual(
      lines.map(line => line.caption),
      [
        " WELCOME TO THE DUCK POND",
        "Home of the finest breadcrumbs since 1987",
        "",
        " Water level: wet, mostly",
        "",
        " Ponds to paddle in",
        " 314 - The big pond",
        " 315 - Geese only (beware)"
      ]
    )
    // Every line lies inside the frame, one cell in from its border.
    for (const line of lines) {
      assert.ok(line.placement.row > frame.placement.row && line.placement.row < frame.placement.row + (frame.height ?? 0) - 1)
      assert.ok(line.placement.column > frame.placement.column)
      assert.ok(line.placement.column + line.visibleWidth < frame.placement.column + frame.visibleWidth)
    }
    // The lines' received ids stay container-relative; an element from another decode matches.
    assert.equal(lines[0]?.id.description, "a1 b1 r0 c0 t131")
    assert.equal(lines[0]?.description.includes("at r2 c33"), true)
  })

  /** The lobby: identity, status message and labels */
  test("lobby", { skip: skipWithoutFakeServer }, async () => {
    const screen = Screen.fromItems(await Fixtures.items("pond-lobby"))
    assert.equal(screen.identity.program, "ZZ_DUCK_LOBBY")
    assert.equal(screen.identity.screenNumber, "0100")
    assert.equal(screen.identity.transaction, "ZZBREAD")
    assert.equal(screen.identity.title, "The Duck Pond Lobby")
    assert.equal(screen.message, "Quack! Breadcrumbs are served at noon.")
    assert.ok(!screen.isLogonScreen)
    assert.equal(screen.inputs.length, 0)
    assert.deepEqual(
      screen.labels.slice(0, 2).map(label => label.text),
      ["Today's special: breadcrumbs", "Beware of the swan at pier 3"]
    )
    assert.ok(screen.labels.every(label => label.text !== undefined && label.column === 2))
    assert.deepEqual(
      screen.menus.map(menu => menu.kind),
      ["menuAct", "menuMnu", "menuPfk", "menuKyb"],
      "the lobby's GUI status, ZZSPLASH"
    )
    assert.ok(screen.diagnostics.isClean)
  })

  /** A screen from DiagSession's decoded message equals the one from its items */
  test("fromServerMessage", { skip: skipWithoutFakeServer }, async () => {
    const machine = new SessionMachine(Fixtures.identity, Fixtures.terminal)
    machine.start()
    // Swift's `Fixtures.message("pond-gate")`: the gate's message payload as the fake server sends it.
    const gate = await withPond("duck-pond-logon", async pond => (await pond.first()).payload.slice())
    const message = machine.receive({ kind: "payload", payload: gate }).message
    assert.ok(message !== undefined)
    const screen = Screen.fromMessage(message)
    assert.deepEqual(screen, await Fixtures.gate())
    assert.ok(!screen.isServerError)

    // An SNC frame (compress 2) is dropped by the session; no screen is built from it.
    const snc = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 2)
    const dropped = machine.receive({ kind: "payload", payload: snc }).message
    assert.ok(dropped !== undefined)
    throwsInfo(() => Screen.fromMessage(dropped), ScreenDecodingError, { kind: "notDecoded", value: { kind: "snc" } })
  })

  /** The identity vector of the invented logon-style screen */
  test("identityVector", () => {
    const vector = Fixtures.vector("Tests/Vectors/server-screen/logon-screen-identity.vec")
    const expect = vector.expectations
    const screen = Screen.fromItems(vector.bytes)
    assert.equal(screen.identity.systemName, expect.get("expect.dbname"))
    assert.equal(screen.identity.client, expect.get("expect.client"))
    assert.equal(screen.identity.transaction, expect.get("expect.tcode"))
    assert.equal(screen.identity.program, expect.get("expect.dynproname"))
    assert.equal(screen.identity.screenNumber, expect.get("expect.dynpronumber"))
    assert.equal(screen.identity.guiProgram, expect.get("expect.cuaname"))
    assert.equal(screen.identity.guiStatus, expect.get("expect.cuastatus"))
    assert.equal(screen.identity.title, expect.get("expect.session_title"))
    assert.equal(screen.size?.rows.toString(), expect.get("expect.area.area_height"))
    assert.equal(screen.size?.columns.toString(), expect.get("expect.area.area_width"))
    assert.equal(screen.size?.windowRows.toString(), expect.get("expect.area.window_height"))
    assert.equal(screen.size?.windowColumns.toString(), expect.get("expect.area.window_width"))
    assert.equal(screen.inputs.length.toString(), expect.get("expect.efields"))
    assert.equal(screen.inputs.filter(input => input.isPassword).length.toString(), expect.get("expect.efields.invisible"))
    assert.equal(screen.menus.length.toString(), expect.get("expect.menus"))
    assert.equal(
      screen.menus
        .map(menu => menu.entries.length)
        .reduce((sum, count) => sum + count, 0)
        .toString(),
      expect.get("expect.menu_entries")
    )
    assert.ok(screen.isLogonScreen)
  })

  /** The atoms vector of the logon-style screen: one element per atom that is not a child */
  test("logonAtomsVector", () => {
    const vector = Fixtures.vector("Tests/Vectors/dynt/server-logon-atoms.vec")
    const expect = vector.expectations
    const screen = Screen.fromItems(Fixtures.atomItem(vector.bytes))
    const declared = expect.get("expect.atoms")
    assert.ok(declared !== undefined)
    assert.ok(/^[+-]?\d+$/.test(declared), `expect.atoms is a number: ${declared}`)
    const count = Number(declared)
    const expected: { etype: string | undefined; row: string | undefined; col: string | undefined }[] = []
    for (let index = 1; index <= count; index++) {
      const etype = expect.get(`expect.atom.${index}.etype`)
      if (etype === "114" || etype === "120") continue
      expected.push({ etype, row: expect.get(`expect.atom.${index}.row`), col: expect.get(`expect.atom.${index}.col`) })
    }
    assert.equal(screen.elements.length, expected.length)
    for (let index = 0; index < Math.min(screen.elements.length, expected.length); index++) {
      const element = screen.elements[index]
      const atom = expected[index]
      assert.equal(element.id.elementType.toString(), atom.etype)
      assert.equal(element.row.toString(), atom.row)
      assert.equal(element.column.toString(), atom.col)
    }
    assert.equal(screen.inputs.length, 4)
    assert.equal(screen.inputs.filter(input => input.isPassword).length, 1)
    assert.ok(screen.inputs.every(input => (input.isPassword ? input.text === undefined : input.text !== undefined)))
  })

  /** A password field's value is never decoded, described, debug-described or dumped */
  test("passwordNeverPrinted", { skip: skipWithoutFakeServer }, async () => {
    const items = await Fixtures.screens(`
screen hideout
  text DYNPRONAME "ZZ_NEST"
  atoms
    label row 1 col 1 mlen 6 "Quack"
    input row 1 col 8 mlen 12 max 40 "quackquack" invisible fname "ZZNEST-QUACK"
end
`)
    const screen = Screen.fromItems(items)
    const password = screen.inputs[0]
    assert.ok(password !== undefined)
    assert.ok(password.isPassword)
    assert.equal(password.text, undefined)
    assert.equal(password.fieldName, undefined)
    assert.equal(password.description, "input b1 r1 c8 t130 w12 max40 password")
    assert.equal(password.debugDescription, password.description)
    // Swift's `dump(screen)`: every stored property, hidden ones included.
    const dumped = inspect(screen, { depth: 8, showHidden: true })
    for (const printed of [String(screen), inspect(screen), screen.debugDescription, dumped, JSON.stringify(screen), `${screen.elements}`]) {
      assert.ok(!printed.includes("quackquack"))
    }
    assert.equal(screen.description, "Screen(ZZ_NEST ?: 2 elements, 1 inputs, 1 password)")
    assert.ok(screen.debugDescription.includes('label b1 r1 c1 t132 w6 protected "Quack"'))
  })

  /** Ids are stable across decodes and count repeated positions */
  test("stableIDs", { skip: skipWithoutFakeServer }, async () => {
    assert.deepEqual(
      (await Fixtures.gate()).elements.map(element => element.id),
      (await Fixtures.gate()).elements.map(element => element.id)
    )
    const items = await Fixtures.screens(`
screen echo
  atoms
    label row 3 col 4 mlen 5 "Quack"
    label row 3 col 4 mlen 5 "Quack"
end
`)
    const ids = Screen.fromItems(items).elements.map(element => element.id)
    assert.deepEqual(
      ids.map(id => id.occurrence),
      [0, 1]
    )
    assert.ok(ScreenElementID.compare(ids[0], ids[1]) < 0)
    assert.equal(ids[1].description, "b1 r3 c4 t132#1")
    assert.equal(new ScreenElementID({ area: 2, block: 1, row: 3, column: 4, elementType: 132 }).description, "a2 b1 r3 c4 t132")
  })

  /** Every element kind, with its widths and texts */
  test("elementKinds", () => {
    const atoms = new ByteWriter()
    const header = (type: DyntElementType, row: number): DyntAtomHeader => new DyntAtomHeader({ etype: type, block: 2, row, col: 1 })
    DyntAtomEncoder.appendFrame(header(etype("frame1"), 1), 5, 30, utf8("Nest"), atoms)
    DyntAtomEncoder.appendTabstripButton(
      header(etype("tabstripButton"), 2),
      {
        vLength: 9,
        vHeight: 1,
        pageID: 1,
        functionCodeOffset: 0,
        textOffset: 0,
        idOffset: 0,
        text: utf8("Pond"),
        functionCode: utf8("ZZTAB"),
        id: utf8("T1")
      },
      atoms
    )
    // Push button 115: vlength, vheight, two offsets, then the strings (#35, not decoded).
    DyntAtomEncoder.appendAtom(header(etype("pushbutton2"), 3), Uint8Array.of(7, 1, 0, 0, 0, 0, 0x51, 0), atoms)
    // Radio button 129: button, label length (u16), event id offset (u16), event id length,
    // text offset (u16), text length (u16), then the rest (#35).
    DyntAtomEncoder.appendAtom(header(etype("radiobutton3"), 4), Uint8Array.of(1, 0, 6, 0, 0, 0, 0, 0, 0, 0), atoms)
    DyntAtomEncoder.appendAtom(header(etype("checkbutton1"), 5), Uint8Array.of(1), atoms)
    DyntAtomEncoder.appendField(header(etype("ofield2"), 6), { mlen: 8, maxNrChars: 8, text: utf8("42  ") }, atoms)
    DyntAtomEncoder.appendAtom(header(etype("efield"), 7), Uint8Array.of(0, 0), atoms)
    DyntAtomEncoder.appendAtom(header(DyntElementType.unknown(200), 8), new Uint8Array(0), atoms)
    const items = new ByteWriter()
    items.bytes(Fixtures.atomItem(new Uint8Array(0)))
    DiagItemEncoder.appendAPPL(ApplItem.dynt("tabstripButtons"), atoms.toBytes(), items)
    const screen = Screen.fromItems(items.toBytes())

    const K = ScreenElementKind
    assert.deepEqual(
      screen.elements.map(element => element.kind),
      [K.frame, K.tab, K.button, K.radioButton, K.checkbox, K.output, K.input, K.other(DyntElementType.unknown(200))]
    )
    assert.deepEqual(
      screen.elements.map(element => element.width),
      [30, 9, 7, 6, undefined, 8, undefined, undefined]
    )
    assert.deepEqual(
      screen.elements.map(element => element.height),
      [5, 1, 1, undefined, undefined, undefined, undefined, undefined]
    )
    // The push button's strings lack their second zero byte (R-DA-9); the radio button's empty
    // text is where both sources agree (PV-0659).
    assert.deepEqual(
      screen.elements.map(element => element.text),
      ["Nest", "Pond", undefined, "", undefined, "42", undefined, undefined]
    )
    assert.deepEqual(
      screen.elements.map(element => element.functionCode),
      [undefined, "ZZTAB", undefined, undefined, undefined, undefined, undefined, undefined]
    )
    assert.deepEqual(
      screen.elements.map(element => element.maxLength),
      [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]
    )
    assert.deepEqual(
      screen.elements.map(element => ScreenElementKind.description(element.kind)),
      ["frame", "tab", "button", "radio", "checkbox", "output", "input", "etype 200"]
    )
    assert.deepEqual(ScreenElementKind.of(etype("fname")), ScreenElementKind.other(etype("fname")))
    assert.equal(ScreenElementKind.description(ScreenElementKind.other(etype("fname"))), "DIAG_DGOTYP_FNAME")
    assert.equal(screen.elements[0].description, 'frame b2 r1 c1 t127 w30 h5 "Nest"')
    assert.equal(screen.diagnostics.repairedTexts, 0)
  })

  /** Items the screen reads besides atoms: OKCODE, a stopped menu, a repeated message */
  test("otherItems", () => {
    const items = new ByteWriter()
    ScreenText.appendItem(ApplItem.varInfo("okcode"), utf8("ZZDUCK"), items)
    ScreenText.appendItem(ApplItem.stSystemInfo("message"), utf8("First quack  "), items)
    ScreenText.appendItem(ApplItem.stSystemInfo("message"), utf8("Second quack"), items)
    // An entry cut off inside its fixed fields: the walk stops, no entry is kept.
    DiagItemEncoder.appendAPPL4(ApplItem.mnuEntry("menuMnu"), Uint8Array.of(0, 5), items)
    const screen = Screen.fromItems(items.toBytes())
    assert.ok(screen.hasOKCodeItem)
    assert.equal(screen.message, "First quack")
    assert.equal(screen.menus.length, 1)
    assert.ok(screen.menus[0].isTruncated)
    assert.equal(screen.menus[0].entries.length, 0)
    assert.equal(screen.elements.length, 0)
    assert.deepEqual(screen.identity, new ScreenIdentityTexts())
    assert.equal(screen.size, undefined)
    assert.ok(!screen.diagnostics.isClean)
  })

  /** A walk that stops keeps what came before it; the screen is never dropped */
  test("stoppedWalks", () => {
    // An atom whose declared length runs past the value (IMPL-DA-3): no element, one stop.
    const truncatedAtom = Fixtures.atomItem(Uint8Array.of(0x00, 0x20, 0, 0, 130))
    const noAtoms = Screen.fromItems(truncatedAtom)
    assert.equal(noAtoms.elements.length, 0)
    assert.equal(noAtoms.diagnostics.stoppedAtomWalks, 1)
    assert.equal(noAtoms.diagnostics.itemWalkStop, undefined)
    assert.ok(!noAtoms.diagnostics.isClean)
    // An item cut off inside its length (IMPL-IT-5).
    const cut = Screen.fromItems(Uint8Array.of(0x10, 0x06, 0x02, 0x00))
    assert.ok(cut.diagnostics.itemWalkStop instanceof DiagItemWalkError)
    assert.deepEqual(cut.diagnostics.itemWalkStop.info, { kind: "truncated", itemIndex: 1, itemOffset: 0, field: "length" })
    // A DYNT_TABSTRIP_BUTTONS walk that stops: the identity reader does not walk it, the screen does.
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.dynt("tabstripButtons"), Uint8Array.of(0x00, 0x05), items)
    assert.equal(Screen.fromItems(items.toBytes()).diagnostics.stoppedAtomWalks, 1)
  })

  /** Code page 1100 reads as ISO 8859-1: the gate's ASCII texts are the same as in UTF-8 */
  test("latin1CodePage", { skip: skipWithoutFakeServer }, async () => {
    const screen = Screen.fromItems(await Fixtures.items("pond-gate"), { codePage: 1100 })
    const utf8Screen = await Fixtures.gate()
    assert.equal(screen.codePage, 1100)
    assert.equal(screen.textEncoding, "latin1")
    assert.ok(screen.knowsCodePage)
    assert.deepEqual(screen.identity, utf8Screen.identity)
    assert.deepEqual(
      screen.elements.map(element => element.text),
      utf8Screen.elements.map(element => element.text)
    )
    assert.deepEqual(screen.menus, utf8Screen.menus)
    assert.ok(screen.diagnostics.isClean)
    assert.ok(screen.isLogonScreen)
  })

  /** Invalid UTF-8 is shown repaired, with U+FFFD, and counted */
  test("invalidText", () => {
    const atoms = new ByteWriter()
    const header = new DyntAtomHeader({ etype: etype("keyword2"), block: 1, row: 1, col: 1, attributes: DyntAttributes.protected })
    DyntAtomEncoder.appendField(header, { mlen: 2, maxNrChars: 2, text: Uint8Array.of(0xc3, 0x28) }, atoms)
    const screen = Screen.fromItems(Fixtures.atomItem(atoms.toBytes()))
    assert.equal(screen.labels.length, 1)
    assert.equal(screen.labels[0].text, "�(")
    assert.equal(screen.diagnostics.repairedTexts, 1)
    assert.ok(!screen.diagnostics.isClean)
  })
})
