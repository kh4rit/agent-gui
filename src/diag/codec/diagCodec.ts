// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DiagCodec.swift (MIT).

// DiagCodec: the DIAG header and message layout (docs/protocol/diag-header.md), the compression
// header and the hand-off to DiagCompression (compression-header.md), the item layer with its
// (id, sid) registry (items.md), and the session payloads and client messages (session.md).
//
// The API follows protocol spec v1:
// - `DiagHeader` (the 8 fields, `bodyClass()`, the three client header patterns);
// - `DiagMessage` (header plus body layout), `DiagErrorBody` (error-body split), `ServerErrorText`
//   (the error text decoded for the user's own screen, IMPL-DH-8);
// - `CompressionHeader.decode`, `Decompressor` / `Decompression` (LZH and LZC data);
// - `DiagItemWalker`, `DiagItem`, `DiagItemType`, `DiagItemEncoder`, the registry `ApplID`,
//   `ApplSID`, `ApplItem`;
// - the value codecs `SESValue`, `SFEValue`, `SBAValue`, `SLCValue`, `SimpleItemValue`,
//   `UserConnect`, `SupportBits`, `DialogStepNumber`, `SystemInfoText`, `SystemInfoNumber`,
//   `CodepageDiagGUI`, `KernelVersion`;
// - `CodecSpecGap`: the open issues these paths stop at.
//
// Since protocol spec v2 (server-screen.md, client-input.md): the screen value codecs
// `ScreenValue` / `ScreenValueLayout` (`AreaSize`, `FontMetric`, `ContainerGeometry`,
// `ScrollInfos`, `ScrollInfos2`, `ContainerLoop`, `ListFocus`), `InternalModeUUIDs`, `DyntFocus`,
// `ContainerName`.
//
// Conventions of the TypeScript port (docs/porting.md): a Swift enum becomes a string union or a
// discriminated union on `kind` together with a const object of the same name that holds its
// members (`DiagItemType.name(type)`, `ApplItem.of(id, sid)`); an unlabeled associated value is
// the field `value`. A Swift `Range<Int>` is a `ByteRange`. Byte arrays are `Uint8Array`, and
// encoders append to a `ByteWriter` (src/diag/wire/bytes.ts).

/**
 * Numbers of the open spec-gap issues (`issues/NNNN-*.md`) at which a DiagCodec path stops or
 * that a value this module exposes depends on.
 *
 * These are issue-tracker numbers, not protocol values. A path that needs a fact the spec does
 * not state throws an error that names its issue (`specGap`) instead of guessing
 * (docs/protocol/README.md, "How implementers use this spec").
 *
 * Swift adds members to this enum with `extension CodecSpecGap` in ScreenValues.swift,
 * DyntAtom.swift and DyntElements.swift; a TypeScript const object cannot be
 * extended from another module without a load-order cycle, so those members live here, under a
 * comment naming their Swift file.
 */
export const CodecSpecGap = {
  /**
   * Values and meanings of mode_stat, msg_type, msg_info and msg_rc; how a server opens, numbers
   * and ends modes (Readings R-MO-1 to R-MO-6 stand in, session.md §8).
   */
  diagHeaderFieldValues: 6, // not-protocol: issue number, issues/0006
  /** com_flag meanings and turn-taking. */
  comFlagSemantics: 7, // not-protocol: issue number, issues/0007
  /**
   * Error text: its encoding (UTF-16LE or the code page in force), byte-order mark, 0x0C inside
   * a code unit (IMPL-DH-8).
   */
  diagErrorText: 8, // not-protocol: issue number, issues/0008
  /** Server step-number rules, per-mode counting, EOM in server messages. */
  messageSequencing: 15, // not-protocol: issue number, issues/0015
  /** The ws_type Swooey sends: a project decision (P1 ADR). */
  connectWSType: 16, // not-protocol: issue number, issues/0016
  /** The SUPPORTDATA mask Swooey sends: a project decision (P1 ADR). */
  supportDataMask: 17, // not-protocol: issue number, issues/0017
  /** Code-page numbers to character sets; the code_page to request; text item character sets. */
  codePageValues: 18, // not-protocol: issue number, issues/0018
  /** XMLBLOB value encoding and roles; encoders send no XMLBLOB (IMPL-IT-10). */
  xmlblobValue: 20, // not-protocol: issue number, issues/0020
  /** Compression version nibbles other than 1 (IMPL-CH-8, provisional). */
  compressionVersionNibble: 25, // not-protocol: issue number, issues/0025
  /** The size of the OKC value (type 0x08); the walker stops at OKC (IMPL-IT-8). */
  okcSize: 30, // not-protocol: issue number, issues/0030
  /** APPL versus APPL4 per (id, sid); encoders send only the carriers of R-IT-10. */
  applCarrier: 31, // not-protocol: issue number, issues/0031
  /** Layouts of ICO, TIT, DiagMessage, SBA2 and CHL values. */
  simpleItemLayouts: 32, // not-protocol: issue number, issues/0032
  /** Payload layouts of the registry pairs no spec file specifies. */
  applPayloadLayouts: 33, // not-protocol: issue number, issues/0033

  // ScreenValues.swift (extension CodecSpecGap)

  /**
   * Decoder policy for value lengths: overlong values, unterminated strings, trailing bytes.
   * Provisional; IMPL-SS-3 applies it to the screen layouts.
   */
  itemValueLengthPolicy: 39, // not-protocol: issue number, issues/0039
  /** Which items a real server sends in a screen, in which order, and whether order matters. */
  serverScreenComposition: 49, // not-protocol: issue number, issues/0049
  /** The MNUENTRY entry walk (a conflict between the sources) and the meaning of its fields. */
  menuEntries: 50, // not-protocol: issue number, issues/0050
  /** Which focus items a server sends, and what DYNT_FOCUS_1's fields mean. */
  focusItems: 51, // not-protocol: issue number, issues/0051
  /** `@…@` icon and tooltip codes in field and label texts. */
  atCodesInTexts: 53, // not-protocol: issue number, issues/0053
  /** Absent identity items on later screens; repeated identity items in one message. */
  identityItemRepeats: 54, // not-protocol: issue number, issues/0054
  /** Which item a client must send to trigger a function (VARINFO OKCODE, UI_EVENT_SOURCE, …). */
  functionTrigger: 55, // not-protocol: issue number, issues/0055
  /** UI_EVENT_SOURCE: the event-data width when NAVIGATION_DATA is clear (a conflict). */
  uiEventDataWidth: 56, // not-protocol: issue number, issues/0056

  // DyntAtom.swift (extension CodecSpecGap)

  /**
   * The meaning of the dlg_flag_1 and dlg_flag_2 bits, including the "changed" flag of user
   * input (dynt-atoms.md, "dlg_flag bytes").
   */
  dyntDialogFlags: 34, // not-protocol: issue number, issues/0034
  /**
   * The trailing strings of push-button (115) and radio-button (129) atoms: the sources
   * conflict (dynt-atoms.md, "Radio button (129)", "Buttons (115, 116)").
   */
  dyntButtonStrings: 35, // not-protocol: issue number, issues/0035
  /** Field atoms whose dlen does not fill the rest of the atom: the sources conflict (IMPL-DA-6). */
  dyntDlenMismatch: 36, // not-protocol: issue number, issues/0036
  /**
   * Payloads that do not fit their element type's fixed layout (too short, a tabstrip string
   * without its zero byte, bytes after the third tabstrip string): no rule in the spec.
   */
  dyntMalformedPayload: 38, // not-protocol: issue number, issues/0038

  // W2a: screen side
  // DyntElements.swift (extension CodecSpecGap)

  /** Checkbox and radio bodies and their returns (elements.md §3; R-EL-1, R-EL-2, R-EL-4). */
  toggleElements: 107, // not-protocol: issue number, issues/0107
  /** Dropdown option lists and the returned key (elements.md §4; R-EL-3). */
  dropdownValues: 108, // not-protocol: issue number, issues/0108
  /** Tabstrip header, page association, inactive pages, local paging (elements.md §5). */
  tabstripPages: 109, // not-protocol: issue number, issues/0109
  /** Table-control items: headers, rows, selector, scroll state and request (elements.md §6). */
  tableControlItems: 110, // not-protocol: issue number, issues/0110
  /** List SFE flags, DYNN CHL, list paging and line selection (elements.md §7). */
  listOutput: 111, // not-protocol: issue number, issues/0111
  /** Popups: SES modal fields, POPU, closing (elements.md §8). */
  popups: 112, // not-protocol: issue number, issues/0112
  /** MESTYPE2 layout conflict and how I and A messages travel (elements.md §9). */
  statusMessageTypes: 113, // not-protocol: issue number, issues/0113
  /** Value help (F4): request, answer and pick (elements.md §10). */
  valueHelp: 114, // not-protocol: issue number, issues/0114
  /** Required and date markers on input fields (elements.md §11). */
  fieldMarkers: 115 // not-protocol: issue number, issues/0115
} as const

/**
 * Failures of the value codecs of individual items: the simple-item layouts (items.md) and the
 * session payloads (session.md). Each aborts the decoding of that one value only.
 */
export type ItemPayloadErrorInfo =
  /**
   * The value ends inside a fixed-size field or before the terminator of a zero-terminated
   * string (vector error class `truncated`).
   */
  | { readonly kind: "truncated"; readonly needed: number; readonly available: number }
  /**
   * The value is longer than its fixed size. The spec states the exact size (for example
   * CONNECT 12 bytes, PV-0504); Swooey does not guess what extra bytes mean.
   */
  | { readonly kind: "overlong"; readonly expected: number; readonly actual: number }
  /**
   * The input is not a simple item of a type this codec decodes: `typeByte` is no simple
   * type, or the first byte is missing (undefined).
   */
  | { readonly kind: "notASimpleItem"; readonly typeByte: number | undefined }
  /** The layout is not specified yet; `issue` names the spec-gap issue. */
  | { readonly kind: "specGap"; readonly issue: number }

export class ItemPayloadError extends Error {
  constructor(readonly info: ItemPayloadErrorInfo) {
    super(describeItemPayloadError(info))
    this.name = "ItemPayloadError"
  }
}

function describeItemPayloadError(info: ItemPayloadErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return `item value truncated: ${info.needed} bytes needed, ${info.available} available`
    case "overlong":
      return `item value overlong: ${info.expected} bytes expected, ${info.actual} present`
    case "notASimpleItem":
      return `not a simple item (type byte ${info.typeByte === undefined ? "missing" : info.typeByte})`
    case "specGap":
      return `item value layout not specified (spec gap #${info.issue})`
  }
}

/** Fixed-size reads shared by the value codecs. */
export const FixedSize = {
  /** Checks that `value` holds exactly `size` bytes. */
  check(value: Uint8Array, size: number): void {
    if (value.length < size) throw new ItemPayloadError({ kind: "truncated", needed: size, available: value.length })
    if (value.length !== size) throw new ItemPayloadError({ kind: "overlong", expected: size, actual: value.length })
  }
} as const

// Swift's private `enum ByteWriter` of this file (`appendU16BigEndian`) is not ported: the codec
// uses DiagWire's `ByteWriter.u16be` (src/diag/wire/bytes.ts) instead.

/**
 * A Swift `Range<Int>`: the offsets `lowerBound ..< upperBound`. Decoders return ranges into the
 * bytes they were given and never copy them (IMPL-IT-6, IMPL-DA-5).
 */
export class ByteRange {
  constructor(
    readonly lowerBound: number,
    readonly upperBound: number
  ) {
    if (!(lowerBound <= upperBound)) throw new Error(`range requires lowerBound <= upperBound (${lowerBound} ..< ${upperBound})`)
  }

  /** The number of offsets in the range. */
  get count(): number {
    return this.upperBound - this.lowerBound
  }

  get isEmpty(): boolean {
    return this.lowerBound === this.upperBound
  }

  /** Whether `offset` lies in the range. */
  contains(offset: number): boolean {
    return offset >= this.lowerBound && offset < this.upperBound
  }

  /** A view of these bytes of `bytes` (no copy; Swift `span.extracting(range)`). */
  of(bytes: Uint8Array): Uint8Array {
    return bytes.subarray(this.lowerBound, this.upperBound)
  }

  /** The range moved by `delta`. */
  shifted(delta: number): ByteRange {
    return new ByteRange(this.lowerBound + delta, this.upperBound + delta)
  }

  toString(): string {
    return `${this.lowerBound} ..< ${this.upperBound}`
  }
}

/** `lowerBound ..< upperBound`. */
export const byteRange = (lowerBound: number, upperBound: number): ByteRange => new ByteRange(lowerBound, upperBound)

/** Swift `UInt8(exactly:)`: whether `value` is an integer in 0–255. */
export const isUInt8 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xff

/** Swift `UInt16(exactly:)`: whether `value` is an integer in 0–65 535. */
export const isUInt16 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xffff

/** Swift `UInt32(exactly:)`: whether `value` is an integer in 0–4 294 967 295. */
export const isUInt32 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xffffffff

/**
 * Swift's `Int.max` where a length computation overflows. JavaScript numbers are exact up to
 * 2^53 − 1, so that is the largest length the port represents.
 */
export const INT_MAX = Number.MAX_SAFE_INTEGER
