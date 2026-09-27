// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/DuckPondEnvelopeTests.swift (MIT).
//
// The Swift tests ran FakeScenarios' ScenarioSession in process and kept the server's echo
// themselves (`ServerEcho`, `encoder.inputMessage(step, echo:)`); this port runs them against the
// real fake server over TCP (src/test/support/screenSession.ts) and skips without it. The
// DiagSession on the connection keeps the echo of every message it reads and numbers the steps
// (`pond.session.machine`), so the echo and step checks read it. Where the Swift test read the
// server's parse of the client message (`reply.message.structure`), this port asserts on the step
// the client wrote (the bytes on the wire) and on the server's log line of the message, which is
// that structure's summary (returned fields, password fields, OK-code length, envelope items, and
// the length withheld for a password field); the reply is the screen the client receives.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DiagHeader, DiagItemWalkError, DiagItemWalker, InputEnvelope, Secret, type ClientInputStep, type DiagItem } from "../../../diag/codec/index.js"
import { FieldEdits, FunctionReadings, FunctionTrigger, type Screen, type ScreenElementID } from "../../../diag/screen/index.js"
import type { ServerMessage } from "../../../diag/session/index.js"
import { screenOf, skipWithoutFakeServer, withPond, type Pond } from "../../support/screenSession.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Waits until the server's log names every frame the client has read: the server logs a frame once
 * it has written it, so its line can come after the client read the frame.
 */
async function logCaughtUp(pond: Pond): Promise<void> {
  for (let wait = 0; wait < 200 && pond.sentFrames() < pond.session.diagnostics.messages; wait++) await sleep(5)
  assert.ok(pond.sentFrames() >= pond.session.diagnostics.messages, `the log names every frame read: ${pond.server.log.join("\n")}`)
}

/**
 * What the server's log line of a dialog message says about it: its summary (Swift's
 * `ClientMessage.summary` of `reply.message.structure`), kinds, counts and lengths, never a value.
 */
interface LoggedStructure {
  returnedFields: number
  returnedPasswordFields: number
  /** What the log writes in place of the size: "length withheld (password field)", or undefined when it prints the size. */
  withheld: string | undefined
  okCodeLength: number | undefined
  envelopeItems: string[]
}

function loggedStructure(line: string): LoggedStructure {
  const fields = /; (\d+) returned field\(s\), (\d+) of them password field\(s\)/.exec(line)
  const withheld = /received, (length withheld \([^)]*\)):/.exec(line)
  const okCode = /; OKCODE (\d+) bytes, not shown/.exec(line)
  const envelope = /; envelope items: ([^;]*)/.exec(line)
  return {
    returnedFields: fields === null ? 0 : Number(fields[1]),
    returnedPasswordFields: fields === null ? 0 : Number(fields[2]),
    withheld: withheld === null ? undefined : withheld[1],
    okCodeLength: okCode === null ? undefined : Number(okCode[1]),
    envelopeItems: envelope === null ? [] : envelope[1].split(", ")
  }
}

/** What the server did with one step (Swift's `ScenarioStep`): the step written, the reply, and the server's log line of the dialog message. */
interface Reply {
  step: ClientInputStep
  messages: ServerMessage[]
  line: string
  structure: LoggedStructure
}

/** The items of an item sequence, walked to its end or to a stop. */
function walkItems(items: Uint8Array): DiagItem[] {
  const walker = new DiagItemWalker()
  const walked: DiagItem[] = []
  for (;;) {
    let item: DiagItem | undefined
    try {
      item = walker.next(items)
    } catch (error) {
      if (!(error instanceof DiagItemWalkError)) throw error
      throw new Error(`the item walk stopped: ${String(error)}`)
    }
    if (item === undefined) return walked
    walked.push(item)
  }
}

/**
 * The Duck Pond demo with each stage of the reference input envelope (client-input.md §11): the
 * scenario engine accepts every envelope, and the demo logs on and navigates with each. The client
 * keeps what the server sent as a session does (`ServerEcho`) and writes each step with it.
 */
describe("Duck Pond with the reference input envelope", () => {
  /**
   * A connection to the default scenario, the screen it shows and the readings of its steps (Swift's
   * `Pond`, which held a `ScenarioSession`, an encoder and the echo: here the DiagSession on the
   * connection keeps the echo of every message it reads and writes each step with it).
   */
  class EnvelopePond {
    /** The dialog messages the server read so far. */
    private dialogMessages = 0

    private constructor(
      readonly pond: Pond,
      readonly readings: FunctionReadings,
      public screen: Screen
    ) {}

    static async open(pond: Pond, envelope: InputEnvelope): Promise<EnvelopePond> {
      return new EnvelopePond(pond, new FunctionReadings({ envelope }), screenOf(await pond.first()))
    }

    /**
     * Submits the screen with `trigger`, `edits` and `cursor`; the new screen is the reply's last
     * one when the server's first frame is a screen, as in Swift.
     */
    async press(trigger: FunctionTrigger, edits = new FieldEdits(), cursor?: ScreenElementID): Promise<Reply> {
      const step = this.screen.inputStep(edits, trigger, { readings: this.readings, cursor })
      await logCaughtUp(this.pond)
      const sentBefore = this.pond.sentFrames()
      const messages = await this.pond.reply(step)
      this.dialogMessages += 1
      const number = this.dialogMessages
      assert.ok(await this.pond.waitForLog(`dialog message ${number}:`), this.pond.server.log.join("\n"))
      const lines = this.pond.logLines(`dialog message ${number}:`)
      assert.equal(lines.length, 1, lines.join("\n"))
      await logCaughtUp(this.pond)
      const output = this.pond.server.log.filter(line => /#\d+ sent /.test(line)).slice(sentBefore)
      if (/#\d+ sent screen /.test(output[0] ?? "")) {
        const last = output.findLastIndex(line => /#\d+ sent screen /.test(line))
        this.screen = screenOf(messages[last])
      }
      return { step, messages, line: lines[0], structure: loggedStructure(lines[0]) }
    }

    /** Logs on at the gate: a duck ID, a secret quack and a dialect, the cursor on the quack. */
    async logOn(): Promise<Reply> {
      const edits = new FieldEdits()
      let quack: ScreenElementID | undefined
      for (const input of this.screen.inputs) {
        if (input.isPassword) {
          edits.setSecret(new Secret(utf8("mallard")), input.id)
          quack = input.id
        } else if (input.maxLength === 12) {
          edits.setText("DK", input.id)
        } else if (input.maxLength === 2) {
          edits.setText("QU", input.id)
        }
      }
      return this.press(FunctionTrigger.enter, edits, quack)
    }

    get program(): string | undefined {
      return this.screen.identity.program
    }

    get message(): string | undefined {
      return this.screen.message
    }
  }

  /** every stage logs on, opens ZZDUCK, fires F8 and a push button, and goes back with F3 */
  for (const envelope of InputEnvelope.stages) {
    test(`demo(${InputEnvelope.name(envelope)})`, { skip: skipWithoutFakeServer }, async () => {
      await withPond("duck-pond-logon", async server => {
        const pond = await EnvelopePond.open(server, envelope)
        assert.equal(pond.program, "SAPMSYST")
        const logon = await pond.logOn()
        assert.equal(pond.program, "ZZ_DUCK_LOBBY", InputEnvelope.name(envelope))
        // Swift read `logon.message.structure`; here the step on the wire and the server's log line.
        const structure = logon.structure
        assert.equal(logon.step.fieldCount, 4, "the gate's own pond number goes back too (R-CI-19)")
        assert.ok(structure.returnedFields === 4 && structure.returnedPasswordFields === 1, `the gate's own pond number goes back too (R-CI-19): ${logon.line}`)
        // Swift: `structure.clearance == .passwordField`: the log withholds the message's length.
        assert.equal(structure.withheld, "length withheld (password field)", logon.line)

        let expected: string[]
        switch (envelope) {
          case InputEnvelope.minimal:
            expected = []
            break
          case InputEnvelope.echoStage:
          case InputEnvelope.chlStage:
            expected = ["DYNT_ATOM as APPL"]
            break
          case InputEnvelope.stateStage:
            expected = ["CONTAINER RESET", "DYNT_ATOM as APPL", "DYNT_FOCUS_1"]
            break
          default:
            expected = ["CONTAINER RESET", "DYNT_ATOM as APPL", "DYNT_FOCUS_1", "XMLBLOB"]
        }
        assert.deepEqual(structure.envelopeItems, expected, InputEnvelope.name(envelope))
        // Swift checked `ClientMessage.dialog(number: 1, diag: structure).summary`: the log line is that summary.
        assert.equal(logon.line.includes("envelope items"), expected.length > 0, logon.line)

        const command = await pond.press(FunctionTrigger.okCode("ZZDUCK"))
        assert.equal(pond.program, "ZZ_RUBBER_DUCK")
        // Swift: `command.message.structure?.okCode == Array("ZZDUCK".utf8)`: the OK-code on the
        // wire, and its length in the server's log (which never shows the text).
        assert.deepEqual(command.step.functionCode, utf8("ZZDUCK"))
        assert.equal(command.structure.okCodeLength, 6, command.line)
        const key = await pond.press(FunctionTrigger.virtualKey(8))
        assert.deepEqual(key.step.functionCode, utf8("=ZZASK"), "Reading R-CI-20: F8's entry is captioned like the Ask the Duck button")
        assert.equal(key.structure.okCodeLength, 6, key.line)
        assert.equal(pond.screen.identity.title, "The Duck Has Spoken")
        assert.equal(
          key.structure.envelopeItems.includes("XMLBLOB"),
          InputEnvelope.contains(envelope, InputEnvelope.dataManager),
          `an OK-code step is a command step: the DATAMANAGER goes with the reference envelope (R-CI-17): ${key.line}`
        )
        await pond.press(FunctionTrigger.virtualKey(12))
        const ask = pond.screen.functions.find(f => f.code === "=ZZASK")
        assert.ok(ask !== undefined)
        const asked = await pond.press(FunctionTrigger.function(ask))
        assert.deepEqual(asked.step.functionCode, utf8("=ZZASK"))
        assert.equal(asked.structure.okCodeLength, 6, asked.line)
        await pond.press(FunctionTrigger.virtualKey(3))
        assert.equal(pond.message, "The duck is listening. It always is.", "F3: back to ZZDUCK")
        // Swift: `pond.encoder.lastStepNumber == 6`. The session numbers the steps: the Duck Pond sends
        // no DIALOG_STEP_NUMBER, so the session's echo holds none and every stage counts its own; the
        // server read six dialog messages.
        assert.equal(server.session.machine.lastStepNumber, 6, "Swooey's own counter: the Duck Pond sends no step number")
        assert.equal(server.session.machine.echo.stepNumber, undefined, "the Duck Pond sends no step number")
        assert.equal(server.logLines("dialog message").length, 6, server.server.log.join("\n"))
      })
    })
  }

  /** the reference logon step echoes the gate's SES and CONTAINER RESET */
  test("echoesTheGate", { skip: skipWithoutFakeServer }, async () => {
    await withPond("duck-pond-logon", async server => {
      const pond = await EnvelopePond.open(server, InputEnvelope.reference)
      // Swift kept the echo in its Pond; the session keeps it (a copy).
      const gateEcho = server.session.machine.echo
      assert.ok(gateEcho.ses !== undefined)
      assert.deepEqual(gateEcho.containerReset, new Uint8Array(9))
      assert.ok(gateEcho.stepNumber === undefined && gateEcho.codepageDiagGUI === undefined && gateEcho.dynnCHL === undefined)
      const edits = new FieldEdits()
      const duck = pond.screen.inputs.find(input => input.maxLength === 12 && !input.isPassword)
      assert.ok(duck !== undefined)
      edits.setText("DK", duck.id)
      const step = pond.screen.inputStep(edits, FunctionTrigger.enter, { readings: pond.readings, cursor: duck.id })
      // Swift built the payload with `encoder.inputMessage(step, echo: pond.echo)` and did not send
      // it; the session builds it with its echo only to write it, and resolves to what it wrote.
      const payload = await server.session.submit(step)
      const body = payload.slice(DiagHeader.size)
      const ses = walkItems(body).find(item => item.type === "ses")
      assert.ok(ses !== undefined)
      assert.deepEqual(ses.valueRange.of(body), gateEcho.ses)
      // The server answers the step with the lobby.
      assert.equal(screenOf(await server.settle("the lobby")).identity.program, "ZZ_DUCK_LOBBY")
    })
  })
})
