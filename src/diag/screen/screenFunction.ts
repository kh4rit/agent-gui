// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenFunction.swift (MIT).

// The functions a screen offers and its menu bar (docs/protocol/server-screen.md §8.7,
// client-input.md §7.5), and the builder that makes them from the GUI status and the elements.
//
// Swift's `extension Screen` of this file (`StandardFunction`, `function(_:)`,
// `function(forVirtualKey:)`, `hasGUIStatus`) is `StandardFunction` and the functions of
// `ScreenFunctions`, which take the screen; `Screen` has methods that call them.

import { GUIStatus, GUIVirtualKey, isUInt8, type GUIStatusPart } from "../codec/index.js"
import type { ScreenReadings } from "./functionTrigger.js"
import type { Screen } from "./screen.js"
import { ScreenElementID, type ScreenElement } from "./screenElement.js"
import type { ScreenMenu, ScreenMenuEntry } from "./screenMenu.js"

/**
 * A function's stable identity within one screen: where the function sits, never its text. The same
 * GUI status on a later screen gives the same ids. (Swift `ScreenFunction.ID`, a raw-value wrapper
 * of a string: here the string itself.)
 */
export type ScreenFunctionID = string

/**
 * Where a function sits (Swift `ScreenFunction.Kind`).
 * - `standardToolbar`: a button of the standard toolbar, which the app always offers
 *   (`StandardFunction`): enabled as the screen's GUI status says, or always when the screen
 *   declares none.
 * - `applicationToolbar`: a button of the application toolbar (MENU_PFK, Reading R-SS-10).
 * - `menu`: a menu item. `path` holds the titles of the menus that lead to it, the menu bar's title
 *   first (MENU_ACT, then MENU_MNU submenus, Reading R-SS-11), without the item's own text. An
 *   **empty path** is an entry of the function-key list (MENU_KYB), which the GUI offers as the
 *   screen's context menu: it belongs to no menu-bar menu.
 * - `pushButton`: a push button (etype 115) or tabstrip tab (116) on the screen: the element that
 *   sends `ScreenFunction.code` when clicked.
 */
export type ScreenFunctionKind =
  | { readonly kind: "standardToolbar" }
  | { readonly kind: "applicationToolbar" }
  | { readonly kind: "menu"; readonly path: readonly string[] }
  | { readonly kind: "pushButton"; readonly value: ScreenElementID }

export const ScreenFunctionKind = {
  standardToolbar: { kind: "standardToolbar" } as ScreenFunctionKind,
  applicationToolbar: { kind: "applicationToolbar" } as ScreenFunctionKind,
  menu: (path: readonly string[]): ScreenFunctionKind => ({ kind: "menu", path }),
  pushButton: (value: ScreenElementID): ScreenFunctionKind => ({ kind: "pushButton", value }),

  /** Swift's `==`: the same case with the same path or element. */
  equals(a: ScreenFunctionKind, b: ScreenFunctionKind): boolean {
    if (a.kind !== b.kind) return false
    if (a.kind === "menu" && b.kind === "menu") return a.path.length === b.path.length && a.path.every((title, index) => title === b.path[index])
    if (a.kind === "pushButton" && b.kind === "pushButton") return ScreenElementID.equals(a.value, b.value)
    return true
  }
} as const

/** The fields of a `ScreenFunction` (Swift `init(id:code:text:virtualKey:kind:isEnabled:tooltip:accelerator:)`). */
export interface ScreenFunctionFields {
  id: ScreenFunctionID
  code: string | undefined
  text: string | undefined
  virtualKey: number | undefined
  kind: ScreenFunctionKind
  isEnabled: boolean
  tooltip?: string | undefined
  accelerator?: string | undefined
}

/**
 * One function a screen offers, and where it sits: the standard toolbar, the application toolbar, a
 * menu, or a push button or tab on the screen (docs/protocol/server-screen.md §8.7, client-input.md
 * §7.5).
 *
 * Pinned API between the model and the app: `id`, `code`, `text`, `virtualKey`, `kind` and
 * `isEnabled`. The rest is added by the model and optional for a caller.
 *
 * A function is fired with the `function` trigger of `Screen.inputStep`: a push button or tab sends
 * its `code` in VARINFO OKCODE (PV-0773); every other function sends its `virtualKey` as
 * `FunctionReadings.functionKey` says (Readings R-CI-20, R-CI-10). A function with neither cannot be
 * fired yet (#55).
 */
export class ScreenFunction {
  readonly id: ScreenFunctionID
  /**
   * The function code a click sends in VARINFO OKCODE, verbatim (a push button's or tab's, usually
   * starting with `=`, PV-0773); undefined for GUI-status functions, which carry a function number
   * instead (PV-0730).
   */
  readonly code: string | undefined
  /**
   * The caption: the entry's or button's text in the screen's code page, or the standard toolbar's
   * own label. It may start with an `@…@` icon code (#53).
   */
  readonly text: string | undefined
  /**
   * The virtual key (function number) the function fires with (PV-0730, PV-0731); undefined for a
   * push button, a tab and a menu item bound to none.
   */
  readonly virtualKey: number | undefined
  readonly kind: ScreenFunctionKind
  /** Whether the screen offers the function enabled (SEL, Reading R-SS-12). A disabled function is refused by the input step. */
  readonly isEnabled: boolean
  /** The tooltip: an application-toolbar entry's info string, or for a standard button the text the GUI status gives its virtual key. */
  readonly tooltip: string | undefined
  /** A menu entry's accelerator (the letter the GUI underlines), or undefined. */
  readonly accelerator: string | undefined

  constructor(fields: ScreenFunctionFields) {
    this.id = fields.id
    this.code = fields.code
    this.text = fields.text
    this.virtualKey = fields.virtualKey
    this.kind = fields.kind
    this.isEnabled = fields.isEnabled
    this.tooltip = fields.tooltip
    this.accelerator = fields.accelerator
  }

  /**
   * The key combination of `virtualKey` in the GUI_FKEY table (PV-0731), for example `F3`,
   * `Shift+F3` or `Ctrl+S`; undefined without a virtual key or for a number the table lacks.
   */
  get keyCombination(): string | undefined {
    const key = this.virtualKey
    return key !== undefined && isUInt8(key) ? GUIVirtualKey.keyCombination(key) : undefined
  }

  /**
   * Whether the function has something to send: a virtual key or a function code. A menu item bound
   * to no function number has neither and cannot be fired yet (#55); show it disabled.
   */
  get canFire(): boolean {
    return this.virtualKey !== undefined || this.code !== undefined
  }

  /** An entry of the function-key list, the context menu (`kind` is a `menu` with an empty path). */
  get isContextMenuEntry(): boolean {
    return this.kind.kind === "menu" && this.kind.path.length === 0
  }

  /** For example `standard:3 "Back" vkey 3 enabled`; the text is the screen's, never a field value. */
  get description(): string {
    const parts = [this.id]
    if (this.text !== undefined) parts.push(`"${this.text}"`)
    if (this.code !== undefined) parts.push(`code ${this.code}`)
    if (this.virtualKey !== undefined) parts.push(`vkey ${this.virtualKey}`)
    parts.push(this.isEnabled ? "enabled" : "disabled")
    return parts.join(" ")
  }

  toString(): string {
    return this.description
  }
}

/**
 * One item of a menu: a function, a submenu or a separator line (Swift's indirect enum
 * `ScreenMenuItem`).
 */
export type ScreenMenuItem =
  | { readonly kind: "function"; readonly value: ScreenFunction }
  | { readonly kind: "submenu"; readonly title: string; readonly items: readonly ScreenMenuItem[] }
  | { readonly kind: "separator" }

export const ScreenMenuItem = {
  function: (value: ScreenFunction): ScreenMenuItem => ({ kind: "function", value }),
  submenu: (title: string, items: readonly ScreenMenuItem[]): ScreenMenuItem => ({ kind: "submenu", title, items }),
  separator: { kind: "separator" } as ScreenMenuItem
} as const

/** One menu of the menu bar (MENU_ACT) with its items (MENU_MNU), for rendering; the items' functions are also in `Screen.functions`. */
export class ScreenMenuBarMenu {
  /** The title (a MENU_ACT entry's text). */
  readonly title: string
  /** position_1 of the title's entry (Reading R-SS-11). */
  readonly position: number
  readonly accelerator: string | undefined
  readonly items: readonly ScreenMenuItem[]

  constructor(fields: { title: string; position: number; accelerator: string | undefined; items: readonly ScreenMenuItem[] }) {
    this.title = fields.title
    this.position = fields.position
    this.accelerator = fields.accelerator
    this.items = fields.items
  }
}

/**
 * The functions the app offers on every screen, with the virtual keys they fire (PV-0731). The
 * virtual keys are the protocol's; the names, the choice of eight and the Mac keys that press them
 * (for example ⌘S for Save, virtual key 11, which the GUI_FKEY table calls Ctrl+S) are the app's.
 * (Swift `Screen.StandardFunction`, whose raw value is the virtual key.)
 */
export type StandardFunction = "enter" | "save" | "back" | "exit" | "cancel" | "execute" | "choose" | "help"

const STANDARD_KEYS: Readonly<Record<StandardFunction, number>> = {
  enter: 0, // provenance: PV-0731
  save: 11, // provenance: PV-0731
  back: 3, // provenance: PV-0731
  exit: 15, // provenance: PV-0731
  cancel: 12, // provenance: PV-0731
  execute: 8, // provenance: PV-0731
  choose: 2, // provenance: PV-0731
  help: 1 // provenance: PV-0731
}

const STANDARD_LABELS: Readonly<Record<StandardFunction, string>> = {
  enter: "Enter",
  save: "Save",
  back: "Back",
  exit: "Exit",
  cancel: "Cancel",
  execute: "Execute",
  choose: "Choose",
  help: "Help"
}

export const StandardFunction = {
  /** The eight in the order the app offers them (Swift `CaseIterable`). */
  allCases: ["enter", "save", "back", "exit", "cancel", "execute", "choose", "help"] as readonly StandardFunction[],

  /**
   * The virtual key: 0 Enter, 11 Ctrl+S (F11 on the systems ODG saw), 3 F3, 15 Shift+F3, 12 F12,
   * 8 F8, 2 F2, 1 F1 (PV-0731). Also Swift's `rawValue`.
   */
  virtualKey(standard: StandardFunction): number {
    return STANDARD_KEYS[standard]
  },

  /** The function of a virtual key, or undefined (Swift `init?(rawValue:)`). */
  fromRaw(key: number): StandardFunction | undefined {
    return StandardFunction.allCases.find(standard => STANDARD_KEYS[standard] === key)
  },

  /** The app's own label. */
  label(standard: StandardFunction): string {
    return STANDARD_LABELS[standard]
  },

  /** The id of its standard-toolbar function. */
  id(standard: StandardFunction): ScreenFunctionID {
    return `standard:${STANDARD_KEYS[standard]}`
  },

  /** Enter and Help work on every screen; the others follow the GUI status. (Swift internal.) */
  isAlwaysEnabled(standard: StandardFunction): boolean {
    return standard === "enter" || standard === "help"
  }
} as const

// MARK: - Screen members (Swift's `extension Screen`)

/** The members Swift's `extension Screen` of ScreenFunction.swift adds; `Screen` calls them. */
export const ScreenFunctions = {
  /** The standard-toolbar function for `standard` (always present). (Swift `function(_:)`.) */
  function(screen: Screen, standard: StandardFunction): ScreenFunction | undefined {
    const id = StandardFunction.id(standard)
    return screen.functions.find(function_ => function_.id === id)
  },

  /**
   * The function fired by virtual key `virtualKey`, or undefined when no function has it: the first
   * of an application-toolbar button, a menu item, a function-key list entry and a standard-toolbar
   * button with that key. Every one of them fires the same function number. (Swift
   * `function(forVirtualKey:)`.)
   */
  functionForVirtualKey(screen: Screen, virtualKey: number): ScreenFunction | undefined {
    const rank = (function_: ScreenFunction): number => {
      switch (function_.kind.kind) {
        case "applicationToolbar":
          return 0
        case "menu":
          return function_.kind.path.length > 0 ? 1 : 2
        case "standardToolbar":
          return 3
        case "pushButton":
          return 4
      }
    }
    let best: ScreenFunction | undefined
    for (const candidate of screen.functions) {
      if (candidate.virtualKey !== virtualKey) continue
      if (best === undefined || rank(candidate) < rank(best)) best = candidate
    }
    return best
  },

  /** Whether the screen declares a GUI status: any MNUENTRY item. */
  hasGUIStatus(screen: Screen): boolean {
    return screen.menus.length > 0
  }
} as const

// MARK: - Building the functions

/** Builds a screen's functions and menu bar from its MNUENTRY items and elements (server-screen.md §8.7). (Swift internal.) */
export class FunctionBuilder {
  readonly menus: readonly ScreenMenu[]
  readonly elements: readonly ScreenElement[]
  readonly readings: ScreenReadings

  private _functions: ScreenFunction[] = []
  private _menuBar: ScreenMenuBarMenu[] = []
  /** MENU_MNU entries whose menu-bar title or parent is missing. */
  private _unplacedEntries = 0
  /** The ids given so far, so that entries at the same place get distinct ids. */
  private ids = new Map<string, number>()

  constructor(menus: readonly ScreenMenu[], elements: readonly ScreenElement[], readings: ScreenReadings) {
    this.menus = menus
    this.elements = elements
    this.readings = readings
    this.build()
  }

  get functions(): ScreenFunction[] {
    return this._functions
  }

  get menuBar(): ScreenMenuBarMenu[] {
    return this._menuBar
  }

  get unplacedEntries(): number {
    return this._unplacedEntries
  }

  /** `base`, or `base#2`, `base#3` … for its later uses. */
  private uniqueID(base: string): ScreenFunctionID {
    const count = (this.ids.get(base) ?? 0) + 1
    this.ids.set(base, count)
    return count === 1 ? base : `${base}#${count}`
  }

  private entries(part: GUIStatusPart): ScreenMenuEntry[] {
    return this.menus.filter(menu => GUIStatus.part(menu.kind) === part).flatMap(menu => menu.entries)
  }

  private isEnabled(entry: ScreenMenuEntry): boolean {
    return !this.readings.menuEnabledBySEL || GUIStatus.isSelectable(entry.fields)
  }

  private build(): void {
    const toolbar = this.entries("applicationToolbar")
    const keys = this.entries("functionKeys")
    const items = this.entries("menuItems")
    this.buildStandard([...toolbar, ...keys, ...items])
    toolbar.forEach((entry, index) => {
      if (GUIStatus.isSeparator(entry.fields)) return
      this._functions.push(
        new ScreenFunction({
          id: this.uniqueID(`toolbar:${index + 1}`),
          code: undefined,
          text: entry.text,
          virtualKey: GUIStatus.functionNumber(entry.fields),
          kind: ScreenFunctionKind.applicationToolbar,
          isEnabled: this.isEnabled(entry),
          tooltip: entry.info,
          accelerator: entry.accelerator
        })
      )
    })
    this.buildMenuBar(this.entries("menuBar"), items)
    keys.forEach((entry, index) => {
      if (GUIStatus.isSeparator(entry.fields)) return
      this._functions.push(
        new ScreenFunction({
          id: this.uniqueID(`keys:${index + 1}`),
          code: undefined,
          text: entry.text,
          virtualKey: GUIStatus.functionNumber(entry.fields),
          kind: ScreenFunctionKind.menu([]),
          isEnabled: this.isEnabled(entry),
          tooltip: entry.info,
          accelerator: entry.accelerator
        })
      )
    })
    // A push button or tab the server disabled (Reading R-EL-19) is offered disabled.
    for (const element of this.elements) {
      if (element.kind.kind !== "button" && element.kind.kind !== "tab") continue
      const code = element.functionCode === undefined || element.functionCode.length === 0 ? undefined : element.functionCode
      this._functions.push(
        new ScreenFunction({
          id: this.uniqueID(`element:${element.id.description}`),
          code,
          text: element.text,
          virtualKey: undefined,
          kind: ScreenFunctionKind.pushButton(element.id),
          isEnabled: code !== undefined && !element.isDisabled
        })
      )
    }
  }

  /** The eight standard functions, enabled as the GUI status declares their virtual keys. */
  private buildStandard(declared: readonly ScreenMenuEntry[]): void {
    const hasStatus = this.menus.length > 0
    for (const standard of StandardFunction.allCases) {
      const key = StandardFunction.virtualKey(standard)
      const matches = declared.filter(entry => GUIStatus.functionNumber(entry.fields) === key)
      const enabled = StandardFunction.isAlwaysEnabled(standard) || !hasStatus || matches.some(entry => this.isEnabled(entry))
      this._functions.push(
        new ScreenFunction({
          id: StandardFunction.id(standard),
          code: undefined,
          text: StandardFunction.label(standard),
          virtualKey: key,
          kind: ScreenFunctionKind.standardToolbar,
          isEnabled: enabled,
          tooltip: matches[0]?.text
        })
      )
    }
  }

  /** The menu bar: one menu per MENU_ACT title, its items from MENU_MNU by position (R-SS-11). */
  private buildMenuBar(titles: readonly ScreenMenuEntry[], items: readonly ScreenMenuEntry[]): void {
    const placed = items.filter(entry => GUIStatus.menuPosition(entry.fields).length >= 2)
    // Swift's `Dictionary(grouping:)` by the position without its last number, keyed here by its text.
    const children = new Map<string, number[]>()
    placed.forEach((entry, index) => {
      const key = positionKey(GUIStatus.menuPosition(entry.fields).slice(0, -1))
      const group = children.get(key)
      if (group === undefined) children.set(key, [index])
      else group.push(index)
    })
    const used = new Set<number>()
    const seenTitles = new Set<number>()
    for (const title of titles) {
      const position = GUIStatus.menuPosition(title.fields)
      if (!(position.length === 1) || seenTitles.has(position[0])) continue
      seenTitles.add(position[0])
      const text = title.text ?? ""
      const menuItems = this.menuItems([position[0]], [text], placed, children, used)
      this._menuBar.push(new ScreenMenuBarMenu({ title: text, position: position[0], accelerator: title.accelerator, items: menuItems }))
    }
    this._unplacedEntries = items.length - used.size
  }

  private menuItems(
    parent: readonly number[],
    path: readonly string[],
    placed: readonly ScreenMenuEntry[],
    children: ReadonlyMap<string, number[]>,
    used: Set<number>
  ): ScreenMenuItem[] {
    const result: ScreenMenuItem[] = []
    for (const index of children.get(positionKey(parent)) ?? []) {
      used.add(index)
      const entry = placed[index]
      const key = GUIStatus.menuPosition(entry.fields)
      if (GUIStatus.isSeparator(entry.fields)) {
        result.push(ScreenMenuItem.separator)
      } else if (GUIStatus.opensMenu(entry.fields) || children.has(positionKey(key))) {
        const title = entry.text ?? ""
        const items = this.menuItems(key, [...path, title], placed, children, used)
        result.push(ScreenMenuItem.submenu(title, items))
      } else {
        const function_ = new ScreenFunction({
          id: this.uniqueID("menu:" + key.join(".")),
          code: undefined,
          text: entry.text,
          virtualKey: GUIStatus.functionNumber(entry.fields),
          kind: ScreenFunctionKind.menu(path),
          isEnabled: this.isEnabled(entry),
          accelerator: entry.accelerator
        })
        this._functions.push(function_)
        result.push(ScreenMenuItem.function(function_))
      }
    }
    return result
  }
}

/** A menu position as a map key (Swift keys the dictionary by the `[UInt8]` itself). */
function positionKey(position: readonly number[]): string {
  return position.join(",")
}
