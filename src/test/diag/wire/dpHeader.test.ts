// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/DPHeaderTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  DPHeader,
  DPHeaderError,
  DPTerminalName,
  DP_HEADER_FIELDS,
  NIFrameDecoder,
  NIFrameEncoder,
  dpHeaderFieldName,
  dpHeaderFieldOffset,
  dpHeaderFieldRange,
  dpHeaderFieldSize,
  dpHeaderFieldTemplateFill,
  type DPHeaderField
} from "../../../diag/wire/index.js"
import { assertThrowsInfo } from "../../support/assertions.js"
import { SeededGenerator } from "../../support/seededGenerator.js"
import { concat, drain, expectedHeader, specTemplate, utf8 } from "./support.js"

const range = (field: DPHeaderField): number[] => {
  const [start, end] = dpHeaderFieldRange(field)
  return Array.from({ length: end - start }, (_, i) => start + i)
}

describe("DP header layout", () => {
  /** dp-header.md, "Layout": (name, offset, size), typed in from the spec table. */
  const specLayout: [string, number, number][] = [
    ["request_id", 0, 4], ["retcode", 4, 1], ["sender_id", 5, 1], ["action_type", 6, 1], ["req_info", 7, 4],
    ["tid", 11, 4], ["uid", 15, 2], ["mode", 17, 1], ["wp_id", 18, 4], ["wp_ca_blk", 22, 4], ["appc_ca_blk", 26, 4],
    ["length", 30, 4], ["new_stat", 34, 1], ["unused1", 35, 4], ["rq_id", 39, 2], ["unused2", 41, 40],
    ["terminal", 81, 15], ["unused3", 96, 10], ["unused4", 106, 20], ["unused5", 126, 4], ["unused6", 130, 4],
    ["unused7", 134, 4], ["unused8", 138, 4], ["unused9", 142, 1], ["unused10", 143, 57]
  ]

  test("fieldsMatchTheSpecTable", () => {
    const fields = DP_HEADER_FIELDS
    assert.equal(fields.length, 25)
    assert.deepEqual(fields.map(dpHeaderFieldName), specLayout.map(f => f[0]))
    assert.deepEqual(fields.map(dpHeaderFieldOffset), specLayout.map(f => f[1]))
    assert.deepEqual(fields.map(dpHeaderFieldSize), specLayout.map(f => f[2]))
  })

  test("fieldsTileExactly200Bytes", () => {
    let next = 0
    for (const field of DP_HEADER_FIELDS) {
      assert.equal(dpHeaderFieldOffset(field), next, `${dpHeaderFieldName(field)} starts at ${dpHeaderFieldOffset(field)}, expected ${next}`)
      assert.deepEqual(dpHeaderFieldRange(field), [dpHeaderFieldOffset(field), dpHeaderFieldOffset(field) + dpHeaderFieldSize(field)])
      next = dpHeaderFieldRange(field)[1]
    }
    assert.equal(next, DPHeader.size)
    assert.equal(DPHeader.size, 200)
    assert.equal(DPTerminalName.width, 15)
    assert.equal(dpHeaderFieldSize("terminal"), DPTerminalName.width)
  })

  test("onlyTheLengthAndTheTerminalHaveNoTemplateFill", () => {
    for (const field of DP_HEADER_FIELDS) {
      if (field === "length" || field === "terminal") {
        assert.equal(dpHeaderFieldTemplateFill(field), undefined)
      } else {
        // Every template field is a uniform fill: check it against the spec's hex table.
        const [start, end] = dpHeaderFieldRange(field)
        assert.ok(
          specTemplate.subarray(start, end).every(b => b === dpHeaderFieldTemplateFill(field)),
          dpHeaderFieldName(field)
        )
      }
    }
  })
})

describe("DP header encoder (IMPL-DP-2)", () => {
  test("emptyNameAndZeroLengthIsTheSpecTemplate", () => {
    assert.deepEqual(DPHeader.firstMessage(DPTerminalName.empty, 0).bytes, specTemplate)
  })

  const cases: [string, number][] = [
    ["testhost", 8],
    ["llama-farm-07", 258],
    ["toaster.local", 0x0102_0304],
    ["", 1],
    ["x", 0xffff_ffff],
    ["waffle-iron-015", 16]
  ]
  for (const [name, bodyLength] of cases) {
    test(`onlyTheLengthAndTheTerminalAreFilledIn(${JSON.stringify(name)}, ${bodyLength})`, () => {
      const header = DPHeader.firstMessage(DPTerminalName.fromHostName(name), bodyLength)
      assert.deepEqual(header.bytes, expectedHeader(utf8(name), bodyLength))
      assert.equal(header.length, bodyLength)
      assert.deepEqual(header.terminalName.slice(), utf8(name))
      assert.ok(header.matchesTemplate)
      assert.deepEqual(header.nonTemplateFields, [])
    })
  }

  test("lengthIsLittleEndian", () => {
    // 258 = 0x0102: u32 LE is 02 01 00 00 (a big-endian writer would give 00 00 01 02).
    const header = DPHeader.firstMessage(DPTerminalName.empty, 258)
    assert.deepEqual(header.bytesOf("length").slice(), Uint8Array.of(0x02, 0x01, 0x00, 0x00))
    assert.deepEqual(header.bytes.slice(30, 34), Uint8Array.of(0x02, 0x01, 0x00, 0x00))
  })

  test("firstMessageFieldValues", () => {
    // PV-0240 to PV-0263 through the typed accessors.
    const header = DPHeader.firstMessage(DPTerminalName.fromHostName("ZZ-GOAT-HOST"), 77)
    assert.equal(header.requestID, -1)
    assert.equal(header.retcode, 0x0a)
    assert.equal(header.senderID, 0)
    assert.equal(header.actionType, 0)
    assert.equal(header.reqInfo, 0)
    assert.equal(header.tid, -1)
    assert.equal(header.uid, -1)
    assert.equal(header.mode, 0xff)
    assert.equal(header.wpID, -1)
    assert.equal(header.wpCaBlk, -1)
    assert.equal(header.appcCaBlk, -1)
    assert.equal(header.length, 77)
    assert.equal(header.newStat, 0)
    assert.equal(header.rqID, -1)
    assert.equal(header.unused9, 1)
    assert.deepEqual(header.bytesOf("unused1").slice(), Uint8Array.of(0xff, 0xff, 0xff, 0xff))
    assert.deepEqual(header.bytesOf("unused2").slice(), new Uint8Array(40).fill(0x20))
    assert.deepEqual(header.bytesOf("unused4").slice(), new Uint8Array(20).fill(0x20))
    assert.deepEqual(header.bytesOf("unused7").slice(), Uint8Array.of(0xff, 0xff, 0xff, 0xff))
    assert.deepEqual(header.bytesOf("unused10").slice(), new Uint8Array(57))
    assert.deepEqual(header.terminalName.slice(), utf8("ZZ-GOAT-HOST"))
    assert.deepEqual(header.bytesOf("terminal").slice(), concat(utf8("ZZ-GOAT-HOST"), [0, 0, 0]))
  })

  test("firstMessagePayloadPrefixesTheDiagMessage", () => {
    const message = Uint8Array.of(0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x04, 0x02)
    const name = DPTerminalName.fromHostName("pancake-lab")
    const payload = DPHeader.firstMessagePayload(name, message)
    assert.deepEqual(payload, concat(expectedHeader(utf8("pancake-lab"), 11), message))
    // (Swift's Span overload is the same function here.)
    const decoded = DPHeader.parseFirstMessage(payload)
    assert.deepEqual(decoded.bytes, DPHeader.firstMessage(name, 11).bytes)
    assert.deepEqual(payload.slice(DPHeader.size), message)
    // An empty DIAG part still gets a valid header (length 0).
    assert.deepEqual(DPHeader.firstMessagePayload(DPTerminalName.empty, new Uint8Array(0)), specTemplate)
  })

  test("framedFirstMessageDecodesBack", () => {
    // The client's first frame: NI length | DP header | DIAG message (R-DP-2: DP length = NI
    // length − 200).
    const message = new Uint8Array(300).fill(0x5a)
    const payload = DPHeader.firstMessagePayload(DPTerminalName.fromHostName("sofa-fort"), message)
    const frameBytes = new NIFrameEncoder().encode(payload)
    const decoder = new NIFrameDecoder()
    decoder.append(frameBytes)
    decoder.finish()
    const { frames, error } = drain(decoder)
    assert.equal(error, undefined)
    assert.ok(frames[0])
    const received = frames[0].payload
    const header = DPHeader.parseFirstMessage(received)
    assert.equal(header.length, received.length - DPHeader.size)
    assert.deepEqual(header.terminalName.slice(), utf8("sofa-fort"))
  })

  test("bodyLengthsAreChecked", () => {
    // The DP length is a u32: a longer body cannot be expressed. Checked with counts, since a
    // 4 GiB buffer is not allocated in a unit test. (Swift's checkedLengths also returns the
    // payload size, 200 + count; the port's checkedLength returns the field only.)
    assert.equal(DPHeader.checkedLength(0xffff_ffff), 0xffff_ffff)
    assert.equal(DPHeader.checkedLength(0), 0)
    for (const count of [0x1_0000_0000, Number.MAX_SAFE_INTEGER - 199, Number.MAX_SAFE_INTEGER, -1, Number.MIN_SAFE_INTEGER])
      assertThrowsInfo(DPHeaderError, { kind: "bodyTooLong", bodyLength: count }, () => DPHeader.checkedLength(count))
  })

  test("seededRoundTrips", () => {
    const generator = new SeededGenerator(0xd9_0001)
    for (let i = 0; i < 2000; i++) {
      const nameBytes = Uint8Array.from({ length: generator.int(0, 15) }, () => generator.uint8(0x20, 0x7e))
      const name = DPTerminalName.fromHostName(String.fromCharCode(...nameBytes))
      assert.deepEqual(name.bytes, nameBytes)
      const message = generator.bytes(generator.int(0, 64))
      const payload = DPHeader.firstMessagePayload(name, message)
      const header = DPHeader.parseFirstMessage(payload)
      assert.deepEqual(header.bytes, expectedHeader(nameBytes, message.length))
      assert.deepEqual(header.terminalName.slice(), nameBytes)
      assert.ok(header.matchesTemplate)
      assert.deepEqual(DPHeader.firstMessage(name, header.length).bytes, header.bytes)
      assert.deepEqual(DPHeader.parse(header.bytes).bytes, header.bytes)
    }
  })
})

describe("DP header decoder (IMPL-DP-3)", () => {
  test("fewerThan200BytesAreTruncated", () => {
    for (let count = 0; count < DPHeader.size; count++) {
      const bytes = specTemplate.slice(0, count)
      assertThrowsInfo(DPHeaderError, { kind: "truncated", byteCount: count }, () => DPHeader.parse(bytes))
      assertThrowsInfo(DPHeaderError, { kind: "truncated", byteCount: count }, () => DPHeader.parseFirstMessage(bytes))
    }
  })

  test("parsingReadsTheFirst200BytesOnly", () => {
    const payload = concat(expectedHeader([0x41], 3), [7, 8, 9])
    const header = DPHeader.parse(payload)
    assert.deepEqual(header.bytes, payload.slice(0, 200))
    const firstMessage = DPHeader.parseFirstMessage(payload)
    assert.deepEqual(firstMessage.bytes, header.bytes)
    // Parsing alone does not check the length.
    assert.equal(DPHeader.parse(concat(payload, [10])).length, 3)
  })

  test("lengthMustCountTheBytesAfterTheHeader", () => {
    const body = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)
    const empty = new Uint8Array(0)
    const cases: [number, Uint8Array][] = [
      [9, body], [7, body], [0, body], [8, empty], [0x0800_0000, body], [0xffff_ffff, body], [0xffff_ffff, empty]
    ]
    for (const [declared, caseBody] of cases) {
      const payload = concat(expectedHeader([], declared), caseBody)
      assertThrowsInfo(DPHeaderError, { kind: "lengthMismatch", declaredLength: declared, bodyLength: caseBody.length }, () =>
        DPHeader.parseFirstMessage(payload)
      )
    }
  })

  test("bigEndianLengthIsAMismatch", () => {
    // 00 00 00 08 at offset 30 reads (LE) as 134217728, not 8.
    const payload = concat(expectedHeader([], 0), new Uint8Array(8).fill(0x33))
    payload.set([0x00, 0x00, 0x00, 0x08], 30)
    assertThrowsInfo(DPHeaderError, { kind: "lengthMismatch", declaredLength: 134_217_728, bodyLength: 8 }, () =>
      DPHeader.parseFirstMessage(payload)
    )
    assert.equal(DPHeader.parse(payload).length, 134_217_728)
  })

  test("typedAccessorsReadTheirByteOrder", () => {
    const bytes = specTemplate.slice()
    bytes.set([0x80, 0x00, 0x00, 0x01], 0) // request_id s32 BE
    bytes[4] = 0xa4
    bytes[5] = 0xa5
    bytes[6] = 0xa6
    bytes.set([0x89, 0xab, 0xcd, 0xef], 7) // req_info u32 BE
    bytes.set([0x12, 0x34, 0x56, 0x78], 11) // tid s32 BE
    bytes.set([0x80, 0x01], 15) // uid s16 BE
    bytes[17] = 0x11
    bytes.set([0x00, 0x00, 0x01, 0x00], 18) // wp_id
    bytes.set([0xff, 0xff, 0xff, 0xfe], 22) // wp_ca_blk
    bytes.set([0x7f, 0xff, 0xff, 0xff], 26) // appc_ca_blk
    bytes.set([0x78, 0x56, 0x34, 0x12], 30) // length u32 LE
    bytes[34] = 0x80
    bytes.set([0x01, 0x02], 39) // rq_id s16 BE
    bytes[142] = 0x42
    const header = DPHeader.parse(bytes)
    assert.equal(header.requestID, 0x8000_0001 | 0) // Int32(bitPattern:)
    assert.equal(header.retcode, 0xa4)
    assert.equal(header.senderID, 0xa5)
    assert.equal(header.actionType, 0xa6)
    assert.equal(header.reqInfo, 0x89ab_cdef)
    assert.equal(header.tid, 0x1234_5678)
    assert.equal(header.uid, -0x7fff) // Int16(bitPattern: 0x8001)
    assert.equal(header.mode, 0x11)
    assert.equal(header.wpID, 256)
    assert.equal(header.wpCaBlk, -2)
    assert.equal(header.appcCaBlk, 0x7fff_ffff)
    assert.equal(header.length, 0x1234_5678)
    assert.equal(header.newStat, 0x80)
    assert.equal(header.rqID, 0x0102)
    assert.equal(header.unused9, 0x42)
  })

  test("terminalNameStopsAtTheFirstZeroByte", () => {
    const bytes = specTemplate.slice()
    bytes.set(utf8("pickle-jar-0042"), 81)
    assert.deepEqual(DPHeader.parse(bytes).terminalName.slice(), utf8("pickle-jar-0042"), "15 bytes, no terminator (R-DP-5)")
    bytes[84] = 0
    assert.deepEqual(DPHeader.parse(bytes).terminalName.slice(), utf8("pic"))
    bytes[81] = 0
    assert.equal(DPHeader.parse(bytes).terminalName.length, 0)
  })

  test("everyNonTemplateFillerIsReportedAndNotRejected", () => {
    // The length is left out: changing it is a mismatch (tested above).
    for (const field of DP_HEADER_FIELDS) {
      if (field === "length") continue
      for (const position of range(field)) {
        const bytes = specTemplate.slice()
        bytes[position] ^= 0x5a
        const header = DPHeader.parseFirstMessage(bytes)
        if (field === "terminal") {
          assert.ok(header.matchesTemplate, "the terminal name is filled in by the encoder")
        } else {
          assert.deepEqual(header.nonTemplateFields, [field], `${dpHeaderFieldName(field)} byte ${position}`)
          assert.ok(!header.matchesTemplate)
        }
      }
    }
  })

  test("severalNonTemplateFieldsAreListedInWireOrder", () => {
    const bytes = specTemplate.slice()
    bytes[142] = 0 // unused9
    bytes[4] = 0 // retcode
    bytes[17] = 2 // mode
    const header = DPHeader.parseFirstMessage(bytes)
    assert.deepEqual(header.nonTemplateFields, ["retcode", "mode", "unused9"])
    assert.deepEqual(header.nonTemplateFields.map(dpHeaderFieldName), ["retcode", "mode", "unused9"])
  })
})
