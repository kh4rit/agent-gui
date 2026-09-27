// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DyntTestSupport.swift (MIT).

// Hand-built DYNT atoms for the DYNT tests, written byte by byte from dynt-atoms.md and independent
// of DyntAtomEncoder, so that encoder tests compare two separate constructions. Invented texts
// follow docs/testing.md §8 (D15): deliberately silly, ZZ… transaction codes.

import { DyntAtoms, type DyntAtom, type DyntAtomDiagnostics, type DyntAtomWalkError } from "../../diag/codec/index.js"
import { ascii, cat } from "./codecTestSupport.js"

/** Swift's trapping `UInt8(_:)` / `UInt16(_:)`: `value`, which must not exceed `max`. */
function checked(value: number, max: number): number {
  if (value > max) throw new RangeError(`${value} does not fit (at most ${max})`)
  return value
}

export function u16BE(value: number): Uint8Array {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff)
}

/**
 * One atom: u16 BE atom_length (13 + content), dlg flags, etype, area, block, group, u16 BE row and
 * col, attribute byte, then the content.
 */
export function rawAtom(
  etype: number,
  options: {
    content?: ArrayLike<number>
    flags?: [number, number]
    area?: number
    block?: number
    group?: number
    row?: number
    col?: number
    attr?: number
    declaredLength?: number
  } = {}
): Uint8Array {
  const content = options.content ?? []
  const [flag1, flag2] = options.flags ?? [0, 0]
  const length = options.declaredLength ?? checked(13 + content.length, 0xffff)
  return cat(
    u16BE(length),
    [flag1, flag2, etype, options.area ?? 0, options.block ?? 1, options.group ?? 0],
    u16BE(options.row ?? 0),
    u16BE(options.col ?? 0),
    [options.attr ?? 0],
    content
  )
}

/** A `_2` field payload (130–132): u16 flag1, dlen, mlen, u16 maxnrchars, text. */
export function field2Content(
  text: ArrayLike<number>,
  options: { flag1?: number; dlen?: number; mlen?: number; maxNrChars?: number } = {}
): Uint8Array {
  return cat(
    u16BE(options.flag1 ?? 0),
    [options.dlen ?? checked(text.length, 0xff), options.mlen ?? 10],
    u16BE(options.maxNrChars ?? 20),
    text
  )
}

/** A `_1` field payload (121–123): one-byte flag1, dlen, mlen, u16 maxnrchars, text. */
export function field1Content(
  text: ArrayLike<number>,
  options: { flag1?: number; dlen?: number; mlen?: number; maxNrChars?: number } = {}
): Uint8Array {
  return cat([options.flag1 ?? 0, options.dlen ?? checked(text.length, 0xff), options.mlen ?? 10], u16BE(options.maxNrChars ?? 20), text)
}

/**
 * A tabstrip-button payload (116): v_length, v_height, page_id, three u16 offsets, three
 * zero-terminated strings.
 */
export function tabstripContent(fields: { text: ArrayLike<number>; functionCode: ArrayLike<number>; id: ArrayLike<number>; pageID?: number }): Uint8Array {
  return cat(
    [12, 1, fields.pageID ?? 2],
    u16BE(0x0102),
    u16BE(0x0304),
    u16BE(0x0506),
    fields.text,
    [0],
    fields.functionCode,
    [0],
    fields.id,
    [0]
  )
}

/** Walks a whole atom value. */
export function walkAtoms(value: Uint8Array): { atoms: DyntAtom[]; error: DyntAtomWalkError | undefined; diagnostics: DyntAtomDiagnostics } {
  return DyntAtoms.walk(value)
}

/** The etypes whose payload dynt-atoms.md specifies. */
export const specifiedEtypes: ReadonlySet<number> = new Set([114, 115, 116, 120, 121, 122, 123, 127, 129, 130, 131, 132])

/**
 * An invented screen: a label, an input field with its FNAME and XMLPROP children, a password
 * field and a frame. Nothing here resembles a real screen.
 */
export const ZZScreen = {
  label: ascii("Ducks in a row"),
  input: ascii("QUACK"),
  fieldName: ascii("ZZDUCK-POND"),
  property: ascii("<Propertybag/>"),
  frameCaption: ascii("Sock drawer"),

  get atoms(): Uint8Array {
    return cat(
      rawAtom(132, { content: field2Content(ZZScreen.label), row: 1, col: 1, attr: 0x21 }),
      rawAtom(130, { content: field2Content(ZZScreen.input), row: 1, col: 20, attr: 0x40 }),
      rawAtom(114, { content: ZZScreen.fieldName, row: 1, col: 20, attr: 0x40 }),
      rawAtom(120, { content: ZZScreen.property, row: 1, col: 20, attr: 0x40 }),
      rawAtom(130, { content: field2Content([]), flags: [4, 1], row: 2, col: 20, attr: 0x42 }),
      rawAtom(127, { content: cat(u16BE(3), u16BE(40), ZZScreen.frameCaption) })
    )
  }
}
