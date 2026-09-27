// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/EnvelopeInputStepTests.swift (MIT).

// ScreenModel's input step with the reference input envelope (client-input.md §11): the changed bit
// on edited fields (R-CI-13), the focus item for the cursor field (R-CI-16) and, on a function key
// with nothing edited, the cursor field as received (PV-0779). On the Duck Pond gate (D15).
//
// The gate (Swift `Fixtures.gate()`, which FakeScenarios built in process) comes from the real fake
// server over TCP (src/test/support/screenSession.ts): the tests skip without it.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { InputEnvelope, InputFocus, Secret } from "../../../diag/codec/index.js"
import { FieldEdits, FunctionReadings, FunctionTrigger } from "../../../diag/screen/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe("Input step: the reference envelope", () => {
  const reference = new FunctionReadings({ envelope: InputEnvelope.reference })
  /** The reference envelope with function numbers as UI events (Reading R-CI-10). */
  const referenceEvents = new FunctionReadings({ functionKey: "uiEventSource", envelope: InputEnvelope.reference })

  /** Enter on the gate: the edited fields with the changed bit, the focus on the password with offset 0 */
  test("logonWithEnvelope", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const duck = Fixtures.input(gate, 4)
    const quack = Fixtures.input(gate, 6)
    const edits = new FieldEdits()
    edits.setText("MALLARD", duck.id)
    edits.setSecret(new Secret(utf8("mallard")), quack.id)
    const step = gate.inputStep(edits, FunctionTrigger.enter, { readings: reference, cursor: quack.id })
    assert.equal(step.envelope, InputEnvelope.reference)
    const { atoms, value } = Fixtures.returnedAtoms(step)
    const pond = Fixtures.input(gate, 2)
    assert.deepEqual(
      atoms.map(atom => atom.row),
      [2, 4, 6],
      "the logon step returns the gate's own pond number too (R-CI-19)"
    )
    assert.deepEqual(
      atoms.map(atom => atom.dialogFlags),
      [pond.atom.dialogFlags.withChangedBit(), duck.atom.dialogFlags.withChangedBit(), quack.atom.dialogFlags.withChangedBit()]
    )
    assert.deepEqual(Fixtures.text(atoms[0], value), utf8("314"))
    assert.ok(atoms.every(atom => (atom.dialogFlags.flag2 & 0x01) === 0x01))
    assert.deepEqual(step.focus, new InputFocus(6, 18, 0), "a password's length is never an offset")
    assert.equal(step.uiEvent, undefined, "Enter: the fields alone (R-CI-11)")
    assert.equal(step.functionCode, undefined, "Enter: the fields alone (R-CI-11)")
  })

  /** The focus offset is the end of the cursor field's text: the edit's, else the received one's */
  test("focusOffset", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const duck = Fixtures.input(gate, 4)
    const pond = Fixtures.input(gate, 2)
    const edits = new FieldEdits()
    edits.setText("MALLARD  ", duck.id)
    const edited = gate.inputStep(edits, FunctionTrigger.enter, { readings: reference, cursor: duck.id })
    assert.deepEqual(edited.focus, new InputFocus(4, 18, 7))
    const received = gate.inputStep(edits, FunctionTrigger.enter, { readings: reference, cursor: pond.id })
    assert.deepEqual(received.focus, new InputFocus(2, 18, 3), '"314" as the gate shows it')
    const none = gate.inputStep(edits, FunctionTrigger.enter, { readings: reference })
    assert.equal(none.focus, undefined, "no cursor, no focus item")
    const label = gate.labels[0]
    assert.ok(label !== undefined)
    assert.equal(gate.inputStep(edits, FunctionTrigger.enter, { readings: reference, cursor: label.id }).focus, undefined)
    // Swift's `var stage = Self.reference` copies the struct.
    const stage = reference.clone()
    stage.envelope = InputEnvelope.echoStage
    assert.equal(gate.inputStep(edits, FunctionTrigger.enter, { readings: stage, cursor: duck.id }).focus, undefined, "echoes only: no focus")
  })

  /** A function key with nothing edited returns the cursor field as received, without the changed bit */
  test("functionKeyReturnsTheCursorField", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const pond = Fixtures.input(gate, 2)
    const step = gate.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(5), { readings: referenceEvents, cursor: pond.id })
    assert.notEqual(step.uiEvent, undefined)
    const { atoms, value } = Fixtures.returnedAtoms(step)
    assert.deepEqual(
      atoms.map(atom => atom.row),
      [2]
    )
    assert.deepEqual(
      atoms.map(atom => atom.dialogFlags),
      [pond.atom.dialogFlags],
      "as received (PV-0779)"
    )
    assert.deepEqual(Fixtures.text(atoms[0], value), utf8("314"))

    const quack = Fixtures.input(gate, 6)
    const onPassword = gate.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(5), { readings: referenceEvents, cursor: quack.id })
    assert.equal(onPassword.fieldCount, 0, "a password field is never sent back unedited")
    assert.deepEqual(onPassword.focus, new InputFocus(6, 18))

    const edits = new FieldEdits()
    edits.setText("EIDER", Fixtures.input(gate, 4).id)
    const withEdit = gate.inputStep(edits, FunctionTrigger.virtualKey(5), { readings: referenceEvents, cursor: pond.id })
    assert.equal(withEdit.fieldCount, 1, "only the edit")
    const enter = gate.inputStep(new FieldEdits(), FunctionTrigger.enter, { readings: reference, cursor: pond.id })
    assert.equal(enter.fieldCount, 0, "Enter with nothing edited returns nothing")
    const okCode = gate.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(5), { readings: reference, cursor: pond.id })
    assert.deepEqual(okCode.functionCode, utf8("/05"), "an OK-code step is no UI-event frame (R-CI-20)")
    assert.equal(okCode.fieldCount, 0, "an OK-code step is no UI-event frame (R-CI-20)")
  })

  /** The minimal envelope, the default, keeps the step Swooey sent before */
  test("minimalDefault", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const duck = Fixtures.input(gate, 4)
    const edits = new FieldEdits()
    edits.setText("MALLARD", duck.id)
    const step = gate.inputStep(edits, FunctionTrigger.enter, { cursor: duck.id })
    assert.equal(step.envelope, InputEnvelope.minimal)
    assert.equal(step.focus, undefined)
    const { atoms } = Fixtures.returnedAtoms(step)
    assert.deepEqual(
      atoms.map(atom => atom.dialogFlags),
      [duck.atom.dialogFlags]
    )
    assert.equal(new FunctionReadings().envelope, InputEnvelope.minimal)
  })
})
