// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/LogonCodePageTests.swift (MIT): its `CodePageScreens`,
// which GUIBlobSessionTests shares.

import {
  ApplItem,
  ClientIdentity,
  DiagItemEncoder,
  DyntAtomEncoder,
  DyntAttributes,
  DyntElementType,
  ScreenText,
  SupportBits,
  TextEncoding
} from "../../diag/codec/index.js"
import { SessionMachine } from "../../diag/session/index.js"
import { ByteWriter } from "../../diag/wire/index.js"
import { cat } from "./codecTestSupport.js"
import { Fixtures, LogonScreens, utf8 } from "./sessionTestSupport.js"

// MARK: - Code page screens (Swift `CodePageScreens`)

/** Screens in one code page, built with the codec's encoders. */
export const CodePageScreens = {
  /** `text` in `encoding`: the tests use UTF-16 and UTF-8, which represent every string. */
  bytes(text: string, encoding: TextEncoding): Uint8Array {
    return TextEncoding.encode(encoding, text) ?? new Uint8Array(0)
  },

  /** `text` in UTF-16LE. */
  utf16LE(text: string): Uint8Array {
    return CodePageScreens.bytes(text, "utf16LittleEndian")
  },

  /** An APPL text item whose value is `bytes` as they are. */
  textItem(item: ApplItem, bytes: Uint8Array): Uint8Array {
    const output = new ByteWriter()
    ScreenText.appendItem(item, bytes, output)
    return output.toBytes()
  },

  /**
   * An ST_R3INFO CODEPAGE_DIAG_GUI item (PV-0532): the number, the minimum bytes per character,
   * the number as text and an invented description, each zero-terminated.
   */
  codePageItem(codePage: number): Uint8Array {
    const value = cat(
      [(codePage >>> 24) & 0xff, (codePage >>> 16) & 0xff, (codePage >>> 8) & 0xff, codePage & 0xff, 2],
      utf8(`${codePage}`),
      [0],
      utf8("Pond script"),
      [0]
    )
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("codepageDiagGUI"), value, items)
    return items.toBytes()
  },

  /**
   * The Moat gate with every text in `encoding`: DYNPRONAME padded with spaces as the example
   * pads it (PV-0726), a label, a user field (maxnrchars 12) and the password field (INVISIBLE,
   * 40), the structure LogonStep looks for (R-SS-9). `declaring` adds a CODEPAGE_DIAG_GUI item
   * after the texts: a declaration governs the whole message (Reading R-SE-9).
   */
  gateItems(encoding: TextEncoding, options: { program?: string; declaring?: number } = {}): Uint8Array {
    const atoms = new ByteWriter()
    DyntAtomEncoder.appendField(
      LogonScreens.header(DyntElementType.of("keyword2"), { row: 1, col: 4, attributes: DyntAttributes.protected }),
      { mlen: 10, maxNrChars: 10, text: CodePageScreens.bytes("Moat gate", encoding) },
      atoms
    )
    DyntAtomEncoder.appendField(
      LogonScreens.header(DyntElementType.of("efield2"), { row: 6, flags: [0, 1], attributes: DyntAttributes.yes3D }),
      { mlen: 12, maxNrChars: 12, text: new Uint8Array(0) },
      atoms
    )
    DyntAtomEncoder.appendField(
      LogonScreens.header(DyntElementType.of("efield2"), {
        row: 8,
        flags: [4, 1],
        attributes: DyntAttributes.yes3D | DyntAttributes.invisible
      }),
      { mlen: 12, maxNrChars: 40, text: new Uint8Array(0) },
      atoms
    )
    const items = new ByteWriter()
    items.bytes(CodePageScreens.textItem(ApplItem.stSystemInfo("dynproName"), CodePageScreens.bytes((options.program ?? "SAPMSYST") + "    ", encoding)))
    items.bytes(CodePageScreens.textItem(ApplItem.stSystemInfo("dynproNumber"), CodePageScreens.bytes("0271", encoding)))
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), atoms.toBytes(), items)
    if (options.declaring !== undefined) items.bytes(CodePageScreens.codePageItem(options.declaring))
    return items.toBytes()
  },

  /** `gateItems(_:program:declaring:)` as an uncompressed message. */
  gate(encoding: TextEncoding, options: { program?: string; declaring?: number } = {}): Uint8Array {
    return Fixtures.message(CodePageScreens.gateItems(encoding, options))
  },

  /** The moat's lobby in `encoding`: an invented program past the logon screen. */
  lobby(encoding: TextEncoding): Uint8Array {
    return Fixtures.message(
      cat(
        CodePageScreens.textItem(ApplItem.stSystemInfo("dynproName"), CodePageScreens.bytes("ZZ_MOAT_LOBBY", encoding)),
        CodePageScreens.textItem(ApplItem.stSystemInfo("dynproNumber"), CodePageScreens.bytes("0100", encoding))
      )
    )
  },

  /** An identity whose CONNECT requests `codePage` and declares nothing else. */
  identity(codePage: number): ClientIdentity {
    return new ClientIdentity({ codePage, wsType: 0, supportData: new SupportBits() })
  },

  /** A machine that requested `codePage` in CONNECT and waits for the first reply. */
  awaitingMachine(codePage: number): SessionMachine {
    const machine = new SessionMachine(CodePageScreens.identity(codePage), Fixtures.terminal)
    machine.start()
    return machine
  }
} as const
