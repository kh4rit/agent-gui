// SPDX-License-Identifier: MIT
// Configuration: one or more SAP systems reached over DIAG (agent-adt's config conventions).

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** What the first message declares (Swooey's identity presets, DiagCodec ClientIdentityPresets). */
export const IDENTITY_PRESETS = ["reference", "reference-norfc", "reference-nocfw", "minimal", "placeholder"] as const
export type IdentityPresetName = (typeof IDENTITY_PRESETS)[number]

/** How a logon answers the server's "already logged on" question. */
export const MULTIPLE_LOGON_CHOICES = ["fail", "continue", "endOthers"] as const
export type MultipleLogonChoice = (typeof MULTIPLE_LOGON_CHOICES)[number]

/** Where the password of a system comes from. The value itself is never part of the config object. */
export type PasswordSource =
  /** `${credential}`: the operating system's credential store (Windows Credential Manager, macOS Keychain). */
  | { kind: "credentialStore" }
  /** A literal or `${env:NAME}`-expanded value. Resolved at load time; kept out of logs. */
  | { kind: "value"; value: string }
  /** No password configured. */
  | { kind: "none" }

export interface TransactionPolicyConfig {
  /** When set, only these transactions may be started or worked in. */
  allow?: string[]
  /** Transactions refused in addition to the built-in list. */
  deny?: string[]
  /** Set to false to drop the built-in deny list (not recommended). */
  builtInDenyList?: boolean
}

/** Connection details and policies for one SAP system. */
export interface SystemConfig {
  /** Short name used by the `system` tool parameter, e.g. "DEV". */
  name: string
  /** Application server host name or address. */
  host: string
  /** TCP port of the dispatcher: 3200 + instance number unless given explicitly. */
  port: number
  /** SAP client, e.g. "100". Optional: the logon screen's default is used. */
  client?: string
  /** SAP user name. */
  user: string
  /** Logon language, e.g. "EN". */
  language?: string
  /** Where the password comes from. */
  password: PasswordSource
  /** When true every tool that saves is refused, and so are the commit functions. */
  readOnly: boolean
  /** Which transactions the agent may use. */
  transactions: TransactionPolicyConfig
  /** Function codes that save or post; refused by gui_step (use gui_save). */
  commitFunctions: string[]
  /** What to do when the server reports the user is already logged on. */
  whenAlreadyLoggedOn: MultipleLogonChoice
  /** What the first message declares. */
  identity: IdentityPresetName
  /** Most sessions (SAP modes) the agent may open at once. */
  maxSessions: number
  /** Idle sessions are logged off after this many minutes (0 = never). */
  idleLogoffMinutes: number
  /** A step answers "busy" after this many seconds; the server's step continues. */
  stepTimeoutSeconds: number
  /** Seconds to wait for the TCP connection. */
  connectTimeoutSeconds: number
  /** Audit log settings. */
  audit: { enabled: boolean; values: boolean }
  /** File for a structure-only protocol trace (no field values, no passwords). */
  trace?: string
}

export interface Config {
  systems: SystemConfig[]
  /** Name of the system used when a tool call does not specify one. */
  defaultSystem: string
  /** Folder for audit logs and the logon state. */
  dataDir: string
}

export class ConfigError extends Error {}

/** `~/.agent-gui` (`%USERPROFILE%\.agent-gui` on Windows), or AGENT_GUI_HOME. */
export function defaultDataDir(env: NodeJS.ProcessEnv): string {
  return env.AGENT_GUI_HOME || join(homedir(), ".agent-gui")
}

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const CREDENTIAL_REF = "${credential}"

/** Replaces `${env:NAME}` placeholders with environment variable values. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF, (_match, key: string) => {
    const v = env[key]
    if (v === undefined) throw new ConfigError(`Environment variable ${key} referenced in the config file is not set`)
    return v
  })
}

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "boolean") return v
  return /^(1|true|yes|x)$/i.test(String(v))
}

function optionalString(v: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (v === undefined || v === null || v === "") return undefined
  return expandEnvRefs(String(v), env)
}

function optionalNumber(v: unknown, name: string, field: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`System ${name}: ${field} must be a non-negative number`)
  return n
}

function stringList(v: unknown, name: string, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined
  const list = Array.isArray(v) ? v : String(v).split(",")
  const out = list.map(x => String(x).trim().toUpperCase()).filter(Boolean)
  if (out.some(x => /\s/.test(x))) throw new ConfigError(`System ${name}: ${field} entries must not contain spaces`)
  return out
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T, name: string, field: string): T {
  if (v === undefined || v === null || v === "") return fallback
  const s = String(v)
  const hit = allowed.find(a => a.toLowerCase() === s.toLowerCase())
  if (!hit) throw new ConfigError(`System ${name}: ${field} must be one of ${allowed.join(", ")} (got "${s}")`)
  return hit
}

function parsePassword(v: unknown, env: NodeJS.ProcessEnv): PasswordSource {
  if (v === undefined || v === null || v === "") return { kind: "none" }
  const raw = String(v)
  if (raw.trim() === CREDENTIAL_REF) return { kind: "credentialStore" }
  return { kind: "value", value: expandEnvRefs(raw, env) }
}

/** Port from `port`, or 3200 + the two-digit instance number (sapdpNN). */
function parsePort(raw: Record<string, unknown>, name: string): number {
  if (raw.port !== undefined && raw.port !== "") {
    const port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`System ${name}: port must be 1-65535`)
    return port
  }
  const instance = raw.instance ?? raw.sysnr ?? raw.systemNumber
  if (instance === undefined || instance === "") throw new ConfigError(`System ${name}: instance (00-99) or port is required`)
  const text = String(instance)
  if (!/^\d{1,2}$/.test(text)) throw new ConfigError(`System ${name}: instance must be 00-99 (got "${text}")`)
  return 3200 + Number(text)
}

function normalizeSystem(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): SystemConfig {
  const name = optionalString(raw.name, env)
  if (!name) throw new ConfigError("Every system in the config file needs a name")
  if (/\s/.test(name)) throw new ConfigError(`System name "${name}" must not contain spaces`)
  const host = optionalString(raw.host ?? raw.server ?? raw.ashost, env)
  if (!host) throw new ConfigError(`System ${name}: host is required`)
  if (host.includes("/")) throw new ConfigError(`System ${name}: host must be a plain host name (SAProuter strings are not supported yet)`)
  const user = optionalString(raw.user ?? raw.username, env)
  if (!user) throw new ConfigError(`System ${name}: user is required`)
  const client = optionalString(raw.client, env)
  if (client !== undefined && !/^\d{3}$/.test(client)) throw new ConfigError(`System ${name}: client must be three digits`)
  const language = optionalString(raw.language, env)
  if (language !== undefined && !/^[A-Za-z0-9]{1,2}$/.test(language)) throw new ConfigError(`System ${name}: language must be a 1-2 character SAP language key`)
  const tx = (raw.transactions && typeof raw.transactions === "object" ? raw.transactions : {}) as Record<string, unknown>
  const audit = (raw.audit && typeof raw.audit === "object" ? raw.audit : {}) as Record<string, unknown>
  return {
    name,
    host,
    port: parsePort(raw, name),
    client,
    user: user.toUpperCase(),
    language: language?.toUpperCase(),
    password: parsePassword(raw.password, env),
    readOnly: parseBool(raw.readOnly) ?? false,
    transactions: {
      allow: stringList(tx.allow, name, "transactions.allow"),
      deny: stringList(tx.deny, name, "transactions.deny"),
      builtInDenyList: parseBool(tx.builtInDenyList) ?? true
    },
    commitFunctions: stringList(raw.commitFunctions, name, "commitFunctions") ?? [],
    whenAlreadyLoggedOn: oneOf(raw.whenAlreadyLoggedOn, MULTIPLE_LOGON_CHOICES, "fail", name, "whenAlreadyLoggedOn"),
    identity: oneOf(raw.identity, IDENTITY_PRESETS, "reference", name, "identity"),
    maxSessions: optionalNumber(raw.maxSessions, name, "maxSessions") ?? 2,
    idleLogoffMinutes: optionalNumber(raw.idleLogoffMinutes, name, "idleLogoffMinutes") ?? 15,
    stepTimeoutSeconds: optionalNumber(raw.stepTimeoutSeconds, name, "stepTimeoutSeconds") ?? 60,
    connectTimeoutSeconds: optionalNumber(raw.connectTimeoutSeconds, name, "connectTimeoutSeconds") ?? 15,
    audit: { enabled: parseBool(audit.enabled) ?? true, values: parseBool(audit.values) ?? true },
    trace: optionalString(raw.trace, env)
  }
}

/** Builds a system from the SAP_* environment variables, if SAP_HOST is set. */
export function systemFromEnv(env: NodeJS.ProcessEnv): SystemConfig | undefined {
  if (!env.SAP_HOST) return undefined
  return normalizeSystem(
    {
      name: env.SAP_SYSTEM_NAME || "default",
      host: env.SAP_HOST,
      instance: env.SAP_INSTANCE,
      port: env.SAP_PORT,
      client: env.SAP_CLIENT,
      user: env.SAP_USER,
      language: env.SAP_LANGUAGE,
      password: env.SAP_PASSWORD,
      readOnly: env.SAP_READ_ONLY,
      identity: env.SAP_IDENTITY
    },
    {}
  )
}

/**
 * Parses a JSON config file. `systems` may be an array of systems (each with a `name`) or an
 * object keyed by system name.
 */
export function parseConfigFile(text: string, env: NodeJS.ProcessEnv, fileName = "config"): { systems: SystemConfig[]; defaultSystem?: string; dataDir?: string } {
  let raw: any
  try {
    raw = JSON.parse(text.replace(/^﻿/, "")) // PowerShell writes UTF-8 files with a byte order mark
  } catch (e) {
    throw new ConfigError(`Invalid JSON in ${fileName}: ${(e as Error).message}`)
  }
  if (!raw || typeof raw !== "object") throw new ConfigError(`${fileName} must contain a JSON object`)
  let entries: Record<string, unknown>[] = []
  if (Array.isArray(raw.systems)) entries = raw.systems
  else if (raw.systems && typeof raw.systems === "object")
    entries = Object.entries(raw.systems).map(([name, s]) => ({ name, ...(s as object) }))
  else if (raw.host) entries = [{ name: "default", ...raw }]
  return {
    systems: entries.map(s => normalizeSystem(s, env)),
    defaultSystem: optionalString(raw.defaultSystem, env),
    dataDir: optionalString(raw.dataDir, env)
  }
}

export const CONFIG_HELP = `No SAP system configured.

Either set environment variables:
  SAP_HOST=sap-dev.example.com  SAP_INSTANCE=00  SAP_CLIENT=100  SAP_USER=YOURUSER  SAP_PASSWORD=secret
  (optional: SAP_PORT=3200 SAP_LANGUAGE=EN SAP_SYSTEM_NAME=DEV SAP_READ_ONLY=true)

or point AGENT_GUI_CONFIG (or --config <file>) to a JSON file such as:
  {
    "defaultSystem": "DEV",
    "systems": {
      "DEV": { "host": "sap-dev.example.com", "instance": "00", "client": "100", "user": "YOURUSER", "password": "\${credential}" },
      "QAS": { "host": "sap-qas.example.com", "instance": "00", "client": "100", "user": "YOURUSER", "password": "\${env:SAP_QAS_PASSWORD}", "readOnly": true }
    }
  }

"\${credential}" reads the password from the Windows Credential Manager (macOS Keychain);
store it once with: agent-gui --set-password --system DEV`

/** Loads the configuration from CLI arguments, AGENT_GUI_CONFIG, ~/.agent-gui/systems.json and SAP_* variables. */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const systems: SystemConfig[] = []
  let defaultSystem: string | undefined
  let dataDir: string | undefined
  const idx = argv.indexOf("--config")
  if (idx >= 0 && !argv[idx + 1]) throw new ConfigError("--config requires a file path")
  let file = idx >= 0 ? argv[idx + 1] : env.AGENT_GUI_CONFIG
  let implicit = false
  if (!file) {
    file = join(defaultDataDir(env), "systems.json")
    implicit = true
  }
  const path = resolve(file)
  let text: string | undefined
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    if (!implicit) throw new ConfigError(`Cannot read config file ${path}: ${(e as Error).message}`)
  }
  if (text !== undefined) {
    const parsed = parseConfigFile(text, env, path)
    systems.push(...parsed.systems)
    defaultSystem = parsed.defaultSystem
    dataDir = parsed.dataDir
  }
  const fromEnv = systemFromEnv(env)
  if (fromEnv) {
    const existing = systems.findIndex(s => s.name.toLowerCase() === fromEnv.name.toLowerCase())
    if (existing >= 0) systems[existing] = fromEnv
    else systems.push(fromEnv)
  }
  if (!systems.length) throw new ConfigError(CONFIG_HELP)
  const names = new Set<string>()
  for (const s of systems) {
    const key = s.name.toLowerCase()
    if (names.has(key)) throw new ConfigError(`Duplicate system name ${s.name}`)
    names.add(key)
  }
  defaultSystem = env.SAP_DEFAULT_SYSTEM || defaultSystem || systems[0].name
  const match = systems.find(s => s.name.toLowerCase() === defaultSystem!.toLowerCase())
  if (!match) throw new ConfigError(`Default system ${defaultSystem} is not configured`)
  return { systems, defaultSystem: match.name, dataDir: dataDir ?? defaultDataDir(env) }
}

/** A system description safe to show to the agent: never a password. */
export function describeSystem(s: SystemConfig, isDefault: boolean): string {
  const parts = [
    `${s.name}${isDefault ? " (default)" : ""}: ${s.host}:${s.port}`,
    `client ${s.client ?? "default"}`,
    `user ${s.user}`,
    s.language ? `language ${s.language}` : undefined,
    s.readOnly ? "READ-ONLY" : undefined,
    s.transactions.allow ? `transactions ${s.transactions.allow.join(",")}` : undefined
  ]
  return parts.filter(Boolean).join("  ")
}
