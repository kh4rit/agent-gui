// SPDX-License-Identifier: MIT
// From ScreenModel's Screen and the mode's control scene to the AgentScreen the model reads, with
// an index from the references it shows (f…, k…, t…, c…) back to what they name. The mapping
// follows what Swooey's app shows (SwooeyApp ScreenBridge.display / element, ScreenCanvas).

import type { ScreenElementID } from "../diag/screen/index.js"
import {
  ScreenLogon,
  type ControlScene,
  type ControlShell,
  type GridModel,
  type Screen,
  type ScreenElement,
  type ScreenFunction,
  type ScreenList,
  type ScreenMessageType,
  type ScreenTable,
  type TreeModel
} from "../diag/screen/index.js"
import type {
  AgentControl,
  AgentField,
  AgentFieldKind,
  AgentFunction,
  AgentList,
  AgentScreen,
  AgentTab,
  AgentTable,
  AgentTreeNode,
  MessageType
} from "./agentScreen.js"
import { keyLabel } from "./keys.js"

/** What the references of one AgentScreen stand for. */
export interface RefIndex {
  /** f-ref → element. */
  fields: Map<string, ScreenElementID>
  /** element map key → f-ref. */
  byElement: Map<string, string>
  /** k-ref → function. */
  functions: Map<string, ScreenFunction>
  /** t-ref → table. */
  tables: Map<string, ScreenTable>
  /** c-ref → shell id. */
  controls: Map<string, number>
  /** The list's display line → (server row, first body line). */
  listRows: Map<number, number>
}

export interface AgentView {
  screen: AgentScreen
  index: RefIndex
}

function messageType(type: ScreenMessageType): MessageType | undefined {
  switch (type.kind) {
    case "success":
      return "S"
    case "information":
      return "I"
    case "warning":
      return "W"
    case "error":
      return "E"
    case "abort":
      return "A"
    case "exit":
      return "X"
    default:
      return undefined
  }
}

function fieldKind(element: ScreenElement): AgentFieldKind {
  switch (element.kind.kind) {
    case "label":
      return "label"
    case "input":
      return element.isEditable || element.isPassword ? "input" : "output"
    case "output":
      return "output"
    case "frame":
      return "frame"
    case "tab":
      return "tab"
    case "button":
      return "button"
    case "checkbox":
      return "checkbox"
    case "radioButton":
      return "radio"
    case "dropdown":
      return "dropdown"
    default:
      return "other"
  }
}

/** The text an element shows: a label's caption, a field's value (the server's `?` in an empty required field is no text, R-EL-16a). */
function shownText(element: ScreenElement): string | undefined {
  if (element.isPassword) return undefined
  if (element.holdsRequiredMarker) return ""
  const kind = element.kind.kind
  if (kind === "label" || kind === "frame" || kind === "button" || kind === "tab" || kind === "checkbox" || kind === "radioButton")
    return (element.caption ?? element.text ?? "").trim()
  return (element.text ?? "").replace(/\s+$/, "")
}

/** A list line as text: its segments at their columns. */
function listLineText(line: { segments: readonly { column: number; text: string }[] }): string {
  let out = ""
  for (const segment of line.segments) {
    if (out.length < segment.column) out = out.padEnd(segment.column, " ")
    out += segment.text
  }
  return out.replace(/\s+$/, "")
}

function buildList(list: ScreenList, index: RefIndex): AgentList {
  const lines: string[] = []
  const hotspots: { line: number; column: number; text: string }[] = []
  const first = list.scroll.firstLine
  list.lines.forEach((line, i) => {
    const number = first + i
    lines.push(listLineText(line))
    index.listRows.set(number, line.row)
    for (const segment of line.segments)
      if (segment.isHotspot && segment.text.trim()) hotspots.push({ line: number, column: segment.column, text: segment.text.trim() })
  })
  return {
    header: list.headerLines.map(listLineText),
    lines,
    firstLine: first,
    totalLines: list.scroll.totalLines,
    hotspots: hotspots.length ? hotspots : undefined
  }
}

function treeNodes(tree: TreeModel): AgentTreeNode[] {
  const out: AgentTreeNode[] = []
  const keys = new Set(tree.nodes.map(n => n.id))
  const seen = new Set<string>()
  const walk = (parentKey: string, depth: number) => {
    for (const node of tree.children(parentKey)) {
      if (node.isHidden || seen.has(node.id)) continue
      seen.add(node.id)
      const hasChildren = tree.hasChildren(node.id) || node.isFolder || node.forcesExpander
      out.push({ key: node.id, text: node.text, depth, hasChildren, expanded: hasChildren ? tree.expanded.has(node.id) || tree.hasChildren(node.id) : undefined })
      walk(node.id, depth + 1)
    }
  }
  // Roots: nodes whose parent is not a node of the tree.
  const roots = new Set(tree.nodes.filter(n => !keys.has(n.parentKey)).map(n => n.parentKey))
  for (const root of roots) walk(root, 0)
  return out
}

function gridView(grid: GridModel): AgentControl["grid"] {
  const columns = grid.columns.slice().sort((a, b) => a.position - b.position)
  return {
    columns: columns.map(c => ({ name: c.id, title: c.header })),
    rows: grid.rowNumbers.map(row => columns.map(c => grid.text(row, c.position).replace(/\s+$/, ""))),
    totalRows: undefined
  }
}

function controlView(ref: string, shell: ControlShell, area: string | undefined): AgentControl {
  const content = shell.content
  if (content.kind === "tree") return { ref, kind: "tree", area, tree: { nodes: treeNodes(content.value) } }
  if (content.kind === "grid") return { ref, kind: "grid", area, grid: gridView(content.value) }
  if (content.kind === "splitter") return { ref, kind: "splitter", area }
  if (content.kind === "container") return { ref, kind: "container", area }
  return { ref, kind: "other", area, className: shell.className }
}

/** The shells the screen shows: those linked to its control areas or docked to its program, and their children. */
function visibleShells(screen: Screen, scene: ControlScene): { shell: ControlShell; area?: string }[] {
  const out: { shell: ControlShell; area?: string }[] = []
  const added = new Set<number>()
  const add = (shell: ControlShell | undefined, area: string | undefined) => {
    if (!shell || added.has(shell.id)) return
    added.add(shell.id)
    out.push({ shell, area })
    for (const child of scene.children(shell.id)) add(child, area)
  }
  for (const container of screen.containers) if (container.kind === "control" && container.name) add(scene.shellLinkedTo(container.name), container.name)
  if (screen.identity.program) add(scene.shellDockedTo(screen.identity.program), "docked")
  if (out.length === 0)
    for (const shell of scene.shells.values()) if (shell.content.kind === "tree" || shell.content.kind === "grid") add(shell, undefined)
  return out
}

/** The decode notice Swooey's status bar shows (ScreenBridge.decodeNotice), counts only. */
function decodeNotices(screen: Screen): string[] {
  const d = screen.diagnostics
  const parts: string[] = []
  if (d.itemWalkStop !== undefined) parts.push("the end of the screen was not understood")
  if (d.stoppedAtomWalks > 0) parts.push(`${d.stoppedAtomWalks} group(s) of elements cut short`)
  if (d.atomsWithoutContainer > 0) parts.push(`${d.atomsWithoutContainer} element(s) in an area the screen did not declare`)
  if (d.guessedTexts > 0) parts.push(`code page ${screen.codePage} is unknown, so ${d.guessedTexts} text(s) are read as ISO 8859-1`)
  if (d.repairedTexts > 0) parts.push(`${d.repairedTexts} text(s) had bytes that are not ${screen.textEncoding}`)
  return parts.length ? [`screen read in part: ${parts.join("; ")}`] : []
}

/** Builds the agent's view of `screen`. */
export function buildAgentView(screen: Screen, scene: ControlScene, system: string, session: string, serverError?: string): AgentView {
  const index: RefIndex = {
    fields: new Map(),
    byElement: new Map(),
    functions: new Map(),
    tables: new Map(),
    controls: new Map(),
    listRows: new Map()
  }

  // Functions.
  const functions: AgentFunction[] = []
  const functionRefByButton = new Map<string, string>()
  screen.functions.forEach((f, i) => {
    const ref = `k${i + 1}`
    index.functions.set(ref, f)
    let where: AgentFunction["where"]
    switch (f.kind.kind) {
      case "standardToolbar":
        where = "standard"
        break
      case "applicationToolbar":
        where = "toolbar"
        break
      case "menu":
        where = f.kind.path.length === 0 ? "keys" : "menu"
        break
      case "pushButton":
        where = "button"
        functionRefByButton.set(f.kind.value.mapKey, ref)
        break
    }
    functions.push({
      ref,
      code: f.code,
      text: f.text?.trim() || undefined,
      key: keyLabel(f.virtualKey),
      virtualKey: f.virtualKey,
      where,
      menuPath: f.kind.kind === "menu" && f.kind.path.length ? [...f.kind.path] : undefined,
      enabled: f.isEnabled && f.canFire,
      tooltip: f.tooltip?.trim() || undefined
    })
  })

  // Tables first, so that cells know their table reference.
  const tableRefById = new Map<number, string>()
  screen.tables.forEach((t, i) => {
    const ref = `t${i + 1}`
    tableRefById.set(t.id, ref)
    index.tables.set(ref, t)
  })

  // Elements. Row selectors of table controls are the table's marks, not fields.
  const selectors = new Set<string>()
  for (const t of screen.tables) for (const r of t.rows) if (r.selector) selectors.add(r.selector.mapKey)
  const fields: AgentField[] = []
  screen.elements.forEach((element, i) => {
    const ref = `f${i + 1}`
    index.fields.set(ref, element.id)
    index.byElement.set(element.id.mapKey, ref)
    if (selectors.has(element.id.mapKey)) return
    const kind = fieldKind(element)
    const field: AgentField = {
      ref,
      kind,
      text: shownText(element),
      name: element.fieldName?.trim() || undefined,
      row: element.placement.row,
      column: element.placement.column,
      width: element.visibleWidth
    }
    if (kind === "input" || kind === "output") {
      field.maxLength = element.maxLength
      field.editable = element.isEditable
      field.password = element.isPassword || undefined
      field.required = element.isRequired || undefined
      field.valueHelp = element.hasValueHelp || undefined
    }
    if (kind === "checkbox" || kind === "radio") {
      field.checked = element.isChecked ?? false
      field.editable = !element.isProtected && !element.isDisabled
    }
    if (kind === "radio" && element.radioGroup) field.group = `g${element.radioGroup.key}`
    if (kind === "dropdown" && element.dropdown) {
      field.options = element.dropdown.options.map(o => ({ key: o.key, text: o.text }))
      field.text = element.dropdown.selectedOption?.key ?? field.text
      field.editable = !element.isProtected
    }
    if (element.table) {
      const tableRef = tableRefById.get(element.table.table)
      if (tableRef) field.table = { ref: tableRef, row: element.table.line, column: element.table.column }
    }
    if (kind === "button" || kind === "tab") field.functionRef = functionRefByButton.get(element.id.mapKey)
    if (element.isHighlighted) field.highlighted = true
    fields.push(field)
  })

  // Labels for fields: the label left of the field on the same row and area, or the table column title.
  const labels = fields.filter(f => f.kind === "label")
  for (const f of fields) {
    if (f.kind !== "input" && f.kind !== "output" && f.kind !== "dropdown" && f.kind !== "checkbox") continue
    if (f.table) {
      const table = index.tables.get(f.table.ref)
      const column = table?.columns[f.table.column]
      if (column?.title) f.label = column.title.trim()
      continue
    }
    if (f.kind === "checkbox" && f.text) continue
    let best: AgentField | undefined
    for (const l of labels) {
      if (l === f || l.row !== f.row || l.column >= f.column || !l.text) continue
      if (!best || l.column > best.column) best = l
    }
    if (best && !fields.some(o => o !== f && o.row === f.row && o.kind === "input" && o.column > best!.column && o.column < f.column))
      f.label = best.text
  }

  // Tables.
  const tables: AgentTable[] = screen.tables.map(t => {
    const ref = tableRefById.get(t.id)!
    const elementById = new Map(screen.elements.map(e => [e.id.mapKey, e]))
    return {
      ref,
      name: t.name?.trim() || undefined,
      columns: t.columns.map(c => ({ title: c.title?.trim() || undefined, name: c.fieldName?.trim() || undefined, key: c.isKey || undefined, width: c.width })),
      rows: t.rows.map(r => ({
        row: r.line,
        selected: t.selection.mode === "multiple" ? r.isSelected : undefined,
        cells: r.cells.map(id => {
          if (!id) return undefined
          const e = elementById.get(id.mapKey)
          if (!e) return undefined
          if (e.kind.kind === "checkbox") return e.isChecked ? "[x]" : "[ ]"
          return shownText(e)
        }),
        cellRefs: r.cells.map(id => (id ? index.byElement.get(id.mapKey) : undefined))
      })),
      firstRow: t.scroll.firstRow,
      visibleRows: t.scroll.visibleRows,
      totalRows: t.scroll.totalRows,
      selectable: t.selection.mode === "multiple"
    }
  })

  // Tabs.
  const tabs: AgentTab[] = []
  for (const strip of screen.tabstrips)
    for (const tab of strip.tabs)
      tabs.push({ ref: index.byElement.get(tab.id.mapKey) ?? tab.id.mapKey, text: tab.caption.trim(), active: tab.isActive, functionRef: functionRefByButton.get(tab.id.mapKey) })

  // Controls.
  const controls: AgentControl[] = []
  for (const { shell, area } of visibleShells(screen, scene)) {
    const ref = `c${shell.id}`
    index.controls.set(ref, shell.id)
    const view = controlView(ref, shell, area)
    if (view.kind !== "container") controls.push(view)
  }

  const popup = screen.presentation.kind === "popup" ? screen.presentation.value : undefined
  const main = popup ? ScreenLogon.mainWindowScreen(screen) : undefined
  const status = screen.statusMessage
  const text = (status?.text ?? screen.message ?? "").trim()
  const type = status ? messageType(status.type) : undefined
  const agentScreen: AgentScreen = {
    system,
    session,
    transaction: screen.identity.transaction?.trim() || undefined,
    program: screen.identity.program?.trim() || undefined,
    screenNumber: screen.identity.screenNumber?.trim() || undefined,
    title: (popup?.title ?? screen.identity.title)?.trim() || undefined,
    popup: popup ? { title: popup.title?.trim() || screen.identity.title?.trim(), level: popup.level } : undefined,
    under: main
      ? { transaction: main.identity.transaction, program: main.identity.program, screenNumber: main.identity.screenNumber, title: main.identity.title }
      : undefined,
    message: text ? { type: type ?? "I", text, id: status?.id?.messageClass?.trim() || undefined, number: status?.id?.number?.trim() || undefined } : undefined,
    functions,
    fields,
    tables,
    list: screen.list ? buildList(screen.list, index) : undefined,
    tabs,
    controls,
    cursor: screen.cursor?.element ? index.byElement.get(screen.cursor.element.mapKey) : undefined,
    logonScreen: screen.isLogonScreen,
    notices: decodeNotices(screen),
    serverError
  }
  return { screen: agentScreen, index }
}
