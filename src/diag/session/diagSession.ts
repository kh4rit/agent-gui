// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/DiagSession.swift (MIT). The signposts of
// SessionSignposts.swift are left out (DiagSignposts is not ported); the behaviour is the same.

// DiagSession: the session of one connection (docs/architecture.md §2–§4; docs/protocol/
// session.md). Portable, transport-agnostic and generic over its transport.
//
// - `DiagTransport` / `DiagTransportEvent` / `DiagTransportError`: what the session needs from an
//   NI-framed connection. The Node socket transport (src/engine) conforms; tests use scripted ones.
// - `SessionMachine`: the state machine without I/O — the first message, keep-alive, decoding of
//   the server's messages into `ServerMessage`s (screen identity and input fields), the clean close,
//   and `SessionState` / `DisconnectReason`.
// - `DiagSession`: the driver that performs the machine's reactions on a transport, the input step
//   (client-input.md) included.
// - `LogonStep`: the logon input step built from the logon screen's field structure (R-SS-9).
// - `SessionModes`: the modes (SAP sessions) of the connection, routed by the DIAG header's mode
//   byte (session.md §8).
// - `ControlTraffic`: interim messages, server calls in parts and the automatic replies
//   (controls/transport.md §2.3, §2.5): an empty RFC_TR_MOR after a part and Swooey's own answer to
//   an `OLE_FLUSH_CALL` (DiagCodec's `FlushCallAnswerBuilder`), the intra-step server requests' stub
//   responder of architecture.md §4.

import type { ClientCompression, ClientIdentity, ClientInputStep } from "../codec/index.js"
import type { DPTerminalName } from "../wire/index.js"
import type { ControlReadings } from "./controlTraffic.js"
import { DiagTransportError, type DiagTransport } from "./diagTransport.js"
import { logOn, type LogonCredentials, type LogonStep, LogonStepOptions } from "./logonStep.js"
import type { ServerMessage } from "./serverMessage.js"
import { SessionMachine, type SessionReaction } from "./sessionMachine.js"
import { SessionSendError, type SessionDiagnostics, type SessionState } from "./sessionState.js"

/**
 * Runs a `SessionMachine` on a transport: the session of one connection, from the first message to
 * the close.
 *
 * One owner calls its methods in turn, awaiting each, so every event is handled in arrival order
 * without locks.
 *
 * There is no timeout (architecture.md §4): `nextMessage()` waits until the server sends a DIAG
 * message, either side closes, or the transport fails. Keep-alive pings are answered by the
 * transport on its own, or by the session while it receives (IMPL-NI-4).
 */
export class DiagSession<Transport extends DiagTransport = DiagTransport> {
  private readonly _machine: SessionMachine
  private readonly transport: Transport

  /** A session on `transport`, which must be connected and unused, with `machine`. */
  constructor(transport: Transport, machine: SessionMachine)
  /** A session on `transport` with a new machine; see `SessionMachine`'s constructor. */
  constructor(transport: Transport, identity: ClientIdentity, terminal: DPTerminalName, compression?: ClientCompression)
  constructor(transport: Transport, machine: SessionMachine | ClientIdentity, terminal?: DPTerminalName, compression: ClientCompression = "off") {
    this.transport = transport
    if (machine instanceof SessionMachine) {
      this._machine = machine
    } else {
      if (terminal === undefined) throw new Error("a session with a new machine needs a terminal name")
      this._machine = new SessionMachine(machine, terminal, { compression })
    }
  }

  /**
   * The state machine: state, diagnostics and the client identity. The live machine, for reading:
   * Swift hands out a copy, so drive the session through its own methods only.
   */
  get machine(): SessionMachine {
    return this._machine
  }

  get state(): SessionState {
    return this._machine.state
  }

  get diagnostics(): SessionDiagnostics {
    return this._machine.diagnostics
  }

  /** The open modes in ascending order (`SessionMachine.openModes`, session.md §8). */
  get openModes(): number[] {
    return this._machine.openModes
  }

  /**
   * How the session answers the server's control traffic by itself (`SessionMachine.controlReadings`,
   * controls/transport.md §2.3). `nextMessage()` writes the reply before it returns the message that
   * asked for it.
   */
  get controlReadings(): ControlReadings {
    return this._machine.controlReadings
  }

  set controlReadings(readings: ControlReadings) {
    this._machine.controlReadings = readings
  }

  /**
   * Writes the first message (session.md §1). Resolves to its payload once it was written, or
   * undefined when nothing was written: the session had started already, the message could not be
   * built, or the write failed (the session is then disconnected).
   */
  async start(): Promise<Uint8Array | undefined> {
    const reaction = this._machine.start()
    if (!(await this.perform(reaction))) return undefined
    return reaction.send[0]
  }

  /**
   * Waits for the next DIAG message from the server, handling keep-alive and empty frames on the
   * way. Resolves to undefined once the session is disconnected: by a dispatcher frame, a close by
   * the peer, or a transport failure. A message that could not be decoded is returned too
   * (`ServerMessageContent` `notDecoded`); the session goes on after it.
   */
  async nextMessage(): Promise<ServerMessage | undefined> {
    while (!this._machine.isDisconnected) {
      // A failed read or a close by the peer disconnects the machine, which ends the loop.
      let reaction: SessionReaction
      try {
        const event = await this.transport.receive()
        reaction = event !== undefined ? this._machine.receive(event) : this._machine.peerClosed()
      } catch (error) {
        if (!(error instanceof DiagTransportError)) throw error
        reaction = this._machine.transportFailed(error)
      }
      await this.perform(reaction)
      if (reaction.message !== undefined) return reaction.message
    }
    return undefined
  }

  /**
   * Writes an input step (client-input.md §1): DIALOG_STEP_NUMBER with the next per-connection step
   * first, the step's items, EOM last (`SessionMachine.send`), in the header of `mode`, an open mode
   * (session.md §8). Resolves to whether it was written. Nothing is written before the logon screen,
   * after the session ended, or when the message cannot be built; a failed write disconnects the
   * session with the transport's error. The reply comes from `nextMessage()`, which moves the state
   * on to `active` once a screen past the logon screen arrives.
   */
  async send(step: ClientInputStep, mode = 0): Promise<boolean> {
    try {
      await this.submit(step, mode)
      return true
    } catch (error) {
      if (error instanceof SessionSendError) return false
      throw error
    }
  }

  /**
   * `send` that says why nothing was written: it rejects with `SessionSendError`. Resolves to the
   * payload that was written, for a caller that shows its structure: it may hold a password field's
   * text, so it is never logged or kept, and only a structure dump that withholds the password's
   * lengths (IMPL-DA-1) may be made of it; the caller wipes it after that.
   */
  async submit(step: ClientInputStep, mode = 0): Promise<Uint8Array> {
    const reaction = this._machine.send(step, mode)
    if (!(await this.perform(reaction))) {
      const state = this._machine.state
      if (state.kind === "disconnected" && state.reason.kind === "transportFailed")
        throw new SessionSendError({ kind: "notWritten", error: state.reason.error })
      throw new SessionSendError({ kind: "notReady", state })
    }
    return reaction.send[0] ?? new Uint8Array(0)
  }

  /**
   * Builds the logon step for `screen` and writes it (`LogonStep`, `submit`); rejects with
   * `LogonStepError`. See `logOn` in logonStep.ts. (Swift: `extension DiagSession` in
   * LogonStep.swift, `logOn(_:on:options:)`.)
   */
  logOn(credentials: LogonCredentials, screen: ServerMessage, options: LogonStepOptions = new LogonStepOptions()): Promise<LogonStep> {
    return logOn(this, credentials, screen, options)
  }

  /**
   * Ends the connection cleanly (session.md §4.3): writes the close message, then closes the
   * transport. Resolves to the close message once it was written; the reason is then
   * `closedByClient`. Resolves to undefined when none was written:
   * - the session had not started: `closedBeforeFirstMessage`;
   * - it was disconnected already: its reason stays, and the transport is not closed again;
   * - the write failed: `closeMessageNotWritten` with the transport's error (#103).
   *
   * Either way the session is disconnected afterwards.
   */
  async close(): Promise<Uint8Array | undefined> {
    const reaction = this._machine.close()
    if (!(await this.perform(reaction))) return undefined
    return reaction.send[0]
  }

  /**
   * Writes the reaction's payloads in order, then closes the transport when asked. A failed write
   * goes to the machine (`SessionMachine.writeFailed`), which keeps the transport's error in the
   * reason: `transportFailed` while the session runs, `closeMessageNotWritten` for the close message
   * (#103); then the transport is closed. Resolves to whether at least one payload was asked for and
   * every payload was written.
   */
  private async perform(reaction: SessionReaction): Promise<boolean> {
    for (const payload of reaction.send) {
      try {
        await this.transport.send(payload)
      } catch (error) {
        if (!(error instanceof DiagTransportError)) throw error
        this._machine.writeFailed(error)
        await this.transport.close()
        return false
      }
    }
    if (reaction.closeTransport) await this.transport.close()
    return reaction.send.length > 0
  }
}
