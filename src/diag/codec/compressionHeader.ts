// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/CompressionHeader.swift (MIT).

import { CompressedDataError, LZCDecoder, LZCParameters, LZHDecoder } from "../compression/index.js"
import { ByteWriter, WireBytes } from "../wire/index.js"
import { isUInt32 } from "./diagCodec.js"

/**
 * Layout and values of the 8-byte compression header (docs/protocol/compression-header.md).
 * maxbits and the block-mode flag of LZC byte 7 are read with DiagCompression's `LZCParameters`,
 * which defines those two constants (PV-0310, PV-0312) once.
 */
export const CompressionHeaderLayout = {
  size: 8, // provenance: PV-0060
  uncompressedLength: 0, // provenance: PV-0061
  algorithmByte: 4, // provenance: PV-0063
  magicFirst: 5, // provenance: PV-0067
  magicSecond: 6, // provenance: PV-0067
  byte7: 7, // provenance: PV-0068, PV-0069
  magic: { first: 0x1f, second: 0x9d }, // provenance: PV-0067
  /** The algorithm is the low nibble of byte 4; decoders dispatch on it alone. */
  algorithmMask: 0x0f, // provenance: PV-0063
  /** The version is the high nibble of byte 4. */
  versionShift: 4, // provenance: PV-0063
  /** Largest value the 4-bit version nibble can hold. */
  versionMax: 0x0f, // provenance: PV-0063
  lzcAlgorithm: 1, // provenance: PV-0065
  lzhAlgorithm: 2, // provenance: PV-0064
  /** Version nibble of both known algorithm bytes (0x11 and 0x12). */
  knownVersion: 1, // provenance: PV-0066
  /** LZH byte 7: the level; Swooey's encoder writes 2, as a compressing DIAG client does. */
  lzhLevel: 2, // provenance: PV-0068, PV-0316
  /** LZC byte 7: bits 0x20 and 0x40 are unused and ignored (IMPL-CH-9). */
  lzcUnusedBits: 0x60 // provenance: PV-0313
} as const

/**
 * The compression algorithm, selected by the low nibble of byte 4 (never by the whole byte: both
 * sources' display tables label 0x10 "LZC", but 0x10 has nibble 0 and names no algorithm).
 * `lzc`: nibble 1 (byte 0x11), compression-lzc.md; `lzh`: nibble 2 (byte 0x12), compression-lzh.md.
 */
export type CompressionAlgorithm = "lzc" | "lzh"

export const CompressionAlgorithm = {
  allCases: ["lzc", "lzh"] as readonly CompressionAlgorithm[],

  /** The algorithm nibble. */
  nibble(algorithm: CompressionAlgorithm): number {
    return algorithm === "lzc" ? CompressionHeaderLayout.lzcAlgorithm : CompressionHeaderLayout.lzhAlgorithm
  },

  /** The algorithm of a nibble, or undefined. */
  fromNibble(nibble: number): CompressionAlgorithm | undefined {
    if (nibble === CompressionHeaderLayout.lzcAlgorithm) return "lzc"
    if (nibble === CompressionHeaderLayout.lzhAlgorithm) return "lzh"
    return undefined
  }
} as const

/** Failures of the structural header parse, `CompressionHeader.parse`: steps 1–3 of IMPL-CH-4. */
export type CompressionHeaderErrorInfo =
  /** Fewer than 8 bytes are present. [`truncated`] */
  | { readonly kind: "truncated"; readonly availableByteCount: number }
  /** Bytes 5–6 are not `1F 9D` (IMPL-CH-2). [`bad-magic`] */
  | { readonly kind: "badMagic"; readonly first: number; readonly second: number }
  /** The low nibble of byte 4 is neither 1 (LZC) nor 2 (LZH) (IMPL-CH-1). Carries the whole byte. [`unknown-algorithm`] */
  | { readonly kind: "unknownAlgorithm"; readonly byte: number }

export class CompressionHeaderError extends Error {
  constructor(readonly info: CompressionHeaderErrorInfo) {
    super(describeHeaderFault(info))
    this.name = "CompressionHeaderError"
  }
}

/**
 * Failures of the header decoder, `CompressionHeader.decode`, in the check order of IMPL-CH-4.
 * The vector error class of each case is given in brackets.
 */
export type CompressionHeaderDecodingErrorInfo =
  | CompressionHeaderErrorInfo
  /** LZC only: maxbits (byte 7 & 0x1F) is outside 9–16 (PV-0311, R-CH-5). Carries maxbits. [`bad-maxbits`] */
  | { readonly kind: "badMaxbits"; readonly maxbits: number }

export class CompressionHeaderDecodingError extends Error {
  constructor(readonly info: CompressionHeaderDecodingErrorInfo) {
    super(info.kind === "badMaxbits" ? `compression header: LZC maxbits ${info.maxbits} outside 9-16` : describeHeaderFault(info))
    this.name = "CompressionHeaderDecodingError"
  }
}

function describeHeaderFault(info: CompressionHeaderErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return `compression header truncated: ${info.availableByteCount} bytes`
    case "badMagic":
      return `compression header: bad magic ${info.first} ${info.second}`
    case "unknownAlgorithm":
      return `compression header: unknown algorithm byte ${info.byte}`
  }
}

/** Values the compression header encoder cannot write. */
export type CompressionHeaderEncodingErrorInfo =
  /** The version does not fit the 4-bit version nibble. */
  | { readonly kind: "versionOutOfRange"; readonly value: number }
  /** An LZC maxbits outside 9–16 (PV-0311). */
  | { readonly kind: "maxbitsOutOfRange"; readonly value: number }
  /** LZC unused bits other than 0x20 and 0x40 (PV-0313). */
  | { readonly kind: "unusedBitsOutOfRange"; readonly value: number }

export class CompressionHeaderEncodingError extends Error {
  constructor(readonly info: CompressionHeaderEncodingErrorInfo) {
    super(`compression header encoder: ${info.kind} (${info.value})`)
    this.name = "CompressionHeaderEncodingError"
  }
}

/** The fields of a compression header, for `CompressionHeader.of`. */
export interface CompressionHeaderFields {
  uncompressedLength: number
  version: number
  algorithm: CompressionAlgorithm
  byte7: number
}

/**
 * The 8-byte compression header that follows a DIAG header whose compress byte is 1
 * (docs/protocol/compression-header.md). The compressed data follows it directly and runs to the
 * end of the frame (PV-0350).
 */
export class CompressionHeader {
  /** Size of the header. */
  static readonly size = CompressionHeaderLayout.size
  /** The version nibble of both known algorithm bytes, the one encoders write (PV-0066). */
  static readonly knownVersion = CompressionHeaderLayout.knownVersion
  /** The LZH level Swooey's encoder writes (PV-0068, PV-0316). */
  static readonly defaultLZHLevel = CompressionHeaderLayout.lzhLevel

  /**
   * Bytes 0–3, u32 LE: the exact length the data decompresses to (R-CH-3, PV-0314). 0 is legal
   * here; the data must then decompress to nothing.
   */
  readonly uncompressedLength: number
  /**
   * High nibble of byte 4. Only 1 is known; other values are reported, not rejected, and the
   * algorithm is still chosen by the low nibble (IMPL-CH-8, provisional until #25).
   */
  readonly version: number
  /** Low nibble of byte 4. */
  readonly algorithm: CompressionAlgorithm
  /** Byte 7 as received: the LZH level, or LZC maxbits, block-mode flag and unused bits. */
  readonly byte7: number

  /** The unchecked memberwise init (Swift's private `init(uncompressedLength:uncheckedVersion:…)`). */
  private constructor(uncompressedLength: number, version: number, algorithm: CompressionAlgorithm, byte7: number) {
    if (!isUInt32(uncompressedLength)) throw new Error(`uncompressedLength ${uncompressedLength} is not a u32`)
    this.uncompressedLength = uncompressedLength
    this.version = version & 0xff
    this.algorithm = algorithm
    this.byte7 = byte7 & 0xff
  }

  // MARK: Decoding

  /**
   * The structural parse: steps 1–3 of IMPL-CH-4 (at least 8 bytes, magic, algorithm nibble).
   * LZC maxbits is reported by `maxbits` but not range-checked here; `decode` is the full header
   * decoder. Bytes after the header are ignored.
   */
  static parse(bytes: Uint8Array): CompressionHeader {
    if (bytes.length < CompressionHeaderLayout.size)
      throw new CompressionHeaderError({ kind: "truncated", availableByteCount: bytes.length })
    const first = bytes[CompressionHeaderLayout.magicFirst]
    const second = bytes[CompressionHeaderLayout.magicSecond]
    if (first !== CompressionHeaderLayout.magic.first || second !== CompressionHeaderLayout.magic.second)
      throw new CompressionHeaderError({ kind: "badMagic", first, second })
    const algorithmByte = bytes[CompressionHeaderLayout.algorithmByte]
    const algorithm = CompressionAlgorithm.fromNibble(algorithmByte & CompressionHeaderLayout.algorithmMask)
    if (algorithm === undefined) throw new CompressionHeaderError({ kind: "unknownAlgorithm", byte: algorithmByte })
    // PV-0062: the uncompressed length is an unsigned little-endian 32-bit integer.
    const uncompressedLength = WireBytes.u32LittleEndian(bytes, CompressionHeaderLayout.uncompressedLength) // provenance: PV-0061, PV-0062
    return new CompressionHeader(
      uncompressedLength,
      algorithmByte >> CompressionHeaderLayout.versionShift,
      algorithm,
      bytes[CompressionHeaderLayout.byte7]
    )
  }

  /**
   * The header decoder (IMPL-CH-4): at least 8 bytes, the magic, the algorithm nibble, then for
   * LZC only maxbits in 9–16 (R-CH-5). A pure function of its input; bytes after the header are
   * ignored. Each failure names the first check that failed.
   */
  static decode(bytes: Uint8Array): CompressionHeader {
    let header: CompressionHeader
    try {
      header = CompressionHeader.parse(bytes)
    } catch (error) {
      if (error instanceof CompressionHeaderError) throw new CompressionHeaderDecodingError(error.info)
      throw error
    }
    if (header.algorithm === "lzc") {
      const maxbits = LZCParameters.maxbits(header.byte7) // provenance: PV-0310
      try {
        LZCParameters.fromHeaderByte7(header.byte7) // provenance: PV-0311
      } catch (error) {
        if (error instanceof CompressedDataError) throw new CompressionHeaderDecodingError({ kind: "badMaxbits", maxbits })
        throw error
      }
    }
    return header
  }

  // MARK: Encoding

  /** A header from its fields. `byte7` is written as given. */
  static of(fields: CompressionHeaderFields): CompressionHeader {
    if (!(fields.version >= 0 && fields.version <= CompressionHeaderLayout.versionMax))
      throw new CompressionHeaderEncodingError({ kind: "versionOutOfRange", value: fields.version })
    return new CompressionHeader(fields.uncompressedLength, fields.version, fields.algorithm, fields.byte7)
  }

  /**
   * The LZH header of a compressed client message: version 1, byte 4 = 0x12, level 2
   * (PV-0316, IMPL-CH-7). Always valid, so it cannot fail.
   */
  static clientLZH(uncompressedLength: number): CompressionHeader {
    return new CompressionHeader(uncompressedLength, CompressionHeaderLayout.knownVersion, "lzh", CompressionHeaderLayout.lzhLevel)
  }

  /**
   * An LZH header: byte 4 = (version << 4) | 2, byte 7 = `level`. The defaults are what a
   * compressing DIAG client writes: version 1, level 2 (PV-0316, IMPL-CH-7).
   */
  static lzh(uncompressedLength: number, options: { level?: number; version?: number } = {}): CompressionHeader {
    return CompressionHeader.of({
      uncompressedLength,
      version: options.version ?? CompressionHeader.knownVersion,
      algorithm: "lzh",
      byte7: options.level ?? CompressionHeader.defaultLZHLevel
    })
  }

  /**
   * An LZC header: byte 7 = maxbits | unusedBits | (blockMode << 7) (PV-0069). `maxbits` must lie
   * in 9–16 and `unusedBits` within 0x60. Swooey does not encode LZC; this exists to reproduce
   * received headers (the fake server, tests), so `unusedBits` can be set, although an encoder
   * following E-LZC-1 leaves those bits clear. Defaults: block mode on, no unused bits, version 1.
   */
  static lzc(
    uncompressedLength: number,
    maxbits: number,
    options: { blockMode?: boolean; unusedBits?: number; version?: number } = {}
  ): CompressionHeader {
    const unusedBits = options.unusedBits ?? 0
    let parameters: LZCParameters
    try {
      parameters = new LZCParameters(maxbits, options.blockMode ?? true)
    } catch (error) {
      if (error instanceof CompressedDataError) throw new CompressionHeaderEncodingError({ kind: "maxbitsOutOfRange", value: maxbits })
      throw error
    }
    if ((unusedBits & ~CompressionHeaderLayout.lzcUnusedBits & 0xff) !== 0)
      throw new CompressionHeaderEncodingError({ kind: "unusedBitsOutOfRange", value: unusedBits })
    return CompressionHeader.of({
      uncompressedLength,
      version: options.version ?? CompressionHeader.knownVersion,
      algorithm: "lzc",
      byte7: parameters.headerByte7 | unusedBits
    })
  }

  // MARK: Fields

  /**
   * Whether the version nibble is the only known one, 1 (PV-0066). A header with another version
   * still decodes (IMPL-CH-8); the session logs a diagnostic once per connection (#25).
   */
  get hasKnownVersion(): boolean {
    return this.version === CompressionHeaderLayout.knownVersion
  }

  /** LZH: byte 7, the level (reported, never checked: IMPL-CH-3, PV-0068). Undefined for LZC. */
  get level(): number | undefined {
    return this.algorithm === "lzh" ? this.byte7 : undefined
  }

  /**
   * LZC: maxbits, byte 7 & 0x1F (PV-0310, R-CH-5 as corrected in v1). `decode` has checked that
   * it lies in 9–16; `parse` has not. Undefined for LZH.
   */
  get maxbits(): number | undefined {
    return this.algorithm === "lzc" ? LZCParameters.maxbits(this.byte7) : undefined
  }

  /** LZC: the block-mode flag, bit 0x80 of byte 7 (PV-0312); a clear flag is valid. Undefined for LZH. */
  get blockMode(): boolean | undefined {
    return this.algorithm === "lzc" ? LZCParameters.blockMode(this.byte7) : undefined
  }

  /**
   * LZC: bits 0x20 and 0x40 of byte 7, which decoders ignore and which are reported only for the
   * debug view (PV-0313, IMPL-CH-9). Undefined for LZH.
   */
  get unusedBits(): number | undefined {
    return this.algorithm === "lzc" ? this.byte7 & CompressionHeaderLayout.lzcUnusedBits : undefined
  }

  /**
   * LZC: the decoder parameters of byte 7; throws `CompressedDataError` `badMaxbits` when maxbits
   * is outside 9–16. Undefined for LZH.
   */
  lzcParameters(): LZCParameters | undefined {
    if (this.algorithm !== "lzc") return undefined
    return LZCParameters.fromHeaderByte7(this.byte7)
  }

  /** Byte 4: (version << 4) | algorithm. */
  get algorithmByte(): number {
    return ((this.version << CompressionHeaderLayout.versionShift) | CompressionAlgorithm.nibble(this.algorithm)) & 0xff
  }

  /** Appends the 8 header bytes. */
  serialize(output: ByteWriter): void {
    WireBytes.appendU32LittleEndian(this.uncompressedLength, output) // provenance: PV-0061, PV-0062
    output.u8(this.algorithmByte)
    output.u8(CompressionHeaderLayout.magic.first)
    output.u8(CompressionHeaderLayout.magic.second)
    output.u8(this.byte7)
  }

  /** The header's 8 bytes. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(CompressionHeaderLayout.size)
    this.serialize(output)
    return output.toBytes()
  }
}

// MARK: - Decompression

/**
 * Decompresses the data of compressed messages with DiagCompression's LZH and LZC decoders
 * (compression-lzh.md, compression-lzc.md). Keep one per connection: the decoders' tables are
 * reused.
 *
 * The declared uncompressed length is compared with `maxUncompressedLength` before any output
 * memory is reserved (IMPL-CH-5), and the data must decompress to exactly that length (PV-0314).
 * A failure aborts that message only and gives no output (IMPL-CH-6).
 *
 * Swift decompresses into a caller's `inout [UInt8]`, emptied on failure; the port returns the
 * output and throws on failure (the decoders' TypeScript API returns their output).
 */
export class Decompressor {
  /**
   * Default cap on the declared uncompressed length (IMPL-CH-5). Not a protocol value: the spec
   * states no limit below the u32 range (PV-0062).
   */
  static readonly defaultMaxUncompressedLength = 64 * 1024 * 1024 // not-protocol: output size cap, 64 MiB (IMPL-CH-5)

  /** The cap on declared uncompressed lengths. */
  maxUncompressedLength: number
  /** Created on the first LZH message: its tables take about 66 KB. */
  private lzh: LZHDecoder | undefined
  private readonly lzc = new LZCDecoder()

  constructor(maxUncompressedLength: number = Decompressor.defaultMaxUncompressedLength) {
    this.maxUncompressedLength = maxUncompressedLength
  }

  /**
   * Decompresses `data`, the bytes after the compression header up to the end of the frame. On
   * success returns exactly `header.uncompressedLength` bytes: the item sequence, or for a
   * message with err_no ≠ 0 the error body (R-CH-2). On failure throws `CompressedDataError`.
   *
   * The header should come from `CompressionHeader.decode`; a header from the structural parse
   * with an LZC maxbits outside 9–16 fails here with `badMaxbits`.
   */
  decompress(data: Uint8Array, header: CompressionHeader): Uint8Array {
    switch (header.algorithm) {
      case "lzh":
        if (this.lzh === undefined) this.lzh = new LZHDecoder()
        return this.lzh.decode(data, header.uncompressedLength, this.maxUncompressedLength)
      case "lzc": {
        const parameters = LZCParameters.fromHeaderByte7(header.byte7)
        return this.lzc.decode(data, parameters, header.uncompressedLength, this.maxUncompressedLength)
      }
    }
  }
}

/**
 * One-shot decompression with fresh decoders. Sessions keep a `Decompressor` per connection
 * instead, which reuses its tables.
 */
export const Decompression = {
  /** Default cap on the declared uncompressed length (IMPL-CH-5; not a protocol value). */
  defaultMaxUncompressedLength: Decompressor.defaultMaxUncompressedLength,

  /**
   * Decompresses `data` (the bytes after the compression header, to the end of the frame). The
   * declared length is checked against the cap before anything is allocated (IMPL-CH-5).
   */
  decompress(
    data: Uint8Array,
    header: CompressionHeader,
    maxUncompressedLength: number = Decompressor.defaultMaxUncompressedLength
  ): Uint8Array {
    return new Decompressor(maxUncompressedLength).decompress(data, header)
  }
} as const
