// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ClientIdentityPresets.swift (MIT).

// Named client identities (docs/protocol/session.md §3, §5.4) for the owner's live-mode experiments
// (PLAN D22: the owner may try other identities to learn what a server needs) and for the app's
// identity pickers. None of them is the identity the shipped client sends: that stays the P1 ADR's
// decision (#16 ws_type, #17 capability mask, #18 code page).
//
// Swift adds these to `ClientIdentity` in an extension (`ClientIdentity.reference`,
// `ClientIdentity.Preset`, …). A TypeScript class cannot take static members from another module,
// so they live here: `ClientIdentities.reference` for `ClientIdentity.reference`, and
// `ClientIdentityPreset` for `ClientIdentity.Preset`.

import { ClientIdentity, type ClientCompression } from "./clientMessages.js"
import { SupportBit, SupportBits } from "./sessionItems.js"

/**
 * What the public reference client (pysap) sends in its first message by default (session.md §3.2,
 * §3.3, §5.4). Its protocol_version for an uncompressed session is `ProtocolVersion.uncompressed`.
 */
export const ReferenceClientDefaults = {
  /** The CONNECT code_page (PV-0131). */
  codePage: 1_100, // provenance: PV-0131
  /** The CONNECT ws_type (PV-0122). */
  wsType: 5_001, // provenance: PV-0122

  /** The default SUPPORTDATA mask, 32 bytes in wire order, eight per row (PV-0538). A fresh copy on every read. */
  get supportDataBytes(): Uint8Array {
    // prettier-ignore
    return Uint8Array.of(
      0xff, 0x7f, 0xfe, 0x2d, 0xda, 0xb7, 0x37, 0xd6, // provenance: PV-0538
      0x74, 0x08, 0x7e, 0x13, 0x05, 0x97, 0x15, 0x97, // provenance: PV-0538
      0xef, 0xf2, 0x3f, 0x8d, 0x07, 0x70, 0xff, 0x0f, // provenance: PV-0538
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // provenance: PV-0538
    )
  },

  /** `supportDataBytes` as a mask (a fresh one on every read). */
  get supportData(): SupportBits {
    return SupportBits.decode(ReferenceClientDefaults.supportDataBytes)
  },

  /** `supportData` with `bits` cleared. */
  supportDataRemoving(bits: readonly SupportBit[]): SupportBits {
    const mask = ReferenceClientDefaults.supportData
    for (const bit of bits) mask.remove(bit)
    return mask
  }
} as const

/** The named bits, in the order given; a name the table lacks is a programming error. */
function bits(names: readonly string[]): SupportBit[] {
  return names.map(name => {
    const bit = SupportBit.fromName(name)
    if (bit === undefined) throw new Error(`${name} is a bit name of session.md §5.2`)
    return bit
  })
}

/** The static identities of Swift's `extension ClientIdentity`. Each identity is a fresh copy on every read. */
export const ClientIdentities = {
  /** Code page 0, ws_type 0, no capability bit (`ClientIdentityPreset` `placeholder`). */
  get placeholder(): ClientIdentity {
    return new ClientIdentity({ codePage: 0, wsType: 0, supportData: new SupportBits() })
  },

  /** The public reference client's CONNECT defaults and default mask (preset `reference`). */
  get reference(): ClientIdentity {
    return new ClientIdentity({
      codePage: ReferenceClientDefaults.codePage,
      wsType: ReferenceClientDefaults.wsType,
      supportData: ReferenceClientDefaults.supportData
    })
  },

  /** The reference identity less `rfcOverDiagBits` (preset `reference-norfc`). */
  get referenceNoRFC(): ClientIdentity {
    return new ClientIdentity({
      codePage: ReferenceClientDefaults.codePage,
      wsType: ReferenceClientDefaults.wsType,
      supportData: ReferenceClientDefaults.supportDataRemoving(ClientIdentities.rfcOverDiagBits)
    })
  },

  /** The reference identity less `rfcOverDiagBits` and `controlFrameworkBits` (preset `reference-nocfw`). */
  get referenceNoCFW(): ClientIdentity {
    return new ClientIdentity({
      codePage: ReferenceClientDefaults.codePage,
      wsType: ReferenceClientDefaults.wsType,
      supportData: ReferenceClientDefaults.supportDataRemoving([...ClientIdentities.rfcOverDiagBits, ...ClientIdentities.controlFrameworkBits])
    })
  },

  /**
   * The identities whose sessions send the reference input envelope unless told otherwise
   * (`InputEnvelope.default`): `reference` and its two variants, which differ from it only in
   * capability bits.
   */
  get referenceEnvelopeIdentities(): ClientIdentity[] {
    return [ClientIdentities.reference, ClientIdentities.referenceNoRFC, ClientIdentities.referenceNoCFW]
  },

  /** The reference client's code page and ws_type with Swooey's implemented bits only (preset `minimal`). */
  get minimal(): ClientIdentity {
    return new ClientIdentity({
      codePage: ReferenceClientDefaults.codePage,
      wsType: ReferenceClientDefaults.wsType,
      supportData: new SupportBits(ClientIdentities.implementedSupportBits)
    })
  },

  /**
   * The capability bits whose named feature Swooey handles on the wire today (session.md §5.4):
   * ENABLE_UTF8 (screen text is decoded and encoded as UTF-8 only), ENABLE_APPL4 (the walker reads
   * APPL4 items and the encoder writes DYNT_ATOM as APPL4) and DIALOG_STEP_NUMBER (every dialog
   * message starts with the step item, PV-0524). No source says what a bit asks of a client (#17),
   * so this reads each name at face value.
   */
  implementedSupportBits: [SupportBit.enableUTF8, SupportBit.enableAPPL4, SupportBit.dialogStepNumber] as readonly SupportBit[],

  /**
   * The bits of the reference mask that name RFC over DIAG, which preset `reference-norfc` clears
   * (session.md §5.4): every set bit whose name mentions RFC (PV-0510). The mask's other RFC-named
   * bits, RFC_DIALOG, NORFC and RFC_SERVER_4_GUI, are clear already.
   */
  rfcOverDiagBits: bits(["RFCBLOB_DIAG_PARSER", "RFC_QUEUE", "RFC_COMPRESS", "RFC_ASYNC_BLOB"]) as readonly SupportBit[],

  /**
   * The Control Framework bits of the reference mask, which preset `reference-nocfw` also clears
   * (session.md §5.4): the set bits whose names mention a control, those that
   * controls/support-bits.md §2 ties to a control's data provider, container kind or events, and
   * JAVA_BEANS (PV-0510). CONTAINER_TYPE and XML_BLOBS stay: the logon screen's step loop and the
   * reference envelope's DATAMANAGER document use their channels.
   */
  controlFrameworkBits: bits([
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
  ]) as readonly SupportBit[],

  /** The named bits, in the order given; a name the table lacks is a programming error. */
  bits(names: readonly string[]): SupportBit[] {
    return bits(names)
  },

  /** "(A, B, C)" for a summary. */
  names(list: readonly SupportBit[]): string {
    return "(" + list.flatMap(bit => (bit.name === undefined ? [] : [bit.name])).join(", ") + ")"
  }
} as const

/**
 * A named identity with a short name for a command line (`--identity reference`) or a picker (Swift
 * `ClientIdentity.Preset`). Every preset pairs with compression `off` (protocol_version 200,
 * PV-0121), the only compression setting Swooey uses until spike P4 (IMPL-DH-4).
 * - `placeholder`: code page 0, ws_type 0 and no capability bit: claims no front end, no code page
 *   and no capability. What diagctl and the app sent before presets existed.
 * - `reference`: the public reference client's defaults (pysap): code page 1100 (PV-0131), ws_type
 *   5001 (PV-0122) and its default SUPPORTDATA mask (PV-0538).
 * - `referenceNoRFC` (`reference-norfc`): `reference` without the bits of its mask that name RFC
 *   over DIAG (`ClientIdentities.rfcOverDiagBits`, session.md §5.4): for the owner's bisection of a
 *   logon that ends in a server error while the server's RFC handler reports a failed send (#105).
 * - `referenceNoCFW` (`reference-nocfw`): `referenceNoRFC` also without the Control Framework bits
 *   (`ClientIdentities.controlFrameworkBits`, session.md §5.4).
 * - `minimal`: code page 1100 and ws_type 5001 as the reference client sends them, and only the
 *   three capability bits whose named feature Swooey handles today: ENABLE_UTF8, ENABLE_APPL4 and
 *   DIALOG_STEP_NUMBER (session.md §5.4). All three are set in the reference mask too.
 */
export type ClientIdentityPreset = "placeholder" | "reference" | "referenceNoRFC" | "referenceNoCFW" | "minimal"

export const ClientIdentityPreset = {
  /** Every preset, in declaration order (Swift `CaseIterable`). */
  allCases: ["placeholder", "reference", "referenceNoRFC", "referenceNoCFW", "minimal"] as readonly ClientIdentityPreset[],

  /** The short name for a command line (Swift `rawValue`, `name`). */
  name(preset: ClientIdentityPreset): string {
    switch (preset) {
      case "referenceNoRFC":
        return "reference-norfc"
      case "referenceNoCFW":
        return "reference-nocfw"
      default:
        return preset
    }
  },

  /**
   * The preset with this short name (`placeholder`, `reference`, `reference-norfc`,
   * `reference-nocfw`, `minimal`), or undefined (Swift `init?(name:)`).
   */
  fromName(name: string): ClientIdentityPreset | undefined {
    return ClientIdentityPreset.allCases.find(preset => ClientIdentityPreset.name(preset) === name)
  },

  /** The identity this preset declares (a fresh copy). */
  identity(preset: ClientIdentityPreset): ClientIdentity {
    switch (preset) {
      case "placeholder":
        return ClientIdentities.placeholder
      case "reference":
        return ClientIdentities.reference
      case "referenceNoRFC":
        return ClientIdentities.referenceNoRFC
      case "referenceNoCFW":
        return ClientIdentities.referenceNoCFW
      case "minimal":
        return ClientIdentities.minimal
    }
  },

  /** The compression choice to pair with the identity: always `off`. */
  compression(_preset: ClientIdentityPreset): ClientCompression {
    return "off"
  },

  /** One line for a help text or a picker. */
  summary(preset: ClientIdentityPreset): string {
    switch (preset) {
      case "placeholder":
        return "code page 0, ws_type 0, no capability bits"
      case "reference":
        return "the public reference client's defaults: code page 1100, ws_type 5001, its default capability mask"
      case "referenceNoRFC":
        return (
          "reference without the RFC-over-DIAG bits " +
          ClientIdentities.names(ClientIdentities.rfcOverDiagBits) +
          ` (${ClientIdentities.referenceNoRFC.supportData.setBits.length} bits)`
        )
      case "referenceNoCFW":
        return (
          "reference-norfc also without the Control Framework bits " +
          ClientIdentities.names(ClientIdentities.controlFrameworkBits) +
          ` (${ClientIdentities.referenceNoCFW.supportData.setBits.length} bits)`
        )
      case "minimal":
        return "code page 1100, ws_type 5001, only the bits Swooey implements (ENABLE_UTF8, ENABLE_APPL4, DIALOG_STEP_NUMBER)"
    }
  }
} as const
