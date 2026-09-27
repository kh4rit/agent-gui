// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/DPTerminalNameTests.swift (MIT).
//
// Not ported: `currentHostIsTheMachinesHostName`. Swooey's DPTerminalName reads the host name
// with gethostname(); the port keeps src/diag free of Node APIs, so the host passes the name in
// (`fromHostName`) and there is no `currentHost()` to test here.

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { DPTerminalName } from "../../../diag/wire/index.js"
import { concat, utf8 } from "./support.js"

/**
 * IMPL-DP-4 (host name to terminal bytes), R-DP-4 (zero fill), R-DP-5 (15 bytes, no terminator),
 * PV-0255 (no name: 15 zero bytes). Host names are invented.
 */
describe("DP terminal name", () => {
  const cases: [string, string][] = [
    ["testhost", "testhost"],
    ["", ""],
    ["waffle-iron-015", "waffle-iron-015"], // exactly 15: kept whole
    ["waffle-iron-0150", "waffle-iron-015"], // 16: the first 15 bytes
    ["the-grand-hamster-observatory.example", "the-grand-hamst"],
    ["Zürich-Käse-Labor", "Zrich-Kse-Labor"], // non-ASCII characters dropped, not replaced
    ["tab\there", "tabhere"], // control characters dropped
    ["del\u007fete", "delete"],
    ["nul\u0000byte", "nulbyte"],
    ["space ok", "space ok"], // 0x20 is printable
    ["~tilde~", "~tilde~"], // 0x7E is printable
    ["🦙🦙🦙", ""], // nothing printable remains: empty
    ["日本語のホスト名-ZZ", "-ZZ"],
    ["éclair", "eclair"] // a combining mark is a non-ASCII character
  ]
  for (const [hostName, expected] of cases) {
    test(`normalisation(${JSON.stringify(hostName)}, ${JSON.stringify(expected)})`, () => {
      const name = DPTerminalName.fromHostName(hostName)
      assert.deepEqual(name.bytes, utf8(expected))
      assert.equal(name.fieldBytes.length, 15)
      assert.deepEqual(name.fieldBytes, concat(utf8(expected), new Uint8Array(15 - utf8(expected).length)))
    })
  }

  test("everyByteValue", () => {
    for (let byte = 0; byte <= 0xff; byte++) {
      const name = DPTerminalName.normalizing([byte, 0x41])
      if (byte >= 0x20 && byte <= 0x7e) assert.deepEqual(name.bytes, Uint8Array.of(byte, 0x41))
      else assert.deepEqual(name.bytes, Uint8Array.of(0x41), `byte ${byte} must be dropped`)
    }
  })

  test("emptyIsFifteenZeroBytes", () => {
    assert.equal(DPTerminalName.empty.bytes.length, 0)
    assert.deepEqual(DPTerminalName.empty.fieldBytes, new Uint8Array(15))
    assert.deepEqual(DPTerminalName.fromHostName("").bytes, DPTerminalName.empty.bytes)
  })

  test("longInputStopsAtTheWidth", () => {
    const name = DPTerminalName.normalizing(new Uint8Array(100_000).fill(0x7a))
    assert.deepEqual(name.bytes, new Uint8Array(15).fill(0x7a))
  })
})
