// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenLayout.swift (MIT).

// Where a screen's elements sit (server-screen.md §8.6, Reading R-SS-14) and the leading markup of
// their texts (dynt-atoms.md, Reading R-DA-10): grid points and rectangles, icons and tooltips,
// containers, and the XMLPROP property text.
//
// This file also holds `ScreenTextDecoding` and `characterCount`, which the Swift module declares in
// Screen.swift and uses from several files. They live here, in the module's leaf file, so that
// screen.ts can import the files that use them without an import cycle.


// MARK: - Characters and trimming (Swift: Screen.swift)

/** One grapheme segmenter, made once: `Intl.Segmenter` is costly to create. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * Swift's `String.count` for the screen's texts: the extended grapheme clusters. A text of code units
 * below U+0300 without a carriage return has one character per code unit.
 */
export function characterCount(text: string): number {
  let simple = true
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0x300 || unit === 0x0d) {
      simple = false
      break
    }
  }
  if (simple) return text.length
  let count = 0
  for (const _ of graphemes.segment(text)) count += 1
  return count
}

/** Trimming of decoded screen texts (Swift `ScreenTextDecoding`, declared in Screen.swift). */
export const ScreenTextDecoding = {
  /**
   * `text` without its trailing spaces: the padding pysap's reader strips from atom texts
   * (server-screen.md §5.1). Function codes are trimmed so; atom texts also lose trailing zero
   * characters (`trimmingPadding`, R-DA-11).
   */
  trimmingTrailingSpaces(text: string): string {
    let end = text.length
    while (end > 0 && text.charCodeAt(end - 1) === 0x20) end -= 1
    return end === text.length ? text : text.slice(0, end)
  },

  /**
   * `text` without its trailing spaces and zero characters, in any mix: R-SS-4 applied after
   * decoding (PV-0726), and R-DA-11 for atom texts.
   */
  trimmingPadding(text: string): string {
    let end = text.length
    while (end > 0) {
      const unit = text.charCodeAt(end - 1)
      if (unit !== 0x20 && unit !== 0x00) break
      end -= 1
    }
    return end === text.length ? text : text.slice(0, end)
  }
} as const

// MARK: - Grid

/**
 * A cell on the whole screen: row and column from the top-left corner of the main area, both
 * 0-based, in character cells. A Swift struct of two `var`s; ordered by row, then column.
 */
export class GridPoint {
  constructor(
    public row: number,
    public column: number
  ) {}

  /** Swift's `<`: -1, 0 or 1 by row, then column. */
  static compare(lhs: GridPoint, rhs: GridPoint): number {
    if (lhs.row !== rhs.row) return lhs.row < rhs.row ? -1 : 1
    if (lhs.column !== rhs.column) return lhs.column < rhs.column ? -1 : 1
    return 0
  }

  /** Swift's `==`. */
  static equals(lhs: GridPoint, rhs: GridPoint): boolean {
    return lhs.row === rhs.row && lhs.column === rhs.column
  }

  /** For example `r1 c36`. */
  get description(): string {
    return `r${this.row} c${this.column}`
  }

  toString(): string {
    return this.description
  }
}

/**
 * A rectangle of cells on the whole screen: its top-left cell and its size (elements.md: a
 * tabstrip's or table's container, a list window, a popup). Pinned API of the mock-apps work.
 */
export class GridRect {
  constructor(
    public origin: GridPoint,
    public rows: number,
    public columns: number
  ) {}

  /** Whether `point` lies inside the rectangle. */
  contains(point: GridPoint): boolean {
    const origin = this.origin
    return point.row >= origin.row && point.row < origin.row + this.rows && point.column >= origin.column && point.column < origin.column + this.columns
  }

  /**
   * Whether `other` lies wholly inside the rectangle (an empty `other` at a contained origin does
   * too). (Swift's `contains(_: GridRect)`.)
   */
  containsRect(other: GridRect): boolean {
    const origin = this.origin
    return (
      other.origin.row >= origin.row &&
      other.origin.column >= origin.column &&
      other.origin.row + other.rows <= origin.row + this.rows &&
      other.origin.column + other.columns <= origin.column + this.columns
    )
  }

  /** For example `r1 c2 3x40` (rows x columns). */
  get description(): string {
    return `${this.origin.description} ${this.rows}x${this.columns}`
  }

  toString(): string {
    return this.description
  }
}

// MARK: - Icons and markup

/**
 * An icon a screen text names with a code in its leading markup (`@XX@`, dynt-atoms.md, "Icon and
 * tooltip markup"): the two characters between the `@`s, as received. The model knows no icon
 * table: every code is kept, and the app draws the codes it knows and a stand-in for the rest.
 */
export class ScreenIcon {
  /** The two characters, for example `5Y`. */
  constructor(readonly code: string) {}

  /** For example `icon 5Y`. */
  get description(): string {
    return `icon ${this.code}`
  }

  toString(): string {
    return this.description
  }
}

/** The token's delimiter, and the two characters that open a tooltip inside it. */
const DELIMITER = "@"
const ESCAPE = "\\"
const TOOLTIP_MARKER = "Q"
/** The length of an icon code. */
const CODE_LENGTH = 2 // not-protocol: `@XX@`, two characters (dynt-atoms.md, R-DA-10)

/** An ASCII letter or digit (one Unicode scalar). */
function isCodeCharacter(scalar: string): boolean {
  return /^[0-9A-Za-z]$/.test(scalar)
}

/**
 * The code, the tooltip and the caption of a text that starts with a well-formed token; undefined
 * otherwise. The token needs an icon code, a tooltip marker or both. Works on Unicode scalars, as
 * Swift's `unicodeScalars` view.
 */
function parseMarkup(text: string): { code: string | undefined; tooltip: string | undefined; caption: string } | undefined {
  if (!text.startsWith(DELIMITER)) return undefined
  const scalars = Array.from(text)
  const end = scalars.length
  let index = 1
  let code: string | undefined
  const codeEnd = index + CODE_LENGTH <= end ? index + CODE_LENGTH : undefined
  if (
    codeEnd !== undefined &&
    codeEnd < end &&
    scalars.slice(index, codeEnd).every(isCodeCharacter) &&
    (scalars[codeEnd] === DELIMITER || scalars[codeEnd] === ESCAPE)
  ) {
    code = scalars.slice(index, codeEnd).join("")
    index = codeEnd
  }
  let tooltip: string | undefined
  if (index < end && scalars[index] === ESCAPE) {
    const marker = index + 1
    if (!(marker < end && scalars[marker] === TOOLTIP_MARKER)) return undefined
    const start = marker + 1
    let close = -1
    for (let position = start; position < end; position++) {
      if (scalars[position] === DELIMITER) {
        close = position
        break
      }
    }
    if (close < 0) return undefined
    tooltip = scalars.slice(start, close).join("")
    index = close
  }
  if (!((code !== undefined || tooltip !== undefined) && index < end && scalars[index] === DELIMITER)) return undefined
  return { code, tooltip, caption: scalars.slice(index + 1).join("") }
}

/**
 * The leading markup of a screen text (dynt-atoms.md, "Icon and tooltip markup"; Reading R-DA-10):
 * an icon code, a tooltip, or both, in front of the caption.
 *
 * The forms are `@XX@caption` (icon XX), `@XX\Qtip@caption` (icon XX with a tooltip) and
 * `@\Qtip@caption` (a tooltip, no icon). XX is two ASCII letters or digits, kept as received. Only
 * markup at the very start counts; anything else, a malformed token included, stays part of the
 * caption. What follows the closing `@` is the caption as it is: a space after an icon is kept, as
 * the gap the GUI leaves between the icon and the text.
 */
export class TextMarkup {
  /** The icon the markup names, or undefined. */
  readonly icon: ScreenIcon | undefined
  /** The tooltip after `\Q`, or undefined when there is none or it is empty. */
  readonly tooltip: string | undefined
  /** The text after the markup; the whole text when there is none. */
  readonly caption: string
  /** Whether the text started with markup. */
  readonly hasMarkup: boolean

  private constructor(icon: ScreenIcon | undefined, tooltip: string | undefined, caption: string, hasMarkup: boolean) {
    this.icon = icon
    this.tooltip = tooltip
    this.caption = caption
    this.hasMarkup = hasMarkup
  }

  /** Splits `text` into its leading markup and its caption (Swift `init(parsing:)`). */
  static parse(text: string): TextMarkup {
    const parsed = parseMarkup(text)
    if (parsed === undefined) return new TextMarkup(undefined, undefined, text, false)
    const tooltip = parsed.tooltip === undefined || parsed.tooltip.length === 0 ? undefined : parsed.tooltip
    return new TextMarkup(parsed.code === undefined ? undefined : new ScreenIcon(parsed.code), tooltip, parsed.caption, true)
  }
}

// MARK: - Containers

/**
 * The CONTAINER sid that declared a container (PV-0460) (Swift `ScreenContainer.Kind`).
 * - `loop`: LOOP (0x04): a step loop, one or more rows per loop line.
 * - `table`: TABLE (0x05).
 * - `tabstrip`: TABSTRIP (0x08).
 * - `tabstripPage`: TABSTRIP_PAGE (0x09).
 * - `control`: CONTROL (0x0A).
 * - `subscreen`: SUBSCREEN (0x03): a subscreen area (Reading R-SS-16, issue #162).
 */
export type ScreenContainerKind = "loop" | "table" | "tabstrip" | "tabstripPage" | "control" | "subscreen"

export const ScreenContainerKind = {
  allCases: ["loop", "table", "tabstrip", "tabstripPage", "control", "subscreen"] as readonly ScreenContainerKind[],

  /**
   * The sid's name, lower-cased: `loop`, `table`, `tabstrip`, `tabstrip-page`, `control`,
   * `subscreen` (Swift `description`).
   */
  description(kind: ScreenContainerKind): string {
    return kind === "tabstripPage" ? "tabstrip-page" : kind
  }
} as const

/** The fields of a `ScreenContainer` (Swift `init(id:kind:origin:width:height:linesPerLoopRow:name:)`). */
export interface ScreenContainerFields {
  id: number
  kind: ScreenContainerKind
  origin: GridPoint
  width: number
  height: number
  linesPerLoopRow?: number | undefined
  name?: string | undefined
}

/**
 * A container a screen message declares with a CONTAINER geometry item (server-screen.md §8.6,
 * Reading R-SS-14): the area whose id the atoms name in their `area` byte, and its origin on the
 * main screen. Atoms of the area are placed at the origin plus their own row and column.
 */
export class ScreenContainer {
  /** The container id, the `area` its atoms carry. */
  readonly id: number
  readonly kind: ScreenContainerKind
  /** The top-left cell on the main screen. */
  readonly origin: GridPoint
  /** Width and height in cells, as declared. */
  readonly width: number
  readonly height: number
  /**
   * VARINFO CONTAINER_LOOP after a LOOP container: lines per loop row (PV-0716); undefined when none
   * followed it. (Swift `internal(set)`.)
   */
  linesPerLoopRow: number | undefined
  /**
   * The container name of the CONTAINER NAME item after it (PV-0713): for a CONTROL container, the
   * custom container's name that a control shell links to (controls/scene.md); undefined when none
   * followed it or it was empty. (Swift `internal(set)`.)
   */
  name: string | undefined

  constructor(fields: ScreenContainerFields) {
    this.id = fields.id
    this.kind = fields.kind
    this.origin = fields.origin
    this.width = fields.width
    this.height = fields.height
    this.linesPerLoopRow = fields.linesPerLoopRow
    this.name = fields.name
  }

  /**
   * The geometry as received, for the session report: `loop 1 at r1 c36 54x17`, and a loop's lines
   * per row (`, 2 line(s) per row`). Numbers only; nothing that names a system.
   */
  get description(): string {
    let text = `${ScreenContainerKind.description(this.kind)} ${this.id} at ${this.origin.description} ${this.width}x${this.height}`
    if (this.linesPerLoopRow !== undefined) text += `, ${this.linesPerLoopRow} line(s) per row`
    return text
  }

  toString(): string {
    return this.description
  }
}

/**
 * A CONTAINER item of a sid the decoder does not read (DEFAULT, XMLPROP, SPLITTER, SPLITTER_CELL;
 * server-screen.md §8.6), kept in structure for the session report: which one, how long its value
 * is, and the value's bytes when it is short (a geometry holds numbers only; a long value, which may
 * hold text, is not kept). Issue #155 asked what a SUBSCREEN item carries.
 */
export class ScreenContainerItem {
  /** The longest value kept. */
  static readonly shortValueLimit = 16 // not-protocol: a report size cap

  /** The sid's registry name, lower-cased (`default`, `splitter`, …). */
  readonly kind: string
  readonly byteCount: number
  /** The value when it has at most `shortValueLimit` bytes; else empty. */
  readonly bytes: Uint8Array

  constructor(fields: { kind: string; byteCount: number; bytes: ArrayLike<number> }) {
    this.kind = fields.kind
    this.byteCount = fields.byteCount
    this.bytes = fields.byteCount <= ScreenContainerItem.shortValueLimit ? Uint8Array.from(fields.bytes) : new Uint8Array(0)
  }

  /** `subscreen 9 byte(s) hex 01 00 05 …`, or `xmlprop 120 byte(s)`. */
  get description(): string {
    const hex = this.bytes.length === 0 ? "" : " hex " + Array.from(this.bytes, byte => byte.toString(16).padStart(2, "0")).join(" ")
    return `${this.kind} ${this.byteCount} byte(s)${hex}`
  }

  toString(): string {
    return this.description
  }
}

// MARK: - XMLPROP property text

/** The five predefined XML entities. */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"]
])

/**
 * Swift's `UInt32(text, radix:)`: an optional sign and at least one digit of `radix`, in the u32
 * range (a minus sign only before zero); undefined otherwise.
 */
function parseU32(text: string, radix: 10 | 16): number | undefined {
  let digits = text
  let negative = false
  if (digits.startsWith("+") || digits.startsWith("-")) {
    negative = digits.startsWith("-")
    digits = digits.slice(1)
  }
  if (digits.length === 0) return undefined
  const pattern = radix === 16 ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/
  if (!pattern.test(digits)) return undefined
  let value = 0
  for (const digit of digits) {
    value = value * radix + parseInt(digit, radix)
    if (value > 0xffffffff) return undefined
  }
  if (negative && value !== 0) return undefined
  return value
}

/** The character of an entity or character reference's name, or undefined. */
function entity(name: string): string | undefined {
  const known = ENTITIES.get(name)
  if (known !== undefined) return known
  if (!name.startsWith("#")) return undefined
  const digits = name.slice(1)
  const value =
    digits.startsWith("x") || digits.startsWith("X")
      ? parseU32(digits.slice(1), 16) // not-protocol: XML hexadecimal reference
      : parseU32(digits, 10) // not-protocol: XML decimal reference
  // Swift's `Unicode.Scalar(UInt32)`: no surrogate, nothing above U+10FFFF.
  if (value === undefined || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return undefined
  return String.fromCodePoint(value)
}

/**
 * The XMLPROP property text of a field (dynt-atoms.md, "Text atoms"): a `Propertybag` element whose
 * `DefaultTooltip` element holds the tooltip, as pysap's example writes it (pysap-only).
 */
export const XMLPropertyText = {
  openTag: "<DefaultTooltip>",
  closeTag: "</DefaultTooltip>",
  ampersand: "&",

  /**
   * The text of the first `DefaultTooltip` element, with the five predefined XML entities and
   * numeric character references resolved; undefined when there is none or it is empty.
   */
  defaultTooltip(property: string): string | undefined {
    const open = property.indexOf(XMLPropertyText.openTag)
    if (open < 0) return undefined
    const start = open + XMLPropertyText.openTag.length
    const close = property.indexOf(XMLPropertyText.closeTag, start)
    if (close < 0) return undefined
    const tooltip = XMLPropertyText.unescaped(property.slice(start, close))
    return tooltip.length === 0 ? undefined : tooltip
  },

  /**
   * `text` with `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#NN;` and `&#xHH;` resolved; an
   * unknown or malformed reference stays as it is.
   */
  unescaped(text: string): string {
    if (!text.includes(XMLPropertyText.ampersand)) return text
    let result = ""
    let rest = text
    for (;;) {
      const ampersand = rest.indexOf(XMLPropertyText.ampersand)
      if (ampersand < 0) break
      result += rest.slice(0, ampersand)
      const after = rest.slice(ampersand)
      const semicolon = after.indexOf(";")
      const resolved = semicolon < 0 ? undefined : entity(after.slice(1, semicolon))
      if (resolved === undefined) {
        result += "&"
        rest = rest.slice(ampersand + 1)
        continue
      }
      result += resolved
      rest = after.slice(semicolon + 1)
    }
    return result + rest
  }
} as const
