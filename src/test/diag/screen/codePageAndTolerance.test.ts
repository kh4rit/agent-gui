// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/CodePageAndToleranceTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ApplItem,
  CodePage,
  ComFlag,
  CompressField,
  DiagHeader,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntAttributes,
  DyntElementType,
  ScreenText,
  Secret,
  TextEncoding
} from "../../../diag/codec/index.js"
import { FieldEdits, Screen, ScreenDecodingError, ScreenElementKind } from "../../../diag/screen/index.js"
import { SessionMachine } from "../../../diag/session/index.js"
import { ByteWriter, concatBytes } from "../../../diag/wire/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

// MARK: Building blocks

/** `text` as UTF-16 in the given byte order. */
function utf16(text: string, bigEndian: boolean): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    const high = (unit >> 8) & 0xff
    const low = unit & 0xff
    if (bigEndian) bytes.push(high, low)
    else bytes.push(low, high)
  }
  return Uint8Array.from(bytes)
}

/**
 * An ST_R3INFO CODEPAGE_DIAG_GUI item (PV-0532): number, minimum bytes per character, the number as
 * text and an invented description, each zero-terminated.
 */
function codePageItem(codePage: number, bytesPerCharacter = 1): Uint8Array {
  const value = concatBytes(
    [(codePage >>> 24) & 0xff, (codePage >>> 16) & 0xff, (codePage >>> 8) & 0xff, codePage & 0xff, bytesPerCharacter],
    utf8(`${codePage}`),
    [0],
    utf8("Pond script"),
    [0]
  )
  const items = new ByteWriter()
  DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("codepageDiagGUI"), value, items)
  return items.toBytes()
}

function textItem(item: ApplItem, bytes: Uint8Array): Uint8Array {
  const items = new ByteWriter()
  ScreenText.appendItem(item, bytes, items)
  return items.toBytes()
}

/**
 * A screen in `encode`'s code page: identity texts with padding, a label, an input with a value and
 * a password field, a status message.
 */
function screenItems(program: string, encode: (text: string) => Uint8Array): Uint8Array {
  const items = new ByteWriter()
  items.bytes(textItem(ApplItem.stSystemInfo("dynproName"), concatBytes(encode(program + "  "), [0, 0])))
  items.bytes(textItem(ApplItem.stSystemInfo("dynproNumber"), encode("0042")))
  items.bytes(textItem(ApplItem.varInfo("sessionTitle"), encode("Grüße vom Teich")))
  items.bytes(textItem(ApplItem.stSystemInfo("message"), encode("Enten überall » ")))
  const atoms = new ByteWriter()
  DyntAtomEncoder.appendField(
    new DyntAtomHeader({ etype: DyntElementType.of("keyword2"), block: 1, row: 1, col: 1, attributes: DyntAttributes.protected }),
    { mlen: 12, maxNrChars: 12, text: encode("Entenstraße  ") },
    atoms
  )
  DyntAtomEncoder.appendField(
    new DyntAtomHeader({ etype: DyntElementType.of("efield2"), block: 1, row: 2, col: 1 }),
    { mlen: 10, maxNrChars: 10, text: encode("Ölteich") },
    atoms
  )
  DyntAtomEncoder.appendField(
    new DyntAtomHeader({ etype: DyntElementType.of("efield2"), block: 1, row: 3, col: 1, attributes: DyntAttributes.invisible }),
    { mlen: 10, maxNrChars: 20, text: new Uint8Array(0) },
    atoms
  )
  items.bytes(Fixtures.atomItem(atoms.toBytes()))
  return items.toBytes()
}

/** The bytes of `text` in `encoding` (Swift's `encoding.encode($0)!`). */
function encoder(encoding: TextEncoding): (text: string) => Uint8Array {
  return text => {
    const bytes = TextEncoding.encode(encoding, text)
    assert.ok(bytes !== undefined, `${text} is encodable in ${encoding}`)
    return bytes
  }
}

/**
 * Screens in the code page in force (session.md §6.3, §6.4) and screens a real server may send that
 * Swooey cannot read in full (architecture.md §4, "Unknown data"). Every text is invented (D15).
 */
describe("Screen: code pages and tolerance", () => {
  // MARK: Code pages

  /** CODEPAGE_DIAG_GUI in the message sets the code page for the whole message */
  const declaredCases: readonly [number, TextEncoding][] = [
    [CodePage.utf8, "utf8"],
    [CodePage.utf16LittleEndian, "utf16LittleEndian"],
    [CodePage.utf16BigEndian, "utf16BigEndian"],
    [CodePage.latin1, "latin1"]
  ]
  for (const [codePage, encoding] of declaredCases) {
    test(`declaredCodePage(${codePage}, ${encoding})`, () => {
      const encode = encoder(encoding)
      // The declaration comes after the texts: it still governs them (Reading R-SE-9).
      const items = concatBytes(screenItems("SAPMSYST", encode), codePageItem(codePage))
      assert.equal(Screen.declaredCodePage(items), codePage)
      // The session had the CONNECT code page 1100 before; the message declares its own.
      const screen = Screen.fromItems(items, { codePage: CodePage.latin1 })
      assert.equal(screen.codePage, codePage)
      assert.equal(screen.declaredCodePage, codePage)
      assert.equal(screen.textEncoding, encoding)
      assert.ok(screen.knowsCodePage)
      assert.equal(screen.identity.program, "SAPMSYST")
      assert.ok(screen.isLogonScreen, "DYNPRONAME is compared after decoding, so UTF-16 works too")
      assert.equal(screen.identity.screenNumber, "0042")
      assert.equal(screen.identity.title, "Grüße vom Teich")
      assert.equal(screen.message, "Enten überall »", "trailing spaces and zero characters are cut whole")
      assert.deepEqual(
        screen.labels.map(label => label.text),
        ["Entenstraße"]
      )
      assert.deepEqual(
        screen.inputs.map(input => input.text),
        ["Ölteich", undefined]
      )
      assert.ok(screen.diagnostics.isClean, inspect(screen.diagnostics))
    })
  }

  /** Without a declaration the given code page stays in force */
  test("givenCodePage", () => {
    const latin = TextEncoding.encode("latin1", "Grüße")
    assert.ok(latin !== undefined)
    const items = textItem(ApplItem.varInfo("sessionTitle"), latin)
    assert.equal(Screen.declaredCodePage(items), undefined)
    const screen = Screen.fromItems(items, { codePage: CodePage.latin1 })
    assert.equal(screen.codePage, CodePage.latin1)
    assert.equal(screen.declaredCodePage, undefined)
    assert.equal(screen.identity.title, "Grüße")
    // The same bytes in a UTF-8 session are not UTF-8: shown repaired, and counted.
    const wrong = Screen.fromItems(items)
    assert.equal(wrong.identity.title, "Gr��e")
    assert.equal(wrong.diagnostics.repairedTexts, 1)
    // A CODEPAGE_DIAG_GUI value that does not decode declares nothing.
    const broken = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("codepageDiagGUI"), Uint8Array.of(0x00, 0x00), broken)
    assert.equal(Screen.declaredCodePage(broken.toBytes()), undefined)
  })

  /** A code page Swooey does not know: texts read as ISO 8859-1, non-ASCII ones counted as guessed */
  test("unknownCodePage", () => {
    const items = concatBytes(
      textItem(ApplItem.stSystemInfo("dynproName"), utf8("ZZ_TEICH")),
      textItem(ApplItem.varInfo("sessionTitle"), Uint8Array.of(0x47, 0x72, 0xfc, 0xdf, 0x65)), // not-protocol: "Grüße" in ISO 8859-1
      codePageItem(8000)
    )
    const screen = Screen.fromItems(items, { codePage: CodePage.utf8 })
    assert.equal(screen.codePage, 8000)
    assert.ok(!screen.knowsCodePage)
    assert.equal(screen.textEncoding, "latin1")
    assert.equal(screen.identity.program, "ZZ_TEICH")
    assert.equal(screen.identity.title, "Grüße")
    assert.equal(screen.diagnostics.guessedTexts, 1, "the ASCII program name is no guess")
    assert.ok(!screen.diagnostics.isClean)
  })

  /** Edits and the OK-code go out in the screen's code page; a password is transcoded from UTF-8 */
  const inputEncodings: readonly TextEncoding[] = ["utf16LittleEndian", "utf16BigEndian", "latin1", "utf8"]
  for (const encoding of inputEncodings) {
    test(`inputInCodePage(${encoding})`, () => {
      const encode = encoder(encoding)
      const items = concatBytes(screenItems("ZZ_TEICH", encode), codePageItem(TextEncoding.codePage(encoding)))
      const screen = Screen.fromItems(items)
      const field = screen.inputs[0]
      const password = screen.inputs[1]
      assert.ok(password.isPassword)
      const edits = new FieldEdits()
      edits.setText("Möwe", field.id)
      edits.setSecret(new Secret(utf8("Schwan-ß")), password.id)
      const step = screen.inputStep(edits, { functionCode: "/nZZENTE" })
      const { atoms, value } = Fixtures.returnedAtoms(step)
      assert.equal(atoms.length, 2)
      assert.deepEqual(Fixtures.text(atoms[0], value), encode("Möwe"))
      assert.deepEqual(Fixtures.text(atoms[1], value), encode("Schwan-ß"))
      const okCode = encode("/nZZENTE")
      assert.ok(
        step.items.some(item => {
          if (item.kind === "varInfoOKCode") return item.text.length === okCode.length && item.text.every((byte, index) => byte === okCode[index])
          return false
        })
      )
      // An unchanged value is not returned, whatever the code page.
      const same = new FieldEdits()
      same.setText("Ölteich", field.id)
      assert.equal(Fixtures.atomValue(screen.inputStep(same)), undefined)
    })
  }

  // MARK: Tolerance

  /** A malformed atom, an unknown item and an unknown element type cost only themselves */
  test("tolerantScreen", () => {
    const items = new ByteWriter()
    items.bytes(textItem(ApplItem.stSystemInfo("dynproName"), utf8("ZZ_TEICH")))
    // First atom item: a label, then an atom whose length runs past the value.
    const first = new ByteWriter()
    DyntAtomEncoder.appendField(
      new DyntAtomHeader({ etype: DyntElementType.of("keyword2"), block: 1, row: 1, col: 1, attributes: DyntAttributes.protected }),
      { mlen: 5, maxNrChars: 5, text: utf8("Enten") },
      first
    )
    first.bytes([0x00, 0x40, 0x00, 0x00, 130]) // not-protocol: an atom that claims 64 bytes and has 5
    items.bytes(Fixtures.atomItem(first.toBytes()))
    // An item no registry row names (IMPL-IT-1).
    DiagItemEncoder.appendAPPL(ApplItem.unknownID(0x7e, 0x01), utf8("Quak"), items) // not-protocol: unregistered id
    // Second atom item: an unknown element type and a label.
    const second = new ByteWriter()
    DyntAtomEncoder.appendAtom(new DyntAtomHeader({ etype: DyntElementType.unknown(200), block: 1, row: 2, col: 1 }), Uint8Array.of(1, 2), second)
    DyntAtomEncoder.appendField(
      new DyntAtomHeader({ etype: DyntElementType.of("keyword2"), block: 1, row: 3, col: 1, attributes: DyntAttributes.protected }),
      { mlen: 5, maxNrChars: 5, text: utf8("Gänse") },
      second
    )
    items.bytes(Fixtures.atomItem(second.toBytes()))
    items.bytes(textItem(ApplItem.varInfo("sessionTitle"), utf8("Am Teich")))
    // An unknown simple item type ends the walk (IMPL-IT-2); what follows is not read.
    items.bytes([0x0d, 0x51, 0x55]) // not-protocol: type 0x0D is no item type
    items.bytes(textItem(ApplItem.stSystemInfo("message"), utf8("never read")))

    const screen = Screen.fromItems(items.toBytes())
    assert.equal(screen.identity.program, "ZZ_TEICH")
    assert.equal(screen.identity.title, "Am Teich")
    assert.equal(screen.message, undefined)
    assert.deepEqual(
      screen.elements.map(element => element.kind),
      [ScreenElementKind.label, ScreenElementKind.other(DyntElementType.unknown(200)), ScreenElementKind.label]
    )
    assert.deepEqual(
      screen.labels.map(label => label.text),
      ["Enten", "Gänse"]
    )
    const diagnostics = screen.diagnostics
    assert.equal(diagnostics.stoppedAtomWalks, 1)
    assert.equal(diagnostics.unknownItems, 1)
    assert.equal(diagnostics.codec.atoms.unknownElementTypes, 1)
    assert.equal(diagnostics.itemWalkStop?.itemIndex, 6)
    assert.ok(!diagnostics.readPastSessionDrop)
    assert.ok(!diagnostics.isClean)
  })

  /** A message the session drops for a stopped walk is still read up to the stop, error bodies too */
  test("readPastSessionDrop", () => {
    const machine = new SessionMachine(Fixtures.identity, Fixtures.terminal)
    machine.start()
    const items = concatBytes(
      textItem(ApplItem.stSystemInfo("dynproName"), utf8("ZZ_TEICH")),
      Fixtures.atomItem(Uint8Array.of(0x00, 0x40, 0x00, 0x00, 130)), // not-protocol: an atom that runs past its item
      textItem(ApplItem.varInfo("sessionTitle"), utf8("Nach dem Riss"))
    )
    const header = new DiagHeader({
      mode: 0,
      comFlag: 0,
      modeStat: 0,
      errNo: 0,
      msgType: 0,
      msgInfo: 0,
      msgRC: 0,
      compress: CompressField.uncompressed
    })
    const dropped = machine.receive({ kind: "payload", payload: concatBytes(header.bytes, items) }).message
    assert.ok(dropped !== undefined)
    if (!(dropped.content.kind === "notDecoded" && dropped.content.value.kind === "items")) {
      assert.fail(`the session drops a message whose atom walk stops: ${dropped.description}`)
    }
    const screen = Screen.fromMessage(dropped)
    assert.equal(screen.identity.program, "ZZ_TEICH")
    assert.equal(screen.identity.title, "Nach dem Riss")
    assert.ok(screen.diagnostics.readPastSessionDrop)
    assert.equal(screen.diagnostics.stoppedAtomWalks, 1)
    assert.ok(!screen.isServerError)

    // A server error whose items after the text stop the same way.
    const errorHeader = new DiagHeader({
      mode: 0,
      comFlag: ComFlag.eoc,
      modeStat: 0,
      errNo: 1,
      msgType: 0,
      msgInfo: 0,
      msgRC: 0,
      compress: CompressField.uncompressed
    })
    const text = utf16("Quak!", false)
    const error = machine.receive({ kind: "payload", payload: concatBytes(errorHeader.bytes, text, [0x0c], items) }).message
    assert.ok(error !== undefined)
    const errorScreen = Screen.fromMessage(error)
    assert.ok(errorScreen.isServerError)
    assert.equal(errorScreen.identity.program, "ZZ_TEICH")

    // No items at all: an SNC frame stays dropped.
    const snc = machine.receive({ kind: "payload", payload: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 2) }).message
    assert.ok(snc !== undefined)
    throwsInfo(() => Screen.fromMessage(snc), ScreenDecodingError, { kind: "notDecoded", value: { kind: "snc" } })
  })
})
