// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConfigFile } from "../config.js"
import { CredentialError, LogonState, MemoryCredentialStore, credentialTarget, platformCredentialStore, resolvePassword } from "../credentials.js"

const systems = parseConfigFile(
  JSON.stringify({
    systems: {
      PND: { host: "127.0.0.1", instance: "00", client: "001", user: "donald", password: "${credential}" },
      ZOO: { host: "127.0.0.1", instance: "00", user: "daisy", password: "${env:ZOO}" },
      NOPE: { host: "127.0.0.1", instance: "00", user: "gladstone" }
    }
  }),
  { ZOO: "honk" }
).systems

test("passwords come from the credential store, the config value, or nowhere", async () => {
  const store = new MemoryCredentialStore()
  await assert.rejects(resolvePassword(systems[0], store), (e: unknown) => e instanceof CredentialError && /--set-password --system PND/.test(e.message))
  await store.write(credentialTarget(systems[0]), "DONALD", new TextEncoder().encode("Quack!42"))
  assert.equal(new TextDecoder().decode(await resolvePassword(systems[0], store)), "Quack!42")
  assert.equal(new TextDecoder().decode(await resolvePassword(systems[1], store)), "honk")
  await assert.rejects(resolvePassword(systems[2], store), /no password configured/)
})

test("the attempt budget suspends before the attempt and clears only on success", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gui-state-"))
  const state = new LogonState(dir)
  const key = LogonState.accountKey(systems[0])
  assert.equal(state.suspension(key), undefined)
  state.beginAttempt(key)
  assert.match(state.suspension(key)!.reason, /did not complete/)
  // a second process sees the write-ahead record
  assert.ok(new LogonState(dir).suspension(key))
  state.failed(key, "password rejected")
  assert.equal(state.suspension(key)!.reason, "password rejected")
  state.clear(key)
  assert.equal(state.suspension(key), undefined)
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "state.json")).mode & 0o777, 0o600)
  assert.ok(!readFileSync(join(dir, "state.json"), "utf8").includes("Quack"))
})

// The real credential store of this platform, only when explicitly asked for (it writes to the
// user's Keychain / Credential Manager): AGENT_GUI_TEST_CREDENTIAL_STORE=1.
test("platform credential store round trip", { skip: process.env.AGENT_GUI_TEST_CREDENTIAL_STORE !== "1" }, async () => {
  const store = platformCredentialStore()
  const target = `agent-gui:TEST-${process.pid}`
  const secret = new TextEncoder().encode(`Quäck "and" \\honk ${Date.now()}`)
  await store.write(target, "ZZTESTER", secret)
  try {
    assert.deepEqual(await store.read(target, "ZZTESTER"), secret)
  } finally {
    assert.equal(await store.remove(target, "ZZTESTER"), true)
  }
  assert.equal(await store.read(target, "ZZTESTER"), undefined)
})
