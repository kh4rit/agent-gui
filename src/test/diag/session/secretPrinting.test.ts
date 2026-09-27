// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/SecretPrintingTests.swift (MIT).

// Once a Secret is in an input step, nothing prints its bytes or its length (IMPL-DA-1; AGENTS.md:
// passwords never appear in logs or dumps): not the error of a password that does not fit, not
// the step's items, and not the session's reaction that carries the encoded message. Each view is
// compared across two invented passwords of different lengths (D15): a byte or a length in it
// would make the two differ.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ClientInput,
  ClientInputError,
  ClientInputStep,
  ClientItem,
  DyntAttributes,
  ReturnedField,
  SESValue,
  Secret
} from "../../../diag/codec/index.js"
import { LogonStep } from "../../../diag/session/index.js"
import { bytes, repeated } from "../../support/codecTestSupport.js"
import { LogonFixtures, LogonScreens, utf8 } from "../../support/sessionTestSupport.js"

describe("A password in an input step prints neither its bytes nor its length", () => {
  /** Two invented passwords of different lengths (D15). */
  const passwords = ["crocodile-tears", "sardines-4-ever-and-a-day-in-the-moat"] // secret-scan: allow invented test passwords (D15)

  /**
   * Every way a value can be shown: `String`, interpolation, `util.inspect` (Swift's debug
   * description), its deep form (Swift's dump) and JSON.
   */
  function views(value: unknown): string[] {
    return [String(value), inspect(value), `${value}`, inspect(value, { depth: Infinity, showHidden: true }), JSON.stringify(value) ?? "undefined"]
  }

  /** The decimal rendering an array of the password's bytes would have. */
  function bytesShown(password: string): string {
    return Array.from(utf8(password)).join(", ")
  }

  /** a password longer than dlen's byte: the error is the same for 256 and 300 bytes and holds no length */
  test("errorHoldsNoLength", () => {
    const field = new ReturnedField({
      block: 1,
      row: 8,
      col: 30,
      mlen: 255,
      maxNrChars: 400,
      attributes: DyntAttributes.yes3D | DyntAttributes.invisible
    })
    const shown: string[][] = []
    for (const count of [256, 300]) {
      const step = new ClientInputStep()
      try {
        step.appendSecretField(field, new Secret(repeated(0x71, count)))
        assert.fail(`${count} bytes do not fit dlen's one byte`)
      } catch (error) {
        assert.ok(error instanceof ClientInputError, String(error))
        assert.deepStrictEqual(error.info, { kind: "secretNotEncodable" })
        // util.inspect prints an error's stack, whose line numbers belong to the test run, not to
        // the error: it is shown with its name and message in place of the stack.
        error.stack = String(error)
        const errorViews = views(error)
        for (const view of errorViews) {
          assert.ok(!view.includes(`${count}`), view)
        }
        shown.push(errorViews)
      }
      assert.equal(step.fieldCount, 0)
    }
    assert.ok(shown.length === 2)
    assert.deepStrictEqual(shown[0], shown[1])
  })

  /** the logon step's items print no byte and no length of the password */
  test("itemsHoldNoPassword", () => {
    const screen = LogonScreens.received(LogonScreens.gate())
    const shown: string[][] = []
    for (const password of passwords) {
      const step = new LogonStep(screen, LogonFixtures.credentials({ password }))
      const items = step.input.items
      // A ClientItem is a plain object in the port: its description is ClientInput.describeItem
      // (Swift's ClientItem.description), and the step's DYNT_ATOM item withholds its value from
      // util.inspect and JSON as Swift's mirror does. The step that holds the items prints its
      // counts only.
      const itemViews = [`[${items.map(item => ClientInput.describeItem(item)).join(", ")}]`, ...views(items), ...views(step.input)]
      for (const item of items) itemViews.push(ClientInput.describeItem(item), ...views(item))
      for (const view of itemViews) {
        assert.ok(!view.includes(bytesShown(password)), view)
        assert.ok(!view.includes(password))
      }
      shown.push(itemViews)
    }
    assert.deepStrictEqual(shown[0], shown[1], `${shown[0]?.[0] ?? ""} / ${shown[1]?.[0] ?? ""}`)
  })

  /** the other items still show their values; a DYNT_ATOM shows neither bytes nor a length */
  test("otherItemsShowTheirValues", () => {
    assert.equal(ClientInput.describeItem(ClientItem.varInfoOKCode(bytes(0x5a, 0x5a))), "varInfoOKCode(text: [90, 90])")
    assert.equal(ClientInput.describeItem(ClientItem.dynnCHL(bytes(7))), "dynnCHL(value: [7])")
    assert.ok(ClientInput.describeItem(ClientItem.ses(new SESValue({ eventArray: 1 }))).startsWith("ses("))
    assert.equal(ClientInput.describeItem(ClientItem.dyntAtom(bytes(1, 2, 3))), "dyntAtom(value withheld)")
    // String(reflecting:) and Mirror of a DYNT_ATOM item: the step's DYNT_ATOM item shows the
    // description in util.inspect and JSON, and no enumerable key but its kind and value.
    const step = new ClientInputStep()
    step.appendField(new ReturnedField({ block: 1, row: 8, col: 30, mlen: 3, maxNrChars: 3 }), bytes(1, 2, 3))
    const atom = step.items[0]
    assert.equal(inspect(atom), "dyntAtom(value withheld)")
    assert.equal(inspect(atom, { showHidden: true, depth: Infinity }), "dyntAtom(value withheld)")
    assert.equal(JSON.stringify(atom), '"dyntAtom(value withheld)"')
    assert.deepStrictEqual(Object.keys(atom), ["kind", "value"])
  })

  /** the reaction that carries the encoded logon step prints no byte and no length of the password */
  test("reactionHoldsNoPassword", () => {
    const screen = LogonScreens.received(LogonScreens.gate())
    const shown: string[][] = []
    for (const password of passwords) {
      const step = new LogonStep(screen, LogonFixtures.credentials({ password }))
      const machine = LogonScreens.logonMachine()
      const reaction = machine.send(step.input)
      assert.equal(reaction.send.length, 1)
      const reactionViews = views(reaction)
      for (const view of reactionViews) {
        assert.ok(!view.includes(bytesShown(password)), view)
      }
      shown.push(reactionViews)
    }
    assert.deepStrictEqual(shown[0], shown[1], `${shown[0]?.[0] ?? ""} / ${shown[1]?.[0] ?? ""}`)
  })
})
