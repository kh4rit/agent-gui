// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ClientIdentityPresetTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ClientIdentities,
  ClientIdentity,
  ClientIdentityPreset,
  ClientMessageEncoder,
  DiagHeader,
  SupportBit,
  SupportBits
} from "../../../diag/codec/index.js"
import { DPHeader, DPTerminalName } from "../../../diag/wire/index.js"
import { cat, repeated } from "../../support/codecTestSupport.js"

/** Swift `compactMap(\.name)`: the names of the bits that have one. */
function names(bits: readonly SupportBit[]): string[] {
  return bits.flatMap(bit => (bit.name === undefined ? [] : [bit.name]))
}

/** Swift `Set(bits)`: the bits as a set of their numbers. */
function numberSet(bits: readonly SupportBit[]): Set<number> {
  return new Set(bits.map(bit => bit.number))
}

/** Swift `isStrictSubset(of:)`. */
function isStrictSubset(subset: Set<number>, superset: Set<number>): boolean {
  return subset.size < superset.size && [...subset].every(number => superset.has(number))
}

/** Swift `subtracting(_:)`. */
function subtracting(set: Set<number>, other: Set<number>): Set<number> {
  return new Set([...set].filter(number => !other.has(number)))
}

/**
 * The identity presets (session.md §3, §5.4): names, and the exact CONNECT and SUPPORTDATA items
 * each puts into the first message; the reference variants' removed bits.
 */
describe("Client identity presets", () => {
  const terminal = DPTerminalName.fromHostName("zz-waffle-iron")

  /** The two items after the first message's DIAG header. */
  function initItems(preset: ClientIdentityPreset): Uint8Array {
    const encoder = new ClientMessageEncoder(ClientIdentityPreset.identity(preset), terminal, ClientIdentityPreset.compression(preset))
    const payload = encoder.firstMessage()
    return payload.slice(DPHeader.size + DiagHeader.size)
  }

  const connectHeader = [0x10, 0x04, 0x02, 0x00, 0x0c]
  const supportDataHeader = [0x10, 0x04, 0x0b, 0x00, 0x20]

  test("namesRoundTrip", () => {
    assert.deepEqual(
      ClientIdentityPreset.allCases.map(preset => ClientIdentityPreset.name(preset)),
      ["placeholder", "reference", "reference-norfc", "reference-nocfw", "minimal"]
    )
    for (const preset of ClientIdentityPreset.allCases) {
      assert.equal(ClientIdentityPreset.fromName(ClientIdentityPreset.name(preset)), preset)
      assert.ok(ClientIdentityPreset.summary(preset).length > 0)
      assert.equal(ClientIdentityPreset.compression(preset), "off")
    }
    assert.equal(ClientIdentityPreset.fromName("Reference"), undefined)
    assert.equal(ClientIdentityPreset.fromName("referenceNoRFC"), undefined, "the command-line name, not the Swift case")
    assert.equal(ClientIdentityPreset.fromName("zz-toaster"), undefined)
  })

  test("placeholderBytes", () => {
    assert.deepEqual(ClientIdentities.placeholder, new ClientIdentity({ codePage: 0, wsType: 0, supportData: new SupportBits() }))
    const expected = cat(
      connectHeader,
      [0x00, 0x00, 0x00, 0xc8],
      [0x00, 0x00, 0x00, 0x00],
      [0x00, 0x00, 0x00, 0x00],
      supportDataHeader,
      repeated(0, 32)
    )
    assert.deepEqual(initItems("placeholder"), expected)
  })

  /**
   * pysap's defaults: protocol_version 200 (uncompressed), code page 1100, ws_type 5001, and its
   * default mask (PV-0121, PV-0131, PV-0122, PV-0538).
   */
  test("referenceBytes", () => {
    // prettier-ignore
    const mask = Uint8Array.of(
      0xff, 0x7f, 0xfe, 0x2d, 0xda, 0xb7, 0x37, 0xd6,
      0x74, 0x08, 0x7e, 0x13, 0x05, 0x97, 0x15, 0x97,
      0xef, 0xf2, 0x3f, 0x8d, 0x07, 0x70, 0xff, 0x0f,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    )
    const expected = cat(
      connectHeader,
      [0x00, 0x00, 0x00, 0xc8],
      [0x00, 0x00, 0x04, 0x4c],
      [0x00, 0x00, 0x13, 0x89],
      supportDataHeader,
      mask
    )
    assert.deepEqual(initItems("reference"), expected)
    assert.deepEqual(ClientIdentities.reference.supportData.bytes, mask)
    assert.ok(ClientIdentities.reference.codePage === 1_100 && ClientIdentities.reference.wsType === 5_001)
    // Bytes 24–31 are zero: no Wireshark-only (byte 26) or unnamed bit is set.
    assert.ok(ClientIdentities.reference.supportData.setBits.every(bit => bit.number < 192))
    assert.equal(ClientIdentities.reference.supportData.setBits.length, 116)
  })

  test("minimalBytes", () => {
    const mask = repeated(0, 32)
    mask[16] = 0x80 // ENABLE_UTF8, bit 135
    mask[17] = 0x20 // ENABLE_APPL4, bit 141
    mask[22] = 0x20 // DIALOG_STEP_NUMBER, bit 181
    const expected = cat(
      connectHeader,
      [0x00, 0x00, 0x00, 0xc8],
      [0x00, 0x00, 0x04, 0x4c],
      [0x00, 0x00, 0x13, 0x89],
      supportDataHeader,
      mask
    )
    assert.deepEqual(initItems("minimal"), expected)
    assert.deepEqual(names(ClientIdentities.minimal.supportData.setNamedBits), ["ENABLE_UTF8", "ENABLE_APPL4", "DIALOG_STEP_NUMBER"])
  })

  /** minimal ⊂ reference, so the owner can move between the two a bit at a time. */
  test("minimalIsASubsetOfReference", () => {
    const reference = ClientIdentities.reference.supportData
    for (const bit of ClientIdentities.minimal.supportData.setBits) {
      assert.ok(reference.contains(bit), `${bit.name ?? `bit ${bit.number}`}`)
    }
    assert.equal(ClientIdentities.minimal.codePage, ClientIdentities.reference.codePage)
    assert.equal(ClientIdentities.minimal.wsType, ClientIdentities.reference.wsType)
  })

  test("presetsMapToTheirIdentities", () => {
    assert.deepEqual(ClientIdentityPreset.identity("placeholder"), ClientIdentities.placeholder)
    assert.deepEqual(ClientIdentityPreset.identity("reference"), ClientIdentities.reference)
    assert.deepEqual(ClientIdentityPreset.identity("referenceNoRFC"), ClientIdentities.referenceNoRFC)
    assert.deepEqual(ClientIdentityPreset.identity("referenceNoCFW"), ClientIdentities.referenceNoCFW)
    assert.deepEqual(ClientIdentityPreset.identity("minimal"), ClientIdentities.minimal)
    const key = (identity: ClientIdentity) => `${identity.codePage}/${identity.wsType}/${Array.from(identity.supportData.bytes).join(",")}`
    assert.equal(new Set(ClientIdentityPreset.allCases.map(preset => key(ClientIdentityPreset.identity(preset)))).size, 5)
  })

  // MARK: The reference variants (session.md §5.4, #105)

  /** CONNECT as the reference client's, with `mask` after it. */
  function referenceItems(mask: ArrayLike<number>): Uint8Array {
    return cat(connectHeader, [0x00, 0x00, 0x00, 0xc8], [0x00, 0x00, 0x04, 0x4c], [0x00, 0x00, 0x13, 0x89], supportDataHeader, mask)
  }

  /**
   * The reference mask less RFCBLOB_DIAG_PARSER (byte 6, 0x04), RFC_QUEUE and RFC_COMPRESS
   * (byte 10, 0x04 and 0x08) and RFC_ASYNC_BLOB (byte 11, 0x01).
   */
  test("referenceNoRFCBytes", () => {
    // prettier-ignore
    const mask = Uint8Array.of(
      0xff, 0x7f, 0xfe, 0x2d, 0xda, 0xb7, 0x33, 0xd6,
      0x74, 0x08, 0x72, 0x12, 0x05, 0x97, 0x15, 0x97,
      0xef, 0xf2, 0x3f, 0x8d, 0x07, 0x70, 0xff, 0x0f,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    )
    assert.deepEqual(initItems("referenceNoRFC"), referenceItems(mask))
    assert.deepEqual(ClientIdentities.referenceNoRFC.supportData.bytes, mask)
    assert.equal(ClientIdentities.referenceNoRFC.supportData.setBits.length, 112)
  })

  /**
   * reference-norfc less CONTROL_CONTAINER (byte 6, 0x10), JAVA_BEANS, DPLOADONDEMAND and
   * CTL_PROPCACHE (byte 10, 0x10, 0x20, 0x40), DPLOADONDEMAND_WRITE and CONTROL_FOCUS (byte 13,
   * 0x02, 0x04), XMLPROP_CONTAINER and CONTROL_FOCUS_ON_LIST (byte 15, 0x02, 0x80), SPLITTER
   * (byte 18, 0x10) and TEXTEDIT_STREAM (byte 19, 0x01).
   */
  test("referenceNoCFWBytes", () => {
    // prettier-ignore
    const mask = Uint8Array.of(
      0xff, 0x7f, 0xfe, 0x2d, 0xda, 0xb7, 0x23, 0xd6,
      0x74, 0x08, 0x02, 0x12, 0x05, 0x91, 0x15, 0x15,
      0xef, 0xf2, 0x2f, 0x8c, 0x07, 0x70, 0xff, 0x0f,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    )
    assert.deepEqual(initItems("referenceNoCFW"), referenceItems(mask))
    assert.deepEqual(ClientIdentities.referenceNoCFW.supportData.bytes, mask)
    assert.equal(ClientIdentities.referenceNoCFW.supportData.setBits.length, 102)
  })

  /**
   * minimal ⊂ reference-nocfw ⊂ reference-norfc ⊂ reference, and each step clears exactly its
   * named bits: the owner bisects from the reference mask down.
   */
  test("variantsAreSubsetsOfReference", () => {
    const reference = numberSet(ClientIdentities.reference.supportData.setBits)
    const noRFC = numberSet(ClientIdentities.referenceNoRFC.supportData.setBits)
    const noCFW = numberSet(ClientIdentities.referenceNoCFW.supportData.setBits)
    const minimal = numberSet(ClientIdentities.minimal.supportData.setBits)
    assert.ok(isStrictSubset(noRFC, reference))
    assert.ok(isStrictSubset(noCFW, noRFC))
    assert.ok(isStrictSubset(minimal, noCFW), "the variants keep ENABLE_UTF8, ENABLE_APPL4 and DIALOG_STEP_NUMBER")
    assert.deepEqual(subtracting(reference, noRFC), numberSet(ClientIdentities.rfcOverDiagBits))
    assert.deepEqual(subtracting(noRFC, noCFW), numberSet(ClientIdentities.controlFrameworkBits))
    for (const identity of [ClientIdentities.referenceNoRFC, ClientIdentities.referenceNoCFW]) {
      assert.ok(identity.codePage === ClientIdentities.reference.codePage && identity.wsType === ClientIdentities.reference.wsType)
    }
  })

  /**
   * The removed bits by name, each set in the reference mask; the RFC list is every set bit
   * whose name mentions RFC, and the reference mask's other RFC-named bits are clear.
   */
  test("removedBitsByName", () => {
    const reference = ClientIdentities.reference.supportData
    assert.deepEqual(names(ClientIdentities.rfcOverDiagBits), ["RFCBLOB_DIAG_PARSER", "RFC_QUEUE", "RFC_COMPRESS", "RFC_ASYNC_BLOB"])
    assert.deepEqual(
      ClientIdentities.rfcOverDiagBits.map(bit => bit.number),
      [50, 82, 83, 88]
    )
    assert.deepEqual(names(ClientIdentities.controlFrameworkBits), [
      "CONTROL_CONTAINER",
      "JAVA_BEANS",
      "DPLOADONDEMAND",
      "CTL_PROPCACHE",
      "DPLOADONDEMAND_WRITE",
      "CONTROL_FOCUS",
      "XMLPROP_CONTAINER",
      "CONTROL_FOCUS_ON_LIST",
      "SPLITTER",
      "TEXTEDIT_STREAM"
    ])
    assert.deepEqual(
      ClientIdentities.controlFrameworkBits.map(bit => bit.number),
      [52, 84, 85, 86, 105, 106, 121, 127, 148, 152]
    )
    for (const bit of [...ClientIdentities.rfcOverDiagBits, ...ClientIdentities.controlFrameworkBits]) {
      assert.ok(reference.contains(bit), `${bit.name ?? "?"} is set in the reference mask`)
    }
    const rfcNamed = reference.setNamedBits.filter(bit => bit.name?.includes("RFC") === true)
    assert.deepEqual(rfcNamed, ClientIdentities.rfcOverDiagBits)
    const allRFCNamed = Array.from({ length: SupportBit.count }, (_, number) => SupportBit.fromNumber(number))
      .filter((bit): bit is SupportBit => bit !== undefined)
      .filter(bit => bit.name?.includes("RFC") === true)
    assert.deepEqual(names(allRFCNamed), [
      "RFC_DIALOG",
      "NORFC",
      "RFCBLOB_DIAG_PARSER",
      "RFC_QUEUE",
      "RFC_COMPRESS",
      "RFC_ASYNC_BLOB",
      "RFC_SERVER_4_GUI"
    ])
    assert.ok(ClientIdentities.referenceNoCFW.supportData.setNamedBits.every(bit => bit.name?.includes("RFC") !== true))
  })

  /** Each variant's summary names the bits it removes and its bit count. */
  test("variantSummaries", () => {
    assert.equal(
      ClientIdentityPreset.summary("referenceNoRFC"),
      "reference without the RFC-over-DIAG bits (RFCBLOB_DIAG_PARSER, RFC_QUEUE, RFC_COMPRESS, RFC_ASYNC_BLOB) (112 bits)"
    )
    assert.equal(
      ClientIdentityPreset.summary("referenceNoCFW"),
      "reference-norfc also without the Control Framework bits (CONTROL_CONTAINER, JAVA_BEANS, DPLOADONDEMAND, CTL_PROPCACHE, " +
        "DPLOADONDEMAND_WRITE, CONTROL_FOCUS, XMLPROP_CONTAINER, CONTROL_FOCUS_ON_LIST, SPLITTER, TEXTEDIT_STREAM) (102 bits)"
    )
  })
})
