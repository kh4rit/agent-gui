// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/RFCHead.swift (MIT).

// The head of an RFC item stream in structure, for the session report (docs/protocol/controls/
// transport.md IMPL-CT-11, issue #150) and diagctl's controls summary (docs/capture.md): each head
// item's id, length and what the report may say about its value (`RFCValueDescription`), the
// relations between the texts it describes, and the text encoding of the stream. Which items it
// describes is the report's scope: the session report only those Readings R-CT-28 and R-CT-36 use,
// diagctl every one but the connection's user and client. No text of the call is kept: a head item
// shows as its description only.

import type { ByteRange } from "./diagCodec.js"
import { FlushCallAnswerBuilder } from "./flushCallAnswer.js"
import { RFCItemWalkError, RFCItemWalker, RFCStreamSummary, type RFCItem } from "./rfcTransfer.js"
import { RFCTextEncoding, RFCTextForm } from "./rfcText.js"
import { RFCValueDescription } from "./rfcValueDescription.js"

/** The space character (`RFCTableContentEncoder.space`, PV-0934). */
const SPACE = 0x20 // provenance: PV-0934

/**
 * Which head items a report describes (issue #150); every other one shows by its id and length
 * only, and takes no part in a relation or the encoding (Swift `RFCHead.Scope`).
 * - `report`: the session report, which the owner shares: only the items Readings R-CT-28, R-CT-29
 *   and R-CT-36 use (`RFCHead.reportIDs`).
 * - `summary`: diagctl's controls summary: every item but the connection's user and client
 *   (`RFCHead.userAndClientIDs`).
 */
export type RFCHeadScope = "report" | "summary"

export const RFCHeadScope = {
  /** Whether a report of this scope describes the value of head item `id`. */
  describes(scope: RFCHeadScope, id: number): boolean {
    switch (scope) {
      case "report":
        return RFCHead.reportIDs.has(id)
      case "summary":
        return !RFCHead.userAndClientIDs.has(id)
    }
  },

  /** What a line says of a value this scope does not describe. */
  notDescribed(scope: RFCHeadScope): string {
    switch (scope) {
      case "report":
        return "value not described"
      case "summary":
        return "value not described (the connection's user or client)"
    }
  }
} as const

/** One head item in structure (Swift `RFCHead.Item`). */
export interface RFCHeadItem {
  /** The item's place in the stream, from 1. */
  readonly index: number
  readonly id: number
  readonly length: number
  /**
   * The value as `RFCValueDescription` describes it, with a relation to an earlier described head
   * text when one holds; for an item the scope does not describe, only that (or `empty`).
   */
  readonly description: string
}

/** Where the stream's text encoding was read (Swift `RFCHead.EncodingSource`). */
export type RFCHeadEncodingSource =
  /** The function name `01 02`, of this length. */
  | { readonly kind: "functionName"; readonly length: number }
  /** The described head texts of two characters or more, all of one encoding. */
  | { readonly kind: "headTexts"; readonly count: number }

/** Swift `try? walker.next(in:)`. */
function nextItem(walker: RFCItemWalker, stream: Uint8Array): RFCItem | undefined {
  try {
    return walker.next(stream)
  } catch (error) {
    if (error instanceof RFCItemWalkError) return undefined
    throw error
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

/**
 * The head of an RFC item stream (rfc-tr.md §7.7.2, §7.7.3): its items before the first function
 * name `01 02`, parameter (`02 01`, `02 05`), type structure `02 13`, table name `03 01` or end item
 * `FF FF`, each described as a report of its scope may describe it, and the stream's text encoding.
 */
export class RFCHead {
  private static reportIDsCache: ReadonlySet<number> | undefined

  /**
   * The head items the session report describes: those R-CT-28 requires and R-CT-29 echoes
   * (PV-0921), and the partner type `00 11` (PV-0798). (Read lazily: flushCallAnswer.ts, which
   * holds the ids, imports this file.)
   */
  static get reportIDs(): ReadonlySet<number> {
    RFCHead.reportIDsCache ??= new Set([...FlushCallAnswerBuilder.echoedHeadIDs, FlushCallAnswerBuilder.partnerTypeID])
    return RFCHead.reportIDsCache
  }

  /**
   * The long form's user (`01 11`, `00 09`) and client number (`01 14`, `01 34`), as pysap's
   * markers name them (PV-0798): no report describes them.
   */
  static readonly userAndClientIDs: ReadonlySet<number> = new Set([0x0111, 0x0009, 0x0114, 0x0134]) // provenance: PV-0798

  /** The ids that end the head (PV-0912, PV-0911). */
  static readonly endIDs: ReadonlySet<number> = new Set([0x0102, 0x0201, 0x0205, 0x0213, 0x0301, 0xffff]) // provenance: PV-0912, PV-0911

  readonly items: RFCHeadItem[] = []
  /** The function name's form, when the stream has one and it is text. */
  functionNameForm: RFCTextForm | undefined = undefined
  /** The function name's length, when the stream has one. */
  functionNameLength: number | undefined = undefined
  /** The function name as `RFCValueDescription` describes it. */
  functionNameDescription: string | undefined = undefined
  /**
   * The stream's text encoding, and where it was read; undefined when neither the function name
   * nor the described head texts show one.
   */
  encoding: RFCTextEncoding | undefined = undefined
  encodingSource: RFCHeadEncodingSource | undefined = undefined

  /** Reads the head of `stream`, describing the items `scope` allows; a walk that stops ends it. */
  constructor(stream: Uint8Array, scope: RFCHeadScope) {
    const walker = new RFCItemWalker()
    const texts: { index: number; id: number; text: Uint8Array; bytes: ByteRange }[] = []
    const headForms: RFCTextEncoding[] = []
    let index = 0
    for (let item = nextItem(walker, stream); item !== undefined; item = nextItem(walker, stream)) {
      index += 1
      const value = item.valueRange.of(stream)
      if (item.id === RFCStreamSummary.functionNameID) {
        this.functionNameLength = value.length
        this.functionNameForm = RFCTextForm.of(value)
        this.functionNameDescription = RFCValueDescription.describe(value, item.id)
        break
      }
      if (RFCHead.endIDs.has(item.id)) break
      if (!RFCHeadScope.describes(scope, item.id)) {
        this.items.push({ index, id: item.id, length: value.length, description: value.length === 0 ? "empty" : RFCHeadScope.notDescribed(scope) })
        continue
      }
      let description = RFCValueDescription.describe(value, item.id)
      const form = RFCTextForm.of(value)
      if (form !== undefined && form !== "otherZeros") {
        let characters = RFCTextForm.characters(value)
        let end = characters.length
        while (end > 0 && characters[end - 1] === SPACE) end -= 1
        let start = 0
        while (start < end && characters[start] === SPACE) start += 1
        characters = characters.slice(start, end)
        const encoding = RFCTextForm.encoding(form)
        if (characters.length >= 2 && encoding !== undefined) headForms.push(encoding) // not-protocol: a word, not a flag
        // A relation to an earlier head text of three characters or more: never the text.
        const earlier = characters.length >= 3 ? texts.find(text => bytesEqual(text.text, characters)) : undefined // not-protocol: a relation worth a line
        if (earlier !== undefined) {
          const same = RFCHead.equal(stream, earlier.bytes, item.valueRange)
          description += same
            ? `; = item ${earlier.index} (${RFCStreamSummary.hex(earlier.id)})`
            : `; the same characters as item ${earlier.index} (${RFCStreamSummary.hex(earlier.id)}), padded or encoded differently`
        }
        texts.push({ index, id: item.id, text: characters, bytes: item.valueRange })
      }
      this.items.push({ index, id: item.id, length: value.length, description })
    }
    const functionEncoding = this.functionNameForm === undefined ? undefined : RFCTextForm.encoding(this.functionNameForm)
    if (functionEncoding !== undefined && this.functionNameLength !== undefined) {
      this.encoding = functionEncoding
      this.encodingSource = { kind: "functionName", length: this.functionNameLength }
    } else if (headForms.length > 0 && headForms.every(form => form === headForms[0])) {
      this.encoding = headForms[0]
      this.encodingSource = { kind: "headTexts", count: headForms.length }
    }
  }

  static equal(stream: Uint8Array, first: ByteRange, second: ByteRange): boolean {
    if (first.count !== second.count) return false
    for (let offset = 0; offset < first.count; offset++) if (stream[first.lowerBound + offset] !== stream[second.lowerBound + offset]) return false
    return true
  }

  /** The text encoding in words: the encoding and where it was read, or that none shows. */
  get encodingText(): string {
    const encoding = this.encoding
    const source = this.encodingSource
    if (encoding === undefined || source === undefined)
      return "text encoding not shown (no function name, and the head's texts show none or several)"
    switch (source.kind) {
      case "functionName": {
        const form = this.functionNameForm === "zeroPadded" ? ", zero-padded" : ""
        return `text encoding ${RFCTextEncoding.rawValue(encoding)}${form} (by its function name 01 02, ${source.length} bytes)`
      }
      case "headTexts":
        return `text encoding ${RFCTextEncoding.rawValue(encoding)} (by its ${source.count} head text(s))`
    }
  }

  /** The head's lines: one per item and the function name, indented by `indent`. */
  lines(indent: string): string[] {
    const lines = this.items.map(item => indent + `item ${item.index}: ${RFCStreamSummary.hex(item.id)}, length ${item.length}; ${item.description}`)
    if (this.functionNameLength !== undefined && this.functionNameDescription !== undefined)
      lines.push(indent + `function name 01 02, length ${this.functionNameLength}; ${this.functionNameDescription}`)
    return lines
  }
}
