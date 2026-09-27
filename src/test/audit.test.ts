// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuditLog } from "../audit.js"

test("one JSON line per entry, values optional", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gui-audit-"))
  const log = new AuditLog(dir, () => new Date("2026-09-27T10:00:00Z"))
  const entry = {
    tool: "gui_step",
    system: "PND",
    session: "S1",
    transaction: "ZZPOND_CFG",
    trigger: "Enter",
    changes: [{ field: "ZZV_RULES-DUCK_LIMIT", value: "12" }]
  }
  log.record(entry, true)
  log.record(entry, false)
  const lines = readFileSync(join(dir, "audit", "2026-09-27.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].changes[0].value, "12")
  assert.equal(lines[1].changes[0].value, undefined)
  assert.equal(lines[1].changes[0].field, "ZZV_RULES-DUCK_LIMIT")
  assert.equal(lines[0].time, "2026-09-27T10:00:00.000Z")
})
