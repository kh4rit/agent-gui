// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/RFCTransferTests.swift (MIT).

// What a client without controls reads of control traffic (docs/protocol/controls/transport.md
// §2.3, rfc-tr.md §3): msg_info's interim bit (R-CT-22), the RFC_TR items of a message, a call
// assembled from its parts (R-CT-23), the RFC item walk of IMPL-CT-2 and the report's summary, and
// an input step that carries an RFC_TR item (R-CT-24, R-CT-25). Values are invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ApplItem,
  ControlItemScan,
  DiagItemEncoder,
  InputEnvelope,
  RFCCall,
  RFCCallAssembler,
  RFCItemWalkError,
  RFCItemWalker,
  RFCStreamSummary,
  ServerMessageInfo,
  type RFCItem
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo } from "../../support/codecTestSupport.js"
import { rfcEnd, rfcItem } from "../../support/rfcTestSupport.js"

describe("RFC_TR: interim messages, call parts, RFC items and the client's RFC_TR item", () => {
  /** msg_info 0x02 without 0x01 is an interim message; 0x01, 0x03 and 0 are not (R-CT-22) */
  test("interimBit", () => {
    assert.ok(ServerMessageInfo.isInterim(0x02))
    assert.ok(ServerMessageInfo.isInterim(0x06))
    assert.ok(!ServerMessageInfo.isInterim(0x01))
    assert.ok(!ServerMessageInfo.isInterim(0x03))
    assert.ok(!ServerMessageInfo.isInterim(0x00))
  })

  /** the scan finds the RFC_TR items in order, screen content and STOP_TRANS, and stops quietly at a bad item */
  test("scan", () => {
    const items = new ByteWriter()
    const part = bytes(1, 2, 3)
    const empty = new Uint8Array(0)
    const other = bytes(9)
    const area = repeated(0, 16)
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("stopTrans"), empty, items)
    DiagItemEncoder.appendAPPL(ApplItem.rfcTR("mor"), part, items)
    DiagItemEncoder.appendAPPL(ApplItem.of(0x08, 0x0c), other, items)
    const plainItems = items.toBytes()
    const plain = new ControlItemScan(plainItems)
    assert.deepEqual(
      plain.rfcItems.map(item => item.sid),
      [0x04, 0x0c]
    )
    assert.deepEqual(
      plain.rfcItems.map(item => item.name),
      ["RFC_TR_MOR", "RFC_TR sid 0x0C"]
    )
    assert.deepEqual(
      plain.rfcItems.map(item => item.length),
      [3, 1]
    )
    assert.ok(plain.rfcItems[0].knownSID === "mor" && plain.rfcItems[1].knownSID === undefined)
    assert.deepEqual(plain.rfcItems[0].valueRange.of(plainItems), part)
    assert.ok(plain.stopTrans && !plain.carriesScreen)

    DiagItemEncoder.appendAPPL(ApplItem.varInfo("areaSize"), area, items)
    assert.ok(new ControlItemScan(items.toBytes()).carriesScreen)
    const menu = new ByteWriter()
    DiagItemEncoder.appendAPPL4(ApplItem.mnuEntry("menuAct"), empty, menu)
    assert.ok(new ControlItemScan(menu.toBytes()).carriesScreen)
    const atoms = new ByteWriter()
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), empty, atoms)
    assert.ok(new ControlItemScan(atoms.toBytes()).carriesScreen)
    const cut = new ControlItemScan(cat(items.toBytes(), [0x10, 0x08]))
    assert.equal(cut.rfcItems.length, 2, "the walk keeps what came before the stop")
    assert.equal(new ControlItemScan().rfcItems.length, 0)
  })

  /** a call assembles from its parts in order and ends with the closing part (R-CT-23) */
  test("assembler", () => {
    const calls = new RFCCallAssembler()
    assert.ok(!calls.isAssembling)
    const first = bytes(1, 2)
    const second = bytes(3)
    const last = bytes(4, 5)
    assert.deepEqual(calls.append(first, false), { kind: "more", parts: 1, bytes: 2 })
    assert.ok(calls.isAssembling && calls.byteCount === 2)
    assert.deepEqual(calls.append(second, false), { kind: "more", parts: 2, bytes: 3 })
    const outcome = calls.append(last, true)
    assert.deepEqual(outcome, { kind: "complete", value: new RFCCall(3, bytes(1, 2, 3, 4, 5)) })
    // (Two asserts: in one `&&` expression tsc keeps the getters narrowed from the check above.)
    assert.equal(calls.isAssembling, false, "the assembler starts afresh")
    assert.equal(calls.byteCount, 0, "the assembler starts afresh")
    assert.deepEqual(calls.append(last, true), { kind: "complete", value: new RFCCall(1, bytes(4, 5)) }, "a call in one part")
    calls.append(first, false)
    calls.reset()
    assert.ok(!calls.isAssembling)
    assert.ok(RFCCallAssembler.maxCallBytes === 64 << 20 && new RFCCallAssembler().maxBytes === RFCCallAssembler.maxCallBytes)
    const small = new RFCCallAssembler(3)
    assert.deepEqual(small.append(first, false), { kind: "more", parts: 1, bytes: 2 })
    assert.deepEqual(small.append(last, true), { kind: "tooLarge", parts: 2, bytes: 4 }, "past the cap the call is dropped")
    assert.ok(!small.isAssembling && small.byteCount === 0)
    const call = new RFCCall(1, bytes(0x41, 0x42))
    assert.ok(String(call) === "RFCCall(parts: 1, bytes: 2)" && call.description === String(call))
    assert.equal(inspect(call), call.description, "no byte in a dump")
  })

  /** the RFC item walk (IMPL-CT-2): items with their trailing pairs, the end item, the rest ignored */
  test("walk", () => {
    const stream = cat(rfcItem(0x0101, [1, 2]), rfcItem(0x0305, [7], 0x0306), rfcEnd(), [0xaa])
    const walker = new RFCItemWalker()
    const items: RFCItem[] = []
    for (let item = walker.next(stream); item !== undefined; item = walker.next(stream)) {
      items.push(item)
    }
    assert.deepEqual(
      items.map(item => item.id),
      [0x0101, 0x0305, 0xffff]
    )
    assert.deepEqual(
      items.map(item => item.trailerMatches),
      [true, false, true]
    )
    assert.deepEqual(items[0].valueRange.of(stream), bytes(1, 2))
    assert.equal(walker.next(stream), undefined, "nothing after the end item")
  })

  /** a stream cut in an id, a length or a value is truncated; an end item may be cut short */
  test("truncation", () => {
    for (const cut of [bytes(0x01), bytes(0x01, 0x02, 0x00), bytes(0x01, 0x02, 0x00, 0x05, 0x41)]) {
      const walker = new RFCItemWalker()
      throwsInfo(() => walker.next(cut), RFCItemWalkError, { kind: "truncated", itemIndex: 1 })
    }
    const noTrailer = new RFCItemWalker()
    const full = rfcItem(0x0102, [0x41])
    const bare = full.slice(0, full.length - 2)
    assert.equal(noTrailer.next(bare)?.trailerMatches, undefined, "a last item without its trailing pair")
    for (const end of [bytes(0xff, 0xff), bytes(0xff, 0xff, 0x00, 0x09, 0x41)]) {
      const walker = new RFCItemWalker()
      const item = walker.next(end)
      assert.ok(item?.id === 0xffff && item?.trailerMatches === undefined)
      assert.equal(walker.next(end), undefined)
    }
  })

  /** the summary names ids, counts, the end and a listed function; any other name only by its length */
  test("summary", () => {
    const listed = new RFCStreamSummary(
      cat(rfcItem(0x0102, ascii("OLE_FLUSH_CALL  ")), rfcItem(0x0305, [1]), rfcItem(0x0305, [2]), rfcEnd())
    )
    assert.ok(listed.itemCount === 4 && listed.reachedEnd && listed.stop === undefined && listed.trailingBytes === 0)
    assert.deepEqual(listed.ids, [
      { id: 0x0102, count: 1 },
      { id: 0x0305, count: 2 },
      { id: 0xffff, count: 1 }
    ])
    assert.ok(listed.functionName === "OLE_FLUSH_CALL" && listed.withheldFunctionNameLength === undefined)
    assert.equal(listed.description, "4 RFC item(s); ids 01 02, 03 05 ×2, FF FF; function OLE_FLUSH_CALL; end item FF FF")

    const invented = new RFCStreamSummary(cat(rfcItem(0x0102, cat(ascii("ZZ_QUACK"), [0])), rfcEnd(), [1, 2]))
    assert.ok(invented.functionName === undefined && invented.withheldFunctionNameLength === 9)
    assert.equal(invented.trailingBytes, 2)
    assert.equal(
      invented.description,
      "2 RFC item(s); ids 01 02, FF FF; a function name of 9 bytes (not one the spec lists; withheld) (zero-padded, 9 bytes); end item FF FF; " +
        "2 byte(s) after the end item",
      "the form of a name that is not plain ASCII (issue #150)"
    )
    assert.ok(invented.functionNameForm === "zeroPadded" && invented.functionNameLength === 9)

    const binary = new RFCStreamSummary(rfcItem(0x0102, [0x4f, 0x01]))
    assert.ok(binary.withheldFunctionNameLength === 2 && !binary.reachedEnd)

    const odd = new RFCStreamSummary(bytes(0x01, 0x01, 0x00, 0x08, 1, 1, 1, 1, 4))
    assert.deepEqual(odd.stop, { kind: "truncated", itemIndex: 1 })
    assert.equal(
      odd.description,
      "0 RFC item(s); no end item; the walk stopped in item 1 (not an RFC item stream from its first byte, or cut short; #79)"
    )
    const mismatched = new RFCStreamSummary(rfcItem(0x0201, [1], 0x0202))
    assert.equal(mismatched.mismatchedTrailers, 1)
    assert.ok(mismatched.description.endsWith("1 trailing pair(s) not the item's id"))
    assert.deepEqual(RFCStreamSummary.listedFunctionNames, new Set(["OLE_FLUSH_CALL", "SAPGUI_PROGRESS_INDICATOR"]))
  })

  // inputStepCarriesRFCTransfer: needs ClientInput.swift (next wave)

  // threeItemReply: needs ClientInput.swift (next wave)

  /** a control reply's envelope keeps echoes, changed bit, carriers and DYNN CHL, and drops the rest */
  test("controlReplyEnvelope", () => {
    assert.equal(InputEnvelope.controlReply(InputEnvelope.reference), InputEnvelope.chlStage)
    assert.equal(InputEnvelope.controlReply(InputEnvelope.stateStage), InputEnvelope.chlStage)
    assert.equal(InputEnvelope.controlReply(InputEnvelope.echoStage), InputEnvelope.echoStage)
    assert.equal(InputEnvelope.controlReply(InputEnvelope.minimal), InputEnvelope.minimal)
    assert.equal(
      InputEnvelope.controlReply(InputEnvelope.focus | InputEnvelope.dataManager | InputEnvelope.screenState),
      InputEnvelope.minimal
    )
  })

  // step, shapes: the helpers of inputStepCarriesRFCTransfer and threeItemReply, which need
  // ClientInput.swift (next wave)
})
