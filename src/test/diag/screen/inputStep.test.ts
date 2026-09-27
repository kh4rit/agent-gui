// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/InputStepTests.swift (MIT).
//
// The tests that ran FakeScenarios' ScenarioSession in process run against the real fake server
// over TCP (src/test/support/screenSession.ts) and skip without it. Where the Swift test read the
// server's parsed message (`reply.message.structure`), this port asserts on the step the client
// wrote (the bytes on the wire) and on the server's log, which names the same structure (items,
// returned fields, OK-code length, logoff request); the reply is the screen the client receives.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ClientInputError,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntAttributes,
  DyntDialogFlags,
  DyntElementType,
  ReturnedField,
  Secret
} from "../../../diag/codec/index.js"
import { FieldEdits, Screen, ScreenElementID, ScreenInputError } from "../../../diag/screen/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { screenOf, skipWithoutFakeServer, withPond } from "../../support/screenSession.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const efield2 = DyntElementType.of("efield2")

describe("Screen.inputStep: returning the user's edits", () => {
  /** Logon on the Duck Pond gate: Enter returns the edited fields and the fake server answers with the lobby */
  test("logonRoundTrip", { skip: skipWithoutFakeServer }, async () => {
    await withPond("duck-pond-logon", async pond => {
      // The first message gets the gate.
      const gate = screenOf(await pond.first())
      assert.ok(gate.isLogonScreen)

      // Edit pond (client), duck ID (user) and the secret quack (password); press Enter.
      const edits = new FieldEdits()
      edits.setText("271", Fixtures.input(gate, 2).id)
      edits.setText("DONALD", Fixtures.input(gate, 4).id)
      edits.setSecret(new Secret(utf8("quackquack")), Fixtures.input(gate, 6).id)
      const step = gate.inputStep(edits)
      assert.equal(step.fieldCount, 3)
      assert.equal(step.functionCode, undefined)
      assert.ok(!`${step}${edits}`.includes("quack"))

      // The fields come back in screen order, as received apart from the text (R-CI-3, R-CI-4).
      const { atoms, value } = Fixtures.returnedAtoms(step)
      assert.deepEqual(
        atoms.map(atom => atom.etype),
        [efield2, efield2, efield2]
      )
      assert.deepEqual(
        atoms.map(atom => atom.block),
        [1, 1, 1]
      )
      assert.deepEqual(
        atoms.map(atom => atom.row),
        [2, 4, 6]
      )
      assert.deepEqual(
        atoms.map(atom => atom.col),
        [18, 18, 18]
      )
      assert.deepEqual(
        atoms.map(atom => atom.isPasswordField),
        [false, false, true]
      )
      const received = gate.inputs.slice(0, 3)
      assert.deepEqual(
        atoms.map(atom => atom.header.dialogFlags),
        received.map(element => element.atom.header.dialogFlags)
      )
      assert.deepEqual(
        atoms.map(atom => atom.header.attributes),
        received.map(element => element.atom.header.attributes)
      )
      assert.deepEqual(
        atoms.map(atom => atom.header.area),
        received.map(element => element.atom.header.area)
      )
      assert.deepEqual(
        atoms.map(atom => atom.header.group),
        received.map(element => element.atom.header.group)
      )
      const widths = atoms.map(atom => (atom.payload.kind === "field" ? [atom.payload.value.mlen, atom.payload.value.maxNrChars] : []))
      assert.deepEqual(widths, [
        [3, 3],
        [12, 12],
        [12, 40]
      ])
      assert.deepEqual(
        atoms.map(atom => Fixtures.text(atom, value)),
        [utf8("271"), utf8("DONALD"), utf8("quackquack")]
      )

      // The fake server reads the dialog message and answers with the lobby. Its log names the
      // structure: DIALOG_STEP_NUMBER, DYNT_ATOM and EOM, three returned fields, one a password, no
      // OK-code and no logoff request.
      const lobby = screenOf(await pond.submit(step, "the lobby"))
      assert.ok(await pond.waitForLog("dialog message 1: com_flag none, 3 items; 3 returned field(s), 1 of them password field(s)"), pond.server.log.join("\n"))
      const dialog = pond.logLines("dialog message 1")
      assert.equal(dialog.length, 1)
      assert.ok(!dialog[0].includes("OKCODE") && !dialog[0].includes("logoff"), dialog[0])
      assert.ok(await pond.waitForLog("sent screen pond-lobby"))
      assert.equal(lobby.identity.transaction, "ZZBREAD")
      assert.equal(pond.state().kind, "active", "the server goes on")
    })
  })

  /** A command in the OK-code field travels as VARINFO OKCODE (Reading R-CI-6); /i logs off */
  test("functionCode", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const command = gate.inputStep(new FieldEdits(), { functionCode: "/nZZBREAD" })
    assert.equal(command.fieldCount, 0)
    assert.deepEqual(command.items, [{ kind: "varInfoOKCode", text: utf8("/nZZBREAD") }])

    // The codec's gap trigger stays available: the step is then refused (#55).
    throwsInfo(() => gate.inputStep(new FieldEdits(), { functionCode: "/nZZBREAD", trigger: "specGap" }), ScreenInputError, {
      kind: "functionCode",
      value: { kind: "specGap", issue: 55 }
    })

    // A transaction code starts that transaction on the fake server (its `on okcode` rules).
    await withPond("duck-pond-logon", async pond => {
      await pond.first()
      const start = gate.inputStep(new FieldEdits(), { functionCode: "ZZDUCK" })
      assert.deepEqual(start.functionCode, utf8("ZZDUCK"))
      const duck = screenOf(await pond.submit(start, "the rubber duck"))
      assert.ok(await pond.waitForLog("dialog message 1", "OKCODE 6 bytes"), pond.server.log.join("\n"))
      assert.equal(duck.identity.transaction, "ZZDUCK")
      assert.ok(!duck.isLogonScreen)

      // The fake server takes an OKCODE of /i as a logoff request (PV-0725): the logoff message,
      // then the close.
      const edits = new FieldEdits()
      edits.setText("DONALD", Fixtures.input(gate, 4).id)
      const logoff = gate.inputStep(edits, { functionCode: "/i" })
      assert.equal(logoff.items.length, 2)
      await pond.submit(logoff, "the logoff message")
      assert.equal(await pond.session.nextMessage(), undefined, "the server closes after the logoff message")
      assert.deepEqual(pond.state(), { kind: "disconnected", reason: { kind: "closedByServer", lastMessageHadEOC: true } })
      assert.ok(await pond.waitForLog("dialog message 2", "logoff request"), pond.server.log.join("\n"))
      assert.ok(await pond.waitForLog("sent logoff"))
    })
  })

  /** Only edited fields are returned: unchanged texts are left out, and no edit sends no atom */
  test("onlyEditedFields", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const empty = gate.inputStep(new FieldEdits())
    assert.equal(empty.fieldCount, 0)
    assert.equal(empty.items.length, 0)

    const edits = new FieldEdits()
    edits.setText("MA", Fixtures.input(gate, 8).id)
    edits.setText("314 ", Fixtures.input(gate, 2).id) // as received, trailing space aside
    edits.setText("", Fixtures.input(gate, 4).id) // as received: twelve spaces
    const unchanged = gate.inputStep(edits)
    const only = Fixtures.returnedAtoms(unchanged)
    assert.deepEqual(
      only.atoms.map(atom => atom.row),
      [8],
      "no password: not the logon step, so the unchanged fields stay out"
    )
    assert.deepEqual(Fixtures.text(only.atoms[0], only.value), utf8("MA"))

    // With the password it is the logon step (R-CI-19): the pond number that holds a value goes
    // back as received, the empty duck ID stays out.
    edits.setText("", Fixtures.input(gate, 6).id) // a password is never compared
    assert.ok(gate.isLogonStep(edits))
    const step = gate.inputStep(edits)
    const { atoms, value } = Fixtures.returnedAtoms(step)
    assert.deepEqual(
      atoms.map(atom => atom.row),
      [2, 6, 8]
    )
    assert.deepEqual(Fixtures.text(atoms[0], value), utf8("314"))
    assert.equal(Fixtures.text(atoms[1], value).length, 0)
    assert.deepEqual(Fixtures.text(atoms[2], value), utf8("MA"))
  })

  /** The returned-fields vector, byte for byte */
  test("returnedFieldsVector", () => {
    const vector = Fixtures.vector("Tests/Vectors/dynt/returned-edited-fields.vec")
    const atoms = new ByteWriter()
    for (const [row, width] of [
      [38, 3],
      [41, 8]
    ]) {
      const header = new DyntAtomHeader({ etype: efield2, block: 5, row, col: 47, attributes: DyntAttributes.yes3D })
      DyntAtomEncoder.appendField(header, { mlen: width, maxNrChars: width, text: new Uint8Array(0) }, atoms)
    }
    const screen = Screen.fromItems(Fixtures.atomItem(atoms.toBytes()))
    const edits = new FieldEdits()
    edits.setText("42", screen.inputs[0].id)
    edits.setText("PONG", screen.inputs[1].id)
    const step = screen.inputStep(edits)
    assert.deepEqual(step.items, [{ kind: "dyntAtom", value: vector.bytes }])
  })

  /** A password field comes back with its dlg flags as received (R-CI-4) */
  test("passwordVector", () => {
    const vector = Fixtures.vector("Tests/Vectors/dynt/password-field.vec")
    const screen = Screen.fromItems(Fixtures.atomItem(vector.bytes))
    const password = screen.inputs[0]
    assert.ok(password !== undefined)
    assert.ok(password.isPassword)
    assert.equal(password.text, undefined)
    assert.equal(password.width, 12)
    assert.equal(password.maxLength, 40)
    const edits = new FieldEdits()
    edits.setSecret(new Secret(utf8("mallard")), password.id)
    const { atoms, value } = Fixtures.returnedAtoms(screen.inputStep(edits))
    assert.deepEqual(
      atoms.map(atom => atom.dialogFlags),
      [new DyntDialogFlags({ flag1: 4, flag2: 1 })]
    )
    assert.deepEqual(
      atoms.map(atom => atom.isPasswordField),
      [true]
    )
    assert.deepEqual(Fixtures.text(atoms[0], value), utf8("mallard"))
  })

  /** The changed marking is switchable and does what the codec does (#34) */
  test("markedChanged", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const user = Fixtures.input(gate, 4)
    const edits = new FieldEdits()
    edits.setText("DONALD", user.id)
    let marked: ReturnedField
    try {
      marked = ReturnedField.received(user.atom).markedChanged()
    } catch (error) {
      assert.ok(error instanceof ClientInputError)
      throwsInfo(() => gate.inputStep(edits, { flags: "markedChanged" }), ScreenInputError, { kind: "field", value: user.id, error: error.info })
      return
    }
    const { atoms } = Fixtures.returnedAtoms(gate.inputStep(edits, { flags: "markedChanged" }))
    assert.deepEqual(
      atoms.map(atom => atom.header),
      [marked.header]
    )
  })

  /** Edits the screen cannot return are refused */
  test("refusedEdits", { skip: skipWithoutFakeServer }, async () => {
    const gate = await Fixtures.gate()
    const unknown = new ScreenElementID({ block: 1, row: 99, column: 1, elementType: 130 })
    let edits = new FieldEdits()
    edits.setText("DONALD", unknown)
    throwsInfo(() => gate.inputStep(edits), ScreenInputError, { kind: "unknownElement", value: unknown })

    const label = gate.labels[0]
    assert.ok(label !== undefined)
    edits = new FieldEdits()
    edits.setText("Lake", label.id)
    throwsInfo(() => gate.inputStep(edits), ScreenInputError, { kind: "notEditable", value: label.id })

    const pond = Fixtures.input(gate, 2)
    edits = new FieldEdits()
    edits.setText("2718", pond.id)
    throwsInfo(() => gate.inputStep(edits), ScreenInputError, { kind: "tooLong", value: pond.id, maxLength: 3 })

    const password = Fixtures.input(gate, 6)
    edits = new FieldEdits()
    edits.setSecret(new Secret(new Uint8Array(41).fill(0x71)), password.id)
    throwsInfo(() => gate.inputStep(edits), ScreenInputError, { kind: "tooLong", value: password.id, maxLength: 40 })

    // In a code page Swooey does not know, only ASCII is sent (#18, session.md §6.4).
    const unknown0 = Screen.fromItems(await Fixtures.items("pond-gate"), { codePage: 0 })
    edits = new FieldEdits()
    edits.setText("27ä", pond.id)
    throwsInfo(() => unknown0.inputStep(edits), ScreenInputError, { kind: "specGap", issue: 18 })
    throwsInfo(() => unknown0.inputStep(new FieldEdits(), { functionCode: "/nä" }), ScreenInputError, { kind: "specGap", issue: 18 })
    edits = new FieldEdits()
    edits.setSecret(new Secret(utf8("Entenhausen-ä")), password.id)
    throwsInfo(() => unknown0.inputStep(edits), ScreenInputError, { kind: "specGap", issue: 18 })
    edits = new FieldEdits()
    edits.setText("271", pond.id)
    assert.notEqual(Fixtures.atomValue(unknown0.inputStep(edits, { functionCode: "/n" })), undefined)

    // Code page 1100 is ISO 8859-1: a character above U+00FF cannot be sent.
    const latin = Screen.fromItems(await Fixtures.items("pond-gate"), { codePage: 1100 })
    edits = new FieldEdits()
    edits.setText("€", pond.id)
    throwsInfo(() => latin.inputStep(edits), ScreenInputError, { kind: "notEncodable", value: pond.id })
    throwsInfo(() => latin.inputStep(new FieldEdits(), { functionCode: "/n€" }), ScreenInputError, { kind: "notEncodable", value: undefined })
    edits = new FieldEdits()
    edits.setSecret(new Secret(utf8("Taler-€")), password.id)
    throwsInfo(() => latin.inputStep(edits), ScreenInputError, { kind: "notEncodable", value: password.id })
  })

  /** Fields the codec cannot return: an opaque EFIELD, a protected input, an output field */
  test("codecRefusals", () => {
    const atoms = new ByteWriter()
    DyntAtomEncoder.appendAtom(new DyntAtomHeader({ etype: DyntElementType.of("efield"), block: 1, row: 1, col: 1 }), Uint8Array.of(0, 0), atoms)
    DyntAtomEncoder.appendField(
      new DyntAtomHeader({ etype: efield2, block: 1, row: 2, col: 1, attributes: DyntAttributes.protected }),
      { mlen: 4, maxNrChars: 4, text: new Uint8Array(0) },
      atoms
    )
    DyntAtomEncoder.appendField(
      new DyntAtomHeader({ etype: DyntElementType.of("ofield2"), block: 1, row: 3, col: 1 }),
      { mlen: 4, maxNrChars: 4, text: new Uint8Array(0) },
      atoms
    )
    DyntAtomEncoder.appendField(new DyntAtomHeader({ etype: efield2, block: 1, row: 4, col: 1 }), { mlen: 255, maxNrChars: 300, text: new Uint8Array(0) }, atoms)
    const screen = Screen.fromItems(Fixtures.atomItem(atoms.toBytes()))
    const ids = screen.elements.map(element => element.id)
    assert.deepEqual(
      screen.elements.map(element => element.isEditable),
      [true, false, false, true]
    )

    let edits = new FieldEdits()
    edits.setText("QUAK", ids[0])
    throwsInfo(() => screen.inputStep(edits), ScreenInputError, {
      kind: "field",
      value: ids[0],
      error: { kind: "unknownFieldWidths", value: DyntElementType.of("efield") }
    })
    edits = new FieldEdits()
    edits.setText("QUAK", ids[1])
    throwsInfo(() => screen.inputStep(edits), ScreenInputError, { kind: "notEditable", value: ids[1] })
    edits = new FieldEdits()
    edits.setText("QUAK", ids[2])
    throwsInfo(() => screen.inputStep(edits), ScreenInputError, { kind: "notEditable", value: ids[2] })
    // 256 bytes do not fit dlen's one byte, although maxnrchars allows 300 characters.
    edits = new FieldEdits()
    edits.setText("q".repeat(256), ids[3])
    throwsInfo(() => screen.inputStep(edits), ScreenInputError, {
      kind: "field",
      value: ids[3],
      error: { kind: "atom", error: { kind: "textTooLong", length: 256 } }
    })
    edits = new FieldEdits()
    edits.setSecret(new Secret(new Uint8Array(256).fill(0x71)), ids[3])
    throwsInfo(() => screen.inputStep(edits), ScreenInputError, { kind: "field", value: ids[3], error: { kind: "secretNotEncodable" } })
  })

  /** FieldEdits holds texts and secrets and prints neither */
  test("fieldEdits", async () => {
    const { inspect } = await import("node:util")
    const user = new ScreenElementID({ block: 1, row: 4, column: 18, elementType: 130 })
    const password = new ScreenElementID({ block: 1, row: 6, column: 18, elementType: 130 })
    const edits = new FieldEdits()
    assert.ok(edits.isEmpty)
    edits.setText("DONALD", user)
    edits.setSecret(new Secret(utf8("quackquack")), password)
    assert.equal(edits.count, 2)
    assert.deepEqual(edits.ids, [user, password])
    assert.equal(edits.text(user), "DONALD")
    assert.equal(edits.text(password), undefined)
    assert.ok(edits.contains(password))
    // Swift's description, debug description, String(reflecting:) and dump.
    for (const printed of [edits.description, edits.debugDescription, String(edits), JSON.stringify(edits), inspect(edits, { showHidden: true, depth: 8 })]) {
      assert.ok(!printed.includes("DONALD"), printed)
      assert.ok(!printed.includes("quack"), printed)
    }
    assert.equal(edits.description, "FieldEdits(2 fields)")
    edits.remove(password)
    edits.setText(undefined, user)
    assert.ok(edits.isEmpty)
    assert.ok(!edits.contains(user))
  })
})
