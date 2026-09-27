// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/SeededGenerator.swift (MIT).

const MASK64 = (1n << 64n) - 1n

/**
 * A deterministic random number generator (SplitMix64) for reproducible robustness tests. The same
 * seed gives the same sequence on every platform.
 *
 * The helpers replicate the Swift standard library's `random(in:using:)` on a generator: Lemire's
 * nearly divisionless method on the type's width (`next(upperBound:)`), `Bool.random` as bit 17
 * of `next()`, and a full-range draw as the low bits of `next()`, so that a seed gives the same
 * draws as in Swooey.
 */
export class SeededGenerator {
  private state: bigint

  constructor(seed: bigint | number) {
    this.state = BigInt.asUintN(64, BigInt(seed))
  }

  /** The next 64 random bits. */
  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64
    let z = this.state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64
    return z ^ (z >> 31n)
  }

  /** Swift `next(upperBound:)` on an unsigned type of `bits` bits: 0 ..< `upperBound`. */
  private nextBelow(upperBound: bigint, bits: bigint): bigint {
    if (upperBound === 0n) throw new Error("upperBound cannot be zero.")
    const mask = (1n << bits) - 1n
    let random = this.next() & mask
    let product = random * upperBound
    if ((product & mask) < upperBound) {
      const t = ((1n << bits) - upperBound) % upperBound
      while ((product & mask) < t) {
        random = this.next() & mask
        product = random * upperBound
      }
    }
    return product >> bits
  }

  /** Swift `FixedWidthInteger.random(in: lower ... upper, using:)` on a type of `bits` bits. */
  private closed(lower: number, upper: number, bits: bigint): number {
    const delta = BigInt(upper - lower)
    if (delta === (1n << bits) - 1n) return lower + Number(this.next() & ((1n << bits) - 1n))
    return lower + Number(this.nextBelow(delta + 1n, bits))
  }

  /** Swift `Int.random(in: lower ... upper, using:)`. */
  int(lower: number, upper: number): number {
    return this.closed(lower, upper, 64n)
  }

  /** Swift `Int.random(in: lower ..< upper, using:)`. */
  intBelow(lower: number, upper: number): number {
    return lower + Number(this.nextBelow(BigInt(upper - lower), 64n))
  }

  /** Swift `UInt8.random(in: lower ... upper, using:)`; the full range by default. */
  uint8(lower = 0, upper = 0xff): number {
    return this.closed(lower, upper, 8n)
  }

  /** Swift `UInt8.random(in: lower ..< upper, using:)`. */
  uint8Below(lower: number, upper: number): number {
    return lower + Number(this.nextBelow(BigInt(upper - lower), 8n))
  }

  /** Swift `UInt16.random(in: lower ... upper, using:)`; the full range by default. */
  uint16(lower = 0, upper = 0xffff): number {
    return this.closed(lower, upper, 16n)
  }

  /** Swift `Bool.random(using:)`. */
  bool(): boolean {
    return ((this.next() >> 17n) & 1n) === 0n
  }

  /** `count` random bytes. */
  bytes(count: number): number[] {
    const output: number[] = []
    for (let index = 0; index < count; index++) output.push(this.uint8())
    return output
  }

  /** A copy of `input` with a few random mutations: byte flips, bit flips, insertions, deletions and truncation. */
  mutate(input: ArrayLike<number>): number[] {
    const output = Array.from(input)
    const rounds = this.int(1, 4)
    for (let round = 0; round < rounds; round++) {
      switch (this.intBelow(0, 5)) {
        case 0:
          if (output.length > 0) {
            const index = this.intBelow(0, output.length)
            output[index] = this.uint8()
          }
          break
        case 1:
          if (output.length > 0) {
            const index = this.intBelow(0, output.length)
            output[index] ^= 1 << this.uint8Below(0, 8)
          }
          break
        case 2: {
          const value = this.uint8()
          output.splice(this.int(0, output.length), 0, value)
          break
        }
        case 3:
          if (output.length > 0) output.splice(this.intBelow(0, output.length), 1)
          break
        case 4:
          if (output.length > 0) output.length -= this.int(0, output.length)
          break
      }
    }
    return output
  }

  /** Random ascending cut positions strictly inside `0 ..< count`, splitting it into reads. */
  cuts(count: number): number[] {
    if (count <= 1) return []
    const pieces = this.int(0, Math.min(count - 1, 8))
    const positions = new Set<number>()
    for (let piece = 0; piece < pieces; piece++) positions.add(this.intBelow(1, count))
    return [...positions].sort((a, b) => a - b)
  }
}
