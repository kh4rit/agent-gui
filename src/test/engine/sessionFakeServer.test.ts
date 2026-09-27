// SPDX-License-Identifier: MIT
// End to end: the ported DiagSession on the Node socket transport against Swooey's fake DIAG
// server (loopback only, invented Duck Pond screens). Skipped unless AGENT_GUI_FAKE_SERVER names the
// fake-diag-server binary. What is asserted follows Swooey's own end-to-end tests
// (Tests/EndToEndTests/LogonEndToEndTests.swift, Tests/ToolSupportTests/ControlCaptureSupport.swift):
// the gate is the logon program SAPMSYST, the logon step (4 fields, 1 of them the password) reaches
// the lobby, the OK-code ZZDUCK (a VARINFO OKCODE, Reading R-CI-6, as diagctl connect --okcode
// sends it) brings the rubber duck, and the close is clean. The server's log names structure only
// (kinds, counts, lengths). Credentials are invented (D15).

import assert from "node:assert/strict"
import { test } from "node:test"
import { ClientIdentities, ClientInputStep, InputEnvelope, Secret } from "../../diag/codec/index.js"
import { DiagSession, LogonCredentials, type ServerMessage, type SessionState } from "../../diag/session/index.js"
import { DPTerminalName } from "../../diag/wire/index.js"
import { NodeTransport } from "../../engine/nodeTransport.js"
import { skipWithoutFakeServer, startFakeServer, type FakeServer } from "../support/fakeServer.js"

/** The reference identity preset, whose default envelope is `chlStage` (PV-0783). */
const identity = () => ClientIdentities.reference
const terminal = DPTerminalName.fromHostName("zz-duckpond")
const ascii = (text: string) => new TextEncoder().encode(text)
const text = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : new TextDecoder().decode(bytes))
const closedByClient: SessionState = { kind: "disconnected", reason: { kind: "closedByClient" } }

/** Invented credentials: client 001, user DONALD, any password (the fake server checks none). */
function credentials(): LogonCredentials {
  return new LogonCredentials({ client: ascii("001"), user: ascii("DONALD"), password: new Secret(ascii("quack-quack-42")), language: ascii("EN") })
}

/** The session's state now (a function, so that assertions do not narrow a getter's value). */
function stateOf(session: DiagSession<NodeTransport>): SessionState {
  return session.state
}

/** A session on a fresh connection to `server`. */
async function connect(server: FakeServer): Promise<{ session: DiagSession<NodeTransport>; transport: NodeTransport }> {
  const transport = await NodeTransport.connect(server.host, server.port)
  return { session: new DiagSession(transport, identity(), terminal), transport }
}

/** The next message; fails when the session ended instead. */
async function next(session: DiagSession<NodeTransport>, what: string): Promise<ServerMessage> {
  const message = await session.nextMessage()
  assert.ok(message !== undefined, `${what}: the session ended first (${JSON.stringify(stateOf(session))})`)
  return message
}

/** A screen the server sent cleanly: decoded, no server error. */
function assertCleanScreen(message: ServerMessage, what: string): void {
  assert.equal(message.problem, undefined, `${what}: ${message.description}`)
  assert.ok(message.screen !== undefined && !message.screen.isServerError, `${what}: ${message.description}`)
}

/** Reads messages until one that is no control traffic: the screen after the calls (ControlCaptureSupport's settle loop). */
async function settle(session: DiagSession<NodeTransport>): Promise<ServerMessage> {
  for (let message = await session.nextMessage(); message !== undefined; message = await session.nextMessage()) {
    if (message.control === undefined) return message
  }
  throw new Error(`the session ended before the screen after the control calls: ${JSON.stringify(stateOf(session))}`)
}

/** Runs `body` against the fake server with `scenario`; the server's log lines afterwards. */
async function withServer(scenario: string, body: (server: FakeServer) => Promise<void>): Promise<string[]> {
  const server = await startFakeServer(scenario)
  try {
    await body(server)
    // The server logs the close message once it has read it.
    for (let wait = 0; wait < 100 && !server.log.some(line => line.includes("close message (EOC)")); wait++)
      await new Promise(resolve => setTimeout(resolve, 10))
    return server.log.slice()
  } finally {
    await server.stop()
  }
}

/** The log lines that contain every one of `parts`. */
const linesWith = (log: string[], ...parts: string[]) => log.filter(line => parts.every(part => line.includes(part)))

test("duck-pond-logon: the gate, the logon, the rubber duck, a clean close", { skip: skipWithoutFakeServer }, async () => {
  const log = await withServer("duck-pond-logon", async server => {
    const { session } = await connect(server)
    // (a) the first message, then the gate: the logon program.
    assert.ok((await session.start()) !== undefined, "the first message was written")
    assert.equal(stateOf(session).kind, "awaitingFirstReply")
    const gate = await next(session, "the gate")
    assertCleanScreen(gate, "the gate")
    assert.equal(text(gate.identityText("dynproName")), "SAPMSYST")
    assert.ok(gate.isLogonProgram())
    assert.equal(stateOf(session).kind, "logon")

    // (b) the logon step, in the reference identity's default envelope; the lobby.
    const step = await session.logOn(credentials(), gate)
    assert.equal(step.input.envelope, InputEnvelope.default(identity()))
    assert.equal(step.input.envelope, InputEnvelope.chlStage)
    assert.deepEqual(step.roles, ["client", "user", "password", "language"])
    assert.equal(session.machine.lastStepNumber, 1)
    const lobby = await next(session, "the lobby")
    assertCleanScreen(lobby, "the lobby")
    assert.ok(!lobby.isLogonProgram())
    assert.ok(text(lobby.identityText("dynproName"))?.startsWith("ZZ"))
    assert.equal(lobby.control, undefined)
    assert.equal(stateOf(session).kind, "active")

    // (c) the OK-code ZZDUCK as diagctl connect --okcode sends it: a VARINFO OKCODE (R-CI-6).
    const command = new ClientInputStep({ envelope: InputEnvelope.default(identity()) })
    command.setFunctionCode(ascii("ZZDUCK"), "varInfoOKCode")
    await session.submit(command)
    const duck = await next(session, "the rubber duck")
    assertCleanScreen(duck, "the rubber duck")
    const program = text(duck.identityText("dynproName"))
    assert.ok(program !== undefined && program.startsWith("ZZ") && program !== text(lobby.identityText("dynproName")), `program ${program}`)
    assert.equal(stateOf(session).kind, "active")

    // (d) a clean close.
    assert.ok((await session.close()) !== undefined, "the close message was written")
    assert.deepEqual(stateOf(session), closedByClient)
    const counts = session.diagnostics
    assert.equal(counts.messages, 3)
    assert.equal(counts.screens, 3)
    assert.equal(counts.messagesNotDecoded, 0)
    assert.equal(counts.serverErrors, 0)
    assert.equal(counts.inputSteps, 2)
  })
  assert.equal(linesWith(log, "received", "first message", "com_flag INI, 2 items").length, 1, log.join("\n"))
  assert.equal(linesWith(log, "sent screen pond-gate").length, 1, log.join("\n"))
  assert.equal(linesWith(log, "dialog message 1", "4 returned field(s), 1 of them password field(s)").length, 1, log.join("\n"))
  assert.equal(linesWith(log, "sent screen pond-lobby").length, 1, log.join("\n"))
  assert.equal(linesWith(log, "dialog message 2", "OKCODE 6 bytes").length, 1, log.join("\n"))
  assert.equal(linesWith(log, "sent screen pond-rubber-duck").length, 1, log.join("\n"))
  assert.equal(linesWith(log, "close message (EOC)").length, 1, log.join("\n"))
  assert.ok(!log.some(line => line.includes("DONALD") || line.includes("quack-quack")), "nothing typed reaches the server's log")
})

test("keep-alive: every ping answered, the gate and the lobby arrive", { skip: skipWithoutFakeServer }, async () => {
  const log = await withServer("keep-alive", async server => {
    const { session, transport } = await connect(server)
    await session.start()
    const gate = await next(session, "the gate")
    assert.ok(gate.isLogonProgram(), "the gate after a ping")
    await session.logOn(credentials(), gate)
    const lobby = await next(session, "the lobby")
    assertCleanScreen(lobby, "the lobby")
    assert.ok(!lobby.isLogonProgram())
    assert.equal(stateOf(session).kind, "active")
    const counts = session.diagnostics
    assert.equal(counts.pingsAnsweredByTransport, 2, "a ping before the gate and before the lobby, answered by the transport (IMPL-NI-4)")
    assert.equal(counts.pingsAnswered, 0)
    assert.equal(transport.pingsAnswered, 2)
    assert.equal(counts.messages, 2, "pings are no DIAG messages")
    assert.ok((await session.close()) !== undefined)
    assert.deepEqual(stateOf(session), closedByClient)
  })
  assert.equal(linesWith(log, "keep-alive: pong").length, 2, log.join("\n"))
  assert.equal(linesWith(log, "close message (EOC)").length, 1, log.join("\n"))
})

test("duck-pond-control: the control calls answered by the session itself, then the lobby", { skip: skipWithoutFakeServer }, async () => {
  const log = await withServer("duck-pond-control", async server => {
    const { session } = await connect(server)
    await session.start()
    const gate = await next(session, "the gate")
    assert.ok(gate.isLogonProgram())
    await session.logOn(credentials(), gate)
    const lobby = await settle(session)
    assertCleanScreen(lobby, "the lobby")
    assert.ok(!lobby.isLogonProgram())
    assert.ok(text(lobby.identityText("dynproName"))?.startsWith("ZZ"))
    assert.equal(stateOf(session).kind, "active")
    const counts = session.diagnostics
    assert.equal(counts.interimMessages, 2, "two interim messages, never answered (R-CT-22)")
    assert.equal(counts.messagesNotDecoded, 0)
    assert.equal(counts.serverErrors, 0)
    assert.ok(counts.controlCalls >= 1, `control calls: ${counts.controlCalls}`)
    assert.ok(counts.controlReplies > counts.controlCalls, `the parts and the calls answered: ${counts.controlReplies}`)
    assert.ok((await session.close()) !== undefined)
    assert.deepEqual(stateOf(session), closedByClient)
  })
  const parts = linesWith(log, "sent control pond-control part").length
  assert.ok(parts > 1, `the call came in parts:\n${log.join("\n")}`)
  // Each part but the last was acknowledged with an empty RFC_TR_MOR (Reading R-CT-27), the complete
  // call with Swooey's own answer in RFC_TR_RET (R-CT-28), each in three items (R-CT-26).
  assert.equal(linesWith(log, "3 items; RFC_TR: RFC_TR_MOR 0 bytes").length, parts - 1, log.join("\n"))
  const answers = linesWith(log, "3 items; RFC_TR: RFC_TR_RET")
  assert.ok(answers.length >= 1 && !answers[0].includes("RFC_TR_RET 0 bytes"), `Swooey's answer to the pond control's call:\n${log.join("\n")}`)
  assert.equal(linesWith(log, "sent screen pond-lobby").length, 1, log.join("\n"))
  assert.equal(linesWith(log, "close message (EOC)").length, 1, log.join("\n"))
})
