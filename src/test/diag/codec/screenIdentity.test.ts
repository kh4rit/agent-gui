// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ScreenIdentityTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  AreaSize,
  DiagItemWalkError,
  DyntAtomWalkError,
  LogonFieldStructure,
  ScreenIdentity,
  ScreenIdentityDiagnostics,
  ScreenIdentityError,
  ScreenIdentityText,
  ScreenSpecGapError,
  ScreenText,
  byteRange
} from "../../../diag/codec/index.js"
import { appl, appl4, ascii, cat, throwsInfo, u32BE, walkItems } from "../../support/codecTestSupport.js"
import { field1Content, field2Content, rawAtom, tabstripContent } from "../../support/dyntTestSupport.js"
import { ZZLogonScreen, identityText, rawAreaSize, rawMenuEntry } from "../../support/screenTestSupport.js"

const text = identityText
const issue54 = { kind: "specGap", issue: 54 } as const

/** Screen identity (server-screen.md §6, §7) and the logon-guard field structure (credentials.md §5.1), on invented screens built by hand. */
describe("Screen identity", () => {
  test("logonScreenIdentity", () => {
    const items = ZZLogonScreen.items()
    const identity = ScreenIdentity.decode(items)
    const expected: Record<ScreenIdentityText, string> = {
      dbName: "DUK",
      client: "007",
      cpuName: "zz-pond",
      tcode: "ZZQUAK",
      dynproName: "SAPMSYST",
      dynproNumber: "4242",
      cuaName: "SAPMSYST",
      cuaStatus: "ZZHONK",
      guiTheme: "ZZSOCKS",
      sessionTitle: "Rubber Duck Debugging",
      sessionIcon: "Duck Pond (1) DUK"
    }
    for (const field of ScreenIdentityText.allCases) {
      assert.deepEqual(text(identity, field, items), ascii(expected[field]), field)
      assert.equal(identity.occurrences(field), 1)
    }
    assert.deepEqual(identity.areaSize(), new AreaSize({ windowHeight: 20, windowWidth: 70, areaHeight: 20, areaWidth: 70 }))
    assert.equal(identity.areaSizeOccurrences, 1)
    assert.ok(identity.atomCount === 21 && identity.inputFieldCount === 4 && identity.passwordFieldCount === 1)
    assert.ok(identity.menuCount === 2 && identity.menuEntryCount === 3)
    assert.ok(identity.diagnostics.isClean)
    assert.deepEqual(identity.diagnostics, new ScreenIdentityDiagnostics())
    assert.ok(identity.isLogonProgram(items))
    assert.deepEqual(identity.programName()?.of(items), ascii("SAPMSYST"))
    assert.deepEqual(identity.screenNumber()?.of(items), ascii("4242"))
  })

  /** R-SS-7, R-SE-2: order, a leading step item and a trailing EOM change nothing. */
  test("orderStepAndEOMChangeNothing", () => {
    const items = ZZLogonScreen.items()
    const walked = walkItems(items).items
    const reference = ScreenIdentity.decode(items)
    const reversed = cat(...walked.reverse().map(item => items.subarray(item.offset, item.endOffset)))
    const wrapped = cat(appl(0x04, 0x26, u32BE(7)), items, [0x0c])
    for (const variant of [reversed, wrapped]) {
      const identity = ScreenIdentity.decode(variant)
      assert.ok(identity.atomCount === reference.atomCount && identity.menuEntryCount === reference.menuEntryCount)
      assert.ok(identity.inputFieldCount === reference.inputFieldCount && identity.passwordFieldCount === reference.passwordFieldCount)
      assert.deepEqual(identity.areaSize(), reference.areaSize())
      for (const field of ScreenIdentityText.allCases) assert.deepEqual(text(identity, field, variant), text(reference, field, items), field)
    }
  })

  test("absentItemsAreNil", () => {
    const identity = ScreenIdentity.decode(new Uint8Array(0))
    for (const field of ScreenIdentityText.allCases) {
      assert.equal(identity.text(field), undefined)
      assert.equal(identity.occurrences(field), 0)
    }
    assert.equal(identity.areaSize(), undefined)
    assert.ok(!identity.isLogonProgram(new Uint8Array(0)))
    assert.ok(identity.atomCount === 0 && identity.menuCount === 0 && identity.diagnostics.isClean)
  })

  /** R-SS-5: only the exact name after R-SS-4 trimming is the logon program. */
  test("logonProgramRecognition", () => {
    const names: [Uint8Array, boolean][] = [
      [ascii("SAPMSYST"), true],
      [cat(ascii("SAPMSYST  "), [0]), true],
      [ascii(" SAPMSYST"), false],
      [ascii("ZZDUCKPOND"), false],
      [ascii("SAPMSYS"), false],
      [new Uint8Array(0), false]
    ]
    for (const [name, isLogon] of names) {
      const items = appl(0x06, 0x0d, name)
      assert.equal(ScreenIdentity.decode(items).isLogonProgram(items), isLogon, `${name}`)
    }
  })

  /** #54: a repeated identity item makes its accessor throw; the rest of the identity stands. */
  test("repeatedIdentityItemsAreASpecGap", () => {
    const items = cat(
      appl(0x06, 0x0d, ascii("SAPMSYST")),
      appl(0x06, 0x0e, ascii("0001")),
      appl(0x06, 0x0d, ascii("ZZOTHER")),
      appl(0x06, 0x0d, ascii("ZZTHIRD")),
      appl(0x0c, 0x07, rawAreaSize(1, 2, 3, 4)),
      appl(0x0c, 0x07, rawAreaSize(5, 6, 7, 8))
    )
    const identity = ScreenIdentity.decode(items)
    throwsInfo(() => identity.text("dynproName"), ScreenSpecGapError, issue54)
    throwsInfo(() => identity.programName(), ScreenSpecGapError, issue54)
    throwsInfo(() => identity.isLogonProgram(items), ScreenSpecGapError, issue54)
    throwsInfo(() => identity.areaSize(), ScreenSpecGapError, issue54)
    assert.ok(identity.occurrences("dynproName") === 3 && identity.areaSizeOccurrences === 2)
    assert.deepEqual(text(identity, "dynproNumber", items), ascii("0001"))
    assert.ok(identity.diagnostics.repeatedIdentityItems === 3 && !identity.diagnostics.isClean)
  })

  /**
   * IMPL-SS-3 and IMPL-SS-5: a value that fails its layout, or a menu walk that stops, leaves that
   * item undecoded and the message standing.
   */
  test("valueFaultsOnlyCountInDiagnostics", () => {
    const items = cat(
      appl(0x0c, 0x07, rawAreaSize(1, 2, 3, 4).slice(0, -1)),
      appl4(0x0b, 0x02, cat(rawMenuEntry({ text: ascii("Quack") }), rawMenuEntry({ text: ascii("Honk"), declaredLength: 3 }))),
      appl4(0x0b, 0x05, [0xde, 0xad]),
      appl(0x06, 0x02, ascii("DUK"))
    )
    const identity = ScreenIdentity.decode(items)
    assert.ok(identity.areaSize() === undefined && identity.areaSizeOccurrences === 1)
    assert.ok(identity.menuCount === 2 && identity.menuEntryCount === 1)
    assert.ok(identity.diagnostics.undecodableValues === 1 && identity.diagnostics.stoppedMenus === 1)
    assert.equal(identity.diagnostics.unwalkedMenus, 1)
    assert.deepEqual(text(identity, "dbName", items), ascii("DUK"))
  })

  /** IMPL-IT-2, IMPL-IT-5, IMPL-DA-3: a failing item or atom walk drops the message. */
  test("walkFailuresDropTheMessage", () => {
    const truncatedItem = appl(0x06, 0x02, ascii("DUK")).slice(0, -1)
    throwsInfo(() => ScreenIdentity.decode(truncatedItem), ScreenIdentityError, {
      kind: "items",
      value: new DiagItemWalkError({ kind: "truncated", itemIndex: 1, itemOffset: 0, field: "value" })
    })
    throwsInfo(() => ScreenIdentity.decode(cat(appl(0x06, 0x02, ascii("DUK")), [0x08])), ScreenIdentityError, {
      kind: "items",
      value: new DiagItemWalkError({ kind: "unknownType", typeByte: 0x08, itemIndex: 2, itemOffset: 8 })
    })
    const shortAtom = rawAtom(130, { content: field2Content(ascii("x")), declaredLength: 40 })
    throwsInfo(() => ScreenIdentity.decode(cat(appl(0x06, 0x02, ascii("DUK")), appl(0x09, 0x02, shortAtom))), ScreenIdentityError, {
      kind: "atoms",
      value: new DyntAtomWalkError({ kind: "truncated", atomIndex: 1, atomOffset: 0, part: "atom" }),
      itemIndex: 2
    })
    throwsInfo(() => LogonFieldStructure.decode(appl4(0x09, 0x02, rawAtom(130, { declaredLength: 5 }))), ScreenIdentityError, {
      kind: "atoms",
      value: new DyntAtomWalkError({ kind: "badAtomLength", length: 5, atomIndex: 1, atomOffset: 0 }),
      itemIndex: 1
    })
  })

  /**
   * Atoms count under both carriers and across several DYNT_ATOM items; the atom walks' diagnostics
   * are summed; DYNT_TABSTRIP_BUTTONS atoms are not screen atoms.
   */
  test("atomsFromEveryDyntAtomItem", () => {
    const orphan = rawAtom(114, { content: ascii("ZZORPHAN") })
    const items = cat(
      appl(0x09, 0x02, cat(orphan, rawAtom(101, { content: [1, 2, 3] }))),
      appl4(0x09, 0x02, cat(rawAtom(121, { content: field1Content(ascii("x")), attr: 0x02 }), rawAtom(131, { content: field2Content([]) }))),
      appl4(0x09, 0x10, rawAtom(116, { content: tabstripContent({ text: ascii("Nap"), functionCode: ascii("ZZNAP"), id: ascii("T1") }) }))
    )
    const identity = ScreenIdentity.decode(items)
    assert.ok(identity.atomCount === 4 && identity.inputFieldCount === 2 && identity.passwordFieldCount === 1)
    assert.ok(identity.diagnostics.atoms.orphanChildren === 1 && identity.diagnostics.atoms.opaquePayloads === 1)
    assert.ok(!identity.diagnostics.isClean)
  })

  test("identityTextsMapToTheirItems", () => {
    for (const field of ScreenIdentityText.allCases) {
      assert.equal(ScreenIdentityText.of(ScreenIdentityText.item(field)), field)
      assert.ok(ScreenText.isText(ScreenIdentityText.item(field)))
    }
    assert.ok(ScreenIdentityText.of(ApplItem.stSystemInfo("contextID")) === undefined && ScreenIdentityText.of(ApplItem.varInfo("okcode")) === undefined)
  })

  // MARK: Logon field structure (credentials.md §5.1)

  test("logonFieldStructure", () => {
    const items = ZZLogonScreen.items()
    const structure = LogonFieldStructure.decode(items)
    assert.ok(structure.isLogonProgram(items))
    assert.deepEqual(structure.identity, ScreenIdentity.decode(items))
    assert.equal(structure.inputFields.length, 4)
    assert.deepEqual(
      structure.inputFields.map(field => field.maxNrChars),
      [3, 12, 40, 2]
    )
    assert.deepEqual(
      structure.inputFields.map(field => field.isPasswordField),
      [false, false, true, false]
    )
    const password = structure.passwordField
    assert.ok(password)
    assert.ok(password.field?.mlen === 12 && password.atom.row === 4)
    assert.equal(structure.passwordFields.length, 1)
    const names = structure.inputFields.map(field =>
      field.fieldName === undefined ? undefined : field.fieldName.shifted(field.itemValue.lowerBound).of(items).slice()
    )
    assert.deepEqual(names, ["ZZGATE-POND", "ZZGATE-DUCK", "ZZGATE-QUACK", "ZZGATE-TONGUE"].map(ascii))
    assert.ok(structure.inputFields.every(field => field.itemIndex === 17))
    // R-SS-9: the visible inputs are told apart by their maximum length, never by position.
    assert.deepEqual(
      structure.inputFieldsWithMaxNrChars(3).map(field => field.atom.row),
      [1]
    )
    assert.deepEqual(
      structure.inputFieldsWithMaxNrChars(12).map(field => field.atom.row),
      [3]
    )
    assert.equal(structure.inputFieldsWithMaxNrChars(40).length, 0, "the password field is not a visible input")
    assert.equal(structure.inputFieldsWithMaxNrChars(7).length, 0)
  })

  /**
   * The guard's structural checks fail closed: two password fields give no password field, and an
   * EFIELD (101) input has no known maximum length.
   */
  test("logonFieldStructureEdgeCases", () => {
    const twoPasswords = appl4(
      0x09,
      0x02,
      cat(rawAtom(130, { content: field2Content([]), attr: 0x42 }), rawAtom(130, { content: field2Content([]), attr: 0x42 }))
    )
    const structure = LogonFieldStructure.decode(twoPasswords)
    assert.ok(structure.passwordFields.length === 2 && structure.passwordField === undefined)
    assert.ok(!structure.isLogonProgram(twoPasswords))

    const opaque = appl4(
      0x09,
      0x02,
      cat(
        rawAtom(101, { content: [9, 9] }),
        rawAtom(114, { content: ascii("ZZOPAQUE") }),
        rawAtom(130, { content: field2Content(ascii("ab"), { dlen: 1 }) }),
        rawAtom(132, { content: field2Content(ascii("L")) }),
        rawAtom(114, { content: ascii("ZZLABEL") })
      )
    )
    const fields = LogonFieldStructure.decode(opaque).inputFields
    assert.equal(fields.length, 2)
    assert.ok(fields[0].field === undefined && fields[0].maxNrChars === undefined)
    assert.deepEqual(fields[0].fieldName, byteRange(28, 36))
    assert.equal(fields[1].field, undefined, "a dlen mismatch keeps the payload opaque (#36)")
    assert.equal(fields[1].fieldName, undefined, "the FNAME after a label belongs to the label")
    assert.equal(LogonFieldStructure.decode(new Uint8Array(0)).inputFields.length, 0)
  })
})
