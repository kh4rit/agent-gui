// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/CodePageText.swift (MIT).

// Code pages (docs/protocol/session.md §6.3, §6.4): the SAP code-page numbers Swooey knows, the
// character set each denotes, and text decoding and encoding in them. A session's texts are in the
// code page the server declares in ST_R3INFO CODEPAGE_DIAG_GUI; before that declaration, in the
// one the client requested in CONNECT (Reading R-SE-9). Which number is in force is the caller's to
// track (ScreenModel does); this file only maps a number to a character set.
//
// Strict decoding never repairs, and the repairing variant is a separate call so that a caller
// counts what it repaired. Swift's `String` validation and repair are replicated here: UTF-8
// through a decoder that follows the Unicode "maximal subpart" practice (as Swift's and the WHATWG
// decoders do), UTF-16 and ISO 8859-1 by hand (the WHATWG "latin1" label is windows-1252, which
// maps 0x80–0x9F differently). A byte-order mark is never stripped: Swift keeps U+FEFF as text.

import type { ByteWriter } from "../wire/index.js"
import { Secret } from "./secret.js"

/** The SAP code-page numbers Swooey knows (session.md §6.4). CONNECT carries the one the client requests (§3.2) and CODEPAGE_DIAG_GUI the one the server declares (§6.1). */
export const CodePage = {
  /** UTF-8 (PV-0130), the number a Unicode system declared in CODEPAGE_DIAG_GUI (§6.3). */
  utf8: 4110, // provenance: PV-0130
  /** UTF-16 big-endian (PV-0132). */
  utf16BigEndian: 4102, // provenance: PV-0132
  /** UTF-16 little-endian (PV-0133). */
  utf16LittleEndian: 4103, // provenance: PV-0133
  /**
   * SAP's code page comparable to ISO 8859-1 (PV-0134); the reference client requests it in
   * CONNECT (PV-0131).
   */
  latin1: 1100, // provenance: PV-0131, PV-0134

  /**
   * Whether every byte is ASCII (below 0x80), so that the text reads the same in every
   * ASCII-compatible code page, a code page Swooey does not know included (session.md §6.4).
   */
  isASCII(bytes: Uint8Array): boolean {
    for (let index = 0; index < bytes.length; index++) if (bytes[index] >= 0x80) return false // not-protocol: the first non-ASCII byte value
    return true
  }
} as const

/**
 * The character set of a code page Swooey knows (session.md §6.4).
 * - `utf8`: code page 4110 (PV-0130).
 * - `utf16BigEndian`: code page 4102 (PV-0132): UTF-16, most significant byte first.
 * - `utf16LittleEndian`: code page 4103 (PV-0133): UTF-16, least significant byte first.
 * - `latin1`: code page 1100 (PV-0134), SAP's code page comparable to ISO 8859-1: each byte is the
 *   Unicode scalar of the same value. Also the stand-in for a code page Swooey does not know, which
 *   the caller must say it is (session.md §6.4).
 */
export type TextEncoding = "utf8" | "utf16BigEndian" | "utf16LittleEndian" | "latin1"

const REPLACEMENT = 0xfffd

export const TextEncoding = {
  allCases: ["utf8", "utf16BigEndian", "utf16LittleEndian", "latin1"] as readonly TextEncoding[],

  /** The encoding of a code-page number, or undefined for a number Swooey does not know. */
  fromCodePage(codePage: number): TextEncoding | undefined {
    switch (codePage) {
      case CodePage.utf8:
        return "utf8"
      case CodePage.utf16BigEndian:
        return "utf16BigEndian"
      case CodePage.utf16LittleEndian:
        return "utf16LittleEndian"
      case CodePage.latin1:
        return "latin1"
      default:
        return undefined
    }
  },

  /** The code-page number that denotes this encoding. */
  codePage(encoding: TextEncoding): number {
    switch (encoding) {
      case "utf8":
        return CodePage.utf8
      case "utf16BigEndian":
        return CodePage.utf16BigEndian
      case "utf16LittleEndian":
        return CodePage.utf16LittleEndian
      case "latin1":
        return CodePage.latin1
    }
  },

  /** `UTF-8`, `UTF-16BE`, `UTF-16LE` or `ISO 8859-1` (Swift `description`). */
  description(encoding: TextEncoding): string {
    switch (encoding) {
      case "utf8":
        return "UTF-8"
      case "utf16BigEndian":
        return "UTF-16BE"
      case "utf16LittleEndian":
        return "UTF-16LE"
      case "latin1":
        return "ISO 8859-1"
    }
  },

  /** Whether ASCII text has the same bytes in this encoding as in ASCII: UTF-8 and ISO 8859-1. */
  isASCIICompatible(encoding: TextEncoding): boolean {
    return encoding === "utf8" || encoding === "latin1"
  },

  // MARK: Decoding

  /**
   * `bytes` as text, or undefined when they are not valid in this encoding: invalid UTF-8, an odd
   * number of UTF-16 bytes or an unpaired surrogate. ISO 8859-1 accepts every byte. Nothing is
   * repaired.
   */
  decode(encoding: TextEncoding, bytes: Uint8Array): string | undefined {
    switch (encoding) {
      case "utf8": {
        const decoded = decodeUTF8(bytes)
        return decoded.errors === 0 ? scalarsToString(decoded.scalars) : undefined
      }
      case "utf16BigEndian":
      case "utf16LittleEndian": {
        if (bytes.length % 2 !== 0) return undefined // not-protocol: two bytes per UTF-16 code unit
        const decoded = decodeUTF16(codeUnits(bytes, encoding === "utf16BigEndian"))
        return decoded.errors === 0 ? scalarsToString(decoded.scalars) : undefined
      }
      case "latin1":
        return latin1(bytes)
    }
  },

  /**
   * `bytes` as text, with U+FFFD for every invalid sequence and for a last odd UTF-16 byte. For a
   * caller that shows the text anyway and counts the repair.
   */
  decodeRepairing(encoding: TextEncoding, bytes: Uint8Array): string {
    switch (encoding) {
      case "utf8":
        return scalarsToString(decodeUTF8(bytes).scalars)
      case "utf16BigEndian":
      case "utf16LittleEndian": {
        const scalars = decodeUTF16(codeUnits(bytes, encoding === "utf16BigEndian")).scalars
        if (bytes.length % 2 !== 0) scalars.push(REPLACEMENT) // not-protocol: two bytes per UTF-16 code unit
        return scalarsToString(scalars)
      }
      case "latin1":
        return latin1(bytes)
    }
  },

  // MARK: Encoding

  /**
   * `text` in this encoding, or undefined when a character cannot be represented: in ISO 8859-1,
   * anything above U+00FF. UTF-8 and UTF-16 represent every string.
   */
  encode(encoding: TextEncoding, text: string): Uint8Array | undefined {
    switch (encoding) {
      case "utf8":
        return new TextEncoder().encode(text)
      case "utf16BigEndian":
      case "utf16LittleEndian": {
        const output = new Uint8Array(text.length * 2) // not-protocol: two bytes per UTF-16 code unit
        let written = 0
        const emit = (byte: number) => {
          output[written++] = byte
        }
        for (let index = 0; index < text.length; index++) putUnit(text.charCodeAt(index), encoding === "utf16BigEndian", emit)
        return output
      }
      case "latin1": {
        const bytes: number[] = []
        for (const character of text) {
          const scalar = character.codePointAt(0)!
          if (scalar > 0xff) return undefined
          bytes.push(scalar)
        }
        return Uint8Array.from(bytes)
      }
    }
  },

  /**
   * Appends the UTF-8 text `utf8` to `output` in this encoding without making a `string` of it, for
   * a password (`secretTranscoded`). Returns false, leaving what was appended so far for the caller
   * to wipe, when `utf8` is not valid UTF-8 or holds a character this encoding cannot represent.
   */
  transcode(encoding: TextEncoding, utf8: Uint8Array, output: ByteWriter): boolean {
    return transcodeUTF8(encoding, utf8, byte => {
      output.u8(byte)
    })
  }
} as const

/**
 * Transcodes UTF-8 to `encoding`, byte by byte through `emit`, stopping at the first invalid UTF-8
 * sequence (Swift `transcode(_:from:to:stoppingOnError: true)`). ISO 8859-1 goes on past a
 * character it cannot represent but appends nothing from there on.
 */
function transcodeUTF8(encoding: TextEncoding, utf8: Uint8Array, emit: (byte: number) => void): boolean {
  let representable = true
  let failed = false
  scanUTF8(utf8, scalar => {
    if (scalar === undefined) {
      failed = true
      return false
    }
    switch (encoding) {
      case "utf8":
        // UTF-8 to UTF-8 validates the bytes as it copies them.
        encodeScalarUTF8(scalar, emit)
        break
      case "utf16BigEndian":
      case "utf16LittleEndian": {
        const bigEndian = encoding === "utf16BigEndian"
        if (scalar >= 0x10000) {
          const value = scalar - 0x10000
          putUnit(0xd800 | (value >> 10), bigEndian, emit) // not-protocol: UTF-16 surrogate pair
          putUnit(0xdc00 | (value & 0x3ff), bigEndian, emit) // not-protocol: UTF-16 surrogate pair
        } else {
          putUnit(scalar, bigEndian, emit)
        }
        break
      }
      case "latin1":
        if (!representable || scalar > 0xff) {
          representable = false
          break
        }
        emit(scalar)
        break
    }
    return true
  })
  return !failed && representable
}

/** Writes one UTF-16 code unit in the byte order. */
function putUnit(unit: number, bigEndian: boolean, emit: (byte: number) => void): void {
  const high = (unit >> 8) & 0xff // not-protocol: byte assembly
  const low = unit & 0xff
  if (bigEndian) {
    emit(high)
    emit(low)
  } else {
    emit(low)
    emit(high)
  }
}

function encodeScalarUTF8(scalar: number, emit: (byte: number) => void): void {
  if (scalar < 0x80) {
    emit(scalar)
  } else if (scalar < 0x800) {
    emit(0xc0 | (scalar >> 6))
    emit(0x80 | (scalar & 0x3f))
  } else if (scalar < 0x10000) {
    emit(0xe0 | (scalar >> 12))
    emit(0x80 | ((scalar >> 6) & 0x3f))
    emit(0x80 | (scalar & 0x3f))
  } else {
    emit(0xf0 | (scalar >> 18))
    emit(0x80 | ((scalar >> 12) & 0x3f))
    emit(0x80 | ((scalar >> 6) & 0x3f))
    emit(0x80 | (scalar & 0x3f))
  }
}

/**
 * Walks UTF-8 bytes scalar by scalar: `visit` gets each scalar, or undefined for each ill-formed
 * sequence (one per maximal subpart, Unicode §3.9 and the WHATWG decoder; Swift's `UTF8` parser
 * reports the same). Returning false from `visit` stops the walk.
 */
export function scanUTF8(bytes: Uint8Array, visit: (scalar: number | undefined) => boolean): void {
  let needed = 0
  let seen = 0
  let lower = 0x80
  let upper = 0xbf
  let scalar = 0
  let index = 0
  while (index < bytes.length) {
    const byte = bytes[index]
    if (needed === 0) {
      index += 1
      if (byte <= 0x7f) {
        if (!visit(byte)) return
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1
        scalar = byte & 0x1f
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0
        if (byte === 0xed) upper = 0x9f
        needed = 2
        scalar = byte & 0x0f
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90
        if (byte === 0xf4) upper = 0x8f
        needed = 3
        scalar = byte & 0x07
      } else if (!visit(undefined)) {
        return
      }
      continue
    }
    if (byte < lower || byte > upper) {
      // The sequence ends before this byte, which starts the next one.
      needed = 0
      seen = 0
      lower = 0x80
      upper = 0xbf
      if (!visit(undefined)) return
      continue
    }
    index += 1
    lower = 0x80
    upper = 0xbf
    scalar = (scalar << 6) | (byte & 0x3f)
    seen += 1
    if (seen === needed) {
      needed = 0
      seen = 0
      if (!visit(scalar)) return
    }
  }
  if (needed !== 0) visit(undefined)
}

/** The scalars of UTF-8 bytes, U+FFFD for each ill-formed sequence, and the number of those. */
export function decodeUTF8(bytes: Uint8Array): { scalars: number[]; errors: number } {
  const scalars: number[] = []
  let errors = 0
  scanUTF8(bytes, scalar => {
    if (scalar === undefined) {
      errors += 1
      scalars.push(REPLACEMENT)
    } else {
      scalars.push(scalar)
    }
    return true
  })
  return { scalars, errors }
}

/** The scalars of UTF-16 code units, U+FFFD for each unpaired surrogate, and the number of those. */
export function decodeUTF16(units: readonly number[]): { scalars: number[]; errors: number } {
  const scalars: number[] = []
  let errors = 0
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < units.length && units[index + 1] >= 0xdc00 && units[index + 1] <= 0xdfff) {
      scalars.push(0x10000 + ((unit - 0xd800) << 10) + (units[index + 1] - 0xdc00)) // not-protocol: UTF-16 surrogate pair
      index += 1
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      errors += 1
      scalars.push(REPLACEMENT)
    } else {
      scalars.push(unit)
    }
  }
  return { scalars, errors }
}

/** The UTF-16 code units of `bytes` in this byte order; a last odd byte is left out. */
export function codeUnits(bytes: Uint8Array, bigEndian: boolean): number[] {
  const count = Math.floor(bytes.length / 2) // not-protocol: two bytes per UTF-16 code unit
  const units: number[] = new Array(count)
  for (let unit = 0; unit < count; unit++) {
    const first = bytes[2 * unit] // not-protocol: two bytes per UTF-16 code unit
    const second = bytes[2 * unit + 1] // not-protocol: two bytes per UTF-16 code unit
    units[unit] = bigEndian ? (first << 8) | second : (second << 8) | first // not-protocol: byte assembly
  }
  return units
}

/** A string of Unicode scalars. */
export function scalarsToString(scalars: readonly number[]): string {
  let text = ""
  const chunk = 4096
  for (let start = 0; start < scalars.length; start += chunk) text += String.fromCodePoint(...scalars.slice(start, start + chunk))
  return text
}

function latin1(bytes: Uint8Array): string {
  let text = ""
  for (let index = 0; index < bytes.length; index++) text += String.fromCharCode(bytes[index])
  return text
}

/**
 * This secret's bytes, read as UTF-8, in `encoding`, as a new secret; undefined when they are not
 * valid UTF-8 or hold a character `encoding` cannot represent. No `string` of the password is
 * made, and the buffer in between is wiped either way. (Swift: `extension Secret`,
 * `secret.transcoded(fromUTF8To:)`.)
 */
export function secretTranscoded(secret: Secret, encoding: TextEncoding): Secret | undefined {
  // Room for the longest result (UTF-16 of one-byte characters), so that the buffer is never
  // reallocated and no unwiped copy is left behind.
  let buffer = new Uint8Array(0)
  let written = 0
  const transcoded = secret.withBytes(bytes => {
    buffer = new Uint8Array(bytes.length * 2) // not-protocol: two bytes per UTF-16 code unit
    return transcodeUTF8(encoding, bytes, byte => {
      buffer[written] = byte
      written += 1
    })
  })
  const result = Secret.wiping(buffer.subarray(0, written))
  buffer.fill(0)
  if (!transcoded) {
    result.dispose()
    return undefined
  }
  return result
}
