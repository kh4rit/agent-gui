// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/Bug0150Tests.swift (MIT).

// Issue #150 on the session: after its first answer, the owner's server sent a second
// OLE_FLUSH_CALL whose texts held zero bytes, and the session answered it with R-CT-35's empty
// RFC_TR_RET. The session now answers it with Swooey's own answer in the call's encoding
// (Reading R-CT-37), writes its own code-page descriptor into the head by default (Reading R-CT-36,
// with the code page in force), and its report shows the call's head and text encoding and the
// answer's head, kinds only. The calls are invented (D15); the planted address is of a
// documentation range (RFC 5737).
//
// Swift's `ControlTrafficTests` statics are `ControlFixtures` in src/test/support/sessionTestSupport.ts.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlHandleCounter, FlushAnswerHead, FlushCallAnswerBuilder } from "../../../diag/codec/index.js"
import { ControlReadings, ControlReadingsHeadValues } from "../../../diag/session/index.js"
import { InventedFlushCall, type InventedFlushCallText } from "../../support/inventedFlushCall.js"
import { ControlFixtures, EnvelopeFixtures, ScriptStep, TransportLog, utf8 } from "../../support/sessionTestSupport.js"

const Call = InventedFlushCall

/**
 * A code-page descriptor in Reading R-CT-36's shape: code page 4103, two invented bytes, two bytes
 * per character, the replacement character `#`. (A fresh copy on every read.)
 */
const wideDescriptor = (): Uint8Array => Uint8Array.of(4, 1, 0, 3, 0x00, 0x2a, 2, 0, 0, 0, 0x23)

/** The pond call in `text`, with a descriptor in `01 06` and a planted address in `00 07` and `00 18`. */
function call(text: InventedFlushCallText): InventedFlushCall {
  const call = Call.pond()
  call.text = text
  for (const entry of call.head) {
    switch (entry.id) {
      case 0x0106:
        entry.value = wideDescriptor()
        break
      case 0x0007:
        entry.value = utf8("198.51.100.231 ")
        break
      case 0x0018:
        entry.value = utf8("198.51.100.231")
        break
    }
  }
  return call
}

describe("The session answers a flush call in UTF-16 (issue #150)", () => {
  /** a first single-byte call, then a UTF-16LE one: both get Swooey's answer, the second in UTF-16LE (bug #150) */
  test("secondCallInUTF16", async () => {
    const first = call("singleByte").bytes
    const second = call("utf16LittleEndian").bytes
    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(ControlFixtures.part(0x00, 10, first)),
      ScriptStep.payload(ControlFixtures.part(0x00, 11, second))
    ])
    const session = await ControlFixtures.loggedOn(log)
    const firstMessage = await session.nextMessage()
    const firstReply = firstMessage?.control?.reply
    assert.ok(firstReply !== undefined)
    const firstAnswer = firstReply.answer
    assert.ok(firstAnswer?.kind === "built", `the first call was not answered with Swooey's answer: ${JSON.stringify(firstAnswer)}`)
    assert.equal(firstAnswer.summary.textEncoding, "singleByte")
    const secondMessage = await session.nextMessage()
    assert.ok(secondMessage !== undefined)
    const control = secondMessage.control
    assert.ok(control !== undefined)
    const reply = control.reply
    assert.ok(reply !== undefined)
    const answer = reply.answer
    assert.ok(answer?.kind === "built", `the second call got R-CT-35: ${JSON.stringify(answer)}`)
    const summary = answer.summary
    assert.ok(summary.textEncoding === "utf16LittleEndian" && summary.firstHandle === 4, "the connection's counter goes on")
    const head = new FlushAnswerHead({ codePage: secondMessage.codePage })
    const expected = FlushCallAnswerBuilder.answer(second, new ControlHandleCounter(4), head)
    assert.deepEqual(ControlFixtures.items(reply.payload).values[1], expected.value)
    assert.deepEqual(control.notes, [])
  })

  /** the report: the call's head and encoding, the answer's head with Swooey's own descriptor; kinds only (bug #150) */
  test("reportLines", async () => {
    const bytes = call("utf16LittleEndian").bytes
    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(ControlFixtures.part(0x00, 10, bytes)),
      ScriptStep.payload(ControlFixtures.part(0x06, 11, bytes, { msgInfo: 0x02 }))
    ])
    const session = await ControlFixtures.loggedOn(log)
    const message = await session.nextMessage()
    assert.ok(message !== undefined)
    const control = message.control
    assert.ok(control !== undefined)
    const lines = control.detailLines
    const text = lines.join("\n")
    assert.equal(lines[0], "call head (items before the function name): text encoding UTF-16LE (by its function name 01 02, 28 bytes)")
    assert.ok(text.includes("  item 3: 01 06, length 11; binary, 11 bytes; as R-CT-36 reads it: code page 4103, 2 byte(s) per character"), text)
    assert.ok(
      text.includes('  function name 01 02, length 28; "OLE_FLUSH_CALL" (text with a zero byte after each character (UTF-16LE-like))'),
      text
    )
    assert.ok(text.includes("answer head (Swooey's, texts UTF-16LE):"), text)
    const codePage = message.codePage
    const digits = String(codePage)
    assert.ok(
      text.includes(`  item 3: 01 06, length 11, Swooey's own; binary, 11 bytes; as R-CT-36 reads it: code page ${digits}, 1 byte(s) per character`),
      "the code page in force, one byte per character"
    )
    assert.ok(
      text.includes(
        "  item 4: 00 07, length 30, the call's; text with a zero byte after each character (UTF-16LE-like), 30 bytes, not shown; " +
          "kind: dotted IPv4 shape, then 1 space"
      ),
      text
    )
    assert.ok(text.includes("kind: upper-case word"), text)
    // Only the head items Readings R-CT-28 and R-CT-36 use are described: not the host 00 08.
    assert.ok(text.includes("  item 11: 00 08, length 34; value not described") && !text.includes("host-name shape"), text)
    for (const leak of ["198.51", "100.231", "QUACK", "POND", "DUCK", "MOAT", "WADDLE", "ZZDUCKER", "DCK"]) {
      assert.ok(!text.includes(leak), `${leak} leaked`)
    }
    assert.ok(control.summary.includes("function OLE_FLUSH_CALL (UTF-16LE, 28 bytes)"), control.summary)

    const oneWay = (await session.nextMessage())?.control
    assert.ok(oneWay !== undefined)
    assert.equal(oneWay.reply, undefined)
    assert.equal(oneWay.detailLines[0]?.endsWith("text encoding UTF-16LE (by its function name 01 02, 28 bytes)"), true)
  })

  /** the report never describes the user, the client or 00 15, and no four-digit value shows but a release (bug #150) */
  test("numericUserInReport", async () => {
    const pond = Call.pond("long")
    const user = utf8("4711        ")
    for (const entry of pond.head) {
      switch (entry.id) {
        case 0x0111:
        case 0x0009:
          entry.value = user.slice()
          break
        case 0x0015:
          entry.value = Uint8Array.of(0x35, 0x32, 0x30, 0x31) // a binary address whose bytes are digits
          break
        case 0x0013:
          entry.value = utf8("7890")
          break
      }
    }
    pond.parameterValue = utf8("2026")
    const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate()), ScriptStep.payload(ControlFixtures.part(0x00, 10, pond.bytes))])
    const session = await ControlFixtures.loggedOn(log)
    const control = (await session.nextMessage())?.control
    assert.ok(control !== undefined)
    assert.ok(control.reply?.answer?.kind === "built", `the long-form call was not answered: ${JSON.stringify(control.reply?.answer)}`)
    const lines = control.detailLines
    assert.ok(lines.includes("  item 5: 00 15, length 4; value not described"), lines.join("\n"))
    assert.ok(lines.includes('  item 13: 00 13, length 4; "7890"'), "a release of four digits shows")
    assert.ok(lines.includes("  item 18: 01 11, length 12; value not described"), lines.join("\n"))
    assert.ok(lines.includes("  item 19: 01 14, length 3; value not described"), lines.join("\n"))
    assert.ok(lines.includes("  item 26: 00 09, length 12; value not described"), lines.join("\n"))
    const text = [...lines, control.summary].join("\n")
    for (const leak of ["4711", '"2026"', "5201", "(01 11)", "(01 14)", "(00 09)", "kind: digits", "ZZDUCKER", "DCK", "WET"]) {
      assert.ok(!text.includes(leak), `${leak} leaked`)
    }
  })

  /** every head choice: the code page in force, 1100, the address, or the call's values (R-CT-36) */
  test("headChoices", async () => {
    const bytes = call("singleByte").bytes
    assert.deepEqual(ControlReadingsHeadValues.allCases, ["ownCodePage", "ownCodePage1100", "ownCodePageAndAddress", "echo"])
    assert.deepEqual(ControlReadingsHeadValues.allCases.map(ControlReadingsHeadValues.rawValue), [
      "own-code-page",
      "own-code-page-1100",
      "own-address",
      "echo"
    ])
    assert.equal(ControlReadingsHeadValues.title("ownCodePage"), "own code page in 01 06, the rest echoed (R-CT-36)")
    for (const choice of ControlReadingsHeadValues.allCases) {
      const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate()), ScriptStep.payload(ControlFixtures.part(0x00, 10, bytes))])
      const session = await ControlFixtures.loggedOn(log, new ControlReadings({ headValues: choice }))
      const message = await session.nextMessage()
      assert.ok(message !== undefined, choice)
      const reply = message.control?.reply
      assert.ok(reply !== undefined, choice)
      const expected = FlushCallAnswerBuilder.answer(bytes, new ControlHandleCounter(), ControlReadingsHeadValues.head(choice, message.codePage))
      assert.deepEqual(ControlFixtures.items(reply.payload).values[1], expected.value, choice)
      const own = expected.summary.ownHeadIDs
      switch (choice) {
        case "ownCodePage":
        case "ownCodePage1100":
          assert.deepEqual(own, [0x0106, 0x0011], choice)
          break
        case "ownCodePageAndAddress":
          assert.deepEqual(own, [0x0106, 0x0007, 0x0018, 0x0011], choice)
          break
        case "echo":
          assert.deepEqual(own, [0x0011], choice)
          break
      }
    }
    assert.deepEqual(ControlReadingsHeadValues.head("ownCodePage1100", 4110), new FlushAnswerHead({ codePage: 1100 }))
    assert.deepEqual(ControlReadingsHeadValues.head("echo", 4110), FlushAnswerHead.echo)
  })
})
