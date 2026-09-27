// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/DuckPondNavigationTests.swift (MIT).
//
// The Swift tests ran FakeScenarios' ScenarioSession in process; this port runs them against the
// real fake server over TCP (src/test/support/screenSession.ts) and skips without it. Where the
// Swift test read the server's parse of the client message (`reply.message.structure`), its
// history (`session.history`) or its counter (`dialogMessageCount`), this port asserts on the step
// the client wrote (the bytes on the wire), on the server's log, which names the same structure
// (OK-code length, function key) and every frame it sent, and on the screens the client receives.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ComFlag,
  CompressField,
  DiagHeader,
  FunctionKeyOKCode,
  UIControlType,
  UIEventFunctionKey,
  type ClientInputStep
} from "../../../diag/codec/index.js"
import { FieldEdits, FunctionReadings, FunctionTrigger, ScreenFunctionKind, ScreenInputError, type Screen } from "../../../diag/screen/index.js"
import type { ServerMessage } from "../../../diag/session/index.js"
import { screenOf, skipWithoutFakeServer, withPond, type Pond } from "../../support/screenSession.js"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The labels of the frames the server logged as sent so far, in order ("screen pond-lobby", "logoff"). */
function sentLabels(pond: Pond): string[] {
  return pond.server.log.flatMap(line => {
    const sent = /#\d+ sent (.*), \d+ bytes$/.exec(line)
    return sent === null ? [] : [sent[1]]
  })
}

/**
 * Waits until the server's log names every frame the client has read: the server logs a frame once
 * it has written it, so its line can come after the client read the frame.
 */
async function logCaughtUp(pond: Pond): Promise<void> {
  for (let wait = 0; wait < 200 && pond.sentFrames() < pond.session.diagnostics.messages; wait++) await sleep(5)
  assert.ok(pond.sentFrames() >= pond.session.diagnostics.messages, `the log names every frame read: ${pond.server.log.join("\n")}`)
}

/**
 * What the server's log line of a dialog message says about it (its summary: kinds, counts and
 * lengths, never a value); stands in for Swift's `reply.message.structure`. The summary names the
 * function key of a UI event, else the one of an OK-code of the `/NN` spelling.
 */
interface LoggedStructure {
  number: number
  okCodeLength: number | undefined
  functionKey: number | undefined
  okCodeFunctionKey: number | undefined
}

function loggedStructure(line: string): LoggedStructure {
  const number = /dialog message (\d+):/.exec(line)
  assert.ok(number !== null, line)
  const okCode = /; OKCODE (\d+) bytes, not shown/.exec(line)
  const key = /; function key (\d+)( in OKCODE)?/.exec(line)
  return {
    number: Number(number[1]),
    okCodeLength: okCode === null ? undefined : Number(okCode[1]),
    functionKey: key !== null && key[2] === undefined ? Number(key[1]) : undefined,
    okCodeFunctionKey: key !== null && key[2] !== undefined ? Number(key[1]) : undefined
  }
}

/**
 * What the server did with one step (Swift's `ScenarioStep`): the step written, the messages of the
 * reply, the log line of the dialog message (`structure`) and the labels of the frames the server
 * sent (`output`).
 */
interface Reply {
  step: ClientInputStep
  messages: ServerMessage[]
  line: string
  structure: LoggedStructure
  output: string[]
}

/** The logoff message: com_flag EOP | EOC, every other field 0, and no items (Swift's `ServerMessageHeader.logoffMessage`, PV-0702). */
const logoffMessage = new DiagHeader({
  mode: 0,
  comFlag: ComFlag.eop | ComFlag.eoc,
  modeStat: 0,
  errNo: 0,
  msgType: 0,
  msgInfo: 0,
  msgRC: 0,
  compress: CompressField.uncompressed
}).bytes

/**
 * The Duck Pond demo end to end through the fake server: every reply is decoded into a `Screen`, and
 * every next step is that screen's own input step for a function trigger (client-input.md §7.5), as
 * the app builds it.
 */
describe("Duck Pond navigation through the scenario engine", () => {
  /**
   * A connection to the default scenario and the screen it shows (Swift's `Pond`, which held a
   * `ScenarioSession` and the encoder of its connection: here the DiagSession on the TCP connection
   * writes the steps, with DIALOG_STEP_NUMBER, and counts them).
   */
  class NavigationPond {
    readings = new FunctionReadings()
    /** The dialog messages the server read so far (Swift's `session.dialogMessageCount`). */
    private dialogMessages = 0

    private constructor(
      readonly pond: Pond,
      public screen: Screen
    ) {}

    /** Writes the first message and reads the gate. */
    static async open(pond: Pond): Promise<NavigationPond> {
      return new NavigationPond(pond, screenOf(await pond.first()))
    }

    /**
     * Submits the screen with `trigger` and `edits`; returns what the server did. The screen changes
     * only when the server's first frame is a screen, as in Swift; then the reply's last screen is
     * the new one.
     */
    async press(trigger: FunctionTrigger, edits = new FieldEdits()): Promise<Reply> {
      const step = this.screen.inputStep(edits, trigger, { readings: this.readings })
      await logCaughtUp(this.pond)
      const sentBefore = sentLabels(this.pond).length
      const messages = await this.pond.reply(step)
      this.dialogMessages += 1
      const number = this.dialogMessages
      assert.ok(await this.pond.waitForLog(`dialog message ${number}:`), this.pond.server.log.join("\n"))
      const lines = this.pond.logLines(`dialog message ${number}:`)
      assert.equal(lines.length, 1, lines.join("\n"))
      await logCaughtUp(this.pond)
      const output = sentLabels(this.pond).slice(sentBefore)
      assert.equal(output.length, messages.length, `each frame the server sent is one message read: ${output.join(", ")}`)
      if (output[0]?.startsWith("screen ")) {
        const last = output.findLastIndex(label => label.startsWith("screen "))
        this.screen = screenOf(messages[last])
      }
      return { step, messages, line: lines[0], structure: loggedStructure(lines[0]), output }
    }

    async logOn(): Promise<void> {
      const edits = new FieldEdits()
      for (const input of this.screen.inputs) {
        if (input.isPassword) continue
        edits.setText(input.maxLength === 3 ? "314" : "DK", input.id)
      }
      await this.press(FunctionTrigger.enter, edits)
    }

    /**
     * The screens sent, oldest first, the current one last (Swift's `session.history`), rebuilt from
     * the server's log of the screens it sent by the engine's rule: a screen sent again that is
     * already there cuts the history back to it (going back sends the previous screen again).
     */
    async history(): Promise<string[]> {
      await logCaughtUp(this.pond)
      const history: string[] = []
      for (const label of sentLabels(this.pond)) {
        if (!label.startsWith("screen ")) continue
        const screen = label.slice("screen ".length)
        const index = history.lastIndexOf(screen)
        if (index >= 0) history.splice(index + 1)
        else history.push(screen)
      }
      return history
    }

    get program(): string | undefined {
      return this.screen.identity.program
    }

    get message(): string | undefined {
      return this.screen.message
    }
  }

  /** the demo: log on, feed and count the ducks from the toolbar, open ZZDUCK, ask it with F8 and the button, go back and home */
  test("demo", { skip: skipWithoutFakeServer }, async () => {
    await withPond("duck-pond-logon", async server => {
      const pond = await NavigationPond.open(server)
      assert.equal(pond.program, "SAPMSYST")
      await pond.logOn()
      assert.equal(pond.program, "ZZ_DUCK_LOBBY")
      assert.deepEqual(await pond.history(), ["pond-gate", "pond-lobby"])

      const feed = pond.screen.functions.find(
        f => ScreenFunctionKind.equals(f.kind, ScreenFunctionKind.applicationToolbar) && f.text === "Feed Ducks"
      )
      assert.ok(feed !== undefined)
      const fed = await pond.press(FunctionTrigger.function(feed))
      // Swift read the server's parse: `okCodeFunctionKey == 5`, `functionKey == nil`. Here: the
      // OK-code the step wrote is `/05`, with no UI event, and the server's log names function key 5
      // in the OK-code and no UI-event function key.
      assert.ok(fed.step.functionCode !== undefined)
      assert.equal(FunctionKeyOKCode.functionNumber(fed.step.functionCode), 5, "Reading R-CI-20: /05")
      assert.equal(fed.step.uiEvent, undefined)
      assert.equal(fed.structure.okCodeFunctionKey, 5, `Reading R-CI-20: /05: ${fed.line}`)
      assert.equal(fed.structure.functionKey, undefined, fed.line)
      assert.equal(pond.message, "Breadcrumbs scattered. The ducks demand seconds.")
      await pond.press(FunctionTrigger.virtualKey(6))
      assert.equal(pond.message, "Ducks counted: 7. Or 8. One of them keeps moving.")
      await pond.press(FunctionTrigger.virtualKey(3))
      assert.equal(pond.message, "Breadcrumbs scattered. The ducks demand seconds.", "F3: back to the screen before")

      await pond.press(FunctionTrigger.okCode("ZZDUCK"))
      assert.equal(pond.program, "ZZ_RUBBER_DUCK")
      assert.deepEqual(
        pond.screen.menuBar.map(menu => menu.title),
        ["Duck", "Quackery"]
      )
      await pond.press(FunctionTrigger.virtualKey(8))
      assert.equal(pond.screen.identity.title, "The Duck Has Spoken")
      await pond.press(FunctionTrigger.virtualKey(12))
      assert.equal(pond.message, "The duck is listening. It always is.", "F12: back to ZZDUCK")
      const ask = pond.screen.functions.find(f => f.code === "=ZZASK")
      assert.ok(ask !== undefined)
      const asked = await pond.press(FunctionTrigger.function(ask))
      // Swift: `asked.message.structure?.okCode == Array("=ZZASK".utf8)`: the OK-code on the wire, and
      // its length in the server's log (which never shows the text).
      assert.deepEqual(asked.step.functionCode, new TextEncoder().encode("=ZZASK"))
      assert.equal(asked.structure.okCodeLength, 6, asked.line)
      assert.equal(pond.screen.identity.title, "The Duck Has Spoken")
      const thanks = pond.screen.functions.find(f => f.code === "=ZZTHANKS")
      assert.ok(thanks !== undefined)
      await pond.press(FunctionTrigger.function(thanks))
      assert.equal(pond.message, "The duck accepts your thanks, and a breadcrumb.")

      await pond.press(FunctionTrigger.okCode("ZZDUCK_ROW"))
      const execute = pond.screen.function("execute")
      assert.ok(execute !== undefined)
      await pond.press(FunctionTrigger.function(execute))
      assert.equal(pond.message, "Duck 3 caught the moth and fell in line.")
      const exit = pond.screen.function("exit")
      assert.ok(exit !== undefined)
      await pond.press(FunctionTrigger.function(exit))
      assert.ok(pond.program === "ZZ_DUCK_LOBBY" && pond.message === "Quack! Breadcrumbs are served at noon.", "Shift-F3: home")
      assert.deepEqual(await pond.history(), ["pond-gate", "pond-lobby"])
    })
  })

  /** the lobby has nowhere further back; Enter stays; a menu item fires its number; unknown keys stay */
  test("lobby", { skip: skipWithoutFakeServer }, async () => {
    await withPond("duck-pond-logon", async server => {
      const pond = await NavigationPond.open(server)
      await pond.logOn()
      for (const key of [3, 12, 15]) {
        await pond.press(FunctionTrigger.virtualKey(key))
        assert.equal(pond.message, "You are already home. The ducks look at you expectantly.", `${key}`)
      }
      await pond.press(FunctionTrigger.enter)
      assert.equal(pond.message, "You are already home. The ducks look at you expectantly.", "Enter stays")
      const coffee = pond.screen.functions.find(
        f => f.text === "Top Up the Coffee Machine" && ScreenFunctionKind.equals(f.kind, ScreenFunctionKind.menu(["Ducks"]))
      )
      assert.ok(coffee !== undefined)
      await pond.press(FunctionTrigger.function(coffee))
      assert.equal(pond.program, "ZZ_COFFEE_MACHINE")
      await pond.press(FunctionTrigger.virtualKey(8))
      assert.equal(pond.screen.identity.title, "Coffee Is Brewing")
      await pond.press(FunctionTrigger.virtualKey(1))
      assert.equal(pond.screen.identity.title, "What Does the Duck Say?")
      await pond.press(FunctionTrigger.virtualKey(44))
      assert.equal(pond.screen.identity.title, "What Does the Duck Say?", "an unknown key stays")
      await pond.press(FunctionTrigger.virtualKey(3))
      assert.equal(pond.screen.identity.title, "Coffee Is Brewing")
    })
  })

  /** the gate: F-keys other than Fly South stay; Fly South (15) logs off; pysap's width works too */
  test("gate", { skip: skipWithoutFakeServer }, async () => {
    await withPond("duck-pond-logon", async server => {
      const pond = await NavigationPond.open(server)
      pond.readings = new FunctionReadings({ functionKey: "uiEventSource", eventDataWidth: "oneByte", eventControlType: UIControlType.dynpro })
      await pond.press(FunctionTrigger.virtualKey(5))
      assert.equal(pond.program, "SAPMSYST")
      const fly = pond.screen.functionForVirtualKey(15)
      assert.ok(fly !== undefined)
      const reply = await pond.press(FunctionTrigger.function(fly))
      // Swift: `reply.message.structure?.functionKey == 15`: the UI event on the wire fires 15, and
      // the server's log names function key 15 (a UI event, not an OK-code), in pysap's one-byte width.
      assert.ok(reply.step.uiEvent !== undefined)
      assert.equal(UIEventFunctionKey.decode(reply.step.uiEvent, "oneByte").functionNumber, 15)
      assert.equal(reply.step.functionCode, undefined)
      assert.equal(reply.structure.functionKey, 15, reply.line)
      // Swift: `reply.output == [.frame(ServerMessageHeader.logoffMessage, label: "logoff"), .close]`:
      // the one frame the server logged as sent is the logoff message, which the client read as it
      // is, and then the server closed the connection.
      assert.deepEqual(reply.output, ["logoff"])
      assert.equal(reply.messages.length, 1)
      assert.deepEqual(reply.messages[0].payload, logoffMessage)
      assert.equal(await server.session.nextMessage(), undefined, "the server closes after the logoff message")
      assert.deepEqual(server.state(), { kind: "disconnected", reason: { kind: "closedByServer", lastMessageHadEOC: true } })
      assert.ok(await server.waitForLog("closed by the server"), server.server.log.join("\n"))
    })
  })

  /** a disabled function never reaches the server */
  test("disabled", { skip: skipWithoutFakeServer }, async () => {
    await withPond("duck-pond-logon", async server => {
      const pond = await NavigationPond.open(server)
      await pond.logOn()
      const swan = pond.screen.functionForVirtualKey(20)
      assert.ok(swan !== undefined)
      await assert.rejects(pond.press(FunctionTrigger.function(swan)), (error: unknown) => {
        assert.ok(error instanceof ScreenInputError, `expected ScreenInputError, got ${String(error)}`)
        assert.deepEqual(error.info, { kind: "functionCode", value: { kind: "function", value: { kind: "disabled" } } })
        return true
      })
      // Swift: `session.dialogMessageCount == 1`: the session wrote one step, the logon, and the
      // server read one dialog message.
      assert.equal(server.session.machine.lastStepNumber, 1)
      assert.equal(server.session.diagnostics.inputSteps, 1)
      await sleep(50)
      assert.equal(server.logLines("dialog message").length, 1, server.server.log.join("\n"))
      assert.ok(server.logged("dialog message 1:"))
    })
  })
})
