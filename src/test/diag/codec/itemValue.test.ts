// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ItemValueTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplSID,
  CodepageDiagGUI,
  DialogStepNumber,
  DiagItemType,
  ItemPayloadError,
  KernelVersion,
  ProtocolVersion,
  SBAValue,
  SESValue,
  SFEValue,
  SLCValue,
  SimpleItemValue,
  SupportBit,
  SupportBits,
  SystemInfoNumber,
  SystemInfoText,
  UserConnect,
  byteRange
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo, u32BE, written } from "../../support/codecTestSupport.js"

describe("Simple item values", () => {
  test("sesSplitsSixteenBytesAndIgnoresTheFiller", () => {
    const value = bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0xee, 0xee, 15, 16)
    const ses = SESValue.decode(value)
    assert.deepEqual(
      ses,
      new SESValue({
        eventArray: 1,
        eventID1: 2,
        eventID2: 3,
        eventID3: 4,
        eventID4: 5,
        eventID5: 6,
        screenFlag: 7,
        modalNumber: 8,
        xPos: 9,
        yPos: 10,
        imode: 11,
        flag1: 12,
        dimRow: 15,
        dimCol: 16
      })
    )
    assert.deepEqual(
      written(output => ses.append(output)),
      bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 0, 15, 16),
      "R-IT-12: the filler is written as 00 00"
    )
    assert.equal(SESValue.size, 16)
    assert.deepEqual(
      written(output => new SESValue().append(output)),
      repeated(0, 16)
    )
  })

  test("sfeSbaSlc", () => {
    assert.deepEqual(SFEValue.decode(bytes(1, 2, 3)), new SFEValue({ format: 1, color: 2, extended: 3 }))
    assert.deepEqual(SBAValue.decode(bytes(7, 9)), new SBAValue({ y: 7, x: 9 }))
    assert.deepEqual(SLCValue.decode(bytes(0x01, 0x02)), new SLCValue({ fieldLength: 258 }), "u16 BE, not 513")
    const output = new ByteWriter()
    new SFEValue({ format: 1, color: 2, extended: 3 }).append(output)
    new SBAValue({ y: 7, x: 9 }).append(output)
    new SLCValue({ fieldLength: 0xabcd }).append(output)
    assert.deepEqual(output.toBytes(), bytes(1, 2, 3, 7, 9, 0xab, 0xcd))
    assert.ok(SFEValue.size === 3 && SBAValue.size === 2 && SLCValue.size === 2)
  })

  test("fixedSizesAreExact", () => {
    throwsInfo(() => SESValue.decode(repeated(0, 15)), ItemPayloadError, { kind: "truncated", needed: 16, available: 15 })
    throwsInfo(() => SESValue.decode(repeated(0, 17)), ItemPayloadError, { kind: "overlong", expected: 16, actual: 17 })
    throwsInfo(() => SFEValue.decode(bytes(1, 2)), ItemPayloadError, { kind: "truncated", needed: 3, available: 2 })
    throwsInfo(() => SBAValue.decode(bytes(1)), ItemPayloadError, { kind: "truncated", needed: 2, available: 1 })
    throwsInfo(() => SLCValue.decode(bytes(1, 2, 3)), ItemPayloadError, { kind: "overlong", expected: 2, actual: 3 })
  })

  test("wholeItems", () => {
    assert.deepEqual(SimpleItemValue.decodeItem(bytes(0x0b, 3, 4)), SimpleItemValue.sba(new SBAValue({ y: 3, x: 4 })))
    assert.deepEqual(SimpleItemValue.decodeItem(bytes(0x0a, 3, 4, 5)), SimpleItemValue.sfe(new SFEValue({ format: 3, color: 4, extended: 5 })))
    assert.deepEqual(SimpleItemValue.decodeItem(bytes(0x13, 0, 40)), SimpleItemValue.slc(new SLCValue({ fieldLength: 40 })))
    assert.deepEqual(SimpleItemValue.decodeItem(bytes(0x0c)), SimpleItemValue.eom)
    assert.deepEqual(SimpleItemValue.decodeItem(cat([0x01], repeated(0, 16))), SimpleItemValue.ses(new SESValue()))
    for (const value of [
      SimpleItemValue.eom,
      SimpleItemValue.sba(new SBAValue({ y: 1, x: 2 })),
      SimpleItemValue.ses(new SESValue({ flag1: 9 })),
      SimpleItemValue.sfe(new SFEValue({ format: 0, color: 1, extended: 2 })),
      SimpleItemValue.slc(new SLCValue({ fieldLength: 1 }))
    ]) {
      const item = written(output => SimpleItemValue.appendItem(value, output))
      assert.deepEqual(SimpleItemValue.decodeItem(item), value)
      assert.equal(item[0], DiagItemType.rawValue(SimpleItemValue.type(value)))
    }
  })

  test("unspecifiedLayoutsAreSpecGaps", () => {
    for (const type of ["ico", "tit", "diagMessage", "chl", "sba2"] as DiagItemType[])
      throwsInfo(() => SimpleItemValue.decode(type, new Uint8Array(0)), ItemPayloadError, { kind: "specGap", issue: 32 })
    throwsInfo(() => SimpleItemValue.decodeItem(bytes(0x08)), ItemPayloadError, { kind: "specGap", issue: 30 })
    for (const type of ["appl", "appl4", "xmlblob"] as DiagItemType[])
      throwsInfo(() => SimpleItemValue.decode(type, new Uint8Array(0)), ItemPayloadError, {
        kind: "notASimpleItem",
        typeByte: DiagItemType.rawValue(type)
      })
    throwsInfo(() => SimpleItemValue.decodeItem(new Uint8Array(0)), ItemPayloadError, { kind: "notASimpleItem", typeByte: undefined })
    throwsInfo(() => SimpleItemValue.decodeItem(bytes(0x42)), ItemPayloadError, { kind: "notASimpleItem", typeByte: 0x42 })
    throwsInfo(() => SimpleItemValue.decodeItem(bytes(0x0c, 0x0c)), ItemPayloadError, { kind: "overlong", expected: 0, actual: 1 })
  })
})

describe("Session items", () => {
  test("connect", () => {
    const value = bytes(0x00, 0x01, 0x87, 0x68, 0x00, 0x00, 0x04, 0x4c, 0x00, 0x00, 0x13, 0x89)
    const connect = UserConnect.decode(value)
    assert.deepEqual(connect, new UserConnect({ protocolVersion: 100_200, codePage: 1100, wsType: 5001 }))
    assert.deepEqual(connect.bytes, value)
    assert.ok(ProtocolVersion.compressed === 100_200 && ProtocolVersion.uncompressed === 200)
    const short = value.slice(0, -1)
    throwsInfo(() => UserConnect.decode(short), ItemPayloadError, { kind: "truncated", needed: 12, available: 11 })
    throwsInfo(() => UserConnect.decode(cat(value, [0])), ItemPayloadError, { kind: "overlong", expected: 12, actual: 13 })
  })

  test("dialogStepNumber", () => {
    assert.equal(DialogStepNumber.decode(bytes(1, 2, 3, 4)).step, 0x01020304)
    assert.deepEqual(new DialogStepNumber(1).bytes, bytes(0, 0, 0, 1))
    assert.deepEqual(new DialogStepNumber(0xffffffff).bytes, bytes(0xff, 0xff, 0xff, 0xff))
    throwsInfo(() => DialogStepNumber.decode(bytes(0, 0, 1)), ItemPayloadError, { kind: "truncated", needed: 4, available: 3 })
  })

  test("supportBitNumbering", () => {
    // R-SE-5: bit N at byte N/8, mask 1 << (N mod 8).
    for (let number = 0; number < 256; number++) {
      const bit = SupportBit.fromNumber(number)
      assert.ok(bit)
      assert.ok(bit.byteIndex === Math.floor(number / 8) && bit.mask === 1 << number % 8)
      const bits = new SupportBits([bit])
      const expected = new Uint8Array(32)
      expected[Math.floor(number / 8)] = 1 << number % 8
      assert.deepEqual(bits.bytes, expected)
      assert.ok(bits.contains(bit))
      assert.deepEqual(bits.setBits, [bit])
      assert.deepEqual(SupportBits.decode(expected), bits)
    }
    assert.ok(SupportBit.fromNumber(-1) === undefined && SupportBit.fromNumber(256) === undefined)
    assert.equal(SupportBit.count, 256)
  })

  test("supportBitNames", () => {
    assert.ok(SupportBit.progressIndicator.name === "PROGRESS_INDICATOR" && SupportBit.progressIndicator.number === 0)
    assert.ok(SupportBit.imode.name === "SAPGUI_IMODE" && SupportBit.imode.number === 7)
    assert.ok(SupportBit.enableUTF8.name === "ENABLE_UTF8" && SupportBit.enableUTF8.byteIndex === 16 && SupportBit.enableUTF8.mask === 0x80)
    assert.ok(SupportBit.enableAPPL4.name === "ENABLE_APPL4" && SupportBit.enableAPPL4.byteIndex === 17 && SupportBit.enableAPPL4.mask === 0x20)
    assert.ok(SupportBit.dialogStepNumber.name === "DIALOG_STEP_NUMBER" && SupportBit.dialogStepNumber.byteIndex === 22)
    assert.equal(SupportBit.fromName("GROUPBOX_WITHOUT_BOTTOMLINE")?.number, 214, "the last named bit, Wireshark only")
    assert.equal(SupportBit.fromName("FIORI_TOOLBARS")?.number, 208)
    assert.equal(SupportBit.fromName("ZZ_TELEPORTER"), undefined)
    const named: string[] = []
    for (let number = 0; number < 256; number++) {
      const name = SupportBit.fromNumber(number)?.name
      if (name !== undefined) named.push(name)
    }
    assert.equal(named.length, 215, "bits 0-214 are named")
    assert.equal(new Set(named).size, 215, "names are unique")
    for (let number = 215; number < 256; number++) assert.equal(SupportBit.fromNumber(number)?.name, undefined)
    for (const name of named) assert.equal(SupportBit.fromName(name)?.name, name)
  })

  test("supportBitsSetAndClear", () => {
    const bits = new SupportBits()
    assert.ok(bits.setBits.length === 0)
    assert.deepEqual(bits.bytes, new Uint8Array(32))
    for (const bit of [
      SupportBit.progressIndicator,
      SupportBit.imode,
      SupportBit.enableUTF8,
      SupportBit.enableAPPL4,
      SupportBit.dialogStepNumber,
      SupportBit.fromNumber(255)!
    ])
      bits.insert(bit)
    assert.deepEqual(
      bits.setBits.map(bit => bit.number),
      [0, 7, 135, 141, 181, 255]
    )
    assert.deepEqual(
      bits.setNamedBits.map(bit => bit.number),
      [0, 7, 135, 141, 181]
    )
    assert.ok(bits.byte(0) === 0x81 && bits.byte(16) === 0x80 && bits.byte(17) === 0x20 && bits.byte(22) === 0x20 && bits.byte(31) === 0x80)
    bits.remove(SupportBit.imode)
    bits.remove(SupportBit.fromNumber(255)!)
    assert.deepEqual(
      bits.setBits.map(bit => bit.number),
      [0, 135, 141, 181]
    )
    assert.ok(!bits.contains(SupportBit.imode))
    assert.ok(SupportBit.compare(SupportBit.imode, SupportBit.enableUTF8) < 0)
    throwsInfo(() => SupportBits.decode(repeated(0, 31)), ItemPayloadError, { kind: "truncated", needed: 32, available: 31 })
    throwsInfo(() => SupportBits.decode(repeated(0, 33)), ItemPayloadError, { kind: "overlong", expected: 32, actual: 33 })
  })

  test("systemInfoText", () => {
    const value = cat(ascii("ZZDUCK"), [0, 0])
    assert.deepEqual(SystemInfoText.textRange(value), byteRange(0, 6), "R-SE-6: trailing zero bytes are stripped")
    assert.deepEqual(SystemInfoText.textRange(ascii("ZZ")), byteRange(0, 2))
    assert.deepEqual(SystemInfoText.textRange(bytes(0, 0)), byteRange(0, 0))
    assert.deepEqual(SystemInfoText.textRange(bytes(0x41, 0, 0x42)), byteRange(0, 3), "only trailing zeros are stripped")
    const texts = ApplSID.StSystemInfo.allCases.filter(SystemInfoText.isText)
    assert.deepEqual(texts, ["dbName", "cpuName", "tcode", "message", "client", "codepageAppServer"])
  })

  test("systemInfoNumbers", () => {
    assert.equal(SystemInfoNumber.decode(bytes(0x00, 0x01)), 1)
    assert.equal(SystemInfoNumber.decode(bytes(0x01, 0x02)), 258)
    throwsInfo(() => SystemInfoNumber.decode(bytes(1)), ItemPayloadError, { kind: "truncated", needed: 2, available: 1 })
    assert.deepEqual(ApplSID.StSystemInfo.allCases.filter(SystemInfoNumber.isNumber), ["modeNumber", "diagVersion", "imodeNumber"])
  })

  test("codepageDiagGUI", () => {
    const value = cat(u32BE(0x00001234), [2], ascii("4660"), [0], ascii("ZZ Emoji Plus"), [0])
    const codepage = CodepageDiagGUI.decode(value)
    assert.equal(codepage.codePage, 0x1234)
    assert.equal(codepage.minBytesPerCharacter, 2)
    assert.deepEqual(codepage.numberText.of(value), ascii("4660"))
    assert.deepEqual(codepage.description.of(value), ascii("ZZ Emoji Plus"))
    assert.equal(codepage.trailingByteCount, 0)
    assert.equal(CodepageDiagGUI.decode(cat(value, [9, 9])).trailingByteCount, 2)
    throwsInfo(() => CodepageDiagGUI.decode(u32BE(1)), ItemPayloadError, { kind: "truncated", needed: 5, available: 4 })
    throwsInfo(() => CodepageDiagGUI.decode(cat(u32BE(1), [1])), ItemPayloadError, { kind: "truncated", needed: 6, available: 5 })
    const oneString = cat(u32BE(1), [1], ascii("1"), [0], ascii("no terminator"))
    throwsInfo(() => CodepageDiagGUI.decode(oneString), ItemPayloadError, {
      kind: "truncated",
      needed: oneString.length + 1,
      available: oneString.length
    })
  })

  test("kernelVersion", () => {
    const value = cat(ascii("ZZDB 9"), [0], ascii("ZZK 42"), [0], ascii("7"), [0])
    const version = KernelVersion.decode(value)
    assert.deepEqual(version.databaseVersion.of(value), ascii("ZZDB 9"))
    assert.deepEqual(version.kernelVersion.of(value), ascii("ZZK 42"))
    assert.deepEqual(version.patchLevel.of(value), ascii("7"))
    assert.equal(version.trailingByteCount, 0)
    const short = value.slice(0, -1)
    assert.throws(() => KernelVersion.decode(short), ItemPayloadError)
    const empty = KernelVersion.decode(bytes(0, 0, 0, 0xaa))
    assert.ok(empty.databaseVersion.isEmpty && empty.kernelVersion.isEmpty && empty.patchLevel.isEmpty && empty.trailingByteCount === 1)
  })
})
