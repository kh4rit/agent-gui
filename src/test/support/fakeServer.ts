// SPDX-License-Identifier: MIT
// Swooey's loopback fake DIAG server as a test backend (it serves only invented Duck Pond
// screens). Tests that need it skip unless AGENT_GUI_FAKE_SERVER names the binary; scenarios are
// Swooey's by name, or a path to a .scenario file (AGENT_GUI_SCENARIOS names a folder for
// agent-gui's own ones).

import { spawn, type ChildProcess } from "node:child_process"
import { isAbsolute, join } from "node:path"

export const fakeServerBinary: string | undefined = process.env.AGENT_GUI_FAKE_SERVER || undefined

/** `skip` option for node:test: a reason when the fake server is not available. */
/**
 * Whether sessions against the fake server type object results as SAP GUI does (SW-189, PV-1033;
 * `ControlReadings.objectResultTypes`, on by default). The server of Swooey 112c04d, the last that
 * takes `--scenario`, checks a control answer's result descriptors byte for byte and predates that
 * answer; later servers accept it. So the sessions the tests open against it answer in the older
 * form, and the unit tests (bug0189, controlTraffic) cover the default.
 */
export const fakeServerObjectResultTypes = false

export const skipWithoutFakeServer: string | false = fakeServerBinary ? false : "AGENT_GUI_FAKE_SERVER is not set (path of Swooey's fake-diag-server)"

/**
 * A scenario by name, by file name in AGENT_GUI_SCENARIOS when it ends with `.scenario`, or by an
 * absolute path to a `.scenario` file (a scenario a test wrote, src/test/support/screenSession.ts).
 */
export function scenarioArgument(scenario: string): string {
  if (isAbsolute(scenario)) return scenario
  if (scenario.endsWith(".scenario") && process.env.AGENT_GUI_SCENARIOS) return join(process.env.AGENT_GUI_SCENARIOS, scenario)
  return scenario
}

export interface FakeServer {
  host: string
  port: number
  /** Everything the server printed (structure only: kinds, counts, lengths). */
  log: string[]
  stop(): Promise<void>
}

/** Starts the fake server with `scenario` on a free loopback port. */
export function startFakeServer(scenario: string, timeoutMs = 10000): Promise<FakeServer> {
  if (!fakeServerBinary) return Promise.reject(new Error("AGENT_GUI_FAKE_SERVER is not set"))
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(fakeServerBinary, ["--scenario", scenarioArgument(scenario), "--port", "0", "--host", "127.0.0.1"], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    const log: string[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`fake server did not start: ${log.join(" | ")}`))
    }, timeoutMs)
    const onLine = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line) continue
        log.push(line)
        const m = /listening on 127\.0\.0\.1:(\d+)/.exec(line)
        if (m && !settled) {
          settled = true
          clearTimeout(timer)
          resolvePromise({
            host: "127.0.0.1",
            port: Number(m[1]),
            log,
            stop: () =>
              new Promise<void>(r => {
                if (child.exitCode !== null) return r()
                child.once("exit", () => r())
                child.kill()
              })
          })
        }
      }
    }
    child.stdout!.on("data", onLine)
    child.stderr!.on("data", onLine)
    child.on("exit", code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`fake server exited with ${code}: ${log.join(" | ")}`))
    })
  })
}
