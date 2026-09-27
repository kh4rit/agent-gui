// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCompression/HuffmanDecodeTable.swift (MIT).

import { LZHFormat } from "./lzhFormat.js"

/**
 * Layout of one decode-table entry (a u32 in a `Uint32Array`). Implementation choice, not
 * protocol:
 *
 * | Bits  | Field |
 * |-------|-------|
 * | 0–3   | code length in bits (full length, also in subtables) |
 * | 4–7   | kind (`literal`, `length`, …) |
 * | 8–11  | extra-bit count (length, distance) or subtable index width (link) |
 * | 16–31 | value: literal byte, base length, base distance, symbol, or subtable offset |
 */
export const TableEntry = {
  lengthMask: 0xf, // not-protocol: entry layout
  kindShift: 4, // not-protocol: entry layout
  kindMask: 0xf, // not-protocol: entry layout
  auxShift: 8, // not-protocol: entry layout
  auxMask: 0xf, // not-protocol: entry layout
  valueShift: 16, // not-protocol: entry layout

  // Kinds.
  literal: 0,
  length: 1,
  endOfBlock: 2, // not-protocol: entry kind
  distance: 3, // not-protocol: entry kind
  /** A position of a fixed code that is no symbol of the alphabet (286, 287; 30, 31). */
  invalid: 4, // not-protocol: entry kind
  /** A primary entry that points at a subtable. */
  link: 5, // not-protocol: entry kind
  /** A code-length symbol; the value is the symbol. */
  plain: 6, // not-protocol: entry kind

  make(kind: number, codeLength: number, aux: number, value: number): number {
    return ((codeLength & 0xf) | (kind << 4) | ((aux & 0xf) << 8) | ((value & 0xffff) << 16)) >>> 0 // not-protocol: entry layout
  },

  codeLength(entry: number): number {
    return entry & 0xf // not-protocol: entry layout
  },

  kind(entry: number): number {
    return (entry >>> 4) & 0xf // not-protocol: entry layout
  },

  aux(entry: number): number {
    return (entry >>> 8) & 0xf // not-protocol: entry layout
  },

  value(entry: number): number {
    return entry >>> 16 // not-protocol: entry layout
  }
} as const

/** The three alphabets a table can decode; they differ only in what an entry carries. */
export type HuffmanAlphabet = "literalLength" | "distance" | "codeLength"

/** Kind, extra-bit count and value of the entry for `symbol`, packed as an entry of code length 0. */
function payload(alphabet: HuffmanAlphabet, symbol: number): number {
  switch (alphabet) {
    case "literalLength":
      if (symbol < LZHFormat.literalCount) return TableEntry.make(TableEntry.literal, 0, 0, symbol)
      if (symbol === LZHFormat.endOfBlock) return TableEntry.make(TableEntry.endOfBlock, 0, 0, symbol)
      if (symbol < LZHFormat.literalLengthCount) {
        const index = symbol - LZHFormat.firstLengthSymbol
        return TableEntry.make(TableEntry.length, 0, LZHFormat.lengthExtraBits[index], LZHFormat.lengthBase[index])
      }
      return TableEntry.make(TableEntry.invalid, 0, 0, symbol)
    case "distance":
      if (symbol < LZHFormat.distanceCount)
        return TableEntry.make(TableEntry.distance, 0, LZHFormat.distanceExtraBits[symbol], LZHFormat.distanceBase[symbol])
      return TableEntry.make(TableEntry.invalid, 0, 0, symbol)
    case "codeLength":
      return TableEntry.make(TableEntry.plain, 0, 0, symbol)
  }
}

/** Whether a set of code lengths forms a complete prefix code (PV-0372). */
export type CodeValidity = "complete" | "overSubscribed" | "incomplete"

// Scratch space for `validity` and `build` (JavaScript runs them one at a time).
const counts = new Int32Array(LZHFormat.maxCodeLength + 1)
const nextCode = new Int32Array(LZHFormat.maxCodeLength + 1)

/**
 * Builds two-level decode tables from canonical code lengths (PV-0364).
 *
 * A table has a primary part of `1 << primaryBits` entries, indexed by the next `primaryBits`
 * input bits (first bit in bit 0, as the bit reader delivers them). Codes are sent most
 * significant bit first (PV-0363), so each code is bit-reversed before it is placed. A code
 * longer than `primaryBits` gets a subtable, linked from the primary entry of its first
 * `primaryBits` bits and indexed by the bits after them.
 *
 * Size bound: a subtable holds at most `1 << (15 - primaryBits)` entries and there are at most
 * as many subtables as long codes, so `(1 << primaryBits) + (symbols << (15 - primaryBits))`
 * entries always suffice (`capacity`).
 */
export const HuffmanDecodeTable = {
  /** Entries needed for any code of up to `symbols` symbols and lengths up to 15. */
  capacity(primaryBits: number, symbols: number): number {
    return (1 << primaryBits) + (symbols << (LZHFormat.maxCodeLength - primaryBits))
  },

  /**
   * Checks the lengths of `count` symbols against the Kraft equality: not over-subscribed and
   * not incomplete. All lengths 0 is incomplete (PV-0372: no exception for an empty code).
   */
  validity(lengths: Uint32Array, count: number, maxLength: number): CodeValidity {
    counts.fill(0)
    for (let symbol = 0; symbol < count; symbol++) counts[lengths[symbol]] += 1
    let left = 1
    for (let length = 1; length <= maxLength; length++) {
      left <<= 1
      left -= counts[length]
      if (left < 0) return "overSubscribed"
    }
    return left === 0 ? "complete" : "incomplete"
  },

  /**
   * Fills `table` for the lengths of `count` symbols. The code must be complete (checked by
   * `validity`, or the fixed codes, which are complete with all their positions);
   * `subtableWidths` is scratch space of `1 << primaryBits` entries.
   */
  build(
    lengths: Uint32Array,
    count: number,
    alphabet: HuffmanAlphabet,
    primaryBits: number,
    table: Uint32Array,
    subtableWidths: Uint32Array
  ): void {
    const primarySize = 1 << primaryBits
    counts.fill(0)
    let longest = 0
    for (let symbol = 0; symbol < count; symbol++) {
      const length = lengths[symbol]
      counts[length] += 1
      longest = Math.max(longest, length)
    }
    // Canonical first code of each length (PV-0364).
    counts[0] = 0
    let code = 0
    for (let length = 1; length <= LZHFormat.maxCodeLength; length++) {
      code = (code + counts[length - 1]) << 1
      nextCode[length] = code
    }
    const hasSubtables = longest > primaryBits
    if (hasSubtables) subtableWidths.fill(0, 0, primarySize)
    // Pass 1: codes that fit the primary part; widths of the subtables.
    for (let symbol = 0; symbol < count; symbol++) {
      const length = lengths[symbol]
      if (length === 0) continue
      const reversed = HuffmanDecodeTable.reverse(nextCode[length], length)
      nextCode[length] += 1
      if (length <= primaryBits) {
        const entry = (payload(alphabet, symbol) | length) >>> 0
        for (let index = reversed; index < primarySize; index += 1 << length) table[index] = entry
      } else {
        const prefix = reversed & (primarySize - 1)
        subtableWidths[prefix] = Math.max(subtableWidths[prefix], length - primaryBits)
      }
    }
    if (!hasSubtables) return
    // Link the subtables.
    let offset = primarySize
    for (let prefix = 0; prefix < primarySize; prefix++) {
      const width = subtableWidths[prefix]
      if (width === 0) continue
      table[prefix] = TableEntry.make(TableEntry.link, 0, width, offset)
      offset += 1 << width
    }
    // Pass 2: the long codes, with the first codes recomputed.
    code = 0
    for (let length = 1; length <= LZHFormat.maxCodeLength; length++) {
      code = (code + counts[length - 1]) << 1
      nextCode[length] = code
    }
    for (let symbol = 0; symbol < count; symbol++) {
      const length = lengths[symbol]
      if (length <= primaryBits) continue
      const reversed = HuffmanDecodeTable.reverse(nextCode[length], length)
      nextCode[length] += 1
      const link = table[reversed & (primarySize - 1)]
      const base = TableEntry.value(link)
      const size = 1 << TableEntry.aux(link)
      const entry = (payload(alphabet, symbol) | length) >>> 0
      for (let index = reversed >>> primaryBits; index < size; index += 1 << (length - primaryBits)) table[base + index] = entry
    }
  },

  /** The lowest `length` bits of `code` in reverse order. */
  reverse(code: number, length: number): number {
    let input = code
    let output = 0
    for (let i = 0; i < length; i++) {
      output = (output << 1) | (input & 1)
      input >>>= 1
    }
    return output
  }
} as const
