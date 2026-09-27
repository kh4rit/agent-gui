// SPDX-License-Identifier: MIT
// The screen as the agent sees it: plain data built by the engine from ScreenModel's Screen and
// the mode's control scene, formatted for the model by src/snapshot.ts. Nothing here holds a
// password: password fields carry no text.

/** SAP message types: success, information, warning, error, abort, exit. */
export type MessageType = "S" | "I" | "W" | "E" | "A" | "X"

export interface AgentMessage {
  type: MessageType
  text: string
  /** Message class and number, when the server sent them. */
  id?: string
  number?: string
}

/** One function the screen offers: a toolbar button, a menu item, a push button, a key. */
export interface AgentFunction {
  /** Reference for gui_step's `function` trigger, e.g. "k7". Stable within one screen. */
  ref: string
  /** Function code (push buttons and tabs carry one, e.g. "=ZZASK"). */
  code?: string
  /** Caption, without icon codes. */
  text?: string
  /** Key combination, e.g. "F8", "Shift+F2", "Ctrl+S". */
  key?: string
  virtualKey?: number
  /** Where it sits: the standard toolbar, the application toolbar, a menu, a push button on the screen, or only the function-key list. */
  where: "standard" | "toolbar" | "menu" | "button" | "keys"
  /** For menu items: the menu titles leading to it. */
  menuPath?: string[]
  enabled: boolean
  tooltip?: string
}

export type AgentFieldKind = "input" | "output" | "label" | "button" | "checkbox" | "radio" | "dropdown" | "frame" | "tab" | "other"

/** One element of the screen. */
export interface AgentField {
  /** Reference for gui_step edits, e.g. "f12". Stable within one screen. */
  ref: string
  kind: AgentFieldKind
  /** The caption the engine associates with an input or output field (the label left of it, or a table column title). */
  label?: string
  /** The text of a label, output field or input field; never set for password fields. */
  text?: string
  /** The technical field name (e.g. "RSYST-BNAME"), when the server sent one. */
  name?: string
  row: number
  column: number
  width: number
  maxLength?: number
  editable?: boolean
  required?: boolean
  password?: boolean
  checked?: boolean
  /** Radio group, for radio buttons. */
  group?: string
  /** Dropdown entries. */
  options?: { key: string; text: string }[]
  /** Whether F4 value help is offered. */
  valueHelp?: boolean
  /** For a table cell: its table, absolute row (from 1) and column index (from 0). */
  table?: { ref: string; row: number; column: number }
  /** For push buttons and tabs: the function they fire. */
  functionRef?: string
  highlighted?: boolean
  /** A text that could not be decoded in full. */
  repaired?: boolean
}

export interface AgentTableColumn {
  title?: string
  name?: string
  key?: boolean
  width: number
  kind?: AgentFieldKind
}

export interface AgentTableRow {
  /** Absolute row number, from 1. */
  row: number
  selected?: boolean
  /** Cell texts by column; undefined for an empty or missing cell. */
  cells: (string | undefined)[]
  /** Cell element references by column, for edits. */
  cellRefs: (string | undefined)[]
}

/** A classic table control (as in SM30). */
export interface AgentTable {
  ref: string
  name?: string
  columns: AgentTableColumn[]
  /** The rows the server sent for the visible page. */
  rows: AgentTableRow[]
  firstRow: number
  visibleRows: number
  totalRows?: number
  /** Whether rows can be marked (a row selector column). */
  selectable: boolean
}

/** A classic ABAP list (report output, SE16 standard list). */
export interface AgentList {
  lines: string[]
  firstLine: number
  totalLines?: number
  /** Positions that fire on a choose (hotspots). */
  hotspots?: { line: number; column: number; text: string }[]
}

export interface AgentTreeNode {
  key: string
  text: string
  depth: number
  /** Further column texts of a column tree. */
  items?: string[]
  hasChildren?: boolean
  expanded?: boolean
  selected?: boolean
}

export interface AgentGrid {
  columns: { name?: string; title?: string }[]
  rows: string[][]
  totalRows?: number
  currentCell?: { row: number; column: string }
}

/** A Control Framework control the screen shows. */
export interface AgentControl {
  ref: string
  kind: "tree" | "grid" | "splitter" | "container" | "other"
  /** The screen container it sits in. */
  area?: string
  /** For unsupported controls: its class, so the agent knows what it cannot see. */
  className?: string
  tree?: { nodes: AgentTreeNode[] }
  grid?: AgentGrid
}

export interface AgentTab {
  ref: string
  text: string
  active: boolean
  functionRef?: string
}

/** The whole screen of one session. */
export interface AgentScreen {
  system: string
  session: string
  transaction?: string
  program?: string
  screenNumber?: string
  title?: string
  /** Set when the top window is a popup (modal dialog). */
  popup?: { title?: string; level: number }
  /** The main window under a popup. */
  under?: { transaction?: string; program?: string; screenNumber?: string; title?: string }
  message?: AgentMessage
  functions: AgentFunction[]
  fields: AgentField[]
  tables: AgentTable[]
  list?: AgentList
  tabs: AgentTab[]
  controls: AgentControl[]
  /** The element with the cursor. */
  cursor?: string
  /** The logon screen of the logon program. */
  logonScreen: boolean
  /** Notes about parts the engine could not read. */
  notices: string[]
  /** The server's error text, if the message was a server error. */
  serverError?: string
}
