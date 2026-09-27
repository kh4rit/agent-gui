// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DyntTextAndEncoderTests.swift (MIT): the encoder suite.
// The "DYNT text on demand" suite (decodesUTF8TextOnlyWhenAsked, multibyteText,
// passwordFieldsAreNeverDecoded, otherCodePagesAreSpecGap18, invalidBytesAreNotRepaired,
// partsAndMissingText, anAtomFromAnotherValueIsOutOfRange) needs DyntText.swift (next wave).

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
  INT_MAX,
  byteRange,
  type DyntTabstripString,
  type KnownDyntElementKind
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo, written } from "../../support/codecTestSupport.js"
import { ZZScreen, field1Content, field2Content, rawAtom, tabstripContent, u16BE, walkAtoms } from "../../support/dyntTestSupport.js"

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
