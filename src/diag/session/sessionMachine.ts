// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/SessionMachine.swift (MIT). The signposts of
// SessionSignposts.swift are left out (DiagSignposts is not ported); the behaviour is the same.

import {
  ApplSID,
  ByteRange,
  ClientInput,
  ClientInputStep,
  ClientMessageEncoder,
  ClientMessageError,
  ComFlag,
  Decompressor,
  DiagErrorBody,
  DiagErrorBodyError,
  DiagHeader,
  DiagHeaderError,
  DiagMessage,
  DiagMessageDecodingError,
  InputEnvelope,
  LogonFieldStructure,
  ScreenIdentityError,
  ScreenSpecGapError,
  ServerEcho,
  type ClientCompression,
  type ClientIdentity
} from "../codec/index.js"
import { CompressedDataError } from "../compression/index.js"
import { NILiteral, classifyNIPayload, receiveAction, type DPTerminalName } from "../wire/index.js"
import { ControlTrafficReply, ControlTransport, type ControlReadings, type ControlReadingsReplyShape } from "./controlTraffic.js"
import type { DiagTransportError, DiagTransportEvent } from "./diagTransport.js"
import { ServerMessage, ServerScreen, type ErrorBodyLocation, type ItemSource, type ServerMessageContent } from "./serverMessage.js"
import { SessionCodePage } from "./sessionCodePage.js"
import { ModeState, type ModeEvent } from "./sessionModes.js"
import { DisconnectReason, SessionDiagnostics, SessionSendError, SessionState } from "./sessionState.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/**
 * What the session asks of its transport after an input: payloads to write, in order, each as one
 * frame with one socket write (IMPL-NI-5); then, if set, closing the connection. A DIAG message that
 * arrived is handed over as `message`.
 *
 * Its descriptions (`description`, `toString()`, `toJSON()`, `util.inspect`) show counts only: a
 * payload may be an input step that holds a password, so neither its bytes nor its length is shown
 * (IMPL-DA-1).
 */
export class SessionReaction {
  /** Frame payloads to write, in order. */
  send: Uint8Array[] = []
  /** Close the transport after the writes. */
  closeTransport = false
  /** The DIAG message the input carried, decoded as far as the spec allows. */
  message: ServerMessage | undefined = undefined

  /** Counts only: a payload may be an input step that holds a password. */
  get description(): string {
    return (
      `SessionReaction(send: ${this.send.length} payload(s), bytes withheld; close: ${this.closeTransport ? "yes" : "no"}; message: ` +
      (this.message === undefined ? "none)" : "yes)")
    )
  }

  toString(): string {
    return this.description
  }

  toJSON(): string {
    return this.description
  }

  [INSPECT](): string {
    return this.description
  }
}

/** What `decode` read of one DIAG message. */
interface DecodedMessage {
  header: DiagHeader | undefined
  content: ServerMessageContent
  decompressed?: Uint8Array
  /** The error body of a server error, when it was read (IMPL-DH-6, IMPL-DH-7). */
  errorBody?: ErrorBodyLocation
  /** The code page the message's items declare (`SessionCodePage.declared`). */
  declaredCodePage?: number
}

/**
 * What the walk stage read of one item sequence: the content, and the code page its items declare,
 * also when the walk stopped (the items before the stop count, as in ScreenModel).
 */
interface WalkedItems {
  content: ServerMessageContent
  declaredCodePage?: number
}

/** The options of a `SessionMachine` besides the identity and the terminal. */
export interface SessionMachineOptions {
  /** The CONNECT protocol_version and the compress byte of input steps; `off` until spike P4 (IMPL-DH-4). */
  compression?: ClientCompression
  /** The cap on declared uncompressed lengths (IMPL-CH-5). */
  maxUncompressedLength?: number
}

/**
 * The session state machine of one connection (docs/architecture.md §4; docs/protocol/session.md),
 * without I/O: it turns connection events into `SessionReaction`s, and the driver `DiagSession`
 * performs them on a transport. One owner calls it, so every input is handled in order.
 *
 * - `start()`: the first message (session.md §1, R-SE-1): the DP header, the first-message DIAG
 *   header, CONNECT and SUPPORTDATA, built by `ClientMessageEncoder` from the explicit
 *   `ClientIdentity`, whose ws_type, code page and capability mask are project decisions (#16, #17,
 *   #18) and have no default.
 * - `receive(event)`: every frame payload is classified by rules 1–5 of ni-framing.md. A ping is
 *   answered at once with `NI_PONG\0`, whatever the state (IMPL-NI-4, PV-0201); a pong or an empty
 *   payload is ignored and counted (IMPL-NI-8, IMPL-NI-9); a dispatcher frame disconnects
 *   (IMPL-NI-10, provisional until #3); anything else is a DIAG message. The message is decompressed
 *   with one `Decompressor` per connection (IMPL-CH-5, IMPL-CH-6), split when it is a server error
 *   (IMPL-DH-6 to IMPL-DH-8), and its items are walked into the screen's identity and input fields
 *   (server-screen.md §6, §7). Nothing depends on a leading step item, a trailing EOM or any item
 *   order (R-SE-2, R-SS-7). A message that fails is dropped alone. Each message is routed to its
 *   mode by the header's mode byte (`modes`, session.md §8).
 * - `send(step, mode)`: an input step (client-input.md §1, R-CI-1), built by `ClientMessageEncoder`
 *   with DIALOG_STEP_NUMBER first, the step's items and EOM last, and the per-connection step
 *   counter (session.md §4, PV-0521), in the header of its mode (session.md §8). Taken on the logon
 *   screen and once logged on; the reply's screen moves `logon` on to `active` when it names a
 *   program other than the logon program (R-SS-5), DYNPRONAME read in the code page in force
 *   (`codePageInForce`, Reading R-SE-9).
 * - `close()`: the close message (PV-0302), then the transport is closed.
 * - `writeFailed(error)`: a payload of the last reaction could not be written, the close message's
 *   included, so that the reason stays true (#103).
 * - `peerClosed()` and `transportFailed(error)`: the connection is over.
 *
 * There is no timeout anywhere: a dialog step may run for minutes (architecture.md §4).
 *
 * A Swift struct: `clone()` copies it where Swift copies the value.
 */
export class SessionMachine {
  private _state: SessionState = SessionState.connecting
  private _diagnostics = new SessionDiagnostics()
  private _codePageInForce: number
  private _modes = new Map<number, ModeState>()
  private _latestMode = 0
  private encoder: ClientMessageEncoder
  private decompressor: Decompressor
  /** Whether the last DIAG message had com_flag EOC set (named in the disconnect reason, #7). */
  private lastMessageHadEOC = false
  /**
   * The control transport: a server call under way per mode, the connection's handle counter, and
   * the Readings of the automatic replies (controls/transport.md §2.3, §2.5).
   */
  private control = new ControlTransport()

  /**
   * A session for one connection.
   *
   * - `identity`: what the first message declares. There is no default: the client declares only
   *   capabilities it implements (CLEANROOM.md §1 rule 6), and the values are the P1 ADR's decision
   *   (#16, #17, #18). It is copied.
   * - `terminal`: the DP header's terminal name, the machine's real host name (IMPL-DP-1).
   * - `options.compression`: the CONNECT protocol_version and the compress byte of input steps;
   *   `off` until spike P4 (IMPL-DH-4).
   * - `options.maxUncompressedLength`: the cap on declared uncompressed lengths (IMPL-CH-5).
   */
  constructor(identity: ClientIdentity, terminal: DPTerminalName, options: SessionMachineOptions = {}) {
    this.encoder = new ClientMessageEncoder(identity, terminal, options.compression ?? "off")
    this.decompressor = new Decompressor(options.maxUncompressedLength ?? Decompressor.defaultMaxUncompressedLength)
    this._codePageInForce = identity.codePage
  }

  /** A copy of the machine: state, diagnostics, modes, step counter and control transport. */
  clone(): SessionMachine {
    const copy = new SessionMachine(this.encoder.identity, this.encoder.terminal, {
      compression: this.encoder.compression,
      maxUncompressedLength: this.decompressor.maxUncompressedLength
    })
    copy._state = this._state
    copy._diagnostics = this._diagnostics.clone()
    copy._codePageInForce = this._codePageInForce
    for (const [mode, state] of this._modes) copy._modes.set(mode, state.clone())
    copy._latestMode = this._latestMode
    copy.encoder = this.encoder.clone()
    copy.lastMessageHadEOC = this.lastMessageHadEOC
    copy.control = this.control.clone()
    return copy
  }

  get state(): SessionState {
    return this._state
  }

  /** The counts (a copy). */
  get diagnostics(): SessionDiagnostics {
    return this._diagnostics.clone()
  }

  /**
   * The code page in force after the latest DIAG message (session.md §6.3, Reading R-SE-9): the one
   * CONNECT requested until the server declares one in ST_R3INFO CODEPAGE_DIAG_GUI, then the latest
   * declared. A declaration counts wherever the message's items were read: a screen, the items after
   * a server error's text, and the items before a walk stop, as ScreenModel reads them. Each
   * `ServerMessage` carries the one its texts are in (`ServerMessage.codePage`).
   */
  get codePageInForce(): number {
    return this._codePageInForce
  }

  /**
   * The open modes (SAP sessions) of the connection, by the DIAG header's mode byte (session.md §8):
   * the first message's mode, then every mode the server opened and has not ended (Readings R-MO-1,
   * R-MO-3, R-MO-5). Each keeps its own echo (R-MO-4). A read-only view.
   */
  get modes(): ReadonlyMap<number, ModeState> {
    return this._modes
  }

  /** The mode of the latest DIAG message whose header arrived. */
  get latestMode(): number {
    return this._latestMode
  }

  /** What the first message declares (a copy). */
  get identity(): ClientIdentity {
    return this.encoder.identity.clone()
  }

  /**
   * How the session answers the server's control traffic by itself (controls/transport.md §2.3,
   * §2.5, `ControlReadings`): after a call part that announces more, and after a complete call. Set
   * it before the logon step; the default is Readings R-CT-26 to R-CT-28 with the identity's default
   * envelope. The getter returns the machine's own readings, so that `machine.controlReadings.partReply
   * = …` changes them as Swift's get-and-set does; the setter keeps a copy.
   */
  get controlReadings(): ControlReadings {
    return this.control.readings
  }

  set controlReadings(readings: ControlReadings) {
    this.control.readings = readings.clone()
  }

  /** Whether the connection is over. */
  get isDisconnected(): boolean {
    return SessionState.isDisconnected(this._state)
  }

  /** The step number of the last input step built; 0 before the first (PV-0521). */
  get lastStepNumber(): number {
    return this.encoder.lastStepNumber
  }

  /**
   * What the server last sent in the latest message's mode that the reference input envelope echoes
   * (client-input.md §11, Readings R-CI-12 and R-CI-15): mode_stat of that mode's latest DIAG
   * message, and the latest DIALOG_STEP_NUMBER, SES, CODEPAGE_DIAG_GUI, DYNN CHL, SCROLL_INFOS2 and
   * CONTAINER RESET of its messages whose items were read. With one mode it is the connection's.
   * `echoFor(mode)` gives any mode's. A copy.
   */
  get echo(): ServerEcho {
    return this.echoFor(this._latestMode)
  }

  /**
   * What the reference input envelope echoes in an input step for `mode` (Reading R-MO-4): the
   * values of that mode's own messages; empty for a mode that is not open. A copy. (Swift
   * `echo(for:)`.)
   */
  echoFor(mode: number): ServerEcho {
    return this._modes.get(mode)?.echo.clone() ?? new ServerEcho()
  }

  /** The open modes in ascending order (session.md §8). */
  get openModes(): number[] {
    return [...this._modes.keys()].sort((a, b) => a - b)
  }

  /** Whether `mode` is open: the server sent a message in it and did not end it. */
  isOpen(mode: number): boolean {
    return this._modes.has(mode)
  }

  // MARK: Inputs

  /**
   * The transport is connected: returns the first message to write (session.md §1). Does nothing
   * unless the state is `connecting`.
   */
  start(): SessionReaction {
    const reaction = new SessionReaction()
    if (this._state.kind !== "connecting") return reaction
    try {
      reaction.send.push(this.encoder.firstMessage())
      this._state = SessionState.awaitingFirstReply
    } catch (error) {
      if (!(error instanceof ClientMessageError)) throw error
      this.disconnect(DisconnectReason.firstMessageFailed(error.info), reaction)
    }
    return reaction
  }

  /** Handles one inbound event. Does nothing once the session is disconnected. */
  receive(event: DiagTransportEvent): SessionReaction {
    const reaction = new SessionReaction()
    if (this.isDisconnected) return reaction
    switch (event.kind) {
      case "pingAnswered":
        this._diagnostics.pingsAnsweredByTransport += 1
        break
      case "payload": {
        const payload = event.payload
        const payloadClass = classifyNIPayload(payload)
        const action = receiveAction(payloadClass)
        switch (action.kind) {
          case "reply":
            // IMPL-NI-4: at once, whatever the state. The transport frames the payload, so the wire
            // carries the 12 bytes of PV-0201.
            reaction.send.push(NILiteral.pong.slice())
            this._diagnostics.pingsAnswered += 1
            break
          case "ignore":
            if (payloadClass.kind === "empty") this._diagnostics.emptyPayloads += 1
            else this._diagnostics.pongsIgnored += 1
            break
          case "disconnect":
            this.disconnect(DisconnectReason.dispatcherFrame(action.literal, action.payloadLength), reaction)
            break
          case "deliver": {
            const { message, reply } = this.read(payload)
            reaction.message = message
            // The server waits for it before it sends anything else (PV-0903, PV-0905).
            if (reply !== undefined) reaction.send.push(reply)
            break
          }
        }
        break
      }
    }
    return reaction
  }

  /**
   * An input step to write (client-input.md §1, R-CI-1): the later-message DIAG header,
   * DIALOG_STEP_NUMBER with the next per-connection step, the step's items, EOM last (session.md §4,
   * PV-0524, PV-0521). A step with parts of the reference input envelope (`ClientInputStep.envelope`)
   * is written in the envelope's order with `echo`: its step number and mode_stat are then the
   * server's (client-input.md §11, R-CI-12). Only on the logon screen or once logged on (`logon`,
   * `active`); the state moves on when the reply arrives (`receive`). Nothing is written, and the
   * step counter is unchanged, when it throws `SessionSendError`.
   *
   * `mode` is the mode the step belongs to, 0 for the first: its header carries it and its envelope
   * echoes that mode's messages (Readings R-MO-2, R-MO-4; session.md §8). A mode that is not open
   * throws `modeNotOpen`.
   */
  send(step: ClientInputStep, mode = 0): SessionReaction {
    switch (this._state.kind) {
      case "logon":
      case "active":
        break
      case "connecting":
      case "awaitingFirstReply":
      case "disconnected":
        throw new SessionSendError({ kind: "notReady", state: this._state })
    }
    if (!this.isOpen(mode)) throw new SessionSendError({ kind: "modeNotOpen", mode })
    const reaction = new SessionReaction()
    try {
      reaction.send.push(ClientInput.inputMessage(this.encoder, step, mode, this.echoFor(mode)))
    } catch (error) {
      if (error instanceof ClientMessageError) throw new SessionSendError({ kind: "message", error: error.info })
      throw error
    }
    this._diagnostics.inputSteps += 1
    return reaction
  }

  /** The peer closed the connection at a frame boundary. */
  peerClosed(): SessionReaction {
    const reaction = new SessionReaction()
    if (!this.isDisconnected) this.disconnect(DisconnectReason.closedByServer(this.lastMessageHadEOC), reaction)
    return reaction
  }

  /**
   * The transport failed while connecting or reading. Does nothing once the session is
   * disconnected. A driver reports a failed write with `writeFailed`.
   */
  transportFailed(error: DiagTransportError): SessionReaction {
    const reaction = new SessionReaction()
    if (!this.isDisconnected) this.disconnect(DisconnectReason.transportFailed(error.info), reaction)
    return reaction
  }

  /**
   * A payload of the last reaction could not be written; the driver closes the transport.
   *
   * - While the session runs (the first message, an input step, a pong), it ends with
   *   `transportFailed`, as for a failed read.
   * - When the payload was the close message of `close()`, the session is over already, and its
   *   reason becomes `closeMessageNotWritten`: the transport's error is kept, and `closedByClient`
   *   no longer claims a close message that was never written (#103).
   * - Any other end stays as it is: its reaction had nothing to write.
   *
   * Only the driver that performs the last reaction calls it, and only for that reaction.
   */
  writeFailed(error: DiagTransportError): SessionReaction {
    const reaction = new SessionReaction()
    const state = this._state
    switch (state.kind) {
      case "connecting":
      case "awaitingFirstReply":
      case "logon":
      case "active":
        this.disconnect(DisconnectReason.transportFailed(error.info), reaction)
        break
      case "disconnected":
        if (state.reason.kind === "closedByClient") this.disconnect(DisconnectReason.closeMessageNotWritten(error.info), reaction)
        break
    }
    return reaction
  }

  /**
   * Ends the connection cleanly: the close message (com_flag EOC, no items, PV-0302), then the
   * transport is closed (session.md §4.3). The reason is `closedByClient`, which holds once the close
   * message is written; a driver that cannot write it reports `writeFailed`, and the reason becomes
   * `closeMessageNotWritten` (#103). Before the first message there is no dialog to close: no close
   * message is written, and the reason is `closedBeforeFirstMessage` (pongs may have been written
   * before it, IMPL-NI-4). Once disconnected, nothing happens, and the reason the session ended with
   * stays.
   */
  close(): SessionReaction {
    const reaction = new SessionReaction()
    switch (this._state.kind) {
      case "disconnected":
        break
      case "connecting":
        this.disconnect(DisconnectReason.closedBeforeFirstMessage, reaction)
        break
      case "awaitingFirstReply":
      case "logon":
      case "active":
        reaction.send.push(ClientMessageEncoder.closeMessage)
        this.disconnect(DisconnectReason.closedByClient, reaction)
        break
    }
    return reaction
  }

  private disconnect(reason: DisconnectReason, reaction: SessionReaction): void {
    this._state = SessionState.disconnected(reason)
    reaction.closeTransport = true
  }

  // MARK: DIAG messages

  /**
   * Decodes one DIAG message and moves the state on (`advance`), and reads its control traffic
   * (`answerControl`): the message, and the automatic reply to write when there is one.
   */
  private read(payload: Uint8Array): { message: ServerMessage; reply: Uint8Array | undefined } {
    this._diagnostics.messages += 1
    const decoded = this.decode(payload)
    const header = decoded.header
    if (header !== undefined) {
      this.lastMessageHadEOC = (header.comFlag & ComFlag.eoc) !== 0
      if (header.isError) this._diagnostics.serverErrors += 1
    }
    switch (decoded.content.kind) {
      case "screen":
        this._diagnostics.screens += 1
        break
      case "notDecoded":
        this._diagnostics.messagesNotDecoded += 1
        break
    }
    // A declaration governs the whole message that carries it (Reading R-SE-9).
    this._codePageInForce = decoded.declaredCodePage ?? this._codePageInForce
    let message = new ServerMessage({
      number: this._diagnostics.messages,
      payload,
      header: decoded.header,
      content: decoded.content,
      decompressed: decoded.decompressed ?? new Uint8Array(0),
      errorBody: decoded.errorBody,
      codePage: this._codePageInForce,
      declaredCodePage: decoded.declaredCodePage
    })
    message.modeEvent = this.route(message)
    this.advance(message)
    const reply = this.answerControl(message)
    const blob = message.control?.guiBlob
    if (blob !== undefined && header !== undefined) {
      // STREAM carries the screen's identity, fields and window echoes. Keep the outer message's
      // mode and one-way semantics; never recursively dispatch its items.
      // provenance: PV-1020
      const nested = SessionMachine.screen(header, blob.items, 0, "guiBlob")
      this._codePageInForce = nested.declaredCodePage ?? this._codePageInForce
      const displayed = new ServerMessage({
        number: message.number,
        payload: message.payload,
        header,
        content: nested.content,
        decompressed: message.decompressed,
        codePage: this._codePageInForce,
        declaredCodePage: nested.declaredCodePage,
        guiBlobItems: blob.items
      })
      displayed.modeEvent = message.modeEvent
      displayed.control = message.control
      const state = this._modes.get(header.mode)
      if (state !== undefined) {
        const screenEcho = new ServerEcho(blob.items)
        // The embedded screen can predate the enclosing control exchange. Its step must not replace
        // the transport's latest step (R-CT-44, PV-1020).
        screenEcho.stepNumber = undefined
        state.echo.merge(screenEcho, header)
      }
      message = displayed
      this.advance(message)
    }
    return { message, reply }
  }

  /**
   * Reads `message`'s control traffic into `ServerMessage.control` and builds the automatic reply the
   * Readings ask for (controls/transport.md §2.3, §2.5): after a call part that announces more
   * (R-CT-27) and after a complete call (R-CT-28), a reply in the message's mode: SAP GUI's
   * three-item message (R-CT-26) with the replied message's step, or the envelope's input step. An
   * interim message is never answered (R-CT-22). A reply that cannot be built is noted, never thrown:
   * the message still arrives.
   */
  private answerControl(message: ServerMessage): Uint8Array | undefined {
    const read = this.control.read(message, this.encoder.identity)
    if (read === undefined) return undefined
    const traffic = read.traffic
    message.control = traffic
    if (traffic.isInterim) this._diagnostics.interimMessages += 1
    const mor = ApplSID.RfcTr.rawValue("mor")
    const req = ApplSID.RfcTr.rawValue("req")
    this._diagnostics.controlParts += traffic.items.filter(item => item.sid === mor || item.sid === req).length
    if (traffic.call?.kind === "complete") this._diagnostics.controlCalls += 1
    const plan = read.reply
    if (plan === undefined) return undefined
    const mode = message.mode ?? this._latestMode
    switch (this._state.kind) {
      case "logon":
      case "active":
        break
      case "connecting":
      case "awaitingFirstReply":
      case "disconnected":
        traffic.notes.push("not answered: the session takes input only on the logon screen or once logged on")
        return undefined
    }
    if (!this.isOpen(mode)) {
      traffic.notes.push(`not answered: session ${mode + 1} is not open`)
      return undefined
    }
    const echo = this.echoFor(mode)
    let payload: Uint8Array
    let step: number
    let shape: ControlReadingsReplyShape
    try {
      if (plan.shape === "threeItems" && plan.transfer !== undefined) {
        // The replied message's step, which route merged into the mode's echo; else the server's
        // latest there; else the next own step (Reading R-CT-26). An envelope without echoes counts
        // its own steps: the reply never moves that count back.
        const echoes = InputEnvelope.contains(plan.envelope, InputEnvelope.echoes)
        payload = ClientInput.controlReply(this.encoder, plan.transfer, {
          mode,
          modeStat: echoes ? echo.modeStat : 0,
          stepNumber: echo.stepNumber,
          ownCount: !echoes
        })
        step = echo.stepNumber ?? this.encoder.lastStepNumber
        shape = "threeItems"
      } else {
        // The envelope shape, and the envelope alone in any shape (Reading R-CT-24).
        const input = new ClientInputStep({ envelope: InputEnvelope.controlReply(plan.envelope) })
        input.rfcTransfer = plan.transfer
        payload = ClientInput.inputMessage(this.encoder, input, mode, echo)
        step = this.encoder.lastStepNumber
        shape = "envelope"
      }
    } catch (error) {
      if (!(error instanceof ClientMessageError)) throw error
      traffic.notes.push(`the reply could not be built: ${error.message}`)
      return undefined
    }
    this.control.commit(plan)
    this._diagnostics.controlReplies += 1
    traffic.reply = new ControlTrafficReply({ kind: plan.kind, sid: plan.transfer?.sid, stepNumber: step, payload, answer: plan.answer, shape })
    return payload
  }

  /**
   * Routes `message` to its mode's state by the header's mode byte (session.md §8) and says what it
   * did to the modes. A message without a header counts for the latest mode.
   *
   * - The first message's mode opens quietly: it is the connection's first mode.
   * - A later message in a mode that is not open opens it: `opened` (Reading R-MO-3).
   * - A header-only message (8 bytes, err_no 0) with com_flag EOC in one of several open modes ends
   *   that mode: `ended` (Reading R-MO-5). In the last open mode it is the logoff, and the
   *   connection's end follows (PV-0702).
   *
   * Every message's items update its mode's echo (Reading R-MO-4).
   */
  private route(message: ServerMessage): ModeEvent | undefined {
    const echo = message.withItems(items => new ServerEcho(items)) ?? new ServerEcho()
    const header = message.header
    if (header === undefined) {
      this.modeState(this._latestMode).echo.merge(echo, undefined)
      return undefined
    }
    const mode = header.mode
    this._latestMode = mode
    let event: ModeEvent | undefined
    if (!this._modes.has(mode) && this._modes.size > 0) {
      event = "opened"
      this._diagnostics.modesOpened += 1
    }
    const state = this.modeState(mode)
    state.echo.merge(echo, header)
    state.messages += 1
    if (
      event === undefined &&
      this._modes.size > 1 &&
      message.payload.length === DiagHeader.size &&
      !header.isError &&
      (header.comFlag & ComFlag.eoc) !== 0
    ) {
      this._modes.delete(mode)
      this.control.end(mode)
      this._diagnostics.modesEnded += 1
      event = "ended"
    }
    return event
  }

  /** The state of `mode`, created when it is not open (Swift `modes[mode, default: ModeState()]`). */
  private modeState(mode: number): ModeState {
    let state = this._modes.get(mode)
    if (state === undefined) {
      state = new ModeState()
      this._modes.set(mode, state)
    }
    return state
  }

  /**
   * The state after a DIAG message. Only a screen whose items were read without a server error moves
   * it:
   * - `awaitingFirstReply` → `logon` on the first such screen (session.md §2);
   * - `logon` → `active` on a screen that carries DYNPRONAME and is not the logon program (R-SS-5,
   *   `ServerMessage.isLogonProgram()`: the name decoded in the message's code page, so that a UTF-16
   *   logon screen shown again after a rejected logon stays the logon screen): logged on. A screen
   *   without DYNPRONAME, such as a header-only message, or one whose DYNPRONAME repeats (#54),
   *   leaves the state as it is.
   */
  private advance(message: ServerMessage): void {
    const screen = message.screen
    if (screen === undefined || screen.isServerError) return
    switch (this._state.kind) {
      case "awaitingFirstReply":
        this._state = SessionState.logon
        break
      case "logon": {
        if (!(screen.identity.occurrences("dynproName") > 0)) return
        let isLogon: boolean | undefined
        try {
          isLogon = message.isLogonProgram()
        } catch (error) {
          if (!(error instanceof ScreenSpecGapError)) throw error
        }
        if (isLogon !== false) return
        this._state = SessionState.active
        break
      }
      case "connecting":
      case "active":
      case "disconnected":
        break
    }
  }

  /**
   * The header, content and decompressed data of one DIAG message (diag-header.md, "Body
   * classification"), and where its error body lies when it is a server error.
   */
  private decode(payload: Uint8Array): DecodedMessage {
    let message: DiagMessage
    try {
      message = DiagMessage.parse(payload)
    } catch (error) {
      if (!(error instanceof DiagMessageDecodingError)) throw error
      // The header is kept when its 8 bytes arrived (an unknown compress byte, a bad compression
      // header), so the diagnostics can name its fields.
      let header: DiagHeader | undefined
      try {
        header = DiagHeader.parse(payload)
      } catch (headerError) {
        if (!(headerError instanceof DiagHeaderError)) throw headerError
      }
      const info = error.info
      switch (info.kind) {
        case "header":
          return { header, content: { kind: "notDecoded", value: { kind: "header", error: info.error } } }
        case "compressionHeader":
          return { header, content: { kind: "notDecoded", value: { kind: "compressionHeader", error: info.error } } }
      }
    }
    const header = message.header
    const body = message.body
    switch (body.kind) {
      case "items": {
        const walked = SessionMachine.screen(header, body.range.of(payload), body.range.lowerBound, "payload")
        return { header, content: walked.content, declaredCodePage: walked.declaredCodePage }
      }
      case "errorBody": {
        const walked = SessionMachine.errorScreen(header, body.range.of(payload), body.range.lowerBound, "payload")
        return { header, content: walked.content, errorBody: { range: body.range, source: "payload" }, declaredCodePage: walked.declaredCodePage }
      }
      case "snc":
        return { header, content: { kind: "notDecoded", value: { kind: "snc" } } }
      case "compressed": {
        let output: Uint8Array
        try {
          output = this.decompressor.decompress(body.data.of(payload), body.header)
        } catch (error) {
          if (!(error instanceof CompressedDataError)) throw error
          return { header, content: { kind: "notDecoded", value: { kind: "decompression", error: error.info } } }
        }
        const walked = body.isErrorBody
          ? SessionMachine.errorScreen(header, output, 0, "decompressed")
          : SessionMachine.screen(header, output, 0, "decompressed")
        const errorBody: ErrorBodyLocation | undefined = body.isErrorBody
          ? { range: new ByteRange(0, output.length), source: "decompressed" }
          : undefined
        return { header, content: walked.content, decompressed: output, errorBody, declaredCodePage: walked.declaredCodePage }
      }
    }
  }

  /** Reads the screen in an item sequence that starts at `offset` of its buffer, and the code page its items declare. */
  private static screen(
    header: DiagHeader,
    items: Uint8Array,
    offset: number,
    source: ItemSource,
    errorTextByteCount?: number
  ): WalkedItems {
    const declared = SessionCodePage.declared(items)
    try {
      const fields = LogonFieldStructure.decode(items)
      const screen = new ServerScreen(header, fields, errorTextByteCount, new ByteRange(offset, offset + items.length), source)
      return { content: { kind: "screen", value: screen }, declaredCodePage: declared }
    } catch (error) {
      if (!(error instanceof ScreenIdentityError)) throw error
      return { content: { kind: "notDecoded", value: { kind: "items", error: error.info } }, declaredCodePage: declared }
    }
  }

  /** Splits an error body (text, 0x0C, items; PV-0303) and reads the items after the text. */
  private static errorScreen(header: DiagHeader, body: Uint8Array, offset: number, source: ItemSource): WalkedItems {
    let split: DiagErrorBody
    try {
      split = DiagErrorBody.split(body)
    } catch (error) {
      if (!(error instanceof DiagErrorBodyError)) throw error
      return { content: { kind: "notDecoded", value: { kind: "errorBody", error: error.info } } }
    }
    return SessionMachine.screen(header, split.itemsRange.of(body), offset + split.itemsRange.lowerBound, source, split.textRange.count)
  }
}
