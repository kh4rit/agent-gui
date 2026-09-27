// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/MenuEntries.swift (MIT).

// The menu entries of MNUENTRY items (docs/protocol/server-screen.md §8.1): the value of every
// MNUENTRY item (id 0x0B, sids MENU_ACT, MENU_MNU, MENU_PFK, MENU_KYB) is a sequence of entries
// back to back, with no count, to the end of the value (PV-0720). What positions, flags, return
// codes, function codes and the four sids mean is spec gap #50; the walker only splits the bytes.
// Their meanings under the Readings of server-screen.md §8.7 are in guiStatus.ts.

import { WireBytes, type ByteWriter } from "../wire/index.js"
import { ByteRange, CodecSpecGap } from "./diagCodec.js"
import { ScreenValueEncodingError, ZeroTerminatedWriter } from "./screenListValues.js"

/** Field offsets of a menu entry (PV-0718). */
export const MenuEntryLayout = {
  length: 0, // provenance: PV-0718
  position1: 2, // provenance: PV-0718
  position2: 3, // provenance: PV-0718
  position3: 4, // provenance: PV-0718
  position4: 5, // provenance: PV-0718
  flags: 6, // provenance: PV-0718
  virtualKey: 7, // provenance: PV-0718
  returnCodes: 8, // provenance: PV-0718
  functionCodes: 14, // provenance: PV-0718
  /** The fixed part: the text starts right after it. */
  fixedSize: 20, // provenance: PV-0718, PV-0719
  /** The largest entry the u16 length field can declare. */
  maxLength: 0xffff, // provenance: PV-0718
  /** Each of the three strings ends with this byte. */
  terminator: 0x00 // provenance: PV-0718
} as const

/**
 * The flag byte of a menu entry (entry offset 6): eight one-bit fields named by pysap only
 * (PV-0721). Neither source defines what a bit means; pysap's renderer consults SEL, MEN and SEP
 * for sub-menus (server-screen.md §8.1, informative). The meanings are #50. A value is the byte
 * itself (Swift `OptionSet`).
 */
export type MenuEntryFlags = number

export const MenuEntryFlags = {
  unknown1: 0x01, // provenance: PV-0721
  sel: 0x02, // provenance: PV-0721
  men: 0x04, // provenance: PV-0721
  sep: 0x08, // provenance: PV-0721
  vkey: 0x10, // provenance: PV-0721
  unknown6: 0x20, // provenance: PV-0721
  unknown7: 0x40, // provenance: PV-0721
  unknown8: 0x80, // provenance: PV-0721

  /**
   * Every bit with its name as the spec's table writes it (pysap's `flag_TERM_*` without the
   * prefix), in ascending mask order. The eight names cover all eight bits.
   */
  named: [
    { flag: 0x01, name: "UNK1" },
    { flag: 0x02, name: "SEL" },
    { flag: 0x04, name: "MEN" },
    { flag: 0x08, name: "SEP" },
    { flag: 0x10, name: "VKEY" },
    { flag: 0x20, name: "UNK6" },
    { flag: 0x40, name: "UNK7" },
    { flag: 0x80, name: "UNK8" }
  ] as readonly { readonly flag: number; readonly name: string }[],

  /** Names of the bits that are set, in ascending mask order. */
  names(flags: MenuEntryFlags): string[] {
    return MenuEntryFlags.named.filter(entry => (flags & entry.flag) !== 0).map(entry => entry.name)
  }
} as const

/**
 * Six one-byte codes of a menu entry: its return codes (entry bytes 8–13) or its function codes
 * (bytes 14–19) (PV-0718). What they mean is #50. A mutable value: copy it with `clone()` where
 * Swift copies the struct. Swift packs the six codes into a UInt64; the port keeps the six bytes.
 */
export class MenuEntryCodes {
  /** The number of codes. */
  static readonly count = 6 // provenance: PV-0718

  /** The codes; `new MenuEntryCodes()` holds six zero codes. */
  private readonly storage = new Uint8Array(MenuEntryCodes.count)

  /** Exactly six codes, or undefined for another count (Swift `init?(_:)`). */
  static of(codes: ArrayLike<number>): MenuEntryCodes | undefined {
    if (codes.length !== MenuEntryCodes.count) return undefined
    const result = new MenuEntryCodes()
    for (let index = 0; index < MenuEntryCodes.count; index++) result.set(index, codes[index])
    return result
  }

  /** The six codes at `offset` of `value`; the caller has checked that they are there (Swift `init(_:at:)`). */
  static at(value: Uint8Array, offset: number): MenuEntryCodes {
    const result = new MenuEntryCodes()
    result.storage.set(value.subarray(offset, offset + MenuEntryCodes.count))
    return result
  }

  /** Code `index`, 0-based (return_code_1 or function_code_1 is index 0). Swift's subscript getter. */
  get(index: number): number {
    MenuEntryCodes.check(index)
    return this.storage[index]
  }

  /** Sets code `index`, 0-based. Swift's subscript setter. */
  set(index: number, code: number): void {
    MenuEntryCodes.check(index)
    this.storage[index] = code
  }

  private static check(index: number): void {
    if (!(Number.isInteger(index) && index >= 0 && index < MenuEntryCodes.count)) throw new Error("menu entry code index out of range")
  }

  /** Appends the six codes in order. */
  append(output: ByteWriter): void {
    output.bytes(this.storage)
  }

  /** The six codes in order. */
  get bytes(): Uint8Array {
    return this.storage.slice()
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): MenuEntryCodes {
    return MenuEntryCodes.at(this.storage, 0)
  }
}

/** The fields of a `MenuEntryFields`; every field defaults to 0 (the codes to six zeros). */
export interface MenuEntryFieldsInit {
  position1: number
  position2: number
  position3: number
  position4: number
  flags: MenuEntryFlags
  virtualKey: number
  returnCodes: MenuEntryCodes
  functionCodes: MenuEntryCodes
}

/**
 * The fixed fields of a menu entry after its length (entry bytes 2–19, PV-0718): what a caller
 * chooses when it builds an entry, and what `MenuEntry` reports. The codes are copied in, so the
 * value does not share them with the caller.
 */
export class MenuEntryFields implements MenuEntryFieldsInit {
  readonly position1: number
  readonly position2: number
  readonly position3: number
  readonly position4: number
  readonly flags: MenuEntryFlags
  readonly virtualKey: number
  readonly returnCodes: MenuEntryCodes
  readonly functionCodes: MenuEntryCodes

  constructor(fields: Partial<MenuEntryFieldsInit> = {}) {
    this.position1 = fields.position1 ?? 0
    this.position2 = fields.position2 ?? 0
    this.position3 = fields.position3 ?? 0
    this.position4 = fields.position4 ?? 0
    this.flags = fields.flags ?? 0
    this.virtualKey = fields.virtualKey ?? 0
    this.returnCodes = fields.returnCodes?.clone() ?? new MenuEntryCodes()
    this.functionCodes = fields.functionCodes?.clone() ?? new MenuEntryCodes()
  }
}

/**
 * One menu entry of an MNUENTRY value: where it sits, its fixed fields and where its three strings
 * are, never a copy of its bytes. Offsets are relative to the start of the value.
 */
export class MenuEntry {
  /** 1-based position of the entry in the value. */
  readonly index: number
  /** Offset of the entry's length field. */
  readonly offset: number
  /** The length field: the whole entry, its own two bytes included (PV-0719). */
  readonly length: number
  readonly fields: MenuEntryFields
  /** The text, the accelerator and the info string, without their zero bytes. Their character set is #18. */
  readonly text: ByteRange
  readonly accelerator: ByteRange
  readonly info: ByteRange

  constructor(fields: {
    index: number
    offset: number
    length: number
    fields: MenuEntryFields
    text: ByteRange
    accelerator: ByteRange
    info: ByteRange
  }) {
    this.index = fields.index
    this.offset = fields.offset
    this.length = fields.length
    this.fields = fields.fields
    this.text = fields.text
    this.accelerator = fields.accelerator
    this.info = fields.info
  }

  /** Offset of the byte after the entry, where the next entry starts. */
  get endOffset(): number {
    return this.offset + this.length
  }
}

/**
 * The part of a menu entry a truncated value ended in: `fixedFields`, the 20 fixed bytes; `text`,
 * `accelerator` or `info`, a string whose zero byte is missing before the end of the value.
 */
export type MenuEntryPart = "fixedFields" | "text" | "accelerator" | "info"

/**
 * Why a menu-entry walk stopped (IMPL-SS-5). Entries produced before it count; the rest of the item
 * stays opaque, and the message goes on. The vector error class is given in brackets.
 */
export type MenuEntryWalkErrorInfo =
  /**
   * Fewer than 20 bytes are left for an entry's fixed part, or one of its strings has no zero byte
   * before the end of the value. [`truncated`]
   */
  | { readonly kind: "truncated"; readonly entryIndex: number; readonly entryOffset: number; readonly part: MenuEntryPart }
  /**
   * The length field differs from 20 plus the three strings with their zero bytes: the two sources
   * would find different next entries (#50). [`entry-length-mismatch`]
   */
  | { readonly kind: "lengthMismatch"; readonly entryIndex: number; readonly entryOffset: number; readonly declared: number; readonly actual: number }

export class MenuEntryWalkError extends Error {
  constructor(readonly info: MenuEntryWalkErrorInfo) {
    super(
      info.kind === "truncated"
        ? `menu entry ${info.entryIndex} at offset ${info.entryOffset} truncated in its ${info.part}`
        : `menu entry ${info.entryIndex} at offset ${info.entryOffset} declares length ${info.declared}, its parts take ${info.actual}`
    )
    this.name = "MenuEntryWalkError"
  }

  /** 1-based index of the entry being read when the walk stopped. */
  get entryIndex(): number {
    return this.info.entryIndex
  }

  /** Offset of the length field of the entry being read when the walk stopped. */
  get entryOffset(): number {
    return this.info.entryOffset
  }

  /**
   * The spec-gap issue behind the stop: #50 for a length mismatch (where the next entry starts is a
   * conflict between the sources), #39 for a value that ends early (the provisional length policy).
   */
  get specGapIssue(): number {
    return this.info.kind === "truncated" ? CodecSpecGap.itemValueLengthPolicy : CodecSpecGap.menuEntries
  }
}

/**
 * Walks the menu entries of one MNUENTRY value (server-screen.md §8.1, R-SS-8, IMPL-SS-5).
 *
 * For each entry at offset *p*: fewer than 20 bytes left is `truncated`; the text, accelerator and
 * info strings are found from *p* + 20, each ended by a zero byte inside the value, else
 * `truncated`; a length field other than the bytes from *p* to just after the info's zero byte is
 * `lengthMismatch`; otherwise the entry is produced and the walk goes on after it. Where the check
 * passes, moving on by the length and moving on past the strings are the same (R-SS-8).
 *
 * Index-based, like `DiagItemWalker`: the walker holds only its position, every call gets the same
 * value, and errors are sticky.
 */
export class MenuEntryWalker {
  private _offset = 0
  private _entryCount = 0
  private _error: MenuEntryWalkError | undefined

  /**
   * `allowsZeroPadding`: whether zero bytes between the info string's zero byte and the end the
   * length field declares are taken as padding (server-screen.md Reading R-SS-8a): pysap and ODG
   * move on by the length field, and ODG writes the entry as ending with padding to its length.
   * False, the default, keeps R-SS-8's strict check.
   */
  constructor(readonly allowsZeroPadding = false) {}

  /** Offset of the next entry's length field. */
  get offset(): number {
    return this._offset
  }

  /** Number of entries produced so far. */
  get entryCount(): number {
    return this._entryCount
  }

  /** The error the walk stopped with, if any. */
  get error(): MenuEntryWalkError | undefined {
    return this._error
  }

  /** A copy of this walker (Swift copies the struct on assignment). */
  clone(): MenuEntryWalker {
    const copy = new MenuEntryWalker(this.allowsZeroPadding)
    copy._offset = this._offset
    copy._entryCount = this._entryCount
    copy._error = this._error
    return copy
  }

  /** Returns the next entry, or undefined at the end of the value. */
  next(value: Uint8Array): MenuEntry | undefined {
    if (this._error) throw this._error
    if (!(this._offset < value.length)) return undefined
    const start = this._offset
    const index = this._entryCount + 1
    if (!(value.length - start >= MenuEntryLayout.fixedSize))
      return this.fail({ kind: "truncated", entryIndex: index, entryOffset: start, part: "fixedFields" })
    const declared = WireBytes.u16BigEndian(value, start + MenuEntryLayout.length) // provenance: PV-0718
    const textStart = start + MenuEntryLayout.fixedSize
    const textEnd = terminator(value, textStart)
    if (textEnd === undefined) return this.fail({ kind: "truncated", entryIndex: index, entryOffset: start, part: "text" })
    const acceleratorEnd = terminator(value, textEnd + 1)
    if (acceleratorEnd === undefined) return this.fail({ kind: "truncated", entryIndex: index, entryOffset: start, part: "accelerator" })
    const infoEnd = terminator(value, acceleratorEnd + 1)
    if (infoEnd === undefined) return this.fail({ kind: "truncated", entryIndex: index, entryOffset: start, part: "info" })
    const actual = infoEnd + 1 - start
    if (!(declared === actual || this.isZeroPadding(value, start + actual, start + declared)))
      return this.fail({ kind: "lengthMismatch", entryIndex: index, entryOffset: start, declared, actual })
    const fields = new MenuEntryFields({
      position1: value[start + MenuEntryLayout.position1],
      position2: value[start + MenuEntryLayout.position2],
      position3: value[start + MenuEntryLayout.position3],
      position4: value[start + MenuEntryLayout.position4],
      flags: value[start + MenuEntryLayout.flags],
      virtualKey: value[start + MenuEntryLayout.virtualKey],
      returnCodes: MenuEntryCodes.at(value, start + MenuEntryLayout.returnCodes),
      functionCodes: MenuEntryCodes.at(value, start + MenuEntryLayout.functionCodes)
    })
    const entry = new MenuEntry({
      index,
      offset: start,
      length: Math.max(declared, actual),
      fields,
      text: new ByteRange(textStart, textEnd),
      accelerator: new ByteRange(textEnd + 1, acceleratorEnd),
      info: new ByteRange(acceleratorEnd + 1, infoEnd)
    })
    this._offset = entry.endOffset
    this._entryCount = index
    return entry
  }

  /**
   * Whether `start ..< end` is padding under Reading R-SS-8a: allowed, a non-empty range inside the
   * value, and zero bytes only.
   */
  private isZeroPadding(value: Uint8Array, start: number, end: number): boolean {
    if (!(this.allowsZeroPadding && start < end && end <= value.length)) return false
    for (let index = start; index < end; index++) if (value[index] !== MenuEntryLayout.terminator) return false
    return true
  }

  private fail(info: MenuEntryWalkErrorInfo): never {
    this._error = new MenuEntryWalkError(info)
    throw this._error
  }
}

/** The offset of the first zero byte at or after `start`, or undefined when the value ends first. */
function terminator(value: Uint8Array, start: number): number | undefined {
  for (let index = start; index < value.length; index++) if (value[index] === MenuEntryLayout.terminator) return index
  return undefined
}

/** Convenience over `MenuEntryWalker` for tools and tests; the receive path uses the walker. */
export const MenuEntries = {
  /**
   * Walks a whole MNUENTRY value: the entries produced, and the error that stopped the walk.
   * `allowsZeroPadding` selects Reading R-SS-8a (`MenuEntryWalker.allowsZeroPadding`).
   */
  walk(value: Uint8Array, allowsZeroPadding = false): { entries: MenuEntry[]; error: MenuEntryWalkError | undefined } {
    const walker = new MenuEntryWalker(allowsZeroPadding)
    const entries: MenuEntry[] = []
    try {
      for (let entry = walker.next(value); entry !== undefined; entry = walker.next(value)) entries.push(entry)
    } catch (error) {
      if (!(error instanceof MenuEntryWalkError)) throw error
      return { entries, error }
    }
    return { entries, error: undefined }
  },

  /**
   * Appends one menu entry: its length, the fixed fields, then the text, the accelerator and the
   * info string, each followed by one zero byte. The length is 20 plus the three strings with their
   * zero bytes (PV-0719, R-SS-8), so both sources' walks find the next entry. Nothing is appended
   * when it throws.
   */
  appendEntry(fields: MenuEntryFields, text: Uint8Array, accelerator: Uint8Array, info: Uint8Array, output: ByteWriter): void {
    // Each count is bounded by its array, so the sum cannot overflow.
    const length = MenuEntryLayout.fixedSize + text.length + accelerator.length + info.length + 3 // not-protocol: three terminators
    if (!(length <= MenuEntryLayout.maxLength))
      throw new ScreenValueEncodingError({ kind: "tooLong", length, limit: MenuEntryLayout.maxLength })
    ZeroTerminatedWriter.checkThree(text, accelerator, info)
    output.u16be(length) // provenance: PV-0718, PV-0719
    output.u8(fields.position1)
    output.u8(fields.position2)
    output.u8(fields.position3)
    output.u8(fields.position4)
    output.u8(fields.flags)
    output.u8(fields.virtualKey)
    fields.returnCodes.append(output)
    fields.functionCodes.append(output)
    // Checked above: the strings hold no zero byte, so this appends all three.
    ZeroTerminatedWriter.appendThree(text, accelerator, info, output)
  }
} as const
