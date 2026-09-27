// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/LogonStepTests.swift (MIT).

// The logon step (credentials.md §5.1; client-input.md §1–§3; server-screen.md R-SS-5, R-SS-9):
// built from the logon screen's field structure, the dlg flags as received (Reading R-CI-4), the
// reference client's SES (R-CI-5), and the password from a Secret that never prints. Invented
// names follow docs/testing.md §8 (D15). `LogonStepTests.credentials` and `decode` live in
// sessionTestSupport.ts (`LogonFixtures`).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ApplItem,
  ClientInput,
  ClientMessageEncoder,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAttributes,
  DyntElementType,
  SESValue,
  type CompressField
} from "../../../diag/codec/index.js"
import {
  DisconnectReason,
  LogonStep,
  LogonStepError,
  LogonStepOptions,
  SessionState,
  describeLogonStepError,
  type LogonStepErrorInfo
} from "../../../diag/session/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { cat, throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures, LogonFixtures, LogonScreens, ScriptStep, TransportLog, scriptedSession, utf8 } from "../../support/sessionTestSupport.js"

/** Swift `await #expect(throws: LogonStepError.case) { … }`: `promise` rejects with a `LogonStepError` whose `info` is `info`. */
async function rejectsWith(promise: Promise<unknown>, info: LogonStepErrorInfo, message?: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof LogonStepError, `${message ?? ""} expected LogonStepError, got ${String(error)}`)
      assert.deepStrictEqual(error.info, info, message)
      return true
    },
    message
  )
}

describe("The logon step from the logon screen's field structure", () => {
  const credentials = LogonFixtures.credentials

  /** client, user, password and language in the screen's atom order, at their positions, with their flags as received */
  test("fourFields", () => {
    const screen = LogonScreens.received(LogonScreens.gate())
    const step = new LogonStep(screen, credentials())
    assert.deepStrictEqual(step.roles, ["client", "user", "password", "language"])
    const { items, fields } = LogonFixtures.decode(step)
    assert.deepStrictEqual(items[0], { kind: "ses", value: new SESValue({ eventArray: 1 }) }, "the reference client's SES first (R-CI-5)")
    assert.equal(items.length, 2)
    assert.deepStrictEqual(
      fields.map(field => field.atom.row),
      [4, 6, 8, 11]
    )
    assert.ok(fields.every(field => field.atom.etype.kind === "efield2" && field.atom.col === 30 && field.atom.block === 1))
    assert.deepStrictEqual(
      fields.map(field => field.text),
      [utf8("271"), utf8("ZZGATEKEEPER"), utf8(LogonFixtures.password), utf8("EN")]
    )
    assert.deepStrictEqual(
      fields.map(field => [field.atom.dialogFlags.flag1, field.atom.dialogFlags.flag2]),
      [
        [0, 0],
        [0, 1],
        [4, 1],
        [0, 0]
      ],
      "the dlg flags as the screen sent them (Reading R-CI-4)"
    )
    assert.deepStrictEqual(
      fields.map(field => DyntAttributes.isPasswordField(field.atom.attributes)),
      [false, false, true, false]
    )
    const widths = fields.map(field => {
      const payload = field.atom.payload
      if (payload.kind !== "field") return []
      return [payload.value.mlen, payload.value.maxNrChars]
    })
    assert.deepStrictEqual(widths, [
      [3, 3],
      [12, 12],
      [12, 40],
      [2, 2]
    ])
  })

  /** no client typed: the client the server put in its field goes back (PV-0784); an empty language stays out; the password always goes */
  test("optionalFields", () => {
    const screen = LogonScreens.received(LogonScreens.gate())
    const step = new LogonStep(screen, credentials({ client: "", language: null }))
    assert.deepStrictEqual(step.roles, ["client", "user", "password"])
    assert.deepStrictEqual(LogonFixtures.decode(step).fields[0]?.text, utf8("271"), "the gate's own client")
    const empty = new LogonStep(screen, credentials({ client: "", user: "", password: "", language: "" }))
    assert.deepStrictEqual(empty.roles, ["client", "password"])
    assert.deepStrictEqual(
      LogonFixtures.decode(empty).fields.map(field => field.text),
      [utf8("271"), new Uint8Array(0)]
    )
  })

  /** the options: no SES, other lengths, and the changed flag, which is spec gap #34 */
  test("options", () => {
    const screen = LogonScreens.received(LogonScreens.gate())
    const options = new LogonStepOptions()
    options.ses = undefined
    const noSES = new LogonStep(screen, credentials(), options)
    assert.equal(noSES.input.items.length, 1)
    assert.equal(noSES.input.ses, undefined)

    const lengths = new LogonStepOptions()
    lengths.languageMaxNrChars = 3
    throwsInfo(() => new LogonStep(screen, credentials(), lengths), LogonStepError, { kind: "ambiguousField", role: "language" })
    lengths.languageMaxNrChars = 7
    throwsInfo(() => new LogonStep(screen, credentials(), lengths), LogonStepError, { kind: "missingField", role: "language" })

    const changed = new LogonStepOptions()
    changed.dialogFlags = "markedChanged"
    throwsInfo(() => new LogonStep(screen, credentials(), changed), LogonStepError, {
      kind: "fieldNotEncodable",
      role: "client",
      specGap: 34
    })
    assert.equal(
      describeLogonStepError({ kind: "fieldNotEncodable", role: "client", specGap: 34 }),
      "the client field cannot be returned (spec gap #34)"
    )
  })

  /** refusals: not decoded, a server error, not the logon program, a repeated DYNPRONAME, not exactly one password field */
  test("refusals", () => {
    const gateItems = LogonScreens.gateItems()
    const snc: CompressField = { kind: "snc", value: 2 }
    const cases: [Uint8Array, LogonStepErrorInfo][] = [
      [cat(Fixtures.header({ compress: snc }).bytes, [0x01]), { kind: "notDecoded" }],
      [Fixtures.message(cat(utf8("no"), [0x0c], gateItems), { errNo: 1 }), { kind: "serverError" }],
      [LogonScreens.gate({ program: "ZZ_MOAT" }), { kind: "notLogonProgram" }],
      [Fixtures.message(cat(Fixtures.text(ApplItem.stSystemInfo("dynproName"), "SAPMSYST"), gateItems)), { kind: "identityRepeats" }],
      [LogonScreens.gate({ passwords: 0 }), { kind: "passwordFields", count: 0 }],
      [LogonScreens.gate({ passwords: 2 }), { kind: "passwordFields", count: 2 }],
      [LogonScreens.gate({ clients: 2 }), { kind: "ambiguousField", role: "client" }],
      [LogonScreens.gate({ clients: 0 }), { kind: "missingField", role: "client" }]
    ]
    for (const [payload, expected] of cases) {
      const screen = LogonScreens.received(payload)
      throwsInfo(() => new LogonStep(screen, credentials()), LogonStepError, expected, JSON.stringify(expected))
    }
  })

  /** texts longer than their fields are refused; the password's refusal names no length */
  test("tooLong", () => {
    const screen = LogonScreens.received(LogonScreens.gate())
    throwsInfo(() => new LogonStep(screen, credentials({ user: "ZZGATEKEEPER-OF-THE-MOAT" })), LogonStepError, {
      kind: "textTooLong",
      role: "user"
    })
    const long = "tears".repeat(9)
    throwsInfo(() => new LogonStep(screen, credentials({ password: long })), LogonStepError, { kind: "textTooLong", role: "password" })
    assert.equal(describeLogonStepError({ kind: "textTooLong", role: "password" }), "the password is longer than its field accepts")
    assert.equal(new LogonStep(screen, credentials({ password: "t".repeat(40) })).roles.length, 4)
  })

  /** an input field whose payload was not decoded has unknown widths (IMPL-DA-2) */
  test("unknownWidths", () => {
    const atoms = new ByteWriter()
    DyntAtomEncoder.appendAtom(
      LogonScreens.header(DyntElementType.of("efield"), { row: 8, attributes: DyntAttributes.invisible }),
      utf8("opaque"),
      atoms
    )
    const items = new ByteWriter()
    items.bytes(Fixtures.text(ApplItem.stSystemInfo("dynproName"), "SAPMSYST"))
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), atoms.toBytes(), items)
    const screen = LogonScreens.received(Fixtures.message(items.toBytes()))
    throwsInfo(() => new LogonStep(screen, credentials()), LogonStepError, { kind: "unknownFieldWidths", role: "password" })
  })

  /** credentials, steps and errors never print a text or the password's length */
  test("neverPrints", () => {
    const screen = LogonScreens.received(LogonScreens.gate())
    const logon = credentials()
    const step = new LogonStep(screen, logon)
    const errors: LogonStepErrorInfo[] = [
      { kind: "notDecoded" },
      { kind: "serverError" },
      { kind: "notLogonProgram" },
      { kind: "identityRepeats" },
      { kind: "passwordFields", count: 2 },
      { kind: "missingField", role: "user" },
      { kind: "ambiguousField", role: "client" },
      { kind: "unknownFieldWidths", role: "password" },
      { kind: "textTooLong", role: "password" },
      { kind: "fieldNotEncodable", role: "password", specGap: undefined },
      { kind: "notSent", error: { kind: "notReady", state: SessionState.connecting } }
    ]
    const views = [
      String(logon),
      JSON.stringify(logon),
      inspect(logon),
      String(step),
      JSON.stringify(step),
      inspect(step),
      ...errors.map(describeLogonStepError)
    ]
    for (const view of views) {
      for (const leak of ["crocodile", "tears", "ZZGATEKEEPER", "271", "EN", String(utf8(LogonFixtures.password).length)]) {
        assert.ok(!view.includes(leak), `${leak} in ${view}`)
      }
    }
    assert.equal(String(step), "LogonStep(fields: client, user, password, language; ClientInputStep(fields: 4, SES: yes, DYNN CHL: no))")
  })

  /** the session logs on: the step is written, and the lobby moves it on to active */
  test("sessionLogsOn", async () => {
    const gate = LogonScreens.gate()
    const log = new TransportLog([ScriptStep.payload(gate), ScriptStep.payload(LogonScreens.lobby())])
    const session = scriptedSession(log)
    await session.start()
    const screen = await session.nextMessage()
    assert.ok(screen !== undefined)
    const step = await session.logOn(credentials(), screen)
    assert.deepStrictEqual(step.roles, ["client", "user", "password", "language"])
    const encoder = new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal)
    assert.deepStrictEqual(log.sent.at(-1), ClientInput.inputMessage(encoder, step.input))
    assert.deepStrictEqual(session.state, SessionState.logon)
    await session.nextMessage()
    assert.deepStrictEqual(session.state, SessionState.active)
  })

  /** the session refuses a logon it cannot build, and reports a write that fails */
  test("sessionRefuses", async () => {
    const log = new TransportLog([ScriptStep.payload(LogonScreens.gate({ program: "ZZ_MOAT" }))], 2)
    const session = scriptedSession(log)
    await session.start()
    const lobby = await session.nextMessage()
    assert.ok(lobby !== undefined)
    await rejectsWith(session.logOn(credentials(), lobby), { kind: "notLogonProgram" })
    assert.equal(log.sent.length, 1, "nothing written")

    const gateLog = new TransportLog([ScriptStep.payload(LogonScreens.gate())], 2)
    const failing = scriptedSession(gateLog)
    await failing.start()
    const gate = await failing.nextMessage()
    assert.ok(gate !== undefined)
    try {
      await failing.logOn(credentials(), gate)
      assert.fail("the write did not fail")
    } catch (error) {
      if (!(error instanceof LogonStepError)) throw error
      assert.deepStrictEqual(error.info, { kind: "notSent", error: { kind: "notWritten", error: TransportLog.sendFailure.info } })
      assert.ok(error.isNotWritten)
    }
    assert.ok(!new LogonStepError({ kind: "notLogonProgram" }).isNotWritten)
    assert.deepStrictEqual(failing.state, SessionState.disconnected(DisconnectReason.transportFailed(TransportLog.sendFailure.info)))
  })
})
