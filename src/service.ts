// SPDX-License-Identifier: MIT
// What the MCP tools ask of the server: the sessions of the configured systems. Implemented by
// src/sessions.ts on top of the engine; tests use fakes.

import type { SystemConfig } from "./config.js"
import type { AgentScreen, AgentTable, AgentList, AgentControl } from "./engine/agentScreen.js"

/** A field edit: `field` is a reference from the snapshot (f12), a technical field name, or a label. */
export interface FieldEditInput {
  field: string
  /** New text of an input field. */
  value?: string
  /** Checkbox state. */
  checked?: boolean
  /** Selects a radio button. */
  select?: boolean
  /** Dropdown entry: its key or its text. */
  option?: string
}

/** A table-control cell edit: `row` is the absolute row (from 1); `column` a title, name or index. */
export interface CellEditInput {
  table: string
  row: number
  column: string
  value?: string
  checked?: boolean
}

/** Marks or unmarks a table-control row. */
export interface RowMarkInput {
  table: string
  row: number
  marked: boolean
}

/** What submits a step. Exactly one. */
export type TriggerInput =
  | { kind: "enter" }
  /** F1–F12 with Shift/Ctrl, "PageDown", "PageUp", "First page", "Last page", "Ctrl+S" is refused (use gui_save). */
  | { kind: "key"; key: string }
  /** A function reference (k7), code, or visible text of a toolbar, menu or push button. */
  | { kind: "function"; function: string }
  /** Raw OK-code, as typed into the command field. */
  | { kind: "okcode"; okcode: string }
  /** F2 / double-click on a field (reference) or a list position. */
  | { kind: "choose"; field?: string; line?: number; column?: number }
  /** F4 value help on a field. */
  | { kind: "valueHelp"; field: string }

export interface StepRequest {
  session: string
  edits?: FieldEditInput[]
  cells?: CellEditInput[]
  marks?: RowMarkInput[]
  /** Where the cursor goes (a field reference). */
  cursor?: string
  trigger: TriggerInput
}

export interface StepResult {
  screen: AgentScreen
  /** One line: what changed. */
  change: string
  /** The server has not answered within the step timeout; call gui_wait. */
  busy?: boolean
  /** Extra notes for the agent. */
  notes?: string[]
}

export interface SaveResult extends StepResult {
  /** Whether the server confirmed the save (a success message after Save and the request prompt). */
  saved: boolean
  /** When a transport prompt appeared without a `transport`: it was cancelled; these are its choices. */
  transportPrompt?: { text: string; candidates: string[] }
}

export interface SessionInfo {
  session: string
  system: string
  transaction?: string
  title?: string
  busy: boolean
}

export type TreeAction = "read" | "select" | "open" | "expand" | "collapse" | "clickItem" | "find"
export type GridAction = "read" | "open" | "select"

export interface GuiService {
  /** Configured systems with their open sessions. */
  systems(): { config: SystemConfig; isDefault: boolean; sessions: SessionInfo[] }[]
  /** Logs on (or opens a new session on an existing connection) and returns the first screen. */
  connect(system: string | undefined, transaction?: string): Promise<StepResult>
  /** Logs off a session, or every session of a system. */
  disconnect(target: { session?: string; system?: string }): Promise<string>
  /** The current screen of a session. */
  screen(session: string): AgentScreen
  /** Starts a transaction in a session (/n), or in a new session (/o). */
  start(session: string, transaction: string, newSession: boolean): Promise<StepResult>
  /** One dialog step. */
  step(request: StepRequest): Promise<StepResult>
  /** Rows of a table control, or lines of a list (table = "list"), paging the server as needed. */
  readTable(session: string, table: string, fromRow: number, rows: number): Promise<AgentTable | AgentList>
  /** Tree control actions. */
  tree(session: string, control: string, action: TreeAction, node?: string, item?: string, text?: string): Promise<StepResult | AgentControl>
  /** Grid control actions. */
  grid(session: string, control: string, action: GridAction, row?: number, column?: string): Promise<StepResult | AgentControl>
  /** Save, answering a transport prompt with `transport`. */
  save(session: string, transport?: string): Promise<SaveResult>
  /** Waits for a busy session's answer. */
  wait(session: string, seconds: number): Promise<StepResult>
  /** Closes every connection. */
  close(): Promise<void>
}
