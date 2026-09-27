// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type Socket } from "node:net"
import { NILiteral, NIKeepAlive, bytesEqual } from "../../diag/wire/index.js"
import { DiagTransportError, NodeTransport } from "../../engine/nodeTransport.js"

const frame = (payload: Uint8Array) => {
  const out = new Uint8Array(4 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length)
  out.set(payload, 4)
  return out
}

async function withServer(onSocket: (s: Socket) => void, body: (port: number) => Promise<void>) {
  const server: Server = createServer(onSocket)
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  try {
    await body(port)
  } finally {
    await new Promise<void>(r => server.close(() => r()))
  }
}

test("frames split across reads arrive whole; pings are answered at once", async () => {
  let clientBytes = Buffer.alloc(0)
  await withServer(
    s => {
      s.on("data", d => (clientBytes = Buffer.concat([clientBytes, d])))
      const quack = frame(new TextEncoder().encode("QUACK-QUACK"))
      const ping = frame(NILiteral.ping)
      const all = Buffer.concat([Buffer.from(ping), Buffer.from(quack)])
      s.write(all.subarray(0, 5))
      setTimeout(() => s.end(all.subarray(5)), 20)
    },
    async port => {
      const t = await NodeTransport.connect("127.0.0.1", port)
      assert.deepEqual(await t.receive(), { kind: "pingAnswered" })
      const e = await t.receive()
      assert.equal(e?.kind, "payload")
      assert.equal(new TextDecoder().decode((e as { payload: Uint8Array }).payload), "QUACK-QUACK")
      assert.equal(await t.receive(), undefined)
      for (let i = 0; i < 50 && clientBytes.length < NIKeepAlive.pongFrame.length; i++) await new Promise(r => setTimeout(r, 10))
      assert.ok(bytesEqual(clientBytes, NIKeepAlive.pongFrame))
      await t.close()
    }
  )
})

test("a stream that ends inside a frame is a frame error (IMPL-NI-6)", async () => {
  await withServer(
    s => s.end(Buffer.from([0, 0, 0, 9, 1, 2])),
    async port => {
      const t = await NodeTransport.connect("127.0.0.1", port)
      await assert.rejects(t.receive(), (e: unknown) => e instanceof DiagTransportError && e.info.kind === "frame")
    }
  )
})

test("send writes one framed payload; receiveWithin times out without losing events", async () => {
  const got: Buffer[] = []
  await withServer(
    s => s.on("data", d => got.push(d)),
    async port => {
      const t = await NodeTransport.connect("127.0.0.1", port)
      await t.send(Uint8Array.of(0xde, 0xad))
      assert.equal(await t.receiveWithin(30), "timeout")
      await new Promise(r => setTimeout(r, 30))
      assert.deepEqual([...Buffer.concat(got)], [0, 0, 0, 2, 0xde, 0xad])
      await t.close()
    }
  )
})

test("a refused connection names no host", async () => {
  await assert.rejects(NodeTransport.connect("127.0.0.1", 1), (e: unknown) => e instanceof DiagTransportError && e.info.kind === "connectFailed" && !e.message.includes("127.0.0.1"))
})
