// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { parseConfigFile } from "../config.js"
import type { AgentScreen } from "../engine/agentScreen.js"
import { callTool, createServer } from "../server.js"
import type { GuiService, SaveResult, StepRequest, StepResult } from "../service.js"
import { triggerFrom } from "../tools.js"

const config = parseConfigFile(JSON.stringify({ systems: { PND: { host: "127.0.0.1", instance: "00", user: "donald", password: "x" } } }), {}).systems[0]

const screen = (over: Partial<AgentScreen> = {}): AgentScreen => ({
  system: "PND",
  session: "S1",
  transaction: "ZZDUCK",
  program: "ZZ_DUCK",
  screenNumber: "0100",
  title: "Count the ducks",
  functions: [{ ref: "k1", text: "Enter", virtualKey: 0, where: "standard", enabled: true }],
  fields: [{ ref: "f1", kind: "input", label: "Ducks", text: "3", row: 1, column: 10, width: 3, editable: true }],
  tables: [],
  tabs: [],
  controls: [],
  logonScreen: false,
  notices: [],
  ...over
})

class FakeGui implements GuiService {
  steps: StepRequest[] = []
  saves: (string | undefined)[] = []
  systems() {
    return [{ config, isDefault: true, sessions: [{ session: "S1", system: "PND", transaction: "ZZDUCK", busy: false }] }]
  }
  async connect(): Promise<StepResult> {
    return { screen: screen(), change: "screen ZZ_DUCK 0100" }
  }
  async disconnect() {
    return "logged off"
  }
  screen() {
    return screen()
  }
  async start(): Promise<StepResult> {
    return { screen: screen(), change: "transaction ZZDUCK" }
  }
  async step(request: StepRequest): Promise<StepResult> {
    this.steps.push(request)
    return { screen: screen({ message: { type: "S", text: "Quack" } }), change: "same screen; message S: Quack" }
  }
  async readTable() {
    return { lines: ["Duck  Quacks", "Huey  3"], firstLine: 1, totalLines: 2 }
  }
  async tree(): Promise<StepResult> {
    return { screen: screen(), change: "same screen" }
  }
  async grid(): Promise<StepResult> {
    return { screen: screen(), change: "same screen" }
  }
  async save(_session: string, transport?: string): Promise<SaveResult> {
    this.saves.push(transport)
    if (!transport)
      return { screen: screen(), change: "popup closed", saved: false, transportPrompt: { text: "Prompt for customizing request", candidates: ["ZZDK900077"] } }
    return { screen: screen({ message: { type: "S", text: "Data was saved" } }), change: "message S: Data was saved", saved: true }
  }
  async wait(): Promise<StepResult> {
    return { screen: screen(), change: "same screen" }
  }
  async close() {}
}

test("every tool is listed with its annotations", async () => {
  const server = createServer(new FakeGui())
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  const client = new Client({ name: "t", version: "0" })
  await client.connect(a)
  const tools = (await client.listTools()).tools
  assert.deepEqual(
    tools.map(t => t.name).sort(),
    ["gui_connect", "gui_disconnect", "gui_grid", "gui_list_systems", "gui_save", "gui_screen", "gui_start", "gui_step", "gui_table", "gui_tree", "gui_wait"]
  )
  const save = tools.find(t => t.name === "gui_save")!
  assert.equal(save.annotations?.destructiveHint, true)
  assert.equal(tools.find(t => t.name === "gui_screen")!.annotations?.readOnlyHint, true)
  await client.close()
  await server.close()
})

test("gui_step passes edits and exactly one trigger", async () => {
  const gui = new FakeGui()
  const out = await callTool(gui, "gui_step", { session: "S1", edits: [{ field: "f1", value: "4" }], key: "F8" })
  assert.equal(out.isError, false)
  assert.match(out.text, /^changed: same screen; message S: Quack/)
  assert.deepEqual(gui.steps[0].trigger, { kind: "key", key: "F8" })
  const both = await callTool(gui, "gui_step", { session: "S1", key: "F8", okcode: "/n" })
  assert.equal(both.isError, true)
  assert.match(both.text, /exactly one/)
  assert.deepEqual(triggerFrom({}), { kind: "enter" })
})

test("gui_save without a transport explains the prompt", async () => {
  const gui = new FakeGui()
  const out = await callTool(gui, "gui_save", { session: "S1" })
  assert.match(out.text, /saved: no — SAP asks for a transport request/)
  assert.match(out.text, /ZZDK900077/)
  const ok = await callTool(gui, "gui_save", { session: "S1", transport: "ZZDK900077" })
  assert.match(ok.text, /^saved: yes/)
  assert.deepEqual(gui.saves, [undefined, "ZZDK900077"])
})

test("gui_table formats list lines; gui_list_systems shows sessions", async () => {
  const gui = new FakeGui()
  const list = await callTool(gui, "gui_table", { session: "S1", table: "list" })
  assert.match(list.text, /list: lines 1-2 of 2/)
  assert.match(list.text, /2\| Huey {2}3/)
  const systems = await callTool(gui, "gui_list_systems", {})
  assert.match(systems.text, /PND \(default\): 127\.0\.0\.1:3200/)
  assert.match(systems.text, /S1 ZZDUCK/)
})
