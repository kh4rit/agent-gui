// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/GUIStatus.swift (MIT).

// The GUI status a screen declares (docs/protocol/server-screen.md §8.7): what the four MNUENTRY
// sids make up, what a menu entry's positions, flags and virtual key mean, and the virtual-key
// numbers the GUI fires functions with. The byte layout is menuEntries.ts's (PV-0718); the
// meanings are the Readings of §8.7, from ODG's observations of real GUI traffic, pysap's renderer
// and example server, and SAP's public GUI Scripting documentation (spec gap #50).
//
// Swift declares the meanings as extensions of `ApplSID.MnuEntry` and `MenuEntryFields`. A
// TypeScript type cannot be extended from another module, so they are the members of `GUIStatus`,
// named after this file; each says which Swift member it is.

import type { ApplSIDMnuEntry } from "./applRegistry.js"
import { MenuEntryFlags, type MenuEntryFields } from "./menuEntries.js"

// MARK: - The four MNUENTRY sids

/**
 * What the entries of one MNUENTRY sid make up (server-screen.md Reading R-SS-10, PV-0729).
 * - `menuBar`: MENU_ACT: the menu bar, one entry per menu title, numbered by position_1.
 * - `menuItems`: MENU_MNU: the items of the menus, placed by their positions under the titles.
 * - `applicationToolbar`: MENU_PFK: the application toolbar, one entry per button; the info string
 *   is its tooltip.
 * - `functionKeys`: MENU_KYB: the function-key list, which the GUI offers as the screen's context
 *   menu.
 */
export type GUIStatusPart = "menuBar" | "menuItems" | "applicationToolbar" | "functionKeys"
export const GUIStatusPart = {
  allCases: ["menuBar", "menuItems", "applicationToolbar", "functionKeys"] as readonly GUIStatusPart[]
} as const

// MARK: - What a menu entry means

/** Function numbers with a meaning of their own in a menu entry's virtual-key byte. */
export const GUIFunctionNumber = {
  /**
   * The entry fires no function of its own: a menu title or submenu node, or a menu item with no
   * key or toolbar binding (PV-0730).
   */
  unbound: 100, // provenance: PV-0730
  /** Enter (PV-0731): never a menu, toolbar or key-list binding of its own. */
  enter: 0 // provenance: PV-0731
} as const

/** The GUI-status meanings of the MNUENTRY sids and of a menu entry's fields (Readings R-SS-10 to R-SS-13). */
export const GUIStatus = {
  /** The part of the GUI status a sid's entries make up (Reading R-SS-10, PV-0729). (Swift `sid.guiStatusPart`.) */
  part(sid: ApplSIDMnuEntry): GUIStatusPart {
    switch (sid) {
      case "menuAct":
        return "menuBar"
      case "menuMnu":
        return "menuItems"
      case "menuPfk":
        return "applicationToolbar"
      case "menuKyb":
        return "functionKeys"
    }
  },

  /**
   * The entry's place in the menu tree: position_1 to position_4 up to the first zero (Reading
   * R-SS-11). `[2]` is menu 2's title in MENU_ACT, `[2, 3]` its third item, `[2, 3, 1]` the first
   * item of the submenu that item opens. Empty when position_1 is zero. (Swift `fields.menuPosition`.)
   */
  menuPosition(fields: MenuEntryFields): number[] {
    const position: number[] = []
    for (const value of [fields.position1, fields.position2, fields.position3, fields.position4]) {
      if (value === 0) break
      position.push(value)
    }
    return position
  },

  /** SEL is set: the entry can be chosen (Reading R-SS-12, PV-0721). (Swift `fields.isSelectable`.) */
  isSelectable(fields: MenuEntryFields): boolean {
    return (fields.flags & MenuEntryFlags.sel) !== 0
  },

  /** SEP is set: the entry is a separator line (Reading R-SS-12, PV-0721). (Swift `fields.isSeparator`.) */
  isSeparator(fields: MenuEntryFields): boolean {
    return (fields.flags & MenuEntryFlags.sep) !== 0
  },

  /**
   * MEN is set and the entry is no separator: it opens a menu of its own, a title or a submenu
   * (Reading R-SS-12, PV-0721). (Swift `fields.opensMenu`.)
   */
  opensMenu(fields: MenuEntryFields): boolean {
    return (fields.flags & MenuEntryFlags.men) !== 0 && !GUIStatus.isSeparator(fields)
  },

  /**
   * The function number the entry fires, the join key of MENU_MNU, MENU_PFK and MENU_KYB: the
   * virtual-key byte, unless it is `GUIFunctionNumber.unbound` or Enter's 0, which no entry binds
   * (Reading R-SS-13, PV-0730). The GUI sends it in UI_EVENT_SOURCE (client-input.md Reading
   * R-CI-10). (Swift `fields.functionNumber`.)
   */
  functionNumber(fields: MenuEntryFields): number | undefined {
    if (fields.virtualKey === GUIFunctionNumber.unbound || fields.virtualKey === GUIFunctionNumber.enter) return undefined
    return fields.virtualKey
  }
} as const

// MARK: - Virtual keys

/**
 * A virtual key: the number a GUI fires a function with, which the GUI status binds to a key
 * combination (PV-0731). 0 is Enter; 1 to 48 are the function keys F1 to F12 plain, with Shift, with
 * Ctrl and with Ctrl and Shift; 70 to 86 are further Ctrl combinations and the page keys. Names such
 * as "Back" for 3 are what an application calls the function, not protocol facts. A value is the
 * number itself (Swift `RawRepresentable`, ordered by it).
 */
export type GUIVirtualKey = number

/** Function keys per modifier group: F1 to F12 (PV-0731). */
const FUNCTION_KEYS_PER_GROUP = 12 // provenance: PV-0731
/** The last number of the four function-key groups (PV-0731). */
const LAST_FUNCTION_KEY = 48 // provenance: PV-0731
/** The first and last number of the Ctrl-letter and page-key block (PV-0731). */
const FIRST_EXTRA_KEY = 70 // provenance: PV-0731
const LAST_EXTRA_KEY = 86 // provenance: PV-0731

/** The GUI_FKEY table's exceptions to the F-key pattern: 11 is Ctrl+S, 22 is Shift+Ctrl+0 (PV-0731). */
const EXCEPTIONS = new Map<number, string>([
  [11, "Ctrl+S"], // provenance: PV-0731
  [22, "Shift+Ctrl+0"] // provenance: PV-0731
])

/** The block from 70 to 86, in order (PV-0731). */
const EXTRA_KEYS = [
  "Ctrl+E",
  "Ctrl+F",
  "Ctrl+/",
  "Ctrl+\\",
  "Ctrl+N",
  "Ctrl+O",
  "Ctrl+X",
  "Ctrl+C",
  "Ctrl+V",
  "Ctrl+Z",
  "Ctrl+PageUp",
  "PageUp",
  "PageDown",
  "Ctrl+PageDown",
  "Ctrl+G",
  "Ctrl+R",
  "Ctrl+P"
] as const

const MODIFIERS = ["", "Shift+", "Ctrl+", "Ctrl+Shift+"] as const

export const GUIVirtualKey = {
  enter: 0, // provenance: PV-0731
  f1: 1, // provenance: PV-0731
  f2: 2, // provenance: PV-0731
  f3: 3, // provenance: PV-0731
  f4: 4, // provenance: PV-0731
  f8: 8, // provenance: PV-0731
  /** Ctrl+S in the GUI_FKEY table; ODG's accelerator sample binds F11 to it too. */
  ctrlS: 11, // provenance: PV-0731
  f12: 12, // provenance: PV-0731
  shiftF3: 15, // provenance: PV-0731
  ctrlF: 71, // provenance: PV-0731
  ctrlPageUp: 80, // provenance: PV-0731
  pageUp: 81, // provenance: PV-0731
  pageDown: 82, // provenance: PV-0731
  ctrlPageDown: 83, // provenance: PV-0731
  ctrlG: 84, // provenance: PV-0731
  ctrlP: 86, // provenance: PV-0731

  /**
   * The key combination the GUI_FKEY table gives for the number, for example `F3`, `Shift+F3` or
   * `Ctrl+S`; undefined for a number the table does not list (49 to 69, above 86).
   */
  keyCombination(key: GUIVirtualKey): string | undefined {
    if (key === GUIVirtualKey.enter) return "Enter"
    const exception = EXCEPTIONS.get(key)
    if (exception !== undefined) return exception
    if (key <= LAST_FUNCTION_KEY) {
      const index = key - 1
      return `${MODIFIERS[Math.floor(index / FUNCTION_KEYS_PER_GROUP)]}F${(index % FUNCTION_KEYS_PER_GROUP) + 1}`
    }
    if (key >= FIRST_EXTRA_KEY && key <= LAST_EXTRA_KEY) return EXTRA_KEYS[key - FIRST_EXTRA_KEY]
    return undefined
  },

  /**
   * The plain function key F1 to F12 the number stands for, or undefined (a modified key, Enter,
   * Ctrl+S or another key).
   */
  plainFunctionKey(key: GUIVirtualKey): number | undefined {
    if (!(key >= GUIVirtualKey.f1 && key <= GUIVirtualKey.f12 && key !== GUIVirtualKey.ctrlS)) return undefined
    return key
  },

  /** For example `3 (F3)`, or `60` for a number without a key combination (Swift `description`). */
  description(key: GUIVirtualKey): string {
    const combination = GUIVirtualKey.keyCombination(key)
    return combination === undefined ? `${key}` : `${key} (${combination})`
  }
} as const
