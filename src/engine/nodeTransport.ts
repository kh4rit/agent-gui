// SPDX-License-Identifier: MIT
// The DIAG transport on Node's `net` sockets: the counterpart of Swooey's NetworkTransport
// (SwooeyApp) and NIConnection (ToolTransport). It frames each payload with its u32 BE length
// (PV-0001), writes each frame with one socket write (IMPL-NI-5), caps declared lengths
// (IMPL-NI-1), and answers keep-alive pings as soon as they arrive, whatever the turn state
// (IMPL-NI-4). Errors name classes and lengths, never payload bytes or the host (IMPL-NI-7).

import { Socket, connect as netConnect } from "node:net"
import { NIFrameDecoder, NIFrameEncoder, NIFrameError, NIFraming, NIKeepAlive, classifyNIPayload } from "../diag/wire/index.js"

/** What the transport hands to the session, in arrival order (Swooey DiagTransportEvent). */
export type DiagTransportEvent =
  /** One complete NI frame payload, as received. */
  | { kind: "payload"; payload: Uint8Array }
  /** A framed NI_PING arrived and the transport already wrote the framed NI_PONG. */
  | { kind: "pingAnswered" }

/** Why a transport could not connect, read or write (Swooey DiagTransportError). */
export type DiagTransportErrorInfo =
  | { kind: "connectFailed"; reason: string }
  | { kind: "frame"; error: NIFrameError }
  | { kind: "connectionFailed"; reason: string }

export class DiagTransportError extends Error {
  constructor(readonly info: DiagTransportErrorInfo) {
    super(
      info.kind === "connectFailed"
        ? `connect failed: ${info.reason}`
        : info.kind === "frame"
          ? info.error.message
          : `connection failed: ${info.reason}`
    )
    this.name = "DiagTransportError"
  }
}

/** An NI-framed connection as the session uses it (Swooey DiagTransport). */
export interface DiagTransport {
  /** Writes one frame carrying `payload`; resolves once the bytes were handed to the socket. */
  send(payload: Uint8Array): Promise<void>
  /** The next inbound event, or undefined once the peer closed the connection at a frame boundary. */
  receive(): Promise<DiagTransportEvent | undefined>
  /** Closes the connection. Calling it again does nothing. */
  close(): Promise<void>
}

export interface NodeTransportOptions {
  /** Seconds to wait for the TCP connection (only the connect gives up; steps never time out). */
  connectTimeoutSeconds?: number
  /** Cap on a declared inbound payload length (IMPL-NI-1). */
  maxPayloadLength?: number
  /** Called whenever an event becomes available (for a caller that polls `hasPendingInbound`). */
  onInbound?: () => void
}

/** A DIAG transport over a TCP socket. */
export class NodeTransport implements DiagTransport {
  private readonly decoder: NIFrameDecoder
  private readonly encoder = new NIFrameEncoder()
  private readonly events: DiagTransportEvent[] = []
  private waiter: { resolve: (e: DiagTransportEvent | undefined) => void; reject: (e: DiagTransportError) => void } | undefined
  private ended = false
  private failure: DiagTransportError | undefined
  private closed = false
  /** Pings answered so far (IMPL-NI-4). */
  pingsAnswered = 0

  private constructor(
    private readonly socket: Socket,
    private readonly options: NodeTransportOptions
  ) {
    this.decoder = new NIFrameDecoder(options.maxPayloadLength ?? NIFraming.defaultMaxPayloadLength)
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 60_000)
    socket.on("data", chunk => this.onData(chunk))
    socket.on("end", () => this.onEnd())
    socket.on("close", () => this.onEnd())
    socket.on("error", e => this.onError(e))
  }

  /** Opens a TCP connection. The error names neither host nor port. */
  static connect(host: string, port: number, options: NodeTransportOptions = {}): Promise<NodeTransport> {
    return new Promise((resolvePromise, reject) => {
      const socket = netConnect({ host, port })
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new DiagTransportError({ kind: "connectFailed", reason: `no answer within ${options.connectTimeoutSeconds ?? 15} s` }))
      }, (options.connectTimeoutSeconds ?? 15) * 1000)
      socket.once("connect", () => {
        clearTimeout(timeout)
        socket.removeAllListeners("error")
        resolvePromise(new NodeTransport(socket, options))
      })
      socket.once("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timeout)
        reject(new DiagTransportError({ kind: "connectFailed", reason: e.code ?? "socket error" }))
      })
    })
  }

  /** Whether an event (or the end) is waiting to be received without blocking. */
  get hasPendingInbound(): boolean {
    return this.events.length > 0 || this.ended || this.failure !== undefined
  }

  private push(event: DiagTransportEvent) {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w.resolve(event)
    } else this.events.push(event)
    this.options.onInbound?.()
  }

  private onData(chunk: Buffer) {
    if (this.failure || this.closed) return
    this.decoder.append(chunk)
    for (;;) {
      let frame
      try {
        frame = this.decoder.nextFrame()
      } catch (e) {
        this.fail(new DiagTransportError({ kind: "frame", error: e as NIFrameError }))
        return
      }
      if (!frame) return
      if (classifyNIPayload(frame.payload).kind === "keepAlivePing") {
        // IMPL-NI-4: answer at once, with one write, whatever the turn state.
        this.socket.write(NIKeepAlive.pongFrame)
        this.pingsAnswered++
        this.push({ kind: "pingAnswered" })
      } else this.push({ kind: "payload", payload: frame.payload })
    }
  }

  private onEnd() {
    if (this.ended) return
    this.ended = true
    this.decoder.finish()
    try {
      // A stream that ended inside a frame is an error (IMPL-NI-6).
      while (this.decoder.nextFrame()) {
        /* complete frames were delivered in onData */
      }
    } catch (e) {
      this.fail(new DiagTransportError({ kind: "frame", error: e as NIFrameError }))
      return
    }
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w.resolve(undefined)
    }
    this.options.onInbound?.()
  }

  private onError(e: NodeJS.ErrnoException) {
    this.fail(new DiagTransportError({ kind: "connectionFailed", reason: e.code ?? "socket error" }))
  }

  private fail(error: DiagTransportError) {
    if (this.failure) return
    this.failure = error
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w.reject(error)
    }
    this.socket.destroy()
    this.options.onInbound?.()
  }

  async send(payload: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure
    if (this.closed || this.ended) throw new DiagTransportError({ kind: "connectionFailed", reason: "the connection is closed" })
    let frame: Uint8Array
    try {
      frame = this.encoder.encode(payload)
    } catch (e) {
      throw new DiagTransportError({ kind: "frame", error: e as NIFrameError })
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.socket.write(frame, err => (err ? reject(new DiagTransportError({ kind: "connectionFailed", reason: (err as NodeJS.ErrnoException).code ?? "write failed" })) : resolvePromise()))
    })
    frame.fill(0) // the frame may hold a password field
  }

  receive(): Promise<DiagTransportEvent | undefined> {
    const next = this.events.shift()
    if (next) return Promise.resolve(next)
    if (this.failure) return Promise.reject(this.failure)
    if (this.ended || this.closed) return Promise.resolve(undefined)
    if (this.waiter) return Promise.reject(new Error("receive() is already waiting"))
    return new Promise((resolvePromise, reject) => (this.waiter = { resolve: resolvePromise, reject }))
  }

  /** Like receive(), but gives up after `ms` and resolves "timeout" (the event stays queued). */
  receiveWithin(ms: number): Promise<DiagTransportEvent | undefined | "timeout"> {
    if (this.hasPendingInbound) return this.receive()
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === onEvent) this.waiter = undefined
        resolvePromise("timeout")
      }, ms)
      const onEvent = (e: DiagTransportEvent | undefined) => {
        clearTimeout(timer)
        resolvePromise(e)
      }
      this.waiter = {
        resolve: onEvent,
        reject: err => {
          clearTimeout(timer)
          reject(err)
        }
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await new Promise<void>(resolvePromise => {
      if (this.socket.destroyed) return resolvePromise()
      this.socket.end(() => resolvePromise())
      setTimeout(() => {
        this.socket.destroy()
        resolvePromise()
      }, 2000).unref()
    })
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w.resolve(undefined)
    }
  }
}
