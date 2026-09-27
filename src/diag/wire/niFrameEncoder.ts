// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/NIFrameEncoder.swift (MIT).

import { ByteWriter, WireBytes } from "./bytes.js"
import { NIFrameError, NIFraming } from "./niFraming.js"

/**
 * NI frame encoder (docs/protocol/ni-framing.md, "Writing frames").
 *
 * Writes the payload length as u32 BE, then the payload, into one contiguous buffer so that the
 * caller can send the frame with a single socket write (IMPL-NI-5). Outgoing payloads are checked
 * against a cap (IMPL-NI-1); a payload a u32 length cannot express is always rejected too.
 */
export class NIFrameEncoder {
  constructor(readonly maxPayloadLength: number = NIFraming.defaultMaxPayloadLength) {}

  /** Appends one frame carrying `payload` to `output`. */
  encodeInto(payload: Uint8Array, output: ByteWriter): void {
    const length = this.checkedLength(payload.length)
    // PV-0001..PV-0003: a 4-byte u32 BE length counting the payload only, then the payload.
    WireBytes.appendU32BigEndian(length, output) // provenance: PV-0001, PV-0002, PV-0003
    output.bytes(payload)
  }

  /** Returns one frame carrying `payload`. */
  encode(payload: Uint8Array): Uint8Array {
    const output = new ByteWriter(NIFraming.lengthFieldSize + payload.length)
    this.encodeInto(payload, output)
    return output.toBytes()
  }

  private checkedLength(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 0xffffffff || count > this.maxPayloadLength)
      throw new NIFrameError({ kind: "payloadOverCap", length: count, cap: this.maxPayloadLength })
    return count
  }
}
