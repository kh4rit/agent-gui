// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/Expectations.swift (MIT).

import { hexByteToken } from "./vectorFile.js"

/**
 * Reads a vector's `expect.*` values with the types of test/vectors/README.md ("Value types") and
 * records which keys were used, so that a runner can fail on keys it never consumed.
 */
export class Expectations {
  private readonly consumed = new Set<string>()
  /** Missing required keys and malformed values. */
  readonly problems: string[] = []

  constructor(private readonly values: Map<string, string>) {}

  /** Keys present in the vector that no check read, sorted. */
  get unconsumedKeys(): string[] {
    return [...this.values.keys()].filter(k => !this.consumed.has(k)).sort()
  }

  /** Marks every key as read (used after a mismatch that makes the remaining keys meaningless). */
  consumeAll(): void {
    for (const k of this.values.keys()) this.consumed.add(k)
  }

  /** The keys starting with `prefix`, sorted (does not consume them). */
  keys(prefix: string): string[] {
    return [...this.values.keys()].filter(k => k.startsWith(prefix)).sort()
  }

  /** Whether the key is present (does not consume it). */
  has(key: string): boolean {
    return this.values.has(key)
  }

  /** The raw value, or undefined (recording a problem) when a required key is missing. */
  string(key: string, required = true): string | undefined {
    const value = this.values.get(key)
    if (value === undefined) {
      if (required) this.problems.push(`missing required key ${key}`)
      return undefined
    }
    this.consumed.add(key)
    return value
  }

  /** `int`: decimal, no sign, no separators. */
  int(key: string, required = true): number | undefined {
    const text = this.string(key, required)
    if (text === undefined) return undefined
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(Number(text))) {
      this.problems.push(`${key}: '${text}' is not a decimal int`)
      return undefined
    }
    return Number(text)
  }

  /** `byte`: `0x` and two uppercase hex digits. */
  byte(key: string, required = true): number | undefined {
    const text = this.string(key, required)
    if (text === undefined) return undefined
    if (!/^0x[0-9A-F]{2}$/.test(text)) {
      this.problems.push(`${key}: '${text}' is not a byte (0xHH)`)
      return undefined
    }
    return parseInt(text.slice(2), 16)
  }

  /** `hex`: two-digit hex bytes separated by single spaces, or `none` (an empty array). */
  hex(key: string, required = true): Uint8Array | undefined {
    const text = this.string(key, required)
    if (text === undefined) return undefined
    if (text === "none") return new Uint8Array(0)
    const bytes: number[] = []
    for (const token of text.split(" ")) {
      const byte = hexByteToken(token)
      if (byte === undefined) {
        this.problems.push(`${key}: '${text}' is not hex bytes separated by single spaces`)
        return undefined
      }
      bytes.push(byte)
    }
    return Uint8Array.from(bytes)
  }

  /** `names`: tokens joined by commas without spaces, or `none` (an empty array). */
  names(key: string, required = true): string[] | undefined {
    const text = this.string(key, required)
    if (text === undefined) return undefined
    if (text === "none") return []
    const names = text.split(",")
    if (!names.every(n => n !== "" && !n.includes(" "))) {
      this.problems.push(`${key}: '${text}' is not a comma-separated name list`)
      return undefined
    }
    return names
  }
}
