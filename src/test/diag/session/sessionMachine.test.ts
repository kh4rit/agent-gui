// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/SessionMachineTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import {
  ApplItem,
  ClientMessageEncoder,
  CodecSpecGap,
  ComFlag,
  CompressField,
  CompressionHeader,
  DiagHeader,
  DiagItemEncoder,
  DiagItemWalker,
  LogonFieldStructure,
  ProtocolVersion,
  ScreenSpecGapError,
  SupportBits,
  UserConnect
} from "../../../diag/codec/index.js"
import {
  DiagTransportError,
  DisconnectReason,
  SessionDiagnostics,
  SessionReaction,
  SessionState
} from "../../../diag/session/index.js"
import { ByteWriter, DPHeader, NIFrameEncoder, NIFrameError, NIKeepAlive, NILiteral, type DispatcherLiteral } from "../../../diag/wire/index.js"
import { bytes, cat, throwsInfo } from "../../support/codecTestSupport.js"
import { Fixtures, utf8 } from "../../support/sessionTestSupport.js"

describe("Session machine: first message, first reply, close", () => {
  /** start writes the first message: DP header, the INI header, CONNECT then SUPPORTDATA, no EOM (session.md §1) */
  test("startWritesTheFirstMessage", () => {
    const machine = Fixtures.machine()
    assert.deepStrictEqual(machine.state, SessionState.connecting)
    const reaction = machine.start()
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply)
    assert.ok(!reaction.closeTransport)
    assert.equal(reaction.message, undefined)
    const expected = new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal).firstMessage()
    assert.deepStrictEqual(reaction.send, [expected])

    // Independently of the encoder: the DP header of the template, then the header of PV-0300
    // (diag-header/client-first-message.vec), then exactly the two init items (R-SE-1).
    const payload = reaction.send[0]
    assert.ok(payload !== undefined)
    const dp = DPHeader.parseFirstMessage(payload)
    assert.deepStrictEqual(dp.nonTemplateFields, [])
    assert.deepStrictEqual(Array.from(dp.terminalName), Array.from(utf8("mallard")))
    const diag = payload.slice(DPHeader.size)
    assert.deepStrictEqual(diag.slice(0, DiagHeader.size), Fixtures.vector("diag-header/client-first-message.vec"))
    const items = diag.slice(DiagHeader.size)
    const walker = new DiagItemWalker()
    const pairs: (ApplItem | undefined)[] = []
    for (let item = walker.next(items); item !== undefined; item = walker.next(items)) {
      pairs.push(item.appl)
      const appl = item.appl
      if (appl !== undefined && ApplItem.equals(appl, ApplItem.stUser("connect"))) {
        const connect = UserConnect.decode(item.valueRange.of(items))
        assert.deepStrictEqual(connect, new UserConnect({ protocolVersion: ProtocolVersion.uncompressed, codePage: 0, wsType: 0 }))
      } else {
        assert.deepStrictEqual(SupportBits.decode(item.valueRange.of(items)).setBits, [], "declares no capability")
      }
    }
    assert.deepStrictEqual(pairs, [ApplItem.stUser("connect"), ApplItem.stUser("supportData")])
    assert.ok(machine.identity.equals(Fixtures.identity))
  })

  /** start does nothing once started */
  test("startTwice", () => {
    const machine = Fixtures.awaitingMachine()
    assert.deepStrictEqual(machine.start(), new SessionReaction())
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply)
  })

  /** the first decoded reply moves to logon; its identity and fields are read (R-SS-5, R-SS-9) */
  test("firstReplyMovesToLogon", () => {
    const machine = Fixtures.awaitingMachine()
    const payload = Fixtures.minimalScreen
    const reaction = machine.receive({ kind: "payload", payload })
    assert.equal(reaction.send.length, 0)
    assert.ok(!reaction.closeTransport)
    assert.deepStrictEqual(machine.state, SessionState.logon)
    const message = reaction.message
    assert.ok(message !== undefined)
    assert.equal(message.number, 1)
    assert.deepStrictEqual(message.payload, payload)
    assert.deepStrictEqual(message.header, Fixtures.header())
    assert.equal(message.problem, undefined)
    const screen = message.screen
    assert.ok(screen !== undefined)
    assert.ok(!screen.isServerError)
    assert.ok(!screen.wasCompressed)
    assert.equal(screen.errorTextByteCount, undefined)
    assert.deepStrictEqual(message.identityText("dynproName"), utf8("SAPMSYST"))
    assert.deepStrictEqual(message.identityText("dynproNumber"), utf8("1337"))
    assert.equal(message.identityText("tcode"), undefined)
    assert.ok(message.isLogonProgram())
    assert.equal(screen.identity.inputFieldCount, 2)
    assert.equal(screen.identity.passwordFieldCount, 1)
    assert.equal(screen.fields.passwordField?.maxNrChars, 40)
    assert.equal(screen.fields.inputFieldsWithMaxNrChars(12).length, 1)
    assert.deepStrictEqual(screen.fields, LogonFieldStructure.decode(Fixtures.minimalScreenItems))
    assert.equal(machine.diagnostics.messages, 1)
    assert.equal(machine.diagnostics.screens, 1)
  })

  /** a leading step item and a trailing EOM change nothing (R-SE-2, R-SS-7) */
  test("stepItemAndEOM", () => {
    const machine = Fixtures.awaitingMachine()
    const message = machine.receive({
      kind: "payload",
      payload: Fixtures.message(Fixtures.vector("server-screen/minimal-screen-step-and-eom.vec"))
    }).message
    assert.ok(message !== undefined)
    assert.deepStrictEqual(message.identityText("dynproName"), utf8("SAPMSYST"))
    assert.deepStrictEqual(message.identityText("dynproNumber"), utf8("1337"))
    assert.equal(message.screen?.identity.passwordFieldCount, 1)
    assert.deepStrictEqual(machine.state, SessionState.logon)
  })

  /** the full logon-style screen of the items vector: the fields the codec reads, the logon program */
  test("fullLogonScreen", () => {
    const machine = Fixtures.awaitingMachine()
    const items = Fixtures.vector("items/server-logon-screen.vec")
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(items) }).message
    assert.ok(message !== undefined)
    const screen = message.screen
    assert.ok(screen !== undefined)
    assert.deepStrictEqual(screen.fields, LogonFieldStructure.decode(items))
    assert.ok(message.isLogonProgram())
    assert.ok(screen.identity.menuCount > 0)
    assert.equal(message.withItems(view => view.length), items.length)
  })

  /** another program in another item order: not the logon program, texts trimmed (R-SS-4) */
  test("reorderedIdentity", () => {
    const machine = Fixtures.awaitingMachine()
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(Fixtures.vector("server-screen/reordered-identity.vec")) }).message
    assert.ok(message !== undefined)
    assert.ok(!message.isLogonProgram())
    assert.deepStrictEqual(message.identityText("dynproName"), utf8("ZZDUCKPOND"))
    assert.deepStrictEqual(message.identityText("dynproNumber"), utf8("0042"))
    assert.deepStrictEqual(message.identityText("client"), utf8("042"))
    assert.deepStrictEqual(machine.state, SessionState.logon, "the state does not depend on the program")
  })

  /** a message before the first message is decoded, and the state stays connecting */
  test("messageBeforeStart", () => {
    const machine = Fixtures.machine()
    assert.notEqual(machine.receive({ kind: "payload", payload: Fixtures.minimalScreen }).message?.screen, undefined)
    assert.deepStrictEqual(machine.state, SessionState.connecting)
  })

  /** close after the first message writes exactly the close message (PV-0302) and closes */
  test("closeWritesTheCloseMessage", () => {
    for (const reachedLogon of [false, true]) {
      const machine = Fixtures.awaitingMachine()
      if (reachedLogon) machine.receive({ kind: "payload", payload: Fixtures.minimalScreen })
      const reaction = machine.close()
      assert.deepStrictEqual(reaction.send, [Fixtures.vector("diag-header/client-close.vec")], `reached logon: ${reachedLogon}`)
      assert.ok(reaction.closeTransport)
      assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.closedByClient))
      assert.deepStrictEqual(machine.close(), new SessionReaction(), "closing again does nothing")
    }
  })

  /** close before the first message writes nothing and closes; the reason says that there was no close message */
  test("closeBeforeStart", () => {
    const machine = Fixtures.machine()
    const reaction = machine.close()
    assert.equal(reaction.send.length, 0)
    assert.ok(reaction.closeTransport)
    assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.closedBeforeFirstMessage))
    assert.deepStrictEqual(machine.start(), new SessionReaction(), "a closed session never starts")
  })

  /** a close by the peer names whether the last message had EOC (PV-0702, #7) */
  test("peerClosed", () => {
    const quiet = Fixtures.awaitingMachine()
    assert.ok(quiet.peerClosed().closeTransport)
    assert.deepStrictEqual(quiet.state, SessionState.disconnected(DisconnectReason.closedByServer(false)))
    assert.deepStrictEqual(quiet.peerClosed(), new SessionReaction())

    const loggedOff = Fixtures.awaitingMachine()
    loggedOff.receive({ kind: "payload", payload: Fixtures.minimalScreen })
    const logoff = loggedOff.receive({ kind: "payload", payload: Fixtures.vector("diag-header/server-logoff.vec") }).message
    assert.ok(logoff !== undefined)
    assert.equal(logoff.header?.comFlag, ComFlag.eop | ComFlag.eoc)
    assert.equal(logoff.screen?.identity.atomCount, 0, "a header-only message reads as an empty screen")
    loggedOff.peerClosed()
    assert.deepStrictEqual(loggedOff.state, SessionState.disconnected(DisconnectReason.closedByServer(true)))

    const cases: [ComFlag, boolean][] = [
      [ComFlag.eoc, true],
      [ComFlag.eop, false],
      [ComFlag.eos, false]
    ]
    for (const [flags, named] of cases) {
      const machine = Fixtures.awaitingMachine()
      machine.receive({ kind: "payload", payload: Fixtures.message([], { comFlag: flags }) })
      machine.peerClosed()
      assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.closedByServer(named)), `com_flag ${ComFlag.names(flags)}`)
    }

    const again = Fixtures.awaitingMachine()
    again.receive({ kind: "payload", payload: Fixtures.vector("diag-header/server-logoff.vec") })
    again.receive({ kind: "payload", payload: Fixtures.minimalScreen })
    again.peerClosed()
    assert.deepStrictEqual(again.state, SessionState.disconnected(DisconnectReason.closedByServer(false)), "only the last message counts")
  })

  /** a transport failure disconnects once; later inputs do nothing */
  test("transportFailure", () => {
    const machine = Fixtures.awaitingMachine()
    const failure = new DiagTransportError({ kind: "frame", error: new NIFrameError({ kind: "truncated", streamOffset: 4, bufferedByteCount: 3 }) })
    assert.ok(machine.transportFailed(failure).closeTransport)
    assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.transportFailed(failure.info)))
    assert.deepStrictEqual(machine.transportFailed(new DiagTransportError({ kind: "connectionFailed", reason: "again" })), new SessionReaction())
    assert.deepStrictEqual(machine.receive({ kind: "payload", payload: NILiteral.ping }), new SessionReaction(), "no pong after the end")
    assert.deepStrictEqual(machine.receive({ kind: "payload", payload: Fixtures.minimalScreen }), new SessionReaction())
    assert.deepStrictEqual(machine.receive({ kind: "pingAnswered" }), new SessionReaction())
    assert.deepStrictEqual(machine.diagnostics, new SessionDiagnostics())
    assert.ok(machine.isDisconnected)
  })
})

describe("Session machine: keep-alive and dispatcher frames (ni-framing.md)", () => {
  /** a ping is answered with NI_PONG\0 in every state, framed as PV-0201 (IMPL-NI-4) */
  test("pingAnsweredInEveryState", () => {
    const ping = Fixtures.vector("ni/payload-ping.vec")
    const machine = Fixtures.machine()
    const states: SessionState[] = []
    for (let step = 0; step < 3; step++) {
      if (step === 1) machine.start()
      if (step === 2) machine.receive({ kind: "payload", payload: Fixtures.minimalScreen })
      states.push(machine.state)
      const reaction = machine.receive({ kind: "payload", payload: ping })
      assert.deepStrictEqual(reaction.send, [NILiteral.pong], `step ${step}`)
      assert.ok(!reaction.closeTransport)
      assert.equal(reaction.message, undefined)
      assert.deepStrictEqual(new NIFrameEncoder().encode(reaction.send[0]), NIKeepAlive.pongFrame)
    }
    assert.deepStrictEqual(states, [SessionState.connecting, SessionState.awaitingFirstReply, SessionState.logon])
    assert.equal(machine.diagnostics.pingsAnswered, 3)
    assert.equal(machine.diagnostics.messages, 1, "pings are not DIAG messages")
  })

  /** a ping the transport answered is only counted */
  test("pingAnsweredByTransport", () => {
    const machine = Fixtures.awaitingMachine()
    assert.deepStrictEqual(machine.receive({ kind: "pingAnswered" }), new SessionReaction())
    assert.equal(machine.diagnostics.pingsAnsweredByTransport, 1)
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply)
  })

  /** a pong and an empty payload are ignored and counted (IMPL-NI-8, IMPL-NI-9) */
  test("pongAndEmptyIgnored", () => {
    const machine = Fixtures.awaitingMachine()
    assert.deepStrictEqual(machine.receive({ kind: "payload", payload: Fixtures.vector("ni/payload-pong.vec") }), new SessionReaction())
    assert.deepStrictEqual(machine.receive({ kind: "payload", payload: Fixtures.vector("ni/payload-empty.vec") }), new SessionReaction())
    assert.equal(machine.diagnostics.pongsIgnored, 1)
    assert.equal(machine.diagnostics.emptyPayloads, 1)
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply)
  })

  /** a dispatcher frame disconnects with the literal and the length (IMPL-NI-10) */
  test("dispatcherFrame", () => {
    const cases: [string, DispatcherLiteral, number][] = [
      ["ni/payload-dptmmsg-14.vec", "dptmmsg", 14],
      ["ni/payload-dptmopc-17.vec", "dptmopc", 17],
      ["ni/payload-dptmmsg.vec", "dptmmsg", 12]
    ]
    for (const [path, literal, length] of cases) {
      const machine = Fixtures.awaitingMachine()
      const reaction = machine.receive({ kind: "payload", payload: Fixtures.vector(path) })
      assert.ok(reaction.closeTransport, path)
      assert.equal(reaction.send.length, 0, path)
      assert.deepStrictEqual(machine.state, SessionState.disconnected(DisconnectReason.dispatcherFrame(literal, length)), path)
      assert.deepStrictEqual(machine.close(), new SessionReaction(), `no close message after a dispatcher frame: ${path}`)
    }
  })
})

describe("Session machine: message decoding (diag-header.md, compression-header.md, items.md)", () => {
  /** a compressed screen is decompressed and read like an uncompressed one */
  test("compressedScreen", () => {
    const machine = Fixtures.awaitingMachine()
    const items = Fixtures.minimalScreenItems
    const message = machine.receive({ kind: "payload", payload: Fixtures.compressedMessage(items) }).message
    assert.ok(message !== undefined)
    const screen = message.screen
    assert.ok(screen !== undefined)
    assert.ok(screen.wasCompressed)
    assert.deepStrictEqual(screen.fields, LogonFieldStructure.decode(items))
    assert.deepStrictEqual(message.identityText("dynproName"), utf8("SAPMSYST"))
    assert.ok(message.isLogonProgram())
    assert.deepStrictEqual(message.withItems(view => view.slice()), items)
    assert.deepStrictEqual(machine.state, SessionState.logon)
  })

  /** compressed data that fails drops the message only (IMPL-CH-6) */
  test("decompressionFailure", () => {
    const machine = Fixtures.awaitingMachine()
    const payload = cat(Fixtures.header({ compress: CompressField.compressed }).bytes, Fixtures.vector("compression/neg-lzh-truncated.vec"))
    const message = machine.receive({ kind: "payload", payload }).message
    assert.ok(message !== undefined)
    assert.equal(message.problem?.kind, "decompression", `expected a decompression problem, got ${inspect(message.problem)}`)
    assert.deepStrictEqual(message.header, Fixtures.header({ compress: CompressField.compressed }))
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply)
    assert.equal(machine.diagnostics.messagesNotDecoded, 1)

    // The session goes on: the next message parses (architecture.md §4).
    machine.receive({ kind: "payload", payload: Fixtures.minimalScreen })
    assert.deepStrictEqual(machine.state, SessionState.logon)
  })

  /** the declared uncompressed length is capped before decompressing (IMPL-CH-5) */
  test("uncompressedLengthCap", () => {
    const machine = Fixtures.machine(8)
    machine.start()
    const message = machine.receive({ kind: "payload", payload: Fixtures.compressedMessage(Fixtures.minimalScreenItems) }).message
    assert.ok(message !== undefined)
    const problem = message.problem
    assert.ok(
      problem?.kind === "decompression" && problem.error.kind === "lengthOverCap",
      `expected length-over-cap, got ${inspect(problem)}`
    )
  })

  /** a bad compression header drops the message and keeps the DIAG header (IMPL-CH-4) */
  test("badCompressionHeader", () => {
    const machine = Fixtures.awaitingMachine()
    const payload = cat(Fixtures.header({ compress: CompressField.compressed }).bytes, Fixtures.vector("compression-header/neg-bad-magic.vec"))
    const message = machine.receive({ kind: "payload", payload }).message
    assert.ok(message !== undefined)
    const problem = message.problem
    assert.ok(problem?.kind === "compressionHeader" && problem.error.kind === "badMagic", `expected bad-magic, got ${inspect(problem)}`)
    assert.deepStrictEqual(message.header?.compress, CompressField.compressed)
  })

  /** an unknown compress byte or a short header drops the message (IMPL-DH-1, IMPL-DH-2) */
  test("badHeaders", () => {
    const machine = Fixtures.awaitingMachine()
    const unknown = machine.receive({ kind: "payload", payload: Fixtures.vector("diag-header/neg-unknown-compress.vec") }).message
    assert.ok(unknown !== undefined)
    assert.deepStrictEqual(unknown.problem, { kind: "header", error: { kind: "unknownCompress", value: 4 } })
    assert.deepStrictEqual(unknown.header?.compress, { kind: "unknown", value: 4 })
    const short = machine.receive({ kind: "payload", payload: Fixtures.vector("diag-header/neg-truncated-7.vec") }).message
    assert.ok(short !== undefined)
    assert.deepStrictEqual(short.problem, { kind: "header", error: { kind: "truncated", availableByteCount: 7 } })
    assert.equal(short.header, undefined)
    assert.equal(short.screen, undefined)
    assert.equal(short.identityText("dynproName"), undefined)
    assert.ok(!short.isLogonProgram())
    assert.equal(short.withItems(view => view.length), undefined)
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply)
    assert.equal(machine.diagnostics.messagesNotDecoded, 2)
  })

  /** an SNC frame is not decoded (IMPL-DH-3) */
  test("sncFrame", () => {
    const machine = Fixtures.awaitingMachine()
    const message = machine.receive({ kind: "payload", payload: cat(Fixtures.vector("diag-header/compress-2.vec"), [0xa1, 0xa2]) }).message
    assert.ok(message !== undefined)
    assert.deepStrictEqual(message.problem, { kind: "snc" })
  })

  /** a server error keeps the state, counts the text and reads the items after it (IMPL-DH-8) */
  test("serverError", () => {
    const machine = Fixtures.awaitingMachine()
    const body = Fixtures.vector("diag-error-body/error-body-text-then-items.vec")
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(body, { errNo: 1 }) }).message
    assert.ok(message !== undefined)
    const screen = message.screen
    assert.ok(screen !== undefined)
    assert.ok(screen.isServerError)
    assert.equal(screen.errorTextByteCount, 4)
    assert.equal(message.withItems(view => view.length), 7)
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply, "a server error is no logon screen")
    assert.equal(machine.diagnostics.serverErrors, 1)
    assert.equal(machine.diagnostics.screens, 1)
    // The text's bytes, before the terminator, for the user's own screen (IMPL-DH-8).
    assert.deepStrictEqual(message.withErrorText(text => text.slice()), bytes(0x41, 0x41, 0x42, 0x42))
    const text = message.decodedErrorText()
    assert.ok(text !== undefined)
    assert.equal(text.text, "AABB", "single-byte text, not the CJK of a UTF-16LE reading (PV-0308)")
    assert.ok(
      text.codePage === Fixtures.identity.codePage && text.encoding === "utf8" && text.isGuessed,
      "code page 0 in force is unknown: UTF-8 is the first guess"
    )
    assert.ok(text.byteCount === 4 && !text.missingTerminator)
  })

  /** a compressed server error is decompressed, then split (IMPL-DH-6) */
  test("compressedServerError", () => {
    const machine = Fixtures.awaitingMachine()
    const body = Fixtures.vector("diag-error-body/error-body-text-then-items.vec")
    const message = machine.receive({ kind: "payload", payload: Fixtures.compressedMessage(body, 5) }).message
    assert.ok(message !== undefined)
    const screen = message.screen
    assert.ok(screen !== undefined)
    assert.ok(screen.isServerError)
    assert.ok(screen.wasCompressed)
    assert.equal(screen.errorTextByteCount, 4)
    assert.equal(message.withItems(view => view.length), 7)
    assert.deepStrictEqual(message.withErrorText(text => text.slice()), bytes(0x41, 0x41, 0x42, 0x42), "from the decompressed data")
    assert.equal(message.decodedErrorText()?.text, "AABB")
  })

  /** an error body without a terminator is not walked (IMPL-DH-7) */
  test("missingTerminator", () => {
    const machine = Fixtures.awaitingMachine()
    const body = Fixtures.vector("diag-error-body/neg-error-body-no-terminator.vec")
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(body, { errNo: 1 }) }).message
    assert.ok(message !== undefined)
    assert.deepStrictEqual(message.problem, { kind: "errorBody", error: { kind: "missingTerminator", byteCount: body.length } })
    assert.equal(machine.diagnostics.serverErrors, 1)
    // The items are not walked, but the text is still there for the user: the whole body.
    assert.equal(message.withErrorText(text => text.length), body.length)
    const text = message.decodedErrorText()
    assert.ok(text !== undefined)
    assert.ok(text.missingTerminator && text.byteCount === body.length)
  })

  /** a message that is no server error has no error text; a compressed one that fails has none either */
  test("noErrorText", () => {
    const machine = Fixtures.awaitingMachine()
    const screen = machine.receive({ kind: "payload", payload: Fixtures.minimalScreen }).message
    assert.ok(screen !== undefined)
    assert.equal(screen.withErrorText(text => text.length), undefined)
    assert.equal(screen.decodedErrorText(), undefined)
    assert.equal(screen.description, "ServerMessage(number: 1, screen; payload withheld)")
    const compressed = Fixtures.compressedMessage(Fixtures.vector("diag-error-body/error-body-text-then-items.vec"), 5)
    const broken = compressed.slice(0, DiagHeader.size + CompressionHeader.size + 1)
    const failed = machine.receive({ kind: "payload", payload: broken }).message
    assert.ok(failed !== undefined)
    assert.notEqual(failed.problem, undefined)
    assert.equal(failed.decodedErrorText(), undefined)
  })

  /** a server error's text reaches no description of the message (IMPL-DH-8) */
  test("errorTextStaysOutOfDescriptions", () => {
    const machine = Fixtures.awaitingMachine()
    const text = "Honk: the gate goose frowns at your hat"
    const units: number[] = []
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index)
      units.push(unit & 0xff, unit >> 8)
    }
    const errorText = Uint8Array.from(units)
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(cat(errorText, [0x0c]), { comFlag: ComFlag.eoc, errNo: 1 }) }).message
    assert.ok(message !== undefined)
    assert.equal(message.decodedErrorText()?.text, text)
    // Swift's description, debug description, interpolation, dump and the content's description.
    const views = [
      String(message),
      `${message}`,
      inspect(message),
      inspect(message, { depth: Infinity, showHidden: true }),
      JSON.stringify(message),
      inspect(message.content, { depth: Infinity })
    ]
    for (const view of views) {
      assert.ok(!view.includes("goose"), view)
      assert.ok(!view.includes(Array.from(errorText.slice(0, 8)).join(", ")), view)
    }
    assert.equal(message.description, "ServerMessage(number: 1, server error, err_no 1; payload withheld)")
    const dropped = machine.receive({ kind: "payload", payload: Fixtures.message(errorText, { errNo: 1 }) }).message
    assert.ok(dropped !== undefined)
    assert.equal(dropped.description, "ServerMessage(number: 2, not decoded: the error body has no 0x0C terminator (IMPL-DH-7); payload withheld)")
    assert.equal(inspect(dropped), dropped.description)
  })

  /** an unknown simple item type drops the message; the next one parses (IMPL-IT-2, architecture.md §4) */
  test("unknownItemType", () => {
    const machine = Fixtures.awaitingMachine()
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(Fixtures.vector("items/neg-unknown-type-0d.vec")) }).message
    assert.ok(message !== undefined)
    const problem = message.problem
    assert.ok(
      problem?.kind === "items" && problem.error.kind === "items" && problem.error.value.info.kind === "unknownType",
      `expected unknown-type, got ${inspect(problem)}`
    )
    assert.deepStrictEqual(machine.state, SessionState.awaitingFirstReply)
    const next = machine.receive({ kind: "payload", payload: Fixtures.minimalScreen }).message
    assert.ok(next !== undefined)
    assert.equal(next.number, 2)
    assert.deepStrictEqual(machine.state, SessionState.logon)
  })

  /** an atom walk that stops drops the message (IMPL-DA-3) */
  test("atomWalkStops", () => {
    const machine = Fixtures.awaitingMachine()
    const items = new ByteWriter()
    // One atom that declares 5 bytes, below the 13-byte atom header (R-DA-3).
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), bytes(0x00, 0x05, 0x00, 0x00, 0x00), items)
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(items.toBytes()) }).message
    assert.ok(message !== undefined)
    const problem = message.problem
    assert.ok(problem?.kind === "items" && problem.error.kind === "atoms", `expected an atom walk stop, got ${inspect(problem)}`)
    assert.equal(problem.error.itemIndex, 1)
  })

  /** a repeated identity text is spec gap #54 for its accessors; the rest stands */
  test("repeatedIdentityText", () => {
    const machine = Fixtures.awaitingMachine()
    const items = cat(
      Fixtures.text(ApplItem.stSystemInfo("dynproName"), "SAPMSYST"),
      Fixtures.text(ApplItem.stSystemInfo("dynproName"), "ZZPUDDLE"),
      Fixtures.text(ApplItem.stSystemInfo("dynproNumber"), "0007")
    )
    const message = machine.receive({ kind: "payload", payload: Fixtures.message(items) }).message
    assert.ok(message !== undefined)
    const gap = { kind: "specGap", issue: CodecSpecGap.identityItemRepeats } as const
    throwsInfo(() => message.identityText("dynproName"), ScreenSpecGapError, gap)
    throwsInfo(() => message.isLogonProgram(), ScreenSpecGapError, gap)
    assert.deepStrictEqual(message.identityText("dynproNumber"), utf8("0007"))
  })
})
