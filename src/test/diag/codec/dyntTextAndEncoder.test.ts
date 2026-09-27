// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DyntTextAndEncoderTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  DyntAtomEncoder,
  DyntAtomEncodingError,
  DyntAtomHeader,
  DyntAttributes,
  DyntDialogFlags,
  DyntElementType,
  DyntField,
  DyntText,
  DyntTextError,
  INT_MAX,
  byteRange,
  type DyntAtom,
  type DyntTabstripString,
  type KnownDyntElementKind
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo, written } from "../../support/codecTestSupport.js"
import { ZZScreen, field1Content, field2Content, rawAtom, tabstripContent, u16BE, walkAtoms } from "../../support/dyntTestSupport.js"

describe("DYNT text on demand", () => {
  const utf8 = 4110

  function first(value: Uint8Array): DyntAtom {
    const atom = walkAtoms(value).atoms[0]
    assert.ok(atom)
    return atom
  }

  test("decodesUTF8TextOnlyWhenAsked", () => {
    const screen = ZZScreen.atoms
    const atoms = walkAtoms(screen).atoms
    assert.equal(DyntText.decode(atoms[0], screen, utf8), "Ducks in a row")
    assert.equal(DyntText.decode(atoms[1], screen, utf8), "QUACK")
    assert.equal(DyntText.decode(atoms[2], screen, utf8), "ZZDUCK-POND")
    assert.equal(DyntText.decode(atoms[3], screen, utf8), "<Propertybag/>")
    assert.equal(DyntText.decode(atoms[5], screen, utf8), "Sock drawer")
    assert.equal(DyntText.utf8CodePage, 4110)
  })

  test("multibyteText", () => {
    const label = ascii("Kaffeepegel ☕ 100 %")
    const value = rawAtom(132, { content: field2Content(label) })
    const atom = first(value)
    assert.equal(DyntText.decode(atom, value, utf8), "Kaffeepegel ☕ 100 %")
    if (atom.payload.kind === "field") assert.equal(atom.payload.value.dlen, label.length, "dlen counts bytes, not characters (R-DA-6)")
  })

  test("passwordFieldsAreNeverDecoded", () => {
    const hidden = ascii("duckduckgoose")
    for (const etype of [130, 121, 114, 127]) {
      const content =
        etype === 130 ? field2Content(hidden) : etype === 121 ? field1Content(hidden) : etype === 127 ? cat(u16BE(1), u16BE(1), hidden) : hidden
      const value = rawAtom(etype, { content, attr: 0x42 })
      const atom = first(value)
      assert.ok(atom.isPasswordField)
      throwsInfo(() => DyntText.decode(atom, value, utf8), DyntTextError, { kind: "passwordField" })
      throwsInfo(() => DyntText.decode(atom, value, 1100), DyntTextError, { kind: "passwordField" })
    }
  })

  test("otherCodePagesAreSpecGap18", () => {
    const value = rawAtom(114, { content: ascii("ZZTEAPOT") })
    const atom = first(value)
    // 1100, 4102 and 4103 decode: CodePageTextTests.
    for (const codePage of [0, 1160, 4109, 4111, 0xffffffff])
      throwsInfo(() => DyntText.decode(atom, value, codePage), DyntTextError, { kind: "specGap", issue: 18 })
  })

  test("invalidBytesAreNotRepaired", () => {
    for (const invalid of [[0xff], [0xc3], [0xe2, 0x98], [0xed, 0xa0, 0x80], [0x41, 0x80, 0x42]]) {
      const value = rawAtom(114, { content: invalid })
      const atom = first(value)
      throwsInfo(() => DyntText.decode(atom, value, utf8), DyntTextError, { kind: "invalidText" })
    }
  })

  test("partsAndMissingText", () => {
    const tab = rawAtom(116, { content: tabstripContent({ text: ascii("Biscuits"), functionCode: ascii("ZZBISCUIT"), id: ascii("TAB7") }) })
    const button = first(tab)
    assert.equal(DyntText.decode(button, tab, utf8, "text"), "Biscuits")
    assert.equal(DyntText.decode(button, tab, utf8, "functionCode"), "ZZBISCUIT")
    assert.equal(DyntText.decode(button, tab, utf8, "id"), "TAB7")

    const field = rawAtom(130, { content: field2Content(ascii("Nope")) })
    const fieldAtom = first(field)
    assert.ok(DyntText.range(fieldAtom, "functionCode") === undefined && DyntText.range(fieldAtom, "id") === undefined)
    throwsInfo(() => DyntText.decode(fieldAtom, field, utf8, "functionCode"), DyntTextError, { kind: "noText" })

    for (const value of [
      rawAtom(101, { content: ascii("opaque") }),
      rawAtom(115, { content: cat([0, 0, 0, 0, 0, 0], ascii("Nap")) }),
      rawAtom(130, { content: field2Content(ascii("Oops"), { dlen: 2 }) })
    ]) {
      const atom = first(value)
      throwsInfo(() => DyntText.decode(atom, value, utf8), DyntTextError, { kind: "noText" })
    }
  })

  test("anAtomFromAnotherValueIsOutOfRange", () => {
    const long = cat(rawAtom(101), rawAtom(114, { content: ascii("ZZFAR-AWAY") }))
    const atom = walkAtoms(long).atoms.at(-1)
    assert.ok(atom)
    throwsInfo(() => DyntText.decode(atom, long.slice(0, 20), utf8), DyntTextError, { kind: "outOfRange" })
  })
})

describe("DYNT atom encoder", () => {
  function header(kind: KnownDyntElementKind, attributes: DyntAttributes = DyntAttributes.yes3D): DyntAtomHeader {
    return new DyntAtomHeader({
      etype: DyntElementType.of(kind),
      dialogFlags: new DyntDialogFlags({ flag1: 4, flag2: 1 }),
      area: 2,
      block: 3,
      group: 5,
      row: 0x0102,
      col: 0x0304,
      attributes
    })
  }

  function handBuilt(etype: number, content: ArrayLike<number>, attr = 0x40): Uint8Array {
    return rawAtom(etype, { content, flags: [4, 1], area: 2, block: 3, group: 5, row: 0x0102, col: 0x0304, attr })
  }

  const noTabstrip = {
    vLength: 0,
    vHeight: 0,
    pageID: 0,
    functionCodeOffset: 0,
    textOffset: 0,
    idOffset: 0,
    text: new Uint8Array(0),
    functionCode: new Uint8Array(0),
    id: new Uint8Array(0)
  }

  test("rawAtomMatchesTheHandBuiltLayout", () => {
    const output = new ByteWriter()
    output.u8(0xaa)
    DyntAtomEncoder.appendAtom(header("icon0"), ascii("ZZ-ICON"), output)
    assert.deepEqual(output.toBytes(), cat([0xaa], handBuilt(112, ascii("ZZ-ICON"))))
  })

  test("typedEncodersMatchTheHandBuiltLayouts", () => {
    assert.deepEqual(
      written(output => DyntAtomEncoder.appendText(header("fname"), ascii("ZZSOCKS-LEFT"), output)),
      handBuilt(114, ascii("ZZSOCKS-LEFT"))
    )
    assert.deepEqual(
      written(output => DyntAtomEncoder.appendField(header("efield2"), { flag1: 0xabcd, mlen: 12, maxNrChars: 0x0203, text: ascii("Quack") }, output)),
      handBuilt(130, field2Content(ascii("Quack"), { flag1: 0xabcd, mlen: 12, maxNrChars: 0x0203 }))
    )
    assert.deepEqual(
      written(output => DyntAtomEncoder.appendField(header("keyword1_1"), { flag1: 0xab, mlen: 3, maxNrChars: 7, text: ascii("Moo") }, output)),
      handBuilt(123, field1Content(ascii("Moo"), { flag1: 0xab, mlen: 3, maxNrChars: 7 }))
    )
    const caption = ZZScreen.frameCaption
    assert.deepEqual(
      written(output => DyntAtomEncoder.appendFrame(header("frame1"), 4, 50, caption, output)),
      handBuilt(127, cat(u16BE(4), u16BE(50), ZZScreen.frameCaption))
    )
    assert.deepEqual(
      written(output =>
        DyntAtomEncoder.appendTabstripButton(
          header("tabstripButton"),
          {
            vLength: 12,
            vHeight: 1,
            pageID: 2,
            functionCodeOffset: 0x0102,
            textOffset: 0x0304,
            idOffset: 0x0506,
            text: ascii("Naps"),
            functionCode: ascii("ZZNAP"),
            id: ascii("N1")
          },
          output
        )
      ),
      handBuilt(116, tabstripContent({ text: ascii("Naps"), functionCode: ascii("ZZNAP"), id: ascii("N1") }))
    )
  })

  test("encodeThenWalkGivesTheFieldsBack", () => {
    const fieldHeader = header("ofield2", DyntAttributes.protected | DyntAttributes.intensify)
    const encoded = written(output => DyntAtomEncoder.appendField(fieldHeader, { flag1: 7, mlen: 8, maxNrChars: 9, text: ascii("Llama") }, output))
    const atom = walkAtoms(encoded).atoms[0]
    assert.ok(atom)
    assert.deepEqual(atom.header, fieldHeader)
    assert.deepEqual(atom.payload, {
      kind: "field",
      value: new DyntField({ form: "v2", flag1: 7, dlen: 5, mlen: 8, maxNrChars: 9, textRange: byteRange(19, 24) })
    })
  })

  test("refusalsAppendNothing", () => {
    const output = new ByteWriter()
    output.u8(0x77)
    throwsInfo(() => DyntAtomEncoder.appendText(header("efield2"), new Uint8Array(0), output), DyntAtomEncodingError, {
      kind: "wrongElementType",
      value: DyntElementType.of("efield2")
    })
    throwsInfo(
      () => DyntAtomEncoder.appendField(header("efield"), { mlen: 1, maxNrChars: 1, text: new Uint8Array(0) }, output),
      DyntAtomEncodingError,
      { kind: "wrongElementType", value: DyntElementType.of("efield") }
    )
    throwsInfo(() => DyntAtomEncoder.appendFrame(header("frame3"), 1, 1, new Uint8Array(0), output), DyntAtomEncodingError, {
      kind: "wrongElementType",
      value: DyntElementType.of("frame3")
    })
    throwsInfo(() => DyntAtomEncoder.appendTabstripButton(header("pushbutton2"), noTabstrip, output), DyntAtomEncodingError, {
      kind: "wrongElementType",
      value: DyntElementType.of("pushbutton2")
    })
    throwsInfo(
      () => DyntAtomEncoder.appendField(header("efield2"), { mlen: 1, maxNrChars: 1, text: repeated(0x41, 256) }, output),
      DyntAtomEncodingError,
      { kind: "textTooLong", length: 256 }
    )
    throwsInfo(
      () => DyntAtomEncoder.appendField(header("efield1"), { flag1: 0x100, mlen: 1, maxNrChars: 1, text: new Uint8Array(0) }, output),
      DyntAtomEncodingError,
      { kind: "flag1OutOfRange", value: 0x100 }
    )
    const cases: [DyntTabstripString, Uint8Array, Uint8Array, Uint8Array][] = [
      ["text", bytes(0x41, 0), bytes(), bytes()],
      ["functionCode", bytes(), bytes(0), bytes()],
      ["id", bytes(), bytes(), bytes(0x42, 0, 0x43)]
    ]
    for (const [part, text, functionCode, id] of cases)
      throwsInfo(
        () => DyntAtomEncoder.appendTabstripButton(header("tabstripButton"), { ...noTabstrip, text, functionCode, id }, output),
        DyntAtomEncodingError,
        { kind: "zeroByteInString", value: part }
      )
    assert.deepEqual(output.toBytes(), bytes(0x77))
  })

  test("atomLengthCap", () => {
    // 13 + 65 522 = 65 535 is the largest atom_length (PV-0602); one more byte is refused.
    let output = new ByteWriter()
    DyntAtomEncoder.appendAtom(header("icon0"), repeated(1, 65_522), output)
    const encoded = output.toBytes()
    assert.equal(encoded.length, 0xffff)
    assert.deepEqual(encoded.subarray(0, 2), bytes(0xff, 0xff))
    output = new ByteWriter()
    throwsInfo(() => DyntAtomEncoder.appendAtom(header("icon0"), repeated(1, 65_523), output), DyntAtomEncodingError, {
      kind: "atomTooLong",
      length: 65_536
    })
    throwsInfo(
      () => DyntAtomEncoder.appendTabstripButton(header("tabstripButton"), { ...noTabstrip, text: repeated(0x41, 65_511) }, output),
      DyntAtomEncodingError,
      { kind: "atomTooLong", length: 65_536 }
    )
    // Swift's `atomLength(payload: .max)` overflows Int; the port's largest exact length is 2^53 − 1.
    throwsInfo(() => DyntAtomEncoder.atomLength(Number.MAX_SAFE_INTEGER), DyntAtomEncodingError, { kind: "atomTooLong", length: INT_MAX })
    assert.equal(output.length, 0)
  })
})
