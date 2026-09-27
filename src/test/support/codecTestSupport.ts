// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/CodecTestSupport.swift (MIT), plus the assertion
// helpers the node:test port needs in place of Swift Testing's `#expect(throws:)`.

// Hand-built items and walk helpers shared by the DiagCodec tests. Values are arbitrary bytes; the
// few invented texts follow docs/testing.md §8 (ZZ… transactions, deliberately silly).

import assert from "node:assert/strict"
import { ClientIdentity, DiagItemWalkError, DiagItemWalker, SupportBit, SupportBits, type DiagItem } from "../../diag/codec/index.js"
import { ByteWriter, concatBytes } from "../../diag/wire/index.js"

/** Concatenates byte arrays (Swift `+` on `[UInt8]`). */
export const cat = (...parts: ArrayLike<number>[]): Uint8Array => concatBytes(...parts)

/** The bytes of a list of byte values. */
export const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

/** `count` copies of `value` (Swift `[UInt8](repeating:count:)`). */
export const repeated = (value: number, count: number): Uint8Array => new Uint8Array(count).fill(value)

/** An XMLBLOB built by hand: type 0x11, u32 BE length, value. */
export function xmlblob(value: ArrayLike<number>): Uint8Array {
  return cat([0x11], u32BE(value.length), value)
}

/** An APPL item built by hand: type 0x10, id, sid, u16 BE length, value. */
export function appl(id: number, sid: number, value: ArrayLike<number>): Uint8Array {
  const n = value.length & 0xffff
  return cat([0x10, id, sid, n >> 8, n & 0xff], value)
}

/** An APPL4 item built by hand: type 0x12, id, sid, u32 BE length, value. */
export function appl4(id: number, sid: number, value: ArrayLike<number>): Uint8Array {
  return cat([0x12, id, sid], u32BE(value.length), value)
}

export function u32BE(value: number): Uint8Array {
  return bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

/** ASCII bytes of an invented text (Swift `Array(text.utf8)`). */
export function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Walks a whole sequence with the v1 walker; returns the items and the error that stopped it. */
export function walkItems(sequence: Uint8Array, start = 0): { items: DiagItem[]; error: DiagItemWalkError | undefined } {
  const walker = new DiagItemWalker(start)
  const items: DiagItem[] = []
  try {
    for (let item = walker.next(sequence); item !== undefined; item = walker.next(sequence)) items.push(item)
    return { items, error: undefined }
  } catch (error) {
    if (!(error instanceof DiagItemWalkError)) throw error
    return { items, error }
  }
}

/**
 * An identity with invented values for tests. It is not a mask or ws_type anyone should send: those
 * are #16, #17 and #18. (A fresh copy on every call: Swift's `let` is a value.)
 */
export function zzTestIdentity(): ClientIdentity {
  return new ClientIdentity({ codePage: 0x0000_1234, wsType: 0x0000_4242, supportData: new SupportBits([SupportBit.dialogStepNumber]) })
}

/** The bytes an encoder writes into a fresh `ByteWriter`. */
export function written(write: (output: ByteWriter) => void): Uint8Array {
  const output = new ByteWriter()
  write(output)
  return output.toBytes()
}

/** An error class of the port: an `Error` whose `info` is the Swift error enum's value. */
type InfoError<Info> = abstract new (...args: never[]) => Error & { readonly info: Info }

/**
 * Swift `#expect(throws: SomeError.case(...)) { ... }`: `body` throws an instance of `errorClass`
 * whose `info` equals `info`.
 */
export function throwsInfo<Info>(body: () => unknown, errorClass: InfoError<Info>, info: Info, message?: string): void {
  assert.throws(
    body,
    (error: unknown) => {
      assert.ok(error instanceof errorClass, `${message ?? ""} expected ${errorClass.name}, got ${String(error)}`)
      assert.deepStrictEqual((error as { info: Info }).info, info, message)
      return true
    },
    message
  )
}

/** The `info` of the error `body` throws as an instance of `errorClass`, or undefined when it does not throw. */
export function thrownInfo<Info>(body: () => unknown, errorClass: InfoError<Info>): Info | undefined {
  try {
    body()
  } catch (error) {
    if (error instanceof errorClass) return (error as { info: Info }).info
    throw error
  }
  return undefined
}

/** Swift `try?`: the result, or undefined when `body` throws an instance of one of `errorClasses`. */
export function attempt<T>(body: () => T, ...errorClasses: (abstract new (...args: never[]) => Error)[]): T | undefined {
  try {
    return body()
  } catch (error) {
    if (errorClasses.length === 0 || errorClasses.some(errorClass => error instanceof errorClass)) return undefined
    throw error
  }
}
