// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCompressionTests/LZHDynamicCodeTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  DynamicCodeWriter,
  DynamicHeader,
  LZHStreamWriter,
  SpecTables,
  decodeLZH,
  range,
  repeated,
  utf8,
  type LengthSymbol
} from "./testSupport.js"

/** A literal/length code for `ZZ!` plus end of block, and a two-symbol distance code. */
const literalLength = SpecTables.flatLengths([0x21, 0x5a, 256, 257], 258)
const distance = SpecTables.flatLengths([0, 1], 2)

/**
 * A final dynamic block with `header`, followed by `ZZ!`, a match (3, 1) and end of block written
 * with the valid codes above (reached only when the header is accepted).
 */
function block(header: DynamicHeader, noise = 0): Uint8Array {
  const writer = new LZHStreamWriter()
  writer.noise(noise)
  writer.blockHeader(true, 2)
  header.write(writer)
  const codes = new DynamicCodeWriter(literalLength, distance)
  for (const symbol of [0x5a, 0x5a, 0x21]) codes.symbol(symbol, writer)
  codes.match(3, 1, writer)
  codes.symbol(256, writer)
  return writer.data
}

const expected = utf8("ZZ!!!!")

const literalSymbols = (lengths: readonly number[]): LengthSymbol[] => lengths.map((length): LengthSymbol => [length, 0])

/** Dynamic code headers (compression-lzh.md, "Dynamic code header" and "Code set validity"). */
describe("LZH dynamic codes", () => {
  test("validHeaderDecodes", () => {
    const data = block(DynamicHeader.forLengths(literalLength, distance))
    assert.deepEqual(decodeLZH(data, 6).bytes, expected)
  })

  test("runSymbolsExpandWithinEachSequence", () => {
    // literalLength: 2 bits for 0x21 (33), 0x5A (90), 256 and 257; 0 elsewhere. Sent with 18
    // runs: 33 zeros, 2, 56 zeros, 2, 138 + 27 zeros, 2, 2; then the distance lengths 1, 1
    // (PV-0369).
    const symbols: LengthSymbol[] = [
      [18, 33 - 11], [2, 0], [18, 56 - 11], [2, 0], [18, 138 - 11], [18, 27 - 11], [2, 0], [2, 0], [1, 0], [1, 0]
    ]
    const header = DynamicHeader.raw({ hlit: 1, hdist: 1, symbols })
    assert.deepEqual(decodeLZH(block(header), 6).bytes, expected)

    // 16 after zeros from 17 repeats a zero (PV-0370).
    const repeatedBytes = repeated(0x41, 3)
    const writer = new LZHStreamWriter()
    writer.noise(0)
    writer.blockHeader(true, 2)
    // Literal/length lengths: 0 x 65 (0x00–0x40), 1 for 0x41, 0 x 3 (17), 0 x 3 (16 repeats 0),
    // 0 x 184 (18 + 18), 1 for 256: 65 + 1 + 3 + 3 + 184 + 1 = 257.
    const lengthSymbols: LengthSymbol[] = [[18, 65 - 11], [1, 0], [17, 0], [16, 0], [18, 138 - 11], [18, 46 - 11], [1, 0]]
    lengthSymbols.push([1, 0], [1, 0])
    DynamicHeader.raw({ hlit: 0, hdist: 1, symbols: lengthSymbols }).write(writer)
    const codes = new DynamicCodeWriter([...new Array<number>(65).fill(0), 1, ...new Array<number>(190).fill(0), 1], [1, 1])
    for (let i = 0; i < repeatedBytes.length; i++) codes.symbol(0x41, writer)
    codes.symbol(256, writer)
    assert.deepEqual(decodeLZH(writer.data, 3).bytes, repeatedBytes)
  })

  test("tooManyLiteralLengthLengths", () => {
    // HLIT 30 and 31 give 287 and 288 lengths, above 286 (PV-0367).
    for (const hlit of [30, 31]) {
      const header = DynamicHeader.raw({ hlit, hdist: 1, symbols: [] })
      assert.deepEqual(decodeLZH(block(header), 6).error, {
        kind: "badCodeLengths",
        fault: { kind: "literalLengthCount", count: hlit + 257 }
      })
    }
  })

  test("tooManyDistanceLengths", () => {
    for (const hdist of [30, 31]) {
      const header = DynamicHeader.raw({ hlit: 1, hdist, symbols: [] })
      assert.deepEqual(decodeLZH(block(header), 6).error, { kind: "badCodeLengths", fault: { kind: "distanceCount", count: hdist + 1 } })
    }
  })

  test("maximumCountsAreAccepted", () => {
    // 286 literal/length and 30 distance lengths (PV-0367).
    const literalLength = SpecTables.flatLengths([0x21, 0x5a, 256, 257, 285], 286)
    const distance = SpecTables.flatLengths([0, 29], 30)
    const writer = new LZHStreamWriter()
    writer.noise(0)
    writer.blockHeader(true, 2)
    DynamicHeader.forLengths(literalLength, distance).write(writer)
    const codes = new DynamicCodeWriter(literalLength, distance)
    codes.symbol(0x5a, writer)
    codes.match(258, 1, writer)
    codes.symbol(256, writer)
    assert.deepEqual(decodeLZH(writer.data, 259).bytes, repeated(0x5a, 259))
  })

  test("codeLengthCodeMustBeComplete", () => {
    const overSubscribed = DynamicHeader.forLengths(literalLength, distance)
    overSubscribed.codeLengthLengths[0] = 1
    overSubscribed.codeLengthLengths[1] = 1
    assert.deepEqual(decodeLZH(block(overSubscribed), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "overSubscribed", code: "codeLength" }
    })

    const incomplete = DynamicHeader.forLengths(literalLength, distance)
    incomplete.codeLengthLengths[18] = 0
    assert.deepEqual(decodeLZH(block(incomplete), 6).error, { kind: "badCodeLengths", fault: { kind: "incomplete", code: "codeLength" } })

    // Nothing sent at all (HCLEN + 4 lengths of 0) is incomplete too.
    const empty = DynamicHeader.raw({ hlit: 1, hdist: 1, hclen: 0, codeLengthLengths: new Array<number>(19).fill(0), symbols: [] })
    assert.deepEqual(decodeLZH(block(empty), 6).error, { kind: "badCodeLengths", fault: { kind: "incomplete", code: "codeLength" } })
  })

  test("unsentCodeLengthCodeLengthsAreZero", () => {
    // With HCLEN + 4 = 4, only symbols 16, 17, 18 and 0 get lengths (PV-0368): a code of 17 and
    // 18 (length 1 each) and nothing else cannot send a nonzero length.
    const lengths = new Array<number>(19).fill(0)
    lengths[17] = 1
    lengths[18] = 1
    lengths[1] = 3 // beyond the four sent lengths: ignored
    const header = DynamicHeader.raw({ hlit: 0, hdist: 0, hclen: 0, codeLengthLengths: lengths, symbols: [[18, 127], [18, 127]] })
    assert.deepEqual(decodeLZH(block(header), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "runPastSequenceEnd", sequence: "literalLength" }
    })
  })

  test("literalLengthCodeMustBeComplete", () => {
    const lengths = [...literalLength]
    lengths[0x21] = 3 // was 2: leaves a gap
    assert.deepEqual(decodeLZH(block(DynamicHeader.forLengths(lengths, distance)), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "incomplete", code: "literalLength" }
    })
    lengths[0x21] = 1 // now claims too much
    assert.deepEqual(decodeLZH(block(DynamicHeader.forLengths(lengths, distance)), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "overSubscribed", code: "literalLength" }
    })
  })

  test("endOfBlockMustHaveALength", () => {
    const lengths = SpecTables.flatLengths([0x21, 0x5a, 257, 258], 259)
    assert.deepEqual(decodeLZH(block(DynamicHeader.forLengths(lengths, distance)), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "missingEndOfBlock" }
    })
  })

  test("distanceCodeMustBeComplete", () => {
    // One used distance symbol is incomplete (no exception, PV-0372, R-LZH-4) ...
    const one = DynamicHeader.forLengths(literalLength, [1])
    assert.deepEqual(decodeLZH(block(one), 6).error, { kind: "badCodeLengths", fault: { kind: "incomplete", code: "distance" } })
    // ... and so is none.
    const none = DynamicHeader.forLengths(literalLength, [0, 0])
    assert.deepEqual(decodeLZH(block(none), 6).error, { kind: "badCodeLengths", fault: { kind: "incomplete", code: "distance" } })
    const over = DynamicHeader.forLengths(literalLength, [1, 1, 1])
    assert.deepEqual(decodeLZH(block(over), 6).error, { kind: "badCodeLengths", fault: { kind: "overSubscribed", code: "distance" } })
  })

  test("repeatWithoutAPreviousLengthFails", () => {
    // IMPL-LZH-7: 16 as the first symbol of either sequence.
    const literalFirst = DynamicHeader.raw({ hlit: 1, hdist: 1, symbols: [[16, 0]] })
    assert.deepEqual(decodeLZH(block(literalFirst), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "repeatWithoutPreviousLength", sequence: "literalLength" }
    })
    const distanceFirst = DynamicHeader.raw({ hlit: 1, hdist: 1, symbols: [...literalSymbols(literalLength), [16, 0]] })
    assert.deepEqual(decodeLZH(block(distanceFirst), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "repeatWithoutPreviousLength", sequence: "distance" }
    })
  })

  test("runsMustNotCrossIntoTheDistanceSequence", () => {
    // The literal/length sequence ends with zeros; an 18 run long enough to reach into the
    // distance sequence fails (PV-0370).
    const symbols = literalSymbols(literalLength.slice(0, 257))
    symbols.push([18, 0]) // 11 zeros where 1 literal/length length remains
    const crossing = DynamicHeader.raw({ hlit: 1, hdist: 1, symbols })
    assert.deepEqual(decodeLZH(block(crossing), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "runPastSequenceEnd", sequence: "literalLength" }
    })

    const repeatSymbols = literalSymbols(literalLength)
    repeatSymbols.push([1, 0], [16, 0]) // 1 + 3 lengths where 2 are left
    const repeatCrossing = DynamicHeader.raw({ hlit: 1, hdist: 1, symbols: repeatSymbols })
    assert.deepEqual(decodeLZH(block(repeatCrossing), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "runPastSequenceEnd", sequence: "distance" }
    })

    const shortRun = literalSymbols(literalLength)
    shortRun.push([17, 0]) // 3 zeros where 2 are left
    const shortCrossing = DynamicHeader.raw({ hlit: 1, hdist: 1, symbols: shortRun })
    assert.deepEqual(decodeLZH(block(shortCrossing), 6).error, {
      kind: "badCodeLengths",
      fault: { kind: "runPastSequenceEnd", sequence: "distance" }
    })
  })

  test("longCodesUseSubtables", () => {
    // Lengths 1, 2, …, 14, 15, 15 (complete) in both codes, so that codes longer than the
    // primary table widths are decoded through subtables.
    const skewed = [...range(1, 14), 15, 15]
    const literalSymbolList = [0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 256, 257, 285]
    const literalLength = new Array<number>(286).fill(0)
    literalSymbolList.forEach((symbol, index) => (literalLength[symbol] = skewed[index]))
    const distance = new Array<number>(30).fill(0)
    range(0, 15).forEach((symbol, index) => (distance[symbol] = skewed[index]))
    const writer = new LZHStreamWriter()
    writer.noise(2, 3)
    writer.blockHeader(true, 2)
    DynamicHeader.forLengths(literalLength, distance).write(writer)
    const codes = new DynamicCodeWriter(literalLength, distance)
    const expected: number[] = []
    for (const symbol of literalSymbolList.slice(0, 13)) {
      codes.symbol(symbol, writer)
      expected.push(symbol)
    }
    // Distances whose symbols have the longest codes: symbol 15 (193–256) needs 193 bytes.
    for (let round = 0; round < 2; round++) {
      codes.match(258, 13, writer)
      for (let i = 0; i < 258; i++) expected.push(expected[expected.length - 13])
    }
    codes.match(3, 200, writer)
    for (let i = 0; i < 3; i++) expected.push(expected[expected.length - 200])
    codes.match(3, 129, writer)
    for (let i = 0; i < 3; i++) expected.push(expected[expected.length - 129])
    codes.symbol(256, writer)
    const data = writer.data
    assert.deepEqual(decodeLZH(data, expected.length).bytes, Uint8Array.from(expected))
    // Every prefix is truncated, including cuts inside a subtable code.
    for (let cut = data.length - 1; cut >= 0; cut--)
      assert.deepEqual(decodeLZH(data.subarray(0, cut), expected.length).error, { kind: "dataTruncated" }, `cut at ${cut}`)
  })
})
