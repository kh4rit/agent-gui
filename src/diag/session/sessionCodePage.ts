// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/SessionCodePage.swift (MIT).

// The code page in force (docs/protocol/session.md §6.3, Reading R-SE-9; §6.4) and the one text
// the session itself reads in it, DYNPRONAME for R-SS-5. Before the server declares a code page in
// ST_R3INFO CODEPAGE_DIAG_GUI, texts are in the one CONNECT requested; from a declaration on, in
// the declared one, and a declaration governs the whole message that carries it. ScreenModel's
// `Screen` reads by the same rule, and both read the top window's DYNPRONAME, the last window
// section's (elements.md Reading R-EL-23, issue #142), so the session's state and
// `Screen.isLogonScreen` agree.
//
// Internal to the session module (Swift `enum SessionCodePage`, internal): not exported from the
// module's index.

import {
  ApplItem,
  CodepageDiagGUI,
  DiagItemWalkError,
  DiagItemWalker,
  ItemPayloadError,
  ScreenIdentity,
  TextEncoding,
  type ByteRange,
  type DiagItem
} from "../codec/index.js"

/** Swift `try? walker.next(in:)`. */
function nextItem(walker: DiagItemWalker, items: Uint8Array): DiagItem | undefined {
  try {
    return walker.next(items)
  } catch (error) {
    if (error instanceof DiagItemWalkError) return undefined
    throw error
  }
}

const CODEPAGE_DIAG_GUI = ApplItem.stSystemInfo("codepageDiagGUI")

export const SessionCodePage = {
  /** The logon program's name as text (R-SS-5, PV-0707). */
  logonProgramName: new TextDecoder().decode(ScreenIdentity.logonProgramName),

  /**
   * The code page the first ST_R3INFO CODEPAGE_DIAG_GUI item of `items` declares (PV-0532), or
   * undefined when none does: no such item, or none whose value decodes. Items after a walk stop
   * are not read.
   */
  declared(items: Uint8Array): number | undefined {
    const walker = new DiagItemWalker()
    for (let item = nextItem(walker, items); item !== undefined; item = nextItem(walker, items)) {
      const appl = item.appl
      if (appl === undefined || !ApplItem.equals(appl, CODEPAGE_DIAG_GUI)) continue
      try {
        return CodepageDiagGUI.decode(item.valueRange.of(items)).codePage
      } catch (error) {
        if (!(error instanceof ItemPayloadError)) throw error
      }
    }
    return undefined
  },

  /**
   * The character set texts in `codePage` are read in: its own, or ISO 8859-1 standing in for a
   * number Swooey does not know (§6.4).
   */
  encoding(codePage: number): TextEncoding {
    return TextEncoding.fromCodePage(codePage) ?? "latin1"
  },

  /**
   * Where the whole value of the `item` whose value starts at `offset` lies in `items`, or undefined
   * when the walk meets none: the item a `ScreenIdentity` range points into (its ranges are trimmed
   * at the end only). Untrimmed: R-SS-4's byte trimming could cut a UTF-16 code unit.
   */
  valueRange(item: ApplItem, offset: number, items: Uint8Array): ByteRange | undefined {
    const walker = new DiagItemWalker()
    for (let next = nextItem(walker, items); next !== undefined; next = nextItem(walker, items)) {
      const appl = next.appl
      if (appl !== undefined && ApplItem.equals(appl, item) && next.valueRange.lowerBound === offset) return next.valueRange
    }
    return undefined
  },

  /**
   * Whether `value`, decoded in `encoding` and trimmed per R-SS-4 after decoding (trailing spaces
   * and zero characters, session.md §6.4), is the logon program's name (R-SS-5). Invalid bytes are
   * replaced, as ScreenModel shows them, so such a value is never the name.
   */
  isLogonProgramName(value: Uint8Array, encoding: TextEncoding): boolean {
    let text = TextEncoding.decodeRepairing(encoding, value)
    while (text.endsWith(" ") || text.endsWith("\u0000")) text = text.slice(0, -1)
    return text === SessionCodePage.logonProgramName
  }
} as const
