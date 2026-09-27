#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ConfigError, describeSystem, loadConfig, type Config } from "./config.js"
import { CredentialError, LogonState, credentialTarget, platformCredentialStore, promptPassword } from "./credentials.js"
import { errorMessage } from "./format.js"
import { callTool, createServer, SERVER_NAME, SERVER_VERSION } from "./server.js"
import { Sessions } from "./sessions.js"
import { formatScreen } from "./snapshot.js"

const HELP = `${SERVER_NAME} ${SERVER_VERSION} - SAP GUI transactions for AI agents (MCP server, DIAG protocol)

Usage: agent-gui [--config <file>] [--check | --call <tool> | --set-password | --forget-password | --reset-logon]
                 [--system <name>] [--args <json>]

  --config <file>     JSON configuration with one or more SAP systems (or AGENT_GUI_CONFIG;
                      default ~/.agent-gui/systems.json)
  --check             log on to every configured system (or --system), print the first screen, log off
  --set-password      store the password of --system (or the default system) in the credential store
                      (Windows Credential Manager, macOS Keychain); asks without echo
  --forget-password   remove the stored password of --system
  --reset-logon       allow an automatic logon again after a rejected password (for \${env:...} passwords)
  --system <name>     the system for --check, --set-password, --forget-password, --reset-logon
  --call <tool>       run one tool without an MCP host and print its result, e.g.
                      --call gui_connect --args '{"system":"DEV","transaction":"SE16"}'
  --args <json>       arguments of the tool: inline JSON, @file.json, or - to read stdin (default {})
  --help              show this help

Without a config file a single system is read from SAP_HOST, SAP_INSTANCE (or SAP_PORT), SAP_CLIENT,
SAP_USER and SAP_PASSWORD (optional SAP_LANGUAGE, SAP_SYSTEM_NAME, SAP_READ_ONLY).
The server speaks MCP over stdio; register it in your agent (Copilot CLI, VS Code, Claude Code ...).

Use of this software requires appropriate SAP licences for any system you connect to.`

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`)
  return v
}

function selectedSystems(config: Config, argv: string[]) {
  const only = argValue(argv, "--system")
  if (!only) return config.systems
  const match = config.systems.find(s => s.name.toLowerCase() === only.toLowerCase())
  if (!match) throw new ConfigError(`Unknown system ${only}. Configured: ${config.systems.map(s => s.name).join(", ")}`)
  return [match]
}

function oneSystem(config: Config, argv: string[]) {
  const name = argValue(argv, "--system") ?? config.defaultSystem
  const system = config.systems.find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!system) throw new ConfigError(`Unknown system ${name}`)
  return system
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return
  }
  const config = loadConfig(argv, process.env)

  if (argv.includes("--set-password")) {
    const system = oneSystem(config, argv)
    if (system.password.kind !== "credentialStore")
      console.error(`Note: system ${system.name} does not use "\${credential}" as its password; the stored one is used only after you change that.`)
    const store = platformCredentialStore()
    const password = await promptPassword(`Password for ${system.user} on ${system.name}: `)
    if (password.length === 0) throw new CredentialError("No password entered; nothing stored.")
    try {
      await store.write(credentialTarget(system), system.user, password)
    } finally {
      password.fill(0)
    }
    new LogonState(config.dataDir).clear(LogonState.accountKey(system))
    console.log(`Stored in the ${store.label} as ${credentialTarget(system)} (user ${system.user}).`)
    return
  }
  if (argv.includes("--forget-password")) {
    const system = oneSystem(config, argv)
    const store = platformCredentialStore()
    const removed = await store.remove(credentialTarget(system), system.user)
    console.log(removed ? `Removed ${credentialTarget(system)} from the ${store.label}.` : `Nothing stored for ${system.name}.`)
    return
  }
  if (argv.includes("--reset-logon")) {
    const system = oneSystem(config, argv)
    new LogonState(config.dataDir).clear(LogonState.accountKey(system))
    console.log(`Automatic logon to ${system.name} is allowed again. It is tried once; check the password first.`)
    return
  }

  const sessions = new Sessions(config)

  if (argv.includes("--call")) {
    const tool = argValue(argv, "--call")!
    let raw = argv.includes("--args") ? argValue(argv, "--args")! : "{}"
    if (raw === "-") raw = readFileSync(0, "utf8")
    else if (raw.startsWith("@")) raw = readFileSync(raw.slice(1), "utf8")
    let args: Record<string, unknown>
    try {
      args = JSON.parse(raw.replace(/^﻿/, ""))
    } catch (e) {
      throw new Error(`--args is not valid JSON: ${(e as Error).message}`)
    }
    try {
      const result = await callTool(sessions, tool, args)
      console.log(result.text)
      process.exitCode = result.isError ? 1 : 0
    } finally {
      await sessions.close()
    }
    return
  }

  if (argv.includes("--check")) {
    console.log("Use of this software requires appropriate SAP licences for any system you connect to.")
    let failed = 0
    for (const system of selectedSystems(config, argv)) {
      process.stdout.write(`${describeSystem(system, system.name === config.defaultSystem)} ... `)
      try {
        const result = await sessions.connect(system.name)
        console.log("OK")
        console.log(
          formatScreen(result.screen)
            .split("\n")
            .slice(0, 6)
            .map(l => `   ${l}`)
            .join("\n")
        )
        await sessions.disconnect({ system: system.name })
      } catch (e) {
        failed++
        console.log(`FAILED\n   ${errorMessage(e)}`)
      }
    }
    await sessions.close()
    process.exitCode = failed ? 1 : 0
    return
  }

  const server = createServer(sessions)
  const transport = new StdioServerTransport()
  const shutdown = async () => {
    await sessions.close().catch(() => undefined)
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  transport.onclose = () => void shutdown()
  await server.connect(transport)
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready: ${config.systems.map(s => s.name).join(", ")}`)
}

main().catch(e => {
  console.error(e instanceof ConfigError ? e.message : errorMessage(e))
  process.exit(1)
})
