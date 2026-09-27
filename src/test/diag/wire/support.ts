// SPDX-License-Identifier: MIT
// Shared helpers of the DiagWire tests. In Swooey they are file-level declarations of
// Tests/DiagWireTests (DPHeaderTests.swift, NIFrameDecoderTests.swift, NIPayloadClassTests.swift,
// MIT), visible to the whole test target; here they live in one module.

import { NIFrameDecoder, NIFrameError, bytesEqual, type NIFrame } from "../../../diag/wire/index.js"
import type { StreamDecodeResult } from "../../vectors/wireRunners.js"

// MARK: DPHeaderTests.swift

/** Whitespace-separated two-digit hex bytes. */
export function hexBytes(text: string): Uint8Array {
  return Uint8Array.from(
    text
      .split(/[ \n]+/)
      .filter(token => token !== "")
      .map(token => parseInt(token, 16))
  )
}

/**
 * The first-message template of dp-header.md ("First-message template"), typed in from the spec's
 * hex table, independently of the field table in the source: length (L0…L3) 0 and terminal
 * (T0…T14) all zero.
 */
export const specTemplate = hexBytes(`
FF FF FF FF 0A 00 00 00 00 00 00 FF FF FF FF FF
FF FF FF FF FF FF FF FF FF FF FF FF FF FF 00 00
00 00 00 FF FF FF FF FF FF 20 20 20 20 20 20 20
20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
20 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 20 20 20 20 20 20
20 20 20 20 20 20 20 20 20 20 20 20 20 20 00 00
00 00 00 00 00 00 FF FF FF FF 00 00 00 00 01 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00
`)

/** `specTemplate` with the length (u32 LE) and the terminal field filled in, by hand. */
export function expectedHeader(terminal: ArrayLike<number>, bodyLength: number): Uint8Array {
  const bytes = specTemplate.slice()
  bytes[30] = bodyLength & 0xff
  bytes[31] = (bodyLength >>> 8) & 0xff
  bytes[32] = (bodyLength >>> 16) & 0xff
  bytes[33] = (bodyLength >>> 24) & 0xff
  for (let index = 0; index < terminal.length; index++) bytes[81 + index] = terminal[index]
  return bytes
}

// MARK: NIFrameDecoderTests.swift

/** Builds a frame by hand (not with the encoder under test): u32 BE length, then the payload. */
export function frame(payload: ArrayLike<number>): Uint8Array {
  const n = payload.length
  const bytes = new Uint8Array(4 + n)
  bytes[0] = (n >>> 24) & 0xff
  bytes[1] = (n >>> 16) & 0xff
  bytes[2] = (n >>> 8) & 0xff
  bytes[3] = n & 0xff
  bytes.set(payload, 4)
  return bytes
}

/** Drains every complete frame; returns the frames and the error that stopped the drain, if any. */
export function drain(decoder: NIFrameDecoder): { frames: NIFrame[]; error: NIFrameError | undefined } {
  const frames: NIFrame[] = []
  for (;;) {
    try {
      const next = decoder.nextFrame()
      if (!next) return { frames, error: undefined }
      frames.push(next)
    } catch (e) {
      if (e instanceof NIFrameError) return { frames, error: e }
      throw e
    }
  }
}

// MARK: NIPayloadClassTests.swift

const asciiZ = (text: string): Uint8Array => Uint8Array.from([...new TextEncoder().encode(text), 0])

/** The literals spelled from their ASCII text, independently of the hex tables in the source. */
export const pingText = asciiZ("NI_PING")
export const pongText = asciiZ("NI_PONG")
export const dptmmsgText = asciiZ("**DPTMMSG**")
export const dptmopcText = asciiZ("**DPTMOPC**")

// MARK: Helpers of the port

/** Equality of two stream results (Swift's `StreamDecodeResult` is Equatable). */
export function sameStreamResult(a: StreamDecodeResult, b: StreamDecodeResult): boolean {
  return (
    JSON.stringify(a.error) === JSON.stringify(b.error) &&
    a.trailing === b.trailing &&
    a.frames.length === b.frames.length &&
    a.frames.every((f, i) => f.payloadOffset === b.frames[i].payloadOffset && bytesEqual(f.payload, b.frames[i].payload))
  )
}

/** Concatenates byte arrays. */
export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

/** The UTF-8 bytes of a string. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
