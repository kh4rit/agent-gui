// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ScreenText.swift (MIT).

// The string items of a screen (docs/protocol/server-screen.md §5.1, client-input.md §7.1): APPL
// items whose whole value is text. The character set of these texts is not stated (#18), so the
// codec gives byte ranges; it decodes nothing to `string`.

import type { ByteWriter } from "../wire/index.js"
import type { ApplItem } from "./applRegistry.js"
import { ByteRange } from "./diagCodec.js"
import { DiagItemEncoder, DiagItemEncodingError, DiagItemLayout } from "./diagItem.js"
import { ScreenValueEncodingError } from "./screenListValues.js"

/** The APPL items whose whole value is one text, and the trimming rule R-SS-4. */
export const ScreenText = {
  /**
   * Trailing padding a reader removes before comparing or showing a screen-identity text: the
   * example pads with spaces and zero bytes, and no source gives either a meaning (R-SS-4, PV-0726).
   */
  spacePadding: 0x20, // provenance: PV-0726
  zeroPadding: 0x00, // provenance: PV-0726

  /**
   * Whether the pair's whole value is one text:
   * - ST_R3INFO DBNAME, CPUNAME, TCODE, MESSAGE, CLIENT, CODEPAGE_APP_SERVER (PV-0534);
   * - ST_R3INFO DYNPRONAME, DYNPRONUMBER, CUANAME, CUASTATUS, CONTEXTID, GUI_THEME (PV-0707);
   * - VARINFO OKCODE, SESSION_TITLE, SESSION_ICON, LIST_CELL_TEXT (PV-0708);
   * - DYNT DYNT_CONTROL_FOCUS (PV-0709).
   *
   * Dispatch is on (id, sid) alone, whichever carrier brought the item (IMPL-IT-9).
   */
  isText(item: ApplItem): boolean {
    switch (item.kind) {
      case "stSystemInfo":
        switch (item.sid) {
          case "dbName":
          case "cpuName":
          case "tcode":
          case "message":
          case "client":
          case "codepageAppServer":
          case "dynproName":
          case "dynproNumber":
          case "cuaName":
          case "cuaStatus":
          case "contextID":
          case "guiTheme":
            return true
          default:
            return false
        }
      case "varInfo":
        return item.sid === "okcode" || item.sid === "sessionTitle" || item.sid === "sessionIcon" || item.sid === "listCellText"
      case "dynt":
        return item.sid === "controlFocus"
      default:
        return false
    }
  },

  /**
   * The range of the text within `value` after R-SS-4: every trailing space (0x20) and zero (0x00)
   * byte removed, in any mix; leading spaces kept. An all-padding value gives an empty range at 0.
   */
  trimmedRange(value: Uint8Array): ByteRange {
    let end = value.length
    while (end > 0 && (value[end - 1] === ScreenText.spacePadding || value[end - 1] === ScreenText.zeroPadding)) end -= 1
    return new ByteRange(0, end)
  },

  /**
   * Appends a text item as APPL: `10`, id, sid, u16 BE length, then `text` verbatim, padding
   * included (items.md, PV-0400–PV-0402). APPL is the carrier under which both sources decode these
   * pairs and the one the fake server uses (R-SS-3); which carrier a real server needs is #31. This
   * is the layout only: whether a client may send VARINFO OKCODE is #55, and `ClientInputStep` does
   * not.
   *
   * Fails with `notAText` for a pair whose value is not a text, and with `tooLong` for a text longer
   * than an APPL value can be (R-IT-4). Nothing is appended when it throws.
   */
  appendItem(item: ApplItem, text: Uint8Array, output: ByteWriter): void {
    if (!ScreenText.isText(item)) throw new ScreenValueEncodingError({ kind: "notAText", value: item })
    try {
      DiagItemEncoder.appendAPPL(item, text, output)
    } catch (error) {
      if (!(error instanceof DiagItemEncodingError)) throw error
      throw new ScreenValueEncodingError({ kind: "tooLong", length: text.length, limit: DiagItemLayout.applMaxValueLength })
    }
  },

  /**
   * Whether `value`, trimmed per R-SS-4, is exactly the bytes of `expected`. Used to compare an
   * identity text with a name, for example DYNPRONAME with the logon program (R-SS-5). (Swift
   * `trimmed(_:equals:)`.)
   */
  trimmedEquals(value: Uint8Array, expected: Uint8Array): boolean {
    const range = ScreenText.trimmedRange(value)
    if (range.count !== expected.length) return false
    for (let index = 0; index < expected.length; index++) if (value[index] !== expected[index]) return false
    return true
  }
} as const
