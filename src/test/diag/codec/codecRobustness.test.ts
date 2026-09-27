// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/CodecRobustnessTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplID,
  ApplItem,
  ApplSID,
  CodepageDiagGUI,
  CompressionHeader,
  CompressionHeaderDecodingError,
  DiagErrorBody,
  DiagErrorBodyError,
  DiagHeader,
  DiagHeaderError,
  DiagItemType,
  DiagMessage,
  DiagMessageBody,
  DiagMessageDecodingError,
  DialogStepNumber,
  Decompressor,
  ItemPayloadError,
  KernelVersion,
  SimpleItemValue,
  SupportBits,
  SystemInfoNumber,
  SystemInfoText,
  UserConnect,
  type ApplSIDStSystemInfo,
  type DiagBodyClass
} from "../../../diag/codec/index.js"
import { CompressedDataError, LZHEncoder, LZHEncodingError } from "../../../diag/compression/index.js"
import { NIFrameEncoder, bytesEqual, classifyNIPayload, receiveAction } from "../../../diag/wire/index.js"
import { compressionHeaderDecodingErrorClass, itemWalkErrorClass } from "../../vectors/codecRunners.js"
import { decodeStream } from "../../vectors/wireRunners.js"
import { appl, appl4, ascii, attempt, bytes, cat, walkItems, xmlblob } from "../../support/codecTestSupport.js"
import { SeededGenerator } from "../../support/seededGenerator.js"

/**
 * Deterministic robustness runs (docs/testing.md §3: size caps and checked arithmetic): random and
 * mutated inputs through every DiagCodec decoder, checked against independent models written from
 * the spec text. Nothing may throw anything but the codecs' own errors, and the invariants must
 * hold for every input. Fixed seeds make every failure reproducible.
 */
const inputCount = 60_000

// MARK: Generators

/** Simple types of known size (items.md, Item types), in type-byte order. */
const simpleSizes = new Map<number, number>([
  [0x01, 16],
  [0x02, 20],
  [0x03, 3],
  [0x07, 76],
  [0x09, 22],
  [0x0a, 3],
  [0x0b, 2],
  [0x0c, 0],
  [0x13, 2],
  [0x15, 36]
])
const simpleTypes = [...simpleSizes.keys()].sort((a, b) => a - b)

/**
 * One plausible item of any kind, sometimes an OKC or an unknown type, sometimes a session item
 * whose value starts out valid.
 */
function plausibleItem(generator: SeededGenerator): Uint8Array {
  const value = generator.bytes(generator.int(0, 24))
  const choice = generator.intBelow(0, 14)
  if (choice === 12 || choice === 13) return plausibleSessionItem(generator)
  if (choice < 4) {
    const type = simpleTypes[generator.intBelow(0, simpleTypes.length)]
    return cat([type], generator.bytes(simpleSizes.get(type)!))
  }
  if (choice < 7) return appl(randomID(generator), generator.uint8(0, 0x2b), value)
  if (choice < 9) return appl4(randomID(generator), generator.uint8(0, 0x2b), value)
  if (choice < 11) return xmlblob(value)
  return bytes([0x08, 0x04, 0x00, 0x14, 0xff][generator.intBelow(0, 5)])
}

function randomID(generator: SeededGenerator): number {
  return generator.bool() ? ApplID.rawValue(ApplID.allCases[generator.intBelow(0, ApplID.allCases.length)]) : generator.uint8()
}

/** The session items whose value layouts session.md states, one case per decoder. */
type SessionValue = "connect" | "supportData" | "step" | "systemInfoNumber" | "systemInfoText" | "codepage" | "kernel"
const sessionValues: readonly SessionValue[] = ["connect", "supportData", "step", "systemInfoNumber", "systemInfoText", "codepage", "kernel"]

/** 0 to `upper` random bytes, none of them zero: the body of a zero-terminated string. */
function nonzeroBytes(lower: number, upper: number, generator: SeededGenerator): number[] {
  const count = generator.int(lower, upper)
  const output: number[] = []
  for (let index = 0; index < count; index++) output.push(generator.uint8(1, 0xff))
  return output
}

/**
 * A well-formed value of `kind` and its (id, sid), written byte by byte from session.md, not with
 * the codecs' encoders.
 */
function validSessionValue(kind: SessionValue, generator: SeededGenerator): { id: number; sid: number; value: number[] } {
  const user = ApplID.rawValue("stUser")
  const systemInfo = ApplID.rawValue("stSystemInfo")
  const pick = (sids: ApplSIDStSystemInfo[]) => ApplSID.StSystemInfo.rawValue(sids[generator.intBelow(0, sids.length)])
  switch (kind) {
    case "connect":
      // §3: three u32 BE, 12 bytes.
      return { id: user, sid: ApplSID.StUser.rawValue("connect"), value: generator.bytes(12) }
    case "supportData": {
      // §5, §5.1: 32 bytes, sent by the client (0x04/0x0B) or the server (0x06/0x11).
      const client = generator.bool()
      const sid = client ? ApplSID.StUser.rawValue("supportData") : ApplSID.StSystemInfo.rawValue("supportData")
      return { id: client ? user : systemInfo, sid, value: generator.bytes(32) }
    }
    case "step":
      // §4.1: one u32 BE.
      return { id: user, sid: ApplSID.StUser.rawValue("dialogStepNumber"), value: generator.bytes(4) }
    case "systemInfoNumber": {
      // §6: MODENUMBER, DIAGVERSION and IMODENUMBER are one u16 BE each.
      const sid = pick(["modeNumber", "diagVersion", "imodeNumber"])
      return { id: systemInfo, sid, value: generator.bytes(2) }
    }
    case "systemInfoText": {
      // §6: the whole value is text; R-SE-6: a reader strips trailing zero bytes.
      const zeros = new Array<number>(generator.int(0, 3)).fill(0)
      const sid = pick(["dbName", "cpuName", "tcode", "message", "client", "codepageAppServer"])
      return { id: systemInfo, sid, value: [...nonzeroBytes(0, 12, generator), ...zeros] }
    }
    case "codepage": {
      // §6.1, R-SE-8: u32 BE code page, u8, then two zero-terminated strings; bytes after them are
      // reported, not interpreted.
      const fixed = generator.bytes(5)
      const number = [...nonzeroBytes(0, 5, generator), 0]
      const description = [...nonzeroBytes(0, 16, generator), 0]
      const trailing = generator.bytes(generator.int(0, 2))
      return { id: systemInfo, sid: ApplSID.StSystemInfo.rawValue("codepageDiagGUI"), value: [...fixed, ...number, ...description, ...trailing] }
    }
    case "kernel": {
      // §6.2: three zero-terminated strings.
      const strings: number[] = []
      for (let index = 0; index < 3; index++) strings.push(...nonzeroBytes(0, 8, generator), 0)
      const trailing = generator.bytes(generator.int(0, 2))
      return { id: systemInfo, sid: ApplSID.StSystemInfo.rawValue("kernelVersion"), value: [...strings, ...trailing] }
    }
  }
}

/**
 * A session item as APPL or APPL4 (IMPL-IT-9: dispatch is on (id, sid) alone). Its value starts out
 * valid and is mutated one time in three (flips, insertions, deletions, truncation), so the
 * decoders see both values they must accept and values next to them.
 */
function plausibleSessionItem(generator: SeededGenerator): Uint8Array {
  const kind = sessionValues[generator.intBelow(0, sessionValues.length)]
  const valid = validSessionValue(kind, generator)
  let value = valid.value
  if (generator.intBelow(0, 3) === 0) value = generator.mutate(value)
  return generator.bool() ? appl(valid.id, valid.sid, value) : appl4(valid.id, valid.sid, value)
}

function plausibleItems(generator: SeededGenerator): Uint8Array {
  const count = generator.int(0, 6)
  const items: Uint8Array[] = []
  for (let index = 0; index < count; index++) items.push(plausibleItem(generator))
  return cat(...items)
}

function input(iteration: number, generator: SeededGenerator, plausible: (generator: SeededGenerator) => Uint8Array): Uint8Array {
  switch (iteration % 3) {
    case 0:
      return Uint8Array.from(generator.bytes(generator.int(0, 40)))
    case 1:
      return Uint8Array.from(generator.mutate(plausible(generator)))
    default:
      return plausible(generator)
  }
}

// MARK: Independent models

/**
 * The walk of items.md, "Walking an item sequence", written separately from DiagItemWalker: the
 * number of complete items, the offset where the walk ended, and the stop class.
 */
function modelWalk(sequence: Uint8Array): { count: number; offset: number; stop: string } {
  let offset = 0
  let count = 0
  const u = (at: number, width: number) => {
    let value = 0
    for (let index = 0; index < width; index++) value = value * 256 + sequence[at + index]
    return value
  }
  while (offset < sequence.length) {
    const type = sequence[offset]
    let header: number
    let length: number
    const left = sequence.length - offset
    if (type === 0x10 || type === 0x12) {
      header = type === 0x10 ? 5 : 7
      if (left < header) return { count, offset, stop: "truncated" }
      length = u(offset + 3, header - 3)
    } else if (type === 0x11) {
      header = 5
      if (left < header) return { count, offset, stop: "truncated" }
      length = u(offset + 1, 4)
    } else {
      const size = simpleSizes.get(type)
      if (size === undefined) return { count, offset, stop: "unknown-simple-type" }
      header = 1
      length = size
    }
    if (left - header < length) return { count, offset, stop: "truncated" }
    offset += header + length
    count += 1
  }
  return { count, offset, stop: "none" }
}

/** An unsigned big-endian number: session.md gives every number in network order (§3, §4.1, §6, §6.1). */
function bigEndian(input: ArrayLike<number>): number {
  let value = 0
  for (let index = 0; index < input.length; index++) value = value * 256 + input[index]
  return value
}

/**
 * `count` zero-terminated strings from `start` (§6.1, §6.2): each string's range without its zero
 * byte, and the number of bytes after the last zero; undefined when a zero is missing.
 */
function zeroTerminatedStrings(raw: Uint8Array, start: number, count: number): { ranges: [number, number][]; trailing: number } | undefined {
  const ranges: [number, number][] = []
  let index = start
  for (let string = 0; string < count; string++) {
    if (index > raw.length) return undefined
    const zero = raw.indexOf(0, index)
    if (zero < 0) return undefined
    ranges.push([index, zero])
    index = zero + 1
  }
  return { ranges, trailing: raw.length - index }
}

/**
 * Session values seen and decoded, per decoder, so a run can show that it reached both the
 * accepting and the rejecting side of every decoder.
 */
class SessionTally {
  readonly seen = new Map<SessionValue, number>()
  readonly decoded = new Map<SessionValue, number>()

  record(kind: SessionValue, success: boolean): void {
    this.seen.set(kind, (this.seen.get(kind) ?? 0) + 1)
    if (success) this.decoded.set(kind, (this.decoded.get(kind) ?? 0) + 1)
  }

  get summary(): string {
    return sessionValues.map(kind => `${kind} ${this.decoded.get(kind) ?? 0}/${this.seen.get(kind) ?? 0}`).join(", ")
  }

  /**
   * Every decoder decoded at least `floor` values and at least `share` of the values it saw, and
   * rejected at least `rejectedFloor`. ST_R3INFO text never fails; for it, "decoded" means that
   * trailing zero bytes were stripped, and a value without them counts as rejected.
   */
  expectReached(floor: number, share: number, rejectedFloor: number): void {
    for (const kind of sessionValues) {
      const seen = this.seen.get(kind) ?? 0
      const decoded = this.decoded.get(kind) ?? 0
      assert.ok(decoded >= floor, `${kind}: ${decoded} decoded, want ${floor} (${this.summary})`)
      assert.ok(decoded >= share * seen, `${kind}: ${decoded} of ${seen} decoded, want ${share} (${this.summary})`)
      assert.ok(seen - decoded >= rejectedFloor, `${kind}: ${seen - decoded} rejected, want ${rejectedFloor} (${this.summary})`)
    }
  }
}

/** "ABABABA" as LZC codes 0x041, 0x042, 0x101, 0x103 (CompressionHeaderTests' `DecompressorTests.lzcData`). */
const lzcData = [0x41, 0x84, 0x04, 0x1c, 0x08]

/**
 * A plausible message payload: a DIAG header, then items, an error body, a compression header with
 * real LZH or LZC data, or an SNC frame.
 */
function plausibleMessage(generator: SeededGenerator): Uint8Array {
  const errNo = generator.bool() ? 0 : generator.uint8(1, 0xff)
  const compress = [0, 0, 1, 1, 2, 3, 4][generator.intBelow(0, 7)]
  const mode = generator.uint8(0, 3)
  const comFlag = generator.uint8()
  const header = [mode, comFlag, 0, errNo, 0, 0, 0, compress]
  let body = plausibleItems(generator)
  if (errNo !== 0) body = cat(ascii("ZZ oops"), [0x0c], body)
  if (compress !== 1) return cat(header, body)
  if (body.length === 0 || generator.intBelow(0, 3) === 0) {
    // LZC "ABABABA", or a header with a random byte 7.
    const byte7 = generator.bool() ? 0x90 : generator.uint8()
    return cat(header, [7, 0, 0, 0, 0x11, 0x1f, 0x9d, byte7], lzcData)
  }
  const data = attempt(() => new LZHEncoder().encode(body), LZHEncodingError) ?? new Uint8Array(0)
  return cat(header, CompressionHeader.clientLZH(body.length).bytes, data)
}

/**
 * Walks items and decodes every value whose layout session.md states, checked against models
 * written from it: a fixed-size value decodes exactly when it has the stated size, into the
 * big-endian numbers or bits the model reads, and encodes back to the same bytes; a
 * zero-terminated layout decodes exactly when the model finds its zero bytes, into the model's
 * ranges. `tally` counts values seen and decoded per decoder.
 */
function decodePayloads(body: Uint8Array, tally: SessionTally): void {
  for (const item of walkItems(body).items) {
    const value = item.valueRange.of(body)
    const raw = value.slice()
    const appl = item.appl
    if (appl === undefined) continue
    if (appl.kind === "stUser" && appl.sid === "connect") {
      // §3: 12 bytes, protocol_version, code_page, ws_type.
      const connect = attempt(() => UserConnect.decode(value), ItemPayloadError)
      tally.record("connect", connect !== undefined)
      assert.equal(connect !== undefined, raw.length === 12, `CONNECT decodes exactly 12 bytes, not ${raw.length}`)
      if (connect && raw.length === 12) {
        assert.deepEqual(
          [connect.protocolVersion, connect.codePage, connect.wsType],
          [bigEndian(raw.subarray(0, 4)), bigEndian(raw.subarray(4, 8)), bigEndian(raw.subarray(8, 12))]
        )
        assert.deepEqual(connect.bytes, raw)
      }
    } else if ((appl.kind === "stUser" || appl.kind === "stSystemInfo") && appl.sid === "supportData") {
      // §5.1: 32 bytes; bit N is byte N / 8, mask 1 << (N mod 8).
      const bits = attempt(() => SupportBits.decode(value), ItemPayloadError)
      tally.record("supportData", bits !== undefined)
      assert.equal(bits !== undefined, raw.length === 32, `SUPPORTDATA decodes exactly 32 bytes, not ${raw.length}`)
      if (bits && raw.length === 32) {
        const expected: number[] = []
        for (let number = 0; number < 256; number++) if (((raw[Math.floor(number / 8)] >> number % 8) & 1) === 1) expected.push(number)
        assert.deepEqual(
          bits.setBits.map(bit => bit.number),
          expected
        )
        assert.deepEqual(bits.bytes, raw)
      }
    } else if (appl.kind === "stUser" && appl.sid === "dialogStepNumber") {
      // §4.1: one u32 BE.
      const step = attempt(() => DialogStepNumber.decode(value), ItemPayloadError)
      tally.record("step", step !== undefined)
      assert.equal(step?.step, raw.length === 4 ? bigEndian(raw) : undefined)
      if (raw.length === 4) assert.deepEqual(step?.bytes, raw)
      else assert.equal(step, undefined)
    } else if (appl.kind === "stSystemInfo" && SystemInfoNumber.isNumber(appl.sid)) {
      // §6: one u16 BE.
      const number = attempt(() => SystemInfoNumber.decode(value), ItemPayloadError)
      tally.record("systemInfoNumber", number !== undefined)
      assert.equal(number, raw.length === 2 ? bigEndian(raw) : undefined)
    } else if (appl.kind === "stSystemInfo" && SystemInfoText.isText(appl.sid)) {
      // §6, R-SE-6: the text is the whole value but its trailing zero bytes.
      let end = raw.length
      while (end > 0 && raw[end - 1] === 0) end -= 1
      tally.record("systemInfoText", end < raw.length)
      const range = SystemInfoText.textRange(value)
      assert.ok(range.lowerBound === 0 && range.upperBound === end)
    } else if (appl.kind === "stSystemInfo" && appl.sid === "codepageDiagGUI") {
      // §6.1, R-SE-8: u32 BE at 0, u8 at 4, then two zero-terminated strings.
      const model = raw.length < 5 ? undefined : zeroTerminatedStrings(raw, 5, 2)
      const codepage = attempt(() => CodepageDiagGUI.decode(value), ItemPayloadError)
      tally.record("codepage", codepage !== undefined)
      assert.equal(codepage !== undefined, model !== undefined, "CODEPAGE_DIAG_GUI decodes exactly when both strings end")
      if (codepage && model) {
        assert.ok(codepage.codePage === bigEndian(raw.subarray(0, 4)) && codepage.minBytesPerCharacter === raw[4])
        assert.deepEqual(
          [codepage.numberText, codepage.description].map(range => [range.lowerBound, range.upperBound]),
          model.ranges
        )
        assert.equal(codepage.trailingByteCount, model.trailing)
      }
    } else if (appl.kind === "stSystemInfo" && appl.sid === "kernelVersion") {
      // §6.2: three zero-terminated strings.
      const model = zeroTerminatedStrings(raw, 0, 3)
      const version = attempt(() => KernelVersion.decode(value), ItemPayloadError)
      tally.record("kernel", version !== undefined)
      assert.equal(version !== undefined, model !== undefined, "KERNEL_VERSION decodes exactly when its three strings end")
      if (version && model) {
        assert.deepEqual(
          [version.databaseVersion, version.kernelVersion, version.patchLevel].map(range => [range.lowerBound, range.upperBound]),
          model.ranges
        )
        assert.equal(version.trailingByteCount, model.trailing)
      }
    }
  }
}

describe("Codec robustness", () => {
  test("itemWalkerAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5eed0b03)
    const outcomes = new Map<string, number>()
    const types = new Set<DiagItemType>()
    for (let iteration = 0; iteration < inputCount; iteration++) {
      const sequence = input(iteration, generator, plausibleItems)
      const { items, error } = walkItems(sequence)
      const model = modelWalk(sequence)
      const stop = error ? itemWalkErrorClass(error.info) : "none"
      assert.ok(items.length === model.count && stop === model.stop, "walker and model disagree")
      // Items tile the sequence from the start, in order, inside the input.
      let offset = 0
      items.forEach((item, index) => {
        assert.ok(item.index === index + 1 && item.offset === offset && sequence[offset] === DiagItemType.rawValue(item.type))
        assert.ok(item.valueOffset > offset && item.endOffset <= sequence.length)
        if (item.appl) {
          assert.ok(ApplItem.id(item.appl) === sequence[offset + 1] && ApplItem.sid(item.appl) === sequence[offset + 2])
          assert.ok(ApplItem.equals(item.appl, ApplItem.of(ApplItem.id(item.appl), ApplItem.sid(item.appl))))
        } else {
          assert.ok(!DiagItemType.carriesApplItem(item.type))
        }
        const size = DiagItemType.simpleValueSize(item.type)
        if (size !== undefined) {
          assert.equal(item.valueLength, size)
          if (!["eom", "ico", "tit", "diagMessage", "chl", "sba2"].includes(item.type)) {
            const value = attempt(() => SimpleItemValue.decode(item.type, item.valueRange.of(sequence)), ItemPayloadError)
            assert.equal(value && SimpleItemValue.type(value), item.type)
          }
        }
        types.add(item.type)
        offset = item.endOffset
      })
      assert.equal(offset, model.offset)
      if (error) assert.ok(error.itemIndex === items.length + 1 && error.itemOffset === offset && offset < sequence.length)
      else assert.equal(offset, sequence.length)
      outcomes.set(stop, (outcomes.get(stop) ?? 0) + 1)
    }
    for (const outcome of ["none", "truncated", "unknown-simple-type"])
      assert.ok((outcomes.get(outcome) ?? 0) > 1000, `${outcome} was exercised ${outcomes.get(outcome) ?? 0} times`)
    assert.deepEqual([...types].sort(), DiagItemType.allCases.filter(type => type !== "okc").sort(), "every walkable type occurred")
  })

  /**
   * The whole receive path of one message: layout, decompression, error-body split, item walk and
   * the payload decoders of the items the spec specifies.
   */
  test("messagePipeline", () => {
    const generator = new SeededGenerator(0x5eed0b04)
    const decompressor = new Decompressor(1 << 16)
    const classes = new Map<string, number>()
    const count = (name: string) => classes.set(name, (classes.get(name) ?? 0) + 1)
    const tally = new SessionTally()
    for (let iteration = 0; iteration < inputCount; iteration++) {
      const payload = input(iteration, generator, plausibleMessage)
      let message: DiagMessage
      try {
        message = DiagMessage.parse(payload)
      } catch (error) {
        if (!(error instanceof DiagMessageDecodingError)) throw error
        count("error")
        const info = error.info
        if (info.kind === "header" && info.error.kind === "truncated")
          assert.ok(info.error.availableByteCount === payload.length && info.error.availableByteCount < 8)
        else if (info.kind === "header" && info.error.kind === "unknownCompress") assert.ok(info.error.value >= 4 && payload[7] === info.error.value)
        else assert.ok(payload.length >= 8 && payload[7] === 1)
        continue
      }
      assert.deepEqual(message.header.bytes, payload.subarray(0, 8))
      const range = DiagMessageBody.range(message.body)
      assert.ok(range.lowerBound === 8 && range.upperBound === payload.length)
      const bodyClass: DiagBodyClass = DiagMessageBody.bodyClass(message.body)
      count(bodyClass)
      let body: Uint8Array
      let isErrorBody = false
      switch (message.body.kind) {
        case "items":
          body = message.body.range.of(payload)
          break
        case "errorBody":
          body = message.body.range.of(payload)
          isErrorBody = true
          break
        case "snc":
          continue
        case "compressed": {
          const { header, data } = message.body
          assert.ok(data.lowerBound === 16 && data.upperBound === payload.length)
          try {
            body = decompressor.decompress(data.of(payload), header)
            assert.equal(body.length, header.uncompressedLength)
          } catch (error) {
            // The port's decompressor has no partial output to check: it throws or returns.
            if (!(error instanceof CompressedDataError)) throw error
            continue
          }
          isErrorBody = message.body.isErrorBody
          break
        }
      }
      if (isErrorBody) {
        const split = attempt(() => DiagErrorBody.split(body), DiagErrorBodyError)
        if (!split) {
          assert.ok(!body.includes(0x0c))
          continue
        }
        assert.ok(!split.textRange.of(body).includes(0x0c) && body[split.textRange.upperBound] === 0x0c)
        body = split.itemsRange.of(body)
      }
      decodePayloads(body, tally)
    }
    for (const name of ["items", "compressed", "errorBody", "compressedErrorBody", "snc", "error"])
      assert.ok((classes.get(name) ?? 0) > 500, `${name} was exercised ${classes.get(name) ?? 0} times`)
    tally.expectReached(100, 0.4, 10)
  })

  /**
   * Session items alone, each value valid or mutated from a valid one, through the walker and every
   * session value decoder. Most values decode, so the models' checks run on many of them.
   */
  test("sessionValuesAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5eed0b08)
    const tally = new SessionTally()
    for (let index = 0; index < inputCount / 3; index++) decodePayloads(plausibleSessionItem(generator), tally)
    tally.expectReached(1_000, 0.5, 100)
  })

  test("headerDecodersAgainstTheModel", () => {
    const generator = new SeededGenerator(0x5eed0b05)
    for (let iteration = 0; iteration < inputCount; iteration++) {
      const sequence = input(iteration, generator, g => {
        const first = g.uint8(0, 3)
        const algorithm = [0x11, 0x12, 0x10, 0x21, 0x13][g.intBelow(0, 5)]
        return bytes(first, 0, 0, 0, algorithm, 0x1f, 0x9d, g.uint8())
      })
      // DIAG header: a total split of the first 8 bytes, and a byte-exact round trip.
      const header = attempt(() => DiagHeader.parse(sequence), DiagHeaderError)
      if (header) {
        assert.ok(sequence.length >= 8 && bytesEqual(header.bytes, sequence.subarray(0, 8)))
        const [errNo, compress] = [sequence[3], sequence[7]]
        let expected: DiagBodyClass | undefined
        if (compress >= 4) expected = undefined
        else if (compress === 2 || compress === 3) expected = "snc"
        else if (errNo === 0) expected = compress === 0 ? "items" : "compressed"
        else expected = compress === 0 ? "errorBody" : "compressedErrorBody"
        assert.equal(
          attempt(() => header.bodyClass(), DiagHeaderError),
          expected
        )
      } else {
        assert.ok(sequence.length < 8)
      }
      // Compression header: the IMPL-CH-4 order, written out separately.
      let model: string
      if (sequence.length < 8) model = "truncated"
      else if (sequence[5] !== 0x1f || sequence[6] !== 0x9d) model = "bad-magic"
      else if (![1, 2].includes(sequence[4] & 0x0f)) model = "unknown-algorithm"
      else if ((sequence[4] & 0x0f) === 1 && !((sequence[7] & 0x1f) >= 9 && (sequence[7] & 0x1f) <= 16)) model = "bad-maxbits"
      else model = "none"
      try {
        const decoded = CompressionHeader.decode(sequence)
        assert.ok(model === "none" && bytesEqual(decoded.bytes, sequence.subarray(0, 8)))
        assert.equal(decoded.uncompressedLength, (sequence[0] | (sequence[1] << 8) | (sequence[2] << 16) | (sequence[3] << 24)) >>> 0)
      } catch (error) {
        if (!(error instanceof CompressionHeaderDecodingError)) throw error
        assert.equal(compressionHeaderDecodingErrorClass(error.info), model)
      }
    }
  })

  // clientEncoderRoundTrips: needs ClientMessages.swift (next wave)

  /** Whole streams: framer, classifier, message layout and walker on every frame. */
  test("endToEndStreams", () => {
    const generator = new SeededGenerator(0x5eed0b07)
    let frames = 0
    const tally = new SessionTally()
    for (let iteration = 0; iteration < inputCount / 4; iteration++) {
      const parts: Uint8Array[] = []
      const messages = generator.int(0, 3)
      for (let index = 0; index < messages; index++) parts.push(new NIFrameEncoder().encode(plausibleMessage(generator)))
      let stream = cat(...parts)
      if (iteration % 2 === 1) stream = Uint8Array.from(generator.mutate(stream))
      const result = decodeStream(stream, generator.cuts(stream.length), 4096)
      assert.equal(result.frames.reduce((sum, frame) => sum + frame.payload.length + 4, 0) + result.trailing, stream.length)
      for (const frame of result.frames) {
        frames += 1
        if (receiveAction(classifyNIPayload(frame.payload)).kind !== "deliver") continue
        const message = attempt(() => DiagMessage.parse(frame.payload), DiagMessageDecodingError)
        if (!message || message.body.kind !== "items") continue
        decodePayloads(message.body.range.of(frame.payload), tally)
      }
    }
    assert.ok(frames > 10_000, `${frames} frames`)
    tally.expectReached(25, 0.4, 5)
  })
})
