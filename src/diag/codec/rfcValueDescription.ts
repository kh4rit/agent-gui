// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/RFCValueDescription.swift (MIT).

// How a report describes a value of the server's control traffic without showing it: the rules of
// `diagctl decode --pcap --controls` (docs/capture.md, "What the summary shows"), shared with the
// session report's head items (docs/protocol/controls/transport.md IMPL-CT-11, issue #150). A short
// binary value shows in hex; a text only when it is a protocol identifier our specs name, too small
// to hold anything private (one character, one or two digits, a handle) or four digits in a release
// item `00 13` or `00 12`; a value of three or four bytes that may be an IPv4 address never shows,
// as text or as hex; spaces and zero bytes show as their count; everything else as its form, length
// and the kind of its characters (rfcText.ts).
//
// Swift's `String.count` counts characters; texts here are ASCII, so the port counts code points.

import { RFCCodePageDescriptor, RFCTextForm, RFCTextKind } from "./rfcText.js"

const isUpper = (c: string): boolean => c >= "A" && c <= "Z"
const isLower = (c: string): boolean => c >= "a" && c <= "z"
const isDigitCharacter = (c: string): boolean => c >= "0" && c <= "9" && c.length === 1

/**
 * The protocol identifiers a report may show when a value or a record holds exactly one of them.
 * Each is named in docs/protocol/controls: function, program, parameter, method, stream and table
 * names of rfc-tr.md §2 and §7, the automation verbs of §7.2, the RFC exceptions of transport.md
 * §2.3, and the control names of support-bits.md. None is a system's own name, and mock data never
 * uses them (D15).
 */
export const ControlNames = {
  allowlist: new Set([
    // rfc-tr.md §2, §7.1; transport.md §2.1
    "OLE_FLUSH_CALL",
    "SAPLOLEA",
    "SAPGUI_PROGRESS_INDICATOR",
    "XML_DATA_STREAM",
    "IMPORT_XML",
    "EXPORT_XML",
    "GUICORE_BLOB_DIAG_PARSER",
    "BLOB_DIAG_PARSER",
    "RFCBLOB_DIAG_PARSER",
    "STREAM",
    "MDS_CTRL_CONTROLLER",
    // data-provider.md §2 and §5; provenance: PV-1001, PV-1021
    "DP_GET_CLIENT_TABLE45A",
    "DP_PUT_CLIENT_TABLE45A",
    "INSUBTYPE",
    "INTREP",
    "INTYPE",
    "INURL",
    "DATE",
    "DESCRIPTION",
    "PLATTFORM",
    "SUBTYPE",
    "TIME",
    "TOTALSIZE",
    "TYPE",
    "DATAASC",
    "FORMAT",
    "PROPS",
    "ColPosID",
    "ColPosIDType",
    // rfc-tr.md §6, §7: ODG's stream names and the output slot
    "VERBS",
    "SVARS",
    "VARS",
    "_RESULT",
    // rfc-tr.md §7.2: the verbs ODG knows
    "CreateObject",
    "CreateControl",
    "CreateControl2",
    "SetProperty",
    "FreeObject",
    "GetContainer",
    "SetDataFromUrl",
    "InsertPacket",
    "GetTable",
    // transport.md §2.3: the RFC exceptions
    "SYSTEM_FAILURE",
    "COMMUNICATION_FAILURE",
    "RAISE_EXCEPTION",
    // datamanager.md, support-bits.md: control and capability names
    "DATAMANAGER",
    "SHELLID",
    "SHELLEVENT",
    "DATAREQUEST",
    "DATACHANGES",
    "TABLES",
    "NO_EASYACCESS",
    "IDA_ALV",
    "IDA_ALV_FRAGMENTS",
    "DPLOADONDEMAND",
    "DPLOADONDEMAND_WRITE",
    "DP_HTTP_PUT"
  ]) as ReadonlySet<string>,

  /**
   * The verbs ODG knows (rfc-tr.md §7.2): a stream of VERBS records holds at least one of them
   * before a report shows any other method name or a longer object id in it.
   */
  verbs: new Set([
    "CreateObject",
    "CreateControl",
    "CreateControl2",
    "SetProperty",
    "FreeObject",
    "GetContainer",
    "SetDataFromUrl",
    "InsertPacket",
    "GetTable"
  ]) as ReadonlySet<string>,

  /** Whether `text` is an identifier of the verb-name pattern `[A-Z][A-Za-z0-9_]{2,40}`. */
  isIdentifier(text: string): boolean {
    const scalars = Array.from(text)
    if (!(scalars.length >= 3 && scalars.length <= 41 && isUpper(scalars[0]))) return false // not-protocol: a name pattern
    return scalars.slice(1).every(c => isUpper(c) || isLower(c) || isDigitCharacter(c) || c === "_")
  },

  /**
   * Whether `text` reads as a method name of a control's automation interface: CamelCase letters
   * and digits (`CreateObject`, `SetProperty`), up to 40 characters, and not in the customer name
   * ranges (a leading Z or Y), which could name the owner's own classes.
   */
  isMethodName(text: string): boolean {
    const scalars = Array.from(text)
    if (!(scalars.length >= 3 && scalars.length <= 40 && scalars[0] >= "A" && scalars[0] <= "X" && isLower(scalars[1]))) return false // not-protocol: a name pattern
    return scalars.every(c => isUpper(c) || isLower(c) || isDigitCharacter(c))
  }
} as const

/** Where a value's zero bytes are (Swift `RFCValueShape.ZeroPattern`). */
export type RFCValueZeroPattern =
  /** A zero byte after every character: UTF-16LE-like. */
  | "littleEndian"
  /** A zero byte before every character: UTF-16BE-like. */
  | "bigEndian"
  /** Zero bytes only at the end. */
  | "padded"
  | "other"

/** The shape of a value's bytes, which decides how a report describes it. */
export type RFCValueShape =
  | { readonly kind: "empty" }
  /** Every byte is printable ASCII (0x20–0x7E). */
  | { readonly kind: "printable" }
  /** Printable ASCII once its zero bytes are left out: text in a two-byte encoding, or padded. */
  | { readonly kind: "textWithZeros"; readonly value: RFCValueZeroPattern }
  /** Bytes above 0x7E and no control byte: text in another character set, or binary. */
  | { readonly kind: "nonASCII" }
  /** Holds a control byte (0x01–0x1F, 0x7F) or only zero bytes. */
  | { readonly kind: "binary" }

export const RFCValueShape = {
  /** The shape of `bytes` (Swift `RFCValueShape(_:)`). */
  of(bytes: Uint8Array): RFCValueShape {
    if (bytes.length === 0) return { kind: "empty" }
    let zeros = 0
    let control = false
    let high = false
    for (const byte of bytes) {
      if (byte === 0) zeros += 1
      else if ((byte >= 0x01 && byte <= 0x1f) || byte === 0x7f) control = true // not-protocol: ASCII control characters
      else if (byte >= 0x80) high = true // not-protocol: bytes outside ASCII
    }
    if (control || zeros === bytes.length) return { kind: "binary" }
    if (high) return { kind: "nonASCII" }
    if (zeros === 0) return { kind: "printable" }
    switch (RFCTextForm.of(bytes)) {
      case "zeroPadded":
        return { kind: "textWithZeros", value: "padded" }
      case "utf16LittleEndian":
        return { kind: "textWithZeros", value: "littleEndian" }
      case "utf16BigEndian":
        return { kind: "textWithZeros", value: "bigEndian" }
      default:
        return { kind: "textWithZeros", value: "other" }
    }
  },

  /** The text of printable bytes, zero bytes left out and spaces trimmed at both ends. */
  text(bytes: Uint8Array): string {
    let text = ""
    for (const byte of bytes) if (byte !== 0) text += String.fromCharCode(byte)
    return RFCValueDescription.trimmed(text)
  }
} as const

/** How a report describes one value (docs/capture.md, "What the summary shows"). */
export const RFCValueDescription = {
  /** The largest value shown in hex. */
  hexLimit: 4, // not-protocol: the summary's privacy rule
  /**
   * The most digits a number the summary shows may have: a longer one may be a client, a count or
   * an id of the system. Exactly four digits show only in a release item (`releaseIDs`).
   */
  digitLimit: 2, // not-protocol: the summary's privacy rule
  /** The digits of a release, which a release item shows (`isFourDigits`, issue #150). */
  codeDigits: 4, // not-protocol: the summary's privacy rule
  /**
   * The release items: `00 13`, the kernel release, and `00 12`, the release, four characters each
   * (PV-0798). Only their values show when they are four digits; anywhere else four digits may be a
   * numeric user, a company code, a plant or a year, and stay withheld (issue #150).
   */
  releaseIDs: new Set([0x0013, 0x0012]) as ReadonlySet<number>, // provenance: PV-0798
  /** The longest handle shown: `O` and nine digits. */
  handleLimit: 10, // not-protocol: the summary's privacy rule
  /** The id of the code-page descriptor (PV-0797). */
  codePageDescriptorID: 0x0106, // provenance: PV-0797

  /**
   * The value in words: empty; spaces or zero bytes by their count; a short binary value in hex; a
   * text only when it is an allowlisted name, a small text (`isSmall`) or four digits in a release
   * item (`id` in `releaseIDs`); otherwise its kind and length and the kind of its characters. A
   * value of three or four bytes that may be an address (`mayBeAddress`) shows as neither text nor
   * kind, except in a release item. The value of a code-page descriptor `01 06` (`id`) is also read
   * as Reading R-CT-36 reads it.
   */
  describe(bytes: Uint8Array, id?: number): string {
    const shape = RFCValueShape.of(bytes)
    const limit = RFCValueDescription.hexLimit
    switch (shape.kind) {
      case "empty":
        return "empty"
      case "binary":
        if (bytes.every(byte => byte === 0)) return RFCValueDescription.count(bytes.length, "zero byte")
        if (bytes.length <= limit) return RFCValueDescription.hex(bytes)
        return "binary, " + RFCValueDescription.count(bytes.length, "byte") + RFCValueDescription.codePageReading(bytes, id)
      case "printable":
        if (bytes.every(byte => byte === 0x20)) return RFCValueDescription.count(bytes.length, "space") // not-protocol: a space
        // Printable text, padded or wide, is text at any length.
        return RFCValueDescription.text(bytes, shape, id)
      case "textWithZeros":
        // One printable byte among zero bytes reads as a small number as much as a text: in hex it
        // shows at most one character.
        if (bytes.length <= limit && bytes.filter(byte => byte !== 0).length === 1) return RFCValueDescription.hex(bytes)
        // Two characters and zero bytes are no number to show in hex.
        return RFCValueDescription.text(bytes, shape, id)
      case "nonASCII":
        if (bytes.length <= limit) return RFCValueDescription.hex(bytes)
        return "non-ASCII text or binary, " + RFCValueDescription.count(bytes.length, "byte") + RFCValueDescription.codePageReading(bytes, id)
    }
  },

  /** `; as R-CT-36 reads it: …` for a value of `01 06` in the descriptor's shape, else nothing. */
  codePageReading(bytes: Uint8Array, id: number | undefined): string {
    if (id !== RFCValueDescription.codePageDescriptorID) return ""
    const descriptor = RFCCodePageDescriptor.of(bytes)
    if (descriptor === undefined) return "; not a code-page descriptor as R-CT-36 reads one"
    return "; as R-CT-36 reads it: " + descriptor.summary
  },

  /** `1 byte`, `2 bytes`. */
  count(number: number, noun: string): string {
    return number === 1 ? `1 ${noun}` : `${number} ${noun}s`
  },

  /**
   * Whether `bytes` has three or four bytes and is no small number in either byte order (nor all bits
   * set): such a value may be an IPv4 address, which a report never shows, in hex, as text, or by
   * the kind of its characters.
   */
  mayBeAddress(bytes: Uint8Array): boolean {
    if (!(bytes.length > 2 && bytes.length <= RFCValueDescription.hexLimit)) return false // not-protocol: the summary's privacy rule
    let bigEndian = 0
    for (const byte of bytes) bigEndian = bigEndian * 256 + byte // not-protocol: byte assembly
    let littleEndian = 0
    for (let index = bytes.length - 1; index >= 0; index--) littleEndian = littleEndian * 256 + bytes[index] // not-protocol: byte assembly
    const small = Math.min(bigEndian, littleEndian) < 0x1_0000 // not-protocol: the summary's privacy rule
    return !small && !bytes.every(byte => byte === 0xff) // not-protocol: all bits set
  },

  /** A short binary value in hex, unless it may be an address (`mayBeAddress`). */
  hex(bytes: Uint8Array): string {
    if (RFCValueDescription.mayBeAddress(bytes)) return `binary, ${bytes.length} bytes, not shown (such a value may be an address)`
    return "hex " + Array.from(bytes, byte => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ") // not-protocol: two hex digits
  },

  /**
   * A text: shown only when it is an allowlisted name, four digits in a release item (`id` in
   * `releaseIDs`) or a small text; otherwise its kind and length, the kind of its characters, its
   * trailing spaces, and the allowlisted names among its words. A text of three or four bytes that
   * may be an address (`mayBeAddress`) shows by its kind and length only, unless it is an
   * allowlisted name or in a release item, which holds a text (PV-0798).
   */
  text(bytes: Uint8Array, shape: RFCValueShape, id?: number): string {
    let kind: string
    if (shape.kind === "textWithZeros") {
      switch (shape.value) {
        case "littleEndian":
          kind = "text with a zero byte after each character (UTF-16LE-like)"
          break
        case "bigEndian":
          kind = "text with a zero byte before each character (UTF-16BE-like)"
          break
        case "padded":
          kind = "text padded with zero bytes"
          break
        case "other":
          kind = "text with zero bytes"
          break
      }
    } else {
      kind = "text"
    }
    const text = RFCValueShape.text(bytes)
    if (text.length === 0) return `${kind}: spaces only, ` + RFCValueDescription.count(bytes.length, "byte")
    const release = id !== undefined && RFCValueDescription.releaseIDs.has(id)
    if (RFCValueDescription.isShown(text, new Set()) || (release && RFCValueDescription.isFourDigits(text)))
      return kind === "text" ? `"${text}"` : `"${text}" (${kind})`
    if (!release && RFCValueDescription.mayBeAddress(bytes))
      return `${kind}, ` + RFCValueDescription.count(bytes.length, "byte") + ", not shown (such a value may be an address)"
    if (RFCValueDescription.isSmall(text)) return kind === "text" ? `"${text}"` : `"${text}" (${kind})`
    const words = RFCValueDescription.names(text, new Set())
    const listed = words.length === 0 ? "" : "; names in it: " + words.join(", ")
    return `${kind}, ` + RFCValueDescription.count(bytes.length, "byte") + ", not shown; " + RFCValueDescription.characterKind(bytes) + listed
  },

  /** `kind: <the kind of the characters>` and the number of trailing space characters, if any. */
  characterKind(bytes: Uint8Array): string {
    const characters = Array.from(bytes).filter(byte => byte !== 0)
    let trailing = 0
    while (characters.length > 0 && characters[characters.length - 1] === 0x20) {
      // not-protocol: a space
      characters.pop()
      trailing += 1
    }
    while (characters.length > 0 && characters[0] === 0x20) characters.shift() // not-protocol: a space
    const kind = "kind: " + RFCTextKind.rawValue(RFCTextKind.of(characters))
    return trailing === 0 ? kind : kind + ", then " + RFCValueDescription.count(trailing, "space")
  },

  /** Whether `text` is a handle: `O` and one to nine digits (Reading R-CT-11). */
  isHandle(text: string): boolean {
    const characters = Array.from(text)
    return (
      characters.length >= 2 &&
      characters.length <= RFCValueDescription.handleLimit &&
      characters[0] === "O" &&
      characters.slice(1).every(isDigitCharacter)
    ) // not-protocol: O and a digit at least
  },

  /** Whether `text` is an integer of at most two digits, perhaps with a minus sign. */
  isSmallInteger(text: string): boolean {
    const digits = Array.from(text.startsWith("-") ? text.slice(1) : text)
    return digits.length >= 1 && digits.length <= RFCValueDescription.digitLimit && digits.every(isDigitCharacter)
  },

  /**
   * Whether `text` is exactly four digits, as a release is (PV-0798); a report shows such a text
   * only in a release item (`releaseIDs`, issue #150).
   */
  isFourDigits(text: string): boolean {
    const characters = Array.from(text)
    return characters.length === RFCValueDescription.codeDigits && characters.every(isDigitCharacter)
  },

  /**
   * Whether `text` is small enough to show whatever it is: one character, an integer of at most two
   * digits, or a handle. None of them can hold a user, a client, a host or a system ID, and each of
   * them matters for the grammar (a flag, a count, a handle reference).
   */
  isSmall(text: string): boolean {
    return Array.from(text).length === 1 || RFCValueDescription.isSmallInteger(text) || RFCValueDescription.isHandle(text)
  },

  /** Whether a text is a name a report may show. */
  isShown(text: string, names: ReadonlySet<string>): boolean {
    return ControlNames.allowlist.has(text) || names.has(text)
  },

  /** The shown names among the identifier-like words of `text`, each once, in order. */
  names(text: string, names: ReadonlySet<string>): string[] {
    const found: string[] = []
    for (const word of RFCValueDescription.words(text))
      if (RFCValueDescription.isShown(word, names) && !found.includes(word)) found.push(word)
    return found
  },

  /** The runs of letters, digits and underscores in `text`. */
  words(text: string): string[] {
    const words: string[] = []
    let current = ""
    for (const c of text) {
      if (isUpper(c) || isLower(c) || isDigitCharacter(c) || c === "_") {
        current += c
      } else if (current.length > 0) {
        words.push(current)
        current = ""
      }
    }
    if (current.length > 0) words.push(current)
    return words
  },

  /** Whether `character` is one of the ASCII digits. */
  isDigit(character: string): boolean {
    return isDigitCharacter(character)
  },

  /** `text` without spaces at either end. */
  trimmed(text: string): string {
    let start = 0
    let end = text.length
    while (start < end && text[start] === " ") start += 1
    while (end > start && text[end - 1] === " ") end -= 1
    return text.slice(start, end)
  }
} as const
