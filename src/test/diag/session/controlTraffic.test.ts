// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/ControlTrafficTests.swift (MIT).

// The session's side of the control transport (docs/protocol/controls/transport.md §2.3, §2.5):
// after the logon, interim messages that the session neither answers nor shows (Reading R-CT-22),
// a server call in parts (R-CT-23) that the session answers part by part with an empty RFC_TR_MOR
// (R-CT-27) and as a whole with Swooey's own answer (R-CT-28) or, for a call it cannot read, the
// empty RFC_TR_RET (R-CT-35), each in SAP GUI's three-item reply message (R-CT-26); and the older
// replies, still switchable (R-CT-24, R-CT-25, the envelope shape). The shapes are the owner's
// server's (PV-0904, PV-0905), the values invented (docs/testing.md §8, D15).
//
// The Swift suite's static helpers (message, interim, part, call, loggedOn, items) are
// `ControlFixtures` in src/test/support/sessionTestSupport.ts, which Bug0150Tests shares.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientIdentities,
  ClientInput,
  ClientInputStep,
  ClientMessageEncoder,
  ComFlag,
  CompressField,
  ControlHandleCounter,
  DiagHeader,
  DiagItemEncoder,
  DialogStepNumber,
  FlushAnswerHead,
  FlushCallAnswerBuilder,
  InputEnvelope,
  RFCStreamSummary,
  RFCTransferValue
} from "../../../diag/codec/index.js"
import {
  ControlReadings,
  ControlReadingsCallAnswer,
  ControlReadingsHeadValues,
  ControlReadingsPartReply,
  ControlReadingsReplyShape,
  ControlTraffic,
  ControlTrafficReply,
  SessionState
} from "../../../diag/session/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { InventedFlushCall } from "../../support/inventedFlushCall.js"
import { ControlFixtures, EnvelopeFixtures, Fixtures, LogonScreens, ScriptStep, TransportLog } from "../../support/sessionTestSupport.js"

const Self = ControlFixtures

describe("Control traffic: interim messages, calls in parts and the automatic replies", () => {
  /** the owner's sequence: three interim messages, a call in two parts, each part answered, then the screen */
  test("liveSequence", async () => {
    const call = Self.call
    const first = call.slice(0, 200)
    const rest = call.slice(200)
    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(Self.interim(4, 2)),
      ScriptStep.payload(Self.interim(5, 1)),
      ScriptStep.payload(Self.interim(6, 0)),
      ScriptStep.payload(Self.part(0x04, 7, first)),
      ScriptStep.payload(Self.part(0x00, 8, rest)),
      ScriptStep.payload(LogonScreens.lobby())
    ])
    const session = await Self.loggedOn(log)
    assert.equal(log.sent.length, 2, "the first message and the logon step")

    for (let step = 4; step <= 6; step++) {
      const interim = await session.nextMessage()
      assert.ok(interim !== undefined)
      const control = interim.control
      assert.ok(control !== undefined, `message of step ${step}`)
      assert.ok(control.isInterim && control.stopTrans && !control.showsScreen && control.serverContinues)
      assert.ok(control.reply === undefined && control.items.length === 0)
      assert.equal(log.sent.length, 2, "an interim message is never answered (R-CT-22)")
    }
    assert.equal(session.diagnostics.interimMessages, 3)

    const partMessage = await session.nextMessage()
    const part = partMessage?.control
    assert.ok(part !== undefined)
    assert.ok(!part.isInterim && !part.carriesScreen, "the identity block alone is no screen")
    assert.deepEqual(part.items, [{ sid: 0x04, length: 200, name: "RFC_TR_MOR" }])
    assert.deepEqual(part.call, { kind: "part", parts: 1, bytes: 200 })
    const partReply = part.reply
    assert.ok(partReply !== undefined)
    assert.ok(partReply.kind.kind === "partReply" && partReply.kind.value === "emptyMore" && partReply.sid === "mor" && partReply.stepNumber === 7)
    assert.ok(partReply.shape === "threeItems" && partReply.answer === undefined)
    assert.equal(log.sent.length, 3, "the part is answered before the message is handed over")
    assert.deepEqual(log.sent[log.sent.length - 1], partReply.payload)
    const { shapes, values } = Self.items(partReply.payload)
    assert.deepEqual(shapes, ["APPL ST_USER DIALOG_STEP_NUMBER", "APPL RFC_TR RFC_TR_MOR", "EOM"], "R-CT-26 and R-CT-27: three items")
    assert.deepEqual(values[0], Uint8Array.of(0, 0, 0, 7), "the part's step; an empty RFC_TR_MOR")
    assert.equal(values[1].length, 0, "the part's step; an empty RFC_TR_MOR")
    assert.deepEqual(partReply.payload.slice(0, 8), Uint8Array.of(0, 0, 0, 0, 0, 0x01, 0, 0), "msg_info 0x01 (PV-0908)")
    assert.ok(part.summary.endsWith("replied: step 7, RFC_TR_MOR, empty"))

    const endMessage = await session.nextMessage()
    const end = endMessage?.control
    assert.ok(end !== undefined)
    const progress = end.call
    assert.ok(progress?.kind === "complete", `the call did not complete: ${JSON.stringify(progress)}`)
    const { parts, bytes, summary } = progress
    assert.ok(parts === 2 && bytes === call.length)
    assert.ok(summary.itemCount === 3 && summary.reachedEnd && summary.stop === undefined)
    assert.ok(summary.functionName === undefined && summary.withheldFunctionNameLength === 11, "an invented name is withheld")
    const answer = end.reply
    assert.ok(answer !== undefined)
    assert.ok(answer.kind.kind === "callAnswer" && answer.kind.value === "built" && answer.sid === "ret" && answer.stepNumber === 8)
    assert.deepEqual(answer.answer, { kind: "fallback", error: { kind: "notAFlushCall" } }, "an invented function: Swooey cannot read it")
    const { shapes: answerShapes, values: answerValues } = Self.items(answer.payload)
    assert.deepEqual(answerShapes, ["APPL ST_USER DIALOG_STEP_NUMBER", "APPL RFC_TR RFC_TR_RET", "EOM"], "R-CT-35: the empty RFC_TR_RET, in three items")
    assert.equal(answerValues[1].length, 0, "R-CT-35: the empty RFC_TR_RET, in three items")
    assert.deepEqual(end.notes, [
      "Swooey could not read the call (the call is not OLE_FLUSH_CALL); answered with an empty RFC_TR_RET (R-CT-35)"
    ])
    assert.ok(
      end.summary.endsWith(
        "replied: step 8, RFC_TR_RET, empty (R-CT-35: the call is not OLE_FLUSH_CALL); " +
          "Swooey could not read the call (the call is not OLE_FLUSH_CALL); answered with an empty RFC_TR_RET (R-CT-35)"
      ),
      end.summary
    )
    assert.ok(end.progressText.endsWith("answered empty: Swooey could not read the call…"), end.progressText)
    assert.equal(log.sent.length, 4)
    assert.ok(session.diagnostics.controlParts === 2 && session.diagnostics.controlCalls === 1 && session.diagnostics.controlReplies === 2)

    const lobby = await session.nextMessage()
    assert.ok(lobby !== undefined)
    assert.equal(lobby.control, undefined)
    assert.deepEqual(session.state, SessionState.active)
    assert.equal(log.sent.length, 4, "a screen gets no automatic reply")
  })

  /** the defaults: three items, an empty RFC_TR_MOR after a part, Swooey's own answer after a call (R-CT-26 to R-CT-28) */
  test("defaults", () => {
    const readings = new ControlReadings()
    assert.ok(readings.replyShape === "threeItems" && readings.partReply === "emptyMore" && readings.callAnswer === "built")
    assert.equal(readings.envelope, undefined)
    assert.ok(readings.objectResultTypes)
    assert.deepEqual(
      ControlReadingsPartReply.allCases,
      ["emptyMore", "envelopeOnly", "emptyRequest", "emptyMoreBack", "none"],
      "the default, the envelope alone tried live, then the sids in order: no ranking"
    )
    assert.deepEqual(ControlReadingsCallAnswer.allCases, ["built", "emptyReturn", "emptyError", "none"])
    assert.deepEqual(ControlReadingsReplyShape.allCases, ["threeItems", "envelope"])
    assert.ok(!ControlReadingsPartReply.title("emptyMore").includes("seen only from servers"))
    assert.equal(ControlReadingsPartReply.title("emptyMore"), "an empty RFC_TR_MOR, as SAP GUI replies (R-CT-27)")
    assert.ok(ControlReadingsCallAnswer.title("built") === "Swooey's own answer (R-CT-28)" && ControlReadingsCallAnswer.sid("built") === "ret")
    assert.equal(ControlReadingsReplyShape.title("threeItems"), "three items, as SAP GUI replies (R-CT-26)")
  })

  /** the object-result experiment reaches the automatic answer (#189) */
  for (const enabled of [false, true]) {
    test(`objectResultTypes(enabled: ${enabled})`, async () => {
      const call = InventedFlushCall.pond().bytes
      const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate()), ScriptStep.payload(Self.part(0x00, 2, call))])
      const readings = new ControlReadings()
      readings.objectResultTypes = enabled
      const session = await Self.loggedOn(log, readings)
      const control = (await session.nextMessage())?.control
      assert.ok(control !== undefined)
      const answer = control.reply?.answer
      assert.ok(answer?.kind === "built", "missing built control answer")
      assert.equal(answer.summary.objectDescriptorsRewritten, enabled ? 2 : 0)
    })
  }

  /** the switchable replies: an empty RFC_TR_RQT, RFC_TR_MOR or RFC_TR_MOB after a part, RFC_TR_ERR after a call, or nothing */
  test("switchableReplies", async () => {
    const choices: [ControlReadingsPartReply, string][] = [
      ["emptyRequest", "APPL RFC_TR RFC_TR_RQT"],
      ["emptyMore", "APPL RFC_TR RFC_TR_MOR"],
      ["emptyMoreBack", "APPL RFC_TR RFC_TR_MOB"]
    ]
    for (const [partReply, expected] of choices) {
      const log = new TransportLog([
        ScriptStep.payload(EnvelopeFixtures.gate()),
        ScriptStep.payload(Self.part(0x04, 2, [1, 2, 3])),
        ScriptStep.payload(Self.part(0x00, 3, [4]))
      ])
      const session = await Self.loggedOn(log, new ControlReadings({ partReply, callAnswer: "emptyError" }))
      const part = await session.nextMessage()
      const reply = part?.control?.reply
      assert.ok(reply !== undefined, partReply)
      assert.equal(Self.items(reply.payload).shapes[1], expected, partReply)
      assert.equal(reply.sid, ControlReadingsPartReply.sid(partReply), partReply)
      const end = await session.nextMessage()
      const endReply = end?.control?.reply
      assert.ok(endReply !== undefined, partReply)
      assert.equal(Self.items(endReply.payload).shapes[1], "APPL RFC_TR RFC_TR_ERR", partReply)
    }

    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(Self.part(0x04, 2, [1])),
      ScriptStep.payload(Self.part(0x00, 3, [2]))
    ])
    const session = await Self.loggedOn(log, new ControlReadings({ partReply: "none", callAnswer: "none" }))
    const part = await session.nextMessage()
    assert.ok(part !== undefined)
    assert.equal(part.control?.reply, undefined)
    assert.deepEqual(part.control?.notes, ["the part is not acknowledged: the Readings say none"])
    assert.equal(part.control?.serverContinues, false, "nothing sent: the window stops waiting")
    const end = await session.nextMessage()
    assert.ok(end !== undefined)
    assert.equal(end.control?.reply, undefined)
    assert.deepEqual(end.control?.notes, ["the call is not answered: the Readings say none"])
    assert.equal(log.sent.length, 2)
  })

  /** a fragmented one-way call consumes its MOR prefix without answering the final RNB (#179) */
  for (const msgInfo of [0x01, 0x02]) {
    test(`fragmentedOneWay(msgInfo: ${msgInfo})`, async () => {
      const split = 200
      const call = Self.call
      const log = new TransportLog([
        ScriptStep.payload(EnvelopeFixtures.gate()),
        ScriptStep.payload(Self.part(0x04, 2, call.slice(0, split))),
        ScriptStep.payload(Self.part(0x06, 2, call.slice(split), { msgInfo })),
        ScriptStep.payload(Self.part(0x00, 3, call))
      ])
      const session = await Self.loggedOn(log)
      const part = await session.nextMessage()
      assert.equal(part?.control?.reply?.sid, "mor")
      const final = await session.nextMessage()
      const traffic = final?.control
      assert.ok(traffic !== undefined)
      assert.deepEqual(traffic.callBytes, call)
      assert.deepEqual(traffic.call, { kind: "oneWay", bytes: call.length, summary: new RFCStreamSummary(call) })
      assert.equal(traffic.reply, undefined)
      assert.equal(log.sent.length, 3, "only logon and the MOR acknowledgement follow the initial message")
      const next = await session.nextMessage()
      assert.deepEqual(next?.control?.callBytes, call, "the consumed prefix must not leak into the next call")
      assert.ok(next?.control?.reply !== undefined)
    })
  }

  /** a header-only NOP EOP settles the step without replacing its screen (#179) */
  test("noOperationEnd", async () => {
    const header = new DiagHeader({
      mode: 0,
      comFlag: ComFlag.nop | ComFlag.eop,
      modeStat: 0,
      errNo: 0,
      msgType: 0,
      msgInfo: 1,
      msgRC: 0,
      compress: CompressField.uncompressed
    })
    const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate()), ScriptStep.payload(header.bytes), ScriptStep.payload(LogonScreens.lobby())])
    const session = await Self.loggedOn(log)
    const end = await session.nextMessage()
    const traffic = end?.control
    assert.ok(traffic !== undefined)
    assert.ok(!traffic.showsScreen && !traffic.serverContinues)
    assert.ok(traffic.reply === undefined && log.sent.length === 2)
    const lobby = await session.nextMessage()
    assert.equal(lobby?.control, undefined, "ordinary screens still reach the renderer")
  })

  /** NOP handling does not swallow content or other flag combinations (#179) */
  test("noOperationBoundaries", async () => {
    const lobby = LogonScreens.lobby()
    lobby[1] = ComFlag.nop | ComFlag.eop
    const only = (comFlag: number) =>
      new DiagHeader({ mode: 0, comFlag, modeStat: 0, errNo: 0, msgType: 0, msgInfo: 1, msgRC: 0, compress: CompressField.uncompressed }).bytes
    for (const payload of [lobby, only(ComFlag.nop), only(ComFlag.eop)]) {
      const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate()), ScriptStep.payload(payload)])
      const session = await Self.loggedOn(log)
      const message = await session.nextMessage()
      assert.ok(message !== undefined)
      assert.equal(message.control, undefined)
    }
  })

  /** what the session does not understand it notes and never answers: a one-way call, an unknown sid, a part in an interim message */
  test("notUnderstood", async () => {
    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(Self.part(0x06, 2, Self.call)),
      ScriptStep.payload(Self.part(0x0b, 3, [9])),
      ScriptStep.payload(Self.part(0x04, 4, [1], { msgInfo: 0x02 }))
    ])
    const session = await Self.loggedOn(log)
    const oneWay = await session.nextMessage()
    assert.ok(oneWay !== undefined)
    const call = oneWay.control?.call
    assert.ok(call?.kind === "oneWay", `no one-way call: ${String(oneWay.control)}`)
    assert.ok(call.bytes === Self.call.length && call.summary.itemCount === 3)
    assert.equal(oneWay.control?.reply, undefined)
    assert.deepEqual(oneWay.control?.notes, ["nothing to answer; if the server waits, Enter sends the screen again"])
    const unknown = await session.nextMessage()
    assert.ok(unknown !== undefined)
    assert.equal(unknown.control?.items[0]?.name, "RFC_TR_RES")
    assert.equal(unknown.control?.notes[0], "RFC_TR_RES from the server is not understood; not answered")
    const interim = await session.nextMessage()
    assert.ok(interim !== undefined)
    assert.equal(interim.control?.isInterim, true)
    assert.deepEqual(interim.control?.notes, ["an interim message carried a call part; not answered (R-CT-22)"])
    assert.equal(log.sent.length, 2, "nothing answered")
    assert.equal(interim.control?.summary.startsWith("interim message (msg_info, R-CT-22); RFC_TR: RFC_TR_MOR 1 bytes"), true)
  })

  /** the three items whatever the envelope: minimal, echoes and DYNN CHL, full reference; mode_stat echoed only with echoes */
  test("threeItemsWhateverTheEnvelope", async () => {
    const cases: [string, InputEnvelope, number][] = [
      ["minimal", InputEnvelope.minimal, 0],
      ["chlStage", InputEnvelope.chlStage, 0x0c],
      ["reference", InputEnvelope.reference, 0x0c]
    ]
    for (const [name, envelope, modeStat] of cases) {
      const log = new TransportLog([
        ScriptStep.payload(EnvelopeFixtures.gate()),
        ScriptStep.payload(Self.part(0x04, 9, [1], { modeStat: 0x0c })),
        ScriptStep.payload(Self.part(0x00, 9, [2], { modeStat: 0x0c }))
      ])
      const session = await Self.loggedOn(log, new ControlReadings({ envelope }), Fixtures.identity)
      for (const sid of ["RFC_TR_MOR", "RFC_TR_RET"]) {
        const message = await session.nextMessage()
        const reply = message?.control?.reply
        assert.ok(reply !== undefined, `${name}, ${sid}`)
        const { shapes, values } = Self.items(reply.payload)
        assert.deepEqual(shapes, ["APPL ST_USER DIALOG_STEP_NUMBER", `APPL RFC_TR ${sid}`, "EOM"], `${name}, ${sid}`)
        assert.deepEqual(values[0], Uint8Array.of(0, 0, 0, 9), `${name}, ${sid}: the replied message's step, whatever the envelope`)
        assert.deepEqual(reply.payload.slice(0, 8), Uint8Array.of(0, 0, modeStat, 0, 0, 0x01, 0, 0), `${name}, ${sid}`)
      }
    }
  })

  /** the envelope shape reproduces the replies of transport.md §2.3: echoes, DYNN CHL, DYNT_NOFOCUS, msg_info 0 */
  test("envelopeShape", async () => {
    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(Self.part(0x04, 7, [1])),
      ScriptStep.payload(Self.part(0x00, 8, [2]))
    ])
    const old = new ControlReadings({ partReply: "envelopeOnly", callAnswer: "emptyReturn", replyShape: "envelope" })
    const session = await Self.loggedOn(log, old)
    const part = (await session.nextMessage())?.control?.reply
    assert.ok(part !== undefined)
    assert.ok(
      part.kind.kind === "partReply" && part.kind.value === "envelopeOnly" && part.sid === undefined && part.stepNumber === 7 && part.shape === "envelope"
    )
    const { shapes, values } = Self.items(part.payload)
    assert.deepEqual(
      shapes,
      ["APPL ST_USER DIALOG_STEP_NUMBER", "SES", "APPL ST_R3INFO CODEPAGE_DIAG_GUI", "APPL DYNN CHL", "APPL DYNT DYNT_NOFOCUS", "EOM"],
      "R-CT-24: the step echoed, no RFC_TR item, the echoes of echoes and DYNN CHL, no field"
    )
    assert.deepEqual(values[0], Uint8Array.of(0, 0, 0, 7))
    assert.deepEqual(values[1], EnvelopeFixtures.ses)
    assert.deepEqual(values[3], EnvelopeFixtures.chl)
    assert.deepEqual(part.payload.slice(0, 8), new Uint8Array(8))
    const encoder = new ClientMessageEncoder(ClientIdentities.reference, Fixtures.terminal)
    const step = new ClientInputStep({ envelope: InputEnvelope.controlReply(InputEnvelope.chlStage) })
    step.rfcTransfer = new RFCTransferValue("ret")
    const answer = (await session.nextMessage())?.control?.reply
    assert.ok(answer !== undefined)
    assert.ok(answer.kind.kind === "callAnswer" && answer.kind.value === "emptyReturn" && answer.answer === undefined)
    assert.deepEqual(answer.payload, ClientInput.inputMessage(encoder, step, 0, session.machine.echoFor(0)), "the bytes of Swooey 0.0.67's answer")
    assert.deepEqual(Self.items(answer.payload).shapes, [
      "APPL ST_USER DIALOG_STEP_NUMBER",
      "APPL RFC_TR RFC_TR_RET",
      "SES",
      "APPL ST_R3INFO CODEPAGE_DIAG_GUI",
      "APPL DYNN CHL",
      "APPL DYNT DYNT_NOFOCUS",
      "EOM"
    ])
  })

  /** the envelope alone after a part goes in the envelope shape whatever the reply shape, as in issue #133's run (R-CT-24) */
  test("envelopeAloneInAnyShape", async () => {
    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(Self.part(0x04, 7, [1])),
      ScriptStep.payload(Self.part(0x00, 8, [2]))
    ])
    const readings = new ControlReadings({ partReply: "envelopeOnly" })
    assert.equal(readings.replyShape, "threeItems")
    const session = await Self.loggedOn(log, readings)
    const part = (await session.nextMessage())?.control?.reply
    assert.ok(part !== undefined)
    assert.ok(
      part.kind.kind === "partReply" && part.kind.value === "envelopeOnly" && part.sid === undefined && part.stepNumber === 7 && part.shape === "envelope"
    )
    assert.deepEqual(
      Self.items(part.payload).shapes,
      ["APPL ST_USER DIALOG_STEP_NUMBER", "SES", "APPL ST_R3INFO CODEPAGE_DIAG_GUI", "APPL DYNN CHL", "APPL DYNT DYNT_NOFOCUS", "EOM"],
      "never a message of DIALOG_STEP_NUMBER and EOM alone"
    )
    assert.deepEqual(part.payload.slice(0, 8), new Uint8Array(8), "msg_info 0, as the envelope replies went")
    const answer = (await session.nextMessage())?.control?.reply
    assert.ok(answer !== undefined)
    assert.ok(answer.shape === "threeItems" && answer.sid === "ret", "the call's answer keeps the reply shape")
    assert.deepEqual(Self.items(answer.payload).shapes, ["APPL ST_USER DIALOG_STEP_NUMBER", "APPL RFC_TR RFC_TR_RET", "EOM"])
  })

  /** an envelope that counts its own steps: a control reply carries the replied step and never moves the count back (R-CT-26) */
  test("ownStepCount", async () => {
    const log = new TransportLog([
      ScriptStep.payload(EnvelopeFixtures.gate()),
      ScriptStep.payload(Self.part(0x04, 2, [1])),
      ScriptStep.payload(Self.part(0x04, 30, [2]))
    ])
    const session = await Self.loggedOn(log, new ControlReadings(), Fixtures.identity)
    function sentStep(): Uint8Array {
      const last = log.sent[log.sent.length - 1]
      assert.ok(last !== undefined)
      return Self.items(last).values[0]
    }
    const logon = session.machine.lastStepNumber
    for (let index = 0; index < 3; index++) {
      assert.ok(await session.send(new ClientInputStep()))
    }
    assert.ok(session.machine.lastStepNumber === logon + 3 && logon + 3 > 2)
    const low = (await session.nextMessage())?.control?.reply
    assert.ok(low !== undefined)
    assert.ok(low.stepNumber === 2 && low.shape === "threeItems")
    assert.deepEqual(Self.items(low.payload).values[0], Uint8Array.of(0, 0, 0, 2), "the replied message's step (R-CT-26)")
    assert.equal(session.machine.lastStepNumber, logon + 3, "the own count does not move back")
    assert.ok(await session.send(new ClientInputStep()))
    assert.deepEqual(sentStep(), new DialogStepNumber(logon + 4).bytes, "the next ordinary step goes on from the own count")
    const high = (await session.nextMessage())?.control?.reply
    assert.ok(high !== undefined)
    assert.equal(high.stepNumber, 30)
    assert.ok(await session.send(new ClientInputStep()))
    assert.deepEqual(sentStep(), Uint8Array.of(0, 0, 0, 31), "a higher replied step moves the count on: no number goes out twice after it")
  })

  /** a flush call in three RFC_TR_MOR parts and a REQ: three empty RFC_TR_MOR with each part's step, then Swooey's answer */
  test("flushCallInParts", async () => {
    const call = InventedFlushCall.pond().bytes
    const size = Math.floor((call.length + 3) / 4)
    const parts: Uint8Array[] = []
    for (let start = 0; start < call.length; start += size) parts.push(call.slice(start, Math.min(start + size, call.length)))
    assert.equal(parts.length, 4)
    const events: ScriptStep[] = [ScriptStep.payload(EnvelopeFixtures.gate())]
    parts.forEach((part, index) => {
      events.push(ScriptStep.payload(Self.part(index === 3 ? 0x00 : 0x04, 10 + index, part)))
    })
    events.push(ScriptStep.payload(Self.part(0x00, 20, call)))
    const log = new TransportLog(events)
    const session = await Self.loggedOn(log)
    for (let index = 0; index < 3; index++) {
      const reply = (await session.nextMessage())?.control?.reply
      assert.ok(reply !== undefined, `part ${index}`)
      assert.ok(reply.kind.kind === "partReply" && reply.kind.value === "emptyMore" && reply.sid === "mor" && reply.stepNumber === 10 + index, `part ${index}`)
      assert.equal(Self.items(reply.payload).values[1].length, 0, `part ${index}`)
    }
    const end = await session.nextMessage()
    assert.ok(end !== undefined)
    const control = end.control
    assert.ok(control !== undefined)
    const reply = control.reply
    assert.ok(reply !== undefined)
    // The default head (Reading R-CT-36) with the session's code page in force; the pond's 01 06
    // is no descriptor Swooey reads, so it goes out as the call's value, with a note.
    const head = ControlReadingsHeadValues.head("ownCodePage", end.codePage)
    assert.equal(new ControlReadings().headValues, "ownCodePage")
    assert.deepEqual(head, new FlushAnswerHead({ codePage: end.codePage }))
    const expected = FlushCallAnswerBuilder.answer(call, new ControlHandleCounter(), head)
    assert.ok(expected.summary.headNotes.length === 1)
    assert.deepEqual(expected.summary.ownHeadIDs, [0x0011])
    assert.ok(reply.stepNumber === 13 && reply.sid === "ret")
    assert.deepEqual(reply.answer, { kind: "built", summary: expected.summary })
    assert.deepEqual(Self.items(reply.payload).values[1], expected.value, "the builder's answer to the joined parts")
    assert.deepEqual(control.notes, [])
    assert.ok(control.summary.includes(`replied: step 13, RFC_TR_RET, Swooey's answer (R-CT-28): ${expected.summary.description}`), control.summary)
    assert.ok(control.progressText.endsWith("answered with Swooey's own answer…"), control.progressText)
    const second = (await session.nextMessage())?.control?.reply
    assert.ok(second !== undefined)
    const next = FlushCallAnswerBuilder.answer(call, expected.handles, head)
    const secondValue = Self.items(second.payload).values[1]
    assert.deepEqual(second.answer, { kind: "built", summary: next.summary }, "the connection's counter goes on: O4 next")
    assert.deepEqual(secondValue, next.value, "the connection's counter goes on: O4 next")
    assert.equal(next.summary.firstHandle, 4)
    assert.ok(session.diagnostics.controlReplies === 5 && session.diagnostics.controlCalls === 2)
  })

  /** an empty RFC_TR_MOR from the server is no part: no reply, a note */
  test("emptyPartFromTheServer", async () => {
    const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate()), ScriptStep.payload(Self.part(0x04, 3, []))])
    const session = await Self.loggedOn(log)
    const message = await session.nextMessage()
    const control = message?.control
    assert.ok(control !== undefined)
    assert.ok(control.reply === undefined && control.call === undefined)
    assert.equal(control.notes[0], "an empty RFC_TR_MOR from the server is no call part; not answered (R-CT-27)")
    assert.equal(log.sent.length, 2)
  })

  /** a message with a screen and a call: shown, and answered, and the server goes on */
  test("screenWithCall", async () => {
    const items = new ByteWriter()
    items.bytes(EnvelopeFixtures.echoItems(5))
    items.bytes(LogonScreens.gateItems({ program: "ZZMOATLOBBY" }))
    const call = Self.call
    DiagItemEncoder.appendAPPL(ApplItem.rfcTR("req"), call, items)
    const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate()), ScriptStep.payload(Self.message(0x01, items.toBytes()))])
    const session = await Self.loggedOn(log)
    const screen = await session.nextMessage()
    const control = screen?.control
    assert.ok(control !== undefined)
    assert.ok(control.carriesScreen && control.showsScreen && control.serverContinues)
    assert.equal(control.reply?.sid, "ret")
    assert.ok(control.progressText.startsWith(`Control data received (1 part(s), ${Self.call.length} bytes)`), control.progressText)
    assert.deepEqual(session.state, SessionState.active)
  })

  /** the progress lines and the report line name kinds, sids and counts only */
  test("descriptions", () => {
    const traffic = new ControlTraffic({
      isInterim: false,
      stopTrans: false,
      carriesScreen: false,
      items: [{ sid: 0x04, length: 29_737, name: "RFC_TR_MOR" }]
    })
    traffic.call = { kind: "part", parts: 1, bytes: 29_737 }
    assert.equal(traffic.progressText, "Receiving control data: part 1, 29 KB so far…")
    assert.equal(traffic.summary, "RFC_TR: RFC_TR_MOR 29737 bytes; call part 1, 29737 bytes so far")
    const interim = new ControlTraffic({ isInterim: true, stopTrans: true, carriesScreen: false, items: [] })
    assert.equal(interim.progressText, "The server is busy (an interim message, STOP_TRANS)…")
    assert.equal(interim.summary, "interim message (msg_info, R-CT-22); STOP_TRANS")
    const reply = new ControlTrafficReply({ kind: { kind: "partReply", value: "emptyMore" }, sid: "mor", stepNumber: 7, payload: Uint8Array.of(1, 2, 3) })
    assert.equal(`${reply}`, "ControlTraffic.Reply(step 7, RFC_TR_MOR, 3 bytes)")
    assert.deepEqual(ControlReadingsPartReply.allCases.map(ControlReadingsPartReply.rawValue), ["empty-mor", "envelope-only", "empty-rqt", "empty-mob", "none"])
    assert.deepEqual(ControlReadingsCallAnswer.allCases.map(ControlReadingsCallAnswer.rawValue), ["built", "empty-ret", "empty-err", "none"])
    assert.deepEqual(ControlReadingsReplyShape.allCases.map(ControlReadingsReplyShape.rawValue), ["three-items", "envelope"])
  })
})
