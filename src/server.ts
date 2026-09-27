// SPDX-License-Identifier: MIT
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { GuiService } from "./service.js"
import { registerTools } from "./tools.js"
import { SERVER_NAME, SERVER_VERSION } from "./version.js"

export { SERVER_NAME, SERVER_VERSION }

export const INSTRUCTIONS = [
  "SAP GUI transactions for agents over the DIAG protocol: log on, start transactions, read screens, fill fields, work with table controls, lists, popups and tree controls, and save into transport requests.",
  "Typical workflow: gui_connect (with transaction) -> gui_screen -> gui_step (fill fields by f-reference, press a function by k-reference or key) -> gui_table / gui_tree for more rows and nodes -> gui_save with the transport request the user named.",
  "Read each result before the next step: the status message (E = error, W = warning) and popups decide what to do next. Only gui_save commits; never choose or create a transport request yourself."
].join("\n")

/** Builds the MCP server on top of a GuiService. */
export function createServer(gui: GuiService) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  registerTools(server, gui)
  return server
}

/**
 * Calls one tool without an MCP host (CLI --call): the server is connected to an in-memory
 * client, the tool is invoked and its text content returned.
 */
export async function callTool(gui: GuiService, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = createServer(gui)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: `${SERVER_NAME}-cli`, version: SERVER_VERSION })
  await client.connect(clientTransport)
  try {
    const known = (await client.listTools()).tools.map(t => t.name)
    if (!known.includes(name)) throw new Error(`Unknown tool "${name}". Tools: ${known.join(", ")}`)
    const result = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean }
    const text = (result.content ?? []).map(c => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("\n")
    return { text, isError: !!result.isError }
  } finally {
    await client.close()
    await server.close()
  }
}
