// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/InputEnvelopeTests.swift (MIT).

// The reference input envelope (client-input.md §11, Readings R-CI-12 to R-CI-17): byte-exact
// input steps in open-diag-go's order (PV-0774), the echoes (PV-0775, PV-0776), the changed bit
// (PV-0777), the GUI carriers (PV-0778, PV-0779), the focus item (PV-0780) and the DATAMANAGER
// document (PV-0781). Every value the tests echo is invented (D15); positions are off the example
// client's block 1, column 20 (IMPL-SS-1).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  ClientDataManager,
  ClientIdentities,
  ClientInput,
  ClientInputError,
  ClientInputStep,
  ClientMessageEncoder,
  ClientMessageError,
  CompressField,
  Decompressor,
  DiagHeader,
  DiagItemEncoder,
  DiagItemType,
  DiagMessage,
  DialogStepNumber,
  DyntAttributes,
  DyntDialogFlags,
  DyntFocus,
  InputEnvelope,
  InputFocus,
  ReturnedField,
  ServerEcho,
  byteRange
} from "../../../diag/codec/index.js"
import { ByteWriter, DPTerminalName } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, repeated, throwsInfo, zzTestIdentity } from "../../support/codecTestSupport.js"

/** Whether `subsequence` occurs in `array` (Swift's test extension `[UInt8].contains(subsequence:)`). */
function containsSubsequence(array: Uint8Array, subsequence: ArrayLike<number>): boolean {
  if (subsequence.length > array.length) return false
  for (let start = 0; start <= array.length - subsequence.length; start++) {
    let index = 0
    while (index < subsequence.length && array[start + index] === subsequence[index]) index++
    if (index === subsequence.length) return true
  }
  return false
}

describe("Client input: the reference envelope", () => {
  const terminal = DPTerminalName.fromHostName("zz-duckpond")

  // MARK: Invented echo values

  /** An SES the "server" sent: 16 invented bytes, echoed verbatim. */
  const ses = bytes(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7a, 0x7b, 0x12, 0x40)
  /** A CODEPAGE_DIAG_GUI value: 4110, minimum bytes 1, "4110", "ZZ" (invented description). */
  const codePage = bytes(0x00, 0x00, 0x10, 0x0e, 0x01, 0x34, 0x31, 0x31, 0x30, 0x00, 0x5a, 0x5a, 0x00)
  /** A DYNN CHL value: 22 invented bytes. */
  const chl = Uint8Array.from({ length: 0x56 - 0x40 }, (_, index) => 0x40 + index)
  /** A SCROLL_INFOS2 value: 33 invented bytes. */
  const scroll = Uint8Array.from({ length: 0x81 - 0x60 }, (_, index) => 0x60 + index)
  /** A CONTAINER RESET value: id 0 and four zeros, as the owner's logon screen had (PV-0734). */
  const reset = repeated(0, 9)

  /** The suite's static helpers (Swift `Self.echo`, `Self.encoder`, `Self.fields`). */
  const Self = {
    echo(step = 1, modeStat = 0): ServerEcho {
      const echo = new ServerEcho()
      echo.modeStat = modeStat
      echo.stepNumber = step
      echo.ses = ses.slice()
      echo.codepageDiagGUI = codePage.slice()
      echo.dynnCHL = chl.slice()
      echo.scrollInfos2 = scroll.slice()
      echo.containerReset = reset.slice()
      return echo
    },

    encoder(): ClientMessageEncoder {
      return new ClientMessageEncoder(zzTestIdentity(), terminal)
    },

    /**
     * Two edited fields at block 5, column 47: "ZZ" at row 38 (dlg flags 0/1) and, INVISIBLE, "HONK"
     * at row 41 (dlg flags 4/1), each with the changed bit when `changed` is set.
     */
    fields(changed: boolean, envelope: InputEnvelope): ClientInputStep {
      const step = new ClientInputStep({ envelope })
      let first = new ReturnedField({
        block: 5,
        row: 38,
        col: 47,
        mlen: 12,
        maxNrChars: 12,
        dialogFlags: new DyntDialogFlags({ flag1: 0, flag2: 1 }),
        attributes: DyntAttributes.yes3D
      })
      let second = new ReturnedField({
        block: 5,
        row: 41,
        col: 47,
        mlen: 8,
        maxNrChars: 40,
        dialogFlags: new DyntDialogFlags({ flag1: 4, flag2: 0 }),
        attributes: DyntAttributes.yes3D | DyntAttributes.invisible
      })
      if (changed) {
        first = first.withChangedBit()
        second = second.withChangedBit()
      }
      step.appendField(first, ascii("ZZ"))
      step.appendField(second, ascii("HONK"))
      return step
    }
  }

  /** The two atoms of `Self.fields(changed, envelope)` with the changed bit: 21 + 23 = 44 bytes. */
  // prettier-ignore
  const changedAtoms = bytes(
    0x00, 0x15, 0x00, 0x01, 0x82, 0x00, 0x05, 0x00, 0x00, 0x26, 0x00, 0x2f, 0x40, // length 21, flags 00 01, EFIELD_2, block 5, row 38, col 47, YES3D
    0x00, 0x00, 0x02, 0x0c, 0x00, 0x0c, 0x5a, 0x5a, //                               flag1, dlen 2, mlen 12, maxnrchars 12, "ZZ"
    0x00, 0x17, 0x04, 0x01, 0x82, 0x00, 0x05, 0x00, 0x00, 0x29, 0x00, 0x2f, 0x42, // length 23, flags 04 01 (bit 0x01 set), row 41, YES3D|INVISIBLE
    0x00, 0x00, 0x04, 0x08, 0x00, 0x28, 0x48, 0x4f, 0x4e, 0x4b //                    flag1, dlen 4, mlen 8, maxnrchars 40, "HONK"
  )

  /** The bare DATAMANAGER document: 51 ASCII bytes. */
  const dataManager = ascii('<?xml version="1.0" encoding="sap*"?><DATAMANAGER/>')

  // MARK: The logon step

  /**
   * The logon step of the reference envelope, every byte: the echoes, the screen state, the atoms as
   * APPL with the changed bit, the focus on the INVISIBLE field with offset 0, the bare DATAMANAGER
   * document, EOM (client-input.md §11).
   */
  test("referenceLogonStepBytes", () => {
    const step = Self.fields(true, InputEnvelope.reference)
    step.focus = new InputFocus(41, 47)
    const encoder = Self.encoder()
    const payload = ClientInput.inputMessage(encoder, step, 0, Self.echo())
    // prettier-ignore
    const expected = cat(
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // later-message header, mode_stat 0 echoed
      [0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01], // APPL ST_USER DIALOG_STEP_NUMBER 1, the server's
      [0x01], ses, // SES, the server's 16 bytes
      [0x10, 0x06, 0x23, 0x00, 0x0d], codePage, // APPL ST_R3INFO CODEPAGE_DIAG_GUI, the server's
      [0x10, 0x05, 0x01, 0x00, 0x16], chl, // APPL DYNN CHL, the server's 22 bytes
      [0x10, 0x0c, 0x06, 0x00, 0x21], scroll, // APPL VARINFO SCROLL_INFOS2, the server's 33 bytes
      [0x10, 0x0a, 0x01, 0x00, 0x09], reset, // APPL CONTAINER RESET, the server's
      [0x10, 0x09, 0x02, 0x00, 0x2c], changedAtoms, // APPL (not APPL4) DYNT_ATOM, 44 bytes
      [0x10, 0x09, 0x0b, 0x00, 0x0a, 0x01, 0x00, 0x29, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x00], // DYNT_FOCUS_1: 1, row 41, col 47, 0, 0, id 0
      [0x11, 0x00, 0x00, 0x00, 0x33], dataManager, // XMLBLOB, 51 bytes
      [0x0c] // EOM
    )
    assert.deepEqual(payload, expected)
    assert.equal(encoder.lastStepNumber, 1)
  })

  /**
   * The stage "echoes only" (echoes, changed bit, carriers): the same step without the window state,
   * the focus and the document.
   */
  test("echoStageLogonStepBytes", () => {
    const step = Self.fields(true, InputEnvelope.echoStage)
    step.focus = new InputFocus(41, 47)
    const encoder = Self.encoder()
    const payload = ClientInput.inputMessage(encoder, step, 0, Self.echo())
    // prettier-ignore
    const expected = cat(
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01],
      [0x01], ses,
      [0x10, 0x06, 0x23, 0x00, 0x0d], codePage,
      [0x10, 0x09, 0x02, 0x00, 0x2c], changedAtoms,
      [0x0c]
    )
    assert.deepEqual(payload, expected)
  })

  /**
   * The stage "echoes and DYNN CHL" (echoes, changed bit, carriers, DYNN CHL): pysap's item set (SES,
   * DYNN CHL, the atoms) with the GUI's echoes and carriers, and no SCROLL_INFOS2, CONTAINER RESET,
   * focus or document (client-input.md §11.5, issue #105).
   */
  test("chlStageLogonStepBytes", () => {
    const step = Self.fields(true, InputEnvelope.chlStage)
    step.focus = new InputFocus(41, 47)
    const encoder = Self.encoder()
    const payload = ClientInput.inputMessage(encoder, step, 0, Self.echo())
    // prettier-ignore
    const expected = cat(
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01],
      [0x01], ses,
      [0x10, 0x06, 0x23, 0x00, 0x0d], codePage,
      [0x10, 0x05, 0x01, 0x00, 0x16], chl, // APPL DYNN CHL, the server's 22 bytes
      [0x10, 0x09, 0x02, 0x00, 0x2c], changedAtoms,
      [0x0c]
    )
    assert.deepEqual(payload, expected)
  })

  /**
   * The DYNN CHL part without an echo falls back to the step's own CHL, as the minimal step sends
   * it, and with none the item is left out; without the carriers the atoms stay APPL4.
   */
  test("chlPartWithoutAnEcho", () => {
    const step = Self.fields(true, InputEnvelope.echoes | InputEnvelope.dynnCHL)
    const encoder = Self.encoder()
    const without = ClientInput.inputMessage(encoder, step, 0, new ServerEcho())
    assert.ok(!containsSubsequence(without, [0x10, 0x05, 0x01]))
    step.dynnCHL = chl
    const withCHL = ClientInput.inputMessage(encoder, step, 0, new ServerEcho())
    assert.ok(containsSubsequence(withCHL, cat([0x10, 0x05, 0x01, 0x00, 0x16], chl)))
    const atoms = cat([0x12, 0x09, 0x02, 0x00, 0x00, 0x00, 0x2c], changedAtoms, [0x0c])
    assert.deepEqual(withCHL.slice(withCHL.length - atoms.length), atoms, "APPL4 without the carriers, then EOM")
  })

  // MARK: Later steps

  /**
   * A function key on a later screen with nothing edited: mode_stat and step echoed, an empty
   * DYNT_NOFOCUS, the UI_EVENT_SOURCE of PV-0771, the focus, and no DATAMANAGER document (PV-0774,
   * PV-0779, PV-0781).
   */
  test("referenceFunctionKeyStepBytes", () => {
    const step = new ClientInputStep({ envelope: InputEnvelope.reference })
    step.setFunctionKey(3, { row: 6, col: 18 })
    step.focus = new InputFocus(6, 18, 5)
    const encoder = Self.encoder()
    const payload = ClientInput.inputMessage(encoder, step, 0, Self.echo(7, 0x03))
    // prettier-ignore
    const expected = cat(
      [0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00], // mode_stat 0x03, the server's
      [0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x07], // step 7, the server's, not Swooey's 1
      [0x01], ses,
      [0x10, 0x06, 0x23, 0x00, 0x0d], codePage,
      [0x10, 0x05, 0x01, 0x00, 0x16], chl,
      [0x10, 0x0c, 0x06, 0x00, 0x21], scroll,
      [0x10, 0x0a, 0x01, 0x00, 0x09], reset,
      [0x10, 0x09, 0x0a, 0x00, 0x00], // an empty APPL DYNT_NOFOCUS: no field returned
      [0x10, 0x0f, 0x01, 0x00, 0x10, 0x0a, 0x00, 0x07, 0x00, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x06, 0x00, 0x12, 0x00, 0x01, 0x00],
      [0x10, 0x09, 0x0b, 0x00, 0x0a, 0x01, 0x00, 0x06, 0x00, 0x12, 0x00, 0x00, 0x00, 0x05, 0x00], // col offset 5
      [0x0c] // no XMLBLOB on a function key
    )
    assert.deepEqual(payload, expected)
    assert.equal(encoder.lastStepNumber, 7)
  })

  /**
   * A command on a later screen: VARINFO OKCODE right after CODEPAGE_DIAG_GUI, then the screen state,
   * the fields, and the DATAMANAGER document before EOM (PV-0774).
   */
  test("referenceOKCodeStepBytes", () => {
    const step = Self.fields(true, InputEnvelope.reference)
    const code = ascii("ZZDUCK")
    step.setFunctionCode(code, "varInfoOKCode")
    const encoder = Self.encoder()
    const payload = ClientInput.inputMessage(encoder, step, 0, Self.echo(2))
    // prettier-ignore
    const expected = cat(
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02],
      [0x01], ses,
      [0x10, 0x06, 0x23, 0x00, 0x0d], codePage,
      [0x10, 0x0c, 0x04, 0x00, 0x06, 0x5a, 0x5a, 0x44, 0x55, 0x43, 0x4b], // APPL VARINFO OKCODE "ZZDUCK", unpadded
      [0x10, 0x05, 0x01, 0x00, 0x16], chl,
      [0x10, 0x0c, 0x06, 0x00, 0x21], scroll,
      [0x10, 0x0a, 0x01, 0x00, 0x09], reset,
      [0x10, 0x09, 0x02, 0x00, 0x2c], changedAtoms,
      [0x11, 0x00, 0x00, 0x00, 0x33], dataManager,
      [0x0c]
    )
    assert.deepEqual(payload, expected)
  })

  // MARK: Fallbacks and the minimal envelope

  /**
   * With nothing to echo, the echoes fall back to Swooey's own counter and the reference client's
   * SES (R-CI-5); no CODEPAGE_DIAG_GUI and no screen state are invented.
   */
  test("echoesWithoutAnEcho", () => {
    const step = new ClientInputStep({ envelope: InputEnvelope.reference })
    const encoder = Self.encoder()
    const first = ClientInput.inputMessage(encoder, step, 0, new ServerEcho())
    // prettier-ignore
    const expected = cat(
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01],
      [0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // SES, event_array 1
      [0x10, 0x09, 0x0a, 0x00, 0x00],
      [0x11, 0x00, 0x00, 0x00, 0x33], dataManager,
      [0x0c]
    )
    assert.deepEqual(first, expected)
    step.dynnCHL = bytes(0x11, 0x22)
    const second = ClientInput.inputMessage(encoder, step, 0, new ServerEcho())
    assert.deepEqual(second.slice(8, 17), bytes(0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02), "the counter goes on")
    assert.ok(
      containsSubsequence(second, [0x10, 0x05, 0x01, 0x00, 0x02, 0x11, 0x22]),
      "the step's own DYNN CHL, as no echo has one"
    )
  })

  /** The minimal envelope is the message of R-CI-2 whatever the echo holds. */
  test("minimalIgnoresTheEcho", () => {
    const step = Self.fields(false, InputEnvelope.minimal)
    const plain = Self.encoder()
    const echoed = Self.encoder()
    const expected = ClientInput.inputMessage(plain, step)
    assert.deepEqual(ClientInput.inputMessage(echoed, step, 0, Self.echo(9, 0x03)), expected)
    assert.equal(echoed.lastStepNumber, 1)
    assert.equal(expected[8 + 9], DiagItemType.rawValue("appl4"), "DYNT_ATOM stays APPL4 (R-IT-10)")
  })

  /**
   * Parts can be taken alone: the carriers without the echoes keep Swooey's step and header and send
   * no SES unless the step has one.
   */
  test("carriersAlone", () => {
    const step = Self.fields(false, InputEnvelope.guiCarriers)
    const encoder = Self.encoder()
    const payload = ClientInput.inputMessage(encoder, step, 0, Self.echo(9, 0x03))
    assert.deepEqual(
      payload.slice(0, 17),
      bytes(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x04, 0x26, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01)
    )
    assert.deepEqual(payload.slice(17, 22), bytes(0x10, 0x09, 0x02, 0x00, 0x2c))
  })

  /** With compression the body is the same items after the compression header. */
  test("compressedReferenceStep", () => {
    const step = Self.fields(true, InputEnvelope.reference)
    const plain = Self.encoder()
    const compressing = new ClientMessageEncoder(zzTestIdentity(), terminal, "lzh")
    const body = ClientInput.inputMessage(plain, step, 0, Self.echo(1, 0x03)).slice(DiagHeader.size)
    const payload = ClientInput.inputMessage(compressing, step, 0, Self.echo(1, 0x03))
    const message = DiagMessage.parse(payload)
    assert.equal(message.header.modeStat, 0x03)
    if (message.body.kind !== "compressed") assert.fail("not compressed")
    const { header, data } = message.body
    const decompressor = new Decompressor()
    const output = decompressor.decompress(data.of(payload), header)
    assert.deepEqual(output, body)
  })

  /** An APPL value longer than 65 535 bytes cannot be echoed; nothing is counted. */
  test("echoTooLongForAPPL", () => {
    const echo = Self.echo()
    echo.dynnCHL = repeated(0, 65_536)
    const encoder = Self.encoder()
    throwsInfo(
      () => ClientInput.inputMessage(encoder, new ClientInputStep({ envelope: InputEnvelope.reference }), 0, echo),
      ClientMessageError,
      { kind: "item", error: { kind: "valueTooLong", type: "appl", length: 65_536 } }
    )
    assert.equal(encoder.lastStepNumber, 0)
    const badSES = Self.echo()
    badSES.ses = bytes(1, 2, 3)
    throwsInfo(
      () => ClientInput.inputMessage(encoder, new ClientInputStep({ envelope: InputEnvelope.echoes }), 0, badSES),
      ClientMessageError,
      { kind: "item", error: { kind: "wrongValueSize", type: "ses", expected: 16, actual: 3 } }
    )
    const tooLongCodePage = Self.echo()
    tooLongCodePage.codepageDiagGUI = repeated(0x30, 65_536)
    throwsInfo(
      () => ClientInput.inputMessage(encoder, new ClientInputStep({ envelope: InputEnvelope.echoes }), 0, tooLongCodePage),
      ClientMessageError,
      { kind: "item", error: { kind: "valueTooLong", type: "appl", length: 65_536 } }
    )
  })

  // MARK: Values

  /**
   * ServerEcho reads one message's items: the last of a repeated item, the first CONTAINER
   * RESET; merging keeps what a newer message does not repeat, and mode_stat from its header.
   */
  test("serverEchoReadsAndMerges", () => {
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(3).bytes, items)
    DiagItemEncoder.appendSimple("ses", ses, items)
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("codepageDiagGUI"), codePage, items)
    DiagItemEncoder.appendAPPL(ApplItem.container("reset"), reset, items)
    DiagItemEncoder.appendAPPL(ApplItem.dynn("chl"), chl, items)
    DiagItemEncoder.appendAPPL(ApplItem.varInfo("scrollInfos2"), scroll, items)
    DiagItemEncoder.appendAPPL(ApplItem.container("reset"), repeated(7, 9), items)
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(4).bytes, items)
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), bytes(1, 2), items) // not 4 bytes: ignored
    DiagItemEncoder.appendEOM(items)
    const found = new ServerEcho(items.toBytes())
    assert.equal(found.stepNumber, 4)
    assert.deepEqual(found.ses, ses)
    assert.deepEqual(found.codepageDiagGUI, codePage)
    assert.deepEqual(found.dynnCHL, chl)
    assert.deepEqual(found.scrollInfos2, scroll)
    assert.deepEqual(found.containerReset, reset, "the first RESET")

    const echo = new ServerEcho()
    echo.merge(
      found,
      new DiagHeader({ mode: 0, comFlag: 0, modeStat: 0xf0, errNo: 0, msgType: 0, msgInfo: 1, msgRC: 0, compress: CompressField.uncompressed })
    )
    assert.equal(echo.modeStat, 0xf0)
    const later = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(5).bytes, later)
    later.u8(0x13) // an unknown item type stops the walk; what came before it counts
    echo.merge(new ServerEcho(later.toBytes()), undefined)
    assert.equal(echo.stepNumber, 5)
    assert.deepEqual(echo.ses, ses, "kept: the newer message has none")
    assert.equal(echo.modeStat, 0xf0, "no header, no change")
    assert.deepEqual(new ServerEcho(new Uint8Array(0)), new ServerEcho())
  })

  /** DYNT_FOCUS_1 as sent (PV-0780): it decodes under PV-0711's layout. */
  test("focusValue", () => {
    const focus = new InputFocus(0x0102, 0x0304, 0x0506)
    assert.deepEqual(focus.bytes, bytes(0x01, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x05, 0x06, 0x00))
    const decoded = DyntFocus.decode(focus.bytes)
    assert.ok(decoded.areaID === 1 && decoded.row === 0x0102 && decoded.col === 0x0304)
    assert.ok(decoded.rowOffset === 0 && decoded.colOffset === 0x0506)
    assert.deepEqual(decoded.containerIDs, byteRange(9, 10))
    assert.equal(new InputFocus(1, 2).colOffset, 0)
  })

  /**
   * The changed bit sets bit 0x01 of dlg_flag_2 and nothing else (PV-0777); #34's blocked marking
   * stays blocked.
   */
  test("changedBit", () => {
    assert.deepEqual(new DyntDialogFlags({ flag1: 4, flag2: 0 }).withChangedBit(), new DyntDialogFlags({ flag1: 4, flag2: 1 }))
    assert.deepEqual(new DyntDialogFlags({ flag1: 0, flag2: 0x81 }).withChangedBit(), new DyntDialogFlags({ flag1: 0, flag2: 0x81 }))
    const field = new ReturnedField({ block: 5, row: 1, col: 2, mlen: 3, maxNrChars: 3, dialogFlags: new DyntDialogFlags({ flag1: 0xa0, flag2: 0x10 }) })
    const changed = field.withChangedBit()
    assert.deepEqual(changed.header.dialogFlags, new DyntDialogFlags({ flag1: 0xa0, flag2: 0x11 }))
    assert.ok(changed.header.row === 1 && changed.mlen === 3)
    throwsInfo(() => field.markedChanged(), ClientInputError, { kind: "specGap", issue: 34 })
  })

  /** The stages, their names and the identity default. */
  test("envelopeStages", () => {
    const e = InputEnvelope
    assert.deepEqual(e.stages, [e.minimal, e.echoStage, e.chlStage, e.stateStage, e.reference])
    assert.deepEqual(
      e.stages.map(stage => e.name(stage)),
      ["minimal", "echoes only", "echoes and DYNN CHL", "echoes, window state and focus", "full reference"]
    )
    assert.equal(e.name(e.focus | e.dataManager), "focus+DATAMANAGER")
    assert.deepEqual(e.partNames(e.reference), ["echoes", "changed bit", "GUI carriers", "DYNN CHL", "screen state", "focus", "DATAMANAGER"])
    assert.ok(e.contains(e.reference, e.stateStage) && e.contains(e.stateStage, e.chlStage))
    assert.ok(e.contains(e.chlStage, e.echoStage) && (e.chlStage & ~e.echoStage) === e.dynnCHL)
    assert.ok(!e.contains(e.chlStage, e.screenState) && !e.contains(e.chlStage, e.focus))
    assert.equal(e.default(ClientIdentities.reference), e.chlStage, "the stage the owner's server logged on with (PV-0783)")
    assert.equal(e.default(ClientIdentities.referenceNoRFC), e.chlStage, "the variants keep the reference identity's envelope")
    assert.equal(e.default(ClientIdentities.referenceNoCFW), e.chlStage)
    assert.equal(e.default(ClientIdentities.placeholder), e.minimal)
    assert.equal(e.default(ClientIdentities.minimal), e.minimal)
  })

  /** The step's description names the envelope and never a text. */
  test("descriptionNamesTheEnvelope", () => {
    const step = Self.fields(true, InputEnvelope.reference)
    assert.equal(step.description, "ClientInputStep(fields: 2, SES: no, DYNN CHL: no, envelope: full reference)")
    step.focus = new InputFocus(1, 2)
    assert.ok(step.description.endsWith("envelope: full reference, focus: yes)"))
    assert.ok(!step.description.includes("HONK"))
    assert.deepEqual(ClientDataManager.bareDocument, dataManager)
  })
})
