// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/RFCText.swift (MIT).

// The texts of an RFC item stream (docs/protocol/controls/rfc-tr.md §7.8, issue #150): the
// encodings a call's texts travel in (Reading R-CT-37), the form a text has on the wire, the kind of
// a text a report does not show, and the code-page descriptor `01 06` as Reading R-CT-36 reads it.
// Nothing here keeps or prints a text: the session report and diagctl's controls summary use these
// to say what a value is without showing it (IMPL-CT-11, docs/capture.md).

import { ByteWriter } from "../wire/index.js"
import type { ByteRange } from "./diagCodec.js"

/** The space character, as rfcEncoding.ts's `RFCTableContentEncoder.space` (PV-0934). */
const SPACE = 0x20 // provenance: PV-0934

/**
 * How the texts of an RFC item stream travel (Reading R-CT-37): one byte per character, as the
 * server sent its first calls, or UTF-16 of either byte order, two bytes per character (PV-0799).
 * Item lengths and table widths count bytes in all three; binary items are the same in all three.
 * `RFCTextEncoding.rawValue` gives Swift's raw values (`single-byte`, `UTF-16LE`, `UTF-16BE`).
 */
export type RFCTextEncoding = "singleByte" | "utf16LittleEndian" | "utf16BigEndian"

export const RFCTextEncoding = {
  /** Every case, in declaration order (Swift `CaseIterable`). */
  allCases: ["singleByte", "utf16LittleEndian", "utf16BigEndian"] as readonly RFCTextEncoding[],

  /** `single-byte`, `UTF-16LE` or `UTF-16BE`. */
  rawValue(encoding: RFCTextEncoding): string {
    switch (encoding) {
      case "singleByte":
        return "single-byte"
      case "utf16LittleEndian":
        return "UTF-16LE"
      case "utf16BigEndian":
        return "UTF-16BE"
    }
  },

  /** Bytes per character (PV-0799). */
  bytesPerCharacter(encoding: RFCTextEncoding): number {
    return encoding === "singleByte" ? 1 : 2 // provenance: PV-0799
  },

  /**
   * The byte a code unit that is no ASCII character narrows to (`narrow`): no pattern of a record
   * matches it, as no pattern matches a byte above 0x7F in a single-byte record.
   */
  nonASCII: 0xff, // not-protocol: a marker byte

  /** Appends the ASCII bytes `text`, one character each, in this encoding. */
  append(encoding: RFCTextEncoding, text: ArrayLike<number>, output: ByteWriter): void {
    switch (encoding) {
      case "singleByte":
        output.bytes(text)
        return
      case "utf16LittleEndian":
        for (let index = 0; index < text.length; index++) {
          output.u8(text[index])
          output.u8(0)
        }
        return
      case "utf16BigEndian":
        for (let index = 0; index < text.length; index++) {
          output.u8(0)
          output.u8(text[index])
        }
        return
    }
  },

  /** The ASCII bytes `text` in this encoding (an owned copy). */
  encode(encoding: RFCTextEncoding, text: ArrayLike<number>): Uint8Array {
    if (encoding === "singleByte") return Uint8Array.from(text)
    const output = new ByteWriter(text.length * RFCTextEncoding.bytesPerCharacter(encoding))
    RFCTextEncoding.append(encoding, text, output)
    return output.toBytes()
  },

  /** Appends `count` space characters. */
  appendSpaces(encoding: RFCTextEncoding, count: number, output: ByteWriter): void {
    if (!(count > 0)) return
    RFCTextEncoding.append(encoding, new Uint8Array(count).fill(SPACE), output)
  },

  /**
   * The character at code-unit `index` of `bytes` (in bytes, `index × bytesPerCharacter`): its
   * ASCII byte, or `nonASCII` for a code unit above 0x7F.
   */
  character(encoding: RFCTextEncoding, bytes: Uint8Array, index: number): number {
    switch (encoding) {
      case "singleByte":
        return bytes[index]
      case "utf16LittleEndian": {
        const low = bytes[2 * index] // not-protocol: a code unit's two bytes
        const high = bytes[2 * index + 1] // not-protocol: a code unit's two bytes
        return high === 0 && low < 0x80 ? low : RFCTextEncoding.nonASCII // not-protocol: ASCII range
      }
      case "utf16BigEndian": {
        const high = bytes[2 * index] // not-protocol: a code unit's two bytes
        const low = bytes[2 * index + 1] // not-protocol: a code unit's two bytes
        return high === 0 && low < 0x80 ? low : RFCTextEncoding.nonASCII // not-protocol: ASCII range
      }
    }
  },

  /**
   * The characters of `bytes`, one byte each (`character`); a byte after the last whole code unit is
   * left out. Single-byte text comes back unchanged (as a copy).
   */
  narrow(encoding: RFCTextEncoding, bytes: Uint8Array): Uint8Array {
    const count = Math.floor(bytes.length / RFCTextEncoding.bytesPerCharacter(encoding))
    const characters = new Uint8Array(count)
    for (let index = 0; index < count; index++) characters[index] = RFCTextEncoding.character(encoding, bytes, index)
    return characters
  },

  /**
   * Whether the bytes of `stream` at `range` are the ASCII `text` in this encoding, followed only by
   * padding: space characters or zero characters (Reading R-CT-37).
   */
  matches(encoding: RFCTextEncoding, stream: Uint8Array, range: ByteRange, text: ArrayLike<number>): boolean {
    const width = RFCTextEncoding.bytesPerCharacter(encoding)
    if (!(range.count >= text.length * width && range.count % width === 0)) return false
    const characters = range.of(stream)
    for (let index = 0; index < text.length; index++) {
      if (RFCTextEncoding.character(encoding, characters, index) !== text[index]) return false
    }
    for (let index = text.length; index < range.count / width; index++) {
      // A padding character: a space or a zero, both in the ASCII range.
      const padding = RFCTextEncoding.character(encoding, characters, index)
      if (!(padding === SPACE || padding === 0)) return false
    }
    return true
  },

  /**
   * The encoding in which the bytes of `stream` at `range` are `text`, padding allowed (`matches`),
   * trying single-byte first; undefined when none.
   */
  reading(stream: Uint8Array, range: ByteRange, text: ArrayLike<number>): RFCTextEncoding | undefined {
    return RFCTextEncoding.allCases.find(encoding => RFCTextEncoding.matches(encoding, stream, range, text))
  }
} as const

/**
 * The form a text has on the wire (the report's diagnostics, issue #150): single-byte ASCII,
 * ASCII padded with zero bytes, UTF-16 of either byte order, or zero bytes elsewhere. Only for
 * values whose other bytes are printable ASCII; any other value is no text.
 * `RFCTextForm.rawValue` gives Swift's raw values.
 */
export type RFCTextForm = "ascii" | "zeroPadded" | "utf16LittleEndian" | "utf16BigEndian" | "otherZeros"

export const RFCTextForm = {
  /** `ASCII`, `zero-padded`, `UTF-16LE`, `UTF-16BE` or `zero bytes inside`. */
  rawValue(form: RFCTextForm): string {
    switch (form) {
      case "ascii":
        return "ASCII"
      case "zeroPadded":
        return "zero-padded"
      case "utf16LittleEndian":
        return "UTF-16LE"
      case "utf16BigEndian":
        return "UTF-16BE"
      case "otherZeros":
        return "zero bytes inside"
    }
  },

  /**
   * The form of `bytes` (Swift `RFCTextForm(_:)`), or undefined when they are empty, all zero, or
   * hold a byte that is neither zero nor printable ASCII.
   */
  of(bytes: Uint8Array): RFCTextForm | undefined {
    let zeros = 0
    let lastText = -1
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]
      if (byte === 0) {
        zeros += 1
      } else if (byte >= 0x20 && byte < 0x7f) {
        // not-protocol: printable ASCII
        lastText = index
      } else {
        return undefined
      }
    }
    if (lastText < 0) return undefined
    if (zeros === 0) return "ascii"
    // The bytes up to the last character: zero bytes after it are padding.
    const end = lastText + 1
    let innerZeros = 0
    for (let index = 0; index < end; index++) if (bytes[index] === 0) innerZeros += 1
    if (innerZeros === 0) return "zeroPadded"
    const pairs = (zeroFirst: boolean): boolean => {
      // Code units up to the last character; a unit whose second byte lies past it is whole when
      // that byte is zero, which it is, or the bytes end.
      let index = 0
      while (index < end) {
        const first = bytes[index]
        const second = index + 1 < bytes.length ? bytes[index + 1] : 0
        if (zeroFirst ? first !== 0 || second === 0 : first === 0 || second !== 0) return false
        index += 2 // not-protocol: a code unit's two bytes
      }
      return true
    }
    if (pairs(false)) return "utf16LittleEndian"
    if (pairs(true)) return "utf16BigEndian"
    return "otherZeros"
  },

  /** The encoding a text of this form is in; undefined for `otherZeros`. */
  encoding(form: RFCTextForm): RFCTextEncoding | undefined {
    switch (form) {
      case "ascii":
      case "zeroPadded":
        return "singleByte"
      case "utf16LittleEndian":
        return "utf16LittleEndian"
      case "utf16BigEndian":
        return "utf16BigEndian"
      case "otherZeros":
        return undefined
    }
  },

  /** The text's characters without its zero bytes. */
  characters(bytes: Uint8Array): Uint8Array {
    return bytes.filter(byte => byte !== 0)
  }
} as const

/**
 * What a text a report does not show looks like (issue #150): its kind only, never a character.
 * A client number is `digits`, an address `dotted IPv4 shape`, a host name `host-name shape`, a
 * system ID or a user `upper-case word`; the kinds say which of them a head item may be.
 * `RFCTextKind.rawValue` gives Swift's raw values.
 */
export type RFCTextKind = "digits" | "dottedIPv4" | "upperCaseWord" | "hostName" | "mixed"

const isDigitByte = (byte: number): boolean => byte >= 0x30 && byte <= 0x39 // not-protocol: ASCII "0"–"9"
const isUpperByte = (byte: number): boolean => byte >= 0x41 && byte <= 0x5a // not-protocol: ASCII "A"–"Z"
const isLowerByte = (byte: number): boolean => byte >= 0x61 && byte <= 0x7a // not-protocol: ASCII "a"–"z"
const DOT = 0x2e // not-protocol: "."
const HYPHEN = 0x2d // not-protocol: "-"
const UNDERSCORE = 0x5f // not-protocol: "_"

export const RFCTextKind = {
  /** `digits`, `dotted IPv4 shape`, `upper-case word`, `host-name shape` or `mixed`. */
  rawValue(kind: RFCTextKind): string {
    switch (kind) {
      case "digits":
        return "digits"
      case "dottedIPv4":
        return "dotted IPv4 shape"
      case "upperCaseWord":
        return "upper-case word"
      case "hostName":
        return "host-name shape"
      case "mixed":
        return "mixed"
    }
  },

  /**
   * The kind of `characters` (Swift `RFCTextKind(_:)`), a text without its padding: all digits;
   * four groups of one to three digits joined by dots; an upper-case letter followed by upper-case
   * letters, digits and underscores; letters, digits, dots and hyphens with at least one letter;
   * anything else.
   */
  of(characters: ArrayLike<number>): RFCTextKind {
    const all = Array.from(characters)
    if (all.length > 0 && all.every(isDigitByte)) return "digits"
    // An IPv4 address: four groups of one to three digits.
    const groups: number[][] = [[]]
    for (const byte of all) {
      if (byte === DOT) groups.push([])
      else groups[groups.length - 1].push(byte)
    }
    if (groups.length === 4 && groups.every(group => group.length >= 1 && group.length <= 3 && group.every(isDigitByte)))
      // not-protocol: dotted quad
      return "dottedIPv4"
    if (all.length > 0 && isUpperByte(all[0]) && all.every(byte => isUpperByte(byte) || isDigitByte(byte) || byte === UNDERSCORE))
      return "upperCaseWord"
    if (
      all.some(byte => isUpperByte(byte) || isLowerByte(byte)) &&
      all.every(byte => isUpperByte(byte) || isLowerByte(byte) || isDigitByte(byte) || byte === DOT || byte === HYPHEN)
    )
      return "hostName"
    return "mixed"
  }
} as const

/**
 * The code-page descriptor `01 06` as Reading R-CT-36 reads its 11 bytes (PV-0797): bytes 0–3 the
 * code page's four decimal digits, one digit per byte (as digit values 0–9, or as the ASCII
 * digits), bytes 4 and 5 not known, byte 6 the bytes per character (1 or 2), bytes 7–10 a u32 BE
 * whose value is a printable ASCII character, the replacement character. A value of another shape
 * is no descriptor Swooey reads.
 */
export class RFCCodePageDescriptor {
  /** The descriptor's length (PV-0797, PV-0921, PV-0929). */
  static readonly length = 11 // provenance: PV-0797, PV-0921
  static readonly digits = 4 // provenance: PV-0797
  static readonly bytesPerCharacterOffset = 6 // provenance: PV-0797
  static readonly replacementOffset = 7 // provenance: PV-0797

  private constructor(
    /** The code page the digits spell. */
    readonly codePage: number,
    /** Whether the digits are ASCII characters rather than digit values. */
    readonly asciiDigits: boolean,
    /** Bytes 4 and 5, whose meaning is not known. */
    readonly unknown: Uint8Array,
    readonly bytesPerCharacter: number,
    /** The replacement character. */
    readonly replacement: number
  ) {}

  /** Reads `value` (Swift `RFCCodePageDescriptor(_:)`); undefined for a value of another shape. */
  static of(value: Uint8Array): RFCCodePageDescriptor | undefined {
    if (value.length !== RFCCodePageDescriptor.length) return undefined
    const first = value[0]
    const ascii = isDigitByte(first)
    const base = ascii ? 0x30 : 0 // not-protocol: ASCII "0"
    let codePage = 0
    for (let index = 0; index < RFCCodePageDescriptor.digits; index++) {
      const digit = (value[index] - base) & 0xff
      if (!(digit <= 9)) return undefined // not-protocol: a decimal digit
      codePage = codePage * 10 + digit // not-protocol: decimal digits
    }
    const width = value[RFCCodePageDescriptor.bytesPerCharacterOffset]
    if (!(width === 1 || width === RFCTextEncoding.bytesPerCharacter("utf16LittleEndian"))) return undefined
    const replacement = value[RFCCodePageDescriptor.length - 1]
    for (let index = RFCCodePageDescriptor.replacementOffset; index < RFCCodePageDescriptor.length - 1; index++) {
      if (value[index] !== 0) return undefined
    }
    if (!(replacement >= 0x20 && replacement < 0x7f)) return undefined // not-protocol: printable ASCII
    return new RFCCodePageDescriptor(codePage, ascii, Uint8Array.of(value[4], value[5]), width, replacement) // provenance: PV-0797
  }

  /**
   * `value` (a descriptor of this shape) with its digits spelling `codePage` in the same digit form
   * and byte 6 set to `bytesPerCharacter`: Swooey's own descriptor (Reading R-CT-36). Undefined
   * when `codePage` has more than four digits.
   */
  static replacing(value: Uint8Array, codePage: number, bytesPerCharacter: number): Uint8Array | undefined {
    const descriptor = RFCCodePageDescriptor.of(value)
    if (descriptor === undefined || !(codePage >= 0 && codePage <= 9999)) return undefined // not-protocol: four digits
    const bytes = value.slice(0, RFCCodePageDescriptor.length)
    let rest = codePage
    for (let index = RFCCodePageDescriptor.digits - 1; index >= 0; index--) {
      bytes[index] = (rest % 10) + (descriptor.asciiDigits ? 0x30 : 0) // not-protocol: decimal digits
      rest = Math.floor(rest / 10) // not-protocol: decimal digits
    }
    bytes[RFCCodePageDescriptor.bytesPerCharacterOffset] = bytesPerCharacter & 0xff
    return bytes
  }

  /**
   * The descriptor in words: the code page, bytes per character, the replacement character and the
   * two unknown bytes in hex. None of them names a system.
   */
  get summary(): string {
    const hex = Array.from(this.unknown, byte => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ") // not-protocol: two hex digits
    return (
      `code page ${this.codePage}${this.asciiDigits ? " (ASCII digits)" : ""}, ${this.bytesPerCharacter} byte(s) per character, ` +
      `replacement character "${String.fromCharCode(this.replacement)}", bytes 4-5 hex ${hex}`
    )
  }
}
