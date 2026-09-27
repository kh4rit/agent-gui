// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/NIPayloadClass.swift and NIKeepAlive.swift (MIT).

import { WireBytes } from "./bytes.js"
import { SpecGapIssue } from "./diagWire.js"

/** The fixed literals of the NI layer (docs/protocol/ni-framing.md, "Keep-alive", "Dispatcher frames"). */
export const NILiteral = {
  /** `NI_PING\0`, sent by the server. */
  ping: Uint8Array.of(0x4e, 0x49, 0x5f, 0x50, 0x49, 0x4e, 0x47, 0x00), // provenance: PV-0004
  /** `NI_PONG\0`, the client's answer to a ping. */
  pong: Uint8Array.of(0x4e, 0x49, 0x5f, 0x50, 0x4f, 0x4e, 0x47, 0x00), // provenance: PV-0005
  /** `**DPTMMSG**\0` at the start of a dispatcher frame. */
  dptmmsg: Uint8Array.of(0x2a, 0x2a, 0x44, 0x50, 0x54, 0x4d, 0x4d, 0x53, 0x47, 0x2a, 0x2a, 0x00), // provenance: PV-0006
  /** `**DPTMOPC**\0` at the start of a dispatcher frame. */
  dptmopc: Uint8Array.of(0x2a, 0x2a, 0x44, 0x50, 0x54, 0x4d, 0x4f, 0x50, 0x43, 0x2a, 0x2a, 0x00) // provenance: PV-0007
} as const

/** The two dispatcher literals (R-NI-6). */
export type DispatcherLiteral = "dptmmsg" | "dptmopc"
export const DISPATCHER_LITERALS: readonly DispatcherLiteral[] = ["dptmmsg", "dptmopc"]

/** The literal's bytes, including the trailing zero byte. */
export const dispatcherLiteralBytes = (literal: DispatcherLiteral): Uint8Array => NILiteral[literal]

/** The literal as the spec writes it, without the zero byte. */
export const dispatcherLiteralName = (literal: DispatcherLiteral): string =>
  literal === "dptmmsg" ? "**DPTMMSG**" : "**DPTMOPC**"

/**
 * The payload length at which pysap recognises this literal: the literal plus 2 bytes for
 * `**DPTMMSG**\0`, plus 5 bytes for `**DPTMOPC**\0`. Other lengths still classify by the prefix
 * (R-NI-9); what the extra bytes contain is spec gap #3.
 */
export const dispatcherExpectedPayloadLength = (literal: DispatcherLiteral): number =>
  literal === "dptmmsg"
    ? 14 // provenance: PV-0203
    : 17 // provenance: PV-0204

/**
 * The class of a frame payload received from the server (docs/protocol/ni-framing.md,
 * "Payload classification"): the first of rules 1–5 that matches. A client never looks for a DP
 * header in received frames (IMPL-DP-5): a payload that is none of the NI literals is a DIAG
 * message.
 */
export type NIPayloadClass =
  /** Rule 1: a zero-length payload (PV-0205). Ignored (IMPL-NI-8). */
  | { kind: "empty" }
  /** Rule 2: exactly the 8 bytes of `NI_PING\0`. Answered with the framed `NI_PONG\0`. */
  | { kind: "keepAlivePing" }
  /** Rule 3: exactly the 8 bytes of `NI_PONG\0`. Ignored (IMPL-NI-9). */
  | { kind: "keepAlivePong" }
  /** Rule 4: the payload begins with a dispatcher literal, whatever its length (R-NI-9). */
  | { kind: "dispatcher"; literal: DispatcherLiteral; payloadLength: number }
  /** Rule 5: anything else is a DIAG message starting with the DIAG header (R-NI-8). */
  | { kind: "diag" }

/** Classifies one complete frame payload received from the server. */
export function classifyNIPayload(payload: Uint8Array): NIPayloadClass {
  if (payload.length === 0) return { kind: "empty" }
  if (payload.length === NILiteral.ping.length && WireBytes.hasPrefix(payload, NILiteral.ping)) return { kind: "keepAlivePing" }
  if (payload.length === NILiteral.pong.length && WireBytes.hasPrefix(payload, NILiteral.pong)) return { kind: "keepAlivePong" }
  if (WireBytes.hasPrefix(payload, NILiteral.dptmmsg)) return { kind: "dispatcher", literal: "dptmmsg", payloadLength: payload.length }
  if (WireBytes.hasPrefix(payload, NILiteral.dptmopc)) return { kind: "dispatcher", literal: "dptmopc", payloadLength: payload.length }
  return { kind: "diag" }
}

/** For a dispatcher payload, the number of bytes after the literal (spec gap #3); otherwise undefined. */
export function dispatcherTrailingByteCount(payloadClass: NIPayloadClass): number | undefined {
  if (payloadClass.kind !== "dispatcher") return undefined
  return payloadClass.payloadLength - dispatcherLiteralBytes(payloadClass.literal).length
}

/** The open spec gap that bounds what the client does with this payload: #3 for a dispatcher frame. */
export function openSpecGap(payloadClass: NIPayloadClass): number | undefined {
  return payloadClass.kind === "dispatcher" ? SpecGapIssue.niDispatcherFrames : undefined
}

/** What the connection does with a received payload, by its class. */
export type NIReceiveAction =
  /**
   * Write `frame` at once, with one socket write, whatever the turn state, and do not pass the
   * ping on to the session (IMPL-NI-4, IMPL-NI-5). `frame` is the 12-byte framed `NI_PONG\0`.
   */
  | { kind: "reply"; frame: Uint8Array }
  /** Drop the payload; the connection stays open (IMPL-NI-8, IMPL-NI-9). */
  | { kind: "ignore" }
  /**
   * Provisional until spec gap #3 is resolved (IMPL-NI-10): move the session to disconnected with
   * a reason that names the literal, stop sending and close the connection.
   */
  | { kind: "disconnect"; literal: DispatcherLiteral; payloadLength: number; provisionalUntilIssue: number }
  /** Hand the payload to the DIAG decoder (classification rule 5). */
  | { kind: "deliver" }

/** What the connection does with this payload (IMPL-NI-4, IMPL-NI-8, IMPL-NI-9, IMPL-NI-10). */
export function receiveAction(payloadClass: NIPayloadClass): NIReceiveAction {
  switch (payloadClass.kind) {
    case "keepAlivePing":
      return { kind: "reply", frame: NIKeepAlive.pongFrame.slice() }
    case "empty":
    case "keepAlivePong":
      return { kind: "ignore" }
    case "dispatcher":
      return {
        kind: "disconnect",
        literal: payloadClass.literal,
        payloadLength: payloadClass.payloadLength,
        provisionalUntilIssue: SpecGapIssue.niDispatcherFrames
      }
    case "diag":
      return { kind: "deliver" }
  }
}

/**
 * Keep-alive replies (docs/protocol/ni-framing.md, "Keep-alive"; IMPL-NI-4). The server pings
 * with a framed `NI_PING\0`; the client answers each ping once, at once, with the framed
 * `NI_PONG\0` (R-NI-4). The client never pings (IMPL-NI-9).
 */
export const NIKeepAlive = {
  /** The u32 BE length 8, then `NI_PONG\0`: 12 bytes, written with a single socket write. */
  pongFrame: Uint8Array.of(0x00, 0x00, 0x00, 0x08, 0x4e, 0x49, 0x5f, 0x50, 0x4f, 0x4e, 0x47, 0x00), // provenance: PV-0201, PV-0005

  /** The payload the client sends back for `payloadClass`: `NI_PONG\0` for a ping, otherwise undefined. */
  replyPayload(payloadClass: NIPayloadClass): Uint8Array | undefined {
    return payloadClass.kind === "keepAlivePing" ? NILiteral.pong.slice() : undefined
  },

  /** The bytes the client writes on the wire for `payloadClass`: the pong frame for a ping. */
  replyFrame(payloadClass: NIPayloadClass): Uint8Array | undefined {
    return payloadClass.kind === "keepAlivePing" ? NIKeepAlive.pongFrame.slice() : undefined
  }
} as const
