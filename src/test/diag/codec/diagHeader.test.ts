// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DiagHeaderTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ComFlag, CompressField, DiagBodyClass, DiagHeader, DiagHeaderError } from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { bytes, throwsInfo } from "../../support/codecTestSupport.js"

describe("DIAG header", () => {
  test("splitsEightFieldsInOffsetOrder", () => {
    const header = DiagHeader.parse(bytes(0x11, 0x22, 0x33, 0x00, 0x55, 0x66, 0x77, 0x00))
    assert.equal(header.mode, 0x11)
    assert.equal(header.comFlag, ComFlag.eoc | ComFlag.cas)
    assert.equal(header.modeStat, 0x33)
    assert.equal(header.errNo, 0)
    assert.equal(header.msgType, 0x55)
    assert.equal(header.msgInfo, 0x66)
    assert.equal(header.msgRC, 0x77)
    assert.deepEqual(header.compress, CompressField.uncompressed)
    assert.ok(!header.isError)
    assert.equal(header.bodyClass(), "items")
  })

  test("ignoresBytesAfterTheHeader", () => {
    const header = DiagHeader.parse(bytes(1, 2, 3, 0, 5, 6, 7, 0, 0xee, 0xff))
    assert.deepEqual(header.bytes, bytes(1, 2, 3, 0, 5, 6, 7, 0))
  })

  test("fewerThanEightBytesAreTruncated", () => {
    for (let count = 0; count < 8; count++)
      throwsInfo(() => DiagHeader.parse(new Uint8Array(count)), DiagHeaderError, { kind: "truncated", availableByteCount: count })
  })

  test("memberwiseInitAndSerialize", () => {
    const header = new DiagHeader({
      mode: 3,
      comFlag: ComFlag.eos | ComFlag.gra,
      modeStat: 4,
      errNo: 5,
      msgType: 6,
      msgInfo: 7,
      msgRC: 8,
      compress: { kind: "snc", value: 3 }
    })
    const output = new ByteWriter()
    output.u8(0xaa)
    header.serialize(output)
    assert.deepEqual(output.toBytes(), bytes(0xaa, 3, 0x81, 4, 5, 6, 7, 8, 3))
    assert.deepEqual(header.bytes, output.toBytes().subarray(1))
  })

  test("comFlagBitsAndNames", () => {
    const expected: [number, number, string][] = [
      [ComFlag.eos, 0x01, "EOS"],
      [ComFlag.eoc, 0x02, "EOC"],
      [ComFlag.nop, 0x04, "NOP"],
      [ComFlag.eop, 0x08, "EOP"],
      [ComFlag.ini, 0x10, "INI"],
      [ComFlag.cas, 0x20, "CAS"],
      [ComFlag.nnm, 0x40, "NNM"],
      [ComFlag.gra, 0x80, "GRA"]
    ]
    for (const [flag, mask, name] of expected) {
      assert.equal(flag, mask)
      assert.deepEqual(ComFlag.names(flag), [name])
    }
    assert.deepEqual(ComFlag.names(0), [])
    assert.deepEqual(ComFlag.names(0xff), ["EOS", "EOC", "NOP", "EOP", "INI", "CAS", "NNM", "GRA"])
    assert.deepEqual(ComFlag.names(0x22), ["EOC", "CAS"])
    assert.equal(ComFlag.named.length, 8)
  })

  test("everyComFlagValueIsNamedCompletely", () => {
    // R-DH-2: the eight names cover all eight bits, so the names always rebuild the byte.
    for (let value = 0; value <= 0xff; value++) {
      let rebuilt = 0
      for (const name of ComFlag.names(value)) rebuilt |= ComFlag.named.find(entry => entry.name === name)!.flag
      assert.equal(rebuilt, value)
    }
  })

  test("compressFieldCoversEveryByte", () => {
    assert.deepEqual(CompressField.fromRaw(0), { kind: "uncompressed" })
    assert.deepEqual(CompressField.fromRaw(1), { kind: "compressed" })
    assert.deepEqual(CompressField.fromRaw(2), { kind: "snc", value: 2 })
    assert.deepEqual(CompressField.fromRaw(3), { kind: "snc", value: 3 })
    assert.deepEqual(CompressField.fromRaw(4), { kind: "unknown", value: 4 })
    assert.deepEqual(CompressField.fromRaw(0xff), { kind: "unknown", value: 0xff })
    for (let value = 0; value <= 0xff; value++)
      assert.equal(CompressField.rawValue(CompressField.fromRaw(value)), value, "unknown values are preserved")
  })

  /** docs/protocol/diag-header.md, "Body classification" (v1), every err_no × compress combination. */
  test("bodyClassificationTable", () => {
    for (const errNo of [0, 1, 0x7f, 0xff]) {
      for (let compress = 0; compress <= 0xff; compress++) {
        const header = DiagHeader.parse(bytes(0, 0, 0, errNo, 0, 0, 0, compress))
        assert.equal(header.isError, errNo !== 0)
        let expected: DiagBodyClass | undefined
        if (compress >= 4) expected = undefined
        else if (compress === 2 || compress === 3) expected = "snc"
        else if (errNo === 0) expected = compress === 0 ? "items" : "compressed"
        else expected = compress === 0 ? "errorBody" : "compressedErrorBody"
        if (expected !== undefined) {
          const actual = header.bodyClass()
          assert.equal(actual, expected)
          assert.equal(DiagBodyClass.isErrorBody(actual), errNo !== 0 && compress <= 1)
          assert.equal(DiagBodyClass.isCompressed(actual), compress === 1)
        } else {
          throwsInfo(() => header.bodyClass(), DiagHeaderError, { kind: "unknownCompress", value: compress })
        }
      }
    }
  })

  /** IMPL-DH-9, PV-0300 to PV-0302: the only three header patterns the client writes. */
  test("clientHeaderPatterns", () => {
    assert.deepEqual(DiagHeader.clientFirstMessage.bytes, bytes(0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))
    assert.deepEqual(DiagHeader.clientLaterMessage(false).bytes, bytes(0, 0, 0, 0, 0, 0, 0, 0))
    assert.deepEqual(DiagHeader.clientLaterMessage(true).bytes, bytes(0, 0, 0, 0, 0, 0, 0, 1))
    assert.deepEqual(DiagHeader.clientClose.bytes, bytes(0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))
    assert.deepEqual(ComFlag.names(DiagHeader.clientFirstMessage.comFlag), ["INI"])
    assert.deepEqual(ComFlag.names(DiagHeader.clientClose.comFlag), ["EOC"])
    assert.equal(DiagHeader.clientLaterMessage(true).bodyClass(), "compressed")
  })

  /**
   * IMPL-DH-9 as amended on 2026-09-25, Reading R-CT-26 (PV-0908): the control reply's header,
   * `mm 00 ss 00 00 01 00 cc`.
   */
  test("controlReplyHeader", () => {
    assert.deepEqual(DiagHeader.clientControlReply(true, 0, 0).bytes, bytes(0, 0, 0, 0, 0, 0x01, 0, 1), "SAP GUI's header of every later message")
    assert.deepEqual(DiagHeader.clientControlReply(false, 0xf0, 2).bytes, bytes(2, 0, 0xf0, 0, 0, 0x01, 0, 0))
    assert.equal(DiagHeader.controlReplyMsgInfo, 0x01)
    assert.equal(DiagHeader.clientControlReply(false, 0, 0).bodyClass(), "items")
  })

  test("roundTripsEveryFieldValue", () => {
    // Each field takes every byte value once, with the others varying too.
    for (let value = 0; value <= 0xff; value++) {
      const header = Uint8Array.from({ length: 8 }, (_, index) => (value + index * 37) & 0xff)
      assert.deepEqual(DiagHeader.parse(header).bytes, header)
    }
  })
})
