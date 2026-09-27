// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/CodecVectorRunners.swift and the codec parts of
// VectorRunner.swift (`VectorNames`) (MIT): the DiagCodec kinds of protocol spec v1,
// diag-header, diag-error-body, compression-header, items, simple-item-fields, connect,
// support-bits and dialog-step. `decompress` lives in decompressRunners.ts.

import {
  ApplItem,
  ComFlag,
  CompressField,
  CompressionHeader,
  CompressionHeaderDecodingError,
  CompressionHeaderEncodingError,
  CompressionHeaderError,
  DiagErrorBody,
  DiagErrorBodyError,
  DiagHeader,
  DiagHeaderError,
  DiagItemType,
  DiagItemWalkError,
  DiagItemWalker,
  DialogStepNumber,
  ItemPayloadError,
  SESValue,
  SimpleItemValue,
  SupportBit,
  SupportBits,
  UserConnect,
  type CompressionAlgorithm,
  type CompressionHeaderDecodingErrorInfo,
  type CompressionHeaderErrorInfo,
  type DiagBodyClass,
  type DiagErrorBodyErrorInfo,
  type DiagHeaderErrorInfo,
  type DiagItem,
  type DiagItemWalkErrorInfo,
  type ItemPayloadErrorInfo
} from "../../diag/codec/index.js"
import { ByteWriter, bytesEqual, hexByte, hexText } from "../../diag/wire/index.js"
import type { Expectations } from "./expectations.js"
import { registerKind } from "./registry.js"
import type { VectorFile } from "./vectorFile.js"
import { NO_ERROR } from "./wireRunners.js"

// MARK: VectorNames: where the implementation's types meet the vector vocabulary (README, "Error classes")

/** Error classes of the diag-header kind. */
export function diagHeaderErrorClass(info: DiagHeaderErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return "truncated"
    case "unknownCompress":
      return "unknown-compress"
  }
}

/** Error classes of the structural compression-header parse. */
export function compressionHeaderErrorClass(info: CompressionHeaderErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return "truncated"
    case "badMagic":
      return "bad-magic"
    case "unknownAlgorithm":
      return "unknown-algorithm"
  }
}

/** Error classes of the compression-header kind. */
export function compressionHeaderDecodingErrorClass(info: CompressionHeaderDecodingErrorInfo): string {
  return info.kind === "badMaxbits" ? "bad-maxbits" : compressionHeaderErrorClass(info)
}

/** `lzh` or `lzc`. */
export const algorithmName = (algorithm: CompressionAlgorithm): string => algorithm

/** Error classes of the items kind. */
export function itemWalkErrorClass(info: DiagItemWalkErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return "truncated"
    case "unknownType":
      return "unknown-simple-type"
  }
}

/** Error classes of the diag-error-body kind. */
export function errorBodyErrorClass(info: DiagErrorBodyErrorInfo): string {
  switch (info.kind) {
    case "missingTerminator":
      return "missing-terminator"
  }
}

/**
 * Error classes of the value codecs (simple-item-fields, connect, support-bits, dialog-step, and
 * since v2 appl-fields, imode-uuids, dynt-focus and stringz-fields). `truncated` and, for the v2
 * kinds, `overlong` are vector classes (README, "Error classes"); the others are implementation
 * errors no vector expects, named so that a mismatch message says what happened.
 */
export function itemPayloadErrorClass(info: ItemPayloadErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return "truncated"
    case "overlong":
      return "overlong"
    case "notASimpleItem":
      return "not-a-simple-item (implementation)"
    case "specGap":
      return `spec-gap-${info.issue} (implementation)`
  }
}

/** `expect.body` of a diag-header vector. */
export function bodyName(bodyClass: DiagBodyClass): string {
  switch (bodyClass) {
    case "items":
      return "items"
    case "compressed":
      return "compressed"
    case "errorBody":
      return "error-text"
    case "compressedErrorBody":
      return "compressed-error-text"
    case "snc":
      return "snc"
  }
}

/** `expect.item.<n>.type` of an items vector. */
export function itemTypeName(type: DiagItemType): string {
  return type === "diagMessage" ? "diagmessage" : DiagItemType.name(type).toLowerCase()
}

/** A registry name as a vector token: spaces become underscores; no name is `unknown` (README, "Name tokens"). */
export function registryToken(name: string | undefined): string {
  return name === undefined ? "unknown" : name.split(" ").join("_")
}

// MARK: Keys a kind documents as optional or as inputs

/**
 * Keys a kind documents as optional (README, "Kinds"). Removing one leaves a valid vector, which may
 * still pass (for example `expect.block_mode: 1`, the value an absent key means).
 */
export function isOptionalKey(key: string, kind: string): boolean {
  switch (kind) {
    case "diag-header":
      return key === "expect.client_message"
    case "compression-header":
      return key === "expect.block_mode" || key === "expect.unused_bits"
    case "items":
      return key.startsWith("expect.item.") && (key.endsWith(".id_name") || key.endsWith(".sid_name"))
    default:
      if (kind.startsWith("adt-"))
        // README "ADT kinds": headers are listed per vector (unlisted ones are not constrained), and
        // response headers, a reason phrase and some arguments are optional inputs.
        return key.startsWith("expect.header.") || key.startsWith("expect.in.header.") || key === "expect.in.reason" || key.startsWith("expect.arg.")
      return false
  }
}

/**
 * Keys a kind documents as **inputs** (README, "Header"): passed to the code under test, never
 * compared. `expect.id` and `expect.sid` select the layout of an appl-fields or stringz-fields
 * vector.
 */
export function isInputKey(key: string, kind: string): boolean {
  switch (kind) {
    case "appl-fields":
    case "stringz-fields":
      return key === "expect.id" || key === "expect.sid"
    default:
      if (kind.startsWith("adt-")) return key.startsWith("expect.in.") || key.startsWith("expect.arg.") || key === "expect.op"
      return false
  }
}

// MARK: Shared checks

/**
 * Compares the error class and, on a mismatch, marks the remaining keys as read. Returns whether
 * the classes matched.
 */
export function checkError(actual: string, expect: Expectations, failures: string[]): boolean {
  const expected = expect.string("expect.error")
  if (expected === undefined) return false
  if (expected !== actual) {
    failures.push(`error: expected ${expected}, got ${actual}`)
    expect.consumeAll()
    return false
  }
  return true
}

/** Swift `compare(_:_:_:_:)`: records a mismatch when `expected` is present and differs. */
export function compare<T>(name: string, expected: T | undefined, actual: T, failures: string[]): void {
  if (expected === undefined) return
  const equal = Array.isArray(expected) ? JSON.stringify(expected) === JSON.stringify(actual) : expected === actual
  if (!equal) failures.push(`${name}: expected ${show(expected)}, got ${show(actual)}`)
}

const show = (value: unknown): string => (Array.isArray(value) ? JSON.stringify(value) : String(value))

/** Runs `body` and returns the `info` of an error of `errorClass`, rethrowing any other error. */
function caught<Info>(body: () => void, errorClass: abstract new (...args: never[]) => Error & { readonly info: Info }): Info | undefined {
  try {
    body()
    return undefined
  } catch (error) {
    if (error instanceof errorClass) return (error as { info: Info }).info
    throw error
  }
}

// MARK: diag-header

/**
 * The DIAG header decoder, body classification and, for `expect.client_message`, the client header
 * patterns (README, "diag-header").
 */
function runDiagHeader(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let header: DiagHeader | undefined
  let bodyClass: DiagBodyClass | undefined
  let actualError = NO_ERROR
  const error = caught(() => {
    header = DiagHeader.parse(input)
    bodyClass = header.bodyClass()
  }, DiagHeaderError)
  if (error) actualError = diagHeaderErrorClass(error)
  if (!checkError(actualError, expect, failures) || !header || !bodyClass) return
  const fields: [string, number][] = [
    ["mode", header.mode],
    ["com_flag", header.comFlag],
    ["mode_stat", header.modeStat],
    ["err_no", header.errNo],
    ["msg_type", header.msgType],
    ["msg_info", header.msgInfo],
    ["msg_rc", header.msgRC],
    ["compress", CompressField.rawValue(header.compress)]
  ]
  for (const [name, value] of fields) {
    const expected = expect.byte(`expect.${name}`)
    if (expected !== undefined && expected !== value) failures.push(`${name}: expected ${hexByte(expected)}, got ${hexByte(value)}`)
  }
  compare("com_flag.names", expect.names("expect.com_flag.names"), ComFlag.names(header.comFlag), failures)
  compare("body", expect.string("expect.body"), bodyName(bodyClass), failures)
  if (!bytesEqual(header.bytes, input)) failures.push(`round trip: encoding the decoded fields gives ${hexText(header.bytes)}`)
  const role = expect.string("expect.client_message", false)
  if (role !== undefined) checkClientHeader(role, header.compress.kind === "compressed", input, failures)
}

/** The client header of `role`, from the header patterns. */
function checkClientHeader(role: string, compressed: boolean, input: Uint8Array, failures: string[]): void {
  let pattern: DiagHeader
  switch (role) {
    case "first":
      pattern = DiagHeader.clientFirstMessage
      break
    case "later":
      pattern = DiagHeader.clientLaterMessage(compressed)
      break
    case "close":
      pattern = DiagHeader.clientClose
      break
    default:
      failures.push(`client_message: unknown role '${role}'`)
      return
  }
  if (!bytesEqual(pattern.bytes, input)) failures.push(`client_message ${role}: the header pattern is ${hexText(pattern.bytes)}`)
  // Swift also checks the header `ClientMessageEncoder` writes (firstMessage, dialogMessage([]),
  // closeMessage): needs ClientMessages.swift (next wave).
}

// MARK: diag-error-body

/** The error-body splitter (README, "diag-error-body"). */
function runDiagErrorBody(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let body: DiagErrorBody | undefined
  let actualError = NO_ERROR
  const error = caught(() => {
    body = DiagErrorBody.split(input)
  }, DiagErrorBodyError)
  if (error) actualError = errorBodyErrorClass(error)
  if (!checkError(actualError, expect, failures) || !body) return
  compare("text.length", expect.int("expect.text.length"), body.textRange.count, failures)
  compare("items.offset", expect.int("expect.items.offset"), body.itemsRange.lowerBound, failures)
  compare("items.length", expect.int("expect.items.length"), body.itemsRange.count, failures)
  if (
    body.textRange.lowerBound !== 0 ||
    body.itemsRange.upperBound !== input.length ||
    body.itemsRange.lowerBound !== body.textRange.upperBound + 1
  )
    failures.push("the text, the terminator and the items do not tile the input")
}

// MARK: compression-header

const sameHeader = (a: CompressionHeader, b: CompressionHeader): boolean =>
  a.uncompressedLength === b.uncompressedLength && a.version === b.version && a.algorithm === b.algorithm && a.byte7 === b.byte7

/** The compression header decoder in the check order of IMPL-CH-4, and the encoder round trip (README, "compression-header"). */
function runCompressionHeader(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let header: CompressionHeader | undefined
  let actualError = NO_ERROR
  const error = caught(() => {
    header = CompressionHeader.decode(input)
  }, CompressionHeaderDecodingError)
  if (error) actualError = compressionHeaderDecodingErrorClass(error)
  // The structural parse agrees with the decoder except for bad-maxbits, which it does not check.
  let parsed: CompressionHeader | undefined
  caught(() => {
    parsed = CompressionHeader.parse(input)
  }, CompressionHeaderError)
  if ((parsed !== undefined) !== (header !== undefined || actualError === "bad-maxbits") || (header && parsed && !sameHeader(parsed, header)))
    failures.push("the structural parse and the decoder disagree")
  if (!checkError(actualError, expect, failures) || !header) return
  compare("uncompressed_length", expect.int("expect.uncompressed_length"), header.uncompressedLength, failures)
  compare("algorithm", expect.string("expect.algorithm"), algorithmName(header.algorithm), failures)
  compare("version", expect.int("expect.version"), header.version, failures)
  let encoded: Uint8Array | undefined
  const decoded = header
  switch (decoded.algorithm) {
    case "lzh":
      compare("level", expect.int("expect.level"), decoded.level ?? -1, failures)
      encoded = attemptEncode(() => CompressionHeader.lzh(decoded.uncompressedLength, { level: decoded.byte7, version: decoded.version }).bytes)
      break
    case "lzc": {
      const maxbits = decoded.maxbits ?? 0
      const blockMode = decoded.blockMode ?? false
      const unusedBits = decoded.unusedBits ?? 0
      compare("maxbits", expect.int("expect.maxbits"), maxbits, failures)
      compare("block_mode", expect.int("expect.block_mode", false) ?? 1, blockMode ? 1 : 0, failures)
      const expectedUnused = expect.has("expect.unused_bits") ? expect.byte("expect.unused_bits") : 0
      if (expectedUnused !== undefined && expectedUnused !== unusedBits)
        failures.push(`unused_bits: expected ${hexByte(expectedUnused)}, got ${hexByte(unusedBits)}`)
      encoded = attemptEncode(
        () => CompressionHeader.lzc(decoded.uncompressedLength, maxbits, { blockMode, unusedBits, version: decoded.version }).bytes
      )
      break
    }
  }
  if (!encoded || !bytesEqual(encoded, input))
    failures.push(`round trip: encoding the decoded values gives ${encoded ? hexText(encoded) : "an encoder error"}`)
  if (!bytesEqual(decoded.bytes, input)) failures.push(`round trip: re-serialising the decoded header gives ${hexText(decoded.bytes)}`)
}

/** Swift `try?` on a compression header encoder. */
function attemptEncode(encode: () => Uint8Array): Uint8Array | undefined {
  try {
    return encode()
  } catch (error) {
    if (error instanceof CompressionHeaderEncodingError) return undefined
    throw error
  }
}

// MARK: items

/** The item walker (README, "items"). Items produced before an error count. */
function runItems(input: Uint8Array, expect: Expectations, failures: string[]): void {
  const walker = new DiagItemWalker()
  const items: DiagItem[] = []
  let walkError: DiagItemWalkError | undefined
  try {
    for (let item = walker.next(input); item !== undefined; item = walker.next(input)) items.push(item)
  } catch (error) {
    if (!(error instanceof DiagItemWalkError)) throw error
    walkError = error
  }
  compare("error", expect.string("expect.error"), walkError ? itemWalkErrorClass(walkError.info) : NO_ERROR, failures)
  if (walkError) {
    compare("error.item", expect.int("expect.error.item"), walkError.itemIndex, failures)
    if (walkError.info.kind === "unknownType") {
      const expected = expect.byte("expect.error.type")
      if (expected !== undefined && expected !== walkError.info.typeByte)
        failures.push(`error.type: expected ${hexByte(expected)}, got ${hexByte(walkError.info.typeByte)}`)
    }
  }
  const count = expect.int("expect.items")
  if (count === undefined) return
  compare("items", count, items.length, failures)
  for (let number = 1; number <= count; number++) checkItem(number, number <= items.length ? items[number - 1] : undefined, expect, failures)
}

function checkItem(number: number, item: DiagItem | undefined, expect: Expectations, failures: string[]): void {
  const prefix = `expect.item.${number}.`
  const type = expect.string(prefix + "type")
  const offset = expect.int(prefix + "offset")
  const length = expect.int(prefix + "length")
  if (!item) return
  compare(`item ${number} type`, type, itemTypeName(item.type), failures)
  compare(`item ${number} offset`, offset, item.valueOffset, failures)
  compare(`item ${number} length`, length, item.valueLength, failures)
  const appl = item.appl
  if (!appl) return
  compare(`item ${number} id`, expect.byte(prefix + "id"), ApplItem.id(appl), failures)
  compare(`item ${number} sid`, expect.byte(prefix + "sid"), ApplItem.sid(appl), failures)
  compare(`item ${number} id_name`, expect.string(prefix + "id_name", false), registryToken(ApplItem.idName(appl)), failures)
  compare(`item ${number} sid_name`, expect.string(prefix + "sid_name", false), registryToken(ApplItem.sidName(appl)), failures)
}

// MARK: simple-item-fields

/** The simple-item value decoders (README, "simple-item-fields"). */
function runSimpleItemFields(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let value: SimpleItemValue | undefined
  let actualError = NO_ERROR
  const error = caught(() => {
    value = SimpleItemValue.decodeItem(input)
  }, ItemPayloadError)
  if (error) actualError = itemPayloadErrorClass(error)
  if (!checkError(actualError, expect, failures) || !value) return
  compare("type", expect.string("expect.type"), itemTypeName(SimpleItemValue.type(value)), failures)
  let fields: [string, number][]
  switch (value.kind) {
    case "ses": {
      const ses = value.value
      fields = [
        ["event_array", ses.eventArray],
        ["event_id_1", ses.eventID1],
        ["event_id_2", ses.eventID2],
        ["event_id_3", ses.eventID3],
        ["event_id_4", ses.eventID4],
        ["event_id_5", ses.eventID5],
        ["screen_flag", ses.screenFlag],
        ["modal_number", ses.modalNumber],
        ["x_pos", ses.xPos],
        ["y_pos", ses.yPos],
        ["imode", ses.imode],
        ["flag_1", ses.flag1],
        ["dim_row", ses.dimRow],
        ["dim_col", ses.dimCol]
      ]
      break
    }
    case "sfe":
      fields = [
        ["format", value.value.format],
        ["color", value.value.color],
        ["extended", value.value.extended]
      ]
      break
    case "sba":
      fields = [
        ["y", value.value.y],
        ["x", value.value.x]
      ]
      break
    case "slc":
      fields = [["field_length", value.value.fieldLength]]
      break
    case "eom":
      fields = []
      break
  }
  for (const [name, actual] of fields) compare(`field.${name}`, expect.int(`expect.field.${name}`), actual, failures)
  // Round trip; an SES encoder writes the filler as 00 00 (R-IT-12), so compare with it zeroed.
  const expected = input.slice()
  if (SimpleItemValue.type(value) === "ses" && expected.length === 1 + SESValue.size) {
    expected[13] = 0 // not-protocol: SES filler, value bytes 12-13 after the type byte
    expected[14] = 0 // not-protocol: SES filler
  }
  const output = new ByteWriter()
  SimpleItemValue.appendItem(value, output)
  const encoded = output.toBytes()
  if (!bytesEqual(encoded, expected)) failures.push(`round trip: encoding the fields gives ${hexText(encoded)}`)
}

// MARK: connect, support-bits, dialog-step

/** The CONNECT decoder (README, "connect"). */
function runConnect(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let connect: UserConnect | undefined
  let actualError = NO_ERROR
  const error = caught(() => {
    connect = UserConnect.decode(input)
  }, ItemPayloadError)
  if (error) actualError = itemPayloadErrorClass(error)
  if (!checkError(actualError, expect, failures) || !connect) return
  compare("protocol_version", expect.int("expect.protocol_version"), connect.protocolVersion, failures)
  compare("code_page", expect.int("expect.code_page"), connect.codePage, failures)
  compare("ws_type", expect.int("expect.ws_type"), connect.wsType, failures)
  if (!bytesEqual(connect.bytes, input)) failures.push(`round trip: encoding the fields gives ${hexText(connect.bytes)}`)
}

/** The SUPPORTDATA decoder (README, "support-bits"). */
function runSupportBits(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let bits: SupportBits | undefined
  let actualError = NO_ERROR
  const error = caught(() => {
    bits = SupportBits.decode(input)
  }, ItemPayloadError)
  if (error) actualError = itemPayloadErrorClass(error)
  if (!checkError(actualError, expect, failures) || !bits) return
  compare("length", expect.int("expect.length"), bits.bytes.length, failures)
  const named = bits.setNamedBits.map(bit => bit.name!)
  compare("set_bits", expect.names("expect.set_bits"), named, failures)
  if (!bytesEqual(bits.bytes, input)) failures.push("round trip: re-serialising the mask gives different bytes")
  // README: setting exactly the named bits reproduces the input when only named bits are set.
  const onlyNamed = bits.setBits.length === bits.setNamedBits.length
  if (onlyNamed && !bytesEqual(new SupportBits(named.map(name => SupportBit.fromName(name)!)).bytes, input))
    failures.push("round trip: setting exactly set_bits does not reproduce the input")
}

/** The DIALOG_STEP_NUMBER decoder (README, "dialog-step"). */
function runDialogStep(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let step: DialogStepNumber | undefined
  let actualError = NO_ERROR
  const error = caught(() => {
    step = DialogStepNumber.decode(input)
  }, ItemPayloadError)
  if (error) actualError = itemPayloadErrorClass(error)
  if (!checkError(actualError, expect, failures) || !step) return
  compare("step", expect.int("expect.step"), step.step, failures)
  if (!bytesEqual(step.bytes, input)) failures.push(`round trip: encoding the step gives ${hexText(step.bytes)}`)
}

type Runner = (input: Uint8Array, expect: Expectations, failures: string[], vector: VectorFile) => void

const RUNNERS: [string, Runner][] = [
  ["diag-header", runDiagHeader],
  ["diag-error-body", runDiagErrorBody],
  ["compression-header", runCompressionHeader],
  ["items", runItems],
  ["simple-item-fields", runSimpleItemFields],
  ["connect", runConnect],
  ["support-bits", runSupportBits],
  ["dialog-step", runDialogStep]
]

for (const [kind, runner] of RUNNERS) registerKind(kind, runner)
