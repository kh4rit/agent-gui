// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, describeSystem, loadConfig, parseConfigFile } from "../config.js"

const pond = {
  defaultSystem: "PND",
  systems: {
    PND: { host: "127.0.0.1", instance: "00", client: "001", user: "donald", password: "${credential}" },
    ZOO: { host: "127.0.0.1", port: 3299, user: "daisy", password: "${env:ZOO_PASSWORD}", readOnly: true, transactions: { allow: ["zzduck", "ZZCOFFEE"] } }
  }
}

test("systems keyed by name, instance to port, user upper-cased", () => {
  const cfg = parseConfigFile(JSON.stringify(pond), { ZOO_PASSWORD: "quack" })
  const [pnd, zoo] = cfg.systems
  assert.equal(pnd.name, "PND")
  assert.equal(pnd.port, 3200)
  assert.equal(pnd.user, "DONALD")
  assert.deepEqual(pnd.password, { kind: "credentialStore" })
  assert.equal(pnd.identity, "reference")
  assert.equal(pnd.whenAlreadyLoggedOn, "fail")
  assert.equal(zoo.port, 3299)
  assert.deepEqual(zoo.password, { kind: "value", value: "quack" })
  assert.equal(zoo.readOnly, true)
  assert.deepEqual(zoo.transactions.allow, ["ZZDUCK", "ZZCOFFEE"])
})

test("a byte order mark is tolerated", () => {
  const cfg = parseConfigFile("﻿" + JSON.stringify({ host: "h", instance: "01", user: "u" }), {})
  assert.equal(cfg.systems[0].name, "default")
  assert.equal(cfg.systems[0].port, 3201)
})

test("missing environment variables and bad values are reported", () => {
  assert.throws(() => parseConfigFile(JSON.stringify(pond), {}), /ZOO_PASSWORD/)
  assert.throws(() => parseConfigFile(JSON.stringify({ host: "h", user: "u" }), {}), /instance/)
  assert.throws(() => parseConfigFile(JSON.stringify({ host: "h", instance: "123", user: "u" }), {}), /instance/)
  assert.throws(() => parseConfigFile(JSON.stringify({ host: "h", instance: "00", user: "u", client: "1" }), {}), /client/)
  assert.throws(() => parseConfigFile(JSON.stringify({ host: "/H/router/S/3299/H/h", instance: "00", user: "u" }), {}), /SAProuter/)
  assert.throws(() => parseConfigFile(JSON.stringify({ host: "h", instance: "00", user: "u", identity: "sap-gui-9000" }), {}), /identity/)
})

test("loadConfig: file, environment system, default system", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gui-config-"))
  const file = join(dir, "systems.json")
  writeFileSync(file, JSON.stringify(pond))
  const cfg = loadConfig(["--config", file], { ZOO_PASSWORD: "quack", AGENT_GUI_HOME: dir })
  assert.equal(cfg.defaultSystem, "PND")
  assert.equal(cfg.systems.length, 2)
  assert.equal(cfg.dataDir, dir)
  const empty = mkdtempSync(join(tmpdir(), "agent-gui-config-"))
  const env = loadConfig([], { AGENT_GUI_HOME: empty, SAP_HOST: "127.0.0.1", SAP_INSTANCE: "00", SAP_USER: "scrooge", SAP_PASSWORD: "coins" })
  assert.equal(env.systems[0].name, "default")
  assert.equal(env.systems[0].user, "SCROOGE")
})

test("no system at all explains how to configure one", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gui-config-"))
  assert.throws(() => loadConfig([], { AGENT_GUI_HOME: dir }), (e: unknown) => e instanceof ConfigError && /set-password/.test(e.message))
})

test("describeSystem never shows a password", () => {
  const cfg = parseConfigFile(JSON.stringify(pond), { ZOO_PASSWORD: "quack-quack" })
  const text = cfg.systems.map(s => describeSystem(s, s.name === "PND")).join("\n")
  assert.ok(!text.includes("quack-quack"))
  assert.match(text, /PND \(default\): 127\.0\.0\.1:3200/)
  assert.match(text, /READ-ONLY/)
})
