// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ScreenListValues.swift (MIT).

// Value codecs of the screen items whose size follows from their content
// (docs/protocol/server-screen.md §5.2, §8.5, §8.6): ST_R3INFO IMODEUUIDS2 (a counted list), DYNT
// DYNT_FOCUS_1 (fixed fields, then container ids to the end) and CONTAINER NAME (three
// zero-terminated strings), plus the encoder of KERNEL_VERSION, whose decoder is session.md's
// (`KernelVersion`). Decoders return ranges into the value and never copy it
// (docs/performance.md §3).

import { ByteWriter, WireBytes } from "../wire/index.js"
import { ApplItem } from "./applRegistry.js"
import { ByteRange, ItemPayloadError } from "./diagCodec.js"
import { ZeroTerminated } from "./sessionItems.js"

/** Values the screen-value encoders cannot write. Nothing is appended when one is thrown. */
export type ScreenValueEncodingErrorInfo =
  /**
   * A zero-terminated string contains a zero byte, which would end it early. `index` is the
   * string's 0-based position in the layout.
   */
  | { readonly kind: "zeroByteInString"; readonly index: number }
  /** A counted list has more entries than its count field can declare. */
  | { readonly kind: "tooManyEntries"; readonly count: number; readonly limit: number }
  /** A length-prefixed part would be longer than its length field can declare. */
  | { readonly kind: "tooLong"; readonly length: number; readonly limit: number }
  /** The layout to write is not specified; `issue` names the spec-gap issue. */
  | { readonly kind: "specGap"; readonly issue: number }
  /** The item's value is not a text (`ScreenText.isText`). */
  | { readonly kind: "notAText"; readonly value: ApplItem }

export class ScreenValueEncodingError extends Error {
  constructor(readonly info: ScreenValueEncodingErrorInfo) {
    super(
      info.kind === "notAText"
        ? `screen value encoder: ${ApplItem.displayName(info.value)} is not a text`
        : `screen value encoder: ${JSON.stringify(info)}`
    )
    this.name = "ScreenValueEncodingError"
  }
}

// MARK: - IMODEUUIDS2

const UUID_HALF_SIZE = 8 // not-protocol: storage as two UInt64 words
const UUID_BITS_PER_BYTE = 8n // not-protocol: byte assembly

/**
 * One 16-byte internal-mode UUID (server-screen.md §5.2, PV-0710). The bytes are kept in wire
 * order; what the UUID identifies is not stated.
 */
export class InternalModeUUID {
  /** The UUID's size. */
  static readonly size = 16 // provenance: PV-0710

  /** Bytes 0–7, byte 0 in the most significant position (storage, not a byte-order claim). */
  readonly high: bigint
  /** Bytes 8–15, byte 8 in the most significant position. */
  readonly low: bigint

  constructor(fields: { high: bigint; low: bigint }) {
    this.high = BigInt.asUintN(64, fields.high)
    this.low = BigInt.asUintN(64, fields.low)
  }

  /** The UUID at `offset` of `value`; the caller has checked that 16 bytes are there. */
  static at(value: Uint8Array, offset: number): InternalModeUUID {
    let high = 0n
    let low = 0n
    for (let index = 0; index < UUID_HALF_SIZE; index++) {
      high = (high << UUID_BITS_PER_BYTE) | BigInt(value[offset + index])
      low = (low << UUID_BITS_PER_BYTE) | BigInt(value[offset + UUID_HALF_SIZE + index])
    }
    return new InternalModeUUID({ high, low })
  }

  /** The UUID made of exactly 16 bytes, or undefined for another count. */
  static fromBytes(bytes: Uint8Array): InternalModeUUID | undefined {
    if (bytes.length !== InternalModeUUID.size) return undefined
    return InternalModeUUID.at(bytes, 0)
  }

  /** Appends the 16 bytes in wire order. */
  append(output: ByteWriter): void {
    for (let shift = UUID_HALF_SIZE - 1; shift >= 0; shift--) output.u8(Number((this.high >> (BigInt(shift) * UUID_BITS_PER_BYTE)) & 0xffn))
    for (let shift = UUID_HALF_SIZE - 1; shift >= 0; shift--) output.u8(Number((this.low >> (BigInt(shift) * UUID_BITS_PER_BYTE)) & 0xffn))
  }

  /** The 16 bytes in wire order. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(InternalModeUUID.size)
    this.append(output)
    return output.toBytes()
  }
}

/**
 * One entry of IMODEUUIDS2: a UUID and the byte Wireshark labels "active context" (PV-0710).
 * Neither source says what the byte means beyond its label.
 */
export class InternalModeEntry {
  readonly uuid: InternalModeUUID
  readonly activeContext: number

  constructor(fields: { uuid: InternalModeUUID; activeContext: number }) {
    this.uuid = fields.uuid
    this.activeContext = fields.activeContext
  }
}

/**
 * The value of `ST_R3INFO IMODEUUIDS2` (0x06/0x1F): a u8 count *n*, then *n* entries of a 16-byte
 * UUID followed by a u8 active-context byte, 1 + 17·*n* bytes in all (PV-0710; Wireshark only).
 * Wireshark checks that length exactly; Swooey reports a shorter value as `truncated` and a longer
 * one as `overlong` (IMPL-SS-3).
 *
 * The decoded value holds only the count; `entry` reads an entry from the value on demand.
 */
export class InternalModeUUIDs {
  /** The count field's size. */
  static readonly countSize = 1 // provenance: PV-0710
  /** One entry: the UUID and its active-context byte. */
  static readonly entrySize = InternalModeUUID.size + 1 // provenance: PV-0710
  /** Most entries the u8 count can declare. */
  static readonly maxCount = 0xff // provenance: PV-0710

  private constructor(
    /** The number of entries (byte 0). */
    readonly count: number
  ) {}

  /**
   * Decodes an IMODEUUIDS2 value. Fails with `truncated` when the value is empty or shorter than
   * 1 + 17·*n*, and with `overlong` when it is longer.
   */
  static decode(value: Uint8Array): InternalModeUUIDs {
    if (value.length === 0) throw new ItemPayloadError({ kind: "truncated", needed: InternalModeUUIDs.countSize, available: 0 })
    const count = value[0]
    // At most 1 + 17 · 255 = 4336: no overflow.
    const needed = InternalModeUUIDs.countSize + count * InternalModeUUIDs.entrySize
    if (value.length < needed) throw new ItemPayloadError({ kind: "truncated", needed, available: value.length })
    if (value.length !== needed) throw new ItemPayloadError({ kind: "overlong", expected: needed, actual: value.length })
    return new InternalModeUUIDs(count)
  }

  /** Where entry `index` (0-based) lies in the value. */
  entryRange(index: number): ByteRange {
    if (!(index >= 0 && index < this.count)) throw new Error("IMODEUUIDS2 entry index out of range")
    const start = InternalModeUUIDs.countSize + index * InternalModeUUIDs.entrySize
    return new ByteRange(start, start + InternalModeUUIDs.entrySize)
  }

  /** Entry `index` (0-based), read from `value`, the bytes this was decoded from. */
  entry(index: number, value: Uint8Array): InternalModeEntry {
    const range = this.entryRange(index)
    return new InternalModeEntry({ uuid: InternalModeUUID.at(value, range.lowerBound), activeContext: value[range.upperBound - 1] })
  }

  /** Appends an IMODEUUIDS2 value: the count, then each UUID with its active-context byte. */
  static append(entries: readonly InternalModeEntry[], output: ByteWriter): void {
    if (entries.length > InternalModeUUIDs.maxCount)
      throw new ScreenValueEncodingError({ kind: "tooManyEntries", count: entries.length, limit: InternalModeUUIDs.maxCount })
    output.u8(entries.length)
    for (const entry of entries) {
      entry.uuid.append(output)
      output.u8(entry.activeContext)
    }
  }
}

// MARK: - DYNT_FOCUS_1

/**
 * The value of `DYNT DYNT_FOCUS_1` (0x09/0x0B): a u8 area id, then row, col, row offset and col
 * offset as u16 BE, then zero or more u8 container ids to the end of the value (PV-0711; Wireshark
 * only). There is no count field and no length check: only a value shorter than the 9 fixed bytes
 * is refused (`truncated`).
 *
 * Wireshark labels the first field as the focus number of the area id. What it counts, what the
 * offsets mean, and when a server sends the item are #51; whether a client sends it with input is
 * #33 (client-input.md §9).
 */
export class DyntFocus {
  /** The fixed part before the container ids. */
  static readonly fixedSize = 9 // provenance: PV-0711

  static readonly Offset = {
    areaID: 0, // provenance: PV-0711
    row: 1, // provenance: PV-0711
    col: 3, // provenance: PV-0711
    rowOffset: 5, // provenance: PV-0711
    colOffset: 7 // provenance: PV-0711
  } as const

  private constructor(
    readonly areaID: number,
    readonly row: number,
    readonly col: number,
    readonly rowOffset: number,
    readonly colOffset: number,
    /** The container ids, one byte each: from offset 9 to the end of the value. */
    readonly containerIDs: ByteRange
  ) {}

  /** Decodes a DYNT_FOCUS_1 value of at least 9 bytes. */
  static decode(value: Uint8Array): DyntFocus {
    if (value.length < DyntFocus.fixedSize) throw new ItemPayloadError({ kind: "truncated", needed: DyntFocus.fixedSize, available: value.length })
    const offset = DyntFocus.Offset
    return new DyntFocus(
      value[offset.areaID],
      WireBytes.u16BigEndian(value, offset.row), // provenance: PV-0711
      WireBytes.u16BigEndian(value, offset.col), // provenance: PV-0711
      WireBytes.u16BigEndian(value, offset.rowOffset), // provenance: PV-0711
      WireBytes.u16BigEndian(value, offset.colOffset), // provenance: PV-0711
      new ByteRange(DyntFocus.fixedSize, value.length)
    )
  }

  /** Appends a DYNT_FOCUS_1 value: the five fixed fields, then `containerIDs` verbatim. */
  static append(
    fields: { areaID: number; row: number; col: number; rowOffset: number; colOffset: number; containerIDs: Uint8Array },
    output: ByteWriter
  ): void {
    output.u8(fields.areaID)
    output.u16be(fields.row) // provenance: PV-0711
    output.u16be(fields.col) // provenance: PV-0711
    output.u16be(fields.rowOffset) // provenance: PV-0711
    output.u16be(fields.colOffset) // provenance: PV-0711
    output.bytes(fields.containerIDs)
  }
}

// MARK: - Zero-terminated strings

/** Writing the zero-terminated strings of CONTAINER NAME and KERNEL_VERSION. */
export const ZeroTerminatedWriter = {
  /** The terminator of every zero-terminated string (PV-0713, PV-0535, PV-0718). */
  terminator: 0x00, // provenance: PV-0713, PV-0535, PV-0718

  /** Whether `bytes` holds a zero byte. */
  containsTerminator(bytes: Uint8Array): boolean {
    return bytes.includes(ZeroTerminatedWriter.terminator)
  },

  /** Fails when one of three strings holds a zero byte, naming the first such string. */
  checkThree(first: Uint8Array, second: Uint8Array, third: Uint8Array): void {
    if (ZeroTerminatedWriter.containsTerminator(first)) throw new ScreenValueEncodingError({ kind: "zeroByteInString", index: 0 })
    if (ZeroTerminatedWriter.containsTerminator(second)) throw new ScreenValueEncodingError({ kind: "zeroByteInString", index: 1 })
    if (ZeroTerminatedWriter.containsTerminator(third)) throw new ScreenValueEncodingError({ kind: "zeroByteInString", index: 2 }) // not-protocol: string position
  },

  /** Appends three strings, each followed by one zero byte, or nothing when one of them holds a zero byte. */
  appendThree(first: Uint8Array, second: Uint8Array, third: Uint8Array, output: ByteWriter): void {
    ZeroTerminatedWriter.checkThree(first, second, third)
    output.bytes(first)
    output.u8(ZeroTerminatedWriter.terminator)
    output.bytes(second)
    output.u8(ZeroTerminatedWriter.terminator)
    output.bytes(third)
    output.u8(ZeroTerminatedWriter.terminator)
  }
} as const

/**
 * The value of `CONTAINER NAME` (0x0A/0x06): three zero-terminated strings, in order the subscreen
 * name, the container name and the subdynpro name (PV-0713; Wireshark only). Ranges are offsets
 * into the value, without the zero bytes; the character set is #18.
 *
 * No length check: a string whose zero byte is missing is `truncated`, and bytes after the third
 * zero byte are reported as trailing, not rejected (IMPL-SS-3, #39).
 */
export class ContainerName {
  private constructor(
    readonly subscreenName: ByteRange,
    readonly containerName: ByteRange,
    readonly subdynproName: ByteRange,
    /** Bytes after the third string's zero byte; reported, not interpreted. */
    readonly trailingByteCount: number
  ) {}

  /** Decodes a CONTAINER NAME value. */
  static decode(value: Uint8Array): ContainerName {
    const subscreen = ZeroTerminated.scan(value, 0)
    const container = ZeroTerminated.scan(value, subscreen.next)
    const subdynpro = ZeroTerminated.scan(value, container.next)
    return new ContainerName(subscreen.text, container.text, subdynpro.text, value.length - subdynpro.next)
  }

  /** Appends a CONTAINER NAME value: the three strings, each followed by one zero byte. */
  static append(subscreenName: Uint8Array, containerName: Uint8Array, subdynproName: Uint8Array, output: ByteWriter): void {
    ZeroTerminatedWriter.appendThree(subscreenName, containerName, subdynproName, output)
  }
}

/**
 * Appends a KERNEL_VERSION value (session.md §6.2, PV-0535): the database version, the kernel
 * version and the patch level, each followed by one zero byte. (Swift: `extension KernelVersion`,
 * `KernelVersion.append(databaseVersion:kernelVersion:patchLevel:to:)`.)
 */
export function appendKernelVersion(databaseVersion: Uint8Array, kernelVersion: Uint8Array, patchLevel: Uint8Array, output: ByteWriter): void {
  ZeroTerminatedWriter.appendThree(databaseVersion, kernelVersion, patchLevel, output)
}
