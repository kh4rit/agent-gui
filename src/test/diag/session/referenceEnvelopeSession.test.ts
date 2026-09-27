// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/ReferenceEnvelopeSessionTests.swift (MIT).

// The reference input envelope on the session (client-input.md §11): the machine keeps what the
// server last sent (R-CI-12, R-CI-15), the logon step takes the envelope from the session's
// identity, echoes the logon screen's step, SES, CODEPAGE_DIAG_GUI and screen state, returns the
// edited fields as an APPL DYNT_ATOM with the changed bit and leaves out a field the screen already
// shows (PV-0777), and names the password field in DYNT_FOCUS_1 with offset 0. Invented names and
// values follow docs/testing.md §8 (D15). The suite's statics (`ses`, `codePage`, `chl`, `scroll`,
// `reset`, `echoItems`, `gate`, `session`, `shapes`) live in sessionTestSupport.ts
// (`EnvelopeFixtures`).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientDataManager,
  ClientIdentities,
  ClientInputStep,
  CompressField,
  DiagHeader,
  DiagItemEncoder,
  DialogStepNumber,
  DyntAttributes,
  InputEnvelope,
  InputFocus
} from "../../../diag/codec/index.js"
import { LogonStep, LogonStepOptions, SessionState } from "../../../diag/session/index.js"
import { ByteWriter, concatBytes } from "../../../diag/wire/index.js"
import { EnvelopeFixtures, Fixtures, LogonFixtures, LogonScreens, ScriptStep, TransportLog, utf8 } from "../../support/sessionTestSupport.js"

describe("The reference input envelope on the session", () => {
  /** with the reference identity the logon step is echoes and DYNN CHL, the stage that logged on live (PV-0783) */
  test("referenceLogon", async () => {
    const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate(0x02)), ScriptStep.payload(LogonScreens.lobby())])
    const session = EnvelopeFixtures.session(log, ClientIdentities.reference)
    await session.start()
    const gate = await session.nextMessage()
    assert.ok(gate !== undefined)
    assert.ok(session.machine.echo.stepNumber === 1 && session.machine.echo.modeStat === 0x02)
    const step = await session.logOn(LogonFixtures.credentials(), gate)
    assert.equal(step.input.envelope, InputEnvelope.chlStage)
    assert.deepStrictEqual(step.roles, ["client", "user", "password", "language"], "the client the gate already shows goes back too (PV-0784)")

    const payload = log.sent.at(-1)
    assert.ok(payload !== undefined)
    assert.deepStrictEqual(payload.slice(0, 8), Uint8Array.of(0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00), "mode_stat echoed")
    const { items, body } = LogonScreens.walk(payload)
    assert.deepStrictEqual(EnvelopeFixtures.shapes(items), [
      "APPL ST_USER DIALOG_STEP_NUMBER",
      "SES",
      "APPL ST_R3INFO CODEPAGE_DIAG_GUI",
      "APPL DYNN CHL",
      "APPL DYNT DYNT_ATOM",
      "EOM"
    ])
    const values = items.map(item => item.valueRange.of(body).slice())
    assert.deepStrictEqual(values[0], Uint8Array.of(0, 0, 0, 1), "the gate's step, echoed")
    assert.deepStrictEqual(values[1], EnvelopeFixtures.ses)
    assert.deepStrictEqual(values[2], EnvelopeFixtures.codePage)
    assert.deepStrictEqual(values[3], EnvelopeFixtures.chl)
    const fields = LogonScreens.fields(values[4])
    assert.deepStrictEqual(
      fields.map(field => field.atom.row),
      [4, 6, 8, 11]
    )
    assert.ok(
      fields.every(field => (field.atom.dialogFlags.flag2 & 0x01) === 0x01),
      "the changed bit on every field"
    )
    assert.deepStrictEqual(
      fields.map(field => DyntAttributes.isPasswordField(field.atom.attributes)),
      [false, false, true, false]
    )
    assert.deepStrictEqual(fields[0].text, utf8("271"), "the client as the gate shows it")
    assert.equal(session.machine.lastStepNumber, 1)

    await session.nextMessage()
    assert.deepStrictEqual(session.state, SessionState.active)
  })

  /** the full reference envelope, chosen in the options, goes out in open-diag-go's order */
  test("fullReferenceLogon", async () => {
    const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate(0x02)), ScriptStep.payload(LogonScreens.lobby())])
    const session = EnvelopeFixtures.session(log, ClientIdentities.reference)
    await session.start()
    const gate = await session.nextMessage()
    assert.ok(gate !== undefined)
    const options = new LogonStepOptions()
    options.envelope = InputEnvelope.reference
    const step = await session.logOn(LogonFixtures.credentials(), gate, options)
    assert.equal(step.input.envelope, InputEnvelope.reference)
    assert.deepStrictEqual(step.roles, ["client", "user", "password", "language"])

    const payload = log.sent.at(-1)
    assert.ok(payload !== undefined)
    const { items, body } = LogonScreens.walk(payload)
    assert.deepStrictEqual(EnvelopeFixtures.shapes(items), [
      "APPL ST_USER DIALOG_STEP_NUMBER",
      "SES",
      "APPL ST_R3INFO CODEPAGE_DIAG_GUI",
      "APPL DYNN CHL",
      "APPL VARINFO SCROLL_INFOS2",
      "APPL CONTAINER RESET",
      "APPL DYNT DYNT_ATOM",
      "APPL DYNT DYNT_FOCUS_1",
      "XMLBLOB",
      "EOM"
    ])
    const values = items.map(item => item.valueRange.of(body).slice())
    assert.deepStrictEqual(values[4], EnvelopeFixtures.scroll)
    assert.deepStrictEqual(values[5], EnvelopeFixtures.reset)
    const fields = LogonScreens.fields(values[6])
    assert.deepStrictEqual(
      fields.map(field => field.atom.row),
      [4, 6, 8, 11]
    )
    assert.deepStrictEqual(
      fields.map(field => DyntAttributes.isPasswordField(field.atom.attributes)),
      [false, false, true, false]
    )
    assert.deepStrictEqual(values[7], Uint8Array.of(0x01, 0x00, 0x08, 0x00, 0x1e, 0x00, 0x00, 0x00, 0x00, 0x00), "the password field, offset 0")
    assert.deepStrictEqual(values[8], ClientDataManager.bareDocument)
  })

  /** the client goes back whether or not it differs from the screen's (PV-0784); an empty field stays out */
  test("changedClient", () => {
    const gate = LogonScreens.received(EnvelopeFixtures.gate())
    const options = new LogonStepOptions()
    options.envelope = InputEnvelope.reference
    const step = new LogonStep(gate, LogonFixtures.credentials({ client: "314" }), options)
    assert.deepStrictEqual(step.roles, ["client", "user", "password", "language"])
    const same = new LogonStep(gate, LogonFixtures.credentials({ client: "271", language: null }), options)
    assert.deepStrictEqual(same.roles, ["client", "user", "password"], "the unchanged client goes back; the empty language stays out")
    assert.deepStrictEqual(same.input.focus, new InputFocus(8, 30))
    assert.equal(
      String(same),
      "LogonStep(fields: client, user, password; ClientInputStep(fields: 3, SES: yes, DYNN CHL: no, envelope: full reference, focus: yes))"
    )
    const prefilled = new LogonStep(gate, LogonFixtures.credentials({ client: "", language: null }), options)
    assert.deepStrictEqual(prefilled.roles, ["client", "user", "password"], "no client typed: the one the server put there goes back")
    const { fields } = LogonFixtures.decode(prefilled)
    assert.deepStrictEqual(fields[0]?.text, utf8("271"))
  })

  /** with any other identity the logon step stays minimal; options choose the envelope */
  test("otherIdentities", async () => {
    const log = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate(0x02))])
    const session = EnvelopeFixtures.session(log, Fixtures.identity)
    await session.start()
    const gate = await session.nextMessage()
    assert.ok(gate !== undefined)
    const step = await session.logOn(LogonFixtures.credentials(), gate)
    assert.equal(step.input.envelope, InputEnvelope.minimal)
    assert.deepStrictEqual(step.roles, ["client", "user", "password", "language"])
    const sent = log.sent.at(-1)
    assert.ok(sent !== undefined)
    const { items } = LogonScreens.walk(sent)
    assert.deepStrictEqual(EnvelopeFixtures.shapes(items), ["APPL ST_USER DIALOG_STEP_NUMBER", "SES", "APPL4 DYNT DYNT_ATOM", "EOM"])
    assert.equal(sent[2], 0, "no mode_stat echo")

    const stageLog = new TransportLog([ScriptStep.payload(EnvelopeFixtures.gate())])
    const staged = EnvelopeFixtures.session(stageLog, ClientIdentities.reference)
    await staged.start()
    const stagedGate = await staged.nextMessage()
    assert.ok(stagedGate !== undefined)
    const options = new LogonStepOptions()
    options.envelope = InputEnvelope.echoStage
    await staged.logOn(LogonFixtures.credentials(), stagedGate, options)
    const stagedSent = stageLog.sent.at(-1)
    assert.ok(stagedSent !== undefined)
    const { items: stagedItems } = LogonScreens.walk(stagedSent)
    assert.deepStrictEqual(EnvelopeFixtures.shapes(stagedItems), [
      "APPL ST_USER DIALOG_STEP_NUMBER",
      "SES",
      "APPL ST_R3INFO CODEPAGE_DIAG_GUI",
      "APPL DYNT DYNT_ATOM",
      "EOM"
    ])

    const alone = new LogonStep(gate, LogonFixtures.credentials())
    assert.equal(alone.input.envelope, InputEnvelope.minimal, "the step on its own takes nil as minimal")
  })

  /** the machine keeps the latest of each echoed value; a later step echoes the server's step number */
  test("echoAcrossMessages", () => {
    const machine = Fixtures.awaitingMachine()
    machine.receive({ kind: "payload", payload: EnvelopeFixtures.gate() })
    assert.deepStrictEqual(machine.echo.ses, EnvelopeFixtures.ses)
    assert.deepStrictEqual(machine.echo.dynnCHL, EnvelopeFixtures.chl)
    assert.deepStrictEqual(machine.echo.codepageDiagGUI, EnvelopeFixtures.codePage)
    const later = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(6).bytes, later)
    later.bytes(LogonScreens.gateItems())
    const header = new DiagHeader({
      mode: 0,
      comFlag: 0,
      modeStat: 0xf0,
      errNo: 0,
      msgType: 0,
      msgInfo: 1,
      msgRC: 0,
      compress: CompressField.uncompressed
    })
    machine.receive({ kind: "payload", payload: concatBytes(header.bytes, later.toBytes()) })
    assert.ok(machine.echo.stepNumber === 6 && machine.echo.modeStat === 0xf0)
    assert.deepStrictEqual(machine.echo.ses, EnvelopeFixtures.ses, "kept from the gate")

    const step = new ClientInputStep({ envelope: InputEnvelope.reference })
    step.setFunctionKey(3)
    const reaction = machine.send(step)
    const payload = reaction.send[0]
    assert.ok(payload !== undefined)
    assert.equal(payload[2], 0xf0)
    const { items, body } = LogonScreens.walk(payload)
    assert.deepStrictEqual(items[0].valueRange.of(body).slice(), Uint8Array.of(0, 0, 0, 6))
    assert.equal(machine.lastStepNumber, 6)
    assert.ok(!EnvelopeFixtures.shapes(items).includes("XMLBLOB"), "no DATAMANAGER with a function key")
  })
})
