// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenPopup.swift (MIT).

// The model of popups, typed status messages and the cursor (docs/protocol/elements.md §8, §9 and
// §11; Readings R-EL-13, R-EL-14 and R-EL-17), and of a message's window sections (Reading R-EL-23).
// Pinned API of the mock-apps work.

import { ByteRange, DiagItemWalkError, DiagItemWalker, type ApplItem, type DiagItem, type SESValue, type StatusMessageType } from "../codec/index.js"
import type { ScreenIdentityTexts, ScreenSize } from "./screen.js"
import type { ScreenElementID } from "./screenElement.js"
import type { GridPoint, GridRect } from "./screenLayout.js"
import type { ScreenMenu } from "./screenMenu.js"

/** A popup screen (elements.md Reading R-EL-13): its level and where it sits. */
export class ScreenPopup {
  /** 1 = on the main screen, 2 = on a popup, … at most 9 (PV-0975). */
  readonly level: number
  /**
   * SES x_pos and y_pos (from 1) as the origin and dim_row × dim_col as the size, converted to the
   * 0-based grid; undefined when the server sends no position.
   */
  readonly frame: GridRect | undefined
  /** The popup's title (SESSION_TITLE). */
  readonly title: string | undefined

  constructor(fields: { level: number; frame: GridRect | undefined; title: string | undefined }) {
    this.level = fields.level
    this.frame = fields.frame
    this.title = fields.title
  }
}

/**
 * How a screen is shown (elements.md Reading R-EL-13).
 * - `main`: a main screen: it closes every open popup.
 * - `popup`: a popup above the main screen or above another popup.
 */
export type ScreenPresentation = { readonly kind: "main" } | { readonly kind: "popup"; readonly value: ScreenPopup }

export const ScreenPresentation = {
  main: { kind: "main" } as ScreenPresentation,
  popup: (value: ScreenPopup): ScreenPresentation => ({ kind: "popup", value })
} as const

/** A message's class and number, when the server sends them (MESTYPE2, PV-0973). (Swift `ScreenStatusMessage.MessageID`.) */
export class ScreenStatusMessageID {
  readonly messageClass: string
  readonly number: string

  constructor(fields: { messageClass: string; number: string }) {
    this.messageClass = fields.messageClass
    this.number = fields.number
  }
}

/**
 * The type of a status message (PV-0974). Swift's `.error` is `{ kind: "error" }`
 * (`ScreenMessageType.error`).
 * - `success`: `S`: in the status bar.
 * - `information`: `I`: a dialog whose OK sends Enter.
 * - `warning`: `W`: in the status bar; the user may continue.
 * - `error`: `E`: in the status bar; the fields are ready for input again.
 * - `abort`: `A`: a dialog whose OK sends Enter; the program ends.
 * - `exit`: `X`: a runtime error.
 * - `none`: a message without a type: ST_R3INFO MESSAGE alone.
 * - `unknown`: a type byte PV-0974 does not name, kept.
 */
export type ScreenMessageType =
  | { readonly kind: "success" }
  | { readonly kind: "information" }
  | { readonly kind: "warning" }
  | { readonly kind: "error" }
  | { readonly kind: "abort" }
  | { readonly kind: "exit" }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly value: number }

export const ScreenMessageType = {
  success: { kind: "success" } as ScreenMessageType,
  information: { kind: "information" } as ScreenMessageType,
  warning: { kind: "warning" } as ScreenMessageType,
  error: { kind: "error" } as ScreenMessageType,
  abort: { kind: "abort" } as ScreenMessageType,
  exit: { kind: "exit" } as ScreenMessageType,
  none: { kind: "none" } as ScreenMessageType,
  unknown: (value: number): ScreenMessageType => ({ kind: "unknown", value }),

  /** The model of the codec's message type (Swift `init(_:)`). */
  of(type: StatusMessageType): ScreenMessageType {
    return type.kind === "unknown" ? { kind: "unknown", value: type.value } : { kind: type.kind }
  },

  /** Whether the client shows the message as a dialog rather than in the status bar: I and A (R-EL-14). */
  showsAsDialog(type: ScreenMessageType): boolean {
    return type.kind === "information" || type.kind === "abort"
  },

  /** The type's letter (PV-0974), as MESTYPE2's byte 0 carries it; undefined for `none`. */
  letter(type: ScreenMessageType): string | undefined {
    switch (type.kind) {
      case "success":
        return "S"
      case "information":
        return "I"
      case "warning":
        return "W"
      case "error":
        return "E"
      case "abort":
        return "A"
      case "exit":
        return "X"
      case "none":
        return undefined
      case "unknown":
        return String.fromCharCode(type.value)
    }
  }
} as const

/** A status message with its type (elements.md Reading R-EL-14). */
export class ScreenStatusMessage {
  readonly type: ScreenMessageType
  /** The text, trimmed (R-SS-4), with a leading icon markup split off per R-DA-10. */
  readonly text: string
  /** The class and number, when sent. */
  readonly id: ScreenStatusMessageID | undefined

  constructor(fields: { type: ScreenMessageType; text: string; id?: ScreenStatusMessageID | undefined }) {
    this.type = fields.type
    this.text = fields.text
    this.id = fields.id
  }
}

/** Where the server put the cursor (DYNT_FOCUS_1, PV-0711; elements.md Reading R-EL-17). */
export class ScreenCursor {
  /** The element at the focus position, when one is there. */
  readonly element: ScreenElementID | undefined
  /** The row and column as received. */
  readonly position: GridPoint
  /** The container id: the area of the element (0 in the main area). */
  readonly area: number
  /** The caret inside the element (the column offset). */
  readonly offset: number

  constructor(fields: { element: ScreenElementID | undefined; position: GridPoint; area?: number; offset?: number }) {
    this.element = fields.element
    this.position = fields.position
    this.area = fields.area ?? 0
    this.offset = fields.offset ?? 0
  }
}

/**
 * How a message's SES items divide it (elements.md Reading R-EL-23).
 * - `sesSections`: the default: each SES item opens a window section; the identity items, AREASIZE
 *   and the GUI status are per section, and the last section is the top window. An identity item
 *   twice in one section is spec gap #54; once in each of two sections it is not.
 * - `wholeMessage`: the fallback: the message is one section, as before R-EL-23: an identity item in
 *   two sections is a #54 repeat, and every MNUENTRY item is one GUI status.
 */
export type WindowSectionReading = "sesSections" | "wholeMessage"
export const WindowSectionReading = { allCases: ["sesSections", "wholeMessage"] as readonly WindowSectionReading[] } as const

/**
 * One window section of a server message (elements.md Reading R-EL-23): what an SES item and the
 * items after it, up to the next SES, say about one window.
 */
export class ScreenWindowSection {
  /** The window level: 0 the main window, 1 to 9 a popup (SES modal_number, Reading R-EL-13). */
  readonly level: number
  /** The section's SES value, when it decoded. */
  readonly ses: SESValue | undefined
  /** The section's identity texts. A text twice in the section is undefined (#54). */
  readonly identity: ScreenIdentityTexts
  /** The section's AREASIZE. */
  readonly size: ScreenSize | undefined
  /** The section's MNUENTRY items: its window's GUI status, when the message sends it. */
  readonly menus: readonly ScreenMenu[]
  /**
   * Whether the section carries content of its own (issue #147): elements (DYNT_ATOM or
   * DYNT_TABSTRIP_BUTTONS atoms), list runs or a geometry container. A section without content
   * leaves its window showing what it showed; its window state alone is no content. (Swift
   * `internal(set)`.)
   */
  hasContent = false
  /** How many elements the section's content holds (0 without content). (Swift `internal(set)`.) */
  elementCount = 0

  constructor(fields: {
    level: number
    ses?: SESValue | undefined
    identity: ScreenIdentityTexts
    size: ScreenSize | undefined
    menus: readonly ScreenMenu[]
  }) {
    this.level = fields.level
    this.ses = fields.ses
    this.identity = fields.identity
    this.size = fields.size
    this.menus = fields.menus
  }
}

/** One section of a `WindowSectionLayout` (Swift `WindowSectionLayout.Section`). */
export interface WindowSectionLayoutSection {
  /** The section's items: from its SES item (or the sequence's start) to the next SES. */
  range: ByteRange
  /** Whether the section carries elements, list runs or a geometry container. */
  hasContent: boolean
}

/**
 * Where each window section of a message lies (elements.md Reading R-EL-23, issue #147): one per SES
 * item, the items before the first SES in the first; each with its byte range in the item sequence
 * and whether it carries content of its own. A message with fewer than two SES items is one section.
 * (Swift internal.)
 */
export class WindowSectionLayout {
  readonly sections: readonly WindowSectionLayoutSection[]

  /**
   * The sections of `items`. A walk that stops ends the last section where the sequence ends, as
   * the screen decode reads it up to the stop.
   */
  constructor(items: Uint8Array) {
    const sections: WindowSectionLayoutSection[] = [{ range: new ByteRange(0, items.length), hasContent: false }]
    const walker = new DiagItemWalker()
    let sesCount = 0
    for (;;) {
      let item: DiagItem | undefined
      try {
        item = walker.next(items)
      } catch (error) {
        if (!(error instanceof DiagItemWalkError)) throw error
        break
      }
      if (item === undefined) break
      if (item.type === "ses") {
        sesCount += 1
        if (sesCount > 1) {
          const last = sections[sections.length - 1]
          last.range = new ByteRange(last.range.lowerBound, item.offset)
          sections.push({ range: new ByteRange(item.offset, items.length), hasContent: false })
        }
        continue
      }
      if (item.appl !== undefined && WindowSectionLayout.isContent(item.appl)) sections[sections.length - 1].hasContent = true
    }
    this.sections = sections
  }

  /**
   * Whether an item makes its section carry content: atoms, list runs, a geometry container. Window
   * state (DYNN CHL, SCROLL_INFOS, CONTAINER RESET) and the focus alone do not.
   */
  static isContent(appl: ApplItem): boolean {
    switch (appl.kind) {
      case "dynt":
        return appl.sid === "atom" || appl.sid === "tabstripButtons"
      case "varInfo":
        return appl.sid === "listCellText"
      case "container":
        switch (appl.sid) {
          case "loop":
          case "table":
          case "tabstrip":
          case "tabstripPage":
          case "control":
          case "subscreen":
            return true
          default:
            return false
        }
      default:
        return false
    }
  }

  /**
   * Whether an item's meaning follows the section it is in, as content or window state of that
   * window: containers, loop lines, scroll state, the focus, the list window and its runs.
   */
  static followsItsSection(appl: ApplItem): boolean {
    switch (appl.kind) {
      case "container":
        return true
      case "varInfo":
        return appl.sid === "containerLoop" || appl.sid === "scrollInfos" || appl.sid === "listCellText"
      case "dynt":
        return appl.sid === "focus1"
      case "dynn":
        return appl.sid === "chl"
      default:
        return false
    }
  }
}
