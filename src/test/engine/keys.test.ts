// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { keyLabel, okCodeVirtualKey, parseKey } from "../../engine/keys.js"

test("key names become virtual keys", () => {
  assert.equal(parseKey("F8"), 8)
  assert.equal(parseKey("f3"), 3)
  assert.equal(parseKey("Shift+F2"), 14)
  assert.equal(parseKey("Ctrl+F1"), 25)
  assert.equal(parseKey("Ctrl+Shift+F12"), 48)
  assert.equal(parseKey("Shift+Ctrl+F12"), 48)
  assert.equal(parseKey("Ctrl+S"), 11)
  assert.equal(parseKey("Enter"), 0)
  assert.equal(parseKey("PageDown"), 82)
  assert.equal(parseKey("Page Up"), 81)
  assert.equal(parseKey("first page"), 80)
  assert.equal(parseKey("F13"), undefined)
  assert.equal(parseKey("Quack"), undefined)
})

test("virtual keys have labels; /NN OK-codes fire keys", () => {
  assert.equal(keyLabel(14), "Shift+F2")
  assert.equal(keyLabel(11), "Ctrl+S")
  assert.equal(keyLabel(82), "PageDown")
  assert.equal(okCodeVirtualKey("/11"), 11)
  assert.equal(okCodeVirtualKey("/08"), 8)
  assert.equal(okCodeVirtualKey("/8"), undefined)
  assert.equal(okCodeVirtualKey("/nSE16"), undefined)
})
