// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/Screen.swift (MIT).

// One server screen, as the app shows it and as the input step returns it, and the item walk that
// builds it (`ScreenDecoder`).
//
// The members Swift adds to `Screen` in extensions of other files are the functions of an object in
// each of those files, which take the screen (`ScreenFunctions`, `ScreenCarry`, `ScreenLogon`,
// `ScreenInput`, `FunctionTriggerStep`); `Screen` has methods of the same names that call them. The
// files import `Screen` as a type only, so there is no import cycle. `ScreenTextDecoding` and
// `characterCount`, which Swift declares here, live in screenLayout.ts for the same reason. Swift's
// internal `TextDecoder` is `ScreenTextDecoder` (JavaScript has a global `TextDecoder`).

import {
  ApplItem,
  ApplSID,
  CodePage,
  CodepageDiagGUI,
  ContainerGeometry,
  ContainerLoop,
  ContainerName,
  Decompression,
  DiagErrorBody,
  DiagErrorBodyError,
  DiagItemWalkError,
  DiagItemWalker,
  DiagMessage,
  DiagMessageDecodingError,
  DyntAtomWalkError,
  DyntAttributes,
  DyntAtomWalker,
  DyntButtonStrings,
  DyntCombobox,
  DyntElementType,
  DyntFocus,
  DyntText,
  DyntToggle,
  FieldMarkers,
  ItemPayloadError,
  ListWindowState,
  MenuEntries,
  PopupWindow,
  ScreenIdentity,
  ScreenIdentityDiagnostics,
  ScreenIdentityText,
  ScrollInfos,
  SESValue,
  StatusMessageValue,
  TextEncoding,
  ZZValueList,
  AreaSize,
  applItemCarriesDyntAtoms,
  type ApplSIDContainer,
  type ApplSIDMnuEntry,
  type ByteRange,
  type ClientInputStep,
  type ClientInputStepFunctionTrigger,
  type DiagItem,
  type DyntAtom,
  type DyntAtomDiagnostics,
  type DyntAtomHeader
} from "../codec/index.js"
import { CompressedDataError } from "../compression/index.js"
import type { MessageProblem, ServerMessage } from "../session/index.js"
import { FunctionTriggerStep, ScreenReadings, type FunctionTrigger, type TriggerStepOptions } from "./functionTrigger.js"
import { RequiredMarkerReading, ScreenCarry } from "./screenCarry.js"
import { ScreenDropdown, ScreenDropdownOption, type ScreenRadioGroup, type ScreenTabstrip, type ScreenInputFormat } from "./screenControls.js"
import { ScreenElement, ScreenElementID, ScreenElementKind } from "./screenElement.js"
import { FunctionBuilder, ScreenFunctions, type ScreenFunction, type ScreenMenuBarMenu, type StandardFunction } from "./screenFunction.js"
import { ScreenInput, type FieldEdits, type ReturnedFieldFlags } from "./screenInput.js"
import {
  GridPoint,
  ScreenContainer,
  ScreenContainerItem,
  ScreenTextDecoding,
  TextMarkup,
  XMLPropertyText,
  type ScreenContainerKind
} from "./screenLayout.js"
import type { ScreenList } from "./screenList.js"
import { ScreenLogon } from "./screenLogon.js"
import { ScreenMenu, ScreenMenuEntry } from "./screenMenu.js"
import {
  ScreenMessageType,
  ScreenStatusMessage,
  ScreenStatusMessageID,
  ScreenWindowSection,
  WindowSectionLayout,
  type ScreenCursor,
  type ScreenPresentation
} from "./screenPopup.js"
import { ScreenStructureBuilder } from "./screenStructure.js"
import type { ScreenTable } from "./screenTable.js"

// MARK: - Errors

/**
 * Why no screen could be built from a server message: the session dropped it before its items could
 * be read (a truncated header, an SNC frame, a compression header or data that fails). The last good
 * screen stays (architecture.md §4, "Unknown data").
 *
 * A message whose item or atom walk stops is no error: the screen keeps what came before the stop
 * (`ScreenDiagnostics.itemWalkStop`, `ScreenDiagnostics.stoppedAtomWalks`).
 * - `notDecoded`: the session dropped the message, and it holds no items to read.
 */
export type ScreenDecodingErrorInfo = { readonly kind: "notDecoded"; readonly value: MessageProblem }

export class ScreenDecodingError extends Error {
  constructor(readonly info: ScreenDecodingErrorInfo) {
    super("no screen: the session dropped the message, and it holds no items to read")
    this.name = "ScreenDecodingError"
  }
}

// MARK: - Size and diagnostics

/** The window and area size of VARINFO AREASIZE (PV-0704), in character cells as pysap's renderer reads them (server-screen.md §8.3). */
export class ScreenSize {
  readonly rows: number
  readonly columns: number
  readonly windowRows: number
  readonly windowColumns: number

  constructor(fields: { rows: number; columns: number; windowRows: number; windowColumns: number }) {
    this.rows = fields.rows
    this.columns = fields.columns
    this.windowRows = fields.windowRows
    this.windowColumns = fields.windowColumns
  }

  /** The size of an AREASIZE value (Swift's internal `init(_ size:)`). */
  static of(size: AreaSize): ScreenSize {
    return new ScreenSize({ rows: size.areaHeight, columns: size.areaWidth, windowRows: size.windowHeight, windowColumns: size.windowWidth })
  }
}

/**
 * What the screen decode kept, repaired or left out without dropping the screen. A real server sends
 * items and atoms Swooey does not decode yet; they are counted here, and the rest of the screen
 * stands (architecture.md §4, "Unknown data"). A Swift struct: `clone()` copies it.
 */
export class ScreenDiagnostics {
  /**
   * Counts in the codec's terms: values that failed their layout (IMPL-SS-3), stopped or unwalked
   * menus (IMPL-SS-5, #33), repeated identity items (#54) and the atom walks' diagnostics (unknown
   * element types, opaque and malformed payloads), summed over every DYNT_ATOM and
   * DYNT_TABSTRIP_BUTTONS item.
   */
  codec = new ScreenIdentityDiagnostics()
  /**
   * Where the item walk stopped (a truncated item or an unknown item type, IMPL-IT-2, IMPL-IT-5): the
   * items before it are on the screen, the bytes after it were not read. Undefined when the walk
   * reached the end.
   */
  itemWalkStop: DiagItemWalkError | undefined = undefined
  /** Atom walks that stopped (IMPL-DA-3); the atoms before each stop are on the screen, and the walk goes on with the next item. */
  stoppedAtomWalks = 0
  /** APPL items whose (id, sid) no registry row names (IMPL-IT-1): stepped over by length. */
  unknownItems = 0
  /** Whether the session dropped the message because a walk stopped, and the screen was read from its bytes up to the stop. */
  readPastSessionDrop = false
  /** Texts whose bytes are not valid in the code page: shown with U+FFFD in their place. */
  repairedTexts = 0
  /**
   * Texts with bytes above 0x7F in a code page Swooey does not know, shown as ISO 8859-1 (session.md
   * §6.4). ASCII texts read the same in every such code page and are not counted.
   */
  guessedTexts = 0
  /** MENU_MNU entries with no menu-bar title or parent menu at their position (Reading R-SS-11): left out of `Screen.menuBar` and `Screen.functions`. */
  unplacedMenuEntries = 0
  /**
   * Atoms whose `area` names no container the message declared before them (server-screen.md §8.6,
   * Reading R-SS-14): placed at the main screen's origin, as if in area 0.
   */
  atomsWithoutContainer = 0
  /** Checkbox, radio, combobox and other element payloads a Reading of elements.md could not read (R-EL-1, R-EL-3): kept as opaque elements. */
  undecodedElements = 0
  /** Atoms in a table's area that fit no column or row (elements.md Reading R-EL-7). */
  unmatchedTableAtoms = 0
  /** List runs that fit no line of the list window (elements.md Reading R-EL-11). */
  unmatchedListLines = 0
  /** Cells of a list's box runs (elements.md Reading R-EL-20), spaces included. */
  listBoxCells = 0
  /** Characters of box runs that are no line element's code and not a space: kept as they came (Reading R-EL-20). */
  unknownListBoxCodes = 0
  /**
   * A plain CHL or a SCROLL_INFOS that a list message carried without APPL DYNN CHL and that did not
   * fit its runs, so the window state did not come from it (Reading R-EL-21).
   */
  implausibleListWindows = 0
  /**
   * The plain CHL simple item of a message with list runs, read at DYNN CHL's positions, for the
   * session report (Reading R-EL-21, #111): numbers only.
   */
  plainListWindow: ListWindowState | undefined = undefined
  /** The SCROLL_INFOS outside a table of a message with list runs, for the session report (Reading R-EL-21, #111). */
  listScrollInfos: ScrollInfos | undefined = undefined
  /** Radio groups with more than one selected button: the first counts (elements.md Reading R-EL-2). */
  duplicateRadioSelections = 0

  /** A copy (Swift copies the struct on assignment). */
  clone(): ScreenDiagnostics {
    const copy = Object.assign(new ScreenDiagnostics(), this)
    copy.codec = this.codec.clone()
    return copy
  }

  /**
   * Whether the screen was read to its end with nothing repaired, guessed, cut short or ambiguous.
   * Unknown items alone leave it clean: they are stepped over by their length.
   */
  get isClean(): boolean {
    return (
      this.codec.isClean &&
      this.itemWalkStop === undefined &&
      this.stoppedAtomWalks === 0 &&
      this.repairedTexts === 0 &&
      this.guessedTexts === 0 &&
      this.unplacedMenuEntries === 0 &&
      this.atomsWithoutContainer === 0
    )
  }
}

/**
 * The screen's identity texts (server-screen.md §7). Each is undefined when the message does not
 * carry its item or carries it more than once (#54). (Swift `Screen.Identity`; renamed, since the
 * codec exports a `ScreenIdentity` of its own.)
 */
export class ScreenIdentityTexts {
  /** VARINFO SESSION_TITLE: the window title. */
  title: string | undefined = undefined
  /** ST_R3INFO DYNPRONAME: the program (§6.1). */
  program: string | undefined = undefined
  /** ST_R3INFO DYNPRONUMBER: the screen number (§6.1). */
  screenNumber: string | undefined = undefined
  /** ST_R3INFO TCODE: the transaction. */
  transaction: string | undefined = undefined
  /** ST_R3INFO CUANAME: the program of the GUI status. */
  guiProgram: string | undefined = undefined
  /** ST_R3INFO CUASTATUS: the GUI status. */
  guiStatus: string | undefined = undefined
  /** ST_R3INFO DBNAME: the system name. */
  systemName: string | undefined = undefined
  /** ST_R3INFO CLIENT. */
  client: string | undefined = undefined

  constructor(fields: Partial<Omit<ScreenIdentityTexts, "clone">> = {}) {
    Object.assign(this, fields)
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): ScreenIdentityTexts {
    return new ScreenIdentityTexts(this)
  }
}

// MARK: - Screen

/** The fields of a `Screen`, as the decode sets them. */
export interface ScreenFields {
  identity: ScreenIdentityTexts
  size: ScreenSize | undefined
  windowSections: ScreenWindowSection[]
  lowerWindows: Screen[]
  elements: ScreenElement[]
  containers: ScreenContainer[]
  otherContainerItems: ScreenContainerItem[]
  menus: ScreenMenu[]
  functions: ScreenFunction[]
  menuBar: ScreenMenuBarMenu[]
  message: string | undefined
  radioGroups: ScreenRadioGroup[]
  tabstrips: ScreenTabstrip[]
  tables: ScreenTable[]
  list: ScreenList | undefined
  presentation: ScreenPresentation
  statusMessage: ScreenStatusMessage | undefined
  cursor: ScreenCursor | undefined
  hasOKCodeItem: boolean
  isLogonScreen: boolean
  isServerError: boolean
  codePage: number
  declaredCodePage: number | undefined
  textEncoding: TextEncoding
  diagnostics: ScreenDiagnostics
}

/** The options of the screen decode (Swift's `codePage:` and `readings:` parameters). */
export interface ScreenDecodeOptions {
  /** The code page in force before the message; UTF-8 (4110) by default. */
  codePage?: number
  readings?: ScreenReadings
}

/** The options of the command form of `Screen.inputStep` (Swift `inputStep(edits:functionCode:trigger:flags:)`). */
export interface CommandStepOptions {
  functionCode?: string | undefined
  trigger?: ClientInputStepFunctionTrigger
  flags?: ReturnedFieldFlags
}

/**
 * One server screen, as the app shows it and as the input step returns it.
 *
 * Built from one decoded server message (`Screen.fromMessage`) or its item sequence
 * (`Screen.fromItems`) with DiagCodec's decoders: the identity texts (server-screen.md §7, trimmed
 * per R-SS-4), the area size (§8.3), the elements of every DYNT_ATOM and DYNT_TABSTRIP_BUTTONS item
 * in item and atom order (dynt-atoms.md), the menus (§8.1) and the functions and menu bar of the GUI
 * status (§8.7), the status message (ST_R3INFO MESSAGE) and whether a VARINFO OKCODE item came, and
 * the elements of docs/protocol/elements.md: checkbox and radio states, dropdowns, field markers,
 * radio groups, tabstrips, table controls, the classic list, the popup, the typed message and the
 * cursor (`ScreenStructureBuilder`). `readings` switches the Readings of the decode
 * (`ScreenReadings`); at `ScreenReadings.beforeElements` the elements decode as they did before
 * elements.md.
 *
 * **Tolerant.** A walk that stops keeps what came before it: the item walk ends the screen there, an
 * atom walk ends only its item. Unknown items and element types are stepped over or kept by their
 * type. What was left out is counted in `diagnostics`; a screen is never dropped for one bad item or
 * atom.
 *
 * **Code page** (session.md §6.3, §6.4). Texts are decoded in the code page in force: the one this
 * message declares in ST_R3INFO CODEPAGE_DIAG_GUI, else `codePage`, the one the session had before
 * it (the CONNECT code page until a first declaration, Reading R-SE-9). 4110, 4102, 4103 and 1100 are
 * known (`TextEncoding`); any other number is read as ISO 8859-1 and every non-ASCII text counts in
 * `ScreenDiagnostics.guessedTexts`. A password field's text is never decoded.
 *
 * A Swift struct: `clone()` copies it (the elements, which a built screen never changes, are shared).
 */
export class Screen {
  /**
   * The top window's identity: the last window section's (elements.md Reading R-EL-23), with the
   * transaction, system and client of the message's first section when the last lacks them.
   */
  identity: ScreenIdentityTexts
  /**
   * The top window's VARINFO AREASIZE, or undefined when its section carries none, carries it twice
   * (#54), or its value is not 16 bytes (IMPL-SS-3).
   */
  size: ScreenSize | undefined
  /**
   * The message's window sections (elements.md Reading R-EL-23), one per SES item in item order; the
   * last is the top window, which `identity`, `size` and `menus` describe. Empty for a message without
   * SES. Items before the first SES belong to the first section. (Swift `internal(set)`.)
   */
  windowSections: ScreenWindowSection[]
  /**
   * The windows the message's lower sections describe with content of their own (Reading R-EL-23,
   * issue #147), in section order: each a screen of its section's identity, size, GUI status and
   * content. Empty for a message of one section, and for lower sections without content, whose
   * windows keep what they showed. (Swift `internal(set)`.)
   */
  lowerWindows: Screen[]
  /** The elements in item and atom order. FNAME and XMLPROP atoms are children, not elements. */
  elements: ScreenElement[]
  /**
   * The containers the message declared (CONTAINER LOOP, TABLE, TABSTRIP, TABSTRIP_PAGE, CONTROL and
   * SUBSCREEN; server-screen.md §8.6, Readings R-SS-14, R-SS-16), in item order. An element's
   * `ScreenElement.placement` already includes its container's origin; these give the renderer each
   * area's extent.
   */
  containers: ScreenContainer[]
  /** CONTAINER items of sids the decoder does not read, in the order received (structure only). */
  otherContainerItems: ScreenContainerItem[]
  /**
   * The top window's MNUENTRY items in item order (its window section's, Reading R-EL-23); sids
   * outside MENU_ACT…MENU_KYB are not walked (#33).
   */
  menus: ScreenMenu[]
  /**
   * Every function the screen offers (server-screen.md §8.7, Readings R-SS-10 to R-SS-13): the eight
   * standard-toolbar functions (`StandardFunction`), the application toolbar (MENU_PFK), the menu
   * items (MENU_MNU under MENU_ACT), the function-key list (MENU_KYB, the context menu, a `menu` with
   * an empty path), then the push buttons and tabs in screen order. Fire one with the trigger form of
   * `inputStep`. (Swift `internal(set)`.)
   */
  functions: ScreenFunction[]
  /** The menu bar as a tree, for rendering: one menu per MENU_ACT title with its MENU_MNU items. (Swift `internal(set)`.) */
  menuBar: ScreenMenuBarMenu[]
  /** ST_R3INFO MESSAGE, trimmed per R-SS-4: the status-bar message, or undefined. */
  message: string | undefined

  // MARK: Elements of elements.md (pinned; decoded per ScreenReadings)

  /** The radio groups in screen order (elements.md Reading R-EL-2). */
  radioGroups: ScreenRadioGroup[]
  /** The tabstrips in container order (elements.md Reading R-EL-5). */
  tabstrips: ScreenTabstrip[]
  /** The table controls in container order (elements.md Reading R-EL-7). */
  tables: ScreenTable[]
  /** The classic list the message carries (elements.md Reading R-EL-11), or undefined. */
  list: ScreenList | undefined
  /** A main screen or a popup (elements.md Reading R-EL-13). */
  presentation: ScreenPresentation
  /**
   * The typed status message (elements.md Reading R-EL-14): from MESTYPE2, else `message` with the
   * type `none`. `message` stays: `statusMessage?.text ?? message`.
   */
  statusMessage: ScreenStatusMessage | undefined
  /** Where the server put the cursor (DYNT_FOCUS_1, PV-0711; elements.md Reading R-EL-17). */
  cursor: ScreenCursor | undefined
  /** Whether the message carried a VARINFO OKCODE item. How a server declares the command field is not specified (#33, #55); this only records the item. */
  hasOKCodeItem: boolean
  /** Whether the screen is the logon program (R-SS-5): DYNPRONAME, decoded and trimmed, is `SAPMSYST`. */
  isLogonScreen: boolean
  /**
   * Whether the message was a server error (err_no ≠ 0, IMPL-DH-8); the screen then holds the items
   * after the error text. Always false for `fromItems`.
   */
  isServerError: boolean
  /** The code page the texts were decoded with, and the input step encodes edits with: the one the message declared, else the one given. */
  readonly codePage: number
  /**
   * The number this message declared in ST_R3INFO CODEPAGE_DIAG_GUI (PV-0532), or undefined when it
   * carries no such item that decodes. A session keeps it for the messages after this one.
   */
  readonly declaredCodePage: number | undefined
  /** The character set of `codePage`: the known one, or the ISO 8859-1 stand-in. */
  readonly textEncoding: TextEncoding
  diagnostics: ScreenDiagnostics

  /** A screen of these fields; the decode builds them (`fromMessage`, `fromItems`). */
  constructor(fields: ScreenFields) {
    this.identity = fields.identity
    this.size = fields.size
    this.windowSections = fields.windowSections
    this.lowerWindows = fields.lowerWindows
    this.elements = fields.elements
    this.containers = fields.containers
    this.otherContainerItems = fields.otherContainerItems
    this.menus = fields.menus
    this.functions = fields.functions
    this.menuBar = fields.menuBar
    this.message = fields.message
    this.radioGroups = fields.radioGroups
    this.tabstrips = fields.tabstrips
    this.tables = fields.tables
    this.list = fields.list
    this.presentation = fields.presentation
    this.statusMessage = fields.statusMessage
    this.cursor = fields.cursor
    this.hasOKCodeItem = fields.hasOKCodeItem
    this.isLogonScreen = fields.isLogonScreen
    this.isServerError = fields.isServerError
    this.codePage = fields.codePage
    this.declaredCodePage = fields.declaredCodePage
    this.textEncoding = fields.textEncoding
    this.diagnostics = fields.diagnostics
  }

  /**
   * A copy (Swift copies the struct on assignment): the arrays, the identity, the window sections
   * and the diagnostics copied; the elements and the other immutable values shared.
   */
  clone(): Screen {
    return new Screen({
      ...this,
      identity: this.identity.clone(),
      windowSections: this.windowSections.map(section => Object.assign(Object.create(ScreenWindowSection.prototype) as ScreenWindowSection, section)),
      lowerWindows: this.lowerWindows.map(window => window.clone()),
      elements: this.elements.slice(),
      containers: this.containers.slice(),
      otherContainerItems: this.otherContainerItems.slice(),
      menus: this.menus.slice(),
      functions: this.functions.slice(),
      menuBar: this.menuBar.slice(),
      radioGroups: this.radioGroups.slice(),
      tabstrips: this.tabstrips.slice(),
      tables: this.tables.slice(),
      diagnostics: this.diagnostics.clone()
    })
  }

  /** Whether `codePage` is one Swooey knows (`TextEncoding.fromCodePage`), so that its texts are not guessed. */
  get knowsCodePage(): boolean {
    return TextEncoding.fromCodePage(this.codePage) !== undefined
  }

  // MARK: Building a screen

  /**
   * The screen of a message the session decoded, or of one it dropped because a walk stopped (read up
   * to the stop). `options.codePage` is the code page in force before this message. Throws
   * `ScreenDecodingError` `notDecoded` for a message with no items to read. (Swift
   * `init(message:codePage:readings:)`.)
   */
  static fromMessage(message: ServerMessage, options: ScreenDecodeOptions = {}): Screen {
    const codePage = options.codePage ?? DyntText.utf8CodePage
    const readings = options.readings ?? new ScreenReadings()
    const content = message.content
    switch (content.kind) {
      case "screen": {
        // withItems gives the item sequence of every message with a screen.
        const screen = message.withItems(items => Screen.reading(items, codePage, readings))!
        screen.isServerError = content.value.isServerError
        return screen
      }
      case "notDecoded": {
        const problem = content.value
        const recovered = problem.kind === "items" ? Screen.itemBytes(message.payload) : undefined
        if (recovered === undefined) throw new ScreenDecodingError({ kind: "notDecoded", value: problem })
        const screen = Screen.reading(recovered.items, codePage, readings)
        screen.isServerError = recovered.isServerError
        screen.diagnostics.readPastSessionDrop = true
        return screen
      }
    }
  }

  /**
   * The screen of one message's item sequence: the bytes after the DIAG header of an uncompressed
   * message, or the decompressed bytes of a compressed one. Never throws since the walks became
   * tolerant. (Swift `init(items:codePage:readings:)`.)
   */
  static fromItems(items: Uint8Array, options: ScreenDecodeOptions = {}): Screen {
    return Screen.reading(items, options.codePage ?? DyntText.utf8CodePage, options.readings ?? new ScreenReadings())
  }

  /** Swift's `init(reading:codePage:readings:)`. */
  private static reading(items: Uint8Array, given: number, readings: ScreenReadings): Screen {
    const declared = Screen.declaredCodePage(items)
    const codePage = declared ?? given
    // Reading R-EL-23 (issue #147): with several window sections, each section's content is its own
    // window's; the top window is the last section.
    const layout = readings.windowSections === "sesSections" ? new WindowSectionLayout(items) : undefined
    if (layout === undefined || !(layout.sections.length > 1)) return Screen.window(items, codePage, declared, readings, undefined)
    const top = layout.sections.length - 1
    const screen = Screen.window(items, codePage, declared, readings, { index: top, layout })
    for (let index = 0; index < top; index++) {
      if (layout.sections[index].hasContent) screen.lowerWindows.push(Screen.window(items, codePage, declared, readings, { index, layout }))
    }
    screen.windowSections.forEach((section, index) => {
      if (index < layout.sections.length) section.hasContent = layout.sections[index].hasContent
    })
    screen.windowSections[top].elementCount = screen.elements.length
    let lower = 0
    for (let index = 0; index < screen.windowSections.length - 1; index++) {
      const section = screen.windowSections[index]
      if (!section.hasContent) continue
      section.elementCount = screen.lowerWindows[lower]?.elements.length ?? 0
      lower += 1
    }
    return screen
  }

  /**
   * One window of the message: `window` names the section whose identity, size, GUI status and
   * content it reads (Reading R-EL-23), undefined for the whole message, as a message of one section
   * reads. (Swift's `init(reading:codePage:declared:readings:window:)`.)
   */
  private static window(
    items: Uint8Array,
    codePage: number,
    declared: number | undefined,
    readings: ScreenReadings,
    window: { index: number; layout: WindowSectionLayout } | undefined
  ): Screen {
    const decoder = new ScreenDecoder(codePage, readings, window?.index, window === undefined ? undefined : window.layout.sections[window.index].range)
    decoder.walk(items)
    const identity = decoder.identity(items)
    // The window's content: its section's items alone, for the list runs too.
    const contentItems = window === undefined ? items : window.layout.sections[window.index].range.of(items)
    const isTop = window === undefined ? true : window.index === window.layout.sections.length - 1
    const windowSections = isTop ? decoder.windowSections(items) : []
    const structure = new ScreenStructureBuilder(decoder)
    structure.build(contentItems)
    const builder = new FunctionBuilder(decoder.menus, structure.elements, readings)
    const diagnostics = structure.diagnostics
    diagnostics.repairedTexts = structure.text.repaired
    diagnostics.guessedTexts = structure.text.guessed
    diagnostics.unplacedMenuEntries = builder.unplacedEntries
    const areaSize = decoder.areaSize
    return new Screen({
      identity,
      size: areaSize === undefined ? undefined : ScreenSize.of(areaSize),
      windowSections,
      lowerWindows: [],
      elements: structure.elements,
      containers: decoder.containers,
      otherContainerItems: decoder.otherContainerItems,
      menus: decoder.menus,
      functions: builder.functions,
      menuBar: builder.menuBar,
      message: decoder.message,
      radioGroups: structure.radioGroups,
      tabstrips: structure.tabstrips,
      tables: structure.tables,
      list: structure.list,
      presentation: structure.presentation(identity.title),
      statusMessage: Screen.typedStatusMessage(decoder.statusMessage, decoder.message),
      cursor: structure.cursor,
      hasOKCodeItem: decoder.hasOKCodeItem,
      isLogonScreen: identity.program === Screen.logonProgramName,
      isServerError: false,
      codePage,
      declaredCodePage: declared,
      textEncoding: decoder.text.encoding,
      diagnostics
    })
  }

  /**
   * The typed status message of Reading R-EL-14: MESTYPE2's (`typed`) type, class and text, except
   * that a MESSAGE led by the same type's letter, a colon and a space is the sentence the status bar
   * shows, and gives the text without that lead: MESTYPE2's text may then be only the words the
   * sentence names (PV-0995). Without MESTYPE2, MESSAGE without a type. (Swift
   * `typedStatusMessage(mestype2:message:)`.)
   */
  static typedStatusMessage(typed: ScreenStatusMessage | undefined, message: string | undefined): ScreenStatusMessage | undefined {
    if (message === undefined || message.length === 0) return typed
    if (typed === undefined) return new ScreenStatusMessage({ type: ScreenMessageType.none, text: message })
    const letter = ScreenMessageType.letter(typed.type)
    const lead = letter === undefined ? undefined : letter + ": "
    if (lead === undefined || !message.startsWith(lead)) return typed
    const text = TextMarkup.parse(message.slice(lead.length)).caption
    return text.length === 0 ? typed : new ScreenStatusMessage({ type: typed.type, text, id: typed.id })
  }

  /** The logon program's name (R-SS-5, PV-0707), which the decoded DYNPRONAME is compared with. (Swift internal.) */
  static readonly logonProgramName: string = new TextDecoder().decode(ScreenIdentity.logonProgramName)

  /**
   * The code page the first ST_R3INFO CODEPAGE_DIAG_GUI item of `items` declares (PV-0532), or
   * undefined. Items after a walk stop are not read. (Swift `declaredCodePage(in:)`.)
   */
  static declaredCodePage(items: Uint8Array): number | undefined {
    const walker = new DiagItemWalker()
    for (;;) {
      let item: DiagItem | undefined
      try {
        item = walker.next(items)
      } catch (error) {
        if (!(error instanceof DiagItemWalkError)) throw error
        return undefined
      }
      if (item === undefined) return undefined
      if (!ApplItem.equals(item.appl, ApplItem.stSystemInfo("codepageDiagGUI"))) continue
      const value = item.valueRange.of(items)
      const declaration = attempt(() => CodepageDiagGUI.decode(value))
      if (declaration !== undefined) return declaration.codePage
    }
  }

  /**
   * The item sequence of a message the session dropped because a walk stopped: the bytes after the
   * header, after the error text of a server error (R-DH-6), or the decompressed data. Undefined when
   * the message holds none. (Swift internal `itemBytes(of:)`.)
   */
  static itemBytes(payload: Uint8Array): { items: Uint8Array; isServerError: boolean } | undefined {
    let message: DiagMessage
    try {
      message = DiagMessage.parse(payload)
    } catch (error) {
      if (!(error instanceof DiagMessageDecodingError)) throw error
      return undefined
    }
    const isServerError = message.header.isError
    const body = message.body
    switch (body.kind) {
      case "items":
        return { items: body.range.of(payload).slice(), isServerError }
      case "errorBody": {
        const items = errorItems(body.range.of(payload))
        return items === undefined ? undefined : { items, isServerError }
      }
      case "compressed": {
        let output: Uint8Array
        try {
          output = Decompression.decompress(body.data.of(payload), body.header)
        } catch (error) {
          if (!(error instanceof CompressedDataError)) throw error
          return undefined
        }
        const items = body.isErrorBody ? errorItems(output) : output
        return items === undefined ? undefined : { items, isServerError }
      }
      case "snc":
        return undefined
    }
  }

  // MARK: Reading a screen

  /** The element with `id`, or undefined. */
  element(id: ScreenElementID): ScreenElement | undefined {
    return this.elements.find(element => ScreenElementID.equals(element.id, id))
  }

  /** The input fields, password fields included, in screen order. */
  get inputs(): ScreenElement[] {
    return this.elements.filter(element => element.kind.kind === "input")
  }

  /** The labels in screen order. */
  get labels(): ScreenElement[] {
    return this.elements.filter(element => element.kind.kind === "label")
  }

  /** One line: program, screen number, title and counts. Never a field value. */
  get description(): string {
    const program = this.identity.program ?? "?"
    const number = this.identity.screenNumber ?? "?"
    const title = this.identity.title === undefined ? "" : ` "${this.identity.title}"`
    const passwords = this.elements.filter(element => element.kind.kind === "input" && element.isPassword).length
    return `Screen(${program} ${number}${title}: ${this.elements.length} elements, ${this.inputs.length} inputs, ${passwords} password)`
  }

  /** The description, then one line per element (`ScreenElement.description`, which never shows a password field's value). */
  get debugDescription(): string {
    return [this.description, ...this.elements.map(element => "  " + element.description)].join("\n")
  }

  toString(): string {
    return this.description
  }

  // MARK: Members of Swift's extensions in other files

  /** The standard-toolbar function for `standard` (always present). (ScreenFunction.swift; `ScreenFunctions.function`.) */
  function(standard: StandardFunction): ScreenFunction | undefined {
    return ScreenFunctions.function(this, standard)
  }

  /**
   * The function fired by virtual key `virtualKey`, or undefined when no function has it: the first
   * of an application-toolbar button, a menu item, a function-key list entry and a standard-toolbar
   * button with that key. (ScreenFunction.swift, Swift `function(forVirtualKey:)`;
   * `ScreenFunctions.functionForVirtualKey`.)
   */
  functionForVirtualKey(virtualKey: number): ScreenFunction | undefined {
    return ScreenFunctions.functionForVirtualKey(this, virtualKey)
  }

  /** Whether the screen declares a GUI status: any MNUENTRY item. (ScreenFunction.swift.) */
  get hasGUIStatus(): boolean {
    return ScreenFunctions.hasGUIStatus(this)
  }

  /**
   * Whether this screen's window keeps what `previous` showed (Reading R-EL-23, issues #147, #153).
   * (ScreenCarry.swift, Swift `keepsContent(of:)`; `ScreenCarry.keepsContent`.)
   */
  keepsContent(previous: Screen): boolean {
    return ScreenCarry.keepsContent(this, previous)
  }

  /**
   * This screen with the content `previous` showed (`keepsContent`). (ScreenCarry.swift, Swift
   * `keepContent(of:readings:)`; `ScreenCarry.keepContent`.)
   */
  keepContent(previous: Screen, readings?: ScreenReadings): void {
    ScreenCarry.keepContent(this, previous, readings)
  }

  /**
   * This screen with `menus` as its GUI status (Reading R-EL-22). (ScreenCarry.swift, Swift
   * `adoptStatus(_:readings:)`; `ScreenCarry.adoptStatus`.)
   */
  adoptStatus(menus: readonly ScreenMenu[], readings?: ScreenReadings): void {
    ScreenCarry.adoptStatus(this, menus, readings)
  }

  /**
   * The main window a popup message sent with content of its own (Reading R-EL-23, issue #147): the
   * last lower section of level 0 that carries content; undefined otherwise. (ScreenLogon.swift.)
   */
  get mainWindowScreen(): Screen | undefined {
    return ScreenLogon.mainWindowScreen(this)
  }

  /**
   * The input step that submits this screen.
   *
   * With `options` (or nothing) after the edits, the command form (ScreenInput.swift, Swift
   * `inputStep(edits:functionCode:trigger:flags:)`; `ScreenInput.inputStep`): the edited fields and
   * the function code when one is given, carried as `options.trigger` says.
   *
   * With a `FunctionTrigger` after the edits, the trigger form (FunctionTrigger.swift, Swift
   * `inputStep(edits:trigger:readings:flags:cursor:)`; `FunctionTriggerStep.inputStep`): the edited
   * fields plus what the trigger sends (client-input.md §7.5).
   *
   * Throws `ScreenInputError`.
   */
  inputStep(edits: FieldEdits, options?: CommandStepOptions): ClientInputStep
  inputStep(edits: FieldEdits, trigger: FunctionTrigger, options?: TriggerStepOptions): ClientInputStep
  inputStep(edits: FieldEdits, triggerOrOptions?: FunctionTrigger | CommandStepOptions, options?: TriggerStepOptions): ClientInputStep {
    if (triggerOrOptions !== undefined && "kind" in triggerOrOptions) return FunctionTriggerStep.inputStep(this, edits, triggerOrOptions, options)
    return ScreenInput.inputStep(this, edits, triggerOrOptions)
  }

  /**
   * Whether `edits` make the logon step, which returns every field that holds a value (Reading
   * R-CI-19). (ScreenInput.swift; `ScreenInput.isLogonStep`.)
   */
  isLogonStep(edits: FieldEdits): boolean {
    return ScreenInput.isLogonStep(this, edits)
  }

  /**
   * The function code of the screen's push button or tab that stands for GUI-status function
   * `number` (Reading R-CI-20). (FunctionTrigger.swift, Swift `statusButtonCode(forFunction:)`;
   * `FunctionTriggerStep.statusButtonCode`.)
   */
  statusButtonCode(number: number): string | undefined {
    return FunctionTriggerStep.statusButtonCode(this, number)
  }
}

/** The items after the error text of an error body, or undefined when it has no 0x0C. */
function errorItems(body: Uint8Array): Uint8Array | undefined {
  try {
    return DiagErrorBody.split(body).itemsRange.of(body).slice()
  } catch (error) {
    if (!(error instanceof DiagErrorBodyError)) throw error
    return undefined
  }
}

/** Swift `try?` on an item value decoder: undefined for an `ItemPayloadError`. */
function attempt<T>(decode: () => T): T | undefined {
  try {
    return decode()
  } catch (error) {
    if (error instanceof ItemPayloadError) return undefined
    throw error
  }
}

// MARK: - Decoding

/** Text in the code page in force, with the counts of what was repaired or guessed. (Swift internal `TextDecoder`.) */
export class ScreenTextDecoder {
  readonly encoding: TextEncoding
  /** The code page is none Swooey knows: `encoding` is the ISO 8859-1 stand-in. */
  readonly isGuess: boolean
  repaired = 0
  guessed = 0

  constructor(codePage: number) {
    const known = TextEncoding.fromCodePage(codePage)
    this.encoding = known ?? "latin1"
    this.isGuess = known === undefined
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): ScreenTextDecoder {
    return Object.assign(Object.create(ScreenTextDecoder.prototype) as ScreenTextDecoder, this)
  }

  /** `bytes` as text: strict, else repaired and counted; a guess is counted when it holds a byte above 0x7F. */
  decode(bytes: Uint8Array): string {
    if (this.isGuess && !CodePage.isASCII(bytes)) this.guessed += 1
    const text = TextEncoding.decode(this.encoding, bytes)
    if (text !== undefined) return text
    this.repaired += 1
    return TextEncoding.decodeRepairing(this.encoding, bytes)
  }
}

/** Adds another walk's counts to `diagnostics` (Swift: this file's `extension DyntAtomDiagnostics`, `accumulate(_:)`). */
function accumulate(diagnostics: DyntAtomDiagnostics, other: DyntAtomDiagnostics): void {
  diagnostics.orphanChildren += other.orphanChildren
  diagnostics.dlenMismatches += other.dlenMismatches
  diagnostics.malformedPayloads += other.malformedPayloads
  diagnostics.unknownElementTypes += other.unknownElementTypes
  diagnostics.opaquePayloads += other.opaquePayloads
  diagnostics.undecodedButtonStrings += other.undecodedButtonStrings
}

/**
 * What one window section holds (Reading R-EL-23): its SES, where each identity text lies (a range
 * only while it appeared once in the section, #54), its AREASIZE and its MNUENTRY items. (Swift
 * `ScreenDecoder.Section`.)
 */
class Section {
  ses: SESValue | undefined = undefined
  identityRanges = new Map<ScreenIdentityText, ByteRange>()
  identityCounts = new Map<ScreenIdentityText, number>()
  areaSize: AreaSize | undefined = undefined
  areaSizeCount = 0
  menus: ScreenMenu[] = []
}

/** The last DYNT_FOCUS_1 (PV-0711, Reading R-EL-17): the received row, column, caret and first container id. */
export interface ScreenDecoderFocus {
  readonly row: number
  readonly col: number
  readonly colOffset: number
  readonly container: number
}

/**
 * One walk over a screen's items: the identity items, the elements, menus, message and OKCODE item.
 * Tolerant: a stop ends the walk (items) or the item (atoms) and is counted. (Swift internal.)
 */
export class ScreenDecoder {
  text: ScreenTextDecoder
  readonly readings: ScreenReadings
  readonly elements: ScreenElement[] = []
  /**
   * For each element, the index in `containers` of the container its `area` named when it was read
   * (Reading R-SS-14); undefined in area 0 or when no container was in force.
   */
  readonly elementContainers: (number | undefined)[] = []
  /** The elements read from a DYNT_TABSTRIP_BUTTONS item that are tabs (Reading R-EL-5). */
  readonly tabButtonElements: number[] = []
  readonly containers: ScreenContainer[] = []
  readonly otherContainerItems: ScreenContainerItem[] = []
  /** CONTAINER NAME's container name, by the index in `containers` of the container it follows. */
  readonly containerNames = new Map<number, string>()
  /** The SCROLL_INFOS that follows a TABLE container, by the container's index (Reading R-EL-8). */
  readonly tableScrollInfos = new Map<number, ScrollInfos>()
  message: string | undefined = undefined
  /** The first MESTYPE2 (Reading R-EL-14), decoded under `ScreenReadings.messageType`. */
  statusMessage: ScreenStatusMessage | undefined = undefined
  /** The last SES item (Reading R-EL-13). */
  ses: SESValue | undefined = undefined
  /**
   * The window section whose identity, size, GUI status and content this decoder reads (Reading
   * R-EL-23, issue #147), by index; undefined for the whole message's last one.
   */
  readonly window: number | undefined
  /**
   * The byte range of that section's items: content items elsewhere belong to another window and are
   * not read. Undefined reads every item's content, as for a message of one section.
   */
  readonly content: ByteRange | undefined
  /** The last DYNT_FOCUS_1 (PV-0711, Reading R-EL-17): the received row, column, caret and first container id. */
  focus: ScreenDecoderFocus | undefined = undefined
  /** The last APPL DYNN CHL, read as the list window state (Reading R-EL-11). */
  listWindow: ListWindowState | undefined = undefined
  /** The last plain CHL simple item that decodes, read at DYNN CHL's positions (Reading R-EL-21). */
  plainListWindow: ListWindowState | undefined = undefined
  /** The first SCROLL_INFOS while no TABLE container is in force (Reading R-EL-21). */
  listScrollInfos: ScrollInfos | undefined = undefined
  /** Whether any LIST_CELL_TEXT item came (Reading R-EL-11): the runs are walked after the items. */
  hasListRuns = false
  hasOKCodeItem = false
  readonly diagnostics = new ScreenDiagnostics()

  /**
   * The section being read: before the first SES the message's first items, which the first section
   * keeps (a message with one SES reads as one screen, as before R-EL-23).
   */
  private section = new Section()
  /** The sections an SES closed, in order. */
  private readonly closedSections: Section[] = []
  /** How many SES items came. */
  private sesCount = 0
  /** How many elements share each first-occurrence id, for the next occurrence number. */
  private readonly occurrences = new Map<string, number>()
  /**
   * The containers in force, by id, as indices into `containers`: the atoms' areas (Reading R-SS-14).
   * CONTAINER RESET empties it; area 0 is always the main screen.
   */
  private areas = new Map<number, number>()
  /** The index in `containers` of the LOOP container a VARINFO CONTAINER_LOOP describes: the latest one, until a RESET. */
  private latestLoop: number | undefined
  /** The latest geometry container, which a CONTAINER NAME names, until a RESET. */
  private latestGeometry: number | undefined
  /** The latest TABLE container, which a SCROLL_INFOS describes until the next RESET or geometry container (Reading R-EL-8). */
  private scrollTarget: number | undefined
  /**
   * The geometry containers declared since the last RESET, as indices into `containers`, in order: a
   * TABSTRIP_PAGE counts from the TABSTRIP before it, and a container after a page from the page
   * (Reading R-SS-15, issue #155).
   */
  private group: number[] = []
  /**
   * The TABSTRIP_PAGE or SUBSCREEN whose subscreen the next DYNT_ATOM item is: its area-0 atoms are
   * placed in it (Readings R-SS-15, R-SS-16). Cleared by that item and by a RESET.
   */
  private subscreenPage: number | undefined
  /**
   * The comboboxes of the item being walked that may still become dropdowns once their XMLPROP child
   * shows a `ZZValueList` (Reading R-EL-3), by element index.
   */
  private readonly pendingComboboxes = new Map<number, DyntCombobox>()

  constructor(codePage: number, readings: ScreenReadings = new ScreenReadings(), window?: number, content?: ByteRange) {
    this.text = new ScreenTextDecoder(codePage)
    this.readings = readings
    this.window = window
    this.content = content
  }

  /** The section the decoder reads the window of: `window`'s, else the last one. */
  private get chosen(): Section {
    const window = this.window
    if (window === undefined || !(window < this.closedSections.length)) return this.section
    return this.closedSections[window]
  }

  /** The window's AREASIZE: its section's (the top window's, the last section's, by default). */
  get areaSize(): AreaSize | undefined {
    return this.chosen.areaSize
  }

  /** The window's MNUENTRY items: its section's. */
  get menus(): ScreenMenu[] {
    return this.chosen.menus.slice()
  }

  /** The SES of the window: its section's, or for the whole message the last one that decoded. */
  get windowSES(): SESValue | undefined {
    return this.window === undefined ? this.ses : this.chosen.ses
  }

  walk(items: Uint8Array): void {
    const walker = new DiagItemWalker()
    for (;;) {
      let item: DiagItem | undefined
      try {
        item = walker.next(items)
      } catch (error) {
        if (!(error instanceof DiagItemWalkError)) throw error
        this.diagnostics.itemWalkStop = error
        break
      }
      if (item === undefined) break
      const value = item.valueRange.of(items)
      if (item.type === "ses") {
        const decoded = attempt(() => SESValue.decode(value))
        this.ses = decoded ?? this.ses
        this.startSection(decoded)
        continue
      }
      // Content items belong to the window of the section they follow (issue #147).
      const isContent = this.content?.contains(item.offset) ?? true
      if (item.type === "chl") {
        if (isContent) this.plainListWindow = attempt(() => ListWindowState.decode(value)) ?? this.plainListWindow
        continue
      }
      const appl = item.appl
      if (appl === undefined) continue
      const field = ScreenIdentityText.of(appl)
      if (field !== undefined) {
        this.record(field, item.valueRange)
        continue
      }
      if (applItemCarriesDyntAtoms(appl)) {
        if (isContent) this.readAtoms(value, ApplItem.equals(appl, ApplItem.dynt("tabstripButtons")))
        // Only the atom item right after a page is its subscreen (Reading R-SS-15).
        if (ApplItem.equals(appl, ApplItem.dynt("atom"))) this.subscreenPage = undefined
        continue
      }
      if (!isContent && WindowSectionLayout.followsItsSection(appl)) continue
      this.readItem(appl, value)
    }
  }

  /** The items the walk's `switch` reads. */
  private readItem(appl: ApplItem, value: Uint8Array): void {
    switch (appl.kind) {
      case "mnuEntry":
        this.readMenu(value, appl.sid)
        return
      case "unknownSID":
        if (appl.applID === "mnuEntry") this.diagnostics.codec.unwalkedMenus += 1
        else this.diagnostics.unknownItems += 1
        return
      case "unknownID":
        this.diagnostics.unknownItems += 1
        return
      case "varInfo":
        switch (appl.sid) {
          case "areaSize": {
            const section = this.section
            section.areaSizeCount += 1
            if (section.areaSizeCount > 1) {
              section.areaSize = undefined
              this.diagnostics.codec.repeatedIdentityItems += 1
            } else {
              const size = attempt(() => AreaSize.decode(value))
              if (size !== undefined) section.areaSize = size
              else this.diagnostics.codec.undecodableValues += 1
            }
            return
          }
          case "mestype2":
            if (this.statusMessage === undefined && this.readings.messageType === "mestype2") this.statusMessage = this.typedMessage(value)
            return
          case "okcode":
            this.hasOKCodeItem = true
            return
          case "containerLoop": {
            const loop = this.latestLoop
            const lines = loop === undefined ? undefined : attempt(() => ContainerLoop.decode(value))
            if (loop !== undefined && lines !== undefined) this.containers[loop].linesPerLoopRow = lines.linesPerLoopRow
            else if (loop !== undefined) this.diagnostics.codec.undecodableValues += 1
            return
          }
          case "scrollInfos": {
            const target = this.scrollTarget
            if (target !== undefined) {
              if (!this.tableScrollInfos.has(target)) {
                const scroll = attempt(() => ScrollInfos.decode(value))
                if (scroll !== undefined) this.tableScrollInfos.set(target, scroll)
              }
            } else if (this.listScrollInfos === undefined) {
              this.listScrollInfos = attempt(() => ScrollInfos.decode(value))
            }
            return
          }
          case "listCellText":
            this.hasListRuns = true
            return
          default:
            return
        }
      case "stSystemInfo":
        if (appl.sid === "message" && this.message === undefined) this.message = this.trimmedText(value)
        return
      case "container":
        if (appl.sid === "containerName") {
          const target = this.latestGeometry
          if (target === undefined || this.containerNames.has(target)) return
          const name = attempt(() => ContainerName.decode(value))
          if (name === undefined) return
          this.containerNames.set(target, this.trimmedText(name.containerName.of(value)))
          // The element's own name is the first string; the second is the program (trial-derived,
          // PV-1011, issue #158).
          const element = this.trimmedText(name.subscreenName.of(value))
          if (element.length > 0) this.containers[target].name = element
        } else {
          this.readContainer(value, appl.sid)
        }
        return
      case "dynt":
        if (appl.sid === "focus1") {
          const decoded = attempt(() => DyntFocus.decode(value))
          if (decoded !== undefined) {
            const ids = decoded.containerIDs
            this.focus = { row: decoded.row, col: decoded.col, colOffset: decoded.colOffset, container: ids.isEmpty ? 0 : value[ids.lowerBound] }
          }
        }
        return
      case "dynn":
        if (appl.sid === "chl") this.listWindow = attempt(() => ListWindowState.decode(value)) ?? this.listWindow
        return
      default:
        return
    }
  }

  /**
   * A CONTAINER item (server-screen.md §8.6, Reading R-SS-14): RESET empties the containers in force;
   * LOOP, TABLE, TABSTRIP, TABSTRIP_PAGE, CONTROL and SUBSCREEN (Reading R-SS-16) declare one, whose
   * id the atoms after it name in their `area`. A geometry that fails its layout is counted and
   * declares nothing; the other sids (DEFAULT, …) place nothing.
   */
  private readContainer(value: Uint8Array, sid: ApplSIDContainer): void {
    let kind: ScreenContainerKind
    switch (sid) {
      case "loop":
      case "table":
      case "tabstrip":
      case "tabstripPage":
      case "control":
      case "subscreen":
        kind = sid
        break
      case "reset":
        this.areas = new Map()
        this.latestLoop = undefined
        this.latestGeometry = undefined
        this.scrollTarget = undefined
        this.group = []
        this.subscreenPage = undefined
        if (attempt(() => ContainerGeometry.decode(value)) === undefined) this.diagnostics.codec.undecodableValues += 1
        return
      default: {
        // Kept in structure for the report (issues #155, #162).
        const bytes = value.length <= ScreenContainerItem.shortValueLimit ? value.slice() : new Uint8Array(0)
        this.otherContainerItems.push(new ScreenContainerItem({ kind: ApplSID.Container.name(sid).toLowerCase(), byteCount: value.length, bytes }))
        return
      }
    }
    const geometry = attempt(() => ContainerGeometry.decode(value))
    if (geometry === undefined) {
      this.diagnostics.codec.undecodableValues += 1
      return
    }
    // A container counts from its enclosing tabstrip/page (R-SS-15). The opt-in
    // subscreen reading extends that chain to nested subscreens (issue #188).
    // provenance: PV-1032
    let origin = new GridPoint(geometry.row, geometry.col)
    let parent: number | undefined
    for (let position = this.group.length - 1; position >= 0; position--) {
      const candidate = this.containers[this.group[position]].kind
      if (candidate === "tabstrip" || candidate === "tabstripPage" || (this.readings.nestedSubscreens && candidate === "subscreen")) {
        parent = this.group[position]
        break
      }
    }
    if (parent !== undefined) {
      const start = this.containers[parent].origin
      origin = new GridPoint(start.row + origin.row, start.column + origin.column)
    }
    const container = new ScreenContainer({ id: geometry.containerID, kind, origin, width: geometry.width, height: geometry.height })
    // A container declared again in a later group is the same container (issue #155).
    let index = this.containers.findIndex(
      known =>
        known.id === container.id &&
        known.kind === kind &&
        GridPoint.equals(known.origin, origin) &&
        known.width === container.width &&
        known.height === container.height
    )
    if (index < 0) {
      this.containers.push(container)
      index = this.containers.length - 1
    }
    this.group.push(index)
    if (kind === "tabstripPage" || kind === "subscreen") this.subscreenPage = index
    if (kind === "loop") this.latestLoop = index
    this.latestGeometry = index
    this.scrollTarget = kind === "table" ? index : undefined
    // Area 0 is the main screen whatever a container claims.
    if (container.id !== 0) this.areas.set(container.id, index)
  }

  /**
   * Where an atom sits on the whole screen: its container's origin plus its row and column, and the
   * container's index. An area with no container in force is placed as area 0 and counted.
   */
  private placement(header: DyntAtomHeader): { point: GridPoint; container: number | undefined } {
    const row = header.row
    const column = header.col
    const page = this.subscreenPage
    if (header.area === 0 && page !== undefined) {
      // The page's or the SUBSCREEN's subscreen: its atoms count from it (Readings R-SS-15, R-SS-16).
      const origin = this.containers[page].origin
      return { point: new GridPoint(origin.row + row, origin.column + column), container: page }
    }
    if (header.area === 0) return { point: new GridPoint(row, column), container: undefined }
    const index = this.areas.get(header.area)
    if (index === undefined) {
      this.diagnostics.atomsWithoutContainer += 1
      return { point: new GridPoint(row, column), container: undefined }
    }
    const origin = this.containers[index].origin
    return { point: new GridPoint(origin.row + row, origin.column + column), container: index }
  }

  private record(field: ScreenIdentityText, range: ByteRange): void {
    const section = this.section
    const count = (section.identityCounts.get(field) ?? 0) + 1
    section.identityCounts.set(field, count)
    if (count > 1) {
      section.identityRanges.delete(field)
      this.diagnostics.codec.repeatedIdentityItems += 1
    } else {
      section.identityRanges.set(field, range)
    }
  }

  /**
   * An SES item (Reading R-EL-23): the first one opens the first section, which keeps the items
   * before it; each later one closes the section before it and opens a new one. Under
   * `wholeMessage` the message stays one section.
   */
  private startSection(ses: SESValue | undefined): void {
    this.sesCount += 1
    if (this.readings.windowSections !== "sesSections") {
      this.section.ses = ses ?? this.section.ses
      return
    }
    if (this.sesCount > 1) {
      this.closedSections.push(this.section)
      this.section = new Section()
    }
    this.section.ses = ses
  }

  /**
   * The window's identity texts (the top window's, the last section's, by default), decoded after
   * the walk so that a repeated item is known (#54). The transaction, system name and client, which
   * name the session rather than a window, come from the first section when the window's section
   * lacks them.
   */
  identity(items: Uint8Array): ScreenIdentityTexts {
    const identity = this.identityOf(this.chosen, items)
    const first = this.closedSections[0]
    if (first !== undefined && this.window !== 0) {
      const whole = this.identityOf(first, items)
      identity.transaction = identity.transaction ?? whole.transaction
      identity.systemName = identity.systemName ?? whole.systemName
      identity.client = identity.client ?? whole.client
    }
    return identity
  }

  /** The identity texts of one section. */
  private identityOf(section: Section, items: Uint8Array): ScreenIdentityTexts {
    const text = (field: ScreenIdentityText): string | undefined => {
      const range = section.identityRanges.get(field)
      return range === undefined ? undefined : this.trimmedText(range.of(items))
    }
    const identity = new ScreenIdentityTexts()
    identity.title = text("sessionTitle")
    identity.program = text("dynproName")
    identity.screenNumber = text("dynproNumber")
    identity.transaction = text("tcode")
    identity.guiProgram = text("cuaName")
    identity.guiStatus = text("cuaStatus")
    identity.systemName = text("dbName")
    identity.client = text("client")
    return identity
  }

  /**
   * The message's window sections (Reading R-EL-23): one per SES item, the last the top window; none
   * without SES. Under `wholeMessage`, one for a message with an SES.
   */
  windowSections(items: Uint8Array): ScreenWindowSection[] {
    if (!(this.sesCount > 0)) return []
    // The top window's texts were decoded and counted for `identity`: decoding them again here
    // counts nothing, so that a repaired text is counted once.
    const counted = this.text.clone()
    try {
      return [...this.closedSections, this.section].map(section => {
        const window = section.ses === undefined ? undefined : PopupWindow.fromSES(section.ses, this.readings.popup)
        return new ScreenWindowSection({
          level: window?.level ?? 0,
          ses: section.ses,
          identity: this.identityOf(section, items),
          size: section.areaSize === undefined ? undefined : ScreenSize.of(section.areaSize),
          menus: section.menus.slice()
        })
      })
    } finally {
      this.text = counted
    }
  }

  /**
   * A text item's value, decoded and trimmed per R-SS-4: trailing spaces and zero characters removed,
   * after decoding, so that a UTF-16 text is cut at whole characters.
   */
  private trimmedText(value: Uint8Array): string {
    return ScreenTextDecoding.trimmingPadding(this.text.decode(value))
  }

  /**
   * A MESTYPE2 value as a typed message (Reading R-EL-14): the type, the text trimmed (R-SS-4) with
   * its leading markup split off (R-DA-10), and the class and number when either is sent.
   */
  private typedMessage(value: Uint8Array): ScreenStatusMessage | undefined {
    const decoded = attempt(() => StatusMessageValue.decode(value))
    if (decoded === undefined) return undefined
    const messageClass = this.trimmedText(decoded.classRange.of(value))
    const number = this.trimmedText(decoded.numberRange.of(value))
    const text = TextMarkup.parse(this.trimmedText(decoded.textRange.of(value))).caption
    const id = messageClass.length === 0 && number.length === 0 ? undefined : new ScreenStatusMessageID({ messageClass, number })
    return new ScreenStatusMessage({ type: ScreenMessageType.of(decoded.type), text, id })
  }

  private readAtoms(value: Uint8Array, isTabstripButtons: boolean): void {
    const walker = new DyntAtomWalker()
    let decodedButtons = 0
    // The element of the latest atom that is not a child, by atom index (IMPL-DA-4).
    let parent: { atomIndex: number; element: number } | undefined
    this.pendingComboboxes.clear()
    for (;;) {
      let atom: DyntAtom | undefined
      try {
        atom = walker.next(value)
      } catch (error) {
        if (!(error instanceof DyntAtomWalkError)) throw error
        this.diagnostics.stoppedAtomWalks += 1
        break
      }
      if (atom === undefined) break
      if (DyntElementType.isChildMetadata(atom.etype)) {
        if (parent !== undefined && atom.parentIndex === parent.atomIndex) this.readChild(atom, value, parent.element)
        continue
      }
      const { element, container } = this.element(atom, value)
      if (atom.payload.kind === "pushButton" && (element.text !== undefined || element.functionCode !== undefined)) {
        decodedButtons += 1
      } else if (atom.payload.kind === "radioButton" && element.text !== undefined) {
        decodedButtons += 1
      }
      this.elements.push(element)
      this.elementContainers.push(container)
      if (isTabstripButtons && element.kind.kind === "tab") this.tabButtonElements.push(this.elements.length - 1)
      parent = { atomIndex: atom.index, element: this.elements.length - 1 }
    }
    // Comboboxes without a ZZValueList stay what the walker made of them (R-EL-3).
    this.diagnostics.undecodedElements += this.pendingComboboxes.size
    this.pendingComboboxes.clear()
    const atoms = walker.diagnostics
    // Button strings the model read under ScreenReadings.buttonStrings are decoded after all.
    atoms.undecodedButtonStrings -= Math.min(atoms.undecodedButtonStrings, decodedButtons)
    accumulate(this.diagnostics.codec.atoms, atoms)
  }

  /**
   * A FNAME or XMLPROP child of the element at `index` (IMPL-DA-4): the first FNAME names the field;
   * an XMLPROP's `DefaultTooltip` is the tooltip unless the text's markup gave one, and its
   * `ZZValueList` makes a combobox a dropdown (Reading R-EL-3). A password field's children repeat
   * INVISIBLE and are not decoded.
   */
  private readChild(atom: DyntAtom, value: Uint8Array, index: number): void {
    switch (atom.etype.kind) {
      case "fname":
        if (this.elements[index].fieldName === undefined) this.elements[index].fieldName = this.textOf(atom, value)
        return
      case "xmlprop": {
        const property = this.textOf(atom, value)
        if (property === undefined) return
        if (this.elements[index].tooltip === undefined) this.elements[index].tooltip = XMLPropertyText.defaultTooltip(property)
        const combobox = this.pendingComboboxes.get(index)
        const list = combobox === undefined ? undefined : ZZValueList.fromPropertyText(property)
        if (combobox !== undefined && list !== undefined) {
          this.pendingComboboxes.delete(index)
          this.makeDropdown(index, combobox, list, value)
        }
        return
      }
      default:
        return
    }
  }

  /** Turns the combobox element at `index` into a dropdown (Reading R-EL-3): its text is the selected key, its options the list's values. */
  private makeDropdown(index: number, combobox: DyntCombobox, list: ZZValueList, value: Uint8Array): void {
    const old = this.elements[index]
    const field = combobox.field
    const key = ScreenTextDecoding.trimmingPadding(this.text.decode(field.textRange.of(value)))
    const options = list.values.map(option => new ScreenDropdownOption({ key: option.key, text: option.text }))
    const markers = FieldMarkers.of(field.flag1, old.atom.attributes, this.readings.fieldMarkers)
    const functionCode = list.functionCode === undefined || list.functionCode.length === 0 ? undefined : list.functionCode
    const element = new ScreenElement({
      id: old.id,
      kind: ScreenElementKind.dropdown,
      width: field.mlen,
      height: undefined,
      maxLength: field.maxNrChars,
      text: key,
      atom: old.atom,
      placement: old.placement,
      dropdown: new ScreenDropdown({ options, selectedKey: key.length === 0 ? undefined : key, allowsEmpty: list.allowsEmpty }),
      isRequired: (markers & FieldMarkers.required) !== 0,
      firesFunction: functionCode
    })
    element.fieldName = old.fieldName
    element.tooltip = old.tooltip
    element.dropdownBody = { flag1: field.flag1, mlen: field.mlen, maxNrChars: field.maxNrChars }
    this.elements[index] = element
    this.diagnostics.codec.atoms.opaquePayloads -= 1
  }

  private element(atom: DyntAtom, value: Uint8Array): { element: ScreenElement; container: number | undefined } {
    const first = ScreenElementID.ofHeader(atom.header).mapKey
    const occurrence = this.occurrences.get(first) ?? 0
    this.occurrences.set(first, occurrence + 1)
    const kind = ScreenElementKind.of(atom.etype)
    let width: number | undefined
    let height: number | undefined
    let maxLength: number | undefined
    let markers: FieldMarkers = 0
    const payload = atom.payload
    switch (payload.kind) {
      case "field": {
        const field = payload.value
        width = field.mlen
        if (DyntElementType.fieldRole(atom.etype) === "editable") maxLength = field.maxNrChars
        if (kind.kind === "input" || kind.kind === "output") {
          // The invented flag1 bits are read on the `_2` form only (R-EL-16).
          markers = FieldMarkers.of(field.form === "v2" ? field.flag1 : 0, atom.attributes, this.readings.fieldMarkers)
        }
        break
      }
      case "frame":
        width = payload.value.dcols
        height = payload.value.drows
        break
      case "tabstripButton":
        width = payload.value.vLength
        height = payload.value.vHeight
        break
      case "pushButton":
        width = payload.value.vLength
        height = payload.value.vHeight
        break
      case "radioButton":
        width = payload.value.visibleLabelLength
        break
      case "opaque":
      case "text":
      case "undecodable":
        break
    }
    let caption = this.textOf(atom, value)
    let isChecked: boolean | undefined
    let nativeRadioCaption: Uint8Array | undefined
    let firesFunction: string | undefined
    let decodedOpaque = false
    if (kind.kind === "checkbox" || kind.kind === "radioButton") {
      const toggle = DyntToggle.fromAtom(atom, value, this.readings.checkbox)
      if (toggle !== undefined) {
        width = toggle.visibleLength
        isChecked = toggle.isChecked
        decodedOpaque = payload.kind === "opaque"
        if (!atom.isPasswordField) {
          if (toggle.usesNumericState) nativeRadioCaption = toggle.captionRange.of(value).slice()
          caption = ScreenTextDecoding.trimmingPadding(this.text.decode(toggle.captionRange.of(value)))
          const code = toggle.functionCodeRange(value)
          if (code !== undefined) firesFunction = ScreenTextDecoding.trimmingTrailingSpaces(this.text.decode(code.of(value)))
        }
      } else if (this.readings.checkbox !== "specGap") {
        this.diagnostics.undecodedElements += 1
      }
    }
    const placed = this.placement(atom.header)
    const isProtected = (atom.attributes & DyntAttributes.protected) !== 0
    const isDisabled = (kind.kind === "button" || kind.kind === "tab") && isProtected && this.readings.fieldMarkers !== "specGap"
    // Reading R-EL-16a: an editable field whose whole text is `?` is an empty required field.
    const holdsRequiredMarker =
      this.readings.requiredMarker === "questionMark" &&
      kind.kind === "input" &&
      DyntElementType.fieldRole(atom.etype) === "editable" &&
      !atom.isPasswordField &&
      !isProtected &&
      caption !== undefined &&
      caption.replace(/^ +/, "") === RequiredMarkerReading.marker
    const element = new ScreenElement({
      id: ScreenElementID.ofHeader(atom.header, occurrence),
      kind,
      width,
      height,
      maxLength,
      text: caption,
      atom,
      placement: placed.point,
      isChecked,
      isRequired: (markers & FieldMarkers.required) !== 0,
      inputFormat: inputFormat(markers),
      hasValueHelp: (markers & FieldMarkers.valueHelp) !== 0,
      isDisabled,
      firesFunction,
      holdsRequiredMarker
    })
    element.nativeRadioCaption = nativeRadioCaption
    element.functionCode = this.functionCodeOf(atom, value)
    if (decodedOpaque) this.diagnostics.codec.atoms.opaquePayloads -= 1
    if (DyntCombobox.isCombobox(atom.etype) && this.readings.dropdown !== "specGap") {
      const combobox = atom.isPasswordField ? undefined : DyntCombobox.fromAtom(atom, value, this.readings.dropdown)
      if (combobox !== undefined) {
        // The XMLPROP child decides (R-EL-3); the element index is the next one.
        this.pendingComboboxes.set(this.elements.length, combobox)
      } else {
        this.diagnostics.undecodedElements += 1
      }
    }
    return { element, container: placed.container }
  }

  /** The function code a push button (Reading R-DA-9) or a tab (PV-0656) sends, or undefined. */
  private functionCodeOf(atom: DyntAtom, value: Uint8Array): string | undefined {
    let range: ByteRange | undefined
    const payload = atom.payload
    switch (payload.kind) {
      case "pushButton":
        range = DyntButtonStrings.pushButtonStrings(payload.value, value, this.readings.buttonStrings)?.functionCode
        break
      case "tabstripButton":
        range = payload.value.functionCodeRange
        break
      default:
        range = undefined
    }
    if (atom.isPasswordField || range === undefined || !(range.upperBound <= value.length)) return undefined
    return ScreenTextDecoding.trimmingTrailingSpaces(this.text.decode(range.of(value)))
  }

  /**
   * The atom's text with trailing spaces and zero characters removed (R-DA-11), or undefined for a
   * password field and an atom with no decoded text part (opaque payloads, the button strings of
   * #35). A field of zero bytes, as a server sends an empty input, is empty. (Swift `text(of:in:)`.)
   */
  private textOf(atom: DyntAtom, value: Uint8Array): string | undefined {
    if (atom.isPasswordField) return undefined
    const range = DyntButtonStrings.textRange(atom, this.readings.buttonStrings, value)
    if (range === undefined || !(range.lowerBound >= 0) || !(range.upperBound <= value.length)) return undefined
    return ScreenTextDecoding.trimmingPadding(this.text.decode(range.of(value)))
  }

  private readMenu(value: Uint8Array, kind: ApplSIDMnuEntry): void {
    const walk = MenuEntries.walk(value, this.readings.menuEntryPadding)
    const entries: ScreenMenuEntry[] = []
    for (const entry of walk.entries) {
      const accelerator = entry.accelerator.isEmpty ? undefined : this.text.decode(entry.accelerator.of(value))
      const info = entry.info.isEmpty ? undefined : this.text.decode(entry.info.of(value))
      entries.push(new ScreenMenuEntry({ text: this.text.decode(entry.text.of(value)), accelerator, info, fields: entry.fields }))
    }
    if (walk.error !== undefined) this.diagnostics.codec.stoppedMenus += 1
    this.section.menus.push(new ScreenMenu({ kind, entries, isTruncated: walk.error !== undefined }))
  }
}

/** The format a field's markers give (R-EL-16): a date wins over numeric. */
function inputFormat(markers: FieldMarkers): ScreenInputFormat {
  if ((markers & FieldMarkers.date) !== 0) return "date"
  if ((markers & FieldMarkers.numeric) !== 0) return "numeric"
  return "text"
}
