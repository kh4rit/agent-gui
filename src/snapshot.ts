// SPDX-License-Identifier: MIT
// The screen as compact text for the model: identity and message first, then the functions,
// the fields with their references, tables, lists, tabs and controls. References (f…, k…, t…,
// c…) are what the tools take back.

import type { AgentControl, AgentField, AgentFunction, AgentScreen, AgentTable, AgentTreeNode } from "./engine/agentScreen.js"

export interface SnapshotOptions {
  /** compact: what an agent needs to act; full: also menus, disabled functions, positions. */
  detail?: "compact" | "full"
  /** Most list lines shown (the rest via gui_table). */
  maxListLines?: number
  /** Most tree nodes shown (the rest via gui_tree). */
  maxTreeNodes?: number
  /** Most grid rows shown (the rest via gui_grid). */
  maxGridRows?: number
}

const q = (text: string) => JSON.stringify(text)

/** Removes SAP icon codes (`@0V@`) and trims. */
export function plainText(text: string | undefined): string {
  return (text ?? "").replace(/@[0-9A-Z]{2}(\\Q[^@]*)?@/g, "").trim()
}

function functionLabel(f: AgentFunction): string {
  const text = plainText(f.text) || plainText(f.tooltip) || f.code || (f.key ? f.key : "")
  const extras = [f.key, f.code && f.code !== text ? f.code : undefined].filter(Boolean)
  return `${f.ref} ${text}${extras.length ? ` [${extras.join(" ")}]` : ""}${f.enabled ? "" : " (disabled)"}`
}

function formatFunctions(screen: AgentScreen, full: boolean): string[] {
  const shown = screen.functions.filter(f => (full || f.enabled) && (full || f.where !== "menu") && f.where !== "button")
  // One entry per code/key: the toolbar's, else the key list's.
  const seen = new Set<string>()
  const items: string[] = []
  for (const f of shown) {
    const id = `${f.code ?? ""}|${f.virtualKey ?? ""}|${plainText(f.text)}`
    if (seen.has(id)) continue
    seen.add(id)
    items.push(f.where === "menu" && f.menuPath?.length ? `${f.menuPath.join(" > ")} > ${functionLabel(f)}` : functionLabel(f))
  }
  const hidden = screen.functions.filter(f => !f.enabled).length
  const lines: string[] = []
  if (items.length) lines.push(`functions: ${items.join(" · ")}`)
  if (!full && hidden) lines.push(`  (${hidden} disabled functions not shown)`)
  if (!full && screen.functions.some(f => f.where === "menu")) lines.push("  (menu functions: gui_screen detail=full)")
  return lines
}

function describeField(f: AgentField, functions: Map<string, AgentFunction>, full: boolean): string {
  const name = f.name ? `(${f.name})` : ""
  const pos = full ? ` @${f.row},${f.column}` : ""
  const flags: string[] = []
  if (f.required) flags.push("required")
  if (f.valueHelp) flags.push("F4")
  if (f.maxLength !== undefined && f.kind === "input") flags.push(`max ${f.maxLength}`)
  if (f.repaired) flags.push("text repaired")
  const flagText = flags.length ? `  [${flags.join(", ")}]` : ""
  const label = f.label ? q(plainText(f.label)) : ""
  const words = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ")
  switch (f.kind) {
    case "input":
      if (f.password) return words(f.ref, "password", label, name, f.editable === false ? "read-only" : undefined) + pos
      return `${words(f.ref, f.editable === false ? "read-only" : "input", label, name)} = ${q(f.text ?? "")}${flagText}${pos}`
    case "output":
      return `${words(f.ref, "text", label ? label + " =" : undefined, q(f.text ?? ""), name)}${pos}`
    case "label":
      return `${f.ref} label ${q(plainText(f.text))}${pos}`
    case "checkbox":
      return words(f.ref, `checkbox [${f.checked ? "x" : " "}]`, q(plainText(f.text) || plainText(f.label)), name, f.editable === false ? "read-only" : undefined) + pos
    case "radio":
      return words(f.ref, `radio (${f.checked ? "•" : " "})`, q(plainText(f.text) || plainText(f.label)), f.group ? `group ${f.group}` : undefined, name) + pos
    case "dropdown": {
      const current = f.options?.find(o => o.key === f.text)
      const options = f.options?.length ? `  options: ${f.options.map(o => `${o.key}=${q(o.text)}`).join(", ")}` : ""
      return `${words(f.ref, "dropdown", label, name)} = ${q(current ? `${current.key} ${current.text}` : f.text ?? "")}${options}${pos}`
    }
    case "button": {
      const fn = f.functionRef ? functions.get(f.functionRef) : undefined
      const text = plainText(f.text) || plainText(fn?.text) || plainText(fn?.tooltip) || "(icon)"
      return `${f.ref} button ${q(text)}${f.functionRef ? ` → ${f.functionRef}` : ""}${fn && !fn.enabled ? " (disabled)" : ""}${pos}`
    }
    case "frame":
      return `-- ${plainText(f.text) || "frame"} --`
    case "tab":
      return `${f.ref} tab ${q(plainText(f.text))}${f.functionRef ? ` → ${f.functionRef}` : ""}`
    case "other":
      return `${f.ref} (unsupported element ${q(plainText(f.text))})${pos}`
  }
}

/** Fields shown outside tables; labels already named as an input's label are left out in compact mode. */
function formatFields(screen: AgentScreen, full: boolean): string[] {
  const functions = new Map(screen.functions.map(f => [f.ref, f]))
  const fields = screen.fields.filter(f => !f.table && f.kind !== "tab")
  const usedLabels = new Set(fields.filter(f => f.label).map(f => plainText(f.label)))
  const lines: string[] = []
  for (const f of fields) {
    if (!full && f.kind === "label" && usedLabels.has(plainText(f.text))) continue
    if (!full && f.kind === "label" && !plainText(f.text)) continue
    lines.push("  " + describeField(f, functions, full))
  }
  return lines.length ? ["fields:", ...lines] : []
}

function formatTable(t: AgentTable): string[] {
  const range = t.rows.length ? `rows ${t.rows[0].row}-${t.rows[t.rows.length - 1].row}` : "no rows"
  const total = t.totalRows !== undefined ? ` of ${t.totalRows}` : ""
  const lines = [`table ${t.ref}${t.name ? ` ${t.name}` : ""}: ${range}${total}${t.selectable ? ", rows can be marked" : ""}${t.totalRows !== undefined && t.totalRows > t.rows.length ? ` (gui_table ${t.ref} reads more)` : ""}`]
  const header = t.columns.map((c, i) => {
    const title = plainText(c.title) || c.name || `col${i}`
    return `${title}${c.name && c.name !== title ? ` (${c.name})` : ""}${c.key ? "*" : ""}`
  })
  lines.push(`  | row |${t.selectable ? " mark |" : ""} ${header.join(" | ")} |`)
  for (const r of t.rows) {
    const cells = t.columns.map((_c, i) => {
      const ref = r.cellRefs[i]
      const text = r.cells[i] ?? ""
      return ref ? `${text}{${ref}}` : text
    })
    lines.push(`  | ${r.row} |${t.selectable ? ` ${r.selected ? "[x]" : "[ ]"} |` : ""} ${cells.join(" | ")} |`)
  }
  return lines
}

function formatTree(nodes: AgentTreeNode[], max: number): string[] {
  const lines = nodes.slice(0, max).map(n => {
    const marker = n.hasChildren ? (n.expanded ? "[-]" : "[+]") : "   "
    const texts = (n.items ?? []).map(plainText).filter(Boolean)
    const items = texts.length ? `  | ${texts.join(" | ")}` : ""
    return `  ${"  ".repeat(n.depth)}${marker} ${plainText(n.text)}  {${n.key}}${n.selected ? " (selected)" : ""}${items}`
  })
  if (nodes.length > max) lines.push(`  … ${nodes.length - max} more nodes (gui_tree read)`)
  return lines
}

function formatControl(c: AgentControl, options: Required<SnapshotOptions>): string[] {
  if (c.kind === "tree" && c.tree) return [`tree ${c.ref}${c.area ? ` in ${c.area}` : ""}: ${c.tree.nodes.length} nodes loaded`, ...formatTree(c.tree.nodes, options.maxTreeNodes)]
  if (c.kind === "grid" && c.grid) {
    const g = c.grid
    const header = g.columns.map(col => `${plainText(col.title) || col.name}${col.name && col.name !== plainText(col.title) ? ` (${col.name})` : ""}`)
    const lines = [`grid ${c.ref}${c.area ? ` in ${c.area}` : ""}: ${g.rows.length}${g.totalRows !== undefined ? ` of ${g.totalRows}` : ""} rows`, `  | row | ${header.join(" | ")} |`]
    g.rows.slice(0, options.maxGridRows).forEach((r, i) => lines.push(`  | ${i + 1} | ${r.join(" | ")} |`))
    if (g.rows.length > options.maxGridRows) lines.push(`  … ${g.rows.length - options.maxGridRows} more rows (gui_grid read)`)
    return lines
  }
  if (c.kind === "splitter" || c.kind === "container") return []
  return [`control ${c.ref}: ${c.className ?? "unsupported control"} (not readable yet)`]
}

/** The screen as text for the model. */
export function formatScreen(screen: AgentScreen, opts: SnapshotOptions = {}): string {
  const options: Required<SnapshotOptions> = { detail: "compact", maxListLines: 80, maxTreeNodes: 80, maxGridRows: 40, ...opts }
  const full = options.detail === "full"
  const lines: string[] = []
  const identity = [screen.transaction, [screen.program, screen.screenNumber].filter(Boolean).join(" ")].filter(Boolean).join(" · ")
  lines.push(`${screen.session} · ${screen.system}${identity ? ` · ${identity}` : ""}${screen.popup ? " · popup" : ""}`)
  if (screen.popup) {
    const under = screen.under ? ` over ${[screen.under.program, screen.under.screenNumber].filter(Boolean).join(" ")}${screen.under.title ? ` ${q(screen.under.title)}` : ""}` : ""
    lines.push(`popup: ${q(plainText(screen.popup.title) || screen.title || "")}${under}`)
  } else if (screen.title) lines.push(`title: ${q(plainText(screen.title))}`)
  if (screen.serverError) lines.push(`server error: ${screen.serverError}`)
  if (screen.message) {
    const id = screen.message.id ? ` (${screen.message.id}${screen.message.number ? ` ${screen.message.number}` : ""})` : ""
    lines.push(`message: ${screen.message.type} ${screen.message.text}${id}`)
  }
  if (screen.logonScreen) lines.push("note: this is the logon screen; gui_connect logs on with the stored credential")
  lines.push(...formatFunctions(screen, full))
  if (screen.tabs.length)
    lines.push(`tabs: ${screen.tabs.map(t => `${t.ref} ${q(plainText(t.text))}${t.active ? " (active)" : ""}${t.functionRef ? ` → ${t.functionRef}` : ""}`).join(" · ")}`)
  lines.push(...formatFields(screen, full))
  for (const t of screen.tables) lines.push(...formatTable(t))
  if (screen.list) {
    const l = screen.list
    const total = l.totalLines !== undefined ? ` of ${l.totalLines}` : ""
    lines.push(`list: lines ${l.firstLine}-${l.firstLine + l.lines.length - 1}${total}`)
    l.lines.slice(0, options.maxListLines).forEach((text, i) => lines.push(`  ${String(l.firstLine + i).padStart(4)}| ${text}`))
    if (l.lines.length > options.maxListLines) lines.push(`  … ${l.lines.length - options.maxListLines} more lines (gui_table list reads them)`)
    if (l.hotspots?.length) lines.push(`  hotspots: ${l.hotspots.slice(0, 20).map(h => `${h.line},${h.column} ${q(h.text)}`).join(" · ")}`)
  }
  for (const c of screen.controls) lines.push(...formatControl(c, options))
  if (screen.cursor) lines.push(`cursor: ${screen.cursor}`)
  for (const n of screen.notices) lines.push(`notice: ${n}`)
  return lines.join("\n")
}

/** One line saying what a step changed, for the top of a step's result. */
export function describeChange(before: AgentScreen | undefined, after: AgentScreen): string {
  const parts: string[] = []
  const where = (s: AgentScreen) => [s.program, s.screenNumber].filter(Boolean).join(" ")
  if (!before) parts.push(`screen ${where(after)}`)
  else {
    if (before.transaction !== after.transaction && after.transaction) parts.push(`transaction ${after.transaction}`)
    if (!before.popup && after.popup) parts.push(`popup opened ${q(plainText(after.popup.title) || after.title || "")}`)
    else if (before.popup && !after.popup) parts.push("popup closed")
    if (where(before) !== where(after)) parts.push(`new screen ${where(after)}`)
    else if (!parts.length) parts.push("same screen")
  }
  if (after.message) parts.push(`message ${after.message.type}: ${after.message.text}`)
  if (after.serverError) parts.push(`server error: ${after.serverError}`)
  return parts.join("; ")
}
