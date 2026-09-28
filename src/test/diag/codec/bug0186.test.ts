// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/Bug0186Tests.swift (MIT).

// source: fake — cursor coordinates are invented.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientInput,
  ClientInputStep,
  ClientMessageEncoder,
  DiagHeader,
  DiagItemWalker,
  InputEnvelope,
  InputFocus,
  ListFocus,
  ListWindowState,
  ServerEcho,
  type DiagItemType
} from "../../../diag/codec/index.js"
import { DPTerminalName } from "../../../diag/wire/index.js"
import { bytes, repeated, zzTestIdentity } from "../../support/codecTestSupport.js"

// Swift's `InputEnvelopeTests.encoder()` and `.echo()`: the same invented echo values, repeated
// here because a node:test file cannot import another test file without running its tests again.

function encoder(): ClientMessageEncoder {
  return new ClientMessageEncoder(zzTestIdentity(), DPTerminalName.fromHostName("zz-duckpond"))
}

function echo(): ServerEcho {
  const echo = new ServerEcho()
  echo.modeStat = 0
  echo.stepNumber = 1
  echo.ses = bytes(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7a, 0x7b, 0x12, 0x40)
  echo.codepageDiagGUI = bytes(0x00, 0x00, 0x10, 0x0e, 0x01, 0x34, 0x31, 0x31, 0x30, 0x00, 0x5a, 0x5a, 0x00)
  echo.dynnCHL = Uint8Array.from({ length: 0x56 - 0x40 }, (_, index) => 0x40 + index)
  echo.scrollInfos2 = Uint8Array.from({ length: 0x81 - 0x60 }, (_, index) => 0x60 + index)
  echo.containerReset = repeated(0, 9)
  return echo
}

const envelopes: [string, InputEnvelope][] = [
  ["minimal", InputEnvelope.minimal],
  ["chlStage", InputEnvelope.chlStage]
]

describe("Bug #186: optional list cursor carrier", () => {
  /** Both envelope paths encode LIST_FOCUS only when requested (bug #186) */
  for (const [name, envelope] of envelopes) {
    for (const enabled of [false, true]) {
      test(`listFocus(${name}, ${enabled})`, () => {
        const step = new ClientInputStep({ envelope })
        if (enabled) step.listFocus = new ListFocus({ version: 1, row: 258, col: 515 })
        const message = ClientInput.inputMessage(encoder(), step, 0, echo())
        const items = message.subarray(DiagHeader.size)
        const walker = new DiagItemWalker()
        const found: Uint8Array[] = []
        for (let item = walker.next(items); item !== undefined; item = walker.next(items)) {
          if (item.appl !== undefined && ApplItem.equals(item.appl, ApplItem.varInfo("listFocus"))) found.push(item.valueRange.of(items).slice())
        }
        assert.deepEqual(found, enabled ? [bytes(1, 1, 2, 2, 3)] : [])
      })
    }
  }

  /** Plain list state replaces stale dynpro carriers (bug #186) */
  for (const [name, envelope] of envelopes) {
    test(`plainWindow(${name})`, () => {
      const window = new ListWindowState({ currentRow: 4, currentColumn: 9, undecoded: 0x12345678 })
      const step = new ClientInputStep({ dynnCHL: new Uint8Array(22), envelope })
      step.plainListWindow = window
      step.listFocus = new ListFocus({ version: 1, row: 7, col: 13 })
      step.focus = new InputFocus(7, 13)
      const message = ClientInput.inputMessage(encoder(), step, 0, echo())
      const items = message.subarray(DiagHeader.size)
      const walker = new DiagItemWalker()
      const windows: Uint8Array[] = []
      const order: DiagItemType[] = []
      for (let item = walker.next(items); item !== undefined; item = walker.next(items)) {
        order.push(item.type)
        if (item.type === "chl") windows.push(item.valueRange.of(items).slice())
        const appl = item.appl
        assert.ok(appl === undefined || !ApplItem.equals(appl, ApplItem.dynn("chl")))
        assert.ok(appl === undefined || !ApplItem.equals(appl, ApplItem.dynt("noFocus")))
        assert.ok(appl === undefined || !ApplItem.equals(appl, ApplItem.dynt("focus1")))
      }
      assert.deepEqual(windows, [window.bytes])
      assert.equal(order.filter(type => type === "chl").length, 1)
    })
  }
})
