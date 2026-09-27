// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/ControlVectorRunners.swift (MIT).

// Runners for the Control Framework vector kinds with an implementation (test/vectors/README.md,
// "Kinds"): `rfc-items`, the RFC item walk (IMPL-CT-2) and Swooey's item encoder (IMPL-CT-12) in
// both directions.

import { RFCItemEncoder, RFCItemEncodingError, RFCItemWalkError, RFCItemWalker, type RFCItem, type RFCItemWalkErrorInfo } from "../../diag/codec/index.js"
import { ByteWriter, bytesEqual, hexText } from "../../diag/wire/index.js"
import { checkError, compare } from "./codecRunners.js"
import type { Expectations } from "./expectations.js"
import { registerKind } from "./registry.js"
import { NO_ERROR } from "./wireRunners.js"

/** The largest value a vector spells out (`expect.item.<n>.value`). */
export const MAX_SPELLED_VALUE = 64

/** Records a mismatch of two byte arrays when `expected` is present. */
function compareBytes(name: string, expected: Uint8Array | undefined, actual: Uint8Array, failures: string[]): void {
  if (expected === undefined || bytesEqual(expected, actual)) return
  failures.push(`${name}: expected ${hexText(expected)}, got ${hexText(actual)}`)
}

/**
 * `rfc-items`: walks the input as RFC items, compares each item, then writes the walked items again
 * with Swooey's encoder, the end item as `FF FF 00 00 FF FF`, and says whether that gives the input
 * back.
 */
function runRFCItems(input: Uint8Array, expect: Expectations, failures: string[]): void {
  const walker = new RFCItemWalker()
  const items: RFCItem[] = []
  let stop: RFCItemWalkErrorInfo | undefined
  try {
    for (let item = walker.next(input); item !== undefined; item = walker.next(input)) items.push(item)
  } catch (error) {
    if (!(error instanceof RFCItemWalkError)) throw error
    stop = error.info
  }
  const errorClass = stop === undefined ? NO_ERROR : "truncated"
  if (!checkError(errorClass, expect, failures)) return
  if (stop?.kind === "truncated") compare("error.item", expect.int("expect.error.item"), stop.itemIndex, failures)
  const count = expect.int("expect.items")
  if (count === undefined) return
  compare("items", count, items.length, failures)
  for (let number = 1; number <= count; number++) {
    const item = number <= items.length ? items[number - 1] : undefined
    const id = expect.hex(`expect.item.${number}.id`)
    const length = expect.int(`expect.item.${number}.length`)
    const trailer = expect.string(`expect.item.${number}.trailer`)
    const spelled = (item?.valueRange.count ?? 0) <= MAX_SPELLED_VALUE
    const value = expect.hex(`expect.item.${number}.value`, spelled)
    if (item === undefined) continue
    compareBytes(`item ${number} id`, id, Uint8Array.of(item.id >> 8, item.id & 0xff), failures)
    compare(`item ${number} length`, length, item.valueRange.count, failures)
    compareBytes(`item ${number} value`, value, item.valueRange.of(input), failures)
    const actualTrailer = item.trailerMatches === true ? "matches" : item.trailerMatches === false ? "differs" : "missing"
    compare(`item ${number} trailer`, trailer, actualTrailer, failures)
  }
  const last = items[items.length - 1]
  compare("end", expect.string("expect.end"), last !== undefined && last.id === RFCItemWalker.endID ? "yes" : "no", failures)
  if (stop !== undefined) return
  const written = new ByteWriter()
  for (const item of items) {
    if (item.id === RFCItemWalker.endID) {
      RFCItemEncoder.appendEnd(written)
    } else {
      try {
        RFCItemEncoder.append(item.id, item.valueRange.of(input), written)
      } catch (error) {
        if (!(error instanceof RFCItemEncodingError)) throw error
        failures.push(`item encoder refused an item: ${error.message}`)
      }
    }
  }
  compare("reencodes", expect.string("expect.reencodes"), bytesEqual(written.toBytes(), input) ? "yes" : "no", failures)
}

registerKind("rfc-items", runRFCItems)
