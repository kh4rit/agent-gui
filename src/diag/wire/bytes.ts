// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/WireBytes.swift (MIT), plus the helpers the TypeScript
// port needs in place of Swift's fixed-width integers and growable [UInt8].

/**
 * Fixed-width integer reads and writes shared by the codec modules.
 *
 * Callers check that `offset .. offset + 4` lies inside the bytes before calling; a read past the
 * end throws instead of returning garbage. Which byte order a field uses is a protocol fact and is
 * annotated at each call site.
 */
export const WireBytes = {
  /** Reads an unsigned 16-bit integer, most significant byte first. */
  u16BigEndian(bytes: Uint8Array, offset: number): number {
    checkRange(bytes, offset, 2)
    return (bytes[offset] << 8) | bytes[offset + 1] // not-protocol: byte assembly
  },

  /** Reads an unsigned 16-bit integer, least significant byte first. */
  u16LittleEndian(bytes: Uint8Array, offset: number): number {
    checkRange(bytes, offset, 2)
    return bytes[offset] | (bytes[offset + 1] << 8) // not-protocol: byte assembly
  },

  /** Reads an unsigned 32-bit integer, most significant byte first. */
  u32BigEndian(bytes: Uint8Array, offset: number): number {
    checkRange(bytes, offset, 4)
    return (
      ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0 // not-protocol: byte assembly
    )
  },

  /** Reads an unsigned 32-bit integer, least significant byte first. */
  u32LittleEndian(bytes: Uint8Array, offset: number): number {
    checkRange(bytes, offset, 4)
    return (
      (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0 // not-protocol: byte assembly
    )
  },

  /** Appends `value` most significant byte first. */
  appendU32BigEndian(value: number, output: ByteWriter): void {
    output.u32be(value)
  },

  /** Appends `value` least significant byte first. */
  appendU32LittleEndian(value: number, output: ByteWriter): void {
    output.u32le(value)
  },

  /** Whether `bytes` starts with `prefix`. */
  hasPrefix(bytes: Uint8Array, prefix: ArrayLike<number>): boolean {
    if (bytes.length < prefix.length) return false
    for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false
    return true
  }
} as const

function checkRange(bytes: Uint8Array, offset: number, width: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset + width > bytes.length)
    throw new RangeError(`read of ${width} bytes at offset ${offset} outside ${bytes.length} bytes`)
}

/**
 * A growable byte buffer: the TypeScript stand-in for appending to a Swift `[UInt8]`.
 * Values are truncated to their width (Swift's `truncatingIfNeeded`).
 */
export class ByteWriter {
  private buffer: Uint8Array
  private used = 0

  constructor(capacity = 64) {
    this.buffer = new Uint8Array(Math.max(16, capacity))
  }

  /** Number of bytes written so far. */
  get length(): number {
    return this.used
  }

  private reserve(extra: number) {
    const needed = this.used + extra
    if (needed <= this.buffer.length) return
    let size = this.buffer.length * 2
    while (size < needed) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.buffer.subarray(0, this.used))
    this.buffer = grown
  }

  u8(value: number): this {
    this.reserve(1)
    this.buffer[this.used++] = value & 0xff
    return this
  }

  u16be(value: number): this {
    this.reserve(2)
    this.buffer[this.used++] = (value >>> 8) & 0xff // not-protocol: byte assembly
    this.buffer[this.used++] = value & 0xff
    return this
  }

  u16le(value: number): this {
    this.reserve(2)
    this.buffer[this.used++] = value & 0xff
    this.buffer[this.used++] = (value >>> 8) & 0xff // not-protocol: byte assembly
    return this
  }

  u32be(value: number): this {
    this.reserve(4)
    this.buffer[this.used++] = (value >>> 24) & 0xff // not-protocol: byte assembly
    this.buffer[this.used++] = (value >>> 16) & 0xff // not-protocol: byte assembly
    this.buffer[this.used++] = (value >>> 8) & 0xff // not-protocol: byte assembly
    this.buffer[this.used++] = value & 0xff
    return this
  }

  u32le(value: number): this {
    this.reserve(4)
    this.buffer[this.used++] = value & 0xff
    this.buffer[this.used++] = (value >>> 8) & 0xff // not-protocol: byte assembly
    this.buffer[this.used++] = (value >>> 16) & 0xff // not-protocol: byte assembly
    this.buffer[this.used++] = (value >>> 24) & 0xff // not-protocol: byte assembly
    return this
  }

  /** Appends bytes (any array-like of byte values). */
  bytes(values: ArrayLike<number>): this {
    this.reserve(values.length)
    if (values instanceof Uint8Array) this.buffer.set(values, this.used)
    else for (let i = 0; i < values.length; i++) this.buffer[this.used + i] = values[i] & 0xff
    this.used += values.length
    return this
  }

  /** Appends `count` copies of `value`. */
  repeat(value: number, count: number): this {
    this.reserve(count)
    this.buffer.fill(value & 0xff, this.used, this.used + count)
    this.used += count
    return this
  }

  /** Overwrites one byte already written. */
  setU8(offset: number, value: number): void {
    if (offset < 0 || offset >= this.used) throw new RangeError(`byte ${offset} not written yet`)
    this.buffer[offset] = value & 0xff
  }

  /** Overwrites a u32 BE already written (for back-patched lengths). */
  setU32be(offset: number, value: number): void {
    if (offset < 0 || offset + 4 > this.used) throw new RangeError(`bytes ${offset}+4 not written yet`)
    this.buffer[offset] = (value >>> 24) & 0xff // not-protocol: byte assembly
    this.buffer[offset + 1] = (value >>> 16) & 0xff // not-protocol: byte assembly
    this.buffer[offset + 2] = (value >>> 8) & 0xff // not-protocol: byte assembly
    this.buffer[offset + 3] = value & 0xff
  }

  /** Overwrites a u16 BE already written (for back-patched lengths). */
  setU16be(offset: number, value: number): void {
    if (offset < 0 || offset + 2 > this.used) throw new RangeError(`bytes ${offset}+2 not written yet`)
    this.buffer[offset] = (value >>> 8) & 0xff // not-protocol: byte assembly
    this.buffer[offset + 1] = value & 0xff
  }

  /** The bytes written so far, as an owned copy. */
  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.used)
  }
}

/** Reinterprets an unsigned 32-bit value as signed (Swift `Int32(bitPattern:)`). */
export const toInt32 = (u: number): number => u | 0

/** Reinterprets an unsigned 16-bit value as signed (Swift `Int16(bitPattern:)`). */
export const toInt16 = (u: number): number => ((u & 0xffff) << 16) >> 16

/** Reinterprets an unsigned 8-bit value as signed (Swift `Int8(bitPattern:)`). */
export const toInt8 = (u: number): number => ((u & 0xff) << 24) >> 24

/** Byte-wise equality of two byte arrays. */
export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Concatenates byte arrays. */
export function concatBytes(...parts: ArrayLike<number>[]): Uint8Array {
  const w = new ByteWriter(parts.reduce((n, p) => n + p.length, 0))
  for (const p of parts) w.bytes(p)
  return w.toBytes()
}

/** The bytes of an ASCII string (every character must be below 0x80). */
export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c > 0x7f) throw new RangeError(`non-ASCII character in ${JSON.stringify(text)}`)
    out[i] = c
  }
  return out
}

/** `4E 49 5F …` (uppercase, single spaces), or `none` for no bytes (Swooey's HexText.format). */
export function hexText(bytes: ArrayLike<number>): string {
  if (bytes.length === 0) return "none"
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i++) parts.push(hexByte(bytes[i]))
  return parts.join(" ")
}

/** Two uppercase hex digits. */
export function hexByte(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, "0")
}
