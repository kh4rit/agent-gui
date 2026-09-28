// SPDX-License-Identifier: MIT
// The ScreenModel tests' driver of Swooey's fake DIAG server over TCP (loopback only, invented Duck
// Pond screens). In Swooey these tests run the fake server in process (FakeScenarios'
// `ScenarioSession`, `ScenarioLibrary`, `ScreenBuilder`), which the port does not have: here the real
// `fake-diag-server` binary runs the scenario, and the client side is the ported one, NodeTransport,
// DiagSession, LogonStep and ScreenModel's Screen and input step.
//
// - `Pond`: one connection to one scenario: the first screen, the logon, a step and the screen after
//   it (read past control traffic, the settle loop of Swooey's ControlCaptureSupport), the close,
//   and the server's log (structure only: kinds, counts, lengths).
// - `scenarioScreenItems`: the item sequence of a screen a scenario sends, reached by the scenario's
//   own rules (Swift's `Fixtures.items(_:of:)`).
// - `inlineScreenItems`: the item sequence of the one screen of a `.screens` text (Swift's
//   `Fixtures.items(screens:)`): the text goes into a scenario file of its own, whose first reply is
//   that screen.
// - `damSelectPart`: the parts of the Beaver Dam popup's message (Tests/Scenarios/beaver-dam.screens),
//   cut from `dam-select` as the fake server sends it.
//
// Skipped unless AGENT_GUI_FAKE_SERVER names the binary (`skipWithoutFakeServer`). Credentials are
// invented (D15).

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ApplItem,
  ClientIdentity,
  DiagItemWalkError,
  DiagItemWalker,
  Secret,
  SupportBits,
  type ClientInputStep,
  type DiagItem
} from "../../diag/codec/index.js"
import { FieldEdits, FunctionTrigger, Screen, type ScreenReadings } from "../../diag/screen/index.js"
import { DiagSession, LogonCredentials, type ServerMessage, type SessionState } from "../../diag/session/index.js"
import { DPTerminalName } from "../../diag/wire/index.js"
import { NodeTransport } from "../../engine/nodeTransport.js"
import { fakeServerBinary, fakeServerObjectResultTypes, startFakeServer, type FakeServer } from "./fakeServer.js"

export { skipWithoutFakeServer } from "./fakeServer.js"

/** ASCII bytes of an invented text. */
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * The client identity of Swooey's ScreenModel `Fixtures`: the fake server does not look at CONNECT
 * or SUPPORTDATA (PV-0700), and the values Swooey will send are open (#16, #17, #18), so the tests
 * send zeros. A fresh copy on every call.
 */
export function pondIdentity(): ClientIdentity {
  return new ClientIdentity({ codePage: 0, wsType: 0, supportData: new SupportBits() })
}

/** An invented terminal name (Swift's `Fixtures.terminal`). */
export const pondTerminal = DPTerminalName.fromHostName("puddle")

/** Invented credentials: pond 314, duck DK, any quack (the fake server checks none). */
export function pondCredentials(): LogonCredentials {
  return new LogonCredentials({ client: ascii("314"), user: ascii("DK"), password: new Secret(ascii("mallard")), language: ascii("QU") })
}

/** The item sequence of `message`, copied out of it. */
export function messageItems(message: ServerMessage): Uint8Array {
  const items = message.withItems(bytes => bytes.slice())
  assert.ok(items !== undefined, `the message holds no items: ${message.description}`)
  return items
}

/** The screen of `message`'s items, decoded as Swift's `Screen(items:)` (code page 4110 unless given). */
export function screenOf(message: ServerMessage, options: { readings?: ScreenReadings; codePage?: number } = {}): Screen {
  return Screen.fromItems(messageItems(message), options)
}

/** One connection to the fake server running one scenario. */
export class Pond {
  private constructor(
    readonly server: FakeServer,
    readonly session: DiagSession<NodeTransport>,
    readonly transport: NodeTransport
  ) {}

  /** Starts the fake server with `scenario` (a name, or an absolute path) and connects to it. */
  static async open(scenario: string): Promise<Pond> {
    const server = await startFakeServer(scenario)
    try {
      const transport = await NodeTransport.connect(server.host, server.port)
      const session = new DiagSession(transport, pondIdentity(), pondTerminal)
      session.controlReadings.objectResultTypes = fakeServerObjectResultTypes
      return new Pond(server, session, transport)
    } catch (error) {
      await server.stop()
      throw error
    }
  }

  /** The session's state now (a function, so that assertions do not narrow a getter's value). */
  state(): SessionState {
    return this.session.state
  }

  /** The next message; fails when the session ended first. */
  async next(what: string): Promise<ServerMessage> {
    const message = await this.session.nextMessage()
    assert.ok(message !== undefined, `${what}: the session ended first (${JSON.stringify(this.state())})`)
    return message
  }

  /**
   * Reads messages until one that is no control traffic: the screen after the calls, which the
   * session answered by itself (ControlCaptureSupport's settle loop).
   */
  async settle(what: string): Promise<ServerMessage> {
    for (;;) {
      const message = await this.next(what)
      if (message.control === undefined) return message
    }
  }

  /** Writes the first message and reads the first screen. */
  async first(): Promise<ServerMessage> {
    assert.ok((await this.session.start()) !== undefined, "the first message was written")
    return this.settle("the first screen")
  }

  /** Writes `step` and reads the screen after it. */
  async submit(step: ClientInputStep, what = "the screen after the step"): Promise<ServerMessage> {
    await this.session.submit(step)
    return this.settle(what)
  }

  /** Waits until the server's log names every frame the session read (the log lags behind the socket). */
  async logCaughtUp(): Promise<void> {
    for (let wait = 0; wait < 400 && this.sentFrames() < this.session.diagnostics.messages; wait++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(this.sentFrames() >= this.session.diagnostics.messages, `the log names every frame read:\n${this.server.log.join("\n")}`)
  }

  /** The frames the server logged as sent so far (screens, control parts, the logoff message). */
  sentFrames(): number {
    return this.server.log.filter(line => /#\d+ sent /.test(line)).length
  }

  /**
   * Writes `step` and reads every message the server sends in reply, past the control traffic the
   * session answers by itself (Swift's `ScenarioStep.output` of one `receive`); the last is the new
   * screen. Over TCP the reply's end is not marked: the server sends a reply's frames one after the
   * other without waiting and logs each as sent, so once every frame the session read is logged,
   * a frame that follows is logged within a moment (`grace`).
   */
  async reply(step: ClientInputStep, what = "the reply", grace = 40): Promise<ServerMessage[]> {
    // The server logs a frame once it has written it, so the log may still lack a frame the session
    // read already: wait until it names every one, or the count below would expect one more.
    await this.logCaughtUp()
    const sentBefore = this.sentFrames()
    const readBefore = this.session.diagnostics.messages
    await this.session.submit(step)
    const messages = [await this.settle(what)]
    for (;;) {
      const read = () => this.session.diagnostics.messages - readBefore
      for (let wait = 0; wait < 200 && this.sentFrames() - sentBefore < read(); wait++) await new Promise(resolve => setTimeout(resolve, 5))
      await new Promise(resolve => setTimeout(resolve, grace))
      if (!(this.sentFrames() - sentBefore > read())) return messages
      messages.push(await this.settle(what))
    }
  }

  /** Logs on at `gate` with the session's logon step (LogonStep) and invented credentials; the screen after it. */
  async logOn(gate: ServerMessage): Promise<ServerMessage> {
    await this.session.logOn(pondCredentials(), gate)
    return this.settle("the screen after the logon")
  }

  /** Whether the server's log has a line that holds every one of `parts`. */
  logged(...parts: string[]): boolean {
    return this.server.log.some(line => parts.every(part => line.includes(part)))
  }

  /** The server's log lines that hold every one of `parts`. */
  logLines(...parts: string[]): string[] {
    return this.server.log.filter(line => parts.every(part => line.includes(part)))
  }

  /** Waits until the server logged a line with every one of `parts` (it logs a message once it has read it). */
  async waitForLog(...parts: string[]): Promise<boolean> {
    for (let wait = 0; wait < 200 && !this.logged(...parts); wait++) await new Promise(resolve => setTimeout(resolve, 10))
    return this.logged(...parts)
  }

  /** Closes the session (when it still runs) and stops the server; the server's log. */
  async close(): Promise<string[]> {
    try {
      if (this.session.state.kind !== "disconnected") {
        await this.session.close()
        await this.waitForLog("close message (EOC)")
      }
      return this.server.log.slice()
    } finally {
      await this.transport.close()
      await this.server.stop()
    }
  }
}

/** The scenarios the fake server knows (`fake-diag-server --list`), sorted; empty without the binary. */
export function fakeServerScenarios(): string[] {
  if (!fakeServerBinary) return []
  const listed = spawnSync(fakeServerBinary, ["--list"], { encoding: "utf8" })
  return listed.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => /^[a-z0-9-]+$/.test(line))
    .sort()
}

/** Runs `body` on a fresh connection to the fake server with `scenario`; closes it afterwards. */
export async function withPond<Result>(scenario: string, body: (pond: Pond) => Promise<Result>): Promise<Result> {
  const pond = await Pond.open(scenario)
  try {
    return await body(pond)
  } finally {
    await pond.close()
  }
}

// MARK: - Screens of the scenarios

/**
 * How to reach each screen the ScreenModel tests read, by the scenario's own rules: the first
 * screen, the logon step's answer, and the commands after it.
 */
const SCREEN_PATHS: Readonly<Record<string, { scenario: string; reach: (pond: Pond) => Promise<ServerMessage> }>> = {
  "duck-pond-logon/pond-gate": { scenario: "duck-pond-logon", reach: pond => pond.first() },
  "duck-pond-logon/pond-lobby": { scenario: "duck-pond-logon", reach: async pond => pond.logOn(await pond.first()) },
  "duck-pond-logon/pond-rubber-duck": {
    scenario: "duck-pond-logon",
    reach: async pond => {
      const lobby = await pond.logOn(await pond.first())
      return pond.submit(press(lobby, FunctionTrigger.okCode("ZZDUCK")))
    }
  },
  "duck-pond-dam/dam-select": {
    scenario: "duck-pond-dam",
    reach: async pond => {
      const lobby = await pond.logOn(await pond.first())
      return pond.submit(press(lobby, FunctionTrigger.okCode("ZZDAM_MON")))
    }
  },
  "duck-pond-dam/dam-select-again": {
    scenario: "duck-pond-dam",
    reach: async pond => {
      const lobby = await pond.logOn(await pond.first())
      const select = await pond.submit(press(lobby, FunctionTrigger.okCode("ZZDAM_MON")))
      // Enter on the popup: the fields alone (`on message * at dam-select send dam-select-again`).
      return pond.submit(press(select, FunctionTrigger.enter))
    }
  },
  "duck-pond-paddling/paddle-question": { scenario: "duck-pond-paddling", reach: async pond => pond.logOn(await pond.first()) },
  "duck-pond-pond-rules/pond-rules-question": { scenario: "duck-pond-pond-rules", reach: async pond => pond.logOn(await pond.first()) }
}

/**
 * The step `screen` answers `trigger` with and no edit: a command (Reading R-CI-6) or Enter, as the
 * app builds it.
 */
function press(message: ServerMessage, trigger: FunctionTrigger): ClientInputStep {
  return screenOf(message).inputStep(new FieldEdits(), trigger)
}

const screenCache = new Map<string, Promise<Uint8Array>>()

/**
 * The item sequence of screen `screen` as scenario `scenario` sends it, reached by the scenario's
 * own rules (Swift's `Fixtures.items(_:of:)`, which compiled the scenario in process). Cached per
 * test file.
 */
export function scenarioScreenItems(screen: string, scenario = "duck-pond-logon"): Promise<Uint8Array> {
  const key = `${scenario}/${screen}`
  const path = SCREEN_PATHS[key]
  if (path === undefined) return Promise.reject(new Error(`no path to screen ${key}`))
  let items = screenCache.get(key)
  if (items === undefined) {
    items = withPond(path.scenario, async pond => messageItems(await path.reach(pond)))
    screenCache.set(key, items)
  }
  return items
}

/** The screen `screen` of `scenario`, decoded (Swift's `Screen(items: Fixtures.items(_:of:))`). */
export async function scenarioScreen(
  screen: string,
  scenario = "duck-pond-logon",
  options: { readings?: ScreenReadings; codePage?: number } = {}
): Promise<Screen> {
  return Screen.fromItems(await scenarioScreenItems(screen, scenario), options)
}

/** The Duck Pond gate (Swift's `Fixtures.gate()`). */
export function gate(): Promise<Screen> {
  return scenarioScreen("pond-gate")
}

/** The input of the gate at `row` (the gate has one input per row; Swift's `Fixtures.input(_:row:)`). */
export function gateInput(screen: Screen, row: number) {
  const input = screen.inputs.find(element => element.row === row)
  assert.ok(input !== undefined, `an input at row ${row}`)
  return input
}

// MARK: - Inline screens

const inlineCache = new Map<string, Promise<Uint8Array>>()

/**
 * The item sequence of the one screen of a `.screens` text (Tests/Scenarios/README.md; Swift's
 * `Fixtures.items(screens:)`, which built it with FakeScenarios' ScreenBuilder in process): the text
 * goes into a scenario file of its own, whose reply to the first message is that screen, and the
 * fake server builds and sends it.
 */
export function inlineScreenItems(text: string): Promise<Uint8Array> {
  let items = inlineCache.get(text)
  if (items === undefined) {
    items = fetchInline(text)
    inlineCache.set(text, items)
  }
  return items
}

async function fetchInline(text: string): Promise<Uint8Array> {
  const name = /^\s*screen\s+([a-z0-9-]+)/m.exec(text)?.[1]
  assert.ok(name !== undefined, "the text names a screen")
  const directory = mkdtempSync(join(tmpdir(), "agent-gui-screens-"))
  const file = join(directory, "zz-inline.scenario")
  writeFileSync(
    file,
    [
      "# SPDX-License-Identifier: MIT",
      "# source: fake",
      "scenario zz-inline",
      'summary "One inline screen of a ScreenModel test, sent in reply to the first message."',
      text,
      `on first send ${name}`,
      ""
    ].join("\n")
  )
  try {
    return await withPond(file, async pond => messageItems(await pond.first()))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// MARK: - The Beaver Dam popup's parts

/** The parts of the Beaver Dam popup's message (Tests/Scenarios/beaver-dam.screens), in the order `dam-select` sends them. */
export type DamPart = "dam-main-head" | "dam-main-status" | "dam-main-tail" | "dam-select-head" | "dam-select-status" | "dam-select-base"

/**
 * The item sequence of one part of the Beaver Dam popup (Swift's `Fixtures.items(part, of:
 * "duck-pond-dam")`). `dam-select` is those parts in that order (beaver-dam.screens: `items-of`
 * each), so they are cut from it as the fake server sends it: the second SES item starts the popup's
 * section, and in each section the run of MNUENTRY items is the window's GUI status, the items before
 * it the head and the items after it the base (or the main window's tail).
 */
export async function damSelectPart(part: DamPart): Promise<Uint8Array> {
  const items = await scenarioScreenItems("dam-select", "duck-pond-dam")
  const walked: DiagItem[] = []
  const walker = new DiagItemWalker()
  for (;;) {
    let item: DiagItem | undefined
    try {
      item = walker.next(items)
    } catch (error) {
      if (!(error instanceof DiagItemWalkError)) throw error
      break
    }
    if (item === undefined) break
    walked.push(item)
  }
  const sesItems = walked.filter(item => item.type === "ses")
  assert.equal(sesItems.length, 2, "dam-select has two window sections")
  const popupStart = walked.indexOf(sesItems[1])
  const cut = (from: number, to: number): { head: DiagItem[]; status: DiagItem[]; tail: DiagItem[] } => {
    const section = walked.slice(from, to)
    const isMenu = (item: DiagItem) =>
      item.appl !== undefined && (item.appl.kind === "mnuEntry" || (item.appl.kind === "unknownSID" && ApplItem.applID(item.appl) === "mnuEntry"))
    const first = section.findIndex(isMenu)
    assert.ok(first >= 0, "each section of dam-select has its GUI status")
    let last = first
    while (last + 1 < section.length && isMenu(section[last + 1])) last += 1
    return { head: section.slice(0, first), status: section.slice(first, last + 1), tail: section.slice(last + 1) }
  }
  const main = cut(0, popupStart)
  const popup = cut(popupStart, walked.length)
  const parts: Record<DamPart, DiagItem[]> = {
    "dam-main-head": main.head,
    "dam-main-status": main.status,
    "dam-main-tail": main.tail,
    "dam-select-head": popup.head,
    "dam-select-status": popup.status,
    "dam-select-base": popup.tail
  }
  const chosen = parts[part]
  if (chosen.length === 0) return new Uint8Array(0)
  return items.slice(chosen[0].offset, chosen[chosen.length - 1].endOffset)
}
