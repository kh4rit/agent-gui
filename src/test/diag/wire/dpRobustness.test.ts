// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagWireTests/DPRobustnessTests.swift (MIT).

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  DPHeader,
  DPHeaderError,
  DPTerminalName,
  DP_HEADER_FIELDS,
  bytesEqual,
  dpHeaderFieldRange,
  hexText
} from "../../../diag/wire/index.js"
import { SeededGenerator } from "../../support/seededGenerator.js"
import { concat, expectedHeader, specTemplate } from "./support.js"

const INPUT_COUNT = 60_000

/** A first message with a random invented name and body, or a hand-built near miss. */
function plausibleFirstMessage(generator: SeededGenerator): Uint8Array {
  const nameBytes = Uint8Array.from({ length: generator.int(0, 15) }, () => generator.uint8(0x20, 0x7e))
  const body = generator.bytes(generator.int(0, 24))
  const declared = generator.bool() ? body.length : generator.uint32(0, 30)
  return concat(expectedHeader(nameBytes, declared), body)
}

function tryParse(input: Uint8Array): DPHeader | undefined {
  try {
    return DPHeader.parse(input)
  } catch {
    return undefined
  }
}

/**
 * Runs both decoders on `input` and compares them with the model; returns the outcome's error
 * class, or undefined on a mismatch.
 */
function check(input: Uint8Array): string | undefined {
  const parsed = tryParse(input)
  let result: { header: DPHeader } | { error: DPHeaderError }
  try {
    result = { header: DPHeader.parseFirstMessage(input) }
  } catch (e) {
    if (!(e instanceof DPHeaderError)) throw e
    result = { error: e }
  }
  if (input.length < 200) {
    if (parsed !== undefined || !("error" in result) || result.error.info.kind !== "truncated" || result.error.info.byteCount !== input.length)
      return undefined
    return "truncated"
  }
  if (!parsed || !bytesEqual(parsed.bytes, input.subarray(0, 200))) return undefined
  const declared = (input[30] | (input[31] << 8) | (input[32] << 16) | (input[33] << 24)) >>> 0
  const bodyLength = input.length - 200
  if (declared !== bodyLength) {
    if (!("error" in result)) return undefined
    const info = result.error.info
    if (info.kind !== "lengthMismatch" || info.declaredLength !== declared || info.bodyLength !== bodyLength) return undefined
    return "length-mismatch"
  }
  if (!("header" in result)) return undefined
  const header = result.header
  if (!bytesEqual(header.bytes, parsed.bytes) || header.length !== declared) return undefined
  // Template comparison against the spec's hex table, outside the length and terminal.
  const differing = DP_HEADER_FIELDS.filter(field => {
    if (field === "length" || field === "terminal") return false
    const [start, end] = dpHeaderFieldRange(field)
    return !bytesEqual(input.subarray(start, end), specTemplate.subarray(start, end))
  })
  if (JSON.stringify(header.nonTemplateFields) !== JSON.stringify(differing) || header.matchesTemplate !== (differing.length === 0))
    return undefined
  // A template header whose terminal is a printable name then zeros re-encodes exactly.
  const terminal = input.subarray(81, 96)
  const zero = terminal.indexOf(0)
  const name = zero < 0 ? terminal : terminal.subarray(0, zero)
  if (!bytesEqual(header.terminalName, name)) return undefined
  const zeroFilled = terminal.subarray(name.length).every(b => b === 0)
  if (differing.length === 0 && zeroFilled && name.every(b => b >= 0x20 && b <= 0x7e)) {
    const encoded = DPHeader.firstMessage(DPTerminalName.fromHostName(String.fromCharCode(...name)), declared)
    if (!bytesEqual(encoded.bytes, header.bytes)) return undefined
  }
  return "none"
}

/**
 * Deterministic robustness run for the DP header decoder (docs/testing.md §3): random bytes and
 * mutated first messages through `DPHeader.parse` and `DPHeader.parseFirstMessage`. Nothing may
 * throw anything but `DPHeaderError`, and every result is checked against an independent model of
 * IMPL-DP-3 written from the spec's hex template. The seed is fixed, so a failure reproduces
 * exactly.
 */
describe("DP header robustness", () => {
  test("randomAndMutatedInputsMatchTheModel", () => {
    const generator = new SeededGenerator(0x5eed_0d90)
    const outcomes = new Map<string, number>()
    let templates = 0
    for (let iteration = 0; iteration < INPUT_COUNT; iteration++) {
      let input: Uint8Array
      switch (iteration % 4) {
        case 0:
          input = generator.bytes(generator.int(0, 260))
          break
        case 1:
        case 2:
          input = generator.mutate(plausibleFirstMessage(generator))
          break
        default:
          input = plausibleFirstMessage(generator)
      }
      const outcome = check(input)
      if (outcome === undefined) assert.fail(`model mismatch at iteration ${iteration}, input ${hexText(input)}`)
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
      if (outcome === "none" && tryParse(input)?.matchesTemplate === true) templates += 1
    }
    // The run must reach every outcome, or it proves little.
    assert.ok((outcomes.get("none") ?? 0) > 5000, JSON.stringify([...outcomes]))
    assert.ok((outcomes.get("truncated") ?? 0) > 5000, JSON.stringify([...outcomes]))
    assert.ok((outcomes.get("length-mismatch") ?? 0) > 5000, JSON.stringify([...outcomes]))
    assert.ok(templates > 5000, `${templates} templates`)
  })
})
