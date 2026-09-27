// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DyntAtom.swift (MIT).

// DYNT atoms (docs/protocol/dynt-atoms.md): the 13-byte atom header, the attribute byte, the
// element-type table and the payload layouts the spec fully specifies. The walker is in
// dyntAtomWalker.ts, on-demand text decoding in DyntText.swift (next wave) and the layout encoder
// in dyntAtomEncoder.ts.
//
// Hot-path rules (docs/architecture.md §3, IMPL-DA-5): an atom is a set of numbers and ranges into
// the item value it came from. Nothing is copied and no text is decoded while walking; callers
// decode the text of the atoms they need, when they need it (`DyntText`).
//
// This file's `extension CodecSpecGap` (dyntDialogFlags, dyntButtonStrings, dyntDlenMismatch,
// dyntMalformedPayload) is in diagCodec.ts, with the rest of `CodecSpecGap`.

import { ApplItem } from "./applRegistry.js"
import { ByteRange, CodecSpecGap } from "./diagCodec.js"

// MARK: - Spec-gap issues

/** A step that needs a DYNT fact the spec does not state; `issue` names the spec-gap issue. */
export type DyntSpecGapErrorInfo = { readonly kind: "specGap"; readonly issue: number }

export class DyntSpecGapError extends Error {
  constructor(readonly info: DyntSpecGapErrorInfo) {
    super(`DYNT: not specified (spec gap #${info.issue})`)
    this.name = "DyntSpecGapError"
  }
}

// MARK: - Layout

/**
 * Offsets and widths of the atom header (dynt-atoms.md, "Atom header"; PV-0140, PV-0141). Offsets
 * count from the atom's first byte.
 */
export const DyntAtomLayout = {
  /** The fixed header: every atom is at least this long (PV-0140, R-DA-3). */
  headerSize: 13, // provenance: PV-0140
  /** atom_length: u16 BE at offset 0, counting the whole atom (PV-0602, PV-0603). */
  lengthOffset: 0, // provenance: PV-0602
  lengthSize: 2, // provenance: PV-0602
  dlgFlag1Offset: 2, // provenance: PV-0604
  dlgFlag2Offset: 3, // provenance: PV-0605
  etypeOffset: 4, // provenance: PV-0606
  areaOffset: 5, // provenance: PV-0607
  blockOffset: 6, // provenance: PV-0608
  groupOffset: 7, // provenance: PV-0609
  /** row: u16 BE (PV-0610). */
  rowOffset: 8, // provenance: PV-0610
  /** col: u16 BE (PV-0611). */
  colOffset: 10, // provenance: PV-0611
  attributeOffset: 12 // provenance: PV-0612
} as const

/** Payload layouts, offsets counted from the first payload byte, atom offset 13. */
export const DyntPayloadLayout = {
  // _2 field variants 130–132 (PV-0651, PV-0652).
  field2Flag1: 0, // provenance: PV-0651
  field2Dlen: 2, // provenance: PV-0651
  field2Mlen: 3, // provenance: PV-0651
  field2MaxNrChars: 4, // provenance: PV-0651
  field2Text: 6, // provenance: PV-0651, PV-0652

  // _1 field variants 121–123 (PV-0653): flag1 is one byte here.
  field1Flag1: 0, // provenance: PV-0653
  field1Dlen: 1, // provenance: PV-0653
  field1Mlen: 2, // provenance: PV-0653
  field1MaxNrChars: 3, // provenance: PV-0653
  field1Text: 5, // provenance: PV-0653

  // Frame 127 (PV-0654).
  frameDrows: 0, // provenance: PV-0654
  frameDcols: 2, // provenance: PV-0654
  frameText: 4, // provenance: PV-0654

  // Radio button 129 fixed fields (PV-0655).
  radioButton: 0, // provenance: PV-0655
  radioVisibleLabelLength: 1, // provenance: PV-0655
  radioEventIDOffset: 3, // provenance: PV-0655
  radioEventIDLength: 5, // provenance: PV-0655
  radioTextOffset: 6, // provenance: PV-0655
  radioTextLength: 8, // provenance: PV-0655
  radioFixedSize: 10, // provenance: PV-0655

  // Push button 115 fixed fields (PV-0657).
  pushVLength: 0, // provenance: PV-0657
  pushVHeight: 1, // provenance: PV-0657
  pushFunctionCodeOffset: 2, // provenance: PV-0657
  pushTextOffset: 4, // provenance: PV-0657
  pushFixedSize: 6, // provenance: PV-0657

  // Tabstrip button 116 fixed fields, then three NUL-terminated strings (PV-0656).
  tabVLength: 0, // provenance: PV-0656
  tabVHeight: 1, // provenance: PV-0656
  tabPageID: 2, // provenance: PV-0656
  tabFunctionCodeOffset: 3, // provenance: PV-0656
  tabTextOffset: 5, // provenance: PV-0656
  tabIDOffset: 7, // provenance: PV-0656
  tabStrings: 9, // provenance: PV-0656
  /** The terminator of the tabstrip strings. */
  stringTerminator: 0x00 // provenance: PV-0656
} as const

// MARK: - Element types

/** The table itself: element type to raw value (PV-0630). */
const ELEMENT_CODES = {
  efield: 101, // provenance: PV-0630
  ofield: 102, // provenance: PV-0630
  keyword: 103, // provenance: PV-0630
  checkbutton4: 104, // provenance: PV-0630
  radiobutton0: 105, // provenance: PV-0630
  pushbutton3: 106, // provenance: PV-0630
  frame3: 107, // provenance: PV-0630
  loop6: 108, // provenance: PV-0630
  subscreen: 109, // provenance: PV-0630
  property: 111, // provenance: PV-0630
  icon0: 112, // provenance: PV-0630
  pushbutton1: 113, // provenance: PV-0630
  /** FNAME: a Data-Dictionary field name, child metadata of the atom before it. */
  fname: 114, // provenance: PV-0630
  /** The push button whose payload has fixed fields and two strings (#35). */
  pushbutton2: 115, // provenance: PV-0630
  tabstripButton: 116, // provenance: PV-0630
  combobox: 117, // provenance: PV-0630
  checkbutton1: 118, // provenance: PV-0630
  radiobutton1: 119, // provenance: PV-0630
  /** XMLPROP: an XML property fragment, child metadata of the atom before it. */
  xmlprop: 120, // provenance: PV-0630
  efield1: 121, // provenance: PV-0630
  ofield1: 122, // provenance: PV-0630
  /** KEYWORD_1_1. */
  keyword1_1: 123, // provenance: PV-0630
  checkbutton2: 124, // provenance: PV-0630
  /** RADIOBUTTON__0 (with a double underscore in both sources). */
  radiobutton__0: 125, // provenance: PV-0630
  combobox1: 126, // provenance: PV-0630
  frame1: 127, // provenance: PV-0630
  checkbutton3: 128, // provenance: PV-0630
  radiobutton3: 129, // provenance: PV-0630
  efield2: 130, // provenance: PV-0630
  ofield2: 131, // provenance: PV-0630
  keyword2: 132 // provenance: PV-0630
} as const

/** The name suffixes after `DIAG_DGOTYP_`, as both sources write them. */
const ELEMENT_NAMES: Record<KnownDyntElementKind, string> = {
  efield: "EFIELD",
  ofield: "OFIELD",
  keyword: "KEYWORD",
  checkbutton4: "CHECKBUTTON_4",
  radiobutton0: "RADIOBUTTON_0",
  pushbutton3: "PUSHBUTTON_3",
  frame3: "FRAME_3",
  loop6: "LOOP_6",
  subscreen: "SUBSCREEN",
  property: "PROPERTY",
  icon0: "ICON_0",
  pushbutton1: "PUSHBUTTON_1",
  fname: "FNAME",
  pushbutton2: "PUSHBUTTON_2",
  tabstripButton: "TABSTRIP_BUTTON",
  combobox: "COMBOBOX",
  checkbutton1: "CHECKBUTTON_1",
  radiobutton1: "RADIOBUTTON_1",
  xmlprop: "XMLPROP",
  efield1: "EFIELD_1",
  ofield1: "OFIELD_1",
  keyword1_1: "KEYWORD_1_1",
  checkbutton2: "CHECKBUTTON_2",
  radiobutton__0: "RADIOBUTTON__0",
  combobox1: "COMBOBOX_1",
  frame1: "FRAME_1",
  checkbutton3: "CHECKBUTTON_3",
  radiobutton3: "RADIOBUTTON_3",
  efield2: "EFIELD_2",
  ofield2: "OFIELD_2",
  keyword2: "KEYWORD_2"
}

/** The 31 kinds of the element-type table. */
export type KnownDyntElementKind = keyof typeof ELEMENT_CODES

const KNOWN_KINDS = Object.keys(ELEMENT_CODES) as KnownDyntElementKind[]
const KIND_BY_CODE = new Map<number, KnownDyntElementKind>(KNOWN_KINDS.map(kind => [ELEMENT_CODES[kind], kind]))

/**
 * The element type (`etype`, atom offset 4): the kind of screen element and the payload after the
 * header (dynt-atoms.md, "Element types"). The table has 31 entries, every value from 101 to 132
 * except 110 (PV-0630). Every byte maps to a case: a value outside the table is `unknown` and keeps
 * its byte, so nothing is lost. Kinds follow the sources' names without the `DIAG_DGOTYP_` prefix
 * (`DyntElementType.name` gives the full name). Swift's `etype == .efield2` is
 * `etype.kind === "efield2"`.
 */
export type DyntElementType =
  | { readonly kind: KnownDyntElementKind }
  /** A value outside the table; its payload is opaque (IMPL-DA-2). */
  | { readonly kind: "unknown"; readonly value: number }

/**
 * What a field element is for (R-DA-4): EFIELD an editable input field, OFIELD an output or display
 * field, KEYWORD a static label.
 */
export type DyntFieldRole = "editable" | "display" | "label"

/**
 * The two field forms: flag1 is one byte in `_1`, two bytes in `_2` (dynt-atoms.md). `v1`:
 * 121–123, flag1 is one byte; the text starts at payload offset 5. `v2`: 130–132, flag1 is a
 * u16 BE; the text starts at payload offset 6. (Swift `DyntField.Form`.)
 */
export type DyntFieldForm = "v1" | "v2"

export const DyntElementType = {
  /** The 31 element types of the table, in ascending value order. */
  known: KNOWN_KINDS.map(kind => ({ kind })) as readonly DyntElementType[],

  /** A known element type by kind (Swift `.efield2`). */
  of(kind: KnownDyntElementKind): DyntElementType {
    return { kind }
  },

  /** An `unknown` value (Swift `.unknown(byte)`); not canonical for a byte of the table. */
  unknown(value: number): DyntElementType {
    return { kind: "unknown", value }
  },

  /** The element type of an etype byte; a byte outside the table is `unknown` (Swift `init(rawValue:)`). */
  fromRaw(rawValue: number): DyntElementType {
    const kind = KIND_BY_CODE.get(rawValue)
    return kind === undefined ? { kind: "unknown", value: rawValue } : { kind }
  },

  /** The etype byte. */
  rawValue(type: DyntElementType): number {
    return type.kind === "unknown" ? type.value : ELEMENT_CODES[type.kind]
  },

  /**
   * Whether the value is one of the 31 of the table. An `unknown` built from a byte of the table is
   * not canonical; `fromRaw` never builds one.
   */
  isKnown(type: DyntElementType): boolean {
    return type.kind !== "unknown"
  },

  /** The full name as both sources write it (`DIAG_DGOTYP_EFIELD_2`), or undefined for a value outside the table. */
  name(type: DyntElementType): string | undefined {
    const canonical = canonicalKind(type)
    return canonical === undefined ? undefined : "DIAG_DGOTYP_" + ELEMENT_NAMES[canonical]
  },

  /** FNAME (114) and XMLPROP (120) are child metadata of the atom before them (IMPL-DA-4). */
  isChildMetadata(type: DyntElementType): boolean {
    const kind = canonicalKind(type)
    return kind === "fname" || kind === "xmlprop"
  },

  /**
   * The role of the EFIELD, OFIELD and KEYWORD families and their `_1` and `_2` variants (R-DA-4);
   * undefined for every other element type.
   */
  fieldRole(type: DyntElementType): DyntFieldRole | undefined {
    switch (canonicalKind(type)) {
      case "efield":
      case "efield1":
      case "efield2":
        return "editable"
      case "ofield":
      case "ofield1":
      case "ofield2":
        return "display"
      case "keyword":
      case "keyword1_1":
      case "keyword2":
        return "label"
      default:
        return undefined
    }
  },

  /**
   * The field form of 121–123 (`_1`) and 130–132 (`_2`), whose payloads are specified
   * (PV-0651–PV-0653); undefined for every other element type, including the base types 101–103,
   * whose payload is opaque.
   */
  fieldForm(type: DyntElementType): DyntFieldForm | undefined {
    switch (canonicalKind(type)) {
      case "efield1":
      case "ofield1":
      case "keyword1_1":
        return "v1"
      case "efield2":
      case "ofield2":
      case "keyword2":
        return "v2"
      default:
        return undefined
    }
  }
} as const

/** The kind of the table entry a type's byte names (a non-canonical `unknown` included), or undefined. */
function canonicalKind(type: DyntElementType): KnownDyntElementKind | undefined {
  return type.kind === "unknown" ? KIND_BY_CODE.get(type.value) : type.kind
}

// MARK: - Attributes

/**
 * The attribute byte (atom offset 12): eight independent bits (dynt-atoms.md, "Attribute byte";
 * PV-0620–PV-0627). The sources give the names only; apart from INVISIBLE, what each bit means for
 * rendering is not stated. A value is the byte itself (Swift `OptionSet`).
 */
export type DyntAttributes = number

export const DyntAttributes = {
  protected: 0x01, // provenance: PV-0620
  /**
   * A password field: its value is never printed, logged or decoded to a `string` (IMPL-DA-1,
   * PV-0621).
   */
  invisible: 0x02, // provenance: PV-0621
  intensify: 0x04, // provenance: PV-0622
  justRight: 0x08, // provenance: PV-0623
  matchCode: 0x10, // provenance: PV-0624
  propFont: 0x20, // provenance: PV-0625
  yes3D: 0x40, // provenance: PV-0626
  comboStyle: 0x80, // provenance: PV-0627

  /**
   * Every bit with its name as the spec's table writes it, in ascending mask order. The eight names
   * cover all eight bits, so nothing set is ever left unnamed.
   */
  named: [
    { attribute: 0x01, name: "PROTECTED" },
    { attribute: 0x02, name: "INVISIBLE" },
    { attribute: 0x04, name: "INTENSIFY" },
    { attribute: 0x08, name: "JUSTRIGHT" },
    { attribute: 0x10, name: "MATCHCODE" },
    { attribute: 0x20, name: "PROPFONT" },
    { attribute: 0x40, name: "YES3D" },
    { attribute: 0x80, name: "COMBOSTYLE" }
  ] as readonly { readonly attribute: number; readonly name: string }[],

  /** Names of the bits that are set, in ascending mask order (PROTECTED first). */
  names(attributes: DyntAttributes): string[] {
    return DyntAttributes.named.filter(entry => (attributes & entry.attribute) !== 0).map(entry => entry.name)
  },

  /** INVISIBLE is set: the atom is a password field (IMPL-DA-1). */
  isPasswordField(attributes: DyntAttributes): boolean {
    return (attributes & DyntAttributes.invisible) !== 0
  }
} as const

// MARK: - Dialog flags

/**
 * The two dlg_flag bytes (atom offsets 2 and 3). Neither source documents their bits (#34), so they
 * are carried through verbatim and never interpreted.
 */
export class DyntDialogFlags {
  /**
   * The bit of dlg_flag_2 that open-diag-go's live-tested client sets on every field it returns
   * changed (PV-0777). Its meaning is not documented, so it is a Reading (client-input.md R-CI-13)
   * and #34 stays open.
   */
  static readonly changedBitOfFlag2 = 0x01 // provenance: PV-0777

  /** dlg_flag_1, atom offset 2 (PV-0604). */
  readonly flag1: number
  /** dlg_flag_2, atom offset 3 (PV-0605). */
  readonly flag2: number

  constructor(fields: { flag1: number; flag2: number }) {
    this.flag1 = fields.flag1
    this.flag2 = fields.flag2
  }

  /**
   * Whether the flags mark the field as changed. Blocked: which bit does is spec gap #34, so this
   * always throws `DyntSpecGapError` with issue 34.
   */
  isChanged(): boolean {
    throw new DyntSpecGapError({ kind: "specGap", issue: CodecSpecGap.dyntDialogFlags })
  }

  /**
   * The flags a client returns for a field the user edited. Blocked on spec gap #34, like
   * `isChanged()`: encoding user input the server accepts needs it (dynt-atoms.md, "User input").
   */
  markedChanged(): DyntDialogFlags {
    throw new DyntSpecGapError({ kind: "specGap", issue: CodecSpecGap.dyntDialogFlags })
  }

  /**
   * The flags with `changedBitOfFlag2` set in dlg_flag_2 and everything else as it was (Reading
   * R-CI-13, unconfirmed): what the reference envelope returns for an edited field.
   */
  withChangedBit(): DyntDialogFlags {
    return new DyntDialogFlags({ flag1: this.flag1, flag2: this.flag2 | DyntDialogFlags.changedBitOfFlag2 })
  }
}

// MARK: - Header

/** The fields of a `DyntAtomHeader`; everything but `etype` defaults to 0. */
export interface DyntAtomHeaderFields {
  etype: DyntElementType
  dialogFlags?: DyntDialogFlags
  area?: number
  block?: number
  group?: number
  row?: number
  col?: number
  attributes?: DyntAttributes
}

/**
 * The header fields of an atom other than its length: the parts a caller chooses when it builds an
 * atom (`DyntAtomEncoder`) and the parts `DyntAtom` reports.
 */
export class DyntAtomHeader {
  readonly dialogFlags: DyntDialogFlags
  readonly etype: DyntElementType
  readonly area: number
  readonly block: number
  readonly group: number
  readonly row: number
  readonly col: number
  readonly attributes: DyntAttributes

  constructor(fields: DyntAtomHeaderFields) {
    this.dialogFlags = fields.dialogFlags ?? new DyntDialogFlags({ flag1: 0, flag2: 0 })
    this.etype = fields.etype
    this.area = fields.area ?? 0
    this.block = fields.block ?? 0
    this.group = fields.group ?? 0
    this.row = fields.row ?? 0
    this.col = fields.col ?? 0
    this.attributes = fields.attributes ?? 0
  }
}

// MARK: - Payloads

/**
 * A `_1` (121–123) or `_2` (130–132) field atom whose dlen fills the rest of the atom, the only case
 * the spec states (PV-0651–PV-0653). Ranges are offsets into the item value.
 */
export class DyntField {
  readonly form: DyntFieldForm
  /** flag1: one byte (`_1`, widened) or u16 BE (`_2`). Not interpreted. */
  readonly flag1: number
  /** The text's byte length (PV-0652, PV-0653). */
  readonly dlen: number
  /** The on-screen width in characters (pysap-only). */
  readonly mlen: number
  /** The maximum number of characters the user may enter (pysap-only). */
  readonly maxNrChars: number
  /**
   * The text: the caption of a label, the current value of an input field. Decode it with
   * `DyntText` when needed; never for a password field (IMPL-DA-1).
   */
  readonly textRange: ByteRange

  constructor(fields: { form: DyntFieldForm; flag1: number; dlen: number; mlen: number; maxNrChars: number; textRange: ByteRange }) {
    this.form = fields.form
    this.flag1 = fields.flag1
    this.dlen = fields.dlen
    this.mlen = fields.mlen
    this.maxNrChars = fields.maxNrChars
    this.textRange = fields.textRange
  }
}

/** A frame atom (127): its size and caption (PV-0654). */
export class DyntFrame {
  readonly drows: number
  readonly dcols: number
  /** The caption, `atom_length − 17` bytes. */
  readonly textRange: ByteRange

  constructor(fields: { drows: number; dcols: number; textRange: ByteRange }) {
    this.drows = fields.drows
    this.dcols = fields.dcols
    this.textRange = fields.textRange
  }
}

/** The fields of a `DyntTabstripButton`. */
export interface DyntTabstripButtonFields {
  vLength: number
  vHeight: number
  pageID: number
  functionCodeOffset: number
  textOffset: number
  idOffset: number
  textRange: ByteRange
  functionCodeRange: ByteRange
  idRange: ByteRange
  trailingByteCount: number
}

/**
 * A tabstrip-button atom (116): fixed fields, then the text, the function code and the id, each
 * terminated by a zero byte (PV-0656). The three `*Offset` fields are reported as numbers only:
 * neither source says what they are measured from.
 */
export class DyntTabstripButton implements DyntTabstripButtonFields {
  readonly vLength: number
  readonly vHeight: number
  readonly pageID: number
  readonly functionCodeOffset: number
  readonly textOffset: number
  readonly idOffset: number
  /** The three strings, without their zero bytes. */
  readonly textRange: ByteRange
  readonly functionCodeRange: ByteRange
  readonly idRange: ByteRange
  /** Bytes after the third zero byte. The spec says nothing about them (#38); they are reported, not interpreted. */
  readonly trailingByteCount: number

  constructor(fields: DyntTabstripButtonFields) {
    this.vLength = fields.vLength
    this.vHeight = fields.vHeight
    this.pageID = fields.pageID
    this.functionCodeOffset = fields.functionCodeOffset
    this.textOffset = fields.textOffset
    this.idOffset = fields.idOffset
    this.textRange = fields.textRange
    this.functionCodeRange = fields.functionCodeRange
    this.idRange = fields.idRange
    this.trailingByteCount = fields.trailingByteCount
  }
}

/** The three strings of a tabstrip-button atom, in wire order (PV-0656). */
export type DyntTabstripString = "text" | "functionCode" | "id"
export const DyntTabstripString = { allCases: ["text", "functionCode", "id"] as readonly DyntTabstripString[] } as const

/**
 * A push-button atom (115): its fixed fields (PV-0657). How the two strings after them (text, then
 * function code) are delimited is a conflict between the sources (#35), so they stay one opaque
 * range.
 */
export class DyntPushButton {
  readonly vLength: number
  readonly vHeight: number
  readonly functionCodeOffset: number
  readonly textOffset: number
  /** The bytes after the fixed fields, not decoded (#35, IMPL-DA-2). */
  readonly stringsRange: ByteRange

  constructor(fields: { vLength: number; vHeight: number; functionCodeOffset: number; textOffset: number; stringsRange: ByteRange }) {
    this.vLength = fields.vLength
    this.vHeight = fields.vHeight
    this.functionCodeOffset = fields.functionCodeOffset
    this.textOffset = fields.textOffset
    this.stringsRange = fields.stringsRange
  }

  /** The caption's bytes. Blocked on spec gap #35: always throws. */
  textRange(): ByteRange {
    throw new DyntSpecGapError({ kind: "specGap", issue: CodecSpecGap.dyntButtonStrings })
  }
}

/**
 * A radio-button atom (129): its fixed fields (PV-0655). Which bytes form its text is a conflict
 * between the sources (#35), so the rest of the atom stays one opaque range.
 */
export class DyntRadioButton {
  readonly button: number
  readonly visibleLabelLength: number
  readonly eventIDOffset: number
  readonly eventIDLength: number
  readonly textOffset: number
  readonly textLength: number
  /** The bytes after the fixed fields, not decoded (#35, IMPL-DA-2). */
  readonly restRange: ByteRange

  constructor(fields: {
    button: number
    visibleLabelLength: number
    eventIDOffset: number
    eventIDLength: number
    textOffset: number
    textLength: number
    restRange: ByteRange
  }) {
    this.button = fields.button
    this.visibleLabelLength = fields.visibleLabelLength
    this.eventIDOffset = fields.eventIDOffset
    this.eventIDLength = fields.eventIDLength
    this.textOffset = fields.textOffset
    this.textLength = fields.textLength
    this.restRange = fields.restRange
  }

  /** The text's bytes. Blocked on spec gap #35: always throws. */
  textRange(): ByteRange {
    throw new DyntSpecGapError({ kind: "specGap", issue: CodecSpecGap.dyntButtonStrings })
  }
}

/**
 * Why a payload whose layout the spec specifies was kept opaque. The atom's own length is valid, so
 * the walk goes on with the next atom: IMPL-DA-6 for a dlen mismatch, and by analogy, until spec
 * gap #38 gives a rule, for the other two cases. The walker counts each case in its
 * `DyntAtomDiagnostics`.
 */
export type DyntPayloadProblem =
  /** The payload is shorter than the element type's fixed fields. */
  | { readonly kind: "shortContent"; readonly needed: number; readonly available: number }
  /** A field atom whose dlen differs from the bytes after its fixed fields: the sources read different bytes (#36, IMPL-DA-6). */
  | { readonly kind: "dlenMismatch"; readonly dlen: number; readonly remaining: number }
  /** A tabstrip-button string has no terminating zero byte before the end of the atom. */
  | { readonly kind: "unterminatedString"; readonly value: DyntTabstripString }

export const DyntPayloadProblem = {
  /**
   * The spec-gap issue behind the problem: #36 for a dlen mismatch (the sources conflict), #38 for
   * a payload that does not fit its fixed layout (the spec has no rule for it yet).
   */
  specGapIssue(problem: DyntPayloadProblem): number {
    switch (problem.kind) {
      case "dlenMismatch":
        return CodecSpecGap.dyntDlenMismatch
      case "shortContent":
      case "unterminatedString":
        return CodecSpecGap.dyntMalformedPayload
    }
  }
} as const

/**
 * The payload of an atom, decoded by its element type (dynt-atoms.md, step 6 of "Walking an atom
 * sequence"). Every range is an offset range into the item value.
 */
export type DyntPayload =
  /**
   * No payload layout is specified for the element type, or the type is unknown: the payload is
   * the opaque `DyntAtom.contentRange` (IMPL-DA-2).
   */
  | { readonly kind: "opaque" }
  /** FNAME (114) or XMLPROP (120): the whole payload is one text (PV-0650). */
  | { readonly kind: "text"; readonly value: ByteRange }
  /** 121–123 and 130–132 (PV-0651–PV-0653). */
  | { readonly kind: "field"; readonly value: DyntField }
  /** 127 (PV-0654). */
  | { readonly kind: "frame"; readonly value: DyntFrame }
  /** 116 (PV-0656). */
  | { readonly kind: "tabstripButton"; readonly value: DyntTabstripButton }
  /** 115: fixed fields only (PV-0657; strings #35). */
  | { readonly kind: "pushButton"; readonly value: DyntPushButton }
  /** 129: fixed fields only (PV-0655; text #35). */
  | { readonly kind: "radioButton"; readonly value: DyntRadioButton }
  /** A specified layout that this payload does not fit; the payload stays opaque. */
  | { readonly kind: "undecodable"; readonly value: DyntPayloadProblem }

// MARK: - Atom

/** The fields of a `DyntAtom`. */
export interface DyntAtomFields {
  index: number
  offset: number
  length: number
  header: DyntAtomHeader
  payload: DyntPayload
  parentIndex: number | undefined
}

/**
 * One atom of a DYNT atom sequence: its header fields and where its parts are, never a copy of its
 * bytes (IMPL-DA-5). Offsets are relative to the start of the item value the walker was given.
 */
export class DyntAtom {
  /** 1-based position of the atom in the sequence. */
  readonly index: number
  /** Offset of the atom's first byte (its length field). */
  readonly offset: number
  /** atom_length: the whole atom, its own length field included (PV-0603). At least 13. */
  readonly length: number
  /** The header fields other than the length. */
  readonly header: DyntAtomHeader
  /** The payload decoded by element type. */
  readonly payload: DyntPayload
  /**
   * For FNAME (114) and XMLPROP (120): the index of the most recent atom of another type, which this
   * one belongs to (IMPL-DA-4). Undefined for every other type, and for an orphan child (a 114 or
   * 120 with no preceding atom of another type).
   */
  readonly parentIndex: number | undefined

  constructor(fields: DyntAtomFields) {
    this.index = fields.index
    this.offset = fields.offset
    this.length = fields.length
    this.header = fields.header
    this.payload = fields.payload
    this.parentIndex = fields.parentIndex
  }

  get dialogFlags(): DyntDialogFlags {
    return this.header.dialogFlags
  }
  get etype(): DyntElementType {
    return this.header.etype
  }
  get area(): number {
    return this.header.area
  }
  get block(): number {
    return this.header.block
  }
  get group(): number {
    return this.header.group
  }
  get row(): number {
    return this.header.row
  }
  get col(): number {
    return this.header.col
  }
  get attributes(): DyntAttributes {
    return this.header.attributes
  }

  /** The payload after the 13-byte header: `atom_length − 13` bytes (PV-0603). */
  get contentRange(): ByteRange {
    return new ByteRange(this.offset + DyntAtomLayout.headerSize, this.offset + this.length)
  }

  /** Offset of the byte after the atom, where the next atom starts. */
  get endOffset(): number {
    return this.offset + this.length
  }

  /**
   * The range of the atom's decoded text, for the element types whose payload is one text: FNAME
   * and XMLPROP, the field variants, the frame caption and the tabstrip-button caption. Undefined
   * when the payload has no decoded text (opaque, the button strings of #35, a problem).
   */
  get textRange(): ByteRange | undefined {
    switch (this.payload.kind) {
      case "text":
        return this.payload.value
      case "field":
      case "frame":
      case "tabstripButton":
        return this.payload.value.textRange
      case "opaque":
      case "pushButton":
      case "radioButton":
      case "undecodable":
        return undefined
    }
  }

  /** INVISIBLE is set: a password field (IMPL-DA-1, PV-0621), whatever the element type. */
  get isPasswordField(): boolean {
    return DyntAttributes.isPasswordField(this.header.attributes)
  }

  /** FNAME or XMLPROP with no preceding atom of another type (IMPL-DA-4). */
  get isOrphanChild(): boolean {
    return DyntElementType.isChildMetadata(this.header.etype) && this.parentIndex === undefined
  }
}

// MARK: - Carrier

/**
 * Whether the item's value is a DYNT atom sequence: DYNT_ATOM (0x09/0x02, PV-0600) or
 * DYNT_TABSTRIP_BUTTONS (0x09/0x10, PV-0601). Decided on (id, sid) alone, under APPL and APPL4
 * alike (IMPL-IT-9). (Swift: `extension ApplItem`, `item.carriesDyntAtoms`.)
 */
export function applItemCarriesDyntAtoms(item: ApplItem): boolean {
  return ApplItem.equals(item, ApplItem.dynt("atom")) || ApplItem.equals(item, ApplItem.dynt("tabstripButtons"))
}
