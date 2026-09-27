// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenCarry.swift (MIT).

// What a window level keeps from one server message to the next (docs/protocol/elements.md
// Readings R-EL-13a, R-EL-16a and R-EL-22). A GUI status and a title stay in force until they are
// set again [SAP-ABAP-PFSTATUS, SAP-ABAP-TITLEBAR · sap-doc], a real system sends its setup once and
// then only screens [ODG `pkg/lsd/scenes.go` · odg], and sap-tui keeps title, menus and toolbar when
// a frame lacks them [TUI-VIEW `chrome.update` · odg code]; the owner saw a popup sent again after
// Enter without any MNUENTRY item (PV-0992, trial-derived). Which item carries what, and whether a
// server leaves MNUENTRY out exactly when the status is unchanged, is not stated (#112).
//
// Swift's `extension Screen` of this file (`keepsContent(of:)`, `keepContent(of:readings:)`,
// `adoptStatus(_:readings:)`) is the object `ScreenCarry`, whose functions take the screen;
// `Screen` has methods that call them.

import { ScreenReadings } from "./functionTrigger.js"
import type { Screen } from "./screen.js"
import { FunctionBuilder } from "./screenFunction.js"
import type { ScreenMenu } from "./screenMenu.js"
import { ScreenCursor } from "./screenPopup.js"
import { ScreenStructureBuilder } from "./screenStructure.js"

/**
 * The server's `?` in an empty required field (elements.md Reading R-EL-16a).
 * - `questionMark`: the default: an editable input (not protected, not a password) whose whole text
 *   is `?` is an empty required field: drawn empty with the required marker; only typed text goes
 *   back.
 * - `literal`: the fallback: the `?` is the field's text, as before R-EL-16a.
 */
export type RequiredMarkerReading = "questionMark" | "literal"

export const RequiredMarkerReading = {
  allCases: ["questionMark", "literal"] as readonly RequiredMarkerReading[],
  /** The marker's text, as received after trimming (R-SS-4). */
  marker: "?"
} as const

/**
 * How a window level keeps its GUI status (elements.md Reading R-EL-22).
 * - `perLevelWholeStatus`: the default: one GUI status per window level (0 the main window, 1 to 9
 *   the popups). A message with any MNUENTRY item replaces its level's whole status; one without
 *   keeps it. A popup level entered from below starts with none; closing a level drops its status; a
 *   logon screen keeps and hands on nothing. In a message of several window sections (Reading
 *   R-EL-23) each section's MNUENTRY items are its own level's status.
 * - `none`: the fallback: each message's own MNUENTRY items only, as before R-EL-22.
 */
export type StatusCarryReading = "perLevelWholeStatus" | "none"
export const StatusCarryReading = { allCases: ["perLevelWholeStatus", "none"] as readonly StatusCarryReading[] } as const

/**
 * Where a popup's title comes from when its message carries none (elements.md Reading R-EL-13a).
 * - `sessionTitleCarried`: the default: this message's SESSION_TITLE, else the one last received for
 *   the same popup level (a popup sent again).
 * - `sessionTitle`: the fallback: this message's SESSION_TITLE only, as before R-EL-13a.
 */
export type PopupTitleReading = "sessionTitleCarried" | "sessionTitle"
export const PopupTitleReading = { allCases: ["sessionTitleCarried", "sessionTitle"] as readonly PopupTitleReading[] } as const

/** What carrying did to one message's screen (Swift `WindowLevelCarry.Note`). */
export class WindowLevelCarryNote {
  /** The message whose GUI status the screen now has, because it came without one of its own. */
  statusFrom: number | undefined
  /** A popup's title carried from an earlier message of the same level, and that message. */
  title: string | undefined
  titleFrom: number | undefined

  constructor(fields: { statusFrom?: number | undefined; title?: string | undefined; titleFrom?: number | undefined } = {}) {
    this.statusFrom = fields.statusFrom
    this.title = fields.title
    this.titleFrom = fields.titleFrom
  }
}

/** What one level keeps (Swift's private `Kept`). */
interface Kept {
  menus: readonly ScreenMenu[]
  statusMessage: number | undefined
  title: string | undefined
  titleMessage: number | undefined
}

/**
 * What each window level of one mode keeps from one message to the next (Readings R-EL-13a and
 * R-EL-22): its GUI status, and a popup's title. A session keeps one per mode, from its first
 * message; a new mode and a new connection start with an empty one. A Swift struct: `clone()` copies
 * it.
 */
export class WindowLevelCarry {
  status: StatusCarryReading
  title: PopupTitleReading

  private levels = new Map<number, Kept>()
  private lastLevel: number | undefined

  constructor(fields: { status?: StatusCarryReading; title?: PopupTitleReading } = {}) {
    this.status = fields.status ?? "perLevelWholeStatus"
    this.title = fields.title ?? "sessionTitleCarried"
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): WindowLevelCarry {
    const copy = new WindowLevelCarry({ status: this.status, title: this.title })
    copy.levels = new Map(Array.from(this.levels, ([level, kept]) => [level, { ...kept }]))
    copy.lastLevel = this.lastLevel
    return copy
  }

  /** The window level of `screen`: 0 for a main screen, a popup's level. */
  static level(screen: Screen): number {
    return screen.presentation.kind === "popup" ? screen.presentation.value.level : 0
  }

  /**
   * Gives `screen`, from message `number`, what its level keeps when the message lacks it, and keeps
   * what the message has for the messages after it. Returns what was carried. (Swift
   * `carry(into:message:)`; the screen is changed in place.)
   */
  carry(screen: Screen, number: number): WindowLevelCarryNote {
    const level = WindowLevelCarry.level(screen)
    try {
      if (screen.isLogonScreen) {
        // A logon screen starts a session's screens afresh: nothing before it counts, and its own
        // status is the logon program's.
        this.levels = new Map()
        return new WindowLevelCarryNote()
      }
      // The levels above this one closed; a popup level entered from below is a new popup.
      this.levels = new Map(Array.from(this.levels).filter(([key]) => key <= level))
      if (level > 0 && (this.lastLevel ?? 0) < level) this.levels.delete(level)
      if (this.status === "perLevelWholeStatus") {
        // A message of several window sections (Reading R-EL-23) sets the status of each lower
        // level whose section carries one: a popup's first message may also give the main window
        // its status, which a main screen sent later without MNUENTRY then keeps.
        for (const section of screen.windowSections.slice(0, -1)) {
          if (!(section.level < level && section.menus.length > 0)) continue
          const earlier = this.levels.get(section.level)
          this.levels.set(section.level, {
            menus: section.menus,
            statusMessage: number,
            title: earlier?.title,
            titleMessage: earlier?.titleMessage
          })
        }
      }
      const known = this.levels.get(level)
      const kept: Kept = known === undefined ? { menus: [], statusMessage: undefined, title: undefined, titleMessage: undefined } : { ...known }
      const note = new WindowLevelCarryNote()
      switch (this.status) {
        case "perLevelWholeStatus":
          if (screen.menus.length > 0) {
            kept.menus = screen.menus
            kept.statusMessage = number
          } else if (kept.statusMessage !== undefined && kept.menus.length > 0) {
            screen.adoptStatus(kept.menus)
            note.statusFrom = kept.statusMessage
          }
          break
        case "none":
          break
      }
      if (level > 0 && screen.presentation.kind === "popup") {
        const own = screen.presentation.value.title
        if (own !== undefined && own.length > 0) {
          kept.title = own
          kept.titleMessage = number
        } else if (this.title === "sessionTitleCarried" && kept.title !== undefined) {
          note.title = kept.title
          note.titleFrom = kept.titleMessage
        }
      }
      this.levels.set(level, kept)
      return note
    } finally {
      this.lastLevel = level
    }
  }
}

// MARK: - Screen members (Swift's `extension Screen`)

/** The members Swift's `extension Screen` of ScreenCarry.swift adds; `Screen` calls them. */
export const ScreenCarry = {
  /**
   * Whether `screen`'s window keeps what `previous` showed (Reading R-EL-23, issue #147, issue
   * #153): its message has several window sections, the top one without content of its own, and it
   * names the window `previous` is: the same level, and the same program and screen number (a name
   * the section lacks counts as the same). The owner's server refused a selection popup that way, a
   * required field left out (PV-0994). Never across a logon screen or a server error. (Swift
   * `keepsContent(of:)`.)
   */
  keepsContent(screen: Screen, previous: Screen): boolean {
    const top = screen.windowSections.length > 1 ? screen.windowSections[screen.windowSections.length - 1] : undefined
    if (top === undefined || top.hasContent) return false
    if (screen.isLogonScreen || previous.isLogonScreen || screen.isServerError || previous.isServerError) return false
    if (WindowLevelCarry.level(screen) !== WindowLevelCarry.level(previous)) return false
    const program = screen.identity.program ?? previous.identity.program
    const screenNumber = screen.identity.screenNumber ?? previous.identity.screenNumber
    return program === previous.identity.program && screenNumber === previous.identity.screenNumber
  },

  /**
   * `screen` with the content `previous` showed (`keepsContent`): its elements, containers, radio
   * groups, tabstrips, tables and list, the functions built again from this screen's GUI status and
   * those elements, and the cursor this message set, placed on them (without one, the cursor
   * `previous` had). Its identity, size, window state, GUI status and message stay this message's.
   * (Swift `keepContent(of:readings:)`; the screen is changed in place.)
   */
  keepContent(screen: Screen, previous: Screen, readings: ScreenReadings = new ScreenReadings()): void {
    screen.elements = previous.elements.slice()
    screen.containers = previous.containers.slice()
    screen.otherContainerItems = previous.otherContainerItems.slice()
    screen.radioGroups = previous.radioGroups.slice()
    screen.tabstrips = previous.tabstrips.slice()
    screen.tables = previous.tables.slice()
    screen.list = previous.list
    const builder = new FunctionBuilder(screen.menus, screen.elements, readings)
    screen.functions = builder.functions
    screen.menuBar = builder.menuBar
    screen.diagnostics.unplacedMenuEntries = builder.unplacedEntries
    const cursor = screen.cursor
    if (cursor !== undefined) {
      screen.cursor = new ScreenCursor({
        element: ScreenStructureBuilder.element(cursor.position, cursor.area, screen.elements),
        position: cursor.position,
        area: cursor.area,
        offset: cursor.offset
      })
    } else {
      screen.cursor = previous.cursor
    }
  },

  /**
   * `screen` with `menus` as its GUI status (Reading R-EL-22): its functions and menu bar are built
   * again from them and its own elements, as the message's own MNUENTRY items would build them, so
   * that the input step fires them as any other. (Swift `adoptStatus(_:readings:)`; the screen is
   * changed in place.)
   */
  adoptStatus(screen: Screen, menus: readonly ScreenMenu[], readings: ScreenReadings = new ScreenReadings()): void {
    screen.menus = menus.slice()
    const builder = new FunctionBuilder(menus, screen.elements, readings)
    screen.functions = builder.functions
    screen.menuBar = builder.menuBar
    screen.diagnostics.unplacedMenuEntries = builder.unplacedEntries
  }
} as const
