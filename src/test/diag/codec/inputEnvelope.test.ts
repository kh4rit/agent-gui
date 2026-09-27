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
  ClientIdentities,
  CompressField,
  DiagHeader,
  DiagItemEncoder,
  DialogStepNumber,
  DyntFocus,
  InputEnvelope,
  InputFocus,
  ServerEcho,
  byteRange
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { bytes, repeated } from "../../support/codecTestSupport.js"

describe("Client input: the reference envelope", () => {
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

  // MARK: The logon step

  // referenceLogonStepBytes: needs ClientInput.swift (next wave)
  // echoStageLogonStepBytes: needs ClientInput.swift (next wave)
  // chlStageLogonStepBytes: needs ClientInput.swift (next wave)
  // chlPartWithoutAnEcho: needs ClientInput.swift (next wave)

  // MARK: Later steps

  // referenceFunctionKeyStepBytes: needs ClientInput.swift (next wave)
  // referenceOKCodeStepBytes: needs ClientInput.swift (next wave)

  // MARK: Fallbacks and the minimal envelope

  // echoesWithoutAnEcho: needs ClientInput.swift (next wave)
  // minimalIgnoresTheEcho: needs ClientInput.swift (next wave)
  // carriersAlone: needs ClientInput.swift (next wave)
  // compressedReferenceStep: needs ClientInput.swift (next wave)
  // echoTooLongForAPPL: needs ClientInput.swift (next wave)

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

  // changedBit: needs ClientInput.swift (next wave)

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

  // descriptionNamesTheEnvelope: needs ClientInput.swift (next wave)
})
