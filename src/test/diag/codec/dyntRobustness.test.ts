// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DyntRobustnessTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ClientItem,
  ClientMessageEncoder,
  Decompression,
  DiagMessage,
  DiagMessageDecodingError,
  DyntAtomDiagnostics,
  DyntAtomEncoder,
  DyntAtomEncodingError,
  DyntAtomHeader,
  DyntAtomWalkError,
  DyntAtomWalker,
  DyntAtoms,
  DyntDialogFlags,
  DyntElementType,
  DyntField,
  DyntFrame,
  DyntTabstripButton,
  DyntText,
  DyntTextError,
  DyntTextPart,
  applItemCarriesDyntAtoms,
  byteRange,
  type DyntAtom,
  type DyntPayload,
  type KnownDyntElementKind
} from "../../../diag/codec/index.js"
import { ByteWriter, DPTerminalName, NIFrameEncoder, NIKeepAlive, bytesEqual, classifyNIPayload } from "../../../diag/wire/index.js"
import { dyntAtomWalkErrorClass } from "../../vectors/dyntRunners.js"
import { PENDING_KINDS } from "../../vectors/kinds.js"
import { loadVector, vectorFiles } from "../../vectors/paths.js"
import { runVector } from "../../vectors/registry.js"
import { decodeStream } from "../../vectors/wireRunners.js"
import { appl4, ascii, attempt, cat, walkItems, zzTestIdentity } from "../../support/codecTestSupport.js"
import { ZZScreen, field1Content, field2Content, rawAtom, tabstripContent, walkAtoms } from "../../support/dyntTestSupport.js"
import { SeededGenerator } from "../../support/seededGenerator.js"

/**
 * Deterministic robustness, property and delivery tests of the DYNT atom layer: random and mutated
 * atom sequences checked against an independent model of dynt-atoms.md, encode/walk round trips,
 * and atoms delivered through chunked NI frames. Nothing may throw anything but the walker's own
 * error; fixed seeds make every failure reproducible.
 */
const inputCount = 60_000

// MARK: Independent models, written from the spec text

/** "Walking an atom sequence", steps 1–7: the number of complete atoms, where the walk ended, and how it stopped. */
function modelWalk(input: Uint8Array): { count: number; offset: number; stop: string } {
  let offset = 0
  let count = 0
  while (offset < input.length) {
    const left = input.length - offset
    if (left < 2) return { count, offset, stop: "truncated" }
    const length = (input[offset] << 8) | input[offset + 1]
    if (length < 13) return { count, offset, stop: "bad-atom-length" }
    if (length > left) return { count, offset, stop: "truncated" }
    offset += length
    count += 1
  }
  return { count, offset, stop: "none" }
}

/**
 * The text range the spec gives an atom's payload, or undefined (text atoms, field variants whose
 * dlen fills the rest, frames; tabstrip buttons are checked separately).
 */
function modelText(input: Uint8Array, start: number, length: number): [number, number] | undefined {
  const [lower, upper] = [start + 13, start + length]
  const count = upper - lower
  switch (input[start + 4]) {
    case 114:
    case 120:
      return [lower, upper]
    case 121:
    case 122:
    case 123:
      if (count < 5 || input[lower + 1] !== count - 5) return undefined
      return [lower + 5, upper]
    case 130:
    case 131:
    case 132:
      if (count < 6 || input[lower + 2] !== count - 6) return undefined
      return [lower + 6, upper]
    case 127:
      return count >= 4 ? [lower + 4, upper] : undefined
    default:
      return undefined
  }
}

// MARK: Generators

function plausibleAtom(generator: SeededGenerator): Uint8Array {
  const etype =
    generator.intBelow(0, 5) === 0 ? generator.uint8() : [114, 115, 116, 120, 121, 122, 123, 127, 129, 130, 131, 132, 101, 110][generator.intBelow(0, 14)]
  const text = generator.bytes(generator.int(0, 12))
  let content: Uint8Array
  switch (etype) {
    case 121:
    case 122:
    case 123:
      content = field1Content(text, { dlen: generator.bool() ? undefined : generator.uint8(0, 15) })
      break
    case 130:
    case 131:
    case 132:
      content = field2Content(text, { dlen: generator.bool() ? undefined : generator.uint8(0, 15) })
      break
    case 116: {
      const id = generator.bytes(2).filter(byte => byte !== 0)
      content = cat(
        tabstripContent({ text: text.filter(byte => byte !== 0), functionCode: ascii("ZZFUZZ"), id }),
        generator.bytes(generator.int(0, 2))
      )
      break
    }
    case 127:
      content = cat(generator.bytes(4), text)
      break
    default:
      content = Uint8Array.from(text)
  }
  const flag1 = generator.uint8()
  const row = generator.uint16()
  const col = generator.uint16(0, 200)
  const attr = generator.uint8()
  return rawAtom(etype, { content, flags: [flag1, 0], row, col, attr })
}

function plausibleSequence(generator: SeededGenerator): Uint8Array {
  const count = generator.int(0, 6)
  const atoms: Uint8Array[] = []
  for (let index = 0; index < count; index++) atoms.push(plausibleAtom(generator))
  return cat(...atoms)
}

function input(iteration: number, generator: SeededGenerator): Uint8Array {
  switch (iteration % 3) {
    case 0:
      return Uint8Array.from(generator.bytes(generator.int(0, 48)))
    case 1:
      return Uint8Array.from(generator.mutate(plausibleSequence(generator)))
    default:
      return plausibleSequence(generator)
  }
}

// MARK: Robustness

function check(sequence: Uint8Array): void {
  const walker = new DyntAtomWalker()
  const atoms: DyntAtom[] = []
  let error: DyntAtomWalkError | undefined
  try {
    for (let atom = walker.next(sequence); atom !== undefined; atom = walker.next(sequence)) atoms.push(atom)
  } catch (failure) {
    if (!(failure instanceof DyntAtomWalkError)) throw failure
    error = failure
  }
  const model = modelWalk(sequence)
  assert.ok(atoms.length === model.count && walker.offset === model.offset, String(sequence))
  assert.equal(error ? dyntAtomWalkErrorClass(error.info) : "none", model.stop, String(sequence))
  if (error) assert.ok(error.atomIndex === atoms.length + 1 && error.atomOffset === walker.offset)
  let offset = 0
  const diagnostics = new DyntAtomDiagnostics()
  let lastParent: number | undefined
  for (const atom of atoms) {
    assert.ok(atom.offset === offset && atom.length >= 13 && atom.endOffset <= sequence.length)
    assert.ok(DyntElementType.rawValue(atom.etype) === sequence[offset + 4] && atom.attributes === sequence[offset + 12])
    assert.equal(atom.row, (sequence[offset + 8] << 8) | sequence[offset + 9])
    const text = atom.textRange
    const expectedText = modelText(sequence, offset, atom.length)
    assert.ok(
      (text === undefined ? expectedText === undefined : expectedText?.[0] === text.lowerBound && expectedText[1] === text.upperBound) ||
        atom.etype.kind === "tabstripButton"
    )
    if (text) {
      assert.ok(atom.contentRange.contains(text.lowerBound) || text.lowerBound === atom.contentRange.upperBound)
      assert.ok(text.upperBound <= atom.contentRange.upperBound)
    }
    // The parent rule of IMPL-DA-4, restated.
    if (DyntElementType.isChildMetadata(atom.etype)) {
      assert.equal(atom.parentIndex, lastParent)
      if (lastParent === undefined) diagnostics.orphanChildren += 1
    } else {
      assert.equal(atom.parentIndex, undefined)
      lastParent = atom.index
    }
    if (atom.payload.kind === "tabstripButton") {
      const button = atom.payload.value
      for (const range of [button.textRange, button.functionCodeRange, button.idRange])
        assert.ok(range.upperBound < atom.endOffset && sequence[range.upperBound] === 0 && !range.of(sequence).includes(0))
    }
    // Re-encoding the header and content gives the atom back.
    const raw = new ByteWriter()
    attempt(() => DyntAtomEncoder.appendAtom(atom.header, atom.contentRange.of(sequence), raw), DyntAtomEncodingError)
    assert.ok(bytesEqual(raw.toBytes(), sequence.subarray(atom.offset, atom.endOffset)))
    // Decoding text on demand never traps, whatever the bytes.
    for (const part of DyntTextPart.allCases) attempt(() => DyntText.decode(atom, sequence, DyntText.utf8CodePage, part), DyntTextError)
    offset = atom.endOffset
  }
  assert.equal(walker.diagnostics.orphanChildren, diagnostics.orphanChildren)
  const found = walker.diagnostics
  assert.ok(found.opaquePayloads + found.undecodedButtonStrings + found.dlenMismatches + found.malformedPayloads <= atoms.length)
}

describe("DYNT robustness", () => {
  /**
   * Random, mutated and plausible atom sequences: the walker never throws anything but its own
   * error, agrees with the model, and every atom it yields is a consistent view of the input.
   */
  test("randomAndMutatedSequences", () => {
    const generator = new SeededGenerator(0xd1a60dd5)
    for (let iteration = 0; iteration < inputCount; iteration++) check(input(iteration, generator))
  })

  /** Mutations of the invented screen and of every spec vector's bytes. */
  test("mutatedScreensAndVectors", () => {
    const seeds: Uint8Array[] = [ZZScreen.atoms]
    for (const path of vectorFiles()) {
      const vector = loadVector(path)
      if (vector.kind === "dynt-atoms") seeds.push(vector.bytes)
    }
    assert.ok(seeds.length >= 13)
    const generator = new SeededGenerator(0x5eeda70a)
    for (let iteration = 0; iteration < 10_000; iteration++) check(Uint8Array.from(generator.mutate(seeds[iteration % seeds.length])))
  })

  // MARK: Property: encode then walk

  test("encodedAtomsWalkBackToTheirFields", () => {
    const generator = new SeededGenerator(0xe4c0de55)
    const kinds: KnownDyntElementKind[] = ["fname", "efield2", "keyword1_1", "frame1", "tabstripButton"]
    for (let round = 0; round < 5_000; round++) {
      const output = new ByteWriter()
      const expected: [DyntAtomHeader, DyntPayload][] = []
      const atoms = generator.int(1, 5)
      for (let index = 0; index < atoms; index++) {
        const text = Uint8Array.from(generator.bytes(generator.int(0, 20)).map(byte => byte | 1)) // no zero bytes
        const start = output.length + 13
        const kind = generator.intBelow(0, 5)
        const flag1 = generator.uint8()
        const flag2 = generator.uint8()
        const area = generator.uint8()
        const block = generator.uint8()
        const group = generator.uint8()
        const row = generator.uint16()
        const col = generator.uint16()
        const attributes = generator.uint8()
        const header = new DyntAtomHeader({
          etype: DyntElementType.of(kinds[kind]),
          dialogFlags: new DyntDialogFlags({ flag1, flag2 }),
          area,
          block,
          group,
          row,
          col,
          attributes
        })
        let payload: DyntPayload
        switch (kind) {
          case 0:
            DyntAtomEncoder.appendText(header, text, output)
            payload = { kind: "text", value: byteRange(start, start + text.length) }
            break
          case 1:
            DyntAtomEncoder.appendField(header, { flag1: 0x0102, mlen: 3, maxNrChars: 4, text }, output)
            payload = {
              kind: "field",
              value: new DyntField({ form: "v2", flag1: 0x0102, dlen: text.length, mlen: 3, maxNrChars: 4, textRange: byteRange(start + 6, start + 6 + text.length) })
            }
            break
          case 2:
            DyntAtomEncoder.appendField(header, { flag1: 0x09, mlen: 3, maxNrChars: 4, text }, output)
            payload = {
              kind: "field",
              value: new DyntField({ form: "v1", flag1: 0x09, dlen: text.length, mlen: 3, maxNrChars: 4, textRange: byteRange(start + 5, start + 5 + text.length) })
            }
            break
          case 3:
            DyntAtomEncoder.appendFrame(header, 7, 8, text, output)
            payload = { kind: "frame", value: new DyntFrame({ drows: 7, dcols: 8, textRange: byteRange(start + 4, start + 4 + text.length) }) }
            break
          default: {
            DyntAtomEncoder.appendTabstripButton(
              header,
              { vLength: 1, vHeight: 2, pageID: 3, functionCodeOffset: 4, textOffset: 5, idOffset: 6, text, functionCode: ascii("ZZ"), id: new Uint8Array(0) },
              output
            )
            const textEnd = start + 9 + text.length
            payload = {
              kind: "tabstripButton",
              value: new DyntTabstripButton({
                vLength: 1,
                vHeight: 2,
                pageID: 3,
                functionCodeOffset: 4,
                textOffset: 5,
                idOffset: 6,
                textRange: byteRange(start + 9, textEnd),
                functionCodeRange: byteRange(textEnd + 1, textEnd + 3),
                idRange: byteRange(textEnd + 4, textEnd + 4),
                trailingByteCount: 0
              })
            }
          }
        }
        expected.push([header, payload])
      }
      const result = walkAtoms(output.toBytes())
      assert.ok(result.error === undefined && result.atoms.length === expected.length)
      result.atoms.forEach((atom, index) => {
        assert.deepEqual(atom.header, expected[index][0])
        assert.deepEqual(atom.payload, expected[index][1])
      })
    }
  })

  // MARK: Delivery: chunked frames

  function atomsInStream(stream: Uint8Array, cuts: number[]): DyntAtom[][] {
    const result = decodeStream(stream, cuts)
    const screens: DyntAtom[][] = []
    for (const frame of result.frames) {
      if (classifyNIPayload(frame.payload).kind !== "diag") continue
      const message = attempt(() => DiagMessage.parse(frame.payload), DiagMessageDecodingError)
      if (!message || message.body.kind !== "items") continue
      const items = message.body.range.of(frame.payload).slice()
      for (const item of walkItems(items).items)
        if (item.appl && applItemCarriesDyntAtoms(item.appl)) screens.push(DyntAtoms.walk(item.valueRange.of(items)).atoms)
    }
    return screens
  }

  /**
   * A server message whose APPL4 DYNT_ATOM item arrives in NI frames split at random positions:
   * every split gives the same atoms (the walker itself is fed one complete item value, R-DA-1).
   */
  test("atomsThroughChunkedFrames", () => {
    const message = cat([0, 0, 0, 0, 0, 0, 0, 0], appl4(0x09, 0x02, ZZScreen.atoms), [0x0c])
    const stream = cat(new NIFrameEncoder().encode(message), NIKeepAlive.pongFrame, new NIFrameEncoder().encode(message))
    const reference = atomsInStream(stream, [])
    assert.ok(reference.length === 2 && reference[0].length === 6)
    const generator = new SeededGenerator(0xc4a24ed)
    for (let position = 0; position <= stream.length; position++)
      assert.deepEqual(atomsInStream(stream, position === 0 || position === stream.length ? [] : [position]), reference)
    for (let round = 0; round < 500; round++) assert.deepEqual(atomsInStream(stream, generator.cuts(stream.length)), reference)
  })

  /** DYNT atoms inside an LZH-compressed message: decompressed, walked, the same atoms. */
  test("atomsThroughACompressedMessage", () => {
    const encoder = new ClientMessageEncoder(zzTestIdentity(), DPTerminalName.empty, "lzh")
    const payload = encoder.dialogMessage([ClientItem.dyntAtom(ZZScreen.atoms)])
    const message = DiagMessage.parse(payload)
    if (message.body.kind !== "compressed" || message.body.isErrorBody) assert.fail("expected a compressed body")
    const items = Decompression.decompress(message.body.data.of(payload), message.body.header)
    const carrier = walkItems(items).items.find(item => item.appl !== undefined && applItemCarriesDyntAtoms(item.appl))
    assert.ok(carrier)
    assert.equal(carrier.type, "appl4", "DYNT_ATOM goes as APPL4 (R-IT-10)")
    const walked = DyntAtoms.walk(carrier.valueRange.of(items))
    assert.equal(walked.error, undefined)
    assert.deepEqual(
      walked.atoms.map(atom => atom.etype),
      walkAtoms(ZZScreen.atoms).atoms.map(atom => atom.etype)
    )
  })
})

describe("DYNT vectors", () => {
  /** The dynt-atoms kind is dispatched and has the spec v1 vectors (test/vectors/dynt, 12 files). */
  test("theKindHasItsVectors", () => {
    let count = 0
    for (const path of vectorFiles()) {
      const vector = loadVector(path)
      if (vector.kind !== "dynt-atoms") continue
      count += 1
      assert.deepEqual(runVector(vector, PENDING_KINDS), { status: "passed" }, path)
    }
    assert.ok(count >= 12)
  })

  test("errorClasses", () => {
    assert.equal(dyntAtomWalkErrorClass({ kind: "truncated", atomIndex: 1, atomOffset: 0, part: "length" }), "truncated")
    assert.equal(dyntAtomWalkErrorClass({ kind: "truncated", atomIndex: 1, atomOffset: 0, part: "atom" }), "truncated")
    assert.equal(dyntAtomWalkErrorClass({ kind: "badAtomLength", length: 3, atomIndex: 1, atomOffset: 0 }), "bad-atom-length")
  })
})
