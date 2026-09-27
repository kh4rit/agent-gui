// SPDX-License-Identifier: MIT
// Text helpers shared by the tools and the CLI.

/** Turns any thrown value into a message an agent can act on. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export function truncate(text: string, max = 20000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n... (${text.length - max} more characters truncated)`
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

export const line = (parts: (string | undefined | false)[], sep = "  ") =>
  parts.filter(p => p !== undefined && p !== false && p !== "").join(sep)

/** Pads or cuts `text` to exactly `width` characters (for table columns). */
export function cell(text: string, width: number): string {
  if (text.length > width) return width > 1 ? text.slice(0, width - 1) + "…" : text.slice(0, width)
  return text.padEnd(width, " ")
}
