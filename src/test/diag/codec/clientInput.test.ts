// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ClientInputTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ApplItem,
  ClientInput,
  ClientInputError,
  ClientInputStep,
  ClientMessageEncoder,
  DiagHeader,
  DialogStepNumber,
  DyntAtomHeader,
  DyntAttributes,
  DyntDialogFlags,
  DyntElementType,
  DyntField,
  ReturnedField,
  SESValue,
  byteRange
} from "../../../diag/codec/index.js"
import { DPTerminalName } from "../../../diag/wire/index.js"
import { loadVector } from "../../vectors/paths.js"
import { ascii, cat, repeated, throwsInfo, walkItems, zzTestIdentity } from "../../support/codecTestSupport.js"
import { field1Content, field2Content, rawAtom, walkAtoms } from "../../support/dyntTestSupport.js"

/**
 * The client's input step (client-input.md): the returned fields (R-CI-3), the envelope and item
 * order (R-CI-1, R-CI-2), and the typed gaps for what the spec leaves open.
 */
describe("Client input", () => {
  const terminal = DPTerminalName.fromHostName("zz-duckpond")

  /**
   * The atoms of returned-edited-fields.vec, built by the input step: two EFIELD_2 atoms at block 5,
   * column 47, rows 38 and 41, attribute YES3D, dlg flags 0.
   */
  test("returnedFieldsMatchTheSpecVector", () => {
    const vector = loadVector("test/vectors/dynt/returned-edited-fields.vec")
    const step = new ClientInputStep()
    step.appendField(new ReturnedField({ block: 5, row: 38, col: 47, mlen: 3, maxNrChars: 3, attributes: DyntAttributes.yes3D }), ascii("42"))
    step.appendField(new ReturnedField({ block: 5, row: 41, col: 47, mlen: 8, maxNrChars: 8, attributes: DyntAttributes.yes3D }), ascii("PONG"))
    assert.equal(step.fieldCount, 2)
    assert.deepEqual(step.items, [{ kind: "dyntAtom", value: vector.bytes }])
  })

  /**
   * #91: the vector's returned fields sit at invented positions, not at the example client's block 1,
   * column 20 (PV-0724; IMPL-SS-1 keeps SAP's layout out of our fixtures).
   */
  test("returnedFieldsAreOffTheExampleLayout", () => {
    const vector = loadVector("test/vectors/dynt/returned-edited-fields.vec")
    const walked = walkAtoms(vector.bytes)
    assert.ok(walked.error === undefined && walked.atoms.length === 2)
    for (const atom of walked.atoms) {
      assert.ok(atom.block !== 1, `atom ${atom.index}: block`)
      assert.ok(atom.col !== 1 && atom.col !== 20, `atom ${atom.index}: column`)
    }
  })

  /**
   * R-CI-1, R-CI-2: step first, then SES, DYNN CHL and DYNT_ATOM (APPL4), EOM last, and nothing
   * after EOM; no XMLBLOB (IMPL-IT-10).
   */
  test("inputMessageOrder", () => {
    const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal)
    encoder.dialogMessage([])
    const chl = Uint8Array.from({ length: 22 }, (_, index) => index + 1)
    const step = new ClientInputStep({ ses: new SESValue({ eventArray: 1 }), dynnCHL: chl })
    step.appendField(new ReturnedField({ block: 5, row: 44, col: 47, mlen: 12, maxNrChars: 12, attributes: DyntAttributes.yes3D }), ascii("ZZ_DUCK"))
    const payload = ClientInput.inputMessage(encoder, step)
    assert.deepEqual(payload.slice(0, 8), DiagHeader.clientLaterMessage(false).bytes)
    const body = payload.slice(8)
    const walked = walkItems(body)
    assert.equal(walked.error, undefined)
    assert.deepEqual(
      walked.items.map(item => item.type),
      ["appl", "ses", "appl", "appl4", "eom"]
    )
    assert.deepEqual(
      walked.items.map(item => item.appl),
      [ApplItem.stUser("dialogStepNumber"), undefined, ApplItem.dynn("chl"), ApplItem.dynt("atom"), undefined]
    )
    assert.equal(DialogStepNumber.decode(walked.items[0].valueRange.of(body)).step, 2)
    assert.deepEqual(SESValue.decode(walked.items[1].valueRange.of(body)), new SESValue({ eventArray: 1 }))
    assert.deepEqual(walked.items[2].valueRange.of(body), chl)
    const atoms = walkAtoms(walked.items[3].valueRange.of(body).slice())
    assert.ok(atoms.error === undefined && atoms.atoms.length === 1)
    const atom = atoms.atoms[0]
    assert.ok(atom)
    assert.ok(atom.etype.kind === "efield2" && atom.block === 5 && atom.row === 44 && atom.col === 47 && atom.attributes === DyntAttributes.yes3D)
    if (atom.payload.kind !== "field") assert.fail("the returned atom is a field")
    const field = atom.payload.value
    assert.ok(field.dlen === 7 && field.mlen === 12 && field.maxNrChars === 12 && field.flag1 === 0)
    assert.equal(walked.items[walked.items.length - 1]?.endOffset, body.length)
    assert.equal(encoder.lastStepNumber, 2)
  })

  /** An empty step sends only the envelope; a step without SES and DYNN CHL only the atoms. */
  test("itemsFollowWhatTheStepHolds", () => {
    assert.equal(new ClientInputStep().items.length, 0)
    const step = new ClientInputStep()
    step.appendField(new ReturnedField({ block: 0, row: 0, col: 0, mlen: 1, maxNrChars: 1 }), new Uint8Array(0))
    assert.equal(step.items.length, 1)
    const encoder = new ClientMessageEncoder(zzTestIdentity(), terminal, "lzh")
    const payload = ClientInput.inputMessage(encoder, new ClientInputStep())
    assert.equal(payload[7], 1, "compressed like every later message of an LZH session")
    assert.equal(ClientInput.inputMessage(encoder, new ClientInputStep(), 1)[0], 1, "the mode byte names the mode (R-MO-2)")
  })

  /**
   * A returned field takes block, row, column and widths from the atom the server sent, and carries
   * its dlg flags, area, group, attributes and flag1 verbatim (#34: not interpreted).
   */
  test("returnedFieldFromAReceivedAtom", () => {
    const value = cat(
      rawAtom(121, {
        content: field1Content(ascii("x"), { flag1: 7, mlen: 12, maxNrChars: 40 }),
        flags: [4, 1],
        area: 3,
        block: 2,
        group: 5,
        row: 9,
        col: 33,
        attr: 0x42
      }),
      rawAtom(130, { content: field2Content([], { flag1: 0x0102, mlen: 3, maxNrChars: 3 }), block: 2, row: 34, col: 51, attr: 0x40 })
    )
    const atoms = walkAtoms(value).atoms
    const password = ReturnedField.received(atoms[0])
    assert.deepEqual(
      password.header,
      new DyntAtomHeader({
        etype: DyntElementType.of("efield2"),
        dialogFlags: new DyntDialogFlags({ flag1: 4, flag2: 1 }),
        area: 3,
        block: 2,
        group: 5,
        row: 9,
        col: 33,
        attributes: DyntAttributes.invisible | DyntAttributes.yes3D
      })
    )
    assert.ok(password.flag1 === 7 && password.mlen === 12 && password.maxNrChars === 40 && password.isPasswordField)
    const client = ReturnedField.received(atoms[1])
    assert.ok(client.flag1 === 0x0102 && !client.isPasswordField)
    const step = new ClientInputStep()
    step.appendField(password, ascii("Quack"))
    const returned = step.items[0]
    if (returned?.kind !== "dyntAtom") assert.fail("one DYNT_ATOM item")
    const atom = walkAtoms(returned.value).atoms[0]
    assert.ok(atom)
    assert.deepEqual(atom.header, password.header)
    assert.deepEqual(atom.payload, {
      kind: "field",
      value: new DyntField({ form: "v2", flag1: 7, dlen: 5, mlen: 12, maxNrChars: 40, textRange: byteRange(19, 24) })
    })
  })

  test("onlyInputFieldsWithKnownWidthsAreReturned", () => {
    const value = cat(
      rawAtom(132, { content: field2Content(ascii("Pond")) }),
      rawAtom(101, { content: [1, 2] }),
      rawAtom(130, { content: field2Content(ascii("ab"), { dlen: 1 }) }),
      rawAtom(122, { content: field1Content(ascii("out")) })
    )
    const atoms = walkAtoms(value).atoms
    throwsInfo(() => ReturnedField.received(atoms[0]), ClientInputError, { kind: "notAnInputField", value: DyntElementType.of("keyword2") })
    throwsInfo(() => ReturnedField.received(atoms[1]), ClientInputError, { kind: "unknownFieldWidths", value: DyntElementType.of("efield") })
    throwsInfo(() => ReturnedField.received(atoms[2]), ClientInputError, { kind: "unknownFieldWidths", value: DyntElementType.of("efield2") })
    throwsInfo(() => ReturnedField.received(atoms[3]), ClientInputError, { kind: "notAnInputField", value: DyntElementType.of("ofield1") })
  })

  /** What client-input.md leaves open stays a typed gap naming its issue. */
  test("openPartsAreTypedGaps", () => {
    const step = new ClientInputStep()
    throwsInfo(() => step.setFunctionCode(ascii("ZZDUCK")), ClientInputError, { kind: "specGap", issue: 55 })
    throwsInfo(() => step.setFocus(34, 51), ClientInputError, { kind: "specGap", issue: 33 })
    throwsInfo(() => step.setMetricsBlob(ascii("<a/>")), ClientInputError, { kind: "specGap", issue: 20 })
    const field = new ReturnedField({ block: 1, row: 1, col: 1, mlen: 1, maxNrChars: 1 })
    throwsInfo(() => field.markedChanged(), ClientInputError, { kind: "specGap", issue: 34 })
    assert.ok(step.fieldCount === 0 && step.items.length === 0)
  })

  test("textsLongerThanDlenAreRefused", () => {
    const step = new ClientInputStep()
    const field = new ReturnedField({ block: 1, row: 1, col: 1, mlen: 255, maxNrChars: 300 })
    throwsInfo(() => step.appendField(field, repeated(0x51, 256)), ClientInputError, {
      kind: "atom",
      error: { kind: "textTooLong", length: 256 }
    })
    assert.ok(step.fieldCount === 0 && step.items.length === 0)
    step.appendField(field, repeated(0x51, 255))
    assert.equal(step.fieldCount, 1)
  })

  /** IMPL-DA-1: an input step never prints its field texts. */
  test("inputStepsDoNotPrintTheirTexts", () => {
    const step = new ClientInputStep({ ses: new SESValue({ eventArray: 1 }) })
    const quack = ascii("HONKHONKQUACK")
    step.appendField(new ReturnedField({ block: 5, row: 45, col: 47, mlen: 12, maxNrChars: 40, attributes: DyntAttributes.invisible }), quack)
    const texts = [String(step), `${step}`, JSON.stringify(step), inspect(step)]
    for (const text of texts) {
      assert.ok(!text.includes("HONK"), text)
      assert.ok(!text.includes("72"), `no decimal bytes either: ${text}`)
    }
    assert.equal(String(step), "ClientInputStep(fields: 1, SES: yes, DYNN CHL: no)")
    assert.equal(inspect(step), step.description)
  })
})
