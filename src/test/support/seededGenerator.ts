// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/SeededGenerator.swift (MIT).
//
// Swift's `random(in:using:)` and `Bool.random(using:)` are part of the standard library, not of
// Swooey; the methods below reproduce their algorithms (Lemire's nearly divisionless method over
// the generator's 64-bit output), so that a seed gives the same inputs as in Swooey's tests.

const MASK64 = (1n << 64n) - 1n

/**
 * A deterministic random number generator (SplitMix64) for reproducible robustness tests. The
 * same seed gives the same sequence on every platform.
 */
export class SeededGenerator {
  private state: bigint

  constructor(seed: bigint | number) {
    this.state = BigInt.asUintN(64, BigInt(seed))
  }

  /** The next 64-bit value. */
  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64
    let z = this.state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64
    return z ^ (z >> 31n)
  }

  /** Swift `next(upperBound:)` for an unsigned type of `bits` bits: a value in `0 ..< upperBound`. */
  private nextBelow(upperBound: bigint, bits: bigint): bigint {
    if (upperBound === 0n) throw new Error("upperBound cannot be zero")
    const mask = (1n << bits) - 1n
    let m = (this.next() & mask) * upperBound
    if ((m & mask) < upperBound) {
      const t = ((1n << bits) - upperBound) % upperBound
      while ((m & mask) < t) m = (this.next() & mask) * upperBound
    }
    return m >> bits
  }

  /** Swift `random(in: lower ... upper)` for an integer type of `bits` bits. */
  private closed(lower: number, upper: number, bits: bigint): number {
    if (upper < lower) throw new Error(`empty range ${lower}...${upper}`)
    const delta = BigInt(upper) - BigInt(lower)
    if (delta === (1n << bits) - 1n) return Number(BigInt(lower) + (this.next() & delta))
    return Number(BigInt(lower) + this.nextBelow(delta + 1n, bits))
  }

  /** Swift `random(in: lower ..< upper)` for an integer type of `bits` bits. */
  private halfOpen(lower: number, upper: number, bits: bigint): number {
    if (upper <= lower) throw new Error(`empty range ${lower}..<${upper}`)
    return Number(BigInt(lower) + this.nextBelow(BigInt(upper) - BigInt(lower), bits))
  }

  /** `Int.random(in: lower ... upper, using:)` */
  int(lower: number, upper: number): number {
    return this.closed(lower, upper, 64n)
  }

  /** `Int.random(in: lower ..< upper, using:)` */
  intBelow(lower: number, upper: number): number {
    return this.halfOpen(lower, upper, 64n)
  }

  /** `UInt8.random(in: lower ... upper, using:)`; the whole range by default. */
  uint8(lower = 0, upper = 0xff): number {
    return this.closed(lower, upper, 8n)
  }

  /** `UInt8.random(in: lower ..< upper, using:)` */
  uint8Below(lower: number, upper: number): number {
    return this.halfOpen(lower, upper, 8n)
  }

  /** `UInt32.random(in: lower ... upper, using:)` */
  uint32(lower: number, upper: number): number {
    return this.closed(lower, upper, 32n)
  }

  /** `Bool.random(using:)`: bit 17 of the next value is clear. */
  bool(): boolean {
    return ((this.next() >> 17n) & 1n) === 0n
  }

  /** `count` random bytes. */
  bytes(count: number): Uint8Array {
    const output = new Uint8Array(count)
    for (let index = 0; index < count; index++) output[index] = this.uint8()
    return output
  }

  /**
   * A copy of `input` with a few random mutations: byte flips, bit flips, insertions, deletions
   * and truncation.
   */
  mutate(input: ArrayLike<number>): Uint8Array {
    const output = Array.from(input)
    for (let round = this.int(1, 4); round > 0; round--) {
      switch (this.intBelow(0, 5)) {
        case 0:
          if (output.length === 0) break
          {
            const index = this.intBelow(0, output.length)
            output[index] = this.uint8()
          }
          break
        case 1:
          if (output.length === 0) break
          {
            const index = this.intBelow(0, output.length)
            output[index] ^= 1 << this.uint8Below(0, 8)
          }
          break
        case 2: {
          const byte = this.uint8()
          output.splice(this.int(0, output.length), 0, byte)
          break
        }
        case 3:
          if (output.length === 0) break
          output.splice(this.intBelow(0, output.length), 1)
          break
        case 4:
          if (output.length === 0) break
          output.length -= this.int(0, output.length)
          break
      }
    }
    return Uint8Array.from(output)
  }

  /** Random ascending cut positions strictly inside `0 ..< count`, splitting it into reads. */
  cuts(count: number): number[] {
    if (count <= 1) return []
    const pieces = this.int(0, Math.min(count - 1, 8))
    const cuts = new Set<number>()
    for (let i = 0; i < pieces; i++) cuts.add(this.intBelow(1, count))
    return [...cuts].sort((a, b) => a - b)
  }
}
