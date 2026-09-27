// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/SessionItems.swift (MIT).

// Payload codecs of the session items (docs/protocol/session.md): ST_USER CONNECT, SUPPORTDATA
// (ST_USER and ST_R3INFO), DIALOG_STEP_NUMBER and the ST_R3INFO identity items. Every codec works
// on the item's value bytes, as a DiagItem's valueRange delimits them.

import { ByteWriter, WireBytes } from "../wire/index.js"
import type { ApplSIDStSystemInfo } from "./applRegistry.js"
import { ByteRange, FixedSize, ItemPayloadError } from "./diagCodec.js"

// MARK: - ST_USER CONNECT

/**
 * The CONNECT protocol_version values (session.md §3.1). The client's compression choice selects
 * one (PV-0317).
 */
export const ProtocolVersion = {
  /** A compressed session: later client messages carry compress 1. */
  compressed: 100_200, // provenance: PV-0120
  /** An uncompressed session: later client messages carry compress 0. */
  uncompressed: 200 // provenance: PV-0121
} as const

/**
 * The value of `ST_USER CONNECT` (id 0x04, sid 0x02): three u32 BE fields, 12 bytes, in the order
 * protocol_version, code_page, ws_type (PV-0504–PV-0506; both sources).
 *
 * No field has a default. The code_page an honest client requests (#18) and the ws_type it
 * declares (#16) are project decisions of spike P1's ADR, not facts the sources supply; the caller
 * states them explicitly (CLEANROOM.md §1 rule 6).
 */
export class UserConnect {
  /** The value size (PV-0504). */
  static readonly size = 12 // provenance: PV-0504

  static readonly Offset = {
    protocolVersion: 0, // provenance: PV-0505, PV-0506
    codePage: 4, // provenance: PV-0505, PV-0506
    wsType: 8 // provenance: PV-0505, PV-0506
  } as const

  /** 100200 for a compressed session, 200 for an uncompressed one (`ProtocolVersion`). */
  readonly protocolVersion: number
  /**
   * The code page the client requests. Text is always decoded by the negotiated code page
   * (CODEPAGE_DIAG_GUI), never this one (session.md §6.3).
   */
  readonly codePage: number
  /** The front-end type the client declares; see #16 before choosing one. */
  readonly wsType: number

  constructor(fields: { protocolVersion: number; codePage: number; wsType: number }) {
    this.protocolVersion = fields.protocolVersion
    this.codePage = fields.codePage
    this.wsType = fields.wsType
  }

  /** Decodes exactly 12 value bytes. */
  static decode(value: Uint8Array): UserConnect {
    FixedSize.check(value, UserConnect.size)
    return new UserConnect({
      protocolVersion: WireBytes.u32BigEndian(value, UserConnect.Offset.protocolVersion), // provenance: PV-0506
      codePage: WireBytes.u32BigEndian(value, UserConnect.Offset.codePage), // provenance: PV-0506
      wsType: WireBytes.u32BigEndian(value, UserConnect.Offset.wsType) // provenance: PV-0506
    })
  }

  /** Appends the 12 value bytes. */
  append(output: ByteWriter): void {
    WireBytes.appendU32BigEndian(this.protocolVersion, output) // provenance: PV-0506
    WireBytes.appendU32BigEndian(this.codePage, output) // provenance: PV-0506
    WireBytes.appendU32BigEndian(this.wsType, output) // provenance: PV-0506
  }

  /** The 12 value bytes. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(UserConnect.size)
    this.append(output)
    return output.toBytes()
  }
}

// MARK: - DIALOG_STEP_NUMBER

/**
 * The value of `ST_USER DIALOG_STEP_NUMBER` (id 0x04, sid 0x26): one u32 BE, 4 bytes (PV-0125;
 * both sources).
 */
export class DialogStepNumber {
  /** The value size (PV-0125). */
  static readonly size = 4 // provenance: PV-0125

  constructor(readonly step: number) {}

  /** Decodes exactly 4 value bytes. */
  static decode(value: Uint8Array): DialogStepNumber {
    FixedSize.check(value, DialogStepNumber.size)
    return new DialogStepNumber(WireBytes.u32BigEndian(value, 0)) // provenance: PV-0125
  }

  /** Appends the 4 value bytes. */
  append(output: ByteWriter): void {
    WireBytes.appendU32BigEndian(this.step, output) // provenance: PV-0125
  }

  /** The 4 value bytes. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(DialogStepNumber.size)
    this.append(output)
    return output.toBytes()
  }
}

// MARK: - SUPPORTDATA

const BITS_PER_BYTE = 8 // provenance: PV-0509
const SUPPORT_BYTE_COUNT = 32 // provenance: PV-0124

/**
 * The names of bits 0–214, indexed by bit number; undefined marks a bit neither source names. Bits
 * 0–207 are named identically by both sources (PV-0510); bits 208–214, in byte 26, by Wireshark
 * only (PV-0511). Bits 215–255 are unnamed. The names are protocol identifiers taken from the
 * spec's table (D16b), used for diagnostics only.
 */
// prettier-ignore
const SUPPORT_BIT_NAMES: readonly (string | undefined)[] = [ // provenance: PV-0510, PV-0511
  /* byte 0 */ "PROGRESS_INDICATOR", "SAPGUI_LABELS", "SAPGUI_DIAGVERSION", "SAPGUI_SELECT_RECT", "SAPGUI_SYMBOL_RIGHT", "SAPGUI_FONT_METRIC", "SAPGUI_COMPR_ENHANCED", "SAPGUI_IMODE",
  /* byte 1 */ "SAPGUI_LONG_MESSAGE", "SAPGUI_TABLE", "SAPGUI_FOCUS_1", "SAPGUI_PUSHBUTTON_1", "UPPERCASE", "SAPGUI_TABPROPERTY", "INPUT_UPPERCASE", "RFC_DIALOG",
  /* byte 2 */ "LIST_HOTSPOT", "FKEY_TABLE", "MENU_SHORTCUT", "STOP_TRANS", "FULL_MENU", "OBJECT_NAMES", "CONTAINER_TYPE", "DLGH_FLAGS",
  /* byte 3 */ "APPL_MNU", "MESSAGE_INFO", "MESDUM_FLAG1", "TABSEL_ATTRIB", "GUIAPI", "NOGRAPH", "NOMESSAGES", "NORABAX",
  /* byte 4 */ "NOSYSMSG", "NOSAPSCRIPT", "NORFC", "NEW_BSD_JUSTRIGHT", "MESSAGE_VARS", "OCX_SUPPORT", "SCROLL_INFOS", "TABLE_SIZE_OK",
  /* byte 5 */ "MESSAGE_INFO2", "VARINFO_OKCODE", "CURR_TCODE", "CONN_WSIZE", "PUSHBUTTON_2", "TABSTRIP", "UNKNOWN_1", "TABSCROLL_INFOS",
  /* byte 6 */ "TABLE_FIELD_NAMES", "NEW_MODE_REQUEST", "RFCBLOB_DIAG_PARSER", "MULTI_LOGIN_USER", "CONTROL_CONTAINER", "APPTOOLBAR_FIXED", "R3INFO_USER_CHECKED", "NEED_STDDYNPRO",
  /* byte 7 */ "TYPE_SERVER", "COMBOBOX", "INPUT_REQUIRED", "ISO_LANGUAGE", "COMBOBOX_TABLE", "R3INFO_FLAGS", "CHECKRADIO_EVENTS", "R3INFO_USERID",
  /* byte 8 */ "R3INFO_ROLLCOUNT", "USER_TURNTIME2", "NUM_FIELD", "WIN16", "CONTEXT_MENU", "SCROLLABLE_TABSTRIP_PAGE", "EVENT_DESCRIPTION", "LABEL_OWNER",
  /* byte 9 */ "CLICKABLE_FIELD", "PROPERTY_BAG", "UNUSED_1", "TABLE_ROW_REFERENCES_2", "PROPFONT_VALID", "VARINFO_CONTAINER", "R3INFO_IMODEUUID", "NOTGUI",
  /* byte 10 */ "WAN", "XML_BLOBS", "RFC_QUEUE", "RFC_COMPRESS", "JAVA_BEANS", "DPLOADONDEMAND", "CTL_PROPCACHE", "ENJOY_IMODEUUID",
  /* byte 11 */ "RFC_ASYNC_BLOB", "KEEP_SCROLLPOS", "UNUSED_2", "UNUSED_3", "XML_PROPERTIES", "UNUSED_4", "HEX_FIELD", "HAS_CACHE",
  /* byte 12 */ "XML_PROP_TABLE", "UNUSED_5", "ENJOY_IMODEUUID2", "ITS", "NO_EASYACCESS", "PROPERTYPUMP", "COOKIE", "UNUSED_6",
  /* byte 13 */ "SUPPBIT_AREA_SIZE", "DPLOADONDEMAND_WRITE", "CONTROL_FOCUS", "ENTRY_HISTORY", "AUTO_CODEPAGE", "CACHED_VSETS", "EMERGENCY_REPAIR", "AREA2FRONT",
  /* byte 14 */ "SCROLLBAR_WIDTH", "AUTORESIZE", "EDIT_VARLEN", "WORKPLACE", "PRINTDATA", "UNKNOWN_2", "SINGLE_SESSION", "NOTIFY_NEWMODE",
  /* byte 15 */ "TOOLBAR_HEIGHT", "XMLPROP_CONTAINER", "XMLPROP_DYNPRO", "DP_HTTP_PUT", "DYNAMIC_PASSPORT", "WEBGUI", "WEBGUI_HELPMODE", "CONTROL_FOCUS_ON_LIST",
  /* byte 16 */ "CBU_RBUDUMMY_2", "EOKDUMMY_1", "GUI_USER_SCRIPTING", "SLC", "ACCESSIBILITY", "ECATT", "ENJOY_IMODEUUID3", "ENABLE_UTF8",
  /* byte 17 */ "R3INFO_AUTOLOGOUT_TIME", "VARINFO_ICON_TITLE_LIST", "ENABLE_UTF16BE", "ENABLE_UTF16LE", "R3INFO_CODEPAGE_APP", "ENABLE_APPL4", "GUIPATCHLEVEL", "CBURBU_NEW_STATE",
  /* byte 18 */ "BINARY_EVENTID", "GUI_THEME", "TOP_WINDOW", "EVENT_DESCRIPTION_1", "SPLITTER", "VALUE_4_HISTORY", "ACC_LIST", "GUI_USER_SCRIPTING_INFO",
  /* byte 19 */ "TEXTEDIT_STREAM", "DYNT_NOFOCUS", "R3INFO_CODEPAGE_APP_1", "FRAME_1", "TICKET4GUI", "ACC_LIST_PROPS", "TABSEL_ATTRIB_INPUT", "DEFAULT_TOOLTIP",
  /* byte 20 */ "XML_PROP_TABLE_2", "CBU_RBUDUMMY_3", "CELLINFO", "CONTROL_FOCUS_ON_LIST_2", "TABLE_COLUMNWIDTH_INPUT", "ITS_PLUGIN", "OBJECT_NAMES_4_LOGIN_PROCESS", "RFC_SERVER_4_GUI",
  /* byte 21 */ "R3INFO_FLAGS_2", "RCUI", "MENUENTRY_WITH_FCODE", "WEBSAPCONSOLE", "R3INFO_KERNEL_VERSION", "VARINFO_CONTAINER_LOOP", "EOKDUMMY_2", "MESSAGE_INFO3",
  /* byte 22 */ "SBA2", "MAINAREA_SIZE", "GUIPATCHLEVEL_2", "DISPLAY_SIZE", "GUI_PACKET", "DIALOG_STEP_NUMBER", "TC_KEEP_SCROLL_POSITION", "MESSAGE_SERVICE_REQUEST",
  /* byte 23 */ "DYNT_FOCUS_FRAME", "MAX_STRING_LEN", "VARINFO_CONTAINER_1", "STD_TOOLBAR_ITEMS", "XMLPROP_LIST_DYNPRO", "TRACE_GUI_CONNECT", "LIST_FULLWIDTH", "ALLWAYS_SEND_CLIENT",
  /* byte 24 */ "UNKNOWN_3", "GUI_SIGNATURE_COLOR", "MAX_WSIZE", "SAP_PERSONAS", "IDA_ALV", "IDA_ALV_FRAGMENTS", "AMC", "EXTMODE_FONT_METRIC",
  /* byte 25 */ "GROUPBOX", "AGI_ID_TS_BUTTON", "NO_FOCUS_ON_LIST", "FIORI_MODE", "CONNECT_CHECK_DONE", "MSGINFO_WITH_CODEPAGE", "AGI_ID", "AGI_ID_TC",
  /* byte 26 */ "FIORI_TOOLBARS", "OBJECT_NAMES_ENFORCE", "MESDUMMY_FLAGS_2_3", "NWBC", "CONTAINER_LIST", "GUI_SYSTEM_COLOR", "GROUPBOX_WITHOUT_BOTTOMLINE", undefined,
]

/**
 * One support bit of the SUPPORTDATA mask: bit N lives in byte ⌊N/8⌋ at mask `1 << (N mod 8)`
 * (PV-0509, R-SE-5). Numbers run 0–255; bits 0–214 have names (PV-0510, PV-0511).
 */
export class SupportBit {
  /** Bits in the 32-byte mask. */
  static readonly count = SUPPORT_BYTE_COUNT * BITS_PER_BYTE
  static readonly bitsPerByte = BITS_PER_BYTE // provenance: PV-0509
  /** The names of bits 0–214 (session.md §5.2). */
  static readonly names = SUPPORT_BIT_NAMES

  /** The bit number, 0–255. */
  readonly number: number

  private constructor(number: number) {
    this.number = number
  }

  /** The bit numbered `number`, or undefined unless `number` is 0–255. */
  static fromNumber(number: number): SupportBit | undefined {
    if (!(Number.isInteger(number) && number >= 0 && number < SupportBit.count)) return undefined
    return new SupportBit(number)
  }

  /** The bit with this name in session.md §5.2, or undefined. */
  static fromName(name: string): SupportBit | undefined {
    const number = SUPPORT_BIT_NAMES.findIndex(entry => entry === name)
    return number < 0 ? undefined : new SupportBit(number)
  }

  /** The byte of the 32-byte value that holds the bit. */
  get byteIndex(): number {
    return Math.floor(this.number / BITS_PER_BYTE) // provenance: PV-0509
  }

  /** The bit's mask within its byte. */
  get mask(): number {
    return 1 << this.number % BITS_PER_BYTE // provenance: PV-0509
  }

  /** The bit's name (session.md §5.2), or undefined for bits 215–255, which neither source names. */
  get name(): string | undefined {
    return this.number < SUPPORT_BIT_NAMES.length ? SUPPORT_BIT_NAMES[this.number] : undefined
  }

  /** Swift `Comparable`: ascending bit order. */
  static compare(lhs: SupportBit, rhs: SupportBit): number {
    return lhs.number - rhs.number
  }

  // The bits with PROVENANCE rows of their own. Which bits Swooey sets is #17.

  /** PROGRESS_INDICATOR, bit 0 (byte 0, mask 0x01). */
  static readonly progressIndicator = new SupportBit(0) // provenance: PV-0512
  /** SAPGUI_IMODE, bit 7 (byte 0, mask 0x80). */
  static readonly imode = new SupportBit(7) // provenance: PV-0513
  /** ENABLE_UTF8, bit 135 (byte 16, mask 0x80). */
  static readonly enableUTF8 = new SupportBit(135) // provenance: PV-0514
  /** ENABLE_APPL4, bit 141 (byte 17, mask 0x20). */
  static readonly enableAPPL4 = new SupportBit(141) // provenance: PV-0515
  /** DIALOG_STEP_NUMBER, bit 181 (byte 22, mask 0x20). */
  static readonly dialogStepNumber = new SupportBit(181) // provenance: PV-0516
}

/**
 * The 32-byte SUPPORTDATA capability mask (session.md §5): the value of `ST_USER SUPPORTDATA`
 * (0x04/0x0B), which the client sends, and of `ST_R3INFO SUPPORTDATA` (0x06/0x11), which the server
 * sends (PV-0124, PV-0537; both sources).
 *
 * There is deliberately no default mask. Which bits Swooey declares is a project decision of spike
 * P1's ADR (#17), and the client declares only capabilities it implements (CLEANROOM.md §1 rule
 * 6); the caller builds the mask bit by bit.
 *
 * Swift keeps the mask as four UInt64 words; the port keeps the 32 bytes themselves, byte k of the
 * value at index k. A mutable value: copy it with `clone()` where Swift copies the struct.
 */
export class SupportBits {
  /** The value size (PV-0124). */
  static readonly byteCount = SUPPORT_BYTE_COUNT // provenance: PV-0124

  private readonly mask = new Uint8Array(SUPPORT_BYTE_COUNT) // not-protocol: storage as the 32 value bytes

  /**
   * The mask with exactly `bits` set; with no argument, the mask with no bit set (not a mask to
   * send; see #17).
   */
  constructor(bits: Iterable<SupportBit> = []) {
    for (const bit of bits) this.insert(bit)
  }

  /** Decodes exactly 32 value bytes (session.md §5.3). */
  static decode(value: Uint8Array): SupportBits {
    FixedSize.check(value, SupportBits.byteCount)
    const bits = new SupportBits()
    bits.mask.set(value)
    return bits
  }

  /** A copy of this mask. */
  clone(): SupportBits {
    const copy = new SupportBits()
    copy.mask.set(this.mask)
    return copy
  }

  /** Whether `bit` is set (R-SE-5). */
  contains(bit: SupportBit): boolean {
    return (this.mask[bit.byteIndex] & bit.mask) !== 0
  }

  /** Sets `bit`. */
  insert(bit: SupportBit): void {
    this.mask[bit.byteIndex] |= bit.mask
  }

  /** Clears `bit`. */
  remove(bit: SupportBit): void {
    this.mask[bit.byteIndex] &= ~bit.mask
  }

  /** Every bit that is set, named or not, in ascending bit order. */
  get setBits(): SupportBit[] {
    const bits: SupportBit[] = []
    for (let number = 0; number < SupportBit.count; number++) {
      const bit = SupportBit.fromNumber(number)!
      if (this.contains(bit)) bits.push(bit)
    }
    return bits
  }

  /**
   * The named bits that are set, in ascending bit order (byte 0 first, and within a byte mask 0x01
   * before 0x80).
   */
  get setNamedBits(): SupportBit[] {
    return this.setBits.filter(bit => bit.name !== undefined)
  }

  /** Byte `index` (0–31) of the value. */
  byte(index: number): number {
    return this.mask[index]
  }

  /** Appends the 32 value bytes. */
  append(output: ByteWriter): void {
    output.bytes(this.mask)
  }

  /** The 32 value bytes. */
  get bytes(): Uint8Array {
    return this.mask.slice()
  }
}

// MARK: - ST_R3INFO identity items

/**
 * ST_R3INFO values that are text: DBNAME (0x02), CPUNAME (0x03), TCODE (0x07), MESSAGE (0x0B),
 * CLIENT (0x0C) and CODEPAGE_APP_SERVER (0x24) carry the whole item value as text (PV-0534).
 *
 * The character set is not stated by the sources (#18), so the text stays bytes: this gives the
 * range of the text within the value after trailing zero bytes are stripped (R-SE-6). It is
 * decoded by the negotiated code page once #18 says how.
 */
export const SystemInfoText = {
  /** Whether `sid` is one of the text items of PV-0534. */
  isText(sid: ApplSIDStSystemInfo): boolean {
    switch (sid) {
      case "dbName":
      case "cpuName":
      case "tcode":
      case "message":
      case "client":
      case "codepageAppServer":
        return true
      default:
        return false
    }
  },

  /** The range of the text within `value`: all of it except trailing zero bytes (R-SE-6). */
  textRange(value: Uint8Array): ByteRange {
    let end = value.length
    while (end > 0 && value[end - 1] === 0) end -= 1
    return new ByteRange(0, end)
  }
} as const

/**
 * ST_R3INFO values that are one u16 BE: MODENUMBER (0x01), DIAGVERSION (0x06) and IMODENUMBER
 * (0x0A) (PV-0536; Wireshark only, which checks a length of 2).
 */
export const SystemInfoNumber = {
  /** The value size. */
  size: 2, // provenance: PV-0536

  /** Whether `sid` is one of the numeric items of PV-0536. */
  isNumber(sid: ApplSIDStSystemInfo): boolean {
    return sid === "modeNumber" || sid === "diagVersion" || sid === "imodeNumber"
  },

  /** Decodes exactly 2 value bytes. */
  decode(value: Uint8Array): number {
    FixedSize.check(value, SystemInfoNumber.size)
    return WireBytes.u16BigEndian(value, 0) // provenance: PV-0536
  }
} as const

/**
 * Finds a zero-terminated string: the bytes from `start` up to the next zero byte, and the offset
 * after that zero byte.
 */
export const ZeroTerminated = {
  scan(value: Uint8Array, start: number): { text: ByteRange; next: number } {
    let index = start
    while (index < value.length && value[index] !== 0) index += 1
    // The value ends before the string's terminator.
    if (!(index < value.length)) throw new ItemPayloadError({ kind: "truncated", needed: value.length + 1, available: value.length })
    return { text: new ByteRange(start, index), next: index + 1 }
  }
} as const

/**
 * The value of `ST_R3INFO CODEPAGE_DIAG_GUI` (0x06/0x23), with which the server declares the GUI
 * code page (session.md §6.1, PV-0532; Wireshark only): a u32 BE code-page number, a u8 minimum
 * bytes per character, then two zero-terminated strings, the number as text and a description
 * (R-SE-8). Ranges are offsets into the value; the strings' character set is #18.
 */
export class CodepageDiagGUI {
  static readonly Offset = {
    codePage: 0, // provenance: PV-0532
    minBytesPerCharacter: 4, // provenance: PV-0532
    numberText: 5 // provenance: PV-0532
  } as const

  private constructor(
    /** The code-page number. Which character set it denotes is #18 (PV-0130 is unpinned). */
    readonly codePage: number,
    /**
     * The byte Wireshark labels "minimum number of bytes per character". Not interpreted: its use
     * as a Unicode indicator is R-SE-7, unconfirmed (#18).
     */
    readonly minBytesPerCharacter: number,
    /** The code-page number as text, without its zero byte. */
    readonly numberText: ByteRange,
    /** The description, without its zero byte. */
    readonly description: ByteRange,
    /**
     * Bytes after the second string's zero byte. The spec says nothing about them; they are
     * reported, not interpreted.
     */
    readonly trailingByteCount: number
  ) {}

  /**
   * Decodes a CODEPAGE_DIAG_GUI value. Fails with `truncated` when the value ends inside the fixed
   * fields or before a string's zero byte.
   */
  static decode(value: Uint8Array): CodepageDiagGUI {
    const offset = CodepageDiagGUI.Offset
    if (value.length < offset.numberText) throw new ItemPayloadError({ kind: "truncated", needed: offset.numberText, available: value.length })
    const codePage = WireBytes.u32BigEndian(value, offset.codePage) // provenance: PV-0532
    const minBytesPerCharacter = value[offset.minBytesPerCharacter]
    const number = ZeroTerminated.scan(value, offset.numberText)
    const text = ZeroTerminated.scan(value, number.next)
    return new CodepageDiagGUI(codePage, minBytesPerCharacter, number.text, text.text, value.length - text.next)
  }
}

/**
 * The value of `ST_R3INFO KERNEL_VERSION` (0x06/0x29): three zero-terminated strings, the database
 * version, the kernel version and the kernel patch level (session.md §6.2, PV-0535; Wireshark
 * only). Ranges are offsets into the value; the character set is #18. Its encoder is
 * `appendKernelVersion` (ScreenListValues.swift's `extension KernelVersion`).
 */
export class KernelVersion {
  private constructor(
    readonly databaseVersion: ByteRange,
    readonly kernelVersion: ByteRange,
    readonly patchLevel: ByteRange,
    /** Bytes after the third string's zero byte, reported, not interpreted. */
    readonly trailingByteCount: number
  ) {}

  /** Decodes a KERNEL_VERSION value. Fails with `truncated` when the value ends before one of the three zero bytes. */
  static decode(value: Uint8Array): KernelVersion {
    const database = ZeroTerminated.scan(value, 0)
    const kernel = ZeroTerminated.scan(value, database.next)
    const patch = ZeroTerminated.scan(value, kernel.next)
    return new KernelVersion(database.text, kernel.text, patch.text, value.length - patch.next)
  }
}
