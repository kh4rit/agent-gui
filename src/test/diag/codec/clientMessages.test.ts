// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ClientMessagesTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientCompression,
  ClientItem,
  ClientMessageEncoder,
  ClientMessageError,
  DiagHeader,
  DiagMessage,
  Decompressor,
  SESValue,
  SupportBits,
  UserConnect,
  byteRange
} from "../../../diag/codec/index.js"
import { DPHeader, DPTerminalName, NIFrameEncoder } from "../../../diag/wire/index.js"
import { decodeStream } from "../../vectors/wireRunners.js"
import { appl, appl4, ascii, bytes, cat, repeated, throwsInfo, u32BE, walkItems, zzTestIdentity } from "../../support/codecTestSupport.js"
import { SeededGenerator } from "../../support/seededGenerator.js"

describe("Client messages", () => {
  const terminal = DPTerminalName.fromHostName("zz-toaster")

  /**
   * The whole first message, byte for byte, from session.md §1, dp-header.md's template,
   * diag-header.md PV-0300 and items.md's APPL layout.
   */
  test("firstMessageBytes", () => {
    const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal)
    const payload = encoder.firstMessage()
    const diag = payload.slice(DPHeader.size)
    const expected = cat(
      [0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x04, 0x02, 0x00, 0x0c],
      [0x00, 0x00, 0x00, 0xc8],
      u32BE(0x1234),
      u32BE(0x4242),
      [0x10, 0x04, 0x0b, 0x00, 0x20],
      repeated(0, 22),
      [0x20],
      repeated(0, 9)
    )
    assert.deepEqual(diag, expected)
    // pysap's comment on the DP length: the 8-byte DIAG header plus a 54-byte body (session.md §1).
    assert.equal(diag.length, 8 + 54)
    const dp = DPHeader.parseFirstMessage(payload)
    assert.ok(dp.length === 62 && dp.matchesTemplate)
    assert.deepEqual(dp.terminalName.slice(), ascii("zz-toaster"))
    assert.deepEqual(dp, DPHeader.firstMessage(terminal, 62))
  })

  /**
   * The fake server's side: DP header, DIAG header INI, then exactly CONNECT and SUPPORTDATA,
   * no EOM (R-SE-1), whatever the compression choice (PV-0317).
   */
  test("firstMessageDecodesBack", () => {
    for (const compression of ["off", "lzh"] as ClientCompression[]) {
      const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal, compression)
      const payload = encoder.firstMessage()
      DPHeader.parseFirstMessage(payload)
      const diag = payload.slice(DPHeader.size)
      const message = DiagMessage.parse(diag)
      assert.deepEqual(message.header, DiagHeader.clientFirstMessage)
      if (message.body.kind !== "items") assert.fail("the first message is never compressed")
      const items = message.body.range.of(diag).slice()
      const walked = walkItems(items)
      assert.equal(walked.error, undefined)
      assert.deepEqual(
        walked.items.map(item => item.appl),
        [ApplItem.stUser("connect"), ApplItem.stUser("supportData")]
      )
      assert.ok(
        walked.items.every(item => item.type === "appl"),
        "R-IT-10: APPL carriers"
      )
      const connect = UserConnect.decode(walked.items[0].valueRange.of(items))
      assert.deepEqual(
        connect,
        new UserConnect({ protocolVersion: ClientCompression.protocolVersion(compression), codePage: 0x1234, wsType: 0x4242 })
      )
      assert.deepEqual(connect, encoder.userConnect)
      assert.deepEqual(SupportBits.decode(walked.items[1].valueRange.of(items)), zzTestIdentity().supportData)
    }
    assert.ok(ClientCompression.protocolVersion("off") === 200 && ClientCompression.protocolVersion("lzh") === 100_200)
  })

  test("dialogMessagesCountStepsFromOne", () => {
    const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal)
    assert.equal(encoder.lastStepNumber, 0)
    const first = encoder.dialogMessage([])
    assert.deepEqual(first, cat([0, 0, 0, 0, 0, 0, 0, 0], [0x10, 0x04, 0x26, 0x00, 0x04, 0, 0, 0, 1], [0x0c]))
    const ses = new SESValue({ eventArray: 1 })
    const second = encoder.dialogMessage([ClientItem.ses(ses), ClientItem.dynnCHL(repeated(0x5a, 22)), ClientItem.dyntAtom(bytes(1, 2, 3))])
    const expected = cat(
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0x10, 0x04, 0x26, 0x00, 0x04, 0, 0, 0, 2],
      [0x01, 1],
      repeated(0, 15),
      appl(0x05, 0x01, repeated(0x5a, 22)),
      appl4(0x09, 0x02, [1, 2, 3]),
      [0x0c]
    )
    assert.deepEqual(second, expected)
    assert.equal(encoder.lastStepNumber, 2)
    // Step first, EOM last (PV-0524), with the carriers of R-IT-10.
    const walked = walkItems(second.slice(DiagHeader.size))
    assert.deepEqual(
      walked.items.map(item => item.type),
      ["appl", "ses", "appl", "appl4", "eom"]
    )
    assert.deepEqual(walked.items[0]?.appl, ApplItem.stUser("dialogStepNumber"))
  })

  test("compressedDialogMessagesDecompressToTheSameBody", () => {
    const plain = new ClientMessageEncoder(zzTestIdentity(), terminal)
    const compressed = new ClientMessageEncoder(zzTestIdentity(), terminal, "lzh")
    const decompressor = new Decompressor()
    for (let round = 1; round <= 3; round++) {
      const items = [ClientItem.dyntAtom(repeated(round, 40 * round))]
      const reference = plain.dialogMessage(items)
      const payload = compressed.dialogMessage(items)
      const message = DiagMessage.parse(payload)
      assert.deepEqual(message.header, DiagHeader.clientLaterMessage(true))
      if (message.body.kind !== "compressed" || message.body.isErrorBody) assert.fail("not compressed")
      const { header, data } = message.body
      // PV-0316: LZH, byte 4 = 0x12, byte 7 = 2, the exact body length.
      assert.ok(header.algorithmByte === 0x12 && header.byte7 === 2)
      assert.equal(header.uncompressedLength, reference.length - DiagHeader.size)
      const body = decompressor.decompress(data.of(payload), header)
      assert.deepEqual(body, reference.slice(DiagHeader.size))
    }
    assert.equal(compressed.lastStepNumber, 3)
  })

  test("closeMessage", () => {
    assert.deepEqual(ClientMessageEncoder.closeMessage, bytes(0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))
    assert.deepEqual(DiagMessage.parse(ClientMessageEncoder.closeMessage).body, { kind: "items", range: byteRange(8, 8) })
  })

  /**
   * Reading R-MO-2 (session.md §8, PV-0542): an input step of a later mode carries the mode's
   * number in the header's mode byte; everything else is the later-message pattern.
   */
  test("laterModeHeader", () => {
    const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal)
    const first = encoder.dialogMessage([], 0)
    const second = encoder.dialogMessage([], 2)
    assert.deepEqual(first.slice(0, 8), bytes(0, 0, 0, 0, 0, 0, 0, 0))
    assert.deepEqual(second.slice(0, 8), bytes(2, 0, 0, 0, 0, 0, 0, 0))
    assert.equal(encoder.lastStepNumber, 2, "one per-connection counter across modes (PV-0521)")
    assert.deepEqual(DiagHeader.clientLaterMessage(true, 0xf0, 5).bytes, bytes(5, 0, 0xf0, 0, 0, 0, 0, 1))
    assert.deepEqual(DiagHeader.clientLaterMessage(false, 0, 0), DiagHeader.clientLaterMessage(false))
  })

  test("refusals", () => {
    const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal)
    const tooLong = repeated(0, 65_536)
    throwsInfo(() => encoder.dialogMessage([ClientItem.dynnCHL(tooLong)]), ClientMessageError, {
      kind: "item",
      error: { kind: "valueTooLong", type: "appl", length: 65_536 }
    })
    assert.equal(encoder.lastStepNumber, 0)
    // APPL4 carries it.
    assert.equal(encoder.dialogMessage([ClientItem.dyntAtom(tooLong)]).length, 8 + 9 + 7 + 65_536 + 1)
    encoder.lastStepNumber = 0xffff_ffff - 1
    assert.deepEqual(encoder.dialogMessage([]).slice(13, 17), bytes(0xff, 0xff, 0xff, 0xff))
    throwsInfo(() => encoder.dialogMessage([]), ClientMessageError, { kind: "stepNumberExhausted" })
  })

  /**
   * Chunked input: client messages framed with DiagWire, delivered to the NI framer in random
   * reads, decode to the same messages (IMPL-NI-3 end to end).
   */
  test("framedMessagesSurviveChunkedDelivery", () => {
    const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal)
    const payloads = [encoder.firstMessage()]
    for (let step = 0; step < 5; step++) payloads.push(encoder.dialogMessage([ClientItem.ses(new SESValue({ eventArray: step }))]))
    payloads.push(ClientMessageEncoder.closeMessage)
    const stream = cat(...payloads.map(payload => new NIFrameEncoder().encode(payload)))
    const generator = new SeededGenerator(0x5eed00c1)
    for (let round = 0; round < 200; round++) {
      const result = decodeStream(stream, generator.cuts(stream.length))
      assert.equal(result.error, undefined)
      assert.deepEqual(
        result.frames.map(frame => frame.payload.slice()),
        payloads
      )
    }
  })
})
