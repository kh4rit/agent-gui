// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/NIFraming.swift (MIT).

import { WireBytes } from "./bytes.js"

/**
 * Layout of an NI frame: a u32 BE length field, then that many payload bytes
 * (docs/protocol/ni-framing.md, "Frame layout").
 */
export const NIFraming = {
  /** Size of the length field at offset 0 of every frame. */
  lengthFieldSize: 4, // provenance: PV-0001

  /**
   * Default cap on the declared payload length of one frame (IMPL-NI-1). Project policy, not a
   * protocol value. A declared length above the cap fails before any byte of the frame is
   * buffered for it; a length of 0 is a valid, empty frame.
   */
  defaultMaxPayloadLength: 16 << 20, // not-protocol: size cap, 16 MiB (IMPL-NI-1)

  /** Reads the length field at `offset` (u32 BE, counting the payload only). */
  readLength(bytes: Uint8Array, offset: number): number {
    // The length is big-endian (PV-0002) and counts the payload only (PV-0003).
    return WireBytes.u32BigEndian(bytes, offset) // provenance: PV-0002, PV-0003
  }
} as const

/** A complete NI frame taken from a byte stream. */
export interface NIFrame {
  /** Offset in the stream of the frame's first byte (its length field). */
  readonly streamOffset: number
  /** The payload, without the length field. */
  readonly payload: Uint8Array
}

/** Offset in the stream of the first payload byte. */
export const payloadStreamOffset = (frame: NIFrame): number => frame.streamOffset + NIFraming.lengthFieldSize

/** The failures of the NI framer and frame encoder. */
export type NIFrameErrorInfo =
  /**
   * A frame declares a payload longer than the decoder's cap (IMPL-NI-1). The stream cannot be
   * resynchronised, so the decoder stays failed; the connection must be closed.
   */
  | { kind: "lengthOverCap"; declaredLength: number; cap: number; streamOffset: number }
  /** The stream ended inside a frame (IMPL-NI-6). */
  | { kind: "truncated"; streamOffset: number; bufferedByteCount: number }
  /** An outgoing payload is longer than the encoder's cap, or than a u32 length can express. */
  | { kind: "payloadOverCap"; length: number; cap: number }

export class NIFrameError extends Error {
  constructor(readonly info: NIFrameErrorInfo) {
    super(describeNIFrameError(info))
    this.name = "NIFrameError"
  }
}

function describeNIFrameError(info: NIFrameErrorInfo): string {
  switch (info.kind) {
    case "lengthOverCap":
      return `NI frame at stream offset ${info.streamOffset} declares ${info.declaredLength} bytes, over the cap of ${info.cap}`
    case "truncated":
      return `the stream ended inside an NI frame at offset ${info.streamOffset} (${info.bufferedByteCount} bytes buffered)`
    case "payloadOverCap":
      return `outgoing NI payload of ${info.length} bytes is over the cap of ${info.cap}`
  }
}
