// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/DyntVectorRunner.swift (MIT).

// Runner for the `dynt-atoms` vector kind (test/vectors/README.md, "dynt-atoms"): the atom walker
// of docs/protocol/dynt-atoms.md on one DYNT_ATOM item value.

import {
  DyntAtomEncoder,
  DyntAtomEncodingError,
  DyntAtoms,
  DyntAttributes,
  DyntElementType,
  type DyntAtom,
  type DyntAtomWalkErrorInfo
} from "../../diag/codec/index.js"
import { ByteWriter, bytesEqual, hexByte, hexText } from "../../diag/wire/index.js"
import { compare, isOptionalKey as isOptionalKeyOfKind } from "./codecRunners.js"
import type { Expectations } from "./expectations.js"
import { registerKind } from "./registry.js"
import type { VectorFile } from "./vectorFile.js"
import { NO_ERROR } from "./wireRunners.js"

/** Error classes of the dynt-atoms kind. */
export function dyntAtomWalkErrorClass(info: DyntAtomWalkErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return "truncated"
    case "badAtomLength":
      return "bad-atom-length"
  }
}

/**
 * Whether an atom's vector carries `expect.atom.<n>.text_offset` and `text_length` (README,
 * "dynt-atoms").
 * - `required`: the etypes whose payload is one decoded text, which the README lists: FNAME (114),
 *   XMLPROP (120), frame (127) and the field variants (121–123, 130–132).
 * - `optional`: tabstrip button (116). Its payload has three strings (PV-0656), so the README's
 *   list does not name it and a vector written to it gives no text keys; its table ("when the etype
 *   has a decoded text") still admits the caption. The keys are therefore optional: compared with
 *   the caption when given, never required (#42).
 * - `undefined`: every other etype: only the content keys are given, and text keys are not
 *   consumed.
 */
export type DyntTextKeys = "required" | "optional" | "undefined"

export function textKeys(etype: DyntElementType): DyntTextKeys {
  switch (etype.kind) {
    case "fname":
    case "xmlprop":
    case "frame1":
      return "required"
    case "tabstripButton":
      return "optional"
    default:
      return DyntElementType.fieldForm(etype) === undefined ? "undefined" : "required"
  }
}

/**
 * Keys a vector may leave out: those `isOptionalKey` names for its kind and, in a dynt-atoms vector,
 * the text keys of a tabstrip-button (116) atom (`optional`), found by the atom's
 * `expect.atom.<n>.etype`.
 */
export function isOptionalKey(key: string, vector: VectorFile): boolean {
  if (isOptionalKeyOfKind(key, vector.kind)) return true
  if (vector.kind !== "dynt-atoms") return false
  const parts = key.split(".")
  if (parts.length !== 4 || parts[0] !== "expect" || parts[1] !== "atom" || (parts[3] !== "text_offset" && parts[3] !== "text_length"))
    return false
  const etype = vector.expectations.get(`expect.atom.${parts[2]}.etype`)
  if (etype === undefined || !/^[0-9]+$/.test(etype) || Number(etype) > 0xff) return false
  return textKeys(DyntElementType.fromRaw(Number(etype))) === "optional"
}

/**
 * The atom walker (README, "dynt-atoms"). Atoms produced before an error count. The vector is run
 * as one buffer: the walker is always fed one complete item value (R-DA-1).
 */
function runDyntAtoms(input: Uint8Array, expect: Expectations, failures: string[]): void {
  const walk = DyntAtoms.walk(input)
  compare("error", expect.string("expect.error"), walk.error ? dyntAtomWalkErrorClass(walk.error.info) : NO_ERROR, failures)
  if (walk.error) compare("error.atom", expect.int("expect.error.atom"), walk.error.atomIndex, failures)
  checkAtomLayout(walk.atoms, input, failures)
  const count = expect.int("expect.atoms")
  if (count === undefined) return
  compare("atoms", count, walk.atoms.length, failures)
  for (let number = 1; number <= count; number++)
    checkAtom(number, number <= walk.atoms.length ? walk.atoms[number - 1] : undefined, expect, failures)
}

function checkAtom(number: number, atom: DyntAtom | undefined, expect: Expectations, failures: string[]): void {
  const prefix = `expect.atom.${number}.`
  const etype = expect.int(prefix + "etype")
  const length = expect.int(prefix + "length")
  const flag1 = expect.byte(prefix + "dlg_flag_1")
  const flag2 = expect.byte(prefix + "dlg_flag_2")
  const area = expect.int(prefix + "area")
  const block = expect.int(prefix + "block")
  const group = expect.int(prefix + "group")
  const row = expect.int(prefix + "row")
  const col = expect.int(prefix + "col")
  const attr = expect.byte(prefix + "attr")
  const attrNames = expect.names(prefix + "attr.names")
  const contentOffset = expect.int(prefix + "content_offset")
  const contentLength = expect.int(prefix + "content_length")
  if (!atom) {
    // Read the conditional keys too, so that only the count mismatch is reported.
    for (const key of ["text_offset", "text_length", "field.dlen", "field.mlen", "field.maxnrchars"]) expect.string(prefix + key, false)
    return
  }
  const label = `atom ${number}`
  compare(`${label} etype`, etype, DyntElementType.rawValue(atom.etype), failures)
  compare(`${label} length`, length, atom.length, failures)
  compare(`${label} dlg_flag_1`, flag1, atom.dialogFlags.flag1, failures)
  compare(`${label} dlg_flag_2`, flag2, atom.dialogFlags.flag2, failures)
  compare(`${label} area`, area, atom.area, failures)
  compare(`${label} block`, block, atom.block, failures)
  compare(`${label} group`, group, atom.group, failures)
  compare(`${label} row`, row, atom.row, failures)
  compare(`${label} col`, col, atom.col, failures)
  if (attr !== undefined && attr !== atom.attributes) failures.push(`${label} attr: expected ${hexByte(attr)}, got ${hexByte(atom.attributes)}`)
  compare(`${label} attr.names`, attrNames, DyntAttributes.names(atom.attributes), failures)
  compare(`${label} content_offset`, contentOffset, atom.contentRange.lowerBound, failures)
  compare(`${label} content_length`, contentLength, atom.contentRange.count, failures)

  switch (textKeys(atom.etype)) {
    case "required": {
      // A payload that did not decode has no text to compare (#36, #38; no vector covers one): the
      // field branch below reports a field atom, and text keys given anyway are reported as not
      // consumed.
      const text = atom.textRange
      if (text) {
        compare(`${label} text_offset`, expect.int(prefix + "text_offset"), text.lowerBound, failures)
        compare(`${label} text_length`, expect.int(prefix + "text_length"), text.count, failures)
      }
      break
    }
    case "optional": {
      const textOffset = expect.int(prefix + "text_offset", false)
      const textLength = expect.int(prefix + "text_length", false)
      if (textOffset !== undefined || textLength !== undefined) {
        const text = atom.textRange
        if (text) {
          compare(`${label} text_offset`, textOffset, text.lowerBound, failures)
          compare(`${label} text_length`, textLength, text.count, failures)
        } else {
          failures.push(`${label}: text keys given, but the payload has no decoded text (${JSON.stringify(atom.payload)})`)
        }
      }
      break
    }
    case "undefined":
      break // text keys given anyway are reported as not consumed
  }
  // The field keys exist for 121–123 and 130–132, and only for atoms whose dlen fills the rest of
  // the atom (#36): anything else is a failure.
  if (DyntElementType.fieldForm(atom.etype) !== undefined) {
    const dlen = expect.int(prefix + "field.dlen")
    const mlen = expect.int(prefix + "field.mlen")
    const maxNrChars = expect.int(prefix + "field.maxnrchars")
    if (atom.payload.kind !== "field") {
      failures.push(`${label}: a field atom whose payload did not decode (${JSON.stringify(atom.payload)})`)
      return
    }
    const field = atom.payload.value
    compare(`${label} field.dlen`, dlen, field.dlen, failures)
    compare(`${label} field.mlen`, mlen, field.mlen, failures)
    compare(`${label} field.maxnrchars`, maxNrChars, field.maxNrChars, failures)
  }
}

/**
 * Implementation checks every vector gets: the atoms tile the input from offset 0, and re-encoding
 * each atom, raw and through its typed encoder, gives back its bytes.
 */
function checkAtomLayout(atoms: readonly DyntAtom[], input: Uint8Array, failures: string[]): void {
  let offset = 0
  for (const atom of atoms) {
    if (atom.offset !== offset || atom.endOffset > input.length) {
      failures.push(`atom ${atom.index} does not start where atom ${atom.index - 1} ended`)
      return
    }
    offset = atom.endOffset
    const bytes = input.subarray(atom.offset, atom.endOffset)
    const raw = new ByteWriter()
    try {
      DyntAtomEncoder.appendAtom(atom.header, atom.contentRange.of(input), raw)
    } catch (error) {
      if (!(error instanceof DyntAtomEncodingError)) throw error
    }
    if (!bytesEqual(raw.toBytes(), bytes)) failures.push(`atom ${atom.index}: re-encoding the header and content gives ${hexText(raw.toBytes())}`)
    const typed = typedEncoding(atom, input)
    if (typed !== undefined && !bytesEqual(typed, bytes)) failures.push(`atom ${atom.index}: the typed encoder gives ${hexText(typed)}`)
  }
}

/** The atom through the encoder of its payload, or undefined for payloads without one. */
function typedEncoding(atom: DyntAtom, input: Uint8Array): Uint8Array | undefined {
  const output = new ByteWriter()
  try {
    const payload = atom.payload
    switch (payload.kind) {
      case "text":
        DyntAtomEncoder.appendText(atom.header, payload.value.of(input), output)
        break
      case "field": {
        const field = payload.value
        DyntAtomEncoder.appendField(
          atom.header,
          { flag1: field.flag1, mlen: field.mlen, maxNrChars: field.maxNrChars, text: field.textRange.of(input) },
          output
        )
        break
      }
      case "frame":
        DyntAtomEncoder.appendFrame(atom.header, payload.value.drows, payload.value.dcols, payload.value.textRange.of(input), output)
        break
      case "tabstripButton": {
        const button = payload.value
        if (button.trailingByteCount !== 0) return undefined
        DyntAtomEncoder.appendTabstripButton(
          atom.header,
          {
            vLength: button.vLength,
            vHeight: button.vHeight,
            pageID: button.pageID,
            functionCodeOffset: button.functionCodeOffset,
            textOffset: button.textOffset,
            idOffset: button.idOffset,
            text: button.textRange.of(input),
            functionCode: button.functionCodeRange.of(input),
            id: button.idRange.of(input)
          },
          output
        )
        break
      }
      default:
        return undefined
    }
  } catch (error) {
    if (!(error instanceof DyntAtomEncodingError)) throw error
    return new Uint8Array(0)
  }
  return output.toBytes()
}

registerKind("dynt-atoms", runDyntAtoms)
