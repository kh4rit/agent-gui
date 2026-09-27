// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DiagHeader.swift (MIT).

import { ByteWriter } from "../wire/index.js"

/** Offsets of the eight one-byte fields of the DIAG header (docs/protocol/diag-header.md, "Layout"). */
export const DiagHeaderLayout = {
  size: 8, // provenance: PV-0030
  mode: 0, // provenance: PV-0031
  comFlag: 1, // provenance: PV-0032
  modeStat: 2, // provenance: PV-0033
  errNo: 3, // provenance: PV-0034
  msgType: 4, // provenance: PV-0035
  msgInfo: 5, // provenance: PV-0036
  msgRC: 6, // provenance: PV-0037
  compress: 7, // provenance: PV-0038
  /**
   * err_no value meaning "no error"; any other value makes the body an error body: text,
   * terminator 0x0C, items (PV-0054 as corrected in v1, PV-0303).
   */
  noError: 0, // provenance: PV-0054
  /**
   * The mode of the client's first message and of its close message, and of the first mode's
   * input steps (PV-0126, PV-0300, PV-0301, PV-0302; IMPL-DH-9). Input steps of a later mode
   * carry that mode's number instead (Reading R-MO-2, PV-0542).
   */
  clientMode: 0 // provenance: PV-0126
} as const

/**
 * The com_flag byte: eight independent single-bit flags (R-DH-2). Their meaning is spec gap #7;
 * the decoder only names the bits that are set. A value is the byte itself (Swift `OptionSet`).
 */
export type ComFlag = number

export const ComFlag = {
  eos: 0x01, // provenance: PV-0040
  eoc: 0x02, // provenance: PV-0041
  nop: 0x04, // provenance: PV-0042
  eop: 0x08, // provenance: PV-0043
  ini: 0x10, // provenance: PV-0044
  cas: 0x20, // provenance: PV-0045
  nnm: 0x40, // provenance: PV-0046
  gra: 0x80, // provenance: PV-0047

  /**
   * Every named bit with its name, in ascending mask order (0x01 first). Both sources prefix the
   * names with `TERM_`; the prefix is left out here, as in the spec's table.
   */
  named: [
    { flag: 0x01, name: "EOS" },
    { flag: 0x02, name: "EOC" },
    { flag: 0x04, name: "NOP" },
    { flag: 0x08, name: "EOP" },
    { flag: 0x10, name: "INI" },
    { flag: 0x20, name: "CAS" },
    { flag: 0x40, name: "NNM" },
    { flag: 0x80, name: "GRA" }
  ] as readonly { readonly flag: number; readonly name: string }[],

  /**
   * Names of the bits of `flags` that are set, in ascending mask order. The eight names cover all
   * eight bits (R-DH-2), so nothing set is ever left unnamed.
   */
  names(flags: ComFlag): string[] {
    return ComFlag.named.filter(entry => (flags & entry.flag) !== 0).map(entry => entry.name)
  }
} as const

/**
 * The compress byte (docs/protocol/diag-header.md, "Compress values"). Every byte value maps to a
 * case, and `CompressField.rawValue` gives the byte back, so unknown values are preserved.
 */
export type CompressField =
  /** 0, "Compression switched off": the body follows the header directly. */
  | { readonly kind: "uncompressed" }
  /** 1, "Compression switched on": an 8-byte compression header and compressed data follow. */
  | { readonly kind: "compressed" }
  /**
   * 2 ("Data encrypted") or 3 ("Data encrypted wrap"): an SNC frame follows. Not decoded
   * (IMPL-DH-3, PLAN D4). Carries the byte.
   */
  | { readonly kind: "snc"; readonly value: number }
  /** 4–255: named by neither source; a message with such a value is rejected (IMPL-DH-2). Carries the byte. */
  | { readonly kind: "unknown"; readonly value: number }

const COMPRESS_UNCOMPRESSED = 0 // provenance: PV-0050
const COMPRESS_COMPRESSED = 1 // provenance: PV-0051
const COMPRESS_SNC_FIRST = 2 // provenance: PV-0052
const COMPRESS_SNC_LAST = 3 // provenance: PV-0053

export const CompressField = {
  uncompressedValue: COMPRESS_UNCOMPRESSED,
  compressedValue: COMPRESS_COMPRESSED,
  uncompressed: { kind: "uncompressed" } as CompressField,
  compressed: { kind: "compressed" } as CompressField,

  /** The case of a compress byte. */
  fromRaw(rawValue: number): CompressField {
    const byte = rawValue & 0xff
    if (byte === COMPRESS_UNCOMPRESSED) return { kind: "uncompressed" }
    if (byte === COMPRESS_COMPRESSED) return { kind: "compressed" }
    if (byte >= COMPRESS_SNC_FIRST && byte <= COMPRESS_SNC_LAST) return { kind: "snc", value: byte }
    return { kind: "unknown", value: byte }
  },

  /** The byte on the wire. */
  rawValue(field: CompressField): number {
    switch (field.kind) {
      case "uncompressed":
        return COMPRESS_UNCOMPRESSED
      case "compressed":
        return COMPRESS_COMPRESSED
      case "snc":
      case "unknown":
        return field.value
    }
  }
} as const

/**
 * What follows the DIAG header, from err_no and compress alone (docs/protocol/diag-header.md,
 * "Body classification", spec v1). The vector name of each case is given in brackets.
 * - `items`: err_no 0, compress 0: an item sequence. [`items`]
 * - `compressed`: err_no 0, compress 1: a compression header, then compressed data whose
 *   decompressed form is an item sequence (R-CH-2). [`compressed`]
 * - `errorBody`: err_no ≠ 0, compress 0: an error body, that is error text, terminator 0x0C, then
 *   an item sequence (PV-0303, `DiagErrorBody`). [`error-text`]
 * - `compressedErrorBody`: err_no ≠ 0, compress 1: a compression header, then compressed data
 *   whose decompressed form is an error body (IMPL-DH-6; whether servers send this is R-DH-7, #8).
 *   [`compressed-error-text`]
 * - `snc`: compress 2 or 3, whatever err_no is: an SNC frame, not decoded (IMPL-DH-3). [`snc`]
 */
export type DiagBodyClass = "items" | "compressed" | "errorBody" | "compressedErrorBody" | "snc"

export const DiagBodyClass = {
  allCases: ["items", "compressed", "errorBody", "compressedErrorBody", "snc"] as readonly DiagBodyClass[],

  /** Whether the body (or, for the compressed classes, the decompressed data) is an error body. */
  isErrorBody(bodyClass: DiagBodyClass): boolean {
    return bodyClass === "errorBody" || bodyClass === "compressedErrorBody"
  },

  /** Whether a compression header follows the DIAG header. */
  isCompressed(bodyClass: DiagBodyClass): boolean {
    return bodyClass === "compressed" || bodyClass === "compressedErrorBody"
  }
} as const

/** Failures of the DIAG header decoder. */
export type DiagHeaderErrorInfo =
  /** Fewer than 8 bytes are present (IMPL-DH-1). [`truncated`] */
  | { readonly kind: "truncated"; readonly availableByteCount: number }
  /** The compress byte is 4–255 (IMPL-DH-2). Only this message is dropped. [`unknown-compress`] */
  | { readonly kind: "unknownCompress"; readonly value: number }

export class DiagHeaderError extends Error {
  constructor(readonly info: DiagHeaderErrorInfo) {
    super(
      info.kind === "truncated"
        ? `DIAG header truncated: ${info.availableByteCount} bytes`
        : `DIAG header: unknown compress value ${info.value}`
    )
    this.name = "DiagHeaderError"
  }
}

/** The fields of a DIAG header, for `new DiagHeader(...)`. */
export interface DiagHeaderFields {
  mode: number
  comFlag: ComFlag
  modeStat: number
  errNo: number
  msgType: number
  msgInfo: number
  msgRC: number
  compress: CompressField
}

/** The 8-byte DIAG header (docs/protocol/diag-header.md). */
export class DiagHeader {
  /** Size of the header in bytes; the body starts right after it. */
  static readonly size = DiagHeaderLayout.size

  readonly mode: number
  readonly comFlag: ComFlag
  readonly modeStat: number
  readonly errNo: number
  readonly msgType: number
  readonly msgInfo: number
  readonly msgRC: number
  readonly compress: CompressField

  constructor(fields: DiagHeaderFields) {
    this.mode = fields.mode & 0xff
    this.comFlag = fields.comFlag & 0xff
    this.modeStat = fields.modeStat & 0xff
    this.errNo = fields.errNo & 0xff
    this.msgType = fields.msgType & 0xff
    this.msgInfo = fields.msgInfo & 0xff
    this.msgRC = fields.msgRC & 0xff
    this.compress = fields.compress
  }

  /**
   * Splits the first 8 bytes of `bytes` into the eight fields without interpreting them
   * (IMPL-DH-1). Bytes after the header are ignored.
   */
  static parse(bytes: Uint8Array): DiagHeader {
    if (bytes.length < DiagHeaderLayout.size) throw new DiagHeaderError({ kind: "truncated", availableByteCount: bytes.length })
    return new DiagHeader({
      mode: bytes[DiagHeaderLayout.mode],
      comFlag: bytes[DiagHeaderLayout.comFlag],
      modeStat: bytes[DiagHeaderLayout.modeStat],
      errNo: bytes[DiagHeaderLayout.errNo],
      msgType: bytes[DiagHeaderLayout.msgType],
      msgInfo: bytes[DiagHeaderLayout.msgInfo],
      msgRC: bytes[DiagHeaderLayout.msgRC],
      compress: CompressField.fromRaw(bytes[DiagHeaderLayout.compress])
    })
  }

  /**
   * Whether the message is a server error: err_no ≠ 0 (PV-0054). err_no values have no meaning
   * in either source; they are reported as numbers (#8).
   */
  get isError(): boolean {
    return this.errNo !== DiagHeaderLayout.noError
  }

  /**
   * Classifies the body from err_no and compress alone, compress first (spec v1, "Body
   * classification"). Throws `unknownCompress` for compress 4–255, whatever err_no is (IMPL-DH-2).
   */
  bodyClass(): DiagBodyClass {
    switch (this.compress.kind) {
      case "unknown":
        throw new DiagHeaderError({ kind: "unknownCompress", value: this.compress.value })
      case "snc":
        return "snc"
      case "uncompressed":
        return this.isError ? "errorBody" : "items"
      case "compressed":
        return this.isError ? "compressedErrorBody" : "compressed"
    }
  }

  /** Appends the eight fields in offset order (IMPL-DH-1). */
  serialize(output: ByteWriter): void {
    output.u8(this.mode)
    output.u8(this.comFlag)
    output.u8(this.modeStat)
    output.u8(this.errNo)
    output.u8(this.msgType)
    output.u8(this.msgInfo)
    output.u8(this.msgRC)
    output.u8(CompressField.rawValue(this.compress))
  }

  /** The header's 8 bytes. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(DiagHeaderLayout.size)
    this.serialize(output)
    return output.toBytes()
  }

  // MARK: Client headers (IMPL-DH-9)

  /**
   * A header with every field 0 except com_flag, compress and, for an echo, mode_stat, and the
   * mode of a later mode's input step.
   */
  private static client(
    comFlag: ComFlag,
    compress: CompressField,
    modeStat = 0,
    mode: number = DiagHeaderLayout.clientMode,
    msgInfo = 0
  ): DiagHeader {
    return new DiagHeader({ mode, comFlag, modeStat, errNo: DiagHeaderLayout.noError, msgType: 0, msgInfo, msgRC: 0, compress })
  }

  /**
   * The header of the client's first message, after the DP header: mode 0, com_flag INI only,
   * compress 0, every other byte 0, `00 10 00 00 00 00 00 00` (PV-0300, PV-0126, PV-0127). The
   * first message is never compressed, even on a compressed connection (PV-0317).
   */
  static readonly clientFirstMessage = DiagHeader.client(ComFlag.ini, CompressField.uncompressed) // provenance: PV-0300

  /**
   * The header of a later client message: every byte 0 except compress, which is the
   * connection's compression setting, `00 00 00 00 00 00 00 cc` (PV-0301). Mode 0 is the first
   * mode; an input step of a later mode carries its number (Reading R-MO-2). Swooey sends
   * compress 0 until spike P4 (IMPL-DH-4).
   *
   * With `modeStat`: the server's mode_stat, echoed as open-diag-go's client echoes it
   * (client-input.md Reading R-CI-12, PV-0775); with 0 it is the plain later-message header.
   *
   * With `mode`: the header byte that names the mode (session) the step belongs to, as a new SAP
   * GUI window is a new mode byte (Reading R-MO-2, PV-0542; session.md §8).
   */
  static clientLaterMessage(compressed: boolean, modeStat?: number, mode?: number): DiagHeader {
    if (modeStat === undefined) return DiagHeader.client(0, compressed ? CompressField.compressed : CompressField.uncompressed) // provenance: PV-0301
    if (mode === undefined)
      return DiagHeader.client(0, compressed ? CompressField.compressed : CompressField.uncompressed, modeStat) // provenance: PV-0301, PV-0775
    return DiagHeader.client(0, compressed ? CompressField.compressed : CompressField.uncompressed, modeStat, mode) // provenance: PV-0301, PV-0542
  }

  /**
   * msg_info of the session's own replies to control traffic, as on every later message of SAP
   * GUI for Java 8.10 in the owner's structure summary (PV-0908; controls/transport.md §2.5).
   */
  static readonly controlReplyMsgInfo = 0x01 // provenance: PV-0908

  /**
   * The header of the session's reply to control traffic (Reading R-CT-26, IMPL-DH-9 as amended
   * on 2026-09-25): mode, com_flag 0, mode_stat, err_no 0, msg_type 0, **msg_info 0x01**, msg_rc 0
   * and the connection's compress byte, `mm 00 ss 00 00 01 00 cc` (PV-0301, PV-0908). `modeStat`
   * is the server's, echoed when the envelope has echoes (R-CI-12), else 0.
   */
  static clientControlReply(compressed: boolean, modeStat: number, mode: number): DiagHeader {
    return DiagHeader.client(
      0,
      compressed ? CompressField.compressed : CompressField.uncompressed,
      modeStat,
      mode,
      DiagHeader.controlReplyMsgInfo
    ) // provenance: PV-0301, PV-0908
  }

  /**
   * The client's close message, which is this header alone: com_flag EOC only, compress 0,
   * `00 02 00 00 00 00 00 00` (PV-0302). It is never compressed and carries no items.
   */
  static readonly clientClose = DiagHeader.client(ComFlag.eoc, CompressField.uncompressed) // provenance: PV-0302
}
