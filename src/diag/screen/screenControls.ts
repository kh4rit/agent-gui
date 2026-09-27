// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenControls.swift (MIT).

// The model types of checkboxes, radio groups, dropdowns, field markers and tabstrips
// (docs/protocol/elements.md §3–§5 and §11). Pinned API of the mock-apps work: the names are shared
// by the codec, fake-server and app builders; the decoding that fills them follows the Readings of
// elements.md and is switched by `ScreenReadings`.

import type { ScreenElementID } from "./screenElement.js"
import type { GridRect, ScreenIcon } from "./screenLayout.js"

/**
 * How an input field's text is meant (elements.md Reading R-EL-16). The client never blocks input
 * on it: the server checks.
 * - `text`: plain text: no marker.
 * - `numeric`: JUSTRIGHT (PV-0623): right-aligned digits.
 * - `date`: the invented date bit of flag1 (R-EL-16): a date the user may pick from a calendar.
 */
export type ScreenInputFormat = "text" | "numeric" | "date"

/** One option of a dropdown: the key the field holds and returns, and the text the user sees. */
export class ScreenDropdownOption {
  key: string
  text: string

  constructor(fields: { key: string; text: string }) {
    this.key = fields.key
    this.text = fields.text
  }

  /** The key (Swift `Identifiable`). */
  get id(): string {
    return this.key
  }
}

/** A dropdown's options and selection (elements.md Reading R-EL-3, invented; #108). */
export class ScreenDropdown {
  /** The options in the server's order. */
  options: ScreenDropdownOption[]
  /** The selected key; undefined is the empty entry. */
  selectedKey: string | undefined
  /** Whether the dropdown offers an empty entry (`empty="1"`). */
  allowsEmpty: boolean

  constructor(fields: { options: ScreenDropdownOption[]; selectedKey: string | undefined; allowsEmpty: boolean }) {
    this.options = fields.options
    this.selectedKey = fields.selectedKey
    this.allowsEmpty = fields.allowsEmpty
  }

  /**
   * The option whose key is `selectedKey`, or undefined (the empty entry, or a key the options do not
   * contain, which the app shows as it is and keeps).
   */
  get selectedOption(): ScreenDropdownOption | undefined {
    return this.options.find(option => option.key === this.selectedKey)
  }
}

/**
 * A radio group's identity: its area and a key inside the area. Under `RadioGroupReading`
 * `areaBlockGroup` the key is the block in the high byte and the group byte in the low byte
 * (`DyntToggle.radioGroupKey`). (Swift `ScreenRadioGroup.ID`.) Ordered by area, then key.
 */
export class ScreenRadioGroupID {
  constructor(
    readonly area: number,
    readonly key: number
  ) {}

  /** Swift's `<`: -1, 0 or 1 by area, then key. */
  static compare(lhs: ScreenRadioGroupID, rhs: ScreenRadioGroupID): number {
    if (lhs.area !== rhs.area) return lhs.area < rhs.area ? -1 : 1
    if (lhs.key !== rhs.key) return lhs.key < rhs.key ? -1 : 1
    return 0
  }

  /** Swift's `==`. */
  static equals(lhs: ScreenRadioGroupID | undefined, rhs: ScreenRadioGroupID | undefined): boolean {
    if (lhs === undefined || rhs === undefined) return lhs === rhs
    return lhs.area === rhs.area && lhs.key === rhs.key
  }

  /** A string that names the id, for maps keyed by it (Swift `Hashable`). */
  get mapKey(): string {
    return `${this.area}/${this.key}`
  }

  /** For example `radio group a0 k5377`. */
  get description(): string {
    return `radio group a${this.area} k${this.key}`
  }

  toString(): string {
    return this.description
  }
}

/** A radio group (elements.md Reading R-EL-2): its buttons in screen order and the selected one. */
export class ScreenRadioGroup {
  readonly id: ScreenRadioGroupID
  /** The group's buttons, in screen order. */
  readonly members: readonly ScreenElementID[]
  /** The selected button (state `X`); undefined when none is. */
  readonly selected: ScreenElementID | undefined

  constructor(fields: { id: ScreenRadioGroupID; members: readonly ScreenElementID[]; selected: ScreenElementID | undefined }) {
    this.id = fields.id
    this.members = fields.members
    this.selected = fields.selected
  }
}

/**
 * How a tabstrip's pages are switched (Swift `ScreenTabstrip.Paging`).
 * - `server`: each tab click is a round trip; only the active page's atoms come (R-EL-5).
 * - `local`: every page comes at once and the client switches locally (R-EL-6). Never decoded
 *   until #109 is resolved.
 */
export type ScreenTabstripPaging = "server" | "local"

/** One tab of a tabstrip (elements.md §5). */
export class ScreenTab {
  /** The TABSTRIP_BUTTON atom (116). */
  readonly id: ScreenElementID
  /** The caption without its leading icon markup (R-DA-10) and padding. */
  readonly caption: string
  readonly icon: ScreenIcon | undefined
  readonly tooltip: string | undefined
  /** The code a click sends in VARINFO OKCODE, verbatim (PV-0773, PV-0967). */
  readonly functionCode: string | undefined
  /** The atom's page_id (PV-0656); the fake server numbers the tabs from 1. */
  readonly pageID: number
  /** dlg_flag_1 0x40 (PV-0966). */
  readonly isActive: boolean
  /** PROTECTED (Reading R-EL-19, invented): drawn disabled and never fired. */
  readonly isDisabled: boolean

  constructor(fields: {
    id: ScreenElementID
    caption: string
    icon?: ScreenIcon | undefined
    tooltip?: string | undefined
    functionCode: string | undefined
    pageID: number
    isActive: boolean
    isDisabled?: boolean
  }) {
    this.id = fields.id
    this.caption = fields.caption
    this.icon = fields.icon
    this.tooltip = fields.tooltip
    this.functionCode = fields.functionCode
    this.pageID = fields.pageID
    this.isActive = fields.isActive
    this.isDisabled = fields.isDisabled ?? false
  }
}

/** A tabstrip (elements.md Reading R-EL-5): the TABSTRIP container, its tabs and the page the server sent. */
export class ScreenTabstrip {
  /** The CONTAINER TABSTRIP id. */
  readonly id: number
  /** The container's rectangle on the whole screen. */
  readonly frame: GridRect
  /** The tabs in order. */
  readonly tabs: readonly ScreenTab[]
  /**
   * The index in `tabs` of the active tab: the one with dlg_flag_1 0x40 (PV-0966), else the first;
   * undefined without tabs.
   */
  readonly activeIndex: number | undefined
  /** The TABSTRIP_PAGE container whose elements are the active page; undefined when none was found. */
  readonly pageArea: number | undefined
  /** Only `server` is decoded until #109. */
  readonly paging: ScreenTabstripPaging

  constructor(fields: {
    id: number
    frame: GridRect
    tabs: readonly ScreenTab[]
    activeIndex: number | undefined
    pageArea: number | undefined
    paging?: ScreenTabstripPaging
  }) {
    this.id = fields.id
    this.frame = fields.frame
    this.tabs = fields.tabs
    this.activeIndex = fields.activeIndex
    this.pageArea = fields.pageArea
    this.paging = fields.paging ?? "server"
  }

  /** The active tab, when there is one. */
  get activeTab(): ScreenTab | undefined {
    const index = this.activeIndex
    return index !== undefined && index >= 0 && index < this.tabs.length ? this.tabs[index] : undefined
  }
}
