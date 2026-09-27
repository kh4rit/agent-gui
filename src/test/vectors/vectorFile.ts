// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/VectorFile.swift (MIT).

import { readFileSync } from "node:fs"

/** A malformed vector file. */
export class VectorParseError extends Error {
  constructor(
    readonly path: string,
    readonly line: number | undefined,
    readonly detail: string
  ) {
    super(line !== undefined ? `${path}:${line}: ${detail}` : `${path}: ${detail}`)
    this.name = "VectorParseError"
  }
}

/** One parsed vector file, in the format of test/vectors/README.md ("File format"). */
export class VectorFile {
  /** Keys every vector must carry. */
  static readonly requiredKeys = ["source", "spec", "provenance", "kind", "description", "derivation"]
  /** Prefix of every other key. */
  static readonly expectPrefix = "expect."

  constructor(
    /** Where the vector came from (a path relative to the repository root, or a label). */
    readonly path: string,
    /** Header keys and values, in file order. */
    readonly header: { key: string; value: string }[],
    /** The input bytes from the hex section. */
    readonly bytes: Uint8Array
  ) {}

  get source(): string { return this.value("source") ?? "" }
  get spec(): string { return this.value("spec") ?? "" }
  get kind(): string { return this.value("kind") ?? "" }
  get description(): string { return this.value("description") ?? "" }
  get derivation(): string { return this.value("derivation") ?? "" }

  /** The comma-separated `provenance` IDs. */
  get provenance(): string[] {
    return (this.value("provenance") ?? "").split(",").map(s => s.trim())
  }

  /** Every `expect.*` key with its value. */
  get expectations(): Map<string, string> {
    const result = new Map<string, string>()
    for (const entry of this.header) if (entry.key.startsWith(VectorFile.expectPrefix)) result.set(entry.key, entry.value)
    return result
  }

  /** The value of a header key. */
  value(key: string): string | undefined {
    return this.header.find(e => e.key === key)?.value
  }

  /** Parses the text of a vector file. `path` only labels error messages. */
  static parse(text: string, path = "<text>"): VectorFile {
    if (text.includes("\r")) throw new VectorParseError(path, undefined, "CR found: vector files use LF line endings")
    const lines = text.split("\n")
    const header: { key: string; value: string }[] = []
    const seen = new Set<string>()
    let hexLine: number | undefined
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line === "hex:") {
        hexLine = index
        break
      }
      const [key, value] = parseHeaderLine(line, path, index + 1)
      if (seen.has(key)) throw new VectorParseError(path, index + 1, `duplicate key '${key}'`)
      if (!VectorFile.requiredKeys.includes(key) && !key.startsWith(VectorFile.expectPrefix))
        throw new VectorParseError(path, index + 1, `unknown key '${key}': other keys start with 'expect.'`)
      seen.add(key)
      header.push({ key, value })
    }
    if (hexLine === undefined) throw new VectorParseError(path, undefined, "no 'hex:' line")
    for (const key of VectorFile.requiredKeys)
      if (!seen.has(key)) throw new VectorParseError(path, undefined, `missing required key '${key}'`)
    const bytes: number[] = []
    for (let index = hexLine + 1; index < lines.length; index++) {
      const code = lines[index].split("#", 1)[0]
      for (const token of code.split(/[ \t]+/)) {
        if (token === "") continue
        const byte = hexByteToken(token)
        if (byte === undefined) throw new VectorParseError(path, index + 1, `bad hex token '${token}'`)
        bytes.push(byte)
      }
    }
    return new VectorFile(path, header, Uint8Array.from(bytes))
  }

  /** Reads and parses a vector file. `label` names it in errors (default: the path). */
  static load(path: string, label?: string): VectorFile {
    const name = label ?? path
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      throw new VectorParseError(name, undefined, "cannot read file")
    }
    return VectorFile.parse(text, name)
  }
}

/** `# <key>: <value>`: a `#`, one space, the key, a colon, one space, the value (trimmed). */
function parseHeaderLine(line: string, path: string, number: number): [string, string] {
  const colon = line.indexOf(":")
  if (!line.startsWith("# ") || colon < 0) throw new VectorParseError(path, number, "header line must read '# <key>: <value>'")
  const key = line.slice(2, colon)
  const afterColon = line.slice(colon + 1)
  if (!isValidKey(key) || !afterColon.startsWith(" ")) throw new VectorParseError(path, number, "header line must read '# <key>: <value>'")
  const value = afterColon.trim()
  if (!value) throw new VectorParseError(path, number, `empty value for '${key}'`)
  return [key, value]
}

/** `[a-z0-9][a-z0-9_.-]*` */
export function isValidKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]*$/.test(key)
}

/** Exactly two hex digits (either case). */
export function hexByteToken(token: string): number | undefined {
  return /^[0-9A-Fa-f]{2}$/.test(token) ? parseInt(token, 16) : undefined
}
