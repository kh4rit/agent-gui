// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ScreenTestSupport.swift (MIT).

// Hand-built server-screen values and screens for the screen tests, written byte by byte from
// docs/protocol/server-screen.md and independent of the codecs' encoders. Invented texts follow
// docs/testing.md §8 (D15): deliberately silly, ZZ… transaction codes, no real screen's texts.

import type { ScreenIdentity, ScreenIdentityText } from "../../diag/codec/index.js"
import { appl, appl4, ascii, cat, repeated, u32BE } from "./codecTestSupport.js"
import { field2Content, rawAtom, u16BE } from "./dyntTestSupport.js"

/**
 * The bytes of `field`'s text in `items`, or undefined (Swift `ScreenIdentityTests.text(_:_:_:)`,
 * which Bug0142Tests shares). Throws what `ScreenIdentity.text` throws.
 */
export function identityText(identity: ScreenIdentity, field: ScreenIdentityText, items: Uint8Array): Uint8Array | undefined {
  return identity.text(field)?.of(items).slice()
}

/**
 * One menu entry (server-screen.md §8.1): u16 BE length (20 + the three strings with their zero
 * bytes, unless `declaredLength` overrides it), four positions, flags, virtual key, six return
 * codes, six function codes, then text, accelerator and info, each zero-terminated.
 */
export function rawMenuEntry(fields: {
  text: ArrayLike<number>
  accelerator?: ArrayLike<number>
  info?: ArrayLike<number>
  positions?: number[]
  flags?: number
  virtualKey?: number
  returnCodes?: number[]
  functionCodes?: number[]
  declaredLength?: number
}): Uint8Array {
  const accelerator = fields.accelerator ?? []
  const info = fields.info ?? []
  const length = fields.declaredLength ?? 20 + fields.text.length + accelerator.length + info.length + 3
  return cat(
    u16BE(length),
    fields.positions ?? [0, 0, 0, 0],
    [fields.flags ?? 0, fields.virtualKey ?? 0],
    fields.returnCodes ?? [0, 0, 0, 0, 0, 0],
    fields.functionCodes ?? [0, 0, 0, 0, 0, 0],
    fields.text,
    [0],
    accelerator,
    [0],
    info,
    [0]
  )
}

/** Four u32 BE: an AREASIZE-shaped value. */
export function rawAreaSize(windowHeight: number, windowWidth: number, areaHeight: number, areaWidth: number): Uint8Array {
  return cat(u32BE(windowHeight), u32BE(windowWidth), u32BE(areaHeight), u32BE(areaWidth))
}

/**
 * An invented logon-style screen in the order of PV-0703, with D15 texts and the field structure
 * of PV-0724 (not its layout): a label and an EFIELD_2 input per line, FNAME children, one password
 * input with INVISIBLE.
 */
export const ZZLogonScreen = {
  programName: ascii("SAPMSYST"),
  screenNumber: ascii("4242"),
  systemID: ascii("DUK"),
  client: ascii("007"),
  title: ascii("Rubber Duck Debugging"),

  /** Label and input atoms of one logon line, with FNAME children on both and an XMLPROP child on the input. */
  line(fields: { row: number; label: string; input: ArrayLike<number>; mlen: number; maxNrChars: number; invisible?: boolean; name: string }): Uint8Array {
    const fieldName = ascii(fields.name)
    const attr = fields.invisible ? 0x42 : 0x40
    return cat(
      rawAtom(132, { content: field2Content(ascii(fields.label), { mlen: 18, maxNrChars: 18 }), row: fields.row, col: 2, attr: 0x21 }),
      rawAtom(114, { content: fieldName, row: fields.row, col: 2, attr: 0x21 }),
      rawAtom(130, { content: field2Content(fields.input, { mlen: fields.mlen, maxNrChars: fields.maxNrChars }), row: fields.row, col: 22, attr }),
      rawAtom(114, { content: fieldName, row: fields.row, col: 22, attr }),
      rawAtom(120, { content: ascii("<Propertybag/>"), row: fields.row, col: 22, attr })
    )
  },

  get atoms(): Uint8Array {
    return cat(
      ZZLogonScreen.line({ row: 1, label: "Pond", input: ZZLogonScreen.client, mlen: 3, maxNrChars: 3, name: "ZZGATE-POND" }),
      ZZLogonScreen.line({ row: 3, label: "Duck", input: repeated(0x20, 12), mlen: 12, maxNrChars: 12, name: "ZZGATE-DUCK" }),
      ZZLogonScreen.line({ row: 4, label: "Quack", input: [], mlen: 12, maxNrChars: 40, invisible: true, name: "ZZGATE-QUACK" }),
      ZZLogonScreen.line({ row: 6, label: "Tongue", input: ascii("  "), mlen: 2, maxNrChars: 2, name: "ZZGATE-TONGUE" }),
      rawAtom(132, { content: field2Content(ZZLogonScreen.title, { mlen: 21, maxNrChars: 21 }), row: 8, col: 2, attr: 0x21 })
    )
  },

  /**
   * The items of the screen. Several texts are padded with spaces and the theme ends with a zero
   * byte, as the example pads them (PV-0726).
   */
  items(): Uint8Array {
    const pad = [0x20, 0x20, 0x20, 0x20]
    return cat(
      appl(0x06, 0x11, repeated(0, 32)),
      appl(0x06, 0x02, ZZLogonScreen.systemID),
      appl(0x06, 0x0c, ZZLogonScreen.client),
      appl(0x06, 0x03, ascii("zz-pond")),
      appl(0x06, 0x25, cat(ascii("ZZSOCKS"), [0])),
      appl(0x06, 0x07, cat(ascii("ZZQUAK"), pad)),
      [0x01, 0, 0, 0, 0, 0, 0, 0x21, 0, 0, 0, 0, 0, 0, 0, 20, 70],
      appl(0x0c, 0x07, rawAreaSize(20, 70, 20, 70)),
      appl(0x0c, 0x0a, cat(ascii("Duck Pond (1) DUK"), pad)),
      appl(0x06, 0x0f, cat(ZZLogonScreen.programName, pad)),
      appl(0x06, 0x0d, cat(ZZLogonScreen.programName, pad)),
      appl(0x06, 0x10, cat(ascii("ZZHONK"), pad)),
      appl(0x06, 0x0e, ZZLogonScreen.screenNumber),
      appl4(0x0b, 0x01, rawMenuEntry({ text: ZZLogonScreen.title, accelerator: ascii("R"), positions: [1, 0, 0, 0], flags: 0x12 })),
      appl4(
        0x0b,
        0x04,
        cat(
          rawMenuEntry({ text: ascii("Forget the Quack"), flags: 0x02, virtualKey: 5 }),
          rawMenuEntry({ text: ascii("Waddle Away"), positions: [2, 0, 0, 0], flags: 0x02, virtualKey: 15 })
        )
      ),
      appl(0x0c, 0x09, ZZLogonScreen.title),
      appl4(0x09, 0x02, ZZLogonScreen.atoms)
    )
  }
}
