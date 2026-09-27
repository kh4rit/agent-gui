// SPDX-License-Identifier: MIT
// The MCP tools: thin adapters from tool arguments to the GuiService, with the screen formatted
// for the model. Every tool that can change data in SAP other than by saving is "navigate";
// only gui_save commits.

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describeSystem } from "./config.js"
import { errorMessage, plural, truncate } from "./format.js"
import type { AgentControl, AgentList, AgentTable } from "./engine/agentScreen.js"
import type { GuiService, StepResult, TriggerInput } from "./service.js"
import { formatScreen, plainText } from "./snapshot.js"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const run = async (fn: () => Promise<string> | string): Promise<ToolResult> => {
  try {
    return { content: [{ type: "text", text: truncate(await fn(), 60000) }] }
  } catch (e) {
    return { content: [{ type: "text", text: errorMessage(e) }], isError: true }
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const navigates = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const commits = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

const sessionParam = z.string().describe("Session id from gui_connect, e.g. S1.")
const detailParam = z.enum(["compact", "full"]).optional().describe("compact (default) or full: full adds menus, disabled functions and positions.")

/** A step's result: what changed, then the screen. */
export function formatStep(result: StepResult, detail?: "compact" | "full"): string {
  const lines = [`changed: ${result.change}`]
  if (result.busy) lines.push("busy: the server has not answered yet; call gui_wait, then gui_screen")
  for (const n of result.notes ?? []) lines.push(`note: ${n}`)
  lines.push("", formatScreen(result.screen, { detail }))
  return lines.join("\n")
}

function formatRows(data: AgentTable | AgentList): string {
  if ("lines" in data) {
    const lines = [`list: lines ${data.firstLine}-${data.firstLine + data.lines.length - 1}${data.totalLines !== undefined ? ` of ${data.totalLines}` : ""}`]
    for (const h of data.header ?? []) lines.push(` head| ${h}`)
    data.lines.forEach((l, i) => lines.push(`${String(data.firstLine + i).padStart(5)}| ${l}`))
    return lines.join("\n")
  }
  const header = data.columns.map((c, i) => `${c.title || c.name || `col${i}`}${c.name && c.name !== c.title ? ` (${c.name})` : ""}${c.key ? "*" : ""}`)
  const lines = [
    `table ${data.ref}${data.name ? ` ${data.name}` : ""}: ${plural(data.rows.length, "row")}${data.totalRows !== undefined ? ` of ${data.totalRows}` : ""}`,
    `| row |${data.selectable ? " mark |" : ""} ${header.join(" | ")} |`
  ]
  for (const r of data.rows)
    lines.push(`| ${r.row} |${data.selectable ? ` ${r.selected ? "[x]" : "[ ]"} |` : ""} ${data.columns.map((_c, i) => plainText(r.cells[i] ?? "")).join(" | ")} |`)
  return lines.join("\n")
}

function formatControl(c: AgentControl): string {
  if (c.tree) {
    const lines = [`tree ${c.ref}: ${plural(c.tree.nodes.length, "node")} loaded`]
    for (const n of c.tree.nodes) {
      const marker = n.hasChildren ? (n.expanded ? "[-]" : "[+]") : "   "
      lines.push(`${"  ".repeat(n.depth)}${marker} ${plainText(n.text)}  {${n.key}}${n.items?.length ? `  | ${n.items.map(plainText).join(" | ")}` : ""}`)
    }
    return lines.join("\n")
  }
  if (c.grid) {
    const lines = [`grid ${c.ref}: ${plural(c.grid.rows.length, "row")}${c.grid.totalRows !== undefined ? ` of ${c.grid.totalRows}` : ""}`]
    lines.push(`| row | ${c.grid.columns.map(col => col.title || col.name).join(" | ")} |`)
    c.grid.rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.map(plainText).join(" | ")} |`))
    return lines.join("\n")
  }
  return `control ${c.ref}: ${c.className ?? c.kind}`
}

/** The trigger of gui_step from its arguments: exactly one, Enter when none is given. */
export function triggerFrom(args: { key?: string; function?: string; okcode?: string; choose?: string; chooseLine?: number; chooseColumn?: number; valueHelp?: string; enter?: boolean }): TriggerInput {
  const given: TriggerInput[] = []
  if (args.key) given.push({ kind: "key", key: args.key })
  if (args.function) given.push({ kind: "function", function: args.function })
  if (args.okcode !== undefined && args.okcode !== "") given.push({ kind: "okcode", okcode: args.okcode })
  if (args.choose !== undefined || args.chooseLine !== undefined)
    given.push({ kind: "choose", field: args.choose, line: args.chooseLine, column: args.chooseColumn })
  if (args.valueHelp) given.push({ kind: "valueHelp", field: args.valueHelp })
  if (given.length > 1) throw new Error("Give exactly one of key, function, okcode, choose, valueHelp (or none for Enter)")
  return given[0] ?? { kind: "enter" }
}

export function registerTools(server: McpServer, gui: GuiService) {
  server.registerTool(
    "gui_list_systems",
    {
      title: "List SAP systems",
      description: "Lists the configured SAP systems (host, client, user, read-only flag, allowed transactions) and the open sessions. Use a system's name with gui_connect.",
      inputSchema: {},
      annotations: readOnly
    },
    () =>
      run(() => {
        const lines = gui.systems().map(s => {
          const sessions = s.sessions.map(x => `    ${x.session}${x.transaction ? ` ${x.transaction}` : ""}${x.title ? ` "${x.title}"` : ""}${x.busy ? " (busy)" : ""}`)
          return [`- ${describeSystem(s.config, s.isDefault)}`, ...sessions].join("\n")
        })
        return `Configured systems:\n${lines.join("\n")}`
      })
  )

  server.registerTool(
    "gui_connect",
    {
      title: "Log on / open a session",
      description:
        "Logs on to an SAP system over DIAG with the stored credential (the agent never handles passwords) and returns a session id and its first screen. Called again for a system that is already logged on, it opens another session (SAP mode) on the same logon. Optionally starts a transaction right away.",
      inputSchema: {
        system: z.string().optional().describe("Configured system name (gui_list_systems). Optional when only one is configured."),
        transaction: z.string().optional().describe("Transaction to start after logon, e.g. SPRO, SM30, SE16.")
      },
      annotations: navigates
    },
    args => run(async () => formatStep(await gui.connect(args.system, args.transaction)))
  )

  server.registerTool(
    "gui_disconnect",
    {
      title: "Log off",
      description: "Ends a session, or logs off every session of a system. Unsaved input in those sessions is lost.",
      inputSchema: {
        session: z.string().optional().describe("Session to end."),
        system: z.string().optional().describe("System to log off completely.")
      },
      annotations: navigates
    },
    args => run(() => gui.disconnect({ session: args.session, system: args.system }))
  )

  server.registerTool(
    "gui_screen",
    {
      title: "Read the screen",
      description:
        "Returns the current screen of a session: transaction, program and screen number, title, status message, the functions (k… references, with their keys), the fields (f… references, labels, technical names, values, required/F4 flags), table controls (t…) with the visible rows, lists, tabs and controls such as trees (c…). References are valid for the screen they were read from.",
      inputSchema: { session: sessionParam, detail: detailParam },
      annotations: readOnly
    },
    args => run(() => formatScreen(gui.screen(args.session), { detail: args.detail }))
  )

  server.registerTool(
    "gui_start",
    {
      title: "Start a transaction",
      description:
        "Starts a transaction in the session (like /nCODE in the command field: the current transaction ends, unsaved input is lost), or with newSession in a new session (/oCODE). Returns the first screen.",
      inputSchema: {
        session: sessionParam,
        transaction: z.string().describe("Transaction code, e.g. SPRO, SM30, SE16, /SCWM/MON."),
        newSession: z.boolean().optional().describe("Open it in a new session (/o) instead of replacing the current one.")
      },
      annotations: navigates
    },
    args => run(async () => formatStep(await gui.start(args.session, args.transaction, args.newSession ?? false)))
  )

  server.registerTool(
    "gui_step",
    {
      title: "Fill in and submit the screen",
      description: [
        "One dialog step, as SAP GUI sends it: set any number of fields, then submit with exactly one trigger (Enter when none is given).",
        "Fields are addressed by reference (f12), technical name (RSYST-BNAME), label, or as a table cell t1:ROW:COLUMN. Table-control cells go in `cells` (absolute row from 1 on the visible page, column by title, technical name or index); row marks in `marks`.",
        "Triggers: key (F1-F12 with Shift/Ctrl, PageDown, PageUp), function (k-reference, function code, or the visible text of a button or menu item), okcode (raw command-field text), choose (F2 on a field reference or a list line/column), valueHelp (F4 on a field).",
        "Saving is refused here: use gui_save. Returns what changed and the next screen."
      ].join(" "),
      inputSchema: {
        session: sessionParam,
        edits: z
          .array(
            z.object({
              field: z.string().describe("f-reference, technical field name, or label."),
              value: z.string().optional().describe("New text of an input field."),
              checked: z.boolean().optional().describe("Checkbox state."),
              select: z.boolean().optional().describe("true selects this radio button."),
              option: z.string().optional().describe("Dropdown entry: key or text.")
            })
          )
          .optional(),
        cells: z
          .array(
            z.object({
              table: z.string().describe("Table reference, e.g. t1."),
              row: z.number().int().min(1).describe("Absolute row number from 1 (as shown in the table)."),
              column: z.string().describe("Column title, technical name, or index from 0."),
              value: z.string().optional(),
              checked: z.boolean().optional()
            })
          )
          .optional(),
        marks: z
          .array(z.object({ table: z.string(), row: z.number().int().min(1), marked: z.boolean() }))
          .optional()
          .describe("Row marks of table controls (select rows for Copy As, Delete, Details …)."),
        cursor: z.string().optional().describe("Field reference to put the cursor on."),
        key: z.string().optional().describe("Function key, e.g. F8, Shift+F2, Ctrl+F11, PageDown."),
        function: z.string().optional().describe("Function to fire: k-reference, function code, or its visible text."),
        okcode: z.string().optional().describe("Raw command-field text, e.g. =ZZASK or /n."),
        choose: z.string().optional().describe("F2 (double-click) on this field reference or table cell t1:ROW:COLUMN."),
        chooseLine: z.number().int().min(1).optional().describe("F2 on this list line (with chooseColumn)."),
        chooseColumn: z.number().int().min(0).optional(),
        valueHelp: z.string().optional().describe("F4 value help on this field reference."),
        detail: detailParam
      },
      annotations: navigates
    },
    args =>
      run(async () =>
        formatStep(
          await gui.step({
            session: args.session,
            edits: args.edits,
            cells: args.cells,
            marks: args.marks,
            cursor: args.cursor,
            trigger: triggerFrom(args)
          }),
          args.detail
        )
      )
  )

  server.registerTool(
    "gui_table",
    {
      title: "Read table rows",
      description:
        "Reads rows of a table control (t-reference) or lines of a classic list (table = \"list\") beyond the visible page. The server is paged as a user would page, and the screen is left where it was. Refused while the screen has unsent edits.",
      inputSchema: {
        session: sessionParam,
        table: z.string().describe("Table reference (t1) or \"list\"."),
        fromRow: z.number().int().min(1).optional().describe("First row or line (default 1)."),
        rows: z.number().int().min(1).max(2000).optional().describe("How many (default 200).")
      },
      annotations: readOnly
    },
    args => run(async () => formatRows(await gui.readTable(args.session, args.table, args.fromRow ?? 1, args.rows ?? 200)))
  )

  server.registerTool(
    "gui_tree",
    {
      title: "Work with a tree control",
      description:
        "Tree controls such as the SPRO IMG, the SAP Easy Access menu or the transport organizer. read: the loaded nodes as an outline with node keys. select: select a node. open: double-click a node (runs an IMG activity, opens a folder or an entry). expand / collapse: open or close a folder. clickItem: click a node's column item (e.g. an execute icon), with item = the column name or index. find: nodes whose text matches `text` (* as wildcard) among the loaded nodes.",
      inputSchema: {
        session: sessionParam,
        control: z.string().describe("Control reference from the screen, e.g. c1."),
        action: z.enum(["read", "select", "open", "expand", "collapse", "clickItem", "find"]),
        node: z.string().optional().describe("Node key ({…} in the outline)."),
        item: z.string().optional().describe("For clickItem: the item column name or index."),
        text: z.string().optional().describe("For find: the text to look for (* wildcard).")
      },
      annotations: navigates
    },
    args =>
      run(async () => {
        const out = await gui.tree(args.session, args.control, args.action, args.node, args.item, args.text)
        return "screen" in out ? formatStep(out) : formatControl(out)
      })
  )

  server.registerTool(
    "gui_grid",
    {
      title: "Work with an ALV grid",
      description: "ALV grid controls. read: the delivered rows with column names and titles. open: double-click a cell (row from 1, column name). select: make a cell current.",
      inputSchema: {
        session: sessionParam,
        control: z.string().describe("Control reference from the screen, e.g. c2."),
        action: z.enum(["read", "open", "select"]),
        row: z.number().int().min(1).optional(),
        column: z.string().optional()
      },
      annotations: navigates
    },
    args =>
      run(async () => {
        const out = await gui.grid(args.session, args.control, args.action, args.row, args.column)
        return "screen" in out ? formatStep(out) : formatControl(out)
      })
  )

  server.registerTool(
    "gui_save",
    {
      title: "Save",
      description: [
        "Presses Save (Ctrl+S) on the current screen: the only tool that commits data. Refused on read-only systems.",
        "If SAP asks for a transport request (customizing or workbench request prompt), `transport` is entered and confirmed. Without `transport` the prompt is cancelled, nothing is saved, and the result lists the request prompt's text so you can ask the user which request to use.",
        "Never pick or create a transport request on your own: use the one the user named."
      ].join(" "),
      inputSchema: {
        session: sessionParam,
        transport: z.string().optional().describe("Transport request number the user named, e.g. DEVK900123.")
      },
      annotations: commits
    },
    args =>
      run(async () => {
        const result = await gui.save(args.session, args.transport)
        const head = result.saved
          ? "saved: yes"
          : result.transportPrompt
            ? `saved: no — SAP asks for a transport request (${result.transportPrompt.text}); the prompt was cancelled. Ask the user which request to use and call gui_save again with transport.${result.transportPrompt.candidates.length ? ` Requests offered: ${result.transportPrompt.candidates.join(", ")}` : ""}`
            : "saved: no (see the message)"
        return `${head}\n${formatStep(result)}`
      })
  )

  server.registerTool(
    "gui_wait",
    {
      title: "Wait for the server",
      description: "Waits for the answer of a step that was still running (a result said busy), then returns the screen.",
      inputSchema: {
        session: sessionParam,
        seconds: z.number().int().min(1).max(600).optional().describe("How long to wait at most (default 60).")
      },
      annotations: readOnly
    },
    args => run(async () => formatStep(await gui.wait(args.session, args.seconds ?? 60)))
  )
}
