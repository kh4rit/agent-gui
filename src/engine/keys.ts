// SPDX-License-Identifier: MIT
// Key names the agent types ("F8", "Shift+F2", "PageDown") and SAP's virtual key numbers (the
// GUI_FKEY table, PV-0731): 0 Enter, 1–12 F-keys, 13–24 with Shift, 25–36 with Ctrl, 37–48 with
// Ctrl+Shift, 70–86 Ctrl letters and paging (Swooey VirtualKey, SwooeyApp/ScreenFunctions.swift).

import { GUIVirtualKey } from "../diag/codec/index.js"

export const VirtualKeys = {
  enter: 0,
  save: 11,
  firstPage: 80,
  previousPage: 81,
  nextPage: 82,
  lastPage: 83
} as const

const ALIASES = new Map<string, number>([
  ["enter", 0],
  ["return", 0],
  ["pagedown", VirtualKeys.nextPage],
  ["nextpage", VirtualKeys.nextPage],
  ["pgdn", VirtualKeys.nextPage],
  ["pageup", VirtualKeys.previousPage],
  ["previouspage", VirtualKeys.previousPage],
  ["prevpage", VirtualKeys.previousPage],
  ["pgup", VirtualKeys.previousPage],
  ["firstpage", VirtualKeys.firstPage],
  ["ctrl+pageup", VirtualKeys.firstPage],
  ["lastpage", VirtualKeys.lastPage],
  ["ctrl+pagedown", VirtualKeys.lastPage],
  ["back", 3],
  ["exit", 15],
  ["cancel", 12],
  ["execute", 8],
  ["choose", 2],
  ["help", 1],
  ["valuehelp", 4]
])

const normalize = (key: string) =>
  key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/control\+/g, "ctrl+")
    .replace(/strg\+/g, "ctrl+")
    .replace(/umschalt\+/g, "shift+")

/** The virtual key a key name stands for, or undefined. `Shift+Ctrl+F1` and `Ctrl+Shift+F1` are one key. */
export function parseKey(name: string): number | undefined {
  const key = normalize(name)
  const alias = ALIASES.get(key)
  if (alias !== undefined) return alias
  const m = /^((?:shift\+|ctrl\+)*)f(\d{1,2})$/.exec(key)
  if (m) {
    const number = Number(m[2])
    if (number < 1 || number > 12) return undefined
    const shift = m[1].includes("shift+")
    const ctrl = m[1].includes("ctrl+")
    return number + (shift ? 12 : 0) + (ctrl ? 24 : 0)
  }
  // The key table's own names (Ctrl+S, Ctrl+F, …).
  for (let vk = 0; vk <= 86; vk++) {
    const combination = GUIVirtualKey.keyCombination(vk)
    if (combination && normalize(combination) === key) return vk
  }
  if (/^\d{1,2}$/.test(key)) return Number(key)
  return undefined
}

/** The key combination of a virtual key, e.g. "F8", "Shift+F2", "Ctrl+S". */
export function keyLabel(virtualKey: number | undefined): string | undefined {
  if (virtualKey === undefined) return undefined
  if (virtualKey === VirtualKeys.nextPage) return "PageDown"
  if (virtualKey === VirtualKeys.previousPage) return "PageUp"
  if (virtualKey === VirtualKeys.firstPage) return "First page"
  if (virtualKey === VirtualKeys.lastPage) return "Last page"
  return GUIVirtualKey.keyCombination(virtualKey)
}

/** The virtual key an OK-code fires in the batch-input spelling `/NN` (Reading R-CI-20), or undefined. */
export function okCodeVirtualKey(okcode: string): number | undefined {
  const m = /^\/(\d{2,3})$/.exec(okcode.trim())
  if (!m) return undefined
  const value = Number(m[1])
  return value <= 255 ? value : undefined
}
