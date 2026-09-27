// SPDX-License-Identifier: MIT
// The GuiService on top of the engine: one DIAG connection per configured system, one session per
// SAP mode. Every tool call on a system runs in turn (the connection serialises them); the policy
// is checked before anything goes out, and every step is written to the audit log.

import { hostname } from "node:os"
import { appendFileSync } from "node:fs"
import type { Config, SystemConfig } from "./config.js"
import { AuditLog, type AuditEntry } from "./audit.js"
import { CredentialError, LogonState, platformCredentialStore, resolvePassword, type CredentialStore } from "./credentials.js"
import { Policy, PolicyError, SAVE_VIRTUAL_KEY } from "./policy.js"
import { buildAgentView, type AgentView } from "./engine/agentView.js"
import type { AgentControl, AgentList, AgentScreen, AgentTable } from "./engine/agentScreen.js"
import { EngineError, GuiConnection, type StepOutcome } from "./engine/connection.js"
import { keyLabel, okCodeVirtualKey, parseKey, VirtualKeys } from "./engine/keys.js"
import {
  ControlEvents,
  FieldEdits,
  FunctionTrigger,
  ScreenFunctions,
  ScreenPick,
  type ScreenElement,
  type ScreenElementID,
  type ScreenFunction,
  type ScreenTable
} from "./diag/screen/index.js"
import type {
  CellEditInput,
  FieldEditInput,
  GridAction,
  GuiService,
  RowMarkInput,
  SaveResult,
  SessionInfo,
  StepRequest,
  StepResult,
  TreeAction,
  TriggerInput
} from "./service.js"
import { describeChange } from "./snapshot.js"

/** One session: a mode of a system's connection. */
interface Session {
  id: string
  system: SystemConfig
  mode: number
  /** The view the agent saw last (its references). */
  view?: AgentView
  /** The screen revision the view was built from. */
  revision: number
}

interface SystemState {
  config: SystemConfig
  policy: Policy
  connection?: GuiConnection
  lastUsed: number
}

export interface SessionsOptions {
  store?: CredentialStore
  /** Host name for the DP header (tests pass an invented one). */
  terminalName?: string
  now?: () => number
}

const lower = (s: string) => s.trim().toLowerCase()

export class Sessions implements GuiService {
  private readonly systemsByName = new Map<string, SystemState>()
  private readonly sessions = new Map<string, Session>()
  private nextSession = 1
  private readonly audit: AuditLog
  private readonly logonState: LogonState
  private readonly store: CredentialStore
  private readonly idleTimer: NodeJS.Timeout

  constructor(
    private readonly config: Config,
    private readonly options: SessionsOptions = {}
  ) {
    for (const s of config.systems) this.systemsByName.set(lower(s.name), { config: s, policy: new Policy(s), lastUsed: 0 })
    this.audit = new AuditLog(config.dataDir)
    this.logonState = new LogonState(config.dataDir)
    this.store = options.store ?? platformCredentialStore()
    this.idleTimer = setInterval(() => void this.logOffIdle(), 60_000)
    this.idleTimer.unref()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  // MARK: Lookup

  private system(name: string | undefined): SystemState {
    const key = lower(name ?? this.config.defaultSystem)
    const state = this.systemsByName.get(key)
    if (!state) throw new Error(`Unknown system "${name}". Configured: ${this.config.systems.map(s => s.name).join(", ")}`)
    return state
  }

  private session(id: string): { session: Session; state: SystemState; connection: GuiConnection } {
    const session = this.sessions.get(id.trim().toUpperCase())
    if (!session) throw new Error(`Unknown session "${id}". Open sessions: ${[...this.sessions.keys()].join(", ") || "none"} (gui_connect opens one)`)
    const state = this.system(session.system.name)
    const connection = state.connection
    if (!connection || !connection.isOpen || !connection.modes.has(session.mode)) {
      this.sessions.delete(session.id)
      throw new Error(`Session ${session.id} has ended${connection?.ended ? ` (${connection.ended})` : ""}. gui_connect opens a new one.`)
    }
    state.lastUsed = this.now()
    return { session, state, connection }
  }

  private trace(system: SystemConfig): ((line: string) => void) | undefined {
    if (!system.trace) return undefined
    const file = system.trace
    return line => {
      try {
        appendFileSync(file, `${new Date().toISOString()} ${system.name} ${line}\n`, { mode: 0o600 })
      } catch {
        // tracing never breaks a call
      }
    }
  }

  // MARK: Views

  /** The current view of a session, rebuilt when the screen changed. */
  private view(session: Session, connection: GuiConnection): AgentView {
    const mode = connection.mode(session.mode)
    if (!mode.screen) throw new EngineError("the session has no screen yet")
    const view = buildAgentView(mode.screen, mode.scene, session.system.name, session.id, mode.serverError)
    view.screen.notices.push(...mode.notices)
    if (connection.isPending(session.mode)) view.screen.notices.push("busy: the last step has not been answered yet (gui_wait)")
    session.view = view
    session.revision = mode.revision
    return view
  }

  private result(session: Session, connection: GuiConnection, before: AgentScreen | undefined, outcome: StepOutcome | undefined, notes: string[] = []): StepResult {
    if (outcome?.kind === "ended") throw new Error(`The connection ended: ${outcome.reason}. gui_connect logs on again.`)
    const screen = this.view(session, connection).screen
    const policyNote = this.screenPolicyNote(session, screen)
    return {
      screen,
      change: describeChange(before, screen),
      busy: outcome?.kind === "busy" || undefined,
      notes: [...notes, ...(policyNote ? [policyNote] : [])]
    }
  }

  private screenPolicyNote(session: Session, screen: AgentScreen): string | undefined {
    const policy = this.system(session.system.name).policy
    const refusal = screen.transaction ? policy.transactionRefusal(screen.transaction) : undefined
    return refusal ? `${refusal}; only Back (F3), Exit (Shift+F3), Cancel (F12) and /n work here` : undefined
  }

  private record(session: Session, tool: string, entry: Omit<AuditEntry, "tool" | "system">, result?: AgentScreen, error?: unknown) {
    const system = session.system
    if (!system.audit.enabled) return
    this.audit.record(
      {
        tool,
        system: system.name,
        client: system.client,
        user: system.user,
        session: session.id,
        ...entry,
        result: result
          ? { transaction: result.transaction, program: result.program, screen: result.screenNumber, messageType: result.message?.type, message: result.message?.text }
          : undefined,
        error: error ? (error as Error).message : undefined
      },
      system.audit.values
    )
  }

  // MARK: GuiService

  systems() {
    return this.config.systems.map(config => ({
      config,
      isDefault: config.name === this.config.defaultSystem,
      sessions: [...this.sessions.values()]
        .filter(s => s.system.name === config.name)
        .map((s): SessionInfo => {
          const connection = this.systemsByName.get(lower(config.name))?.connection
          const screen = connection?.modes.get(s.mode)?.screen
          return {
            session: s.id,
            system: config.name,
            transaction: screen?.identity.transaction?.trim() || undefined,
            title: screen?.identity.title?.trim() || undefined,
            busy: connection?.isPending(s.mode) ?? false
          }
        })
    }))
  }

  async connect(systemName: string | undefined, transaction?: string): Promise<StepResult> {
    const state = this.system(systemName)
    const system = state.config
    if (transaction) state.policy.checkStart(transaction)
    state.lastUsed = this.now()
    if (state.connection?.isOpen) {
      const connection = state.connection
      const open = [...this.sessions.values()].filter(s => s.system.name === system.name).length
      if (open >= system.maxSessions) throw new PolicyError(`system ${system.name} allows at most ${system.maxSessions} sessions (maxSessions)`)
      return connection.serialized(async () => {
        const from = connection.openModes.find(m => !connection.isPending(m) && connection.mode(m).screen) ?? 0
        const mode = await connection.openMode(from, transaction?.toUpperCase(), system.stepTimeoutSeconds * 1000)
        const session = this.addSession(system, mode)
        const result = this.result(session, connection, undefined, { kind: "replied" })
        this.record(session, "gui_connect", { trigger: transaction ? `/o${transaction}` : "/o" }, result.screen)
        return result
      })
    }
    return this.logOn(state, transaction)
  }

  private addSession(system: SystemConfig, mode: number): Session {
    const session: Session = { id: `S${this.nextSession++}`, system, mode, revision: -1 }
    this.sessions.set(session.id, session)
    return session
  }

  private async logOn(state: SystemState, transaction: string | undefined): Promise<StepResult> {
    const system = state.config
    const account = LogonState.accountKey(system)
    const suspended = this.logonState.suspension(account)
    if (suspended)
      throw new CredentialError(
        `Logon to ${system.name} is suspended: ${suspended.reason} (${suspended.since}). The password is not tried again automatically, so that the SAP user is not locked. Check it, then run: agent-gui --set-password --system ${system.name} (or --reset-logon)`
      )
    const password = await resolvePassword(system, this.store)
    let connection: GuiConnection
    try {
      connection = await GuiConnection.open({
        host: system.host,
        port: system.port,
        identity: system.identity,
        terminalName: this.options.terminalName ?? hostname(),
        connectTimeoutSeconds: system.connectTimeoutSeconds,
        trace: this.trace(system)
      })
    } catch (e) {
      password.fill(0)
      throw new Error(`Could not connect to ${system.name}: ${(e as Error).message}`)
    }
    this.logonState.beginAttempt(account)
    let result
    try {
      result = await connection.logOn(
        { client: system.client, user: system.user, password, language: system.language },
        system.whenAlreadyLoggedOn,
        system.stepTimeoutSeconds * 1000
      )
    } catch (e) {
      this.logonState.withdraw(account)
      await connection.close()
      throw e
    } finally {
      password.fill(0)
    }
    switch (result.kind) {
      case "accepted":
        this.logonState.clear(account)
        break
      case "rejected":
        this.logonState.failed(account, `the server did not accept the logon${result.message ? `: ${result.message}` : ""}`)
        await connection.close()
        throw new CredentialError(
          `Logon to ${system.name} rejected${result.message ? `: ${result.message.replace(/[.!?]+$/, "")}` : ""}. The password will not be tried again until it is stored anew (agent-gui --set-password --system ${system.name}).`
        )
      case "alreadyLoggedOn":
        this.logonState.clear(account)
        await connection.close()
        throw new Error(
          `User ${system.user} is already logged on to ${system.name}${result.information ? ` (${result.information})` : ""}. Set "whenAlreadyLoggedOn": "continue" (or "endOthers") in the configuration, or log off the other session.`
        )
      case "serverError":
        this.logonState.withdraw(account)
        await connection.close()
        throw new Error(`The server refused the logon: ${result.text}`)
      case "unclassified":
        this.logonState.withdraw(account)
        await connection.close()
        throw new Error(
          `After the logon the server shows another screen of the logon program (${result.program} ${result.screenNumber ?? ""}${result.message ? `: ${result.message}` : ""}), for example a password change. Log on once in SAP GUI to settle it.`
        )
      case "noReply":
        this.logonState.withdraw(account)
        await connection.close()
        throw new Error(`Logon to ${system.name} failed: ${result.reason}`)
    }
    state.connection = connection
    const session = this.addSession(system, 0)
    this.record(session, "gui_connect", { trigger: "logon" }, connection.mode(0).screen ? this.view(session, connection).screen : undefined)
    if (transaction) return this.start(session.id, transaction, false)
    return this.result(session, connection, undefined, { kind: "replied" })
  }

  async disconnect(target: { session?: string; system?: string }): Promise<string> {
    if (target.session) {
      const { session, connection } = this.session(target.session)
      await connection.serialized(() => connection.closeMode(session.mode))
      this.sessions.delete(session.id)
      this.record(session, "gui_disconnect", { trigger: "/i" })
      if (!connection.isOpen) this.dropSystem(session.system)
      return `Session ${session.id} ended.`
    }
    const state = this.system(target.system)
    const connection = state.connection
    if (!connection) return `${state.config.name} has no open sessions.`
    await connection.serialized(() => connection.logOff())
    this.dropSystem(state.config)
    return `Logged off ${state.config.name}.`
  }

  private dropSystem(system: SystemConfig) {
    for (const [id, s] of this.sessions) if (s.system.name === system.name) this.sessions.delete(id)
    const state = this.systemsByName.get(lower(system.name))
    if (state) state.connection = undefined
  }

  screen(id: string): AgentScreen {
    const { session, connection } = this.session(id)
    return this.view(session, connection).screen
  }

  async start(id: string, transaction: string, newSession: boolean): Promise<StepResult> {
    const { session, state, connection } = this.session(id)
    const code = transaction.trim().toUpperCase().replace(/^\/[NO]/i, "")
    state.policy.checkStart(code)
    if (newSession) return this.connect(session.system.name, code)
    return connection.serialized(async () => {
      const before = session.view?.screen
      const trigger = FunctionTrigger.okCode(`/n${code}`)
      let outcome: StepOutcome
      try {
        outcome = await connection.submit(session.mode, new FieldEdits(), trigger, { timeoutMs: session.system.stepTimeoutSeconds * 1000 })
      } catch (e) {
        this.record(session, "gui_start", { trigger: `/n${code}` }, undefined, e)
        throw e
      }
      const result = this.result(session, connection, before, outcome)
      this.record(session, "gui_start", { trigger: `/n${code}`, transaction: before?.transaction }, result.screen)
      return result
    })
  }

  // MARK: Steps

  async step(request: StepRequest): Promise<StepResult> {
    const { session, state, connection } = this.session(request.session)
    return connection.serialized(async () => {
      const mode = connection.mode(session.mode)
      const screen = mode.screen
      if (!screen) throw new EngineError("the session has no screen yet")
      if (session.revision !== mode.revision || !session.view) this.view(session, connection)
      const view = session.view!
      const before = view.screen
      const edits = new FieldEdits()
      const changes: { field: string; value?: string }[] = []
      for (const edit of request.edits ?? []) this.applyEdit(edit, screen.elements, view, edits, changes)
      for (const cell of request.cells ?? []) this.applyCell(cell, screen.elements, view, edits, changes)
      for (const mark of request.marks ?? []) this.applyMark(mark, view, edits, changes)
      const cursor = request.cursor ? this.resolveElement(request.cursor, screen.elements, view).id : undefined
      const { trigger, label, leaves } = this.trigger(request.trigger, screen.elements, view, state.policy)
      state.policy.checkScreen(screen.identity.transaction?.trim(), leaves)
      let outcome: StepOutcome
      try {
        outcome = await connection.submit(session.mode, edits, trigger, { cursor, timeoutMs: session.system.stepTimeoutSeconds * 1000 })
      } catch (e) {
        this.record(session, "gui_step", { transaction: before.transaction, program: before.program, screen: before.screenNumber, trigger: label, changes }, undefined, e)
        throw e
      }
      const result = this.result(session, connection, before, outcome)
      this.record(session, "gui_step", { transaction: before.transaction, program: before.program, screen: before.screenNumber, trigger: label, changes }, result.screen)
      return result
    })
  }

  /** A field reference, technical name, label, or table cell address `t1:ROW:COLUMN`. */
  private resolveElement(target: string, elements: readonly ScreenElement[], view: AgentView): ScreenElement {
    const byId = (id: ScreenElementID | undefined) => (id ? elements.find(e => e.id.mapKey === id.mapKey) : undefined)
    const t = target.trim()
    const ref = view.index.fields.get(t.toLowerCase())
    if (ref) return byId(ref)!
    const cell = /^(t\d+):(\d+):(.+)$/i.exec(t)
    if (cell) {
      const table = view.index.tables.get(cell[1].toLowerCase())
      if (!table) throw new EngineError(`no table ${cell[1]} on this screen`)
      const element = byId(this.cellId(table, Number(cell[2]), cell[3]))
      if (!element) throw new EngineError(`table ${cell[1]} has no cell at row ${cell[2]}, column ${cell[3]} on the visible page`)
      return element
    }
    const byName = elements.filter(e => e.fieldName && lower(e.fieldName) === lower(t))
    if (byName.length === 1) return byName[0]
    if (byName.length > 1) throw new EngineError(`${t} names ${byName.length} fields on this screen; use its f-reference`)
    const byLabel = view.screen.fields.filter(f => (f.label && lower(f.label) === lower(t)) || ((f.kind === "checkbox" || f.kind === "radio" || f.kind === "button") && f.text && lower(f.text) === lower(t)))
    if (byLabel.length === 1) return byId(view.index.fields.get(byLabel[0].ref))!
    if (byLabel.length > 1) throw new EngineError(`"${t}" labels ${byLabel.length} fields on this screen; use the f-reference`)
    throw new EngineError(`no field "${t}" on this screen (use an f-reference from gui_screen)`)
  }

  private cellId(table: ScreenTable, row: number, column: string): ScreenElementID | undefined {
    const r = table.rows.find(x => x.line === row)
    if (!r) {
      const lines = table.rows.map(x => x.line)
      throw new EngineError(
        `row ${row} is not on the visible page of the table (rows ${lines.length ? `${Math.min(...lines)}-${Math.max(...lines)}` : "none"}); page with key PageDown, or position the table first`
      )
    }
    const index = this.columnIndex(table, column)
    return r.cells[index]
  }

  private columnIndex(table: ScreenTable, column: string): number {
    const c = column.trim()
    if (/^\d+$/.test(c) && Number(c) < table.columns.length) return Number(c)
    const i = table.columns.findIndex(x => (x.fieldName && lower(x.fieldName) === lower(c)) || (x.title && lower(x.title) === lower(c)))
    if (i >= 0) return i
    const suffix = table.columns.findIndex(x => x.fieldName && lower(x.fieldName).endsWith(`-${lower(c)}`))
    if (suffix >= 0) return suffix
    throw new EngineError(`the table has no column "${column}" (columns: ${table.columns.map(x => x.fieldName ?? x.title).join(", ")})`)
  }

  private applyValue(element: ScreenElement, input: { value?: string; checked?: boolean; select?: boolean; option?: string }, edits: FieldEdits, label: string, changes: { field: string; value?: string }[]) {
    const name = element.fieldName?.trim() || label
    switch (element.kind.kind) {
      case "checkbox":
        if (input.checked === undefined) throw new EngineError(`${label} is a checkbox: give checked true or false`)
        edits.setChecked(input.checked, element.id)
        changes.push({ field: name, value: String(input.checked) })
        return
      case "radioButton":
        if (input.select === false) throw new EngineError(`${label} is a radio button: select another one of its group instead`)
        edits.select(element.id)
        changes.push({ field: name, value: "selected" })
        return
      case "dropdown": {
        const wanted = input.option ?? input.value
        if (wanted === undefined) throw new EngineError(`${label} is a dropdown: give option (key or text)`)
        const options = element.dropdown?.options ?? []
        const option = options.find(o => o.key === wanted) ?? options.find(o => lower(o.text) === lower(wanted)) ?? options.find(o => lower(o.key) === lower(wanted))
        if (!option) throw new EngineError(`${label} has no option "${wanted}" (options: ${options.map(o => `${o.key}=${o.text}`).join(", ")})`)
        edits.setDropdownKey(option.key || undefined, element.id)
        changes.push({ field: name, value: option.key })
        return
      }
      case "input":
        if (element.isPassword) throw new PolicyError("the agent never types into password fields")
        if (!element.isEditable) throw new EngineError(`${label} is not an input field here`)
        if (input.value === undefined) throw new EngineError(`${label}: give a value`)
        edits.setText(input.value, element.id)
        changes.push({ field: name, value: input.value })
        return
      default:
        throw new EngineError(`${label} cannot be edited (${element.kind.kind})`)
    }
  }

  private applyEdit(edit: FieldEditInput, elements: readonly ScreenElement[], view: AgentView, edits: FieldEdits, changes: { field: string; value?: string }[]) {
    const element = this.resolveElement(edit.field, elements, view)
    this.applyValue(element, edit, edits, edit.field, changes)
  }

  private applyCell(cell: CellEditInput, elements: readonly ScreenElement[], view: AgentView, edits: FieldEdits, changes: { field: string; value?: string }[]) {
    const element = this.resolveElement(`${cell.table}:${cell.row}:${cell.column}`, elements, view)
    this.applyValue(element, cell, edits, `${cell.table}:${cell.row}:${cell.column}`, changes)
  }

  private applyMark(mark: RowMarkInput, view: AgentView, edits: FieldEdits, changes: { field: string; value?: string }[]) {
    const table = view.index.tables.get(mark.table.trim().toLowerCase())
    if (!table) throw new EngineError(`no table ${mark.table} on this screen`)
    if (table.selection.mode !== "multiple") throw new EngineError(`table ${mark.table} has no row marks`)
    if (!table.rows.some(r => r.line === mark.row)) throw new EngineError(`row ${mark.row} is not on the visible page of ${mark.table}`)
    edits.setTableRowSelected(mark.marked, mark.row, table.id)
    changes.push({ field: `${mark.table}:${mark.row}:mark`, value: String(mark.marked) })
  }

  /** The trigger of a step, checked against the policy; `leaves` when it only leaves the screen. */
  private trigger(input: TriggerInput, elements: readonly ScreenElement[], view: AgentView, policy: Policy): { trigger: FunctionTrigger; label: string; leaves: boolean } {
    const screen = view.screen
    const saveCode = view.index.functions.get(screen.functions.find(f => f.virtualKey === SAVE_VIRTUAL_KEY)?.ref ?? "")?.code
    const leavingKeys = new Set([3, 12, 15])
    switch (input.kind) {
      case "enter":
        return { trigger: FunctionTrigger.enter, label: "Enter", leaves: false }
      case "key": {
        const vk = parseKey(input.key)
        if (vk === undefined) throw new EngineError(`unknown key "${input.key}" (e.g. F8, Shift+F2, Ctrl+F1, PageDown)`)
        if (policy.isCommit({ virtualKey: vk }, saveCode)) throw new PolicyError(`${keyLabel(vk) ?? input.key} saves: use gui_save`)
        return { trigger: vk === 0 ? FunctionTrigger.enter : FunctionTrigger.virtualKey(vk), label: keyLabel(vk) ?? input.key, leaves: leavingKeys.has(vk) }
      }
      case "function": {
        const fn = this.resolveFunction(input.function, view)
        if (!fn.isEnabled) throw new EngineError(`function "${fn.text ?? fn.code}" is disabled on this screen`)
        if (!fn.canFire) throw new EngineError(`function "${fn.text ?? fn.id}" cannot be fired (no function number or code)`)
        if (policy.isCommit({ virtualKey: fn.virtualKey, functionCode: fn.code }, saveCode))
          throw new PolicyError(`"${fn.text?.trim() ?? fn.code}" saves: use gui_save`)
        return {
          trigger: FunctionTrigger.function(fn),
          label: `function ${fn.text?.trim() ?? ""}${fn.code ? ` ${fn.code}` : ""}${fn.virtualKey !== undefined ? ` (${keyLabel(fn.virtualKey)})` : ""}`.trim(),
          leaves: fn.virtualKey !== undefined && leavingKeys.has(fn.virtualKey)
        }
      }
      case "okcode": {
        const okcode = input.okcode.trim()
        const vk = okCodeVirtualKey(okcode)
        if (vk !== undefined && policy.isCommit({ virtualKey: vk }, saveCode)) throw new PolicyError(`${okcode} saves: use gui_save`)
        if (saveCode && lower(okcode) === lower(saveCode)) throw new PolicyError(`${okcode} saves: use gui_save`)
        const intent = policy.checkOkCode(okcode)
        const leaves = intent.kind === "endTransaction" || intent.kind === "endSession" || intent.kind === "logOff" || intent.kind === "start"
        return { trigger: FunctionTrigger.okCode(okcode), label: `okcode ${okcode}`, leaves }
      }
      case "choose": {
        if (input.field) {
          const element = this.resolveElement(input.field, elements, view)
          return { trigger: FunctionTrigger.choose(ScreenPick.element(element.id)), label: `choose ${input.field}`, leaves: false }
        }
        if (input.line !== undefined) {
          const row = view.index.listRows.get(input.line)
          if (row === undefined) throw new EngineError(`list line ${input.line} is not on the visible page`)
          return { trigger: FunctionTrigger.choose(ScreenPick.list(row, input.column ?? 0)), label: `choose line ${input.line}`, leaves: false }
        }
        throw new EngineError("choose needs a field or a list line")
      }
      case "valueHelp": {
        const element = this.resolveElement(input.field, elements, view)
        return { trigger: FunctionTrigger.valueHelp(element.id), label: `F4 ${input.field}`, leaves: false }
      }
    }
  }

  private resolveFunction(target: string, view: AgentView): ScreenFunction {
    const t = target.trim()
    const byRef = view.index.functions.get(t.toLowerCase())
    if (byRef) return byRef
    const functions = [...view.index.functions.values()]
    const byCode = functions.filter(f => f.code && lower(f.code.replace(/^=/, "")) === lower(t.replace(/^=/, "")))
    if (byCode.length) return byCode.find(f => f.isEnabled) ?? byCode[0]
    const plain = (s: string | undefined) => lower((s ?? "").replace(/@[0-9A-Z]{2}(\\Q[^@]*)?@/g, ""))
    const byText = functions.filter(f => plain(f.text) === lower(t) || plain(f.tooltip) === lower(t))
    if (byText.length) return byText.find(f => f.isEnabled) ?? byText[0]
    throw new EngineError(`no function "${t}" on this screen (use a k-reference from gui_screen)`)
  }

  // MARK: Tables and lists

  async readTable(id: string, tableRef: string, fromRow: number, rows: number): Promise<AgentTable | AgentList> {
    const { session, connection } = this.session(id)
    return connection.serialized(async () => {
      const timeoutMs = session.system.stepTimeoutSeconds * 1000
      if (lower(tableRef) === "list") return this.readList(session, connection, fromRow, rows, timeoutMs)
      let view = this.view(session, connection)
      const first = view.screen.tables.find(t => t.ref === lower(tableRef))
      if (!first) throw new EngineError(`no table ${tableRef} on this screen`)
      const tableIndex = Number(first.ref.slice(1)) - 1
      const originalFirst = first.firstRow
      const total = first.totalRows
      const last = Math.min(fromRow + rows - 1, total ?? fromRow + rows - 1)
      const collected = new Map<number, AgentTable["rows"][number]>()
      for (const r of first.rows) if (r.row >= fromRow && r.row <= last) collected.set(r.row, r)
      let guard = 0
      let scrolled = false
      while (guard++ < 500) {
        const missing = [...Array(Math.max(0, last - fromRow + 1)).keys()].map(i => fromRow + i).find(line => !collected.has(line))
        if (missing === undefined) break
        const screen = connection.mode(session.mode).screen!
        const table = screen.tables[tableIndex]
        const outcome = await connection.submit(session.mode, new FieldEdits(), FunctionTrigger.scrollTable(table.id, missing), { timeoutMs })
        scrolled = true
        if (outcome.kind !== "replied") throw new EngineError(outcome.kind === "busy" ? "the server did not answer the scroll" : `the connection ended: ${outcome.reason}`)
        view = this.view(session, connection)
        const now = view.screen.tables[tableIndex]
        if (!now) throw new EngineError("the table is gone after scrolling (the screen changed)")
        let added = 0
        for (const r of now.rows) if (r.row >= fromRow && r.row <= last && !collected.has(r.row)) {
          collected.set(r.row, r)
          added++
        }
        if (added === 0) break
      }
      if (scrolled && originalFirst !== undefined) {
        const table = connection.mode(session.mode).screen!.tables[tableIndex]
        if (table) await connection.submit(session.mode, new FieldEdits(), FunctionTrigger.scrollTable(table.id, originalFirst), { timeoutMs })
        this.view(session, connection)
      }
      return { ...first, rows: [...collected.values()].sort((a, b) => a.row - b.row) }
    })
  }

  private async readList(session: Session, connection: GuiConnection, fromLine: number, count: number, timeoutMs: number): Promise<AgentList> {
    let view = this.view(session, connection)
    const list = view.screen.list
    if (!list) throw new EngineError("this screen has no list")
    const last = Math.min(fromLine + count - 1, list.totalLines ?? fromLine + count - 1)
    const collected = new Map<number, string>()
    const take = (l: AgentList) => l.lines.forEach((text, i) => collected.set(l.firstLine + i, text))
    take(list)
    const originalFirst = list.firstLine
    let steps = 0
    const page = async (vk: number) => {
      const outcome = await connection.submit(session.mode, new FieldEdits(), FunctionTrigger.virtualKey(vk), { timeoutMs })
      if (outcome.kind !== "replied") throw new EngineError(outcome.kind === "busy" ? "the server did not answer the page key" : `the connection ended: ${outcome.reason}`)
      steps++
      view = this.view(session, connection)
      if (!view.screen.list) throw new EngineError("the list is gone after paging (the screen changed)")
      return view.screen.list
    }
    let current = list
    if (fromLine < current.firstLine) {
      current = await page(VirtualKeys.firstPage)
      take(current)
    }
    while (steps < 500) {
      const missing = [...Array(Math.max(0, last - fromLine + 1)).keys()].map(i => fromLine + i).find(line => !collected.has(line))
      if (missing === undefined) break
      const before = current.firstLine
      current = await page(VirtualKeys.nextPage)
      take(current)
      if (current.firstLine === before) break
    }
    // Back to where the user was.
    if (steps && current.firstLine !== originalFirst) {
      current = await page(VirtualKeys.firstPage)
      while (current.firstLine < originalFirst && steps < 1000) {
        const before = current.firstLine
        current = await page(VirtualKeys.nextPage)
        if (current.firstLine === before) break
      }
    }
    const lines: string[] = []
    for (let n = fromLine; n <= last && collected.has(n); n++) lines.push(collected.get(n)!)
    return { header: list.header, lines, firstLine: fromLine, totalLines: list.totalLines }
  }

  // MARK: Controls

  private shell(view: AgentView, control: string): number {
    const id = view.index.controls.get(control.trim().toLowerCase())
    if (id === undefined) throw new EngineError(`no control ${control} on this screen`)
    return id
  }

  async tree(id: string, control: string, action: TreeAction, node?: string, item?: string, text?: string): Promise<StepResult | AgentControl> {
    const { session, connection } = this.session(id)
    return connection.serialized(async () => {
      const view = this.view(session, connection)
      const shellId = this.shell(view, control)
      const mode = connection.mode(session.mode)
      const shell = mode.scene.shells.get(shellId)!
      if (shell.content.kind !== "tree") throw new EngineError(`${control} is not a tree`)
      const tree = shell.content.value
      const agentControl = view.screen.controls.find(c => c.ref === control.trim().toLowerCase())!
      if (action === "read") return agentControl
      if (action === "find") {
        if (!text) throw new EngineError("find needs text")
        const pattern = new RegExp(`^${text.trim().split("*").map(p => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}`, "i")
        const hits = agentControl.tree!.nodes.filter(n => pattern.test(n.text) || new RegExp(pattern.source.replace(/^\^/, ""), "i").test(n.text))
        return { ...agentControl, tree: { nodes: hits } }
      }
      if (!node) throw new EngineError(`${action} needs a node key`)
      if (!tree.node(node)) throw new EngineError(`tree ${control} has no loaded node ${node}`)
      if (action === "select") {
        const state = ControlEvents.treeState(shell, node)
        if (state) mode.controlStates.set(shellId, state)
        mode.controlFocus = shellId
        return this.result(session, connection, view.screen, undefined, [`node ${node} selected; the next step reports it`])
      }
      if (action === "clickItem")
        throw new EngineError(
          `clicking a node's item (${item ?? "?"}) is not supported yet (Swooey spec gap #84): use open on the node, or the screen's functions`
        )
      if (action === "collapse") return this.result(session, connection, view.screen, undefined, ["collapse changes only the display; the loaded nodes stay listed"])
      if (action === "expand" && tree.hasChildren(node)) return this.result(session, connection, view.screen, undefined, [`the children of ${node} are loaded already`])
      // open, or expand of a node whose children are not loaded: the tree's node event (event 25).
      const event = ControlEvents.treeNodeOpen(mode.scene, shellId, node)
      if (!event)
        throw new EngineError(
          action === "expand"
            ? `the children of ${node} are not loaded and the server registered no node event to load them (Swooey spec gap #84)`
            : `the server registered no double-click event on this tree`
        )
      const before = view.screen
      const outcome = await connection.submit(session.mode, new FieldEdits(), FunctionTrigger.okCode(event.okCode!), {
        controls: event,
        timeoutMs: session.system.stepTimeoutSeconds * 1000
      })
      const result = this.result(session, connection, before, outcome)
      this.record(session, "gui_tree", { transaction: before.transaction, program: before.program, screen: before.screenNumber, trigger: `${action} node ${node}` }, result.screen)
      return result
    })
  }

  async grid(id: string, control: string, action: GridAction, row?: number, column?: string): Promise<StepResult | AgentControl> {
    const { session, connection } = this.session(id)
    return connection.serialized(async () => {
      const view = this.view(session, connection)
      const shellId = this.shell(view, control)
      const mode = connection.mode(session.mode)
      const shell = mode.scene.shells.get(shellId)!
      if (shell.content.kind !== "grid") throw new EngineError(`${control} is not a grid`)
      const grid = shell.content.value
      const agentControl = view.screen.controls.find(c => c.ref === control.trim().toLowerCase())!
      if (action === "read") return agentControl
      if (row === undefined || !column) throw new EngineError(`${action} needs row and column`)
      const rowNumber = grid.rowNumbers[row - 1]
      if (rowNumber === undefined) throw new EngineError(`grid ${control} has no row ${row}`)
      const col = grid.columns.find(c => lower(c.id) === lower(column) || lower(c.header) === lower(column))
      if (!col) throw new EngineError(`grid ${control} has no column ${column}`)
      const cell = { row: rowNumber, column: col.position }
      const state = ControlEvents.gridState(grid, shell, cell)
      if (state) mode.controlStates.set(shellId, state)
      mode.controlFocus = shellId
      if (action === "select") return this.result(session, connection, view.screen, undefined, [`cell ${row}/${column} is current; the next step reports it`])
      const event = ControlEvents.gridDoubleClickIn(mode.scene, shellId, cell)
      if (!event) throw new EngineError("the server registered no double-click event on this grid")
      const before = view.screen
      const outcome = await connection.submit(session.mode, new FieldEdits(), FunctionTrigger.okCode(event.okCode!), {
        controls: event,
        timeoutMs: session.system.stepTimeoutSeconds * 1000
      })
      const result = this.result(session, connection, before, outcome)
      this.record(session, "gui_grid", { transaction: before.transaction, program: before.program, screen: before.screenNumber, trigger: `open ${row}/${column}` }, result.screen)
      return result
    })
  }

  // MARK: Save

  async save(id: string, transport?: string): Promise<SaveResult> {
    const { session, state, connection } = this.session(id)
    state.policy.checkWrite()
    return connection.serialized(async () => {
      const timeoutMs = session.system.stepTimeoutSeconds * 1000
      let view = this.view(session, connection)
      const before = view.screen
      state.policy.checkScreen(before.transaction, false)
      const screen = connection.mode(session.mode).screen!
      const save = ScreenFunctions.functionForVirtualKey(screen, SAVE_VIRTUAL_KEY)
      if (save && !save.isEnabled) throw new EngineError("Save is disabled on this screen")
      const trigger = save ? FunctionTrigger.function(save) : FunctionTrigger.virtualKey(SAVE_VIRTUAL_KEY)
      let outcome = await connection.submit(session.mode, new FieldEdits(), trigger, { timeoutMs })
      this.record(session, "gui_save", { transaction: before.transaction, program: before.program, screen: before.screenNumber, trigger: "Save (Ctrl+S)" }, undefined)
      let result = this.result(session, connection, before, outcome)
      // The transport request prompt: a popup with a request field.
      const prompt = this.requestPrompt(connection, session)
      if (prompt) {
        if (!transport) {
          const text = [result.screen.popup?.title, ...result.screen.fields.filter(f => f.kind === "label" || f.kind === "output").map(f => f.text)].filter(Boolean).join(" / ")
          const cancel = await connection.submit(session.mode, new FieldEdits(), FunctionTrigger.virtualKey(12), { timeoutMs })
          const after = this.result(session, connection, result.screen, cancel, ["the request prompt was cancelled; nothing was saved"])
          this.record(session, "gui_save", { trigger: "transport prompt cancelled (no transport given)" }, after.screen)
          return { ...after, saved: false, transportPrompt: { text: text || "transport request", candidates: [] } }
        }
        const edits = new FieldEdits()
        edits.setText(transport.trim().toUpperCase(), prompt)
        const beforePrompt = result.screen
        outcome = await connection.submit(session.mode, edits, FunctionTrigger.enter, { timeoutMs })
        result = this.result(session, connection, beforePrompt, outcome)
        this.record(session, "gui_save", { trigger: "transport prompt answered", changes: [{ field: "transport request", value: transport }] }, result.screen)
      }
      view = session.view!
      const message = result.screen.message
      const saved = !result.busy && !result.screen.popup && message?.type === "S"
      return { ...result, saved }
    })
  }

  /** The request field of a transport prompt on the current popup, if it is one. */
  private requestPrompt(connection: GuiConnection, session: Session): ScreenElementID | undefined {
    const screen = connection.mode(session.mode).screen
    if (!screen || screen.presentation.kind !== "popup") return undefined
    const input = screen.elements.find(
      e => e.kind.kind === "input" && e.isEditable && (/TRKORR/i.test(e.fieldName ?? "") || /request/i.test(this.labelOf(screen.elements, e) ?? ""))
    )
    return input?.id
  }

  private labelOf(elements: readonly ScreenElement[], element: ScreenElement): string | undefined {
    let best: ScreenElement | undefined
    for (const e of elements) {
      if (e.kind.kind !== "label" || e.placement.row !== element.placement.row || e.placement.column >= element.placement.column) continue
      if (!best || e.placement.column > best.placement.column) best = e
    }
    return best ? (best.caption ?? best.text) : undefined
  }

  async wait(id: string, seconds: number): Promise<StepResult> {
    const { session, connection } = this.session(id)
    return connection.serialized(async () => {
      const before = session.view?.screen
      const outcome = await connection.wait(session.mode, seconds * 1000)
      return this.result(session, connection, before, outcome)
    })
  }

  // MARK: Housekeeping

  private async logOffIdle(): Promise<void> {
    const now = this.now()
    for (const state of this.systemsByName.values()) {
      const minutes = state.config.idleLogoffMinutes
      if (!state.connection || minutes <= 0 || now - state.lastUsed < minutes * 60_000) continue
      const connection = state.connection
      await connection.serialized(() => connection.logOff()).catch(() => undefined)
      this.dropSystem(state.config)
    }
  }

  async close(): Promise<void> {
    clearInterval(this.idleTimer)
    for (const state of this.systemsByName.values()) {
      const connection = state.connection
      if (!connection) continue
      await connection.serialized(() => connection.logOff()).catch(() => undefined)
      this.dropSystem(state.config)
    }
  }
}
