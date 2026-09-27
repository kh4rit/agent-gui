// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { Policy, PolicyError, SAVE_VIRTUAL_KEY, parseOkCode } from "../policy.js"

const system = (over: Partial<ConstructorParameters<typeof Policy>[0]> = {}) =>
  new Policy({ name: "PND", readOnly: false, transactions: { builtInDenyList: true }, commitFunctions: ["BU"], ...over })

test("OK-code prefixes", () => {
  assert.deepEqual(parseOkCode("/nzzduck"), { kind: "start", transaction: "ZZDUCK", newSession: false })
  assert.deepEqual(parseOkCode("/o/ZZPOND/MON"), { kind: "start", transaction: "/ZZPOND/MON", newSession: true })
  assert.deepEqual(parseOkCode("/n"), { kind: "endTransaction" })
  assert.deepEqual(parseOkCode("/o"), { kind: "newSession" })
  assert.deepEqual(parseOkCode("/i"), { kind: "endSession" })
  assert.deepEqual(parseOkCode("/nex"), { kind: "logOff" })
  assert.deepEqual(parseOkCode("/NEND"), { kind: "logOff" })
  assert.deepEqual(parseOkCode("NEWL"), { kind: "function", code: "NEWL" })
  assert.deepEqual(parseOkCode("/08"), { kind: "function", code: "/08" })
})

test("the built-in deny list and the allow list", () => {
  const p = system()
  assert.throws(() => p.checkStart("SU01"), PolicyError)
  assert.throws(() => p.checkOkCode("/nSE38"), /deny list/)
  p.checkStart("ZZDUCK")
  const allow = system({ transactions: { allow: ["ZZDUCK"], builtInDenyList: true } })
  allow.checkStart("zzduck")
  assert.throws(() => allow.checkStart("ZZCOFFEE"), /allowed list/)
  const open = system({ transactions: { builtInDenyList: false } })
  open.checkStart("SE38")
})

test("blocked OK-codes: the debugger and table editing", () => {
  const p = system()
  assert.throws(() => p.checkOkCode("/h"), /debugger/)
  assert.throws(() => p.checkOkCode("/hs"), /debugger/)
  assert.throws(() => p.checkOkCode("&SAP_EDIT"), /editing/)
})

test("committing functions go through gui_save", () => {
  const p = system()
  assert.equal(p.isCommit({ virtualKey: SAVE_VIRTUAL_KEY }, undefined), true)
  assert.equal(p.isCommit({ functionCode: "ZZSAVE" }, "ZZSAVE"), true)
  assert.equal(p.isCommit({ functionCode: "=bu" }, undefined), true)
  assert.equal(p.isCommit({ functionCode: "NEWL" }, "SAVE"), false)
  assert.throws(() => p.checkOkCode("BU"), /gui_save/)
})

test("screens of a denied transaction can only be left", () => {
  const p = system()
  assert.throws(() => p.checkScreen("SM59", false), /Leave it/)
  p.checkScreen("SM59", true)
  p.checkScreen(undefined, false)
})

test("read-only systems refuse writes", () => {
  assert.throws(() => system({ readOnly: true }).checkWrite(), /read-only/)
  system().checkWrite()
})
