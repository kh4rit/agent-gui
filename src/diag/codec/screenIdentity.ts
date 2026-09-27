// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ScreenIdentity.swift (MIT).

// Screen identity (docs/protocol/server-screen.md §6, §7): what a client reads from one server
// message to know which screen it shows — the identity texts, the area size, the DYNT atoms and
// the menus — and the field structure the auto-login guard checks (docs/credentials.md §5.1).
//
// The input is a message's item sequence: the bytes after the DIAG header of an uncompressed
// message with err_no 0, or the decompressed bytes of a compressed one (`DiagMessage`,
// `Decompressor`). The decoder depends on no item order and on no particular item (R-SS-7); a
// leading DIALOG_STEP_NUMBER or a trailing EOM changes nothing (R-SE-2).

import { ApplItem } from "./applRegistry.js"
import { ByteRange, CodecSpecGap, ItemPayloadError } from "./diagCodec.js"
import { DiagItemWalkError, DiagItemWalker, type DiagItem } from "./diagItem.js"
import { DyntElementType, type DyntAtom, type DyntField } from "./dyntAtom.js"
import { DyntAtomDiagnostics, DyntAtomWalkError, DyntAtomWalker } from "./dyntAtomWalker.js"
import { MenuEntryWalkError, MenuEntryWalker } from "./menuEntries.js"
import { ScreenText } from "./screenText.js"
import { AreaSize, ScreenSpecGapError } from "./screenValues.js"

/**
 * The screen-identity texts of server-screen.md §7, each the whole value of one APPL item.
 * - `dbName`: ST_R3INFO DBNAME (0x06/0x02), PV-0534.
 * - `client`: ST_R3INFO CLIENT (0x06/0x0C), PV-0534.
 * - `cpuName`: ST_R3INFO CPUNAME (0x06/0x03), PV-0534.
 * - `tcode`: ST_R3INFO TCODE (0x06/0x07), PV-0534.
 * - `dynproName`: ST_R3INFO DYNPRONAME (0x06/0x0D): the program name (§6.1), PV-0707.
 * - `dynproNumber`: ST_R3INFO DYNPRONUMBER (0x06/0x0E): the screen number (§6.1), PV-0707.
 * - `cuaName`: ST_R3INFO CUANAME (0x06/0x0F): the program that owns the GUI status, PV-0707.
 * - `cuaStatus`: ST_R3INFO CUASTATUS (0x06/0x10): the GUI status name, PV-0707.
 * - `guiTheme`: ST_R3INFO GUI_THEME (0x06/0x25), PV-0707.
 * - `sessionTitle`: VARINFO SESSION_TITLE (0x0C/0x09), PV-0708.
 * - `sessionIcon`: VARINFO SESSION_ICON (0x0C/0x0A), PV-0708.
 */
export type ScreenIdentityText =
  | "dbName"
  | "client"
  | "cpuName"
  | "tcode"
  | "dynproName"
  | "dynproNumber"
  | "cuaName"
  | "cuaStatus"
  | "guiTheme"
  | "sessionTitle"
  | "sessionIcon"

const IDENTITY_TEXTS: readonly ScreenIdentityText[] = [
  "dbName",
  "client",
  "cpuName",
  "tcode",
  "dynproName",
  "dynproNumber",
  "cuaName",
  "cuaStatus",
  "guiTheme",
  "sessionTitle",
  "sessionIcon"
]

export const ScreenIdentityText = {
  allCases: IDENTITY_TEXTS,

  /** The item that carries the text. */
  item(text: ScreenIdentityText): ApplItem {
    switch (text) {
      case "sessionTitle":
      case "sessionIcon":
        return ApplItem.varInfo(text)
      default:
        return ApplItem.stSystemInfo(text)
    }
  },

  /** The identity text `item` carries, or undefined when it carries none (Swift `init?(_:)`). */
  of(item: ApplItem): ScreenIdentityText | undefined {
    switch (item.kind) {
      case "stSystemInfo":
        switch (item.sid) {
          case "dbName":
          case "client":
          case "cpuName":
          case "tcode":
          case "dynproName":
          case "dynproNumber":
          case "cuaName":
          case "cuaStatus":
          case "guiTheme":
            return item.sid
          default:
            return undefined
        }
      case "varInfo":
        return item.sid === "sessionTitle" || item.sid === "sessionIcon" ? item.sid : undefined
      default:
        return undefined
    }
  }
} as const

/**
 * Why the screen identity of a message could not be read. Each drops the whole message, as the
 * walks it reports do.
 * - `items`: the item walk stopped (IMPL-IT-2, IMPL-IT-5).
 * - `atoms`: the atom walk of the DYNT_ATOM item at `itemIndex` stopped (IMPL-DA-3).
 */
export type ScreenIdentityErrorInfo =
  | { readonly kind: "items"; readonly value: DiagItemWalkError }
  | { readonly kind: "atoms"; readonly value: DyntAtomWalkError; readonly itemIndex: number }

export class ScreenIdentityError extends Error {
  constructor(readonly info: ScreenIdentityErrorInfo) {
    super(info.kind === "items" ? `screen identity: ${info.value.message}` : `screen identity: item ${info.itemIndex}: ${info.value.message}`)
    this.name = "ScreenIdentityError"
  }
}

/** What the identity read left undecoded without dropping the message. */
export class ScreenIdentityDiagnostics {
  /**
   * Values that failed their layout, for example an AREASIZE that is not 16 bytes. Only that item
   * stays undecoded (IMPL-SS-3).
   */
  undecodableValues = 0
  /** MNUENTRY items whose entry walk stopped; the entries before the stop count (IMPL-SS-5). */
  stoppedMenus = 0
  /**
   * MNUENTRY items with a sid other than MENU_ACT…MENU_KYB: counted as menus, but their layout is
   * not stated (PV-0720 covers the four sids; #33), so they are not walked.
   */
  unwalkedMenus = 0
  /**
   * Identity items (the texts and AREASIZE) that appeared more than once in one window section
   * (Reading R-EL-23). Which occurrence counts is #54.
   */
  repeatedIdentityItems = 0
  /** The atom walks' own diagnostics, summed over all DYNT_ATOM items. */
  atoms = new DyntAtomDiagnostics()

  /** Whether nothing was left undecoded or ambiguous. */
  get isClean(): boolean {
    return (
      this.undecodableValues === 0 && this.stoppedMenus === 0 && this.unwalkedMenus === 0 && this.repeatedIdentityItems === 0 && this.atoms.isClean
    )
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): ScreenIdentityDiagnostics {
    const copy = Object.assign(new ScreenIdentityDiagnostics(), this)
    copy.atoms = this.atoms.clone()
    return copy
  }
}

/** Adds `other`'s counts to `diagnostics` (Swift's internal `extension DyntAtomDiagnostics`, `add(_:)`). */
function addAtomDiagnostics(diagnostics: DyntAtomDiagnostics, other: DyntAtomDiagnostics): void {
  diagnostics.orphanChildren += other.orphanChildren
  diagnostics.dlenMismatches += other.dlenMismatches
  diagnostics.malformedPayloads += other.malformedPayloads
  diagnostics.unknownElementTypes += other.unknownElementTypes
  diagnostics.opaquePayloads += other.opaquePayloads
  diagnostics.undecodedButtonStrings += other.undecodedButtonStrings
}

/**
 * One identity item: where its text lies and how often it appeared. The range is exposed only when
 * the item appeared once; which occurrence counts otherwise is #54.
 */
class Slot {
  range: ByteRange | undefined
  occurrences = 0

  record(range: ByteRange): void {
    this.range = range
    this.occurrences += 1
  }
}

/** The identity items of one window section (Reading R-EL-23). */
class Section {
  readonly slots: Record<ScreenIdentityText, Slot> = {
    dbName: new Slot(),
    client: new Slot(),
    cpuName: new Slot(),
    tcode: new Slot(),
    dynproName: new Slot(),
    dynproNumber: new Slot(),
    cuaName: new Slot(),
    cuaStatus: new Slot(),
    guiTheme: new Slot(),
    sessionTitle: new Slot(),
    sessionIcon: new Slot()
  }
  area: AreaSize | undefined
  areaOccurrences = 0
}

/**
 * The texts that name the session rather than a window: the first section's stand in when the last
 * section lacks them (Reading R-EL-23).
 */
function namesSession(text: ScreenIdentityText): boolean {
  return text === "tcode" || text === "client" || text === "dbName" || text === "cpuName"
}

/**
 * The identity of the screen one server message shows (server-screen.md §7): the identity texts,
 * the area size, and counts of the atoms, input fields, password fields, menus and menu entries.
 * Texts are byte ranges into the item sequence, trimmed per R-SS-4; nothing is copied and no text
 * is decoded.
 *
 * An absent item leaves its value unknown (undefined). What an absent item means on a later
 * screen, and which occurrence counts when an identity item appears twice in one message, are #54:
 * the accessors of such an item throw `ScreenSpecGapError` with issue 54, and the rest of the
 * identity stands.
 *
 * A message of several window sections (elements.md Reading R-EL-23, PV-0984) describes several
 * windows: each SES item after the first opens a new section, the items before the first SES belong
 * to the first, and the last section is the top window. The identity texts and AREASIZE are the
 * last section's, so an item once in each of two sections is no repeat; TCODE, CLIENT, DBNAME and
 * CPUNAME, which name the session rather than a window, come from the first section when the last
 * lacks them. The counts of atoms, fields and menus stay the whole message's.
 */
export class ScreenIdentity {
  /**
   * The logon program's name, which R-SS-5 compares the trimmed DYNPRONAME with (PV-0707;
   * credentials.md §5.1). It is the one name the spec lets the client and the fake server use
   * (IMPL-SS-1).
   */
  static readonly logonProgramName: Uint8Array = new TextEncoder().encode("SAPMSYST")

  /** The section being read: at the end, the last one, the top window. */
  private section = new Section()
  /** The first section, once a second SES closed it: where the session's texts come from when the last section lacks them. */
  private firstSection: Section | undefined

  private _windowSections = 0
  private _atomCount = 0
  private _inputFieldCount = 0
  private _passwordFieldCount = 0
  private _menuCount = 0
  private _menuEntryCount = 0
  private readonly _diagnostics = new ScreenIdentityDiagnostics()

  private constructor() {}

  /** The SES items of the message: its window sections (Reading R-EL-23), 0 without SES. */
  get windowSections(): number {
    return this._windowSections
  }
  /** Atoms in all DYNT_ATOM items (0x09/0x02, APPL or APPL4); whether several such items form one screen is #54. */
  get atomCount(): number {
    return this._atomCount
  }
  /** Atoms of the EFIELD family (etypes 101, 121, 130; R-DA-4): the input fields. */
  get inputFieldCount(): number {
    return this._inputFieldCount
  }
  /** Input fields with INVISIBLE (0x02, PV-0621) set: the password fields (IMPL-DA-1). */
  get passwordFieldCount(): number {
    return this._passwordFieldCount
  }
  /** MNUENTRY items (id 0x0B, any sid). */
  get menuCount(): number {
    return this._menuCount
  }
  /** Entries in all MNUENTRY items, including those before a stopped walk (IMPL-SS-5). */
  get menuEntryCount(): number {
    return this._menuEntryCount
  }
  /** What was left undecoded or ambiguous (a copy). */
  get diagnostics(): ScreenIdentityDiagnostics {
    return this._diagnostics.clone()
  }

  /**
   * Reads the identity of the screen in the item sequence `items` (Swift `init(items:)`).
   *
   * Fails when the item walk or the atom walk of a DYNT_ATOM item stops, which drops the message
   * (IMPL-IT-2, IMPL-DA-3). A value that fails its own layout (IMPL-SS-3) or a menu entry walk that
   * stops (IMPL-SS-5) only counts in `diagnostics`.
   *
   * With `fields` (for `LogonFieldStructure`, Swift's internal `init(items:fields:collectFields:)`),
   * every input field atom is appended to it with its FNAME child.
   */
  static decode(items: Uint8Array, fields?: LogonInputField[]): ScreenIdentity {
    const identity = new ScreenIdentity()
    identity.read(items, fields)
    return identity
  }

  private read(items: Uint8Array, fields: LogonInputField[] | undefined): void {
    const walker = new DiagItemWalker()
    for (;;) {
      let item: DiagItem | undefined
      try {
        item = walker.next(items)
      } catch (error) {
        if (!(error instanceof DiagItemWalkError)) throw error
        throw new ScreenIdentityError({ kind: "items", value: error })
      }
      if (item === undefined) break
      if (item.type === "ses") {
        this.startSection()
        continue
      }
      const appl = item.appl
      if (appl === undefined) continue
      const value = item.valueRange.of(items)
      const text = ScreenIdentityText.of(appl)
      if (text !== undefined) {
        const trimmed = ScreenText.trimmedRange(value)
        this.record(text, new ByteRange(item.valueOffset + trimmed.lowerBound, item.valueOffset + trimmed.upperBound))
        continue
      }
      if (appl.kind === "varInfo" && appl.sid === "areaSize") {
        this.section.areaOccurrences += 1
        if (this.section.areaOccurrences > 1) {
          this._diagnostics.repeatedIdentityItems += 1
        } else {
          const size = decodeAreaSize(value)
          if (size !== undefined) this.section.area = size
          else this._diagnostics.undecodableValues += 1
        }
      } else if (appl.kind === "dynt" && appl.sid === "atom") {
        this.readAtoms(value, item, fields)
      } else if (appl.kind === "mnuEntry") {
        this.readMenu(value)
      } else if (appl.kind === "unknownSID" && appl.applID === "mnuEntry") {
        this._menuCount += 1
        this._diagnostics.unwalkedMenus += 1
      }
    }
  }

  /**
   * An SES item (Reading R-EL-23): the first opens the first section, which keeps the items before
   * it; each later one closes the section before it and opens a new one.
   */
  private startSection(): void {
    this._windowSections += 1
    if (!(this._windowSections > 1)) return
    if (this.firstSection === undefined) this.firstSection = this.section
    this.section = new Section()
  }

  private record(text: ScreenIdentityText, range: ByteRange): void {
    const slot = this.section.slots[text]
    slot.record(range)
    if (slot.occurrences > 1) this._diagnostics.repeatedIdentityItems += 1
  }

  /** The top window's slot of `text`: the last section's, else, for a text that names the session, the first section's. */
  private slot(text: ScreenIdentityText): Slot {
    const own = this.section.slots[text]
    if (!(own.occurrences === 0 && namesSession(text) && this.firstSection !== undefined)) return own
    return this.firstSection.slots[text]
  }

  /** Walks the atoms of one DYNT_ATOM item value; a stop drops the message (IMPL-DA-3). */
  private readAtoms(value: Uint8Array, item: DiagItem, fields: LogonInputField[] | undefined): void {
    const walker = new DyntAtomWalker()
    // The index (in `fields`) and atom index of this item's latest input field, whose FNAME child
    // may follow (IMPL-DA-4).
    let latestField: { position: number; atomIndex: number } | undefined
    for (;;) {
      let atom: DyntAtom | undefined
      try {
        atom = walker.next(value)
      } catch (error) {
        if (!(error instanceof DyntAtomWalkError)) throw error
        throw new ScreenIdentityError({ kind: "atoms", value: error, itemIndex: item.index })
      }
      if (atom === undefined) break
      this._atomCount += 1
      if (DyntElementType.fieldRole(atom.etype) === "editable") {
        this._inputFieldCount += 1
        if (atom.isPasswordField) this._passwordFieldCount += 1
        if (fields !== undefined) {
          fields.push(new LogonInputField({ itemIndex: item.index, itemValue: item.valueRange, atom }))
          latestField = { position: fields.length - 1, atomIndex: atom.index }
        }
      } else if (
        atom.etype.kind === "fname" &&
        latestField !== undefined &&
        fields !== undefined &&
        atom.parentIndex === latestField.atomIndex &&
        fields[latestField.position].fieldName === undefined
      ) {
        fields[latestField.position].fieldName = atom.textRange
      } else if (!DyntElementType.isChildMetadata(atom.etype)) {
        latestField = undefined
      }
    }
    addAtomDiagnostics(this._diagnostics.atoms, walker.diagnostics)
  }

  /** Walks the entries of one MNUENTRY value; a stop keeps the entries before it (IMPL-SS-5). */
  private readMenu(value: Uint8Array): void {
    this._menuCount += 1
    const walker = new MenuEntryWalker()
    try {
      while (walker.next(value) !== undefined) this._menuEntryCount += 1
    } catch (error) {
      if (!(error instanceof MenuEntryWalkError)) throw error
      this._diagnostics.stoppedMenus += 1
    }
  }

  // MARK: Reading the identity

  /**
   * Where the text of `field` lies in the item sequence, trimmed per R-SS-4, or undefined when the
   * message does not carry it: the top window's (Reading R-EL-23). Throws `ScreenSpecGapError` with
   * issue 54 when its section carries it more than once.
   */
  text(field: ScreenIdentityText): ByteRange | undefined {
    const slot = this.slot(field)
    if (!(slot.occurrences <= 1)) throw new ScreenSpecGapError({ kind: "specGap", issue: CodecSpecGap.identityItemRepeats })
    return slot.range
  }

  /**
   * How often the top window's section carries the item of `field` (the first section's count for
   * a session text the last section lacks, Reading R-EL-23). (Swift `occurrences(of:)`.)
   */
  occurrences(field: ScreenIdentityText): number {
    return this.slot(field).occurrences
  }

  /** The program name: DYNPRONAME, trimmed (server-screen.md §6.1). */
  programName(): ByteRange | undefined {
    return this.text("dynproName")
  }

  /** The screen number: DYNPRONUMBER, trimmed (server-screen.md §6.1). */
  screenNumber(): ByteRange | undefined {
    return this.text("dynproNumber")
  }

  /**
   * The top window's VARINFO AREASIZE value, or undefined when its section carries none or one that
   * is not 16 bytes (counted in `diagnostics`). Throws issue 54 when the section carries it twice.
   */
  areaSize(): AreaSize | undefined {
    if (!(this.section.areaOccurrences <= 1)) throw new ScreenSpecGapError({ kind: "specGap", issue: CodecSpecGap.identityItemRepeats })
    return this.section.area
  }

  /** How often the top window's section carries VARINFO AREASIZE. */
  get areaSizeOccurrences(): number {
    return this.section.areaOccurrences
  }

  /**
   * Whether the screen is the logon program (R-SS-5): DYNPRONAME, trimmed per R-SS-4, equals
   * `logonProgramName`. `items` is the item sequence this identity was read from.
   */
  isLogonProgram(items: Uint8Array): boolean {
    const range = this.programName()
    if (range === undefined) return false
    return ScreenText.trimmedEquals(range.of(items), ScreenIdentity.logonProgramName)
  }
}

/** Swift `try? AreaSize(value:)`. */
function decodeAreaSize(value: Uint8Array): AreaSize | undefined {
  try {
    return AreaSize.decode(value)
  } catch (error) {
    if (error instanceof ItemPayloadError) return undefined
    throw error
  }
}

// MARK: - Logon field structure

/**
 * One input field of a logon-style screen: an atom of the EFIELD family (R-DA-4), with the FNAME
 * child that follows it, if any (IMPL-DA-4).
 */
export class LogonInputField {
  /** The index of the DYNT_ATOM item the atom came from, in the item sequence. */
  readonly itemIndex: number
  /** Where that item's value lies in the item sequence. The atom's ranges, and `fieldName`, are offsets into this value. */
  readonly itemValue: ByteRange
  /** The input atom. */
  readonly atom: DyntAtom
  /** The text of the FNAME child (a Data Dictionary field name), or undefined when none follows. Set by the reader only. */
  fieldName: ByteRange | undefined

  constructor(fields: { itemIndex: number; itemValue: ByteRange; atom: DyntAtom; fieldName?: ByteRange }) {
    this.itemIndex = fields.itemIndex
    this.itemValue = fields.itemValue
    this.atom = fields.atom
    this.fieldName = fields.fieldName
  }

  /** INVISIBLE is set: the password field (PV-0621, IMPL-DA-1). */
  get isPasswordField(): boolean {
    return this.atom.isPasswordField
  }

  /**
   * The field payload of an EFIELD_1 (121) or EFIELD_2 (130) atom whose dlen fills the atom;
   * undefined for EFIELD (101), whose payload is opaque (IMPL-DA-2), and for a payload that did not
   * decode (#36, #38).
   */
  get field(): DyntField | undefined {
    return this.atom.payload.kind === "field" ? this.atom.payload.value : undefined
  }

  /** The most characters the field accepts (maxnrchars), when the payload decoded. */
  get maxNrChars(): number | undefined {
    return this.field?.maxNrChars
  }
}

/**
 * The field structure of a logon-style screen, which the auto-login guard checks before it sends
 * anything (credentials.md §5.1; server-screen.md §6.2, §8.2):
 * - the screen is the logon program (R-SS-5, `isLogonProgram`);
 * - there is exactly one password field, the one EFIELD-family atom with INVISIBLE set (R-SS-9,
 *   `passwordField`), and its maxnrchars bounds the password length;
 * - the other inputs are told apart by their maxnrchars, not by row or column (R-SS-9,
 *   `inputFieldsWithMaxNrChars`). Which lengths a real server uses is not in the sources (PV-0724
 *   holds the example's); the guard's policy chooses them.
 *
 * Positions are never used: the guard finds fields by attributes and lengths only.
 */
export class LogonFieldStructure {
  private constructor(
    /** The screen's identity, read in the same walk. */
    readonly identity: ScreenIdentity,
    /** Every input field (EFIELD family) in item and atom order. */
    readonly inputFields: readonly LogonInputField[]
  ) {}

  /** Reads the identity and the input fields of the screen in `items` (Swift `init(items:)`). */
  static decode(items: Uint8Array): LogonFieldStructure {
    const fields: LogonInputField[] = []
    const identity = ScreenIdentity.decode(items, fields)
    return new LogonFieldStructure(identity, fields)
  }

  /** Whether the screen is the logon program (R-SS-5); `items` is the sequence read. */
  isLogonProgram(items: Uint8Array): boolean {
    return this.identity.isLogonProgram(items)
  }

  /** The input fields with INVISIBLE set. */
  get passwordFields(): LogonInputField[] {
    return this.inputFields.filter(field => field.isPasswordField)
  }

  /** The password field when there is exactly one, else undefined (the guard then shows the manual logon sheet). */
  get passwordField(): LogonInputField | undefined {
    const passwords = this.passwordFields
    return passwords.length === 1 ? passwords[0] : undefined
  }

  /**
   * The visible input fields (INVISIBLE clear) whose maxnrchars is `maxNrChars` (R-SS-9). (Swift
   * `inputFields(maxNrChars:)`.)
   */
  inputFieldsWithMaxNrChars(maxNrChars: number): LogonInputField[] {
    return this.inputFields.filter(field => !field.isPasswordField && field.maxNrChars === maxNrChars)
  }
}
