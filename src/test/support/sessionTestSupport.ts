// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/SessionTestSupport.swift (MIT), with the helpers the
// session test files share: `LogonScreens` and `InputStepSessionTests.step()`
// (InputStepSessionTests.swift), `LogonStepTests.credentials` and `decode`
// (LogonStepTests.swift), the envelope values and helpers of ReferenceEnvelopeSessionTests.swift,
// and the message builders of ControlTrafficTests.swift. In node:test a test file cannot import
// another test file without running its tests again, so they live here.
//
// Spec vectors, server messages built from them, and a scripted transport. Invented names follow
// docs/testing.md §8 (D15).

import assert from "node:assert/strict"
import {
  ApplItem,
  ClientIdentities,
  ClientIdentity,
  ClientInputStep,
  CompressField,
  CompressionHeader,
  Decompressor,
  DiagHeader,
  DiagItemEncoder,
  DiagItemType,
  DiagItemWalker,
  DiagMessage,
  DialogStepNumber,
  DyntAtomEncoder,
  DyntAtomHeader,
  DyntAttributes,
  DyntAtomWalker,
  DyntDialogFlags,
  DyntElementType,
  ReturnedField,
  ScreenText,
  Secret,
  SupportBits,
  type ClientItem,
  type ComFlag,
  type DiagItem,
  type DyntAtom
} from "../../diag/codec/index.js"
import { LZHEncoder } from "../../diag/compression/index.js"
import {
  ControlReadings,
  DiagSession,
  DiagTransportError,
  LogonCredentials,
  SessionMachine,
  type DiagTransport,
  type DiagTransportEvent,
  type LogonStep,
  type ServerMessage
} from "../../diag/session/index.js"
import { ByteWriter, DPTerminalName, concatBytes } from "../../diag/wire/index.js"
import { loadVector } from "../vectors/paths.js"

/** UTF-8 bytes of an invented text (Swift `Array(text.utf8)`). */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

// MARK: - Fixtures

export const Fixtures = {
  /**
   * The fake server reads neither CONNECT nor SUPPORTDATA (PV-0700), and the values Swooey will
   * declare are open (#16, #17, #18): the tests declare nothing. A fresh copy on every read.
   */
  get identity(): ClientIdentity {
    return new ClientIdentity({ codePage: 0, wsType: 0, supportData: new SupportBits() })
  },

  /** An invented terminal name (IMPL-DP-1 asks the client for the real host name; tests never use it). */
  terminal: DPTerminalName.fromHostName("mallard"),

  machine(maxUncompressedLength: number = Decompressor.defaultMaxUncompressedLength): SessionMachine {
    return new SessionMachine(Fixtures.identity, Fixtures.terminal, { maxUncompressedLength })
  },

  /** The machine after its first message: waiting for the server's first reply. */
  awaitingMachine(): SessionMachine {
    const machine = Fixtures.machine()
    machine.start()
    return machine
  },

  /** The bytes of a spec vector, by its path under test/vectors (Swift `Tests/Vectors/`). */
  vector(path: string): Uint8Array {
    return loadVector("test/vectors/" + path).bytes
  },

  /** A header with every field 0 but those given; compress 0 unless given. */
  header(fields: { comFlag?: ComFlag; errNo?: number; compress?: CompressField } = {}): DiagHeader {
    return new DiagHeader({
      mode: 0,
      comFlag: fields.comFlag ?? 0,
      modeStat: 0,
      errNo: fields.errNo ?? 0,
      msgType: 0,
      msgInfo: 0,
      msgRC: 0,
      compress: fields.compress ?? CompressField.uncompressed
    })
  },

  /** A server message: the header, then `body` as it is. */
  message(body: ArrayLike<number>, fields: { comFlag?: ComFlag; errNo?: number } = {}): Uint8Array {
    return concatBytes(Fixtures.header(fields).bytes, body)
  },

  /**
   * A compressed server message: compress 1, an LZH compression header, then `body` as LZH data
   * (compression-header.md, compression-lzh.md).
   */
  compressedMessage(body: Uint8Array, errNo = 0): Uint8Array {
    const message = new ByteWriter()
    message.bytes(Fixtures.header({ errNo, compress: CompressField.compressed }).bytes)
    CompressionHeader.lzh(body.length).serialize(message)
    new LZHEncoder().encodeInto(body, message)
    return message.toBytes()
  },

  /**
   * The minimal logon-style screen of server-screen.md §6.2: SAPMSYST, screen 1337, two inputs, one
   * of them INVISIBLE.
   */
  get minimalScreenItems(): Uint8Array {
    return Fixtures.vector("server-screen/minimal-logon-screen.vec")
  },

  get minimalScreen(): Uint8Array {
    return Fixtures.message(Fixtures.minimalScreenItems)
  },

  /** An APPL text item. */
  text(item: ApplItem, text: string): Uint8Array {
    const output = new ByteWriter()
    ScreenText.appendItem(item, utf8(text), output)
    return output.toBytes()
  }
} as const

// MARK: - Scripted transport

/** What a scripted transport does when the session reads: hand over an event, or fail the read. */
export type ScriptStep = { readonly kind: "event"; readonly event: DiagTransportEvent } | { readonly kind: "fail"; readonly error: DiagTransportError }

export const ScriptStep = {
  event: (event: DiagTransportEvent): ScriptStep => ({ kind: "event", event }),
  payload: (payload: Uint8Array): ScriptStep => ({ kind: "event", event: { kind: "payload", payload } }),
  pingAnswered: (): ScriptStep => ({ kind: "event", event: { kind: "pingAnswered" } }),
  fail: (error: DiagTransportError): ScriptStep => ({ kind: "fail", error })
} as const

/** What a scripted transport was asked to do. One test uses it. */
export class TransportLog {
  /** The reads still to come; when it runs out, the peer has closed the connection. */
  script: ScriptStep[]
  /** Payloads written (copies). */
  sent: Uint8Array[] = []
  /** Write attempts, including failed ones. */
  sendAttempts = 0
  /** Which write attempt (from 1) fails, if any. */
  failingSend: number | undefined
  receiveCount = 0
  closeCount = 0

  constructor(script: ScriptStep[] = [], failingSend?: number) {
    this.script = script
    this.failingSend = failingSend
  }

  /** A fresh copy of the one failure a scripted write throws. */
  static get sendFailure(): DiagTransportError {
    return new DiagTransportError({ kind: "connectionFailed", reason: "the pond froze over" })
  }
}

/** A transport that replays a script and records every write. */
export class ScriptedTransport implements DiagTransport {
  constructor(readonly log: TransportLog) {}

  async send(payload: Uint8Array): Promise<void> {
    this.log.sendAttempts += 1
    if (this.log.failingSend === this.log.sendAttempts) throw TransportLog.sendFailure
    this.log.sent.push(payload.slice())
  }

  async receive(): Promise<DiagTransportEvent | undefined> {
    this.log.receiveCount += 1
    const next = this.log.script.shift()
    if (next === undefined) return undefined
    if (next.kind === "fail") throw next.error
    return next.event
  }

  async close(): Promise<void> {
    this.log.closeCount += 1
  }
}

/** A session on a scripted transport. */
export function scriptedSession(log: TransportLog, identity: ClientIdentity = Fixtures.identity): DiagSession<ScriptedTransport> {
  return new DiagSession(new ScriptedTransport(log), identity, Fixtures.terminal)
}

// MARK: - Logon screens (Swift `LogonScreens`, InputStepSessionTests.swift)

/** Screens for the input-step and logon tests, built with the codec's encoders. */
export const LogonScreens = {
  header(
    etype: DyntElementType,
    fields: { row: number; col?: number; flags?: [number, number]; attributes?: DyntAttributes }
  ): DyntAtomHeader {
    const flags = fields.flags ?? [0, 0]
    return new DyntAtomHeader({
      etype,
      dialogFlags: new DyntDialogFlags({ flag1: flags[0], flag2: flags[1] }),
      area: 0,
      block: 1,
      group: 0,
      row: fields.row,
      col: fields.col ?? 30,
      attributes: fields.attributes ?? 0
    })
  },

  /** One input line: an EFIELD_2 with the given maxnrchars, then its FNAME child. */
  input(
    fields: { row: number; mlen: number; max: number; text?: string; flags?: [number, number]; invisible?: boolean },
    atoms: ByteWriter
  ): void {
    const attributes = fields.invisible === true ? DyntAttributes.yes3D | DyntAttributes.invisible : DyntAttributes.yes3D
    const header = LogonScreens.header(DyntElementType.of("efield2"), { row: fields.row, flags: fields.flags, attributes })
    DyntAtomEncoder.appendField(header, { mlen: fields.mlen, maxNrChars: fields.max, text: utf8(fields.text ?? "") }, atoms)
    const fname = LogonScreens.header(DyntElementType.of("fname"), { row: fields.row, flags: fields.flags, attributes })
    DyntAtomEncoder.appendText(fname, utf8("ZZMOAT-FIELD"), atoms)
  },

  /**
   * The Moat gate: the logon program with a label, client (3), user (12, dlg flags 0/1), password
   * (INVISIBLE, 40, dlg flags 4/1) and language (2), the structure of PV-0724 at rows and columns of
   * our own.
   */
  gateItems(options: { program?: string; passwords?: number; clients?: number; passwordText?: string } = {}): Uint8Array {
    const atoms = new ByteWriter()
    DyntAtomEncoder.appendField(
      LogonScreens.header(DyntElementType.of("keyword2"), { row: 1, col: 4, attributes: DyntAttributes.protected }),
      { mlen: 10, maxNrChars: 10, text: utf8("Moat gate") },
      atoms
    )
    for (let index = 0; index < (options.clients ?? 1); index++) LogonScreens.input({ row: 4 + index, mlen: 3, max: 3, text: "271" }, atoms)
    LogonScreens.input({ row: 6, mlen: 12, max: 12, flags: [0, 1] }, atoms)
    for (let index = 0; index < (options.passwords ?? 1); index++)
      LogonScreens.input({ row: 8 + index, mlen: 12, max: 40, text: options.passwordText ?? "", flags: [4, 1], invisible: true }, atoms)
    LogonScreens.input({ row: 11, mlen: 2, max: 2 }, atoms)
    const items = new ByteWriter()
    items.bytes(Fixtures.text(ApplItem.stSystemInfo("dynproName"), options.program ?? "SAPMSYST"))
    items.bytes(Fixtures.text(ApplItem.stSystemInfo("dynproNumber"), "0271"))
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), atoms.toBytes(), items)
    return items.toBytes()
  },

  gate(options: { program?: string; passwords?: number; clients?: number } = {}): Uint8Array {
    return Fixtures.message(LogonScreens.gateItems(options))
  },

  /** The moat's lobby: an invented program past the logon screen. */
  lobby(program = "ZZ_MOAT_LOBBY"): Uint8Array {
    const atoms = new ByteWriter()
    DyntAtomEncoder.appendField(
      LogonScreens.header(DyntElementType.of("keyword2"), { row: 2, col: 4, attributes: DyntAttributes.protected }),
      { mlen: 20, maxNrChars: 20, text: utf8("Mind the crocodiles") },
      atoms
    )
    const items = new ByteWriter()
    items.bytes(Fixtures.text(ApplItem.stSystemInfo("dynproName"), program))
    items.bytes(Fixtures.text(ApplItem.stSystemInfo("dynproNumber"), "0100"))
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), atoms.toBytes(), items)
    return Fixtures.message(items.toBytes())
  },

  /** A screen as the session hands it over. */
  received(payload: Uint8Array): ServerMessage {
    const machine = Fixtures.awaitingMachine()
    const message = machine.receive({ kind: "payload", payload }).message
    assert.ok(message !== undefined, "the machine hands the message over")
    return message
  },

  /** A machine on the logon screen. */
  logonMachine(): SessionMachine {
    const machine = Fixtures.awaitingMachine()
    machine.receive({ kind: "payload", payload: LogonScreens.gate() })
    assert.equal(machine.state.kind, "logon")
    return machine
  },

  /** The items of a client dialog message (compress 0): the walked items and the body. */
  walk(payload: Uint8Array): { items: DiagItem[]; body: Uint8Array } {
    const message = DiagMessage.parse(payload)
    assert.equal(message.body.kind, "items", "not plain items")
    if (message.body.kind !== "items") return { items: [], body: new Uint8Array(0) }
    const body = message.body.range.of(payload).slice()
    const walker = new DiagItemWalker()
    const items: DiagItem[] = []
    for (let item = walker.next(body); item !== undefined; item = walker.next(body)) items.push(item)
    return { items, body }
  },

  /** The input atoms (EFIELD family) of a DYNT_ATOM value, with their texts. */
  fields(value: Uint8Array): { atom: DyntAtom; text: Uint8Array }[] {
    const walker = new DyntAtomWalker()
    const fields: { atom: DyntAtom; text: Uint8Array }[] = []
    for (let atom = walker.next(value); atom !== undefined; atom = walker.next(value)) {
      if (DyntElementType.fieldRole(atom.etype) !== "editable" || atom.payload.kind !== "field") continue
      fields.push({ atom, text: atom.payload.value.textRange.of(value).slice() })
    }
    return fields
  }
} as const

/** A step returning one field, as a client would after an edit (Swift `InputStepSessionTests.step(_:)`). */
export function inputStep(text = "moat"): ClientInputStep {
  const step = new ClientInputStep()
  step.appendField(new ReturnedField({ block: 1, row: 6, col: 30, mlen: 12, maxNrChars: 12 }), utf8(text))
  return step
}

// MARK: - Logon credentials (Swift `LogonStepTests.credentials`, `decode`)

export const LogonFixtures = {
  password: "crocodile-tears", // secret-scan: allow invented test password (D15)

  credentials(options: { client?: string; user?: string; password?: string; language?: string | null } = {}): LogonCredentials {
    const language = options.language === undefined ? "EN" : options.language
    return new LogonCredentials({
      client: utf8(options.client ?? "271"),
      user: utf8(options.user ?? "ZZGATEKEEPER"),
      password: new Secret(utf8(options.password ?? LogonFixtures.password)),
      language: language === null ? undefined : utf8(language)
    })
  },

  /** The step's items and its returned fields. */
  decode(step: LogonStep): { items: ClientItem[]; fields: { atom: DyntAtom; text: Uint8Array }[] } {
    let atoms: Uint8Array = new Uint8Array(0)
    for (const item of step.input.items) if (item.kind === "dyntAtom") atoms = item.value
    return { items: step.input.items, fields: LogonScreens.fields(atoms) }
  }
} as const

// MARK: - The reference envelope (Swift `ReferenceEnvelopeSessionTests` statics)

export const EnvelopeFixtures = {
  get ses(): Uint8Array {
    return Uint8Array.of(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0x33, 0x44, 0x12, 0x40)
  },
  get codePage(): Uint8Array {
    return Uint8Array.of(0x00, 0x00, 0x10, 0x0e, 0x01, 0x34, 0x31, 0x31, 0x30, 0x00, 0x5a, 0x5a, 0x00)
  },
  get chl(): Uint8Array {
    return Uint8Array.from({ length: 0x36 - 0x20 }, (_, index) => 0x20 + index)
  },
  get scroll(): Uint8Array {
    return Uint8Array.from({ length: 0x91 - 0x70 }, (_, index) => 0x70 + index)
  },
  get reset(): Uint8Array {
    return new Uint8Array(9)
  },

  /**
   * The items a real logon screen carried besides its fields (PV-0733), with invented values:
   * DIALOG_STEP_NUMBER `step`, SES, CODEPAGE_DIAG_GUI, DYNN CHL, SCROLL_INFOS2 and a CONTAINER RESET
   * before the Moat gate's atoms.
   */
  echoItems(step = 1): Uint8Array {
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("codepageDiagGUI"), EnvelopeFixtures.codePage, items)
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(step).bytes, items)
    DiagItemEncoder.appendSimple("ses", EnvelopeFixtures.ses, items)
    DiagItemEncoder.appendAPPL(ApplItem.dynn("chl"), EnvelopeFixtures.chl, items)
    DiagItemEncoder.appendAPPL(ApplItem.varInfo("scrollInfos2"), EnvelopeFixtures.scroll, items)
    DiagItemEncoder.appendAPPL(ApplItem.container("reset"), EnvelopeFixtures.reset, items)
    return items.toBytes()
  },

  /** The Moat gate with the echo items, under a header whose mode_stat is `modeStat`. */
  gate(modeStat = 0): Uint8Array {
    const header = new DiagHeader({ mode: 0, comFlag: 0, modeStat, errNo: 0, msgType: 0, msgInfo: 1, msgRC: 0, compress: CompressField.uncompressed })
    return concatBytes(header.bytes, EnvelopeFixtures.echoItems(), LogonScreens.gateItems())
  },

  session(log: TransportLog, identity: ClientIdentity): DiagSession<ScriptedTransport> {
    return new DiagSession(new ScriptedTransport(log), identity, Fixtures.terminal)
  },

  /** The (type, id, sid) of each item, for the order: `APPL ST_USER DIALOG_STEP_NUMBER`, `SES`, `EOM`. */
  shapes(items: DiagItem[]): string[] {
    return items.map(item => {
      const appl = item.appl
      return appl !== undefined ? `${DiagItemType.name(item.type)} ${ApplItem.displayName(appl)}` : DiagItemType.name(item.type)
    })
  }
} as const

// MARK: - Control traffic (Swift `ControlTrafficTests` statics)

export const ControlFixtures = {
  /** A server message with `msgInfo` and `items`, then EOM. */
  message(msgInfo: number, items: Uint8Array, modeStat = 0): Uint8Array {
    const header = new DiagHeader({ mode: 0, comFlag: 0, modeStat, errNo: 0, msgType: 0, msgInfo, msgRC: 0, compress: CompressField.uncompressed })
    const body = new ByteWriter()
    body.bytes(items)
    DiagItemEncoder.appendEOM(body)
    return concatBytes(header.bytes, body.toBytes())
  },

  /**
   * An interim message as the owner's server sent three of (PV-0904): IMODENUMBER, the step, SES and
   * an empty STOP_TRANS, with msg_info 0x02.
   */
  interim(step: number, imode: number): Uint8Array {
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("imodeNumber"), Uint8Array.of(0, imode), items)
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(step).bytes, items)
    DiagItemEncoder.appendSimple("ses", EnvelopeFixtures.ses, items)
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("stopTrans"), new Uint8Array(0), items)
    return ControlFixtures.message(0x02, items.toBytes())
  },

  /**
   * A message with one RFC_TR item of `sid`, as the owner's server sent the call part (PV-0905): a
   * little of the identity block, the step, the item, msg_info 0x01.
   */
  part(sid: number, step: number, value: ArrayLike<number>, options: { msgInfo?: number; modeStat?: number } = {}): Uint8Array {
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL(ApplItem.stSystemInfo("dbName"), utf8("MOT"), items)
    DiagItemEncoder.appendAPPL(ApplItem.stUser("dialogStepNumber"), new DialogStepNumber(step).bytes, items)
    DiagItemEncoder.appendAPPL(ApplItem.of(0x08, sid), Uint8Array.from(value), items)
    return ControlFixtures.message(options.msgInfo ?? 0x01, items.toBytes(), options.modeStat ?? 0)
  },

  /** An invented call: a function-name item and a filler item, framed as rfc-tr.md §3 says. A fresh copy on every read. */
  get call(): Uint8Array {
    return concatBytes(
      [0x01, 0x02, 0x00, 0x0b],
      utf8("ZZ_MOAT_RUN"),
      [0x01, 0x02],
      [0x03, 0x05, 0x01, 0x2c],
      new Uint8Array(300).fill(0x42),
      [0x03, 0x05],
      [0xff, 0xff, 0x00, 0x00, 0xff, 0xff]
    )
  },

  /** The session after the logon step on the Moat gate: the gate, then the logon step written. */
  async loggedOn(
    log: TransportLog,
    readings: ControlReadings = new ControlReadings(),
    identity: ClientIdentity = ClientIdentities.reference
  ): Promise<DiagSession<ScriptedTransport>> {
    const session = EnvelopeFixtures.session(log, identity)
    session.controlReadings = readings
    await session.start()
    const gate = await session.nextMessage()
    assert.ok(gate !== undefined, "the gate arrives")
    await session.logOn(LogonFixtures.credentials(), gate)
    return session
  },

  /** The (type, id, sid) shapes and values of a written message's items. */
  items(payload: Uint8Array): { shapes: string[]; values: Uint8Array[] } {
    const { items, body } = LogonScreens.walk(payload)
    return { shapes: EnvelopeFixtures.shapes(items), values: items.map(item => item.valueRange.of(body).slice()) }
  }
} as const
