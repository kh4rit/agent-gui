// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenMenu.swift (MIT).

import type { ApplSIDMnuEntry, MenuEntryFields } from "../codec/index.js"

/** One entry of a menu (PV-0718). */
export class ScreenMenuEntry {
  /**
   * The text in the screen's code page (`Screen.textEncoding`); never undefined since texts are
   * always decoded, repaired or read as ISO 8859-1 (`ScreenDiagnostics`).
   */
  readonly text: string | undefined
  /** The accelerator, or undefined when it is empty. */
  readonly accelerator: string | undefined
  /** The info string, or undefined when it is empty. */
  readonly info: string | undefined
  /** Positions, flags, virtual key, return and function codes, as the codec reads them (#50). */
  readonly fields: MenuEntryFields

  constructor(fields: { text: string | undefined; accelerator: string | undefined; info: string | undefined; fields: MenuEntryFields }) {
    this.text = fields.text
    this.accelerator = fields.accelerator
    this.info = fields.info
    this.fields = fields.fields
  }

  /** The virtual key (entry byte 7). */
  get virtualKey(): number {
    return this.fields.virtualKey
  }
}

/**
 * One MNUENTRY item of a screen (server-screen.md §8.1): its sid and its entries. What the four sids
 * and the entry fields mean is #50; the model keeps them as the codec reads them.
 */
export class ScreenMenu {
  /** MENU_ACT, MENU_MNU, MENU_PFK or MENU_KYB. */
  readonly kind: ApplSIDMnuEntry
  readonly entries: readonly ScreenMenuEntry[]
  /** Whether the entry walk stopped before the end of the value; the entries before the stop are kept (IMPL-SS-5). */
  readonly isTruncated: boolean

  constructor(fields: { kind: ApplSIDMnuEntry; entries: readonly ScreenMenuEntry[]; isTruncated: boolean }) {
    this.kind = fields.kind
    this.entries = fields.entries
    this.isTruncated = fields.isTruncated
  }
}
