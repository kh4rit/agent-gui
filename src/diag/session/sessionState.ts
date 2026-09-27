// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/SessionState.swift (MIT).

import { ClientMessageError, CodecSpecGap, type ClientMessageErrorInfo } from "../codec/index.js"
import { SpecGapIssue, dispatcherLiteralName, type DispatcherLiteral } from "../wire/index.js"
import { describeDiagTransportError, type DiagTransportErrorInfo } from "./diagTransport.js"

/**
 * Why a session ended (docs/architecture.md §4, "Every reason is shown verbatim").
 *
 * A client-initiated end has one reason per outcome, so that each one is true (#103):
 * `closedByClient` only once the close message was written, `closeMessageNotWritten` when its write
 * failed, and `closedBeforeFirstMessage` when there was no dialog to close.
 */
export type DisconnectReason =
  /**
   * The client ended the connection after its first message: it wrote the close message (com_flag
   * EOC, PV-0302), then closed the transport.
   */
  | { readonly kind: "closedByClient" }
  /**
   * The client ended the connection before its first message was written: there was no dialog to
   * close, so no close message was written, and it closed the transport. The reason claims only
   * that: pongs may have been written before, since a ping is answered whatever the state
   * (IMPL-NI-4).
   */
  | { readonly kind: "closedBeforeFirstMessage" }
  /**
   * The client ended the connection, but its close message could not be written: the transport
   * failed with this error, and the client closed the transport without it, so the server may never
   * have seen the close (#103). It is its own reason rather than `transportFailed`, because the
   * client, not the failure, ended the session; and rather than `closedByClient`, which says that
   * the close message was written.
   */
  | { readonly kind: "closeMessageNotWritten"; readonly error: DiagTransportErrorInfo }
  /**
   * The server closed the connection at a frame boundary. `lastMessageHadEOC` says whether the last
   * DIAG message it sent had com_flag EOC set, as pysap's example server's logoff message does
   * (PV-0702) and architecture.md §4 lists as "server close / TERM_EOC". The session names the flag
   * and never acts on it: what EOC means in a server message is #7.
   */
  | { readonly kind: "closedByServer"; readonly lastMessageHadEOC: boolean }
  /**
   * A dispatcher frame arrived (IMPL-NI-10, provisional until #3). The payload length is kept; the
   * bytes after the literal are never read or logged (IMPL-NI-7).
   */
  | { readonly kind: "dispatcherFrame"; readonly literal: DispatcherLiteral; readonly payloadLength: number }
  /**
   * The transport failed while the session ran: a frame above the cap, a stream that ended inside a
   * frame (IMPL-NI-6), or a connection failure while reading or writing. A failed write of the
   * close message is `closeMessageNotWritten`.
   */
  | { readonly kind: "transportFailed"; readonly error: DiagTransportErrorInfo }
  /** The first message could not be built, so it was not sent. */
  | { readonly kind: "firstMessageFailed"; readonly error: ClientMessageErrorInfo }

export const DisconnectReason = {
  closedByClient: { kind: "closedByClient" } as DisconnectReason,
  closedBeforeFirstMessage: { kind: "closedBeforeFirstMessage" } as DisconnectReason,
  closeMessageNotWritten: (error: DiagTransportErrorInfo): DisconnectReason => ({ kind: "closeMessageNotWritten", error }),
  closedByServer: (lastMessageHadEOC: boolean): DisconnectReason => ({ kind: "closedByServer", lastMessageHadEOC }),
  dispatcherFrame: (literal: DispatcherLiteral, payloadLength: number): DisconnectReason => ({ kind: "dispatcherFrame", literal, payloadLength }),
  transportFailed: (error: DiagTransportErrorInfo): DisconnectReason => ({ kind: "transportFailed", error }),
  firstMessageFailed: (error: ClientMessageErrorInfo): DisconnectReason => ({ kind: "firstMessageFailed", error }),

  /** The reason in words (Swift `description`). */
  describe(reason: DisconnectReason): string {
    switch (reason.kind) {
      case "closedByClient":
        return "closed by the client (close message, com_flag EOC)"
      case "closedBeforeFirstMessage":
        return "closed by the client before its first message (no close message)"
      case "closeMessageNotWritten":
        return `closed by the client; the close message could not be written: transport failed: ${describeDiagTransportError(reason.error)}`
      case "closedByServer":
        return (
          "the server closed the connection" +
          (reason.lastMessageHadEOC ? ` after a message with com_flag EOC (its meaning is spec gap #${CodecSpecGap.comFlagSemantics})` : "")
        )
      case "dispatcherFrame":
        return (
          `dispatcher frame ${dispatcherLiteralName(reason.literal)}, ${reason.payloadLength} bytes; the session disconnects ` +
          `(IMPL-NI-10, provisional until spec gap #${SpecGapIssue.niDispatcherFrames})`
        )
      case "transportFailed":
        return `transport failed: ${describeDiagTransportError(reason.error)}`
      case "firstMessageFailed":
        return `the first message could not be built: ${new ClientMessageError(reason.error).message}`
    }
  }
} as const

/**
 * Where a connection is in its lifecycle (docs/architecture.md §4: connecting → logon → active →
 * busy → disconnected). *Busy* is not a state of its own yet: a step sent and not yet answered
 * leaves the state as it was.
 */
export type SessionState =
  /**
   * The transport is connected and the first message was not written yet. Pongs may have been: a
   * ping is answered whatever the state (IMPL-NI-4).
   */
  | { readonly kind: "connecting" }
  /**
   * The first message (DP header, CONNECT, SUPPORTDATA; session.md §1) was written, and the session
   * waits for the server's first reply. There is no client timeout (architecture.md §4): the wait
   * ends with a message, a close by either side or a transport failure.
   */
  | { readonly kind: "awaitingFirstReply" }
  /**
   * The server's first reply arrived and decoded without a server error: the logon screen
   * (session.md §2). Whether it really is the logon program is the screen's identity to tell
   * (R-SS-5, `ServerMessage.isLogonProgram()`); the state does not depend on it. The session stays
   * here while the server answers input steps with the logon program again (a rejected logon, for
   * example).
   */
  | { readonly kind: "logon" }
  /**
   * Logged on, in dialog: after the logon screen, the server answered with a screen that is not a
   * server error and names a program (DYNPRONAME, read in the code page in force, Reading R-SE-9)
   * other than the logon program (R-SS-5). The session stays here for every later screen. Which
   * screen a real server sends after a successful logon is not in the sources, so the rule is this
   * reading of R-SS-5, provisional until the owner's validation (spike P1/P3).
   */
  | { readonly kind: "active" }
  /** The connection is over; the reason is shown as it is (architecture.md §4). */
  | { readonly kind: "disconnected"; readonly reason: DisconnectReason }

export const SessionState = {
  connecting: { kind: "connecting" } as SessionState,
  awaitingFirstReply: { kind: "awaitingFirstReply" } as SessionState,
  logon: { kind: "logon" } as SessionState,
  active: { kind: "active" } as SessionState,
  disconnected: (reason: DisconnectReason): SessionState => ({ kind: "disconnected", reason }),

  /** Whether the connection is over. */
  isDisconnected(state: SessionState): boolean {
    return state.kind === "disconnected"
  },

  /** The state as Swift prints the enum: `logon`, `disconnected(<the reason in words>)`. */
  describe(state: SessionState): string {
    return state.kind === "disconnected" ? `disconnected(${DisconnectReason.describe(state.reason)})` : state.kind
  }
} as const

/**
 * Counts a session keeps for the diagnostics event log (docs/architecture.md §9): classes and
 * counts, never payload bytes (IMPL-NI-7). A Swift struct: `clone()` copies it.
 */
export class SessionDiagnostics {
  /** Pings the session answered itself, because the transport delivered them as payloads. */
  pingsAnswered = 0
  /** Pings the transport answered on its own queue (IMPL-NI-4). */
  pingsAnsweredByTransport = 0
  /** `NI_PONG\0` payloads, ignored (IMPL-NI-9). */
  pongsIgnored = 0
  /** Empty payloads, ignored (IMPL-NI-8). */
  emptyPayloads = 0
  /** DIAG messages received, decoded or not. */
  messages = 0
  /** DIAG messages whose items were read (`ServerMessageContent` `screen`). */
  screens = 0
  /** DIAG messages with err_no ≠ 0 (IMPL-DH-8), decoded or not. */
  serverErrors = 0
  /** DIAG messages dropped undecoded (`ServerMessageContent` `notDecoded`). */
  messagesNotDecoded = 0
  /** Input steps built for writing (`SessionMachine.send`). */
  inputSteps = 0
  /** Modes the server opened after the first (Reading R-MO-3, session.md §8). */
  modesOpened = 0
  /** Modes the server ended while another stayed open (Reading R-MO-5, session.md §8). */
  modesEnded = 0
  /** Interim messages: the server went on without the client (Reading R-CT-22, controls/transport.md §2.3). */
  interimMessages = 0
  /** RFC_TR items that carried a part of a server call (RFC_TR_MOR and RFC_TR_REQ). */
  controlParts = 0
  /** Server calls that arrived complete (RFC_TR_REQ). */
  controlCalls = 0
  /**
   * Replies the session sent by itself to control traffic (Readings R-CT-26 to R-CT-28, or the
   * switchable R-CT-24 and R-CT-25).
   */
  controlReplies = 0

  /** A copy of the counts. */
  clone(): SessionDiagnostics {
    return Object.assign(new SessionDiagnostics(), this)
  }
}

/**
 * Why an input step was not written (`SessionMachine.send`, `DiagSession.submit`). Descriptions name
 * the class, never a field text.
 */
export type SessionSendErrorInfo =
  /**
   * The session takes input only on the logon screen or once logged on (`logon`, `active`); it was
   * in this state.
   */
  | { readonly kind: "notReady"; readonly state: SessionState }
  /**
   * The message could not be built: an item too long for its carrier, or the step counter at its
   * maximum. Nothing was written.
   */
  | { readonly kind: "message"; readonly error: ClientMessageErrorInfo }
  /** The write failed; the session is disconnected with the transport's error (`DisconnectReason` `transportFailed`). */
  | { readonly kind: "notWritten"; readonly error: DiagTransportErrorInfo }
  /**
   * The step is for a mode that is not open: the server never sent a message in it, or it ended
   * (session.md §8). Nothing was written.
   */
  | { readonly kind: "modeNotOpen"; readonly mode: number }

export class SessionSendError extends Error {
  constructor(readonly info: SessionSendErrorInfo) {
    super(describeSessionSendError(info))
    this.name = "SessionSendError"
  }
}

/** The error in words (Swift `SessionSendError.description`). */
export function describeSessionSendError(info: SessionSendErrorInfo): string {
  switch (info.kind) {
    case "notReady":
      return `the session takes input only on the logon screen or once logged on; it is ${SessionState.describe(info.state)}`
    case "message":
      return `the input step could not be built: ${new ClientMessageError(info.error).message}`
    case "notWritten":
      return `the input step could not be written: transport failed: ${describeDiagTransportError(info.error)}`
    case "modeNotOpen":
      return `the input step is for session ${info.mode + 1} (mode ${info.mode}), which is not open`
  }
}
