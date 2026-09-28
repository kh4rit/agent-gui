// SPDX-License-Identifier: MIT
// One DIAG connection to one system and its modes (SAP sessions): the port of Swooey's app-side
// session loop (SwooeyApp SessionRunner / ModeRouter, ScreenBridge.send, the logon gate of
// SessionModel / AutoLogon), without the windows. Each mode keeps its screen, its window-level
// carry and its control scene; a step goes out in its mode and the loop reads messages until that
// mode's reply arrives (or the step timeout: the step stays pending and `wait` picks it up).

import {
  ClientIdentityPreset,
  ControlCall,
  DataManagerReport,
  InputEnvelope,
  Secret,
  type DataManagerControl
} from "../diag/codec/index.js"
import {
  ControlScene,
  FieldEdits,
  FunctionReadings,
  FunctionTrigger,
  MultipleLogonQuestion,
  Screen,
  ScreenDecodingError,
  ScreenInputError,
  WindowLevelCarry,
  type ControlAction,
  type MultipleLogonQuestionOption,
  type ScreenElementID
} from "../diag/screen/index.js"
import {
  DiagSession,
  DisconnectReason,
  LogonCredentials,
  LogonStepError,
  MessageProblem,
  SessionSendError,
  type ServerMessage
} from "../diag/session/index.js"
import { DPTerminalName } from "../diag/wire/index.js"
import { NodeTransport } from "./nodeTransport.js"

export interface GuiConnectionOptions {
  host: string
  port: number
  /** Identity preset name: reference, reference-norfc, reference-nocfw, minimal, placeholder. */
  identity: string
  /** The machine's host name, for the DP header's terminal field (IMPL-DP-1). */
  terminalName: string
  connectTimeoutSeconds: number
  /** Structure-only trace lines (no field values, no passwords). */
  trace?: (line: string) => void
}

/** The state of one mode (one SAP session). */
export class ModeState {
  /** The current screen, after the carry and keep-content rules. */
  screen: Screen | undefined
  /** The message the screen came from (the logon step needs the logon screen's message). */
  message: ServerMessage | undefined
  scene = new ControlScene()
  carry = new WindowLevelCarry()
  /** A server error's text on the latest message, if any. */
  serverError: string | undefined
  /** Notices about the latest message (control traffic without a screen, a message not decoded). */
  notices: string[] = []
  /** Control states the next step reports (Reading R-CT-40), by shell. */
  controlStates = new Map<number, DataManagerControl>()
  /** The control with the focus (Reading R-CT-41). */
  controlFocus: number | undefined
  /** Increases with every new screen: references of an older screen are stale. */
  revision = 0
}

export type StepOutcome =
  /** The mode's reply arrived. */
  | { kind: "replied" }
  /** No reply within the timeout; the step stays pending. */
  | { kind: "busy" }
  /** The connection ended. */
  | { kind: "ended"; reason: string }

export type LogonResult =
  | { kind: "accepted" }
  /** The logon screen came back: the password (or user, client) was not accepted. */
  | { kind: "rejected"; message: string | undefined }
  | { kind: "serverError"; text: string }
  /** The user is logged on elsewhere and the configured choice was to stop. */
  | { kind: "alreadyLoggedOn"; information: string | undefined }
  /** The multiple-logon question came again after it was answered (Swooey #148): the answer did not take. */
  | { kind: "multipleLogonRepeated"; information: string | undefined }
  /** Another screen of the logon program: a password change or something else the client does not handle. */
  | { kind: "unclassified"; program: string | undefined; screenNumber: string | undefined; message: string | undefined }
  | { kind: "noReply"; reason: string }

export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineError"
  }
}

/** The logon program's name (R-SS-5). */
const LOGON_PROGRAM = "SAPMSYST"
/** The OK-codes of the session commands (PV-0543 to PV-0545, PV-0725). */
export const OkCodes = { newMode: "/o", endMode: "/i", logOff: "/nex" } as const

const ascii = (text: string) => new TextEncoder().encode(text)

export class GuiConnection {
  readonly modes = new Map<number, ModeState>()
  private pending: { mode: number; asksForNewMode: boolean }[] = []
  private inflight: Promise<ServerMessage | undefined> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  /** The mode the latest `/o` opened. */
  lastOpenedMode: number | undefined
  /** Why the connection ended, once it has. */
  ended: string | undefined

  private constructor(
    private readonly session: DiagSession<NodeTransport>,
    private readonly readings: FunctionReadings,
    private readonly options: GuiConnectionOptions
  ) {
    this.modes.set(0, new ModeState())
  }

  /** Connects, writes the first message and reads the first screen (the logon screen). */
  static async open(options: GuiConnectionOptions, firstScreenTimeoutMs = 30000): Promise<GuiConnection> {
    const preset = ClientIdentityPreset.fromName(options.identity)
    if (!preset) throw new EngineError(`unknown identity preset ${options.identity}`)
    const transport = await NodeTransport.connect(options.host, options.port, { connectTimeoutSeconds: options.connectTimeoutSeconds })
    const identity = ClientIdentityPreset.identity(preset)
    const session = new DiagSession(transport, identity, DPTerminalName.fromHostName(options.terminalName))
    // The envelope the reference identity logged on with (PV-0783): for steps and control replies.
    const envelope = InputEnvelope.default(identity)
    session.controlReadings.envelope = envelope
    const readings = new FunctionReadings({ envelope })
    const connection = new GuiConnection(session, readings, options)
    const first = await session.start()
    if (first === undefined) {
      await transport.close()
      throw new EngineError(`the first message could not be written: ${connection.stateText()}`)
    }
    connection.pending.push({ mode: 0, asksForNewMode: false })
    const outcome = await connection.awaitReply(0, firstScreenTimeoutMs)
    if (outcome.kind !== "replied") {
      await connection.close()
      throw new EngineError(outcome.kind === "busy" ? "the server sent no first screen" : `the connection ended: ${outcome.reason}`)
    }
    return connection
  }

  /** Runs `fn` after every earlier call on this connection (one step at a time). */
  serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  get isOpen(): boolean {
    return this.ended === undefined
  }

  /** The open modes, ascending. */
  get openModes(): number[] {
    return [...this.modes.keys()].sort((a, b) => a - b)
  }

  isPending(mode: number): boolean {
    return this.pending.some(p => p.mode === mode)
  }

  mode(mode: number): ModeState {
    const state = this.modes.get(mode)
    if (!state) throw new EngineError(`session mode ${mode} is not open`)
    return state
  }

  private stateText(): string {
    const state = this.session.state
    return state.kind === "disconnected" ? DisconnectReason.describe(state.reason) : state.kind
  }

  private trace(line: string) {
    this.options.trace?.(line)
  }

  // MARK: Reading

  /** The next message within `ms`, or "timeout" (the read stays in flight for the next call). */
  private async nextWithin(ms: number): Promise<ServerMessage | undefined | "timeout"> {
    if (!this.inflight) this.inflight = this.session.nextMessage()
    const current = this.inflight
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<"timeout">(resolve => (timer = setTimeout(() => resolve("timeout"), Math.max(0, ms))))
    const result = await Promise.race([current, timeout])
    clearTimeout(timer)
    if (result !== "timeout") this.inflight = undefined
    return result
  }

  /** Reads and routes messages until `done()`, the timeout, or the end of the connection. */
  private async pump(done: () => boolean, timeoutMs: number): Promise<StepOutcome> {
    const deadline = Date.now() + timeoutMs
    while (!done()) {
      if (this.ended) return { kind: "ended", reason: this.ended }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { kind: "busy" }
      const message = await this.nextWithin(remaining)
      if (message === "timeout") return { kind: "busy" }
      if (message === undefined) {
        this.ended = this.stateText()
        this.pending = []
        return { kind: "ended", reason: this.ended }
      }
      this.show(message)
    }
    // Messages that follow at once (a screen sent again, trailing control traffic).
    await this.drain(80)
    return this.ended ? { kind: "ended", reason: this.ended } : { kind: "replied" }
  }

  /** Reads what arrives within `quietMs` of the previous message. */
  private async drain(quietMs: number): Promise<void> {
    while (!this.ended) {
      const message = await this.nextWithin(quietMs)
      if (message === "timeout") return
      if (message === undefined) {
        this.ended = this.stateText()
        this.pending = []
        return
      }
      this.show(message)
    }
  }

  /** Waits for the reply of `mode`'s pending step. */
  awaitReply(mode: number, timeoutMs: number): Promise<StepOutcome> {
    return this.pump(() => !this.isPending(mode), timeoutMs)
  }

  /** Reads what the server sent meanwhile, without waiting. */
  poll(): Promise<void> {
    return this.drain(0)
  }

  // MARK: Routing (Swooey ModeRouter.show)

  private replied(mode: number) {
    const index = this.pending.findIndex(p => p.mode === mode)
    if (index >= 0) this.pending.splice(index, 1)
  }

  /** Routes one message to its mode (Reading R-MO-1) and updates that mode's screen. */
  private show(message: ServerMessage): void {
    const mode = message.mode ?? this.pending[0]?.mode ?? 0
    this.trace(`<- ${message.description}${message.mode !== undefined ? ` mode ${message.mode}` : ""}`)
    if (message.modeEvent === "opened") {
      const state = new ModeState()
      this.modes.set(mode, state)
      this.lastOpenedMode = mode
      const asker = this.pending.find(p => p.asksForNewMode)
      if (asker) this.replied(asker.mode)
    }
    const control = message.control
    if (control?.serverContinues !== true) this.replied(mode)
    if (message.modeEvent === "ended") {
      this.modes.delete(mode)
      this.pending = this.pending.filter(p => p.mode !== mode)
      return
    }
    const state = this.modes.get(mode)
    if (!state) return
    state.notices = []
    if (control) {
      this.trace(`   control traffic: ${control.summary}`)
      // A complete flush call builds or feeds controls; the handles of the session's answer name the
      // call's shells in later calls (issue #167).
      if (control.callBytes) {
        try {
          const call = ControlCall.read(control.callBytes)
          const answer = control.reply?.answer
          const handles = answer?.kind === "built" ? answer.summary.handlesByVerb : new Map<number, number>()
          state.scene.apply(call, handles)
        } catch {
          // A call that does not read builds nothing (progress indicators and the like).
        }
      }
      if (!control.showsScreen) {
        // No screen: the previous one stays (Reading R-CT-22).
        if (!control.serverContinues && control.notes.length) state.notices.push(`control traffic not answered: ${control.notes[0]}`)
        return
      }
    }
    const decoded = message.decodedErrorText()
    state.serverError = decoded ? decoded.text : undefined
    let screen: Screen
    try {
      screen = Screen.fromMessage(message, { codePage: message.codePage })
    } catch (e) {
      if (e instanceof ScreenDecodingError) {
        state.notices.push(`message ${message.number} not decoded: ${MessageProblem.describe(e.info.value)}`)
        return
      }
      throw e
    }
    // A top window sent again without content keeps what it showed (Reading R-EL-23, issue #153).
    const previous = state.screen && screen.keepsContent(state.screen) ? state.screen : undefined
    if (previous) screen.keepContent(previous)
    // What the message's window level keeps (Readings R-EL-13a, R-EL-22).
    state.carry.carry(screen, message.number)
    this.trace(
      `   screen ${screen.identity.program ?? "?"} ${screen.identity.screenNumber ?? "?"} tcode ${screen.identity.transaction ?? "-"}` +
        `${screen.presentation.kind === "popup" ? " popup" : ""}: ${screen.elements.length} elements, ${screen.tables.length} tables` +
        `${screen.list ? `, list ${screen.list.lines.length} lines` : ""}, ${state.scene.shells.size} shells` +
        `${screen.statusMessage ? `, message type ${screen.statusMessage.type.kind}` : ""}${previous ? ", kept content" : ""}` +
        `${screen.diagnostics.itemWalkStop ? ", item walk stopped" : ""}`
    )
    state.screen = screen
    state.message = message
    state.revision++
    state.controlStates.clear()
    state.controlFocus = undefined
  }

  // MARK: Steps

  /**
   * Builds the input step on `mode`'s current screen and sends it; then waits for the reply.
   * `controls` carries a control event and its report (controls/events.md §4).
   */
  async submit(
    mode: number,
    edits: FieldEdits,
    trigger: FunctionTrigger,
    options: { cursor?: ScreenElementID; controls?: ControlAction; asksForNewMode?: boolean; timeoutMs: number }
  ): Promise<StepOutcome> {
    if (this.ended) return { kind: "ended", reason: this.ended }
    const state = this.mode(mode)
    if (this.isPending(mode)) throw new EngineError("the previous step has not been answered yet: call gui_wait")
    const screen = state.screen
    if (!screen) throw new EngineError("there is no screen to submit yet")
    let step
    try {
      step = screen.inputStep(edits, trigger, { readings: this.readings, cursor: options.cursor })
    } catch (e) {
      if (e instanceof ScreenInputError) throw new EngineError(`the input was not sent: ${e.message}`)
      throw e
    }
    // What the step reports of the controls (Readings R-CT-39 to R-CT-41).
    const report = new DataManagerReport({ events: options.controls?.report.events ?? [], controls: options.controls?.report.controls.slice() ?? [] })
    const reported = new Set(report.controls.map(c => c.shell))
    for (const [shell, control] of [...state.controlStates].sort((a, b) => a[0] - b[0])) if (!reported.has(shell)) report.controls.push(control)
    const focus = options.controls?.focus ?? (options.cursor === undefined ? state.controlFocus : undefined)
    if (!report.isEmpty) step.dataManager = report.document
    if (focus !== undefined) {
      step.controlFocus = ascii(String(focus))
      step.focus = undefined
    }
    try {
      const payload = await this.session.submit(step, mode)
      payload.fill(0) // it may hold a password field
    } catch (e) {
      if (e instanceof SessionSendError) {
        if (this.session.state.kind === "disconnected") this.ended = this.stateText()
        throw new EngineError(`the input was not sent: ${e.message}`)
      }
      throw e
    }
    this.trace(`-> step mode ${mode} trigger ${trigger.kind} ${edits.count} field(s)${edits.hasElementEdits ? " + element edits" : ""}`)
    state.controlStates.clear()
    this.pending.push({ mode, asksForNewMode: options.asksForNewMode ?? false })
    return this.awaitReply(mode, options.timeoutMs)
  }

  /** Waits for a pending step's reply. */
  async wait(mode: number, timeoutMs: number): Promise<StepOutcome> {
    if (this.ended) return { kind: "ended", reason: this.ended }
    if (!this.isPending(mode)) {
      await this.poll()
      return { kind: "replied" }
    }
    return this.awaitReply(mode, timeoutMs)
  }

  // MARK: Logon (Swooey's logon gate: LogonOutcome.classify, the multiple-logon answer)

  /** Logs on on mode 0's logon screen and classifies the answer. */
  async logOn(
    credentials: { client?: string; user: string; password: Uint8Array; language?: string },
    whenAlreadyLoggedOn: "fail" | "continue" | "endOthers",
    timeoutMs: number
  ): Promise<LogonResult> {
    const state = this.mode(0)
    const gate = state.screen
    if (!gate?.isLogonScreen || !state.message) throw new EngineError("the first screen is not the logon screen")
    const program = gate.identity.program
    const screenNumber = gate.identity.screenNumber
    const logon = new LogonCredentials({
      client: ascii(credentials.client ?? ""),
      user: ascii(credentials.user),
      password: new Secret(credentials.password),
      language: credentials.language ? ascii(credentials.language) : undefined
    })
    try {
      await this.session.logOn(logon, state.message)
    } catch (e) {
      if (e instanceof LogonStepError) return { kind: "noReply", reason: e.message }
      throw e
    } finally {
      logon.password.dispose()
    }
    this.trace("-> logon step mode 0")
    this.pending.push({ mode: 0, asksForNewMode: false })
    let outcome = await this.awaitReply(0, timeoutMs)
    let answered = false
    for (;;) {
      if (outcome.kind === "busy") return { kind: "noReply", reason: "the server did not answer the logon" }
      if (outcome.kind === "ended") return { kind: "noReply", reason: `the connection ended: ${outcome.reason}` }
      const screen = this.mode(0).screen!
      if (this.mode(0).serverError !== undefined) return { kind: "serverError", text: this.mode(0).serverError! }
      const current = screen.identity.program?.trim()
      if (!current) return { kind: "noReply", reason: "the reply names no program" }
      if (!screen.isLogonScreen && current !== LOGON_PROGRAM) return { kind: "accepted" }
      const question = MultipleLogonQuestion.of(screen)
      if (question && answered) return { kind: "multipleLogonRepeated", information: question.information }
      if (question) {
        const option: MultipleLogonQuestionOption =
          whenAlreadyLoggedOn === "continue" ? "continueLogon" : whenAlreadyLoggedOn === "endOthers" ? "endOtherLogons" : "cancelLogon"
        answered = true
        outcome = await this.answerMultipleLogon(question, option, timeoutMs)
        if (option === "cancelLogon") return { kind: "alreadyLoggedOn", information: question.information }
        continue
      }
      if (current === program && screen.identity.screenNumber === screenNumber)
        return answered ? { kind: "alreadyLoggedOn", information: undefined } : { kind: "rejected", message: screen.statusMessage?.text ?? screen.message }
      return { kind: "unclassified", program: current, screenNumber: screen.identity.screenNumber, message: screen.statusMessage?.text ?? screen.message }
    }
  }

  /** Chooses `option`'s radio button and sends it (Swooey answerMultipleLogon, Reading R-EL-4). */
  private async answerMultipleLogon(question: MultipleLogonQuestion, option: MultipleLogonQuestionOption, timeoutMs: number): Promise<StepOutcome> {
    const screen = this.mode(0).screen!
    const id = question.buttons.get(option)
    if (!id) throw new EngineError("the multiple-logon question has no button for the configured choice")
    const edits = new FieldEdits()
    edits.select(id)
    const button = screen.elements.find(e => e.id.mapKey === id.mapKey)
    const trigger = button?.firesFunction ? FunctionTrigger.elementFunction(id) : FunctionTrigger.enter
    return this.submit(0, edits, trigger, { timeoutMs })
  }

  // MARK: Modes and the end

  /** Opens a new mode with `/o` (or `/oCODE`) from `fromMode`; returns the new mode. */
  async openMode(fromMode: number, transaction: string | undefined, timeoutMs: number): Promise<number> {
    this.lastOpenedMode = undefined
    const outcome = await this.submit(fromMode, new FieldEdits(), FunctionTrigger.okCode(`${OkCodes.newMode}${transaction ?? ""}`), {
      asksForNewMode: true,
      timeoutMs
    })
    if (outcome.kind === "ended") throw new EngineError(`the connection ended: ${outcome.reason}`)
    if (this.lastOpenedMode === undefined) {
      const message = this.mode(fromMode).screen?.statusMessage?.text ?? this.mode(fromMode).screen?.message
      throw new EngineError(`the server opened no new session${message ? `: ${message}` : ""}`)
    }
    return this.lastOpenedMode
  }

  /** Ends one mode with `/i` (Reading R-MO-6). */
  async closeMode(mode: number, timeoutMs = 3000): Promise<void> {
    if (this.ended || !this.modes.has(mode)) return
    if (this.modes.size === 1) return this.logOff(timeoutMs)
    const before = this.modes.size
    await this.submit(mode, new FieldEdits(), FunctionTrigger.okCode(OkCodes.endMode), { timeoutMs }).catch(() => undefined)
    if (this.modes.size === before) this.modes.delete(mode)
    this.pending = this.pending.filter(p => p.mode !== mode)
  }

  /** Logs off with `/nex` in any mode with a screen, then closes the connection cleanly. */
  async logOff(timeoutMs = 3000): Promise<void> {
    if (!this.ended) {
      const mode = [...this.modes].find(([m, s]) => s.screen && !this.isPending(m))?.[0]
      if (mode !== undefined) await this.submit(mode, new FieldEdits(), FunctionTrigger.okCode(OkCodes.logOff), { timeoutMs }).catch(() => undefined)
    }
    await this.close()
  }

  /** Closes the connection (the close message, then the socket). */
  async close(): Promise<void> {
    if (this.session.state.kind !== "disconnected") await this.session.close()
    this.ended ??= this.stateText()
    this.pending = []
  }
}
