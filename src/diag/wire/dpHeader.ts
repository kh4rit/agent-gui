// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/DPHeader.swift (MIT).

import { ByteWriter, WireBytes, toInt16, toInt32 } from "./bytes.js"
import { DPTerminalName } from "./dpTerminalName.js"

/** The 25 fields of the 200-byte DP header, in wire order (docs/protocol/dp-header.md, "Layout"). */
export type DPHeaderField =
  | "requestID" | "retcode" | "senderID" | "actionType" | "reqInfo" | "tid" | "uid" | "mode" | "wpID" | "wpCaBlk" | "appcCaBlk"
  | "length" | "newStat" | "unused1" | "rqID" | "unused2" | "terminal"
  | "unused3" | "unused4" | "unused5" | "unused6" | "unused7" | "unused8" | "unused9" | "unused10"

interface FieldInfo {
  /** The field's name as dp-header.md writes it. */
  name: string
  /** Offset of the field's first byte in the DP header. */
  offset: number
  /** The field's width in bytes. */
  size: number
  /**
   * The value every byte of the field has in the client's first message ("First-message
   * template"), or undefined for the two fields the encoder fills in: the length (IMPL-DP-2) and
   * the terminal name (IMPL-DP-4).
   */
  templateFill: number | undefined
}

const FIELDS: Record<DPHeaderField, FieldInfo> = {
  requestID: { name: "request_id", offset: 0, size: 4, templateFill: 0xff }, // provenance: PV-0210, PV-0240
  retcode: { name: "retcode", offset: 4, size: 1, templateFill: 0x0a }, // provenance: PV-0211, PV-0241
  senderID: { name: "sender_id", offset: 5, size: 1, templateFill: 0x00 }, // provenance: PV-0212, PV-0242
  actionType: { name: "action_type", offset: 6, size: 1, templateFill: 0x00 }, // provenance: PV-0213, PV-0243
  reqInfo: { name: "req_info", offset: 7, size: 4, templateFill: 0x00 }, // provenance: PV-0214, PV-0244
  tid: { name: "tid", offset: 11, size: 4, templateFill: 0xff }, // provenance: PV-0215, PV-0245
  uid: { name: "uid", offset: 15, size: 2, templateFill: 0xff }, // provenance: PV-0216, PV-0246
  mode: { name: "mode", offset: 17, size: 1, templateFill: 0xff }, // provenance: PV-0217, PV-0247
  wpID: { name: "wp_id", offset: 18, size: 4, templateFill: 0xff }, // provenance: PV-0218, PV-0248
  wpCaBlk: { name: "wp_ca_blk", offset: 22, size: 4, templateFill: 0xff }, // provenance: PV-0219, PV-0249
  appcCaBlk: { name: "appc_ca_blk", offset: 26, size: 4, templateFill: 0xff }, // provenance: PV-0220, PV-0250
  length: { name: "length", offset: 30, size: 4, templateFill: undefined }, // provenance: PV-0221
  newStat: { name: "new_stat", offset: 34, size: 1, templateFill: 0x00 }, // provenance: PV-0222, PV-0251
  unused1: { name: "unused1", offset: 35, size: 4, templateFill: 0xff }, // provenance: PV-0223, PV-0252
  rqID: { name: "rq_id", offset: 39, size: 2, templateFill: 0xff }, // provenance: PV-0224, PV-0253
  unused2: { name: "unused2", offset: 41, size: 40, templateFill: 0x20 }, // provenance: PV-0225, PV-0254
  terminal: { name: "terminal", offset: 81, size: DPTerminalName.width, templateFill: undefined }, // provenance: PV-0023, PV-0226
  unused3: { name: "unused3", offset: 96, size: 10, templateFill: 0x00 }, // provenance: PV-0227, PV-0256
  unused4: { name: "unused4", offset: 106, size: 20, templateFill: 0x20 }, // provenance: PV-0228, PV-0257
  unused5: { name: "unused5", offset: 126, size: 4, templateFill: 0x00 }, // provenance: PV-0229, PV-0258
  unused6: { name: "unused6", offset: 130, size: 4, templateFill: 0x00 }, // provenance: PV-0230, PV-0259
  unused7: { name: "unused7", offset: 134, size: 4, templateFill: 0xff }, // provenance: PV-0231, PV-0260
  unused8: { name: "unused8", offset: 138, size: 4, templateFill: 0x00 }, // provenance: PV-0232, PV-0261
  unused9: { name: "unused9", offset: 142, size: 1, templateFill: 0x01 }, // provenance: PV-0233, PV-0262
  unused10: { name: "unused10", offset: 143, size: 57, templateFill: 0x00 } // provenance: PV-0234, PV-0263
}

/** Every field, in wire order. */
export const DP_HEADER_FIELDS = Object.keys(FIELDS) as DPHeaderField[]

export const dpHeaderFieldName = (field: DPHeaderField): string => FIELDS[field].name
export const dpHeaderFieldOffset = (field: DPHeaderField): number => FIELDS[field].offset
export const dpHeaderFieldSize = (field: DPHeaderField): number => FIELDS[field].size
/** The bytes the field occupies in the DP header: [start, end). */
export const dpHeaderFieldRange = (field: DPHeaderField): [number, number] => [FIELDS[field].offset, FIELDS[field].offset + FIELDS[field].size]
export const dpHeaderFieldTemplateFill = (field: DPHeaderField): number | undefined => FIELDS[field].templateFill

/** Failures of the DP header decoder and encoder. */
export type DPHeaderErrorInfo =
  /** Fewer than the 200 bytes of a DP header (PV-0020; IMPL-DP-3). Vector class `truncated`. */
  | { kind: "truncated"; byteCount: number }
  /** The length field (u32 LE at offset 30) is not the number of bytes after the header. */
  | { kind: "lengthMismatch"; declaredLength: number; bodyLength: number }
  /** Encoder: the DIAG message is longer than the u32 length field can express. */
  | { kind: "bodyTooLong"; bodyLength: number }

export class DPHeaderError extends Error {
  constructor(readonly info: DPHeaderErrorInfo) {
    super(
      info.kind === "truncated"
        ? `DP header truncated: ${info.byteCount} bytes`
        : info.kind === "lengthMismatch"
          ? `DP header length ${info.declaredLength} does not match the body length ${info.bodyLength}`
          : `DIAG message of ${info.bodyLength} bytes is too long for the DP header`
    )
    this.name = "DPHeaderError"
  }
}

/**
 * The 200-byte DP header that opens the client's first message (docs/protocol/dp-header.md).
 *
 * A value holds exactly `size` bytes; `bytes` is its wire form, so parsing and serialising
 * round-trip every byte. The client encodes it with `firstMessage` / `firstMessagePayload`
 * (IMPL-DP-2) and never decodes one (IMPL-DP-5); decoding exists for tests and the vectors.
 */
export class DPHeader {
  /** Size of the DP header. */
  static readonly size = 200 // provenance: PV-0020

  private constructor(readonly bytes: Uint8Array) {
    if (bytes.length !== DPHeader.size) throw new Error("a DP header is 200 bytes") // provenance: PV-0020
  }

  // MARK: Decoding

  /**
   * Reads the DP header from the first 200 bytes of `bytes`; later bytes are ignored. The length
   * field is not checked here; `parseFirstMessage` checks it.
   */
  static parse(bytes: Uint8Array): DPHeader {
    if (bytes.length < DPHeader.size) throw new DPHeaderError({ kind: "truncated", byteCount: bytes.length })
    return new DPHeader(bytes.slice(0, DPHeader.size))
  }

  /**
   * Decodes the payload of the first frame a client sends: a DP header, then the DIAG message
   * (IMPL-DP-3). Bytes that differ from the template are not an error (see `nonTemplateFields`).
   */
  static parseFirstMessage(payload: Uint8Array): DPHeader {
    const header = DPHeader.parse(payload)
    const bodyLength = payload.length - DPHeader.size
    if (header.length !== bodyLength)
      throw new DPHeaderError({ kind: "lengthMismatch", declaredLength: header.length, bodyLength })
    return header
  }

  // MARK: Encoding (the client's first message)

  /**
   * The DP header of the client's first message: the first-message template with only the length
   * and the terminal name filled in (IMPL-DP-2). `bodyLength` counts the bytes after the header.
   */
  static firstMessage(terminal: DPTerminalName, bodyLength: number): DPHeader {
    const output = new ByteWriter(DPHeader.size)
    DPHeader.appendFirstMessage(terminal, bodyLength, output)
    return new DPHeader(output.toBytes())
  }

  /**
   * The payload of the client's first frame: the first-message DP header, then `diagMessage`
   * unchanged. The DP length is `diagMessage.length` (PV-0022). The caller frames the result.
   */
  static firstMessagePayload(terminal: DPTerminalName, diagMessage: Uint8Array): Uint8Array {
    const bodyLength = DPHeader.checkedLength(diagMessage.length)
    const output = new ByteWriter(DPHeader.size + diagMessage.length)
    DPHeader.appendFirstMessage(terminal, bodyLength, output)
    output.bytes(diagMessage)
    return output.toBytes()
  }

  /** The DP length for a body of `bodyCount` bytes, checked. */
  static checkedLength(bodyCount: number): number {
    if (!Number.isInteger(bodyCount) || bodyCount < 0 || bodyCount > 0xffffffff)
      throw new DPHeaderError({ kind: "bodyTooLong", bodyLength: bodyCount })
    return bodyCount
  }

  /** Appends the template field by field, filling in the length and the terminal name. */
  private static appendFirstMessage(terminal: DPTerminalName, bodyLength: number, output: ByteWriter) {
    for (const field of DP_HEADER_FIELDS) {
      if (field === "length") {
        // The only little-endian field (R-DP-3), counting the bytes after the header.
        WireBytes.appendU32LittleEndian(bodyLength, output) // provenance: PV-0021, PV-0022, PV-0221
      } else if (field === "terminal") {
        output.bytes(terminal.fieldBytes) // provenance: PV-0226, PV-0255
      } else {
        output.repeat(FIELDS[field].templateFill ?? 0, FIELDS[field].size)
      }
    }
  }

  // MARK: Fields

  /** The bytes of one field. */
  bytesOf(field: DPHeaderField): Uint8Array {
    const [start, end] = dpHeaderFieldRange(field)
    return this.bytes.subarray(start, end)
  }

  /** request_id, s32 BE at offset 0 (PV-0210); −1 in the first message. */
  get requestID(): number { return this.signed32("requestID") } // provenance: PV-0210
  /** retcode, u8 at offset 4 (PV-0211); 0x0A in the first message. */
  get retcode(): number { return this.byte("retcode") } // provenance: PV-0211
  /** sender_id, u8 at offset 5 (PV-0212). */
  get senderID(): number { return this.byte("senderID") } // provenance: PV-0212
  /** action_type, u8 at offset 6 (PV-0213). */
  get actionType(): number { return this.byte("actionType") } // provenance: PV-0213
  /** req_info, u32 BE at offset 7 (PV-0214). */
  get reqInfo(): number { return WireBytes.u32BigEndian(this.bytes, FIELDS.reqInfo.offset) } // provenance: PV-0214
  /** tid, s32 BE at offset 11 (PV-0215). */
  get tid(): number { return this.signed32("tid") } // provenance: PV-0215
  /** uid, s16 BE at offset 15 (PV-0216). */
  get uid(): number { return this.signed16("uid") } // provenance: PV-0216
  /** mode, u8 at offset 17 (PV-0217); 0xFF in the first message. */
  get mode(): number { return this.byte("mode") } // provenance: PV-0217
  /** wp_id, s32 BE at offset 18 (PV-0218). */
  get wpID(): number { return this.signed32("wpID") } // provenance: PV-0218
  /** wp_ca_blk, s32 BE at offset 22 (PV-0219). */
  get wpCaBlk(): number { return this.signed32("wpCaBlk") } // provenance: PV-0219
  /** appc_ca_blk, s32 BE at offset 26 (PV-0220). */
  get appcCaBlk(): number { return this.signed32("appcCaBlk") } // provenance: PV-0220
  /** length, u32 **LE** at offset 30: the bytes after the DP header (PV-0021, PV-0022, PV-0221). */
  get length(): number { return WireBytes.u32LittleEndian(this.bytes, FIELDS.length.offset) } // provenance: PV-0021, PV-0221
  /** new_stat, u8 at offset 34 (PV-0222). */
  get newStat(): number { return this.byte("newStat") } // provenance: PV-0222
  /** rq_id, s16 BE at offset 39 (PV-0224). */
  get rqID(): number { return this.signed16("rqID") } // provenance: PV-0224
  /** unused9, u8 at offset 142 (PV-0233); 0x01 in the first message. */
  get unused9(): number { return this.byte("unused9") } // provenance: PV-0233

  /** The terminal name: the terminal field's bytes before its first `00`, or all 15 (R-DP-4, R-DP-5). */
  get terminalName(): Uint8Array {
    const field = this.bytesOf("terminal")
    const zero = field.indexOf(0)
    return zero < 0 ? field : field.subarray(0, zero)
  }

  // MARK: Template comparison

  /**
   * The fields other than the length and the terminal name whose bytes differ from the
   * first-message template, in wire order (IMPL-DP-3; which a server checks is spec gap #22).
   */
  get nonTemplateFields(): DPHeaderField[] {
    return DP_HEADER_FIELDS.filter(field => {
      const fill = FIELDS[field].templateFill
      if (fill === undefined) return false
      return this.bytesOf(field).some(b => b !== fill)
    })
  }

  /** Whether every byte outside the length and the terminal name equals the template. */
  get matchesTemplate(): boolean {
    return this.nonTemplateFields.length === 0
  }

  private byte(field: DPHeaderField): number {
    return this.bytes[FIELDS[field].offset]
  }

  private signed32(field: DPHeaderField): number {
    return toInt32(WireBytes.u32BigEndian(this.bytes, FIELDS[field].offset))
  }

  private signed16(field: DPHeaderField): number {
    return toInt16(WireBytes.u16BigEndian(this.bytes, FIELDS[field].offset))
  }
}
