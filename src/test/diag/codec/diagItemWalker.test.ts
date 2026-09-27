// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DiagItemWalkerTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  DiagItem,
  DiagItemEncoder,
  DiagItemEncodingError,
  DiagItemType,
  DiagItemWalkError,
  DiagItemWalker,
  byteRange,
  type DiagItemField
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { appl, appl4, ascii, bytes, cat, repeated, throwsInfo, walkItems, xmlblob } from "../../support/codecTestSupport.js"

describe("Item types", () => {
  test("theFourteenTypes", () => {
    assert.deepEqual(
      DiagItemType.allCases.map(DiagItemType.rawValue),
      [0x01, 0x02, 0x03, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x10, 0x11, 0x12, 0x13, 0x15]
    )
    assert.deepEqual(DiagItemType.allCases.map(DiagItemType.name), [
      "SES",
      "ICO",
      "TIT",
      "DiagMessage",
      "OKC",
      "CHL",
      "SFE",
      "SBA",
      "EOM",
      "APPL",
      "XMLBLOB",
      "APPL4",
      "SLC",
      "SBA2"
    ])
    for (const type of DiagItemType.allCases) {
      assert.equal(DiagItemType.typeByte(type), DiagItemType.rawValue(type))
      assert.equal(DiagItemType.fromRaw(DiagItemType.rawValue(type)), type)
    }
    // 0x04 is the APPL id ST_USER, but no item type (items.md, Item types).
    for (const byte of [0x00, 0x04, 0x05, 0x06, 0x0d, 0x0e, 0x0f, 0x14, 0x16, 0xff]) assert.equal(DiagItemType.fromRaw(byte), undefined)
  })

  test("sizesAndForms", () => {
    const sizes: Partial<Record<DiagItemType, number>> = {
      ses: 16,
      ico: 20,
      tit: 3,
      diagMessage: 76,
      chl: 22,
      sfe: 3,
      sba: 2,
      eom: 0,
      slc: 2,
      sba2: 36
    }
    for (const type of DiagItemType.allCases) {
      assert.equal(DiagItemType.simpleValueSize(type), sizes[type], DiagItemType.name(type))
      assert.equal(DiagItemType.isLengthPrefixed(type), ["appl", "appl4", "xmlblob"].includes(type))
      assert.equal(DiagItemType.carriesApplItem(type), ["appl", "appl4"].includes(type))
    }
    assert.equal(DiagItemType.simpleValueSize("okc"), undefined, "OKC's size is #30")
  })
})

describe("Item walker", () => {
  test("emptySequence", () => {
    const result = walkItems(new Uint8Array(0))
    assert.ok(result.items.length === 0 && result.error === undefined)
  })

  test("everySimpleTypeOfKnownSize", () => {
    const types: DiagItemType[] = ["ses", "ico", "tit", "diagMessage", "chl", "sfe", "sba", "eom", "slc", "sba2"]
    let sequence: Uint8Array = new Uint8Array(0)
    const expected: DiagItem[] = []
    types.forEach((type, index) => {
      const size = DiagItemType.simpleValueSize(type)!
      expected.push(new DiagItem({ index: index + 1, type, offset: sequence.length, valueRange: byteRange(sequence.length + 1, sequence.length + 1 + size) }))
      sequence = cat(sequence, [DiagItemType.rawValue(type)], repeated(0xa5, size))
    })
    const result = walkItems(sequence)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.items, expected)
    assert.ok(result.items.every(item => item.appl === undefined))
  })

  test("applAndAppl4", () => {
    const sequence = cat(appl(0x04, 0x26, [0, 0, 0, 1]), appl4(0x09, 0x02, [0x40, 0x41]), appl(0x0d, 0x01, []))
    const result = walkItems(sequence)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.items, [
      new DiagItem({ index: 1, type: "appl", offset: 0, valueRange: byteRange(5, 9), appl: ApplItem.stUser("dialogStepNumber") }),
      new DiagItem({ index: 2, type: "appl4", offset: 9, valueRange: byteRange(16, 18), appl: ApplItem.dynt("atom") }),
      new DiagItem({ index: 3, type: "appl", offset: 18, valueRange: byteRange(23, 23), appl: ApplItem.unknownID(0x0d, 0x01) })
    ])
    assert.ok(result.items[1].valueOffset === 16 && result.items[1].valueLength === 2 && result.items[1].endOffset === 18)
  })

  test("lengthsAreBigEndian", () => {
    assert.equal(walkItems(cat([0x10, 4, 2, 0x01, 0x00], repeated(0, 256))).items[0]?.valueLength, 256)
    assert.equal(walkItems(cat([0x12, 4, 2, 0, 0, 0x01, 0x00], repeated(0, 256))).items[0]?.valueLength, 256)
    assert.equal(walkItems(cat([0x11, 0, 0, 0x01, 0x00], repeated(0, 256))).items[0]?.valueLength, 256)
  })

  test("eomDoesNotEndTheWalk", () => {
    // R-IT-1: the sequence runs to the end of the input.
    const result = walkItems(cat([0x0c, 0x0c], xmlblob([7]), [0x0c]))
    assert.equal(result.error, undefined)
    assert.deepEqual(
      result.items.map(item => item.type),
      ["eom", "eom", "xmlblob", "eom"]
    )
  })

  test("truncationNamesTheField", () => {
    const truncated = (itemIndex: number, itemOffset: number, field: DiagItemField) => ({ kind: "truncated", itemIndex, itemOffset, field })
    const applItem = appl(0x04, 0x02, [1, 2, 3])
    const fields: DiagItemField[] = ["id", "sid", "length", "length", "value", "value", "value"]
    for (let count = 1; count < applItem.length; count++)
      assert.deepEqual(walkItems(applItem.slice(0, count)).error?.info, truncated(1, 0, fields[count - 1]))
    const appl4Item = appl4(0x09, 0x02, [1])
    const fields4: DiagItemField[] = ["id", "sid", "length", "length", "length", "length", "value"]
    for (let count = 1; count < appl4Item.length; count++)
      assert.deepEqual(walkItems(appl4Item.slice(0, count)).error?.info, truncated(1, 0, fields4[count - 1]))
    for (let count = 1; count <= 4; count++) assert.deepEqual(walkItems(xmlblob([9]).slice(0, count)).error?.info, truncated(1, 0, "length"))
    assert.deepEqual(walkItems(cat([0x01], repeated(0, 15))).error?.info, truncated(1, 0, "value"))
    const second = walkItems(cat(xmlblob([1]), [0x0b, 0x01]))
    assert.equal(second.items.length, 1)
    assert.deepEqual(second.error?.info, truncated(2, 6, "value"))
    assert.ok(second.error?.itemIndex === 2 && second.error?.itemOffset === 6)
  })

  test("hugeDeclaredLengthsAreTruncatedWithoutOverflow", () => {
    const value = { kind: "truncated", itemIndex: 1, itemOffset: 0, field: "value" }
    assert.deepEqual(walkItems(bytes(0x11, 0xff, 0xff, 0xff, 0xff, 0x00)).error?.info, value)
    assert.deepEqual(walkItems(bytes(0x12, 1, 1, 0xff, 0xff, 0xff, 0xff)).error?.info, value)
    assert.deepEqual(walkItems(bytes(0x10, 1, 1, 0xff, 0xff, 0x00)).error?.info, value)
  })

  test("unknownTypesAndOKCStopTheMessage", () => {
    const known = new Set(DiagItemType.allCases.filter(type => type !== "okc").map(DiagItemType.rawValue))
    for (let byte = 0; byte <= 0xff; byte++) {
      if (known.has(byte)) continue
      const result = walkItems(bytes(0x0c, byte, 0x0c))
      assert.equal(result.items.length, 1)
      assert.deepEqual(result.error?.info, { kind: "unknownType", typeByte: byte, itemIndex: 2, itemOffset: 1 })
      assert.ok(result.error?.itemIndex === 2 && result.error?.itemOffset === 1)
      assert.equal(result.error?.typeName, byte === 0x08 ? "OKC" : undefined)
      assert.equal(result.error?.specGapIssue, byte === 0x08 ? 30 : undefined)
    }
    const truncated = new DiagItemWalkError({ kind: "truncated", itemIndex: 1, itemOffset: 0, field: "id" })
    assert.equal(truncated.typeName, undefined)
    assert.equal(truncated.specGapIssue, undefined)
  })

  test("errorsAreSticky", () => {
    const walker = new DiagItemWalker()
    const unknown = { kind: "unknownType", typeByte: 0x42, itemIndex: 1, itemOffset: 0 } as const
    throwsInfo(() => walker.next(bytes(0x42)), DiagItemWalkError, unknown)
    assert.deepEqual(walker.error?.info, unknown)
    throwsInfo(() => walker.next(xmlblob([])), DiagItemWalkError, unknown)
  })

  test("walkerStateAndStartOffset", () => {
    const sequence = cat([0xee, 0xee], xmlblob([5]))
    assert.deepEqual(walkItems(sequence, 2).items, [new DiagItem({ index: 1, type: "xmlblob", offset: 2, valueRange: byteRange(7, 8) })])
    const walker = new DiagItemWalker(-5)
    const start = walker.offset
    assert.equal(start, 0)
    walker.next(xmlblob([1, 2]))
    assert.ok(walker.offset === 7 && walker.itemCount === 1)
    assert.equal(walker.next(xmlblob([1, 2])), undefined)
    assert.equal(walker.next(new Uint8Array(0)), undefined, "a shorter sequence than the offset ends the walk")
  })

  /** Resuming a walk from any item boundary gives the rest of the whole walk. */
  test("resumingAtAnItemBoundary", () => {
    const sequence = cat(appl(0x04, 0x26, [0, 0, 0, 9]), [0x01], repeated(0, 16), appl4(0x09, 0x02, [1, 2, 3]), xmlblob([4]), [0x0c])
    const whole = walkItems(sequence)
    assert.ok(whole.error === undefined && whole.items.length === 5)
    whole.items.forEach((item, position) => {
      const rest = walkItems(sequence, item.offset)
      assert.deepEqual(
        rest.items.map(each => each.valueRange),
        whole.items.slice(position).map(each => each.valueRange)
      )
    })
  })
})

describe("Item encoder", () => {
  test("layouts", () => {
    const output = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stUser("connect"), bytes(1, 2, 3), output)
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), bytes(4), output)
    DiagItemEncoder.appendXMLBLOB(ascii("<a/>"), output)
    DiagItemEncoder.appendSimple("sba", bytes(7, 8), output)
    DiagItemEncoder.appendEOM(output)
    const encoded = output.toBytes()
    assert.deepEqual(encoded, cat(appl(0x04, 0x02, [1, 2, 3]), appl4(0x09, 0x02, [4]), xmlblob(ascii("<a/>")), [0x0b, 7, 8, 0x0c]))
    const walked = walkItems(encoded)
    assert.equal(walked.error, undefined)
    assert.deepEqual(
      walked.items.map(item => item.type),
      ["appl", "appl4", "xmlblob", "sba", "eom"]
    )
  })

  test("limits", () => {
    const output = new ByteWriter()
    const maximum = new Uint8Array(65_535)
    DiagItemEncoder.appendAPPL(ApplItem.dynn("chl"), maximum, output)
    assert.equal(walkItems(output.toBytes()).items[0]?.valueLength, 65_535)
    const tooLong = new Uint8Array(65_536)
    throwsInfo(() => DiagItemEncoder.appendAPPL(ApplItem.dynn("chl"), tooLong, output), DiagItemEncodingError, {
      kind: "valueTooLong",
      type: "appl",
      length: 65_536
    })
    DiagItemEncoder.appendAPPL4(ApplItem.dynn("chl"), tooLong, output)
    throwsInfo(() => DiagItemEncoder.appendSimple("sfe", bytes(1, 2), output), DiagItemEncodingError, {
      kind: "wrongValueSize",
      type: "sfe",
      expected: 3,
      actual: 2
    })
    for (const type of ["okc", "appl", "appl4", "xmlblob"] as DiagItemType[])
      throwsInfo(() => DiagItemEncoder.appendSimple(type, new Uint8Array(0), output), DiagItemEncodingError, { kind: "notASimpleType", type })
  })
})
