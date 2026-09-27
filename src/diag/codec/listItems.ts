// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ListItems.swift (MIT).

// Classic list output (docs/protocol/elements.md §7): text runs of SBA, SFE, SLC and VARINFO
// LIST_CELL_TEXT (PV-0970), the list colour in SFE byte 1 (PV-0971), box runs and their line
// elements (PV-0972, PV-0978–PV-0981), the invented style flags and the DYNN CHL window state of
// Reading R-EL-11, the window without DYNN CHL of Reading R-EL-21, and the list keys of R-EL-12.

import { ByteWriter, WireBytes } from "../wire/index.js"
import { ApplItem } from "./applRegistry.js"
import { ByteRange, FixedSize, ItemPayloadError, isUInt16, isUInt8 } from "./diagCodec.js"
import { DiagItem, DiagItemEncoder, DiagItemType, DiagItemWalkError, DiagItemWalker } from "./diagItem.js"
import { SBAValue, SFEValue, SLCValue, SimpleItemValue } from "./simpleItemValues.js"

/**
 * How list output is read (elements.md Reading R-EL-11, #111).
 * - `runsWithCHL`: the default: list runs, with the window state (header lines, first line, total)
 *   from DYNN CHL.
 * - `runsOnly`: list runs without the window state: no header split, the total unknown.
 * - `specGap`: the fallback: no list, as before elements.md.
 */
export type ListReading = "runsWithCHL" | "runsOnly" | "specGap"
export const ListReading = { allCases: ["runsWithCHL", "runsOnly", "specGap"] as readonly ListReading[] } as const

/**
 * How the code characters of a box run are shown (elements.md Reading R-EL-20, #128).
 * - `lineElements`: the default: each code `0`…`:` becomes its line element (`ListLineElement`,
 *   PV-0979); any other character stays as it is.
 * - `codes`: the fallback: the code characters as text, as Swooey 0.0.67 showed them.
 */
export type ListBoxReading = "lineElements" | "codes"
export const ListBoxReading = { allCases: ["lineElements", "codes"] as readonly ListBoxReading[] } as const

/**
 * Where a list's window state comes from when a message has no APPL DYNN CHL (elements.md Reading
 * R-EL-21, #111).
 * - `chlOrScrollInfos`: the default: APPL DYNN CHL (R-EL-11), else a plausible plain CHL simple
 *   item read at the same positions, else a plausible VARINFO SCROLL_INFOS outside a table.
 * - `dynnCHLOnly`: the fallback: APPL DYNN CHL only, as before R-EL-21.
 */
export type ListWindowReading = "chlOrScrollInfos" | "dynnCHLOnly"
export const ListWindowReading = { allCases: ["chlOrScrollInfos", "dynnCHLOnly"] as readonly ListWindowReading[] } as const

/**
 * How list paging is sent (elements.md Reading R-EL-12, #111).
 * - `okCodes`: the default: the list status's codes `P--`, `P-`, `P+`, `P++` in VARINFO OKCODE, as
 *   both MIT clients page a list (PV-0976, `PageKey.listOKCode`), through the OK-code that works
 *   live (client-input.md R-CI-20, PV-0787).
 * - `functionKeys`: function numbers 80–83 (`PageKey`), sent as `FunctionReadings.functionKey`
 *   sends any function number: `/80` to `/83` in VARINFO OKCODE under R-CI-20, a UI_EVENT_SOURCE
 *   event under R-CI-10 (Swooey's default up to 0.0.72).
 */
export type ListPagingReading = "okCodes" | "functionKeys"
export const ListPagingReading = { allCases: ["okCodes", "functionKeys"] as readonly ListPagingReading[] } as const

/** The function numbers of the standard list status (PV-0731, PV-0976), beside `PageKey`. */
export const ListFunctionNumber = {
  /** PICK, F2: line selection with the cursor on a line; a double-click and a hotspot click too. */
  choose: 2, // provenance: PV-0731, PV-0976
  /** BACK, F3. */
  back: 3, // provenance: PV-0731, PV-0976
  /** %SC, Ctrl+F. */
  find: 71, // provenance: PV-0731, PV-0976
  /** PRI, Ctrl+P. */
  print: 86 // provenance: PV-0731, PV-0976
} as const

/**
 * The style flags of a list run (elements.md Reading R-EL-11, **invented**): bits of SFE byte 1's
 * high nibble. Real lists showed none of them, so a real list decodes as plain colours. A value is
 * the bits themselves (Swift `OptionSet`).
 */
export type ListRunFlags = number

export const ListRunFlags = {
  intensified: 0x10, // not-protocol: Swooey Reading R-EL-11 (invented)
  inverse: 0x20, // not-protocol: Swooey Reading R-EL-11 (invented)
  hotspot: 0x40, // not-protocol: Swooey Reading R-EL-11 (invented)
  /** The three bits together. */
  all: 0x70 // not-protocol: intensified | inverse | hotspot
} as const

/** A list run's style, read from and written to its SFE value (PV-0421). */
export class ListRunStyle {
  /** SFE byte 0 of a text run (PV-0972). */
  static readonly textFormat = 0x0a // provenance: PV-0972
  /** SFE byte 0 of a ruled run (PV-0972), which box runs carry too (PV-0981). */
  static readonly ruledFormat = 0x08 // provenance: PV-0972, PV-0981
  /** SFE byte 2 of a box-drawing run (PV-0972). */
  static readonly boxExtended = 0x08 // provenance: PV-0972
  /** The highest list colour, group (PV-0971). */
  static readonly maxColor = 7 // provenance: PV-0971
  /** The colour's bits in SFE byte 1: the low nibble; the flags take the high one (R-EL-11). */
  static readonly colorMask = 0x0f // not-protocol: Swooey Reading R-EL-11 (low nibble)

  /**
   * The list colour, 0–7 in ABAP's FORMAT COLOR numbering (PV-0971); a larger value is an unknown
   * colour, kept as received.
   */
  readonly color: number
  readonly flags: ListRunFlags
  /**
   * SFE byte 0 is `ruledFormat`. Informational only: some text runs carry it too (PV-0981), so it
   * never makes a line; `isBox` does.
   */
  readonly isRuled: boolean
  /**
   * SFE byte 2 is `boxExtended`: each character of the text is the code of one cell's line
   * element, `0`…`:` (PV-0972, PV-0979, PV-0980; `ListLineElement`).
   */
  readonly isBox: boolean

  constructor(fields: { color: number; flags?: ListRunFlags; isRuled?: boolean; isBox?: boolean }) {
    this.color = fields.color
    this.flags = fields.flags ?? 0
    this.isRuled = fields.isRuled ?? false
    this.isBox = fields.isBox ?? false
  }

  /**
   * The style of an SFE value. Under `specGap` the flags are not read and the whole byte 1 is the
   * colour.
   */
  static fromSFE(sfe: SFEValue, reading: ListReading = "runsWithCHL"): ListRunStyle {
    let color: number
    let flags: ListRunFlags
    switch (reading) {
      case "runsWithCHL":
      case "runsOnly":
        color = sfe.color & ListRunStyle.colorMask
        flags = sfe.color & ListRunFlags.all
        break
      case "specGap":
        color = sfe.color
        flags = 0
        break
    }
    return new ListRunStyle({
      color,
      flags,
      isRuled: sfe.format === ListRunStyle.ruledFormat,
      isBox: sfe.extended === ListRunStyle.boxExtended
    })
  }

  /** Whether `color` is one of the eight list colours. */
  get isKnownColor(): boolean {
    return this.color <= ListRunStyle.maxColor
  }

  /**
   * The SFE value of R-EL-11: format 0x0A (0x08 when ruled), colour with the flags, extended 0
   * (0x08 for a box run). The fake server writes a box run as ruled and box, `08 colour 08`, as
   * ULINE runs came (PV-0981, R-EL-20).
   */
  get sfe(): SFEValue {
    return new SFEValue({
      format: this.isRuled ? ListRunStyle.ruledFormat : ListRunStyle.textFormat,
      color: (this.color & ListRunStyle.colorMask) | (this.flags & ListRunFlags.all),
      extended: this.isBox ? ListRunStyle.boxExtended : 0
    })
  }
}

/**
 * SAP's list line elements (PV-0978), in their order, as the code characters of a box run
 * (PV-0979): `0` (0x30) to `:` (0x3A), one code per cell (PV-0980). SAP and ODG show any other
 * character as a blank; Swooey keeps it (elements.md Reading R-EL-20).
 */
const LINE_ELEMENTS = {
  /** `0` ┌ */
  topLeftCorner: [0x30, "\u{250C}"], // provenance: PV-0979
  /** `1` └ */
  bottomLeftCorner: [0x31, "\u{2514}"], // provenance: PV-0979
  /** `2` ┐ */
  topRightCorner: [0x32, "\u{2510}"], // provenance: PV-0979
  /** `3` ┘ */
  bottomRightCorner: [0x33, "\u{2518}"], // provenance: PV-0979
  /** `4` ─ */
  horizontalLine: [0x34, "\u{2500}"], // provenance: PV-0979
  /** `5` │ */
  verticalLine: [0x35, "\u{2502}"], // provenance: PV-0979
  /** `6` ├, SAP's left middle corner (a T turned to the left). */
  leftMiddle: [0x36, "\u{251C}"], // provenance: PV-0979
  /** `7` ┤, SAP's right middle corner (a T turned to the right). */
  rightMiddle: [0x37, "\u{2524}"], // provenance: PV-0979
  /** `8` ┴, SAP's bottom middle corner (a reversed T). */
  bottomMiddle: [0x38, "\u{2534}"], // provenance: PV-0979
  /** `9` ┬, SAP's top middle corner (a T). */
  topMiddle: [0x39, "\u{252C}"], // provenance: PV-0979
  /** `:` ┼ */
  cross: [0x3a, "\u{253C}"] // provenance: PV-0979
} as const

export type ListLineElement = keyof typeof LINE_ELEMENTS

const LINE_ELEMENT_CASES = Object.keys(LINE_ELEMENTS) as ListLineElement[]

export const ListLineElement = {
  allCases: LINE_ELEMENT_CASES as readonly ListLineElement[],

  /** The element of a raw byte, or undefined. */
  fromRaw(byte: number): ListLineElement | undefined {
    return LINE_ELEMENT_CASES.find(element => LINE_ELEMENTS[element][0] === byte)
  },

  /** The element a box run's character codes, or undefined for any other character (one Unicode scalar). */
  fromCode(code: string): ListLineElement | undefined {
    const scalar = code.codePointAt(0)
    if (scalar === undefined || String.fromCodePoint(scalar) !== code) return undefined
    return isUInt8(scalar) ? ListLineElement.fromRaw(scalar) : undefined
  },

  /** The element a box-drawing character stands for (the inverse of `glyph`), or undefined. */
  fromGlyph(glyph: string): ListLineElement | undefined {
    return LINE_ELEMENT_CASES.find(element => LINE_ELEMENTS[element][1] === glyph)
  },

  /** The raw byte (the code character's value). */
  rawValue(element: ListLineElement): number {
    return LINE_ELEMENTS[element][0]
  },

  /** The code character. */
  code(element: ListLineElement): string {
    return String.fromCharCode(LINE_ELEMENTS[element][0])
  },

  /**
   * The Unicode box-drawing character (light lines) of the element (PV-0979), which the list model
   * holds and a copy gives (R-EL-20).
   */
  glyph(element: ListLineElement): string {
    return LINE_ELEMENTS[element][1]
  }
} as const

/** The number of characters (Swift `String.count`: extended grapheme clusters) of `text`. */
function characterCount(text: string): number {
  let count = 0
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) count += 1
  return count
}

/**
 * One list text run (PV-0970): its position from the last SBA, the SFE and SLC before it, and its
 * LIST_CELL_TEXT. Ranges are offsets into the item sequence the walker read.
 */
export class ListRun {
  /** SBA y and x (PV-0422): row and column in the list window, from 0. */
  readonly row: number
  readonly column: number
  /**
   * Whether an SBA came since the previous run; otherwise the last position is reused (PV-0970,
   * odg I).
   */
  readonly hasOwnPosition: boolean
  /** The last SFE before the run, if any. */
  readonly sfe: SFEValue | undefined
  /** The SLC before the run (characters, PV-0423), if one came since the previous run. */
  readonly length: number | undefined
  /** The LIST_CELL_TEXT value: the text in the code page in force. */
  readonly textRange: ByteRange
  /** The 1-based index of the LIST_CELL_TEXT item. */
  readonly itemIndex: number

  constructor(fields: {
    row: number
    column: number
    hasOwnPosition: boolean
    sfe: SFEValue | undefined
    length: number | undefined
    textRange: ByteRange
    itemIndex: number
  }) {
    this.row = fields.row
    this.column = fields.column
    this.hasOwnPosition = fields.hasOwnPosition
    this.sfe = fields.sfe
    this.length = fields.length
    this.textRange = fields.textRange
    this.itemIndex = fields.itemIndex
  }

  /** The run's style under `reading`; plain background colour without an SFE. */
  style(reading: ListReading = "runsWithCHL"): ListRunStyle {
    return this.sfe ? ListRunStyle.fromSFE(this.sfe, reading) : new ListRunStyle({ color: 0 })
  }

  /** The item that carries a run's text (PV-0708). */
  static readonly textItem: ApplItem = ApplItem.varInfo("listCellText")

  /**
   * Appends one run of R-EL-11: SBA (row, column), SFE (the style), SLC (`cells`), then an APPL
   * VARINFO LIST_CELL_TEXT with `text`. Nothing is appended when it throws.
   *
   * With a string `text` (and no `cells`): the text written in UTF-8 (code page 4110, the fake
   * server's), with its characters as the SLC length.
   */
  static append(row: number, column: number, style: ListRunStyle, text: Uint8Array, cells: number, output: ByteWriter): void
  static append(row: number, column: number, style: ListRunStyle, text: string, output: ByteWriter): void
  static append(
    row: number,
    column: number,
    style: ListRunStyle,
    text: Uint8Array | string,
    cellsOrOutput: number | ByteWriter,
    maybeOutput?: ByteWriter
  ): void {
    if (typeof text === "string") {
      const bytes = new TextEncoder().encode(text)
      ListRun.append(row, column, style, bytes, Math.min(characterCount(text), 0xffff), cellsOrOutput as ByteWriter)
      return
    }
    const cells = cellsOrOutput as number
    const output = maybeOutput!
    const bytes = new ByteWriter()
    SimpleItemValue.appendItem(SimpleItemValue.sba(new SBAValue({ y: row, x: column })), bytes)
    SimpleItemValue.appendItem(SimpleItemValue.sfe(style.sfe), bytes)
    SimpleItemValue.appendItem(SimpleItemValue.slc(new SLCValue({ fieldLength: cells })), bytes)
    DiagItemEncoder.appendAPPL(ListRun.textItem, text, bytes)
    output.bytes(bytes.toBytes())
  }
}

/**
 * Walks the list runs of an item sequence (PV-0970). It holds the last SBA, SFE and SLC and yields
 * a `ListRun` at each LIST_CELL_TEXT, carried as APPL or APPL4 (IMPL-IT-9). The SBA, SFE and SLC
 * values always have their fixed sizes: the item walker cuts them by those sizes.
 */
export class ListRunWalker {
  private readonly items = new DiagItemWalker()
  private row = 0
  private column = 0
  private hasPosition = false
  private sfe: SFEValue | undefined
  private length: number | undefined
  private _runsWithoutPosition = 0
  private _error: DiagItemWalkError | undefined

  /** Runs that came without an SBA of their own since the previous run. */
  get runsWithoutPosition(): number {
    return this._runsWithoutPosition
  }

  /** The item walk's error, if it stopped; the runs before it count. */
  get error(): DiagItemWalkError | undefined {
    return this._error
  }

  /** The next run, or undefined at the end of the sequence or where the item walk stopped. */
  next(sequence: Uint8Array): ListRun | undefined {
    for (;;) {
      let item: DiagItem | undefined
      try {
        item = this.items.next(sequence)
      } catch (error) {
        if (!(error instanceof DiagItemWalkError)) throw error
        this._error = error
        return undefined
      }
      if (item === undefined) return undefined
      const value = item.valueRange.of(sequence)
      switch (item.type) {
        case "sba": {
          const sba = tryDecode(() => SBAValue.decode(value))
          if (sba === undefined) continue
          this.row = sba.y
          this.column = sba.x
          this.hasPosition = true
          break
        }
        case "sfe":
          this.sfe = tryDecode(() => SFEValue.decode(value))
          break
        case "slc":
          this.length = tryDecode(() => SLCValue.decode(value))?.fieldLength
          break
        case "appl":
        case "appl4": {
          if (!ApplItem.equals(item.appl, ListRun.textItem)) continue
          const run = new ListRun({
            row: this.row,
            column: this.column,
            hasOwnPosition: this.hasPosition,
            sfe: this.sfe,
            length: this.length,
            textRange: item.valueRange,
            itemIndex: item.index
          })
          if (!this.hasPosition) this._runsWithoutPosition += 1
          this.hasPosition = false
          this.length = undefined
          return run
        }
        default:
          continue
      }
    }
  }

  /** Every run of `sequence`, and the walker after the last one (its counts and error). */
  static runs(sequence: Uint8Array): { runs: ListRun[]; walker: ListRunWalker } {
    const walker = new ListRunWalker()
    const runs: ListRun[] = []
    for (let run = walker.next(sequence); run !== undefined; run = walker.next(sequence)) runs.push(run)
    return { runs, walker }
  }
}

/** Swift `try?` on an item value decoder. */
function tryDecode<T>(decode: () => T): T | undefined {
  try {
    return decode()
  } catch (error) {
    if (error instanceof ItemPayloadError) return undefined
    throw error
  }
}

/** The fields of a `ListWindowState`; every field defaults to 0. */
export interface ListWindowStateFields {
  scrollFlags: number
  chlFlags: number
  currentRow: number
  currentColumn: number
  verticalSlider: number
  dimListRow: number
  dimListColumn: number
  horizontalSlider: number
  dimRow: number
  dimColumn: number
  maxListRow: number
  listRowOffset: number
  maxListColumn: number
  listColumnOffset: number
  /** Bytes 18–21, which no source decodes; zero when the fake server writes them. */
  undecoded: number
}

/**
 * The DYNN CHL value as the list window state of Reading R-EL-11: 22 bytes (the size of the CHL
 * simple item, PV-0114) at Wireshark's field positions, which items.md gives as informative (#32).
 * Reading R-EL-21 reads a plain CHL simple item's value the same way. The meanings are Swooey's
 * Reading: maxlistrow = the body lines in total, listrowoffset = the first body line shown − 1,
 * dimlistrow = body rows per page, dimrow = the window's rows (so header lines = dimrow −
 * dimlistrow), maxlistcol and dimlistcol = the widths, the current row and column = the cursor.
 */
export class ListWindowState implements ListWindowStateFields {
  /** The value size (PV-0114). */
  static readonly size = DiagItemType.simpleValueSize("chl")!
  /** The item that carries it: APPL DYNN CHL (0x05/0x01). */
  static readonly item: ApplItem = ApplItem.dynn("chl")

  static readonly Offset = {
    scrollFlags: 0, // not-protocol: Swooey Reading R-EL-11 (Wireshark's informative CHL positions, #32)
    chlFlags: 2, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    currentRow: 4, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    currentColumn: 5, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    verticalSlider: 6, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    dimListRow: 7, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    dimListColumn: 8, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    horizontalSlider: 9, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    dimRow: 10, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    dimColumn: 11, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    maxListRow: 12, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    listRowOffset: 14, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    maxListColumn: 16, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    listColumnOffset: 17, // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
    undecoded: 18 // not-protocol: Swooey Reading R-EL-11 (informative CHL positions)
  } as const

  readonly scrollFlags: number
  readonly chlFlags: number
  readonly currentRow: number
  readonly currentColumn: number
  readonly verticalSlider: number
  readonly dimListRow: number
  readonly dimListColumn: number
  readonly horizontalSlider: number
  readonly dimRow: number
  readonly dimColumn: number
  readonly maxListRow: number
  readonly listRowOffset: number
  readonly maxListColumn: number
  readonly listColumnOffset: number
  readonly undecoded: number

  constructor(fields: Partial<ListWindowStateFields> = {}) {
    this.scrollFlags = fields.scrollFlags ?? 0
    this.chlFlags = fields.chlFlags ?? 0
    this.currentRow = fields.currentRow ?? 0
    this.currentColumn = fields.currentColumn ?? 0
    this.verticalSlider = fields.verticalSlider ?? 0
    this.dimListRow = fields.dimListRow ?? 0
    this.dimListColumn = fields.dimListColumn ?? 0
    this.horizontalSlider = fields.horizontalSlider ?? 0
    this.dimRow = fields.dimRow ?? 0
    this.dimColumn = fields.dimColumn ?? 0
    this.maxListRow = fields.maxListRow ?? 0
    this.listRowOffset = fields.listRowOffset ?? 0
    this.maxListColumn = fields.maxListColumn ?? 0
    this.listColumnOffset = fields.listColumnOffset ?? 0
    this.undecoded = fields.undecoded ?? 0
  }

  /**
   * The window state R-EL-11's server writes: `totalLines` body lines, the first shown at
   * `firstLine` (from 1), `visibleLines` body rows per page in a window of `windowRows` rows (header
   * lines = `windowRows` − `visibleLines`), `width` columns in total of which `visibleWidth` are
   * shown, the cursor at `cursorRow` and `cursorColumn`. Undefined when a value does not fit its
   * field (at most 65,535 lines, 255 rows and columns).
   */
  static fromWindow(window: {
    totalLines: number
    firstLine: number
    visibleLines: number
    windowRows: number
    width: number
    visibleWidth: number
    cursorRow?: number
    cursorColumn?: number
  }): ListWindowState | undefined {
    const cursorRow = window.cursorRow ?? 0
    const cursorColumn = window.cursorColumn ?? 0
    if (
      !isUInt16(window.totalLines) ||
      !(window.firstLine >= 1) ||
      !isUInt16(window.firstLine - 1) ||
      !isUInt8(window.visibleLines) ||
      !isUInt8(window.windowRows) ||
      !(window.windowRows >= window.visibleLines) ||
      !isUInt8(window.width) ||
      !isUInt8(window.visibleWidth) ||
      !isUInt8(cursorRow) ||
      !isUInt8(cursorColumn)
    )
      return undefined
    return new ListWindowState({
      currentRow: cursorRow,
      currentColumn: cursorColumn,
      dimListRow: window.visibleLines,
      dimListColumn: window.visibleWidth,
      dimRow: window.windowRows,
      dimColumn: window.visibleWidth,
      maxListRow: window.totalLines,
      listRowOffset: window.firstLine - 1,
      maxListColumn: window.width
    })
  }

  /** Decodes exactly 22 value bytes. */
  static decode(value: Uint8Array): ListWindowState {
    FixedSize.check(value, ListWindowState.size)
    const offset = ListWindowState.Offset
    return new ListWindowState({
      scrollFlags: WireBytes.u16BigEndian(value, offset.scrollFlags), // not-protocol: Swooey Reading R-EL-11
      chlFlags: WireBytes.u16BigEndian(value, offset.chlFlags), // not-protocol: Swooey Reading R-EL-11
      currentRow: value[offset.currentRow],
      currentColumn: value[offset.currentColumn],
      verticalSlider: value[offset.verticalSlider],
      dimListRow: value[offset.dimListRow],
      dimListColumn: value[offset.dimListColumn],
      horizontalSlider: value[offset.horizontalSlider],
      dimRow: value[offset.dimRow],
      dimColumn: value[offset.dimColumn],
      maxListRow: WireBytes.u16BigEndian(value, offset.maxListRow), // not-protocol: Swooey Reading R-EL-11
      listRowOffset: WireBytes.u16BigEndian(value, offset.listRowOffset), // not-protocol: Swooey Reading R-EL-11
      maxListColumn: value[offset.maxListColumn],
      listColumnOffset: value[offset.listColumnOffset],
      undecoded: WireBytes.u32BigEndian(value, offset.undecoded) // not-protocol: Swooey Reading R-EL-11
    })
  }

  /** Appends the 22 value bytes. */
  append(output: ByteWriter): void {
    output.u16be(this.scrollFlags) // not-protocol: Swooey Reading R-EL-11
    output.u16be(this.chlFlags) // not-protocol: Swooey Reading R-EL-11
    output.bytes([
      this.currentRow,
      this.currentColumn,
      this.verticalSlider,
      this.dimListRow,
      this.dimListColumn,
      this.horizontalSlider,
      this.dimRow,
      this.dimColumn
    ])
    output.u16be(this.maxListRow) // not-protocol: Swooey Reading R-EL-11
    output.u16be(this.listRowOffset) // not-protocol: Swooey Reading R-EL-11
    output.u8(this.maxListColumn)
    output.u8(this.listColumnOffset)
    WireBytes.appendU32BigEndian(this.undecoded, output) // not-protocol: Swooey Reading R-EL-11
  }

  /** The value bytes. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(ListWindowState.size)
    this.append(output)
    return output.toBytes()
  }

  /** Appends the whole item: APPL DYNN CHL with the value. */
  appendItem(output: ByteWriter): void {
    DiagItemEncoder.appendAPPL(ListWindowState.item, this.bytes, output)
  }

  /**
   * Appends the value as a plain CHL simple item: the type byte 0x09 (PV-0410), then the 22 bytes
   * (PV-0114). A real list came with one and without APPL DYNN CHL (PV-0951); Reading R-EL-21 reads
   * it at the same positions.
   */
  appendPlainItem(output: ByteWriter): void {
    output.u8(DiagItemType.rawValue("chl"))
    this.append(output)
  }

  /** The body lines in total (maxlistrow). */
  get totalLines(): number {
    return this.maxListRow
  }

  /** The first body line shown, from 1 (listrowoffset + 1). */
  get firstLine(): number {
    return this.listRowOffset + 1
  }

  /** Body rows per page (dimlistrow). */
  get visibleLines(): number {
    return this.dimListRow
  }

  /** The fixed header lines at the top of the window: dimrow − dimlistrow, never negative. */
  get headerLines(): number {
    return Math.max(0, this.dimRow - this.dimListRow)
  }

  /** The list's width in columns (maxlistcol). */
  get width(): number {
    return this.maxListColumn
  }
}
