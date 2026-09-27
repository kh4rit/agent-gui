// SPDX-License-Identifier: MIT
// End to end: the MCP tools, through an in-memory MCP client, against Swooey's fake DIAG server
// (loopback, invented Duck Pond screens). Skipped unless AGENT_GUI_FAKE_SERVER names the binary.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConfigFile } from "../config.js"
import { MemoryCredentialStore } from "../credentials.js"
import { callTool } from "../server.js"
import { Sessions } from "../sessions.js"
import { skipWithoutFakeServer, startFakeServer, type FakeServer } from "./support/fakeServer.js"
import { repositoryRoot } from "./vectors/paths.js"

/** agent-gui's own invented scenarios (test/scenarios). */
const ownScenario = (name: string) => join(repositoryRoot(), "test", "scenarios", name)

interface Pond {
  server: FakeServer
  sessions: Sessions
  dataDir: string
  call(tool: string, args?: Record<string, unknown>): Promise<string>
  fail(tool: string, args?: Record<string, unknown>): Promise<string>
}

/** A fake server with `scenario` and a Sessions service for system PND pointing at it. */
async function pond(scenario: string, system: Record<string, unknown> = {}, dataDir?: string): Promise<Pond> {
  const server = await startFakeServer(scenario)
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "agent-gui-e2e-"))
  const systems = parseConfigFile(
    JSON.stringify({
      systems: {
        PND: { host: server.host, port: server.port, client: "001", user: "donald", password: "quack-quack", language: "EN", stepTimeoutSeconds: 10, ...system }
      }
    }),
    {}
  ).systems
  const sessions = new Sessions({ systems, defaultSystem: "PND", dataDir: dir }, { terminalName: "zz-e2e", store: new MemoryCredentialStore() })
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(sessions, tool, args)
    assert.equal(r.isError, false, `${tool} failed: ${r.text}`)
    return r.text
  }
  const fail = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(sessions, tool, args)
    assert.equal(r.isError, true, `${tool} should have failed: ${r.text}`)
    return r.text
  }
  return { server, sessions, dataDir: dir, call, fail }
}

async function done(p: Pond) {
  await p.sessions.close()
  await p.server.stop()
}

test("logon, a transaction, back, a second session, log off", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-logon")
  try {
    const lobby = await p.call("gui_connect")
    assert.match(lobby, /S1 · PND · .*ZZ_DUCK_LOBBY 0100/)
    assert.doesNotMatch(lobby, /quack-quack/)
    const duck = await p.call("gui_start", { session: "S1", transaction: "ZZDUCK" })
    assert.match(duck, /changed: transaction ZZDUCK/)
    assert.match(duck, /ZZ_RUBBER_DUCK/)
    const back = await p.call("gui_step", { session: "S1", key: "F3" })
    assert.match(back, /ZZ_DUCK_LOBBY 0100/)
    const second = await p.call("gui_connect", { transaction: "ZZCOFFEE" })
    assert.match(second, /^changed: .*\n\nS2 · PND/m)
    const systems = await p.call("gui_list_systems")
    assert.match(systems, /S1 /)
    assert.match(systems, /S2 ZZCOFFEE/)
    assert.match(await p.call("gui_disconnect", { session: "S2" }), /Session S2 ended/)
    assert.match(await p.call("gui_disconnect", { system: "PND" }), /Logged off PND/)
    assert.match(await p.fail("gui_screen", { session: "S1" }), /Unknown session/)
  } finally {
    await done(p)
  }
})

test("a table control: paging, a cell edit, Save refused in gui_step, gui_save", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-apps")
  try {
    const cfg = await p.call("gui_connect", { transaction: "ZZPOND_CFG" })
    assert.match(cfg, /table t1 ZZ_SPOTS: rows 1-15 of 1000, rows can be marked/)
    assert.doesNotMatch(cfg, /ZZSPOT-MARK/, "row selectors are the table's marks, not fields")
    const rows = await p.call("gui_table", { session: "S1", table: "t1", fromRow: 40, rows: 5 })
    assert.match(rows, /table t1 ZZ_SPOTS: 5 rows of 1000/)
    assert.match(rows, /\| 40 \| \[ \] \| S0040 \|/)
    assert.match(rows, /\| 44 \| \[ \] \| S0044 \|/)
    // the screen is back where it was
    assert.match(await p.call("gui_screen", { session: "S1" }), /rows 1-15 of 1000/)
    assert.match(await p.fail("gui_step", { session: "S1", key: "Ctrl+S" }), /saves: use gui_save/)
    assert.match(await p.fail("gui_step", { session: "S1", function: "Save the Pond" }), /saves: use gui_save/)
    assert.match(await p.fail("gui_step", { session: "S1", okcode: "/11" }), /saves: use gui_save/)
    const edited = await p.call("gui_step", { session: "S1", cells: [{ table: "t1", row: 2, column: "Crumbs/day", value: "99" }] })
    assert.match(edited, /Unsaved changes: 1/)
    assert.match(await p.fail("gui_step", { session: "S1", cells: [{ table: "t1", row: 400, column: "QUOTA", value: "1" }] }), /not on the visible page/)
    const saved = await p.call("gui_save", { session: "S1" })
    assert.match(saved, /^saved: yes/)
    assert.match(saved, /Unsaved changes: 0/)
    // the audit log has the steps, with the edited value
    const audit = readdirSync(join(p.dataDir, "audit"))
    const lines = readFileSync(join(p.dataDir, "audit", audit[0]), "utf8").trim().split("\n").map(l => JSON.parse(l))
    assert.ok(lines.some(l => l.tool === "gui_step" && l.changes?.some((c: { field: string; value: string }) => c.field === "ZZSPOT-QUOTA" && c.value === "99")))
    assert.ok(lines.some(l => l.tool === "gui_save"))
    assert.ok(!JSON.stringify(lines).includes("quack-quack"))
  } finally {
    await done(p)
  }
})

test("read-only systems refuse gui_save", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-apps", { readOnly: true })
  try {
    await p.call("gui_connect", { transaction: "ZZPOND_CFG" })
    assert.match(await p.fail("gui_save", { session: "S1" }), /read-only/)
  } finally {
    await done(p)
  }
})

test("trees and grids: node open, grid double-click, a current cell reported with F6", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-scene")
  try {
    const lobby = await p.call("gui_connect")
    assert.match(lobby, /tree c105 in ZZ_POND_CONTAINER: 5 nodes loaded/)
    assert.match(lobby, /Mallard Mel {2}\{DUCK01\}/)
    assert.match(lobby, /grid c106 .*3 rows/)
    const found = await p.call("gui_tree", { session: "S1", control: "c105", action: "find", text: "*mel*" })
    assert.match(found, /Mallard Mel/)
    assert.doesNotMatch(found, /Quackers/)
    const nest = await p.call("gui_tree", { session: "S1", control: "c105", action: "open", node: "DUCK01" })
    assert.match(nest, /ZZ_DUCK_NEST 0300/)
  } finally {
    await done(p)
  }
  const q = await pond("duck-pond-scene")
  try {
    await q.call("gui_connect")
    assert.match(await q.call("gui_grid", { session: "S1", control: "c106", action: "open", row: 3, column: "DUCK" }), /Sir Waddles, regal/)
  } finally {
    await done(q)
  }
  const r = await pond("duck-pond-scene")
  try {
    await r.call("gui_connect")
    await r.call("gui_grid", { session: "S1", control: "c106", action: "select", row: 2, column: "MOOD" })
    assert.match(await r.call("gui_step", { session: "S1", key: "F6" }), /Moods on the pond/)
  } finally {
    await done(r)
  }
})

test("a selection screen, a list read across pages, a line chosen into a popup", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-apps")
  try {
    const selection = await p.call("gui_connect", { transaction: "ZZBREAD_RPT" })
    assert.match(selection, /input "Duck" \(ZZBREAD-DUCK-LOW\)/)
    assert.match(selection, /radio \(•\) "Classic list"/)
    const list = await p.call("gui_step", { session: "S1", key: "F8" })
    assert.match(list, /list: lines 1-20 of 215/)
    const more = await p.call("gui_table", { session: "S1", table: "list", fromRow: 100, rows: 6 })
    assert.match(more, /list: lines 100-105 of 215/)
    assert.match(more, / {2}105\| /)
    const popup = await p.call("gui_step", { session: "S1", chooseLine: 2 })
    assert.match(popup, /popup opened "Duck Profile"/)
    assert.match(await p.call("gui_step", { session: "S1", key: "F12" }), /popup closed/)
  } finally {
    await done(p)
  }
})

test("policy: deny list and allow list", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-apps", { transactions: { allow: ["ZZDUCK", "ZZPOND_CFG"] } })
  try {
    await p.call("gui_connect")
    assert.match(await p.fail("gui_start", { session: "S1", transaction: "SU01" }), /deny list/)
    assert.match(await p.fail("gui_start", { session: "S1", transaction: "ZZCOFFEE" }), /allowed list/)
    assert.match(await p.fail("gui_step", { session: "S1", okcode: "/nZZCOFFEE" }), /allowed list/)
    assert.match(await p.fail("gui_step", { session: "S1", okcode: "/h" }), /debugger/)
    assert.match(await p.call("gui_start", { session: "S1", transaction: "ZZDUCK" }), /ZZ_RUBBER_DUCK/)
  } finally {
    await done(p)
  }
})

test("a rejected password suspends the logon; nothing is retried", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-wrong-quack")
  try {
    assert.match(await p.fail("gui_connect"), /rejected: Honk!/)
    const before = p.server.log.filter(l => l.includes("dialog message")).length
    assert.match(await p.fail("gui_connect"), /suspended/)
    assert.equal(p.server.log.filter(l => l.includes("dialog message")).length, before, "no second logon step went out")
  } finally {
    await done(p)
  }
})

test("already logged on: fail stops with an explanation, continue logs on", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-paddling")
  try {
    assert.match(await p.fail("gui_connect"), /already logged on/)
  } finally {
    await done(p)
  }
  const q = await pond("duck-pond-paddling", { whenAlreadyLoggedOn: "continue" })
  try {
    assert.match(await q.call("gui_connect"), /ZZ_DUCK_LOBBY/)
  } finally {
    await done(q)
  }
})

test("a password change after the logon is reported, not handled", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond("duck-pond-new-quack")
  try {
    assert.match(await p.fail("gui_connect"), /another screen of the logon program/)
  } finally {
    await done(p)
  }
})

test("keep-alive pings and control calls are answered without the agent", { skip: skipWithoutFakeServer }, async () => {
  for (const scenario of ["keep-alive", "duck-pond-control"]) {
    const p = await pond(scenario)
    try {
      assert.match(await p.call("gui_connect"), /ZZ_DUCK_LOBBY|pond-lobby|Lobby/i)
    } finally {
      await done(p)
    }
  }
})

test("gui_save answers the request prompt with the user's request, and cancels it without one", { skip: skipWithoutFakeServer }, async () => {
  const p = await pond(ownScenario("zz-pond-bureau.scenario"))
  try {
    await p.call("gui_connect", { transaction: "ZZPOND_RULES" })
    await p.call("gui_step", { session: "S1", edits: [{ field: "Duck limit", value: "42" }] })
    const asked = await p.call("gui_save", { session: "S1" })
    assert.match(asked, /^saved: no — SAP asks for a transport request \(Which request holds the pond rules\?/)
    assert.match(asked, /Nothing saved: the request prompt was cancelled/)
    const saved = await p.call("gui_save", { session: "S1", transport: "zzbk900042" })
    assert.match(saved, /^saved: yes/)
    assert.match(saved, /message: S Pond rules saved in request ZZBK900042/)
    assert.match(saved, /"Duck limit" \(ZZRULES-LIMIT\) = "42"/)
  } finally {
    await done(p)
  }
})
