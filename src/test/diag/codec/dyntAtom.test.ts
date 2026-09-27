// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DyntAtomTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  CodecSpecGap,
  DyntAtomDiagnostics,
  DyntAtomWalkError,
  DyntAtomWalker,
  DyntAtoms,
  DyntAttributes,
  DyntDialogFlags,
  DyntElementType,
  DyntField,
  DyntFrame,
  DyntPayloadProblem,
  DyntPushButton,
  DyntRadioButton,
  DyntSpecGapError,
  DyntTabstripButton,
  applItemCarriesDyntAtoms,
  byteRange,
  type DyntAtom,
  type DyntFieldForm,
  type DyntFieldRole,
  type DyntTabstripString
} from "../../../diag/codec/index.js"
import { appl, appl4, ascii, cat, repeated, throwsInfo, walkItems } from "../../support/codecTestSupport.js"
import { ZZScreen, field1Content, field2Content, rawAtom, specifiedEtypes, tabstripContent, u16BE, walkAtoms } from "../../support/dyntTestSupport.js"

const raw = DyntElementType.rawValue
const known = (kind: Parameters<typeof DyntElementType.of>[0]) => DyntElementType.of(kind)

describe("DYNT element types", () => {
  test("theThirtyOneTypes", () => {
    const values = DyntElementType.known.map(raw)
    const expected: number[] = []
    for (let value = 101; value <= 109; value++) expected.push(value)
    for (let value = 111; value <= 132; value++) expected.push(value)
    assert.deepEqual(values, expected)
    assert.equal(DyntElementType.known.length, 31)
    assert.equal(new Set(DyntElementType.known.map(type => type.kind)).size, 31)
    for (const type of DyntElementType.known) {
      assert.ok(DyntElementType.isKnown(type))
      assert.deepEqual(DyntElementType.fromRaw(raw(type)), type)
      assert.ok(DyntElementType.name(type)?.startsWith("DIAG_DGOTYP_"))
    }
    assert.equal(new Set(DyntElementType.known.map(DyntElementType.name)).size, 31, "names are distinct")
  })

  test("namesAsTheSourcesWriteThem", () => {
    const names: Record<number, string> = {
      101: "EFIELD",
      102: "OFIELD",
      103: "KEYWORD",
      104: "CHECKBUTTON_4",
      105: "RADIOBUTTON_0",
      106: "PUSHBUTTON_3",
      107: "FRAME_3",
      108: "LOOP_6",
      109: "SUBSCREEN",
      111: "PROPERTY",
      112: "ICON_0",
      113: "PUSHBUTTON_1",
      114: "FNAME",
      115: "PUSHBUTTON_2",
      116: "TABSTRIP_BUTTON",
      117: "COMBOBOX",
      118: "CHECKBUTTON_1",
      119: "RADIOBUTTON_1",
      120: "XMLPROP",
      121: "EFIELD_1",
      122: "OFIELD_1",
      123: "KEYWORD_1_1",
      124: "CHECKBUTTON_2",
      125: "RADIOBUTTON__0",
      126: "COMBOBOX_1",
      127: "FRAME_1",
      128: "CHECKBUTTON_3",
      129: "RADIOBUTTON_3",
      130: "EFIELD_2",
      131: "OFIELD_2",
      132: "KEYWORD_2"
    }
    for (const [value, name] of Object.entries(names)) assert.equal(DyntElementType.name(DyntElementType.fromRaw(Number(value))), "DIAG_DGOTYP_" + name)
  })

  test("everyByteRoundTripsAndUnknownValuesAreKept", () => {
    for (let byte = 0; byte <= 0xff; byte++) {
      const type = DyntElementType.fromRaw(byte)
      assert.equal(raw(type), byte)
      const inTable = byte >= 101 && byte <= 132 && byte !== 110
      assert.equal(DyntElementType.isKnown(type), inTable)
      assert.equal(DyntElementType.name(type) !== undefined, inTable)
      if (!inTable) assert.deepEqual(type, DyntElementType.unknown(byte))
    }
    // 110 is the one gap in the table.
    assert.deepEqual(DyntElementType.fromRaw(110), DyntElementType.unknown(110))
  })

  test("aNonCanonicalUnknownBehavesLikeItsKnownType", () => {
    const fname = DyntElementType.unknown(114)
    assert.ok(!DyntElementType.isKnown(fname))
    assert.equal(raw(fname), 114)
    assert.equal(DyntElementType.name(fname), "DIAG_DGOTYP_FNAME")
    assert.ok(DyntElementType.isChildMetadata(fname))
    assert.equal(DyntElementType.fieldForm(DyntElementType.unknown(130)), "v2")
    assert.equal(DyntElementType.fieldRole(DyntElementType.unknown(123)), "label")
    assert.equal(DyntElementType.name(DyntElementType.unknown(110)), undefined)
  })

  test("rolesFormsAndChildren", () => {
    const roles: Record<string, DyntFieldRole> = {
      efield: "editable",
      efield1: "editable",
      efield2: "editable",
      ofield: "display",
      ofield1: "display",
      ofield2: "display",
      keyword: "label",
      keyword1_1: "label",
      keyword2: "label"
    }
    const forms: Record<string, DyntFieldForm> = { efield1: "v1", ofield1: "v1", keyword1_1: "v1", efield2: "v2", ofield2: "v2", keyword2: "v2" }
    for (const type of [...DyntElementType.known, DyntElementType.unknown(0), DyntElementType.unknown(255)]) {
      const key = type.kind === "unknown" ? "" : type.kind
      assert.equal(DyntElementType.fieldRole(type), roles[key], JSON.stringify(type))
      assert.equal(DyntElementType.fieldForm(type), forms[key], JSON.stringify(type))
      assert.equal(DyntElementType.isChildMetadata(type), type.kind === "fname" || type.kind === "xmlprop", JSON.stringify(type))
    }
  })
})

describe("DYNT attributes and dialog flags", () => {
  test("masksAndNames", () => {
    assert.deepEqual(
      DyntAttributes.named.map(entry => entry.attribute),
      [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]
    )
    assert.deepEqual(
      DyntAttributes.named.map(entry => entry.name),
      ["PROTECTED", "INVISIBLE", "INTENSIFY", "JUSTRIGHT", "MATCHCODE", "PROPFONT", "YES3D", "COMBOSTYLE"]
    )
    assert.deepEqual(DyntAttributes.names(DyntAttributes.protected | DyntAttributes.propFont), ["PROTECTED", "PROPFONT"])
    assert.deepEqual(DyntAttributes.names(0x42), ["INVISIBLE", "YES3D"])
    assert.deepEqual(DyntAttributes.names(0), [])
  })

  test("everyByteNamesEachSetBitOnce", () => {
    for (let byte = 0; byte <= 0xff; byte++) {
      let bits = 0
      for (let value = byte; value !== 0; value >>= 1) bits += value & 1
      assert.equal(DyntAttributes.names(byte).length, bits)
      assert.equal(DyntAttributes.isPasswordField(byte), (byte & 0x02) !== 0, "INVISIBLE marks a password field (IMPL-DA-1)")
    }
  })

  test("dialogFlagSemanticsAreSpecGap34", () => {
    const flags = new DyntDialogFlags({ flag1: 4, flag2: 1 })
    throwsInfo(() => flags.isChanged(), DyntSpecGapError, { kind: "specGap", issue: 34 })
    throwsInfo(() => flags.markedChanged(), DyntSpecGapError, { kind: "specGap", issue: 34 })
    assert.equal(CodecSpecGap.dyntDialogFlags, 34)
    assert.equal(CodecSpecGap.dyntButtonStrings, 35)
    assert.equal(CodecSpecGap.dyntDlenMismatch, 36)
    assert.equal(CodecSpecGap.dyntMalformedPayload, 38)
  })

  test("theCarrierPairs", () => {
    assert.ok(applItemCarriesDyntAtoms(ApplItem.of(0x09, 0x02)))
    assert.ok(applItemCarriesDyntAtoms(ApplItem.of(0x09, 0x10)))
    for (let sid = 0; sid <= 0xff; sid++) if (sid !== 0x02 && sid !== 0x10) assert.ok(!applItemCarriesDyntAtoms(ApplItem.of(0x09, sid)))
    assert.ok(!applItemCarriesDyntAtoms(ApplItem.of(0x05, 0x02)))
    assert.ok(!applItemCarriesDyntAtoms(ApplItem.of(0x42, 0x02)))
  })
})

describe("DYNT atom walker", () => {
  test("emptyValue", () => {
    const result = walkAtoms(new Uint8Array(0))
    assert.ok(result.atoms.length === 0 && result.error === undefined)
    assert.deepEqual(result.diagnostics, new DyntAtomDiagnostics())
  })

  test("everyHeaderField", () => {
    const input = rawAtom(107, { content: [0xee], flags: [0xa1, 0xb2], area: 0xc3, block: 0xd4, group: 0xe5, row: 0xabcd, col: 0x1234, attr: 0x5d })
    const atom = walkAtoms(input).atoms[0]
    assert.ok(atom)
    assert.ok(atom.index === 1 && atom.offset === 0 && atom.length === 14)
    assert.deepEqual(atom.dialogFlags, new DyntDialogFlags({ flag1: 0xa1, flag2: 0xb2 }))
    assert.deepEqual(atom.etype, known("frame3"))
    assert.ok(atom.area === 0xc3 && atom.block === 0xd4 && atom.group === 0xe5)
    assert.ok(atom.row === 0xabcd && atom.col === 0x1234, "row and col are u16 BE (PV-0610, PV-0611)")
    assert.equal(atom.attributes, 0x5d)
    assert.deepEqual(atom.contentRange, byteRange(13, 14))
    assert.equal(atom.endOffset, 14)
    assert.deepEqual(atom.payload, { kind: "opaque" })
    assert.ok(atom.textRange === undefined && atom.parentIndex === undefined && !atom.isOrphanChild && !atom.isPasswordField)
  })

  test("headerOnlyAtom", () => {
    const result = walkAtoms(rawAtom(101))
    const atom = result.atoms[0]
    assert.ok(atom)
    assert.ok(result.error === undefined && atom.length === 13 && atom.contentRange.isEmpty)
  })

  test("truncatedInsideTheLengthField", () => {
    const result = walkAtoms(cat(rawAtom(101), [0x00]))
    assert.equal(result.atoms.length, 1)
    assert.deepEqual(result.error?.info, { kind: "truncated", atomIndex: 2, atomOffset: 13, part: "length" })
  })

  test("badAtomLengthComesBeforeTruncation", () => {
    // Step 3 before step 4: a declared length below 13 is bad-atom-length even when the rest of the
    // atom is missing too.
    for (const length of [0, 1, 2, 12]) {
      const result = walkAtoms(u16BE(length))
      assert.deepEqual(result.error?.info, { kind: "badAtomLength", length, atomIndex: 1, atomOffset: 0 })
      assert.ok(result.error?.atomIndex === 1 && result.error?.atomOffset === 0)
    }
  })

  test("truncatedAtom", () => {
    const whole = rawAtom(114, { content: ascii("ZZSOCKS") })
    for (let cut = 2; cut < whole.length; cut++)
      assert.deepEqual(walkAtoms(whole.slice(0, cut)).error?.info, { kind: "truncated", atomIndex: 1, atomOffset: 0, part: "atom" }, `cut at ${cut}`)
    // The largest declaration a u16 allows, with far fewer bytes present.
    assert.deepEqual(walkAtoms(rawAtom(101, { declaredLength: 0xffff })).error?.info, { kind: "truncated", atomIndex: 1, atomOffset: 0, part: "atom" })
  })

  test("atomsBeforeAnErrorCountAndErrorsAreSticky", () => {
    const input = cat(rawAtom(101), rawAtom(102), u16BE(5))
    const walker = new DyntAtomWalker()
    assert.equal(walker.next(input)?.index, 1)
    assert.equal(walker.next(input)?.index, 2)
    const error = { kind: "badAtomLength", length: 5, atomIndex: 3, atomOffset: 26 } as const
    throwsInfo(() => walker.next(input), DyntAtomWalkError, error)
    throwsInfo(() => walker.next(input), DyntAtomWalkError, error)
    assert.ok(walker.atomCount === 2 && walker.offset === 26)
    assert.deepEqual(walker.error?.info, error)
    const truncated = new DyntAtomWalkError({ kind: "truncated", atomIndex: 4, atomOffset: 9, part: "atom" })
    assert.ok(truncated.atomIndex === 4 && truncated.atomOffset === 9)
  })

  test("aMaximalAtom", () => {
    // atom_length 0xFFFF: the largest atom, 65 522 payload bytes.
    const content = repeated(0x5a, 0xffff - 13)
    const result = walkAtoms(rawAtom(120, { content }))
    const atom = result.atoms[0]
    assert.ok(atom)
    assert.ok(result.error === undefined && atom.length === 0xffff)
    assert.deepEqual(atom.textRange, byteRange(13, 0xffff))
  })

  test("childrenBelongToThePrecedingAtom", () => {
    const result = walkAtoms(ZZScreen.atoms)
    assert.equal(result.error, undefined)
    assert.deepEqual(
      result.atoms.map(atom => atom.etype),
      [known("keyword2"), known("efield2"), known("fname"), known("xmlprop"), known("efield2"), known("frame1")]
    )
    assert.deepEqual(
      result.atoms.map(atom => atom.parentIndex),
      [undefined, undefined, 2, 2, undefined, undefined]
    )
    assert.deepEqual(
      result.atoms.map(atom => atom.isPasswordField),
      [false, false, false, false, true, false]
    )
    assert.ok(result.diagnostics.isClean && result.diagnostics.orphanChildren === 0)
  })

  test("orphanChildrenAreKeptAndCounted", () => {
    const input = cat(
      rawAtom(114, { content: ascii("ZZORPHAN-FIELD") }),
      rawAtom(120, { content: ascii("<Lonely/>") }),
      rawAtom(103),
      rawAtom(114, { content: ascii("ZZADOPTED") })
    )
    const result = walkAtoms(input)
    assert.ok(result.error === undefined && result.atoms.length === 4)
    assert.deepEqual(
      result.atoms.map(atom => atom.parentIndex),
      [undefined, undefined, undefined, 3]
    )
    assert.deepEqual(
      result.atoms.map(atom => atom.isOrphanChild),
      [true, true, false, false]
    )
    assert.ok(result.diagnostics.orphanChildren === 2 && !result.diagnostics.isClean)
  })

  test("arrayAndSpanWalksAgree", () => {
    const walker = new DyntAtomWalker()
    const atoms: DyntAtom[] = []
    const screen = ZZScreen.atoms
    for (let atom = walker.next(screen); atom !== undefined; atom = walker.next(screen)) atoms.push(atom)
    assert.deepEqual(atoms, DyntAtoms.walk(screen.subarray(0)).atoms)
    assert.deepEqual(walker.diagnostics, DyntAtoms.walk(screen).diagnostics)
    assert.equal(walker.next(screen), undefined, "the end stays the end")
  })
})

describe("DYNT payloads", () => {
  test("textAtoms", () => {
    const name = ascii("ZZCOFFEE-REFILL")
    const result = walkAtoms(cat(rawAtom(114, { content: name }), rawAtom(120, { content: [] })))
    assert.deepEqual(result.atoms[0].payload, { kind: "text", value: byteRange(13, 13 + name.length) })
    assert.deepEqual(result.atoms[1].payload, { kind: "text", value: byteRange(41, 41) }, "an empty XMLPROP is an empty text")
    assert.deepEqual(result.atoms[0].textRange, byteRange(13, 28))
  })

  test("field2", () => {
    const text = ascii("Rubber duck on duty")
    const atom = walkAtoms(rawAtom(130, { content: field2Content(text, { flag1: 0xabcd, mlen: 30, maxNrChars: 0x0102 }) })).atoms[0]
    assert.ok(atom)
    const expected = new DyntField({ form: "v2", flag1: 0xabcd, dlen: text.length, mlen: 30, maxNrChars: 0x0102, textRange: byteRange(19, 19 + text.length) })
    assert.deepEqual(atom.payload, { kind: "field", value: expected })
    assert.deepEqual(atom.textRange, expected.textRange)
    assert.equal(DyntElementType.fieldRole(atom.etype), "editable")
  })

  test("field1HasAOneByteFlag", () => {
    const text = ascii("ZZDUCK")
    const atom = walkAtoms(rawAtom(123, { content: field1Content(text, { flag1: 0xab, mlen: 6, maxNrChars: 0x0a0b }) })).atoms[0]
    assert.ok(atom)
    assert.deepEqual(atom.payload, {
      kind: "field",
      value: new DyntField({ form: "v1", flag1: 0xab, dlen: 6, mlen: 6, maxNrChars: 0x0a0b, textRange: byteRange(18, 24) })
    })
  })

  test("dlenMismatchKeepsThePayloadOpaqueAndTheWalkGoesOn", () => {
    const text = ascii("Teapot")
    const input = cat(
      rawAtom(131, { content: field2Content(text, { dlen: 5 }) }),
      rawAtom(121, { content: field1Content(text, { dlen: 7 }) }),
      rawAtom(101)
    )
    const result = walkAtoms(input)
    assert.ok(result.error === undefined && result.atoms.length === 3)
    assert.deepEqual(result.atoms[0].payload, { kind: "undecodable", value: { kind: "dlenMismatch", dlen: 5, remaining: 6 } })
    assert.deepEqual(result.atoms[1].payload, { kind: "undecodable", value: { kind: "dlenMismatch", dlen: 7, remaining: 6 } })
    assert.equal(result.atoms[0].textRange, undefined)
    assert.equal(DyntPayloadProblem.specGapIssue({ kind: "dlenMismatch", dlen: 5, remaining: 6 }), 36)
    assert.ok(result.diagnostics.dlenMismatches === 2 && result.diagnostics.malformedPayloads === 0)
  })

  test("shortContentForEveryFixedLayout", () => {
    const cases: [number, number][] = [
      [121, 5],
      [122, 5],
      [123, 5],
      [130, 6],
      [131, 6],
      [132, 6],
      [127, 4],
      [116, 9],
      [115, 6],
      [129, 10]
    ]
    for (const [etype, needed] of cases) {
      for (let available = 0; available < needed; available++) {
        const atom = walkAtoms(rawAtom(etype, { content: repeated(0, available) })).atoms[0]
        assert.deepEqual(atom?.payload, { kind: "undecodable", value: { kind: "shortContent", needed, available } }, `etype ${etype}, ${available} bytes`)
        assert.equal(DyntPayloadProblem.specGapIssue({ kind: "shortContent", needed, available }), 38)
      }
    }
    assert.equal(walkAtoms(rawAtom(130, { content: [0, 0] })).diagnostics.malformedPayloads, 1)
  })

  test("frame", () => {
    const atom = walkAtoms(rawAtom(127, { content: cat(u16BE(0x0102), u16BE(0x0304), ZZScreen.frameCaption) })).atoms[0]
    assert.ok(atom)
    assert.deepEqual(atom.payload, {
      kind: "frame",
      value: new DyntFrame({ drows: 0x0102, dcols: 0x0304, textRange: byteRange(17, 17 + ZZScreen.frameCaption.length) })
    })
  })

  test("tabstripButton", () => {
    const content = tabstripContent({ text: ascii("Snacks"), functionCode: ascii("ZZSNACK"), id: ascii("T1"), pageID: 7 })
    const atom = walkAtoms(rawAtom(116, { content: cat(content, [0xee, 0xee]) })).atoms[0]
    assert.ok(atom)
    const expected = new DyntTabstripButton({
      vLength: 12,
      vHeight: 1,
      pageID: 7,
      functionCodeOffset: 0x0102,
      textOffset: 0x0304,
      idOffset: 0x0506,
      textRange: byteRange(22, 28),
      functionCodeRange: byteRange(29, 36),
      idRange: byteRange(37, 39),
      trailingByteCount: 2
    })
    assert.deepEqual(atom.payload, { kind: "tabstripButton", value: expected })
    assert.deepEqual(atom.textRange, byteRange(22, 28))
    const empty = walkAtoms(rawAtom(116, { content: tabstripContent({ text: [], functionCode: [], id: [] }) })).atoms[0]
    assert.ok(empty)
    if (empty.payload.kind !== "tabstripButton") assert.fail("empty strings are valid")
    const button = empty.payload.value
    assert.ok(button.textRange.isEmpty && button.functionCodeRange.isEmpty && button.idRange.isEmpty && button.trailingByteCount === 0)
  })

  test("unterminatedTabstripStrings", () => {
    const fixed = [1, 1, 1, 0, 0, 0, 0, 0, 0]
    const cases: [Uint8Array, DyntTabstripString][] = [
      [ascii("Cat"), "text"],
      [cat(ascii("Cat"), [0], ascii("ZZMEOW")), "functionCode"],
      [cat(ascii("Cat"), [0, 0], ascii("P9")), "id"]
    ]
    for (const [strings, missing] of cases) {
      const result = walkAtoms(rawAtom(116, { content: cat(fixed, strings) }))
      assert.deepEqual(result.atoms[0]?.payload, { kind: "undecodable", value: { kind: "unterminatedString", value: missing } })
      assert.equal(DyntPayloadProblem.specGapIssue({ kind: "unterminatedString", value: missing }), 38)
      assert.equal(result.diagnostics.malformedPayloads, 1)
    }
  })

  test("pushAndRadioButtonsKeepTheirStringsOpaque", () => {
    const push = walkAtoms(rawAtom(115, { content: cat([9, 1], u16BE(0x0a0b), u16BE(0x0c0d), ascii("Nap"), [0], ascii("ZZNAP"), [0]) })).atoms[0]
    assert.ok(push)
    assert.deepEqual(push.payload, {
      kind: "pushButton",
      value: new DyntPushButton({ vLength: 9, vHeight: 1, functionCodeOffset: 0x0a0b, textOffset: 0x0c0d, stringsRange: byteRange(19, 29) })
    })
    assert.equal(push.textRange, undefined)
    if (push.payload.kind === "pushButton") {
      const button = push.payload.value
      throwsInfo(() => button.textRange(), DyntSpecGapError, { kind: "specGap", issue: 35 })
    }
    const radio = walkAtoms(rawAtom(129, { content: cat([1], u16BE(0x0203), u16BE(0x0405), [6], u16BE(0x0708), u16BE(0x090a), ascii("Tea")) })).atoms[0]
    assert.ok(radio)
    assert.deepEqual(radio.payload, {
      kind: "radioButton",
      value: new DyntRadioButton({
        button: 1,
        visibleLabelLength: 0x0203,
        eventIDOffset: 0x0405,
        eventIDLength: 6,
        textOffset: 0x0708,
        textLength: 0x090a,
        restRange: byteRange(23, 26)
      })
    })
    if (radio.payload.kind === "radioButton") {
      const button = radio.payload.value
      throwsInfo(() => button.textRange(), DyntSpecGapError, { kind: "specGap", issue: 35 })
    }
    const result = walkAtoms(cat(rawAtom(115, { content: [0, 0, 0, 0, 0, 0] }), rawAtom(129, { content: repeated(0, 10) })))
    assert.ok(result.diagnostics.undecodedButtonStrings === 2 && result.diagnostics.isClean)
  })

  test("everyOtherElementTypeIsOpaque", () => {
    for (let byte = 0; byte <= 0xff; byte++) {
      if (specifiedEtypes.has(byte)) continue
      const result = walkAtoms(rawAtom(byte, { content: ascii("Mystery meat") }))
      assert.deepEqual(result.atoms[0]?.payload, { kind: "opaque" }, `etype ${byte}`)
      assert.equal(result.diagnostics.opaquePayloads, 1)
      const inTable = byte >= 101 && byte <= 132 && byte !== 110
      assert.equal(result.diagnostics.unknownElementTypes, inTable ? 0 : 1)
    }
  })

  test("applItemsCarryAtomsUnderBothCarriers", () => {
    // An APPL4 DYNT_ATOM and an APPL DYNT_TABSTRIP_BUTTONS, walked end to end (IMPL-IT-9).
    const atoms = ZZScreen.atoms
    const tab = rawAtom(116, { content: tabstripContent({ text: ascii("Naps"), functionCode: ascii("ZZNAP"), id: ascii("N") }) })
    const items = cat(appl4(0x09, 0x02, atoms), appl(0x09, 0x10, tab), appl(0x09, 0x01, [0, 1]), [0x0c])
    const walked = walkItems(items)
    assert.equal(walked.error, undefined)
    const carriers = walked.items.filter(item => item.appl !== undefined && applItemCarriesDyntAtoms(item.appl))
    assert.equal(carriers.length, 2)
    const first = DyntAtoms.walk(carriers[0].valueRange.of(items))
    assert.ok(first.error === undefined && first.atoms.length === 6)
    const second = DyntAtoms.walk(carriers[1].valueRange.of(items))
    assert.deepEqual(second.atoms[0]?.etype, known("tabstripButton"))
  })
})
