// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/WireVectorRunners.swift and the ni-stream part of
// VectorRunner.swift (MIT): the DiagWire kinds `ni-stream`, `ni-payload` and `dp-header`.

import {
  DPHeader,
  DPHeaderError,
  DPTerminalName,
  NIFrameDecoder,
  NIFrameError,
  NIFraming,
  NIKeepAlive,
  bytesEqual,
  classifyNIPayload,
  dpHeaderFieldName,
  hexText,
  payloadStreamOffset,
  receiveAction,
  type NIFrameErrorInfo,
  type NIPayloadClass
} from "../../diag/wire/index.js"
import type { Expectations } from "./expectations.js"
import { registerKind } from "./registry.js"

export const NO_ERROR = "none"

export function niFrameErrorClass(info: NIFrameErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return "truncated"
    case "lengthOverCap":
    case "payloadOverCap":
      return "length-over-cap"
  }
}

export function payloadClassName(payloadClass: NIPayloadClass): string {
  switch (payloadClass.kind) {
    case "empty":
      return "empty"
    case "keepAlivePing":
      return "keepalive-ping"
    case "keepAlivePong":
      return "keepalive-pong"
    case "dispatcher":
      return payloadClass.literal === "dptmmsg" ? "dispatcher-dptmmsg" : "dispatcher-dptmopc"
    case "diag":
      return "diag"
  }
}

/** Error classes of the dp-header kind. `bodyTooLong` maps to the class of an over-long length. */
export function dpHeaderErrorClass(error: DPHeaderError): string {
  switch (error.info.kind) {
    case "truncated":
      return "truncated"
    case "lengthMismatch":
      return "length-mismatch"
    case "bodyTooLong":
      return "length-over-cap"
  }
}

// MARK: ni-stream

/** The outcome of feeding one byte stream to the NI framer. */
export interface StreamDecodeResult {
  frames: { payloadOffset: number; payload: Uint8Array }[]
  /** The error at the end of the stream, or undefined for a clean end. */
  error: NIFrameErrorInfo | undefined
  /** Input bytes after the last complete frame. */
  trailing: number
}

const errorClassOf = (r: StreamDecodeResult) => (r.error ? niFrameErrorClass(r.error) : NO_ERROR)

/** Feeds `input` in reads that end at each position of `cuts`, taking frames after every read. */
export function decodeStream(input: Uint8Array, cuts: number[] = [], cap = NIFraming.defaultMaxPayloadLength): StreamDecodeResult {
  const decoder = new NIFrameDecoder(cap)
  const frames: StreamDecodeResult["frames"] = []
  let failure: NIFrameErrorInfo | undefined
  const drain = () => {
    while (failure === undefined) {
      try {
        const frame = decoder.nextFrame()
        if (!frame) return
        frames.push({ payloadOffset: payloadStreamOffset(frame), payload: frame.payload })
      } catch (e) {
        if (!(e instanceof NIFrameError)) throw e
        failure = e.info
      }
    }
  }
  let start = 0
  for (const end of [...cuts, input.length]) {
    if (failure !== undefined) break
    decoder.append(input.subarray(start, end))
    start = end
    drain()
  }
  if (failure === undefined) {
    decoder.finish()
    drain()
  }
  return { frames, error: failure, trailing: input.length - decoder.consumedByteCount }
}

const sameResult = (a: StreamDecodeResult, b: StreamDecodeResult) =>
  JSON.stringify(a.error) === JSON.stringify(b.error) &&
  a.trailing === b.trailing &&
  a.frames.length === b.frames.length &&
  a.frames.every((f, i) => f.payloadOffset === b.frames[i].payloadOffset && bytesEqual(f.payload, b.frames[i].payload))

/** Caps the ni-stream vectors run under: the README's minimum (256) and the default cap. */
const STREAM_CAPS = [256, NIFraming.defaultMaxPayloadLength]

function runNIStream(input: Uint8Array, expect: Expectations, failures: string[]) {
  const reference = decodeStream(input, [], STREAM_CAPS[0])
  // IMPL-NI-3: every splitting and every cap must give the same frames, error and trailing count.
  for (const cap of STREAM_CAPS) {
    const variants: [string, StreamDecodeResult][] = [
      [`one read, cap ${cap}`, decodeStream(input, [], cap)],
      [`one byte per read, cap ${cap}`, decodeStream(input, input.length ? Array.from({ length: input.length - 1 }, (_, i) => i + 1) : [], cap)]
    ]
    for (let position = 0; position <= input.length; position++)
      variants.push([`two reads split at ${position}, cap ${cap}`, decodeStream(input, [position], cap)])
    for (const [label, result] of variants) if (!sameResult(result, reference)) failures.push(`${label} differs from the one-read result`)
  }
  const expectedError = expect.string("expect.error")
  if (expectedError !== undefined && expectedError !== errorClassOf(reference))
    failures.push(`error: expected ${expectedError}, got ${errorClassOf(reference)}`)
  const trailing = expect.int("expect.trailing")
  if (trailing !== undefined && trailing !== reference.trailing) failures.push(`trailing: expected ${trailing}, got ${reference.trailing}`)
  const count = expect.int("expect.frames")
  if (count === undefined) return
  if (count !== reference.frames.length) failures.push(`frames: expected ${count}, got ${reference.frames.length}`)
  for (let number = 1; number <= count; number++) {
    const offset = expect.int(`expect.frame.${number}.offset`)
    const length = expect.int(`expect.frame.${number}.length`)
    if (offset === undefined || length === undefined || number > reference.frames.length) continue
    const frame = reference.frames[number - 1]
    if (frame.payloadOffset !== offset) failures.push(`frame ${number} offset: expected ${offset}, got ${frame.payloadOffset}`)
    if (frame.payload.length !== length) failures.push(`frame ${number} length: expected ${length}, got ${frame.payload.length}`)
    if (offset + length <= input.length && !bytesEqual(frame.payload, input.subarray(offset, offset + length)))
      failures.push(`frame ${number} payload differs from input[${offset}..<${offset + length}]`)
  }
}

// MARK: ni-payload

/** Classification rules 1–5 and the keep-alive reply (IMPL-NI-4). */
function runNIPayload(input: Uint8Array, expect: Expectations, failures: string[]) {
  const payloadClass = classifyNIPayload(input)
  const actualClass = payloadClassName(payloadClass)
  const expectedClass = expect.string("expect.class")
  if (expectedClass !== undefined && expectedClass !== actualClass) failures.push(`class: expected ${expectedClass}, got ${actualClass}`)
  const reply = NIKeepAlive.replyPayload(payloadClass) ?? new Uint8Array(0)
  const expectedReply = expect.hex("expect.reply")
  if (expectedReply && !bytesEqual(expectedReply, reply)) failures.push(`reply: expected ${hexText(expectedReply)}, got ${hexText(reply)}`)
  const action = receiveAction(payloadClass)
  const written = action.kind === "reply" ? action.frame : new Uint8Array(0)
  if (!bytesEqual(written, NIKeepAlive.replyFrame(payloadClass) ?? new Uint8Array(0)))
    failures.push("receive action and NIKeepAlive.replyFrame disagree")
  const expectedFrame = expect.hex("expect.reply.frame")
  if (!expectedFrame) return
  // The frame must be the u32 BE length of the reply, then the reply (built here by hand).
  if (expectedReply) {
    const n = expectedReply.length
    const framed = n === 0 ? [] : [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...expectedReply]
    if (!bytesEqual(framed, expectedFrame)) failures.push("vector: expect.reply.frame is not the u32 BE framing of expect.reply")
  }
  if (!bytesEqual(expectedFrame, written)) failures.push(`reply.frame: expected ${hexText(expectedFrame)}, got ${hexText(written)}`)
}

// MARK: dp-header

/** The first-message decoder (IMPL-DP-3) and, through the round trip, the encoder (IMPL-DP-2, IMPL-DP-4). */
function runDPHeader(input: Uint8Array, expect: Expectations, failures: string[]) {
  let header: DPHeader | undefined
  let decodeError: DPHeaderError | undefined
  try {
    header = DPHeader.parseFirstMessage(input)
  } catch (e) {
    if (!(e instanceof DPHeaderError)) throw e
    decodeError = e
  }
  const actualError = decodeError ? dpHeaderErrorClass(decodeError) : NO_ERROR
  const expectedError = expect.string("expect.error")
  if (expectedError === undefined) return
  if (expectedError !== actualError) {
    failures.push(`error: expected ${expectedError}, got ${actualError}`)
    expect.consumeAll()
    return
  }
  if (decodeError?.info.kind === "truncated") return
  if (decodeError?.info.kind === "lengthMismatch") {
    const { declaredLength, bodyLength } = decodeError.info
    const expectedLength = expect.int("expect.length")
    if (expectedLength !== undefined && expectedLength !== declaredLength) failures.push(`length: expected ${expectedLength}, got ${declaredLength}`)
    const expectedBody = expect.int("expect.body_length")
    if (expectedBody !== undefined && expectedBody !== bodyLength) failures.push(`body_length: expected ${expectedBody}, got ${bodyLength}`)
    return
  }
  if (!header) return
  const prefix = input.subarray(0, DPHeader.size)
  const bodyLength = input.length - DPHeader.size
  const expectedLength = expect.int("expect.length")
  if (expectedLength !== undefined && expectedLength !== header.length) failures.push(`length: expected ${expectedLength}, got ${header.length}`)
  const expectedBody = expect.int("expect.body_length")
  if (expectedBody !== undefined && expectedBody !== bodyLength) failures.push(`body_length: expected ${expectedBody}, got ${bodyLength}`)
  const terminal = header.bytesOf("terminal")
  const expectedTerminal = expect.hex("expect.terminal")
  if (expectedTerminal && !bytesEqual(expectedTerminal, terminal))
    failures.push(`terminal: expected ${hexText(expectedTerminal)}, got ${hexText(terminal)}`)
  const nameLength = expect.int("expect.terminal.length")
  if (nameLength !== undefined && nameLength !== header.terminalName.length)
    failures.push(`terminal.length: expected ${nameLength}, got ${header.terminalName.length}`)
  const actualTemplate = header.matchesTemplate ? "yes" : "no"
  const expectedTemplate = expect.string("expect.template")
  if (expectedTemplate !== undefined && expectedTemplate !== actualTemplate)
    failures.push(
      `template: expected ${expectedTemplate}, got ${actualTemplate} (non-template fields: ${header.nonTemplateFields.map(dpHeaderFieldName).join(", ")})`
    )
  if (!bytesEqual(header.bytes, prefix)) failures.push("round trip: re-serialising the parsed header gives different bytes")
  // Round trip: for a template vector, the encoder given the name and the body length reproduces
  // the first 200 bytes, and the payload helper the whole input.
  if (expectedTemplate !== "yes" || !expectedTerminal || nameLength === undefined || nameLength > expectedTerminal.length) return
  const name = DPTerminalName.normalizing(expectedTerminal.subarray(0, nameLength))
  const encoded = DPHeader.firstMessage(name, bodyLength)
  if (!bytesEqual(encoded.bytes, prefix)) failures.push(`round trip: the first-message encoder gives ${hexText(encoded.bytes)}`)
  const payload = DPHeader.firstMessagePayload(name, input.subarray(DPHeader.size))
  if (!bytesEqual(payload, input)) failures.push("round trip: the first-message payload helper does not reproduce the input")
}

registerKind("ni-stream", runNIStream)
registerKind("ni-payload", runNIPayload)
registerKind("dp-header", runDPHeader)
