// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/NIFrameDecoder.swift (MIT).

import { NIFrameError, NIFraming, type NIFrame, type NIFrameErrorInfo } from "./niFraming.js"

/**
 * Incremental NI frame decoder (docs/protocol/ni-framing.md, "Reading a byte stream").
 *
 * Feed it TCP reads of any size with `append`, take complete frames with `nextFrame()` (owned
 * copy) or `withNextFrame(body)` (view), and call `finish()` when the peer closes the connection. The frames produced and the error reported do
 * not depend on how the bytes were split into reads (IMPL-NI-3).
 *
 * Nothing is allocated for a frame before its declared length has passed the cap check
 * (IMPL-NI-1). Errors are sticky: after `lengthOverCap` or `truncated` every further call throws
 * the same error, and appended bytes are dropped.
 */
export class NIFrameDecoder {
  private storage = new Uint8Array(0)
  private stored = 0
  private readIndex = 0
  private isFinished = false
  private failure: NIFrameErrorInfo | undefined

  /** Stream offset of the first byte not yet consumed (the start of the next frame). */
  consumedByteCount = 0

  /** Largest declared payload length accepted; a larger one fails the stream (IMPL-NI-1). */
  constructor(readonly maxPayloadLength: number = NIFraming.defaultMaxPayloadLength) {}

  /** Bytes received but not yet consumed as part of a complete frame. */
  get bufferedByteCount(): number {
    return this.stored - this.readIndex
  }

  /** Whether `finish()` was called. */
  get hasFinished(): boolean {
    return this.isFinished
  }

  /** The error the decoder failed with, if any. */
  get error(): NIFrameError | undefined {
    return this.failure ? new NIFrameError(this.failure) : undefined
  }

  // MARK: Feeding bytes

  /** Appends bytes received from the peer. */
  append(bytes: ArrayLike<number>): void {
    if (!this.acceptsInput || bytes.length === 0) return
    this.compactIfWorthwhile()
    const needed = this.stored + bytes.length
    if (needed > this.storage.length) {
      let size = Math.max(64, this.storage.length * 2)
      while (size < needed) size *= 2
      const grown = new Uint8Array(size)
      grown.set(this.storage.subarray(0, this.stored))
      this.storage = grown
    }
    if (bytes instanceof Uint8Array) this.storage.set(bytes, this.stored)
    else for (let i = 0; i < bytes.length; i++) this.storage[this.stored + i] = bytes[i]
    this.stored = needed
  }

  /**
   * Signals that the peer closed the connection. Complete frames still buffered can be taken
   * afterwards; once none is left, a non-empty buffer makes the next call to `nextFrame()` throw
   * `truncated` (IMPL-NI-6).
   */
  finish(): void {
    this.isFinished = true
  }

  // MARK: Taking frames

  /**
   * Removes the next complete frame and returns it with an owned copy of its payload, or returns
   * `undefined` when more bytes are needed (or the stream ended cleanly).
   */
  nextFrame(): NIFrame | undefined {
    const length = this.nextFrameLength()
    if (length === undefined) return undefined
    const start = this.readIndex + NIFraming.lengthFieldSize
    const frame: NIFrame = { streamOffset: this.consumedByteCount, payload: this.storage.slice(start, start + length) }
    this.consume(NIFraming.lengthFieldSize + length)
    return frame
  }

  /**
   * Removes the next complete frame and passes a view of its payload to `body`, without copying.
   * Returns `body`'s result, or `undefined` when more bytes are needed (or the stream ended
   * cleanly). The view is valid only inside `body`.
   */
  withNextFrame<Result>(body: (streamOffset: number, payload: Uint8Array) => Result): Result | undefined {
    const length = this.nextFrameLength()
    if (length === undefined) return undefined
    const start = this.readIndex + NIFraming.lengthFieldSize
    const result = body(this.consumedByteCount, this.storage.subarray(start, start + length))
    this.consume(NIFraming.lengthFieldSize + length)
    return result
  }

  // MARK: Internals

  private get acceptsInput(): boolean {
    return this.failure === undefined && !this.isFinished
  }

  /** Payload length of the complete frame at `readIndex`, or `undefined` if not complete yet. */
  private nextFrameLength(): number | undefined {
    if (this.failure) throw new NIFrameError(this.failure)
    const available = this.stored - this.readIndex
    if (available < NIFraming.lengthFieldSize) return this.endOfData(available)
    const declared = NIFraming.readLength(this.storage.subarray(0, this.stored), this.readIndex)
    // IMPL-NI-1: compare with the cap before buffering anything for this frame.
    if (declared > this.maxPayloadLength)
      return this.fail({ kind: "lengthOverCap", declaredLength: declared, cap: this.maxPayloadLength, streamOffset: this.consumedByteCount })
    // IMPL-NI-2: 4 + L cannot overflow a double.
    const frameSize = NIFraming.lengthFieldSize + declared
    if (available < frameSize) return this.endOfData(available)
    return declared
  }

  /** No complete frame is buffered: wait for more bytes, or report the end of the stream. */
  private endOfData(available: number): number | undefined {
    if (!this.isFinished || available <= 0) return undefined
    return this.fail({ kind: "truncated", streamOffset: this.consumedByteCount, bufferedByteCount: available })
  }

  private fail(info: NIFrameErrorInfo): never {
    this.failure = info
    throw new NIFrameError(info)
  }

  private consume(count: number) {
    this.readIndex += count
    this.consumedByteCount += count
  }

  /** Drops consumed bytes when that is cheap relative to what was consumed (amortised O(1) per byte). */
  private compactIfWorthwhile() {
    if (this.readIndex === 0) return
    if (this.readIndex === this.stored) {
      this.stored = 0
      this.readIndex = 0
    } else if (this.readIndex >= this.stored - this.readIndex) {
      this.storage.copyWithin(0, this.readIndex, this.stored)
      this.stored -= this.readIndex
      this.readIndex = 0
    }
  }
}
