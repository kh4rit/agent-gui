// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/DiagTransport.swift (MIT).

import type { NIFrameError } from "../wire/index.js"

/** What a transport hands to the session, in arrival order. */
export type DiagTransportEvent =
  /**
   * One complete NI frame payload, as received. The session classifies it by rules 1–5 of
   * docs/protocol/ni-framing.md ("Payload classification"): a keep-alive ping is answered, a pong or
   * an empty payload is ignored, a dispatcher frame disconnects, and anything else is a DIAG
   * message.
   */
  | { kind: "payload"; payload: Uint8Array }
  /**
   * The transport recognised a framed `NI_PING\0` and already wrote the framed `NI_PONG\0` on the
   * connection's own queue, whatever the turn state (IMPL-NI-4). The session only counts it.
   * Transports should answer pings themselves; one that delivers a ping as a `payload` gets the
   * answer from the session, but only while the session is receiving.
   */
  | { kind: "pingAnswered" }

/**
 * Why a transport could not connect, read or write. Descriptions name classes, counts and lengths,
 * never payload bytes (IMPL-NI-7), and never the host.
 */
export type DiagTransportErrorInfo =
  /** The connection could not be opened; `reason` is the transport's description. */
  | { kind: "connectFailed"; reason: string }
  /**
   * The NI framer failed: a declared length above the inbound cap (IMPL-NI-1), a stream that ended
   * inside a frame (IMPL-NI-6), or an outgoing payload above the outgoing cap.
   */
  | { kind: "frame"; error: NIFrameError }
  /** The connection failed while reading or writing; `reason` is the transport's description. */
  | { kind: "connectionFailed"; reason: string }

export class DiagTransportError extends Error {
  constructor(readonly info: DiagTransportErrorInfo) {
    super(describeDiagTransportError(info))
    this.name = "DiagTransportError"
  }
}

/** The error in words (Swift `DiagTransportError.description`): classes, counts and lengths only. */
export function describeDiagTransportError(info: DiagTransportErrorInfo): string {
  switch (info.kind) {
    case "connectFailed":
      return `connect failed: ${info.reason}`
    case "frame": {
      const frame = info.error.info
      switch (frame.kind) {
        case "lengthOverCap":
          return `a frame at stream offset ${frame.streamOffset} declares ${frame.declaredLength} bytes, above the cap of ${frame.cap} (IMPL-NI-1)`
        case "truncated":
          return `the stream ended inside the frame at offset ${frame.streamOffset}, after ${frame.bufferedByteCount} byte(s) of it (IMPL-NI-6)`
        case "payloadOverCap":
          return `an outgoing payload of ${frame.length} bytes is above the cap of ${frame.cap} (IMPL-NI-1)`
      }
      break
    }
    case "connectionFailed":
      return `connection failed: ${info.reason}`
  }
}

/**
 * An NI-framed connection as the session uses it (docs/architecture.md §2, "Transport"). The Node
 * socket transport (`NodeTransport`, src/engine) conforms; tests use scripted ones.
 *
 * The session is generic over its transport. A transport frames each payload itself (the u32 BE
 * length of PV-0001), writes each frame with one socket write (IMPL-NI-5), caps declared lengths
 * (IMPL-NI-1), and should answer keep-alive pings on its own (IMPL-NI-4, `pingAnswered`).
 */
export interface DiagTransport {
  /** Writes one frame carrying `payload`. Resolves once the bytes were handed to the socket; rejects with `DiagTransportError`. */
  send(payload: Uint8Array): Promise<void>

  /**
   * The next inbound event, or undefined once the peer has closed the connection at a frame
   * boundary. A peer that closes inside a frame is `DiagTransportError` `frame` with an
   * `NIFrameError` `truncated` (IMPL-NI-6).
   */
  receive(): Promise<DiagTransportEvent | undefined>

  /** Closes the connection. Calling it again does nothing. */
  close(): Promise<void>
}
