// SPDX-License-Identifier: MIT
// Passwords for DIAG logons: the operating system's credential store, the logon attempt budget,
// and the interactive password prompt of `agent-gui --set-password`.
//
// The password never passes through the agent: it is not a tool argument, never part of a tool
// result, and never written to a log. It travels to the credential store on stdin, never in argv.

import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SystemConfig } from "./config.js"

export class CredentialError extends Error {}

/** The name a system's password is stored under. */
export const credentialTarget = (system: Pick<SystemConfig, "name">): string => `agent-gui:${system.name}`

/** A place to keep passwords: read, write, delete by target name and user. */
export interface CredentialStore {
  readonly label: string
  read(target: string, user: string): Promise<Uint8Array | undefined>
  write(target: string, user: string, password: Uint8Array): Promise<void>
  remove(target: string, user: string): Promise<boolean>
}

interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

/** Runs a command, writing `input` to its stdin; never puts secrets on the command line. */
function run(command: string, args: string[], input: Uint8Array | string | undefined, timeoutMs = 30000): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const out: Buffer[] = []
    let err = ""
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on("data", (d: Buffer) => out.push(d))
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")))
    child.on("error", e => {
      clearTimeout(timer)
      reject(new CredentialError(`Cannot run ${command}: ${e.message}`))
    })
    child.on("close", code => {
      clearTimeout(timer)
      resolvePromise({ code, stdout: Buffer.concat(out), stderr: err.trim() })
    })
    child.stdin.on("error", () => {})
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
  })
}

// MARK: Windows Credential Manager

/** P/Invoke of advapi32's CredRead/CredWrite/CredDelete for generic credentials. */
const WINDOWS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentGuiCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] blob = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);
      return blob;
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, byte[] blob) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = blob.Length;
    c.CredentialBlob = Marshal.AllocCoTaskMem(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
  public static bool Delete(string target) { return CredDelete(target, 1, 0); }
}
'@
$op = [Console]::In.ReadLine()
$target = [Console]::In.ReadLine()
$user = [Console]::In.ReadLine()
if ($op -eq 'read') {
  $b = [AgentGuiCred]::Read($target)
  if ($null -eq $b) { exit 3 }
  [Console]::Out.Write([Convert]::ToBase64String($b))
} elseif ($op -eq 'write') {
  $b = [Convert]::FromBase64String([Console]::In.ReadLine())
  [AgentGuiCred]::Write($target, $user, $b)
} elseif ($op -eq 'delete') {
  if (-not [AgentGuiCred]::Delete($target)) { exit 3 }
} else { exit 2 }
`

class WindowsCredentialStore implements CredentialStore {
  readonly label = "Windows Credential Manager"

  private exec(lines: string[]): Promise<RunResult> {
    const encoded = Buffer.from(WINDOWS_HELPER, "utf16le").toString("base64")
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], lines.join("\n") + "\n")
  }

  async read(target: string, user: string): Promise<Uint8Array | undefined> {
    const r = await this.exec(["read", target, user])
    if (r.code === 3) return undefined
    if (r.code !== 0) throw new CredentialError(`${this.label}: reading ${target} failed (${r.stderr.split("\n")[0] || `exit ${r.code}`})`)
    return new Uint8Array(Buffer.from(r.stdout.toString("ascii").trim(), "base64"))
  }

  async write(target: string, user: string, password: Uint8Array): Promise<void> {
    const r = await this.exec(["write", target, user, Buffer.from(password).toString("base64")])
    if (r.code !== 0) throw new CredentialError(`${this.label}: storing ${target} failed (${r.stderr.split("\n")[0] || `exit ${r.code}`})`)
  }

  async remove(target: string, user: string): Promise<boolean> {
    const r = await this.exec(["delete", target, user])
    return r.code === 0
  }
}

// MARK: macOS Keychain

/** Quotes one argument for `security -i`, which reads commands from stdin. */
const securityQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

class MacKeychainStore implements CredentialStore {
  readonly label = "macOS Keychain"

  async read(target: string, user: string): Promise<Uint8Array | undefined> {
    const r = await run("/usr/bin/security", ["find-generic-password", "-s", target, "-a", user, "-w"], undefined)
    if (r.code === 44) return undefined // errSecItemNotFound
    if (r.code !== 0) throw new CredentialError(`${this.label}: reading ${target} failed (exit ${r.code})`)
    return new Uint8Array(r.stdout.subarray(0, r.stdout.length - (r.stdout.at(-1) === 0x0a ? 1 : 0)))
  }

  async write(target: string, user: string, password: Uint8Array): Promise<void> {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(password)
    if (/[\r\n]/.test(text)) throw new CredentialError("A password cannot contain line breaks")
    const command = `add-generic-password -U -s ${securityQuote(target)} -a ${securityQuote(user)} -l ${securityQuote(`agent-gui ${target}`)} -w ${securityQuote(text)}\n`
    const r = await run("/usr/bin/security", ["-i"], command)
    if (r.code !== 0) throw new CredentialError(`${this.label}: storing ${target} failed (exit ${r.code})`)
  }

  async remove(target: string, user: string): Promise<boolean> {
    const r = await run("/usr/bin/security", ["delete-generic-password", "-s", target, "-a", user], undefined)
    return r.code === 0
  }
}

// MARK: Linux Secret Service

class SecretToolStore implements CredentialStore {
  readonly label = "Secret Service (secret-tool)"

  async read(target: string, user: string): Promise<Uint8Array | undefined> {
    const r = await run("secret-tool", ["lookup", "service", target, "user", user], undefined)
    if (r.code !== 0 || r.stdout.length === 0) return undefined
    return new Uint8Array(r.stdout)
  }

  async write(target: string, user: string, password: Uint8Array): Promise<void> {
    const r = await run("secret-tool", ["store", `--label=agent-gui ${target}`, "service", target, "user", user], password)
    if (r.code !== 0) throw new CredentialError(`${this.label}: storing ${target} failed (${r.stderr || `exit ${r.code}`})`)
  }

  async remove(target: string, user: string): Promise<boolean> {
    const r = await run("secret-tool", ["clear", "service", target, "user", user], undefined)
    return r.code === 0
  }
}

/** The credential store of this platform. */
export function platformCredentialStore(platform: NodeJS.Platform = process.platform): CredentialStore {
  if (platform === "win32") return new WindowsCredentialStore()
  if (platform === "darwin") return new MacKeychainStore()
  return new SecretToolStore()
}

/** An in-memory store for tests. */
export class MemoryCredentialStore implements CredentialStore {
  readonly label = "memory"
  private readonly items = new Map<string, Uint8Array>()
  private key = (target: string, user: string) => `${target}\u0000${user}`
  async read(target: string, user: string) {
    const v = this.items.get(this.key(target, user))
    return v ? v.slice() : undefined
  }
  async write(target: string, user: string, password: Uint8Array) {
    this.items.set(this.key(target, user), password.slice())
  }
  async remove(target: string, user: string) {
    return this.items.delete(this.key(target, user))
  }
}

/**
 * The password of a system as UTF-8 bytes, from its configured source. The caller wipes the
 * bytes (`fill(0)`) as soon as the logon step is built.
 */
export async function resolvePassword(system: SystemConfig, store: CredentialStore): Promise<Uint8Array> {
  switch (system.password.kind) {
    case "value":
      return new TextEncoder().encode(system.password.value)
    case "credentialStore": {
      const bytes = await store.read(credentialTarget(system), system.user)
      if (!bytes || bytes.length === 0)
        throw new CredentialError(
          `No password stored for system ${system.name} in the ${store.label}. Store it with: agent-gui --set-password --system ${system.name}`
        )
      return bytes
    }
    case "none":
      throw new CredentialError(
        `System ${system.name} has no password configured. Set "password": "\${credential}" and run: agent-gui --set-password --system ${system.name}`
      )
  }
}

// MARK: Attempt budget

/**
 * The logon attempt budget (Swooey docs/credentials.md §4): an automatic logon marks the account
 * suspended before it goes out (a write-ahead record), and only a confirmed successful logon
 * clears it. A rejection, a server error, no answer or a crash all leave it suspended, so no
 * later call sends the same password again. `--set-password` or `--reset-logon` clears it.
 *
 * At most one automatic failed attempt per stored password between successful logons: an agent
 * in a retry loop cannot lock the SAP user.
 */
export class LogonState {
  private readonly file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, "state.json")
  }

  /** The key of one SAP account: system, host, client and user. */
  static accountKey(system: Pick<SystemConfig, "name" | "host" | "port" | "client" | "user">): string {
    return `${system.name}|${system.host}:${system.port}|${system.client ?? ""}|${system.user}`
  }

  private load(): { suspended: Record<string, { since: string; reason: string }> } {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"))
      if (raw && typeof raw === "object" && raw.suspended && typeof raw.suspended === "object") return raw
    } catch {
      // missing or unreadable: nothing suspended
    }
    return { suspended: {} }
  }

  private save(state: { suspended: Record<string, { since: string; reason: string }> }) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // not supported on this file system
    }
  }

  /** Why the account is suspended, or undefined when an automatic attempt may go out. */
  suspension(key: string): { since: string; reason: string } | undefined {
    return this.load().suspended[key]
  }

  /** Records an attempt before it is sent. */
  beginAttempt(key: string): void {
    const state = this.load()
    state.suspended[key] = { since: new Date().toISOString(), reason: "a logon attempt did not complete" }
    this.save(state)
  }

  /** Records why the attempt failed; the account stays suspended. */
  failed(key: string, reason: string): void {
    const state = this.load()
    state.suspended[key] = { since: new Date().toISOString(), reason }
    this.save(state)
  }

  /** A confirmed successful logon, or a new password: clears the suspension. */
  clear(key: string): void {
    const state = this.load()
    if (!(key in state.suspended)) return
    delete state.suspended[key]
    this.save(state)
  }

  /** Withdraws an attempt that never went out (the connection failed before the logon step). */
  withdraw(key: string): void {
    this.clear(key)
  }
}

// MARK: Interactive prompt

/**
 * Reads a password from the terminal without echo, or one line from stdin when it is not a
 * terminal (for scripted setup). Returns UTF-8 bytes; the caller wipes them.
 */
export function promptPassword(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    output.write(prompt)
    const chars: number[] = []
    const finish = (error?: Error) => {
      input.removeListener("data", onData)
      input.removeListener("end", onEnd)
      if (input.isTTY) input.setRawMode(false)
      input.pause()
      output.write("\n")
      if (error) {
        chars.fill(0)
        reject(error)
        return
      }
      const bytes = new TextEncoder().encode(String.fromCodePoint(...chars))
      chars.fill(0)
      resolvePromise(bytes)
    }
    const onEnd = () => finish()
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      for (const ch of text) {
        const code = ch.codePointAt(0)!
        if (ch === "\r" || ch === "\n") return finish()
        if (code === 3) return finish(new CredentialError("cancelled"))
        if (code === 4 && chars.length === 0) return finish(new CredentialError("cancelled"))
        if (code === 127 || code === 8) {
          chars.pop()
          continue
        }
        if (code >= 0x20) chars.push(code)
      }
    }
    if (input.isTTY) input.setRawMode(true)
    input.on("data", onData)
    input.on("end", onEnd)
    input.resume()
  })
}
