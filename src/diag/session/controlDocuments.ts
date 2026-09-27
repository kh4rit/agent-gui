// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/ControlDocuments.swift (MIT).

import { ByteRange, DiagItemWalkError, DiagItemWalker, type DiagItem } from "../codec/index.js"
import type { ServerMessage } from "./serverMessage.js"

/**
 * Which document a `ControlDocument` is (Swift `ControlDocument.Kind`).
 * - `xmlBlob`: the value of an XMLBLOB item (type 0x11).
 * - `controlProperties`: the value of an APPL CONTROL CONTROL_PROPERTIES item (0x0E, 0x01).
 */
export type ControlDocumentKind = "xmlBlob" | "controlProperties"

export const ControlDocumentKind = {
  /** `XMLBLOB` or `CONTROL_PROPERTIES` (Swift `description`). */
  describe(kind: ControlDocumentKind): string {
    switch (kind) {
      case "xmlBlob":
        return "XMLBLOB"
      case "controlProperties":
        return "CONTROL_PROPERTIES"
    }
  }
} as const

/**
 * A Control Framework document a server message carried, for the developer dump (Session ▸ Copy
 * Control Traffic Dump): the value of an XMLBLOB item (the DATAMANAGER document, datamanager.md) or
 * of a CONTROL_PROPERTIES item (transport.md §3), verbatim. The session report never shows one.
 */
export class ControlDocument {
  /** The most bytes of one document kept. */
  static readonly keptBytes = 1 << 20 // not-protocol: a memory cap, 1 MiB

  constructor(
    readonly kind: ControlDocumentKind,
    /** The item's value, cut at `keptBytes`. */
    readonly bytes: Uint8Array,
    /** The value's length as received. */
    readonly length: number
  ) {}
}

/** Swift `try? walker.next(in:)`. */
function nextItem(walker: DiagItemWalker, items: Uint8Array): DiagItem | undefined {
  try {
    return walker.next(items)
  } catch (error) {
    if (error instanceof DiagItemWalkError) return undefined
    throw error
  }
}

/**
 * The XMLBLOB and CONTROL_PROPERTIES values of `message`, in item order; empty when it carries none
 * or its items do not walk. (Swift `extension ServerMessage { var controlDocuments }`; read it as
 * `message.controlDocuments`.)
 */
export function readControlDocuments(message: ServerMessage): ControlDocument[] {
  return (
    message.withItems(items => {
      const documents: ControlDocument[] = []
      const walker = new DiagItemWalker()
      for (let item = nextItem(walker, items); item !== undefined; item = nextItem(walker, items)) {
        let kind: ControlDocumentKind
        const appl = item.appl
        if (item.type === "xmlblob") {
          kind = "xmlBlob"
        } else if (appl !== undefined && appl.kind === "control" && appl.sid === "controlProperties") {
          kind = "controlProperties"
        } else {
          continue
        }
        const range = item.valueRange
        const kept = new ByteRange(range.lowerBound, Math.min(range.upperBound, range.lowerBound + ControlDocument.keptBytes))
        documents.push(new ControlDocument(kind, kept.of(items).slice(), range.count))
      }
      return documents
    }) ?? []
  )
}
