// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ControlScene.swift (MIT).

// The control scene (docs/protocol/controls/scene.md): the shells the server's flush calls
// created on this connection, read call by call from their verbs (DiagCodec.ControlCall).
//
// Swift's `extension String` of this file (`replacingMinusSuffix`) is the free function
// `replacingMinusSuffix(text)` at the end.

import { parseInteger, type ControlCall, type ControlCallInvocation, type DataObject } from "../codec/index.js"
import { ControlShell, swiftCount, type ControlShellCell, type GridModel, type SplitterLayout, type TreeModel } from "./controlModels.js"

/** What a record of one call stands for while the call is read (Swift `ControlScene.Meaning`). */
type Meaning =
  | { readonly kind: "shell"; readonly value: number }
  | { readonly kind: "splitterCell"; readonly shell: number; readonly row: number; readonly column: number }
  | { readonly kind: "provider"; readonly value: number }
  | { readonly kind: "onDemand"; readonly value: number }

/** A data provider of one call. */
interface Provider {
  url: string | undefined
}

/**
 * An on-demand data object of one call: the packets inserted into it, and the grid it became
 * the data table of.
 */
interface OnDemand {
  packets: DataObject[]
  grid: number | undefined
}

/** The models a shell's content holds, by kind. */
interface Models {
  splitter: SplitterLayout
  tree: TreeModel
  grid: GridModel
}

/**
 * The shells of a connection's mode, built from its flush calls.
 *
 * A Swift struct: `clone()` copies it. `apply` never changes a shell object it did not make during
 * the same call (it puts a changed copy in the shell's place), so a shell or a model read from the
 * scene, and a clone of the scene, stay as they were.
 */
export class ControlScene {
  /** The most shells kept; the oldest go first. */
  static readonly maxShells = 64 // not-protocol: a memory cap

  /** The shells by id, in the order of their creation. (Swift `public internal(set)`.) */
  shells = new Map<number, ControlShell>()
  private _calls = 0
  /**
   * The shell each handle Swooey's answers returned for a shell's creation names, by the
   * handle's number: a later call may name the shell by it (Reading R-SC-8, issue #167).
   */
  private shellsByHandle = new Map<number, number>()

  /** Calls applied so far. */
  get calls(): number {
    return this._calls
  }

  /** A copy of the scene; the shells are shared until either scene changes one. */
  clone(): ControlScene {
    const copy = new ControlScene()
    copy.shells = new Map(this.shells)
    copy._calls = this._calls
    copy.shellsByHandle = new Map(this.shellsByHandle)
    return copy
  }

  /**
   * The shell a custom container named `name` links to (Swift `shell(linkedTo:)`): the latest
   * created; of shells created by the same call, the first in `shells`.
   */
  shellLinkedTo(name: string): ControlShell | undefined {
    return latest(Array.from(this.shells.values()).filter(shell => shell.containerName === name))
  }

  /** The shell docked to `program` (Swift `shell(dockedTo:)`). */
  shellDockedTo(program: string): ControlShell | undefined {
    return latest(Array.from(this.shells.values()).filter(shell => shell.dockedProgram === program))
  }

  /** The children of shell `id`, by creation (Swift `children(of:)`). */
  children(id: number): ControlShell[] {
    return Array.from(this.shells.values())
      .filter(shell => shell.parent === id)
      .sort((a, b) => a.created - b.created)
  }

  /** The child in splitter `id`'s cell (Swift `child(of:in:)`). */
  child(id: number, cell: ControlShellCell): ControlShell | undefined {
    return this.children(id).find(shell => shell.cell !== undefined && shell.cell.row === cell.row && shell.cell.column === cell.column)
  }

  /** The shell whose creation Swooey's answer returned the handle numbered `handle` for (Swift `shell(handle:)`). */
  shellByHandle(handle: number): ControlShell | undefined {
    const id = this.shellsByHandle.get(handle)
    return id === undefined ? undefined : this.shells.get(id)
  }

  /**
   * Applies one call's verbs (Readings R-SC-1 to R-SC-8). `handles` holds the number of the
   * handle Swooey's answer to the call returned for a verb, by the verb's number
   * (`FlushAnswerSummary.handlesByVerb`).
   */
  apply(call: ControlCall, handles: ReadonlyMap<number, number> = new Map()): void {
    this._calls += 1
    const calls = this._calls
    // Value semantics: the map, and each shell the call changes, are copied first.
    this.shells = new Map(this.shells)
    const owned = new Set<number>()
    /** Shell `id` to change: a copy the first time this call changes it. */
    const writable = (id: number | undefined): ControlShell | undefined => {
      if (id === undefined) return undefined
      const shell = this.shells.get(id)
      if (shell === undefined || owned.has(id)) return shell
      const copy = shell.clone()
      this.shells.set(id, copy)
      owned.add(id)
      return copy
    }
    /** Whether shell `id`'s content is of `kind`. */
    const holds = (id: number | undefined, kind: keyof Models): boolean => id !== undefined && this.shells.get(id)?.content.kind === kind
    /**
     * The model of shell `id` to change, when its content is of `kind` (Swift's
     * `case .tree(var tree)? = shells[id]?.content` … `shells[id]?.content = .tree(tree)`).
     */
    const model = <K extends keyof Models>(id: number | undefined, kind: K): Models[K] | undefined => {
      if (!holds(id, kind)) return undefined
      const content = writable(id)!.content
      return "value" in content ? (content.value as Models[K]) : undefined
    }

    const meanings = new Map<number, Meaning>()
    const providers: Provider[] = []
    const onDemands: OnDemand[] = []
    let latestTree: number | undefined
    let latestGrid: number | undefined

    const text = (n: number, invocation: ControlCallInvocation): string => call.argument(n, invocation) ?? ""
    const number = (n: number, invocation: ControlCallInvocation): number | undefined => parseInteger(text(n, invocation))
    const meaning = (n: number, invocation: ControlCallInvocation): Meaning | undefined => {
      const argument = invocation.argument(n)
      return argument === undefined ? undefined : meanings.get(argument.record)
    }
    const dataObject = (meaning: Meaning | undefined): DataObject | undefined => {
      if (meaning?.kind !== "provider") return undefined
      const url = providers[meaning.value].url
      return url === undefined ? undefined : call.dataObject(url)
    }
    const targetShell = (invocation: ControlCallInvocation): number | undefined => {
      const target = meanings.get(invocation.target)
      return target?.kind === "shell" ? target.value : undefined
    }
    // A shell argument: the result record of a creation in this call, or the number or the
    // handle Swooey's answer returned for a creation in an earlier call (`38` or `O38`, issue #167).
    const shellArgument = (n: number, invocation: ControlCallInvocation): number | undefined => {
      const argument = meaning(n, invocation)
      if (argument !== undefined) return argument.kind === "shell" ? argument.value : undefined
      const value = text(n, invocation)
      const digits = value.startsWith("O") ? value.slice(1) : value // provenance: PV-0939
      const handle = parseInteger(digits)
      return handle === undefined ? undefined : this.shellByHandle(handle)?.id
    }

    for (const invocation of call.invocations) {
      switch (invocation.name) {
        case "CreateObject": {
          const className = text(1, invocation)
          const result = invocation.result
          if (result === undefined) break
          if (className.includes("DataProvider")) {
            // provenance: PV-1009
            providers.push({ url: undefined })
            meanings.set(result, { kind: "provider", value: providers.length - 1 })
          } else if (className.includes("OnDemand")) {
            // provenance: PV-1009
            onDemands.push({ packets: [], grid: undefined })
            meanings.set(result, { kind: "onDemand", value: onDemands.length - 1 })
          }
          break
        }
        case "CreateControl":
        case "CreateControl2": {
          const id = number(1, invocation)
          if (id === undefined) break
          const shell = new ControlShell({ id, className: text(2, invocation), content: ControlShell.contentForClass(text(2, invocation)), created: calls })
          const cell = meaning(4, invocation)
          const parent = number(4, invocation)
          if (cell?.kind === "splitterCell") {
            shell.parent = cell.shell
            shell.cell = { row: cell.row, column: cell.column }
          } else if (parent !== undefined && this.shells.has(parent)) {
            shell.parent = parent
          }
          // Deleted first, so that the map's order is the order of creation.
          this.shells.delete(id)
          this.shells.set(id, shell)
          owned.add(id)
          // A handle of a shell this id named before names no shell any more.
          this.shellsByHandle = new Map(Array.from(this.shellsByHandle).filter(([, named]) => named !== id))
          const handle = handles.get(invocation.index)
          if (handle !== undefined) this.shellsByHandle.set(handle, id)
          if (invocation.result !== undefined) meanings.set(invocation.result, { kind: "shell", value: id })
          if (shell.content.kind === "tree") latestTree = id
          if (shell.content.kind === "grid") latestGrid = id
          this.evict()
          break
        }
        case "LinkContainer": {
          const shell = writable(number(1, invocation))
          if (shell !== undefined) shell.containerName = text(2, invocation)
          break
        }
        case "LinkControl": {
          const shell = writable(number(1, invocation))
          if (shell !== undefined) shell.dockedProgram = text(2, invocation)
          break
        }
        case "SetGrid": {
          const layout = model(targetShell(invocation), "splitter")
          if (layout === undefined) break
          layout.rows = Math.max(number(1, invocation) ?? 1, 1)
          layout.columns = Math.max(number(2, invocation) ?? 1, 1)
          break
        }
        case "GetContainer": {
          const id = targetShell(invocation)
          const result = invocation.result
          if (id !== undefined && result !== undefined) {
            meanings.set(result, { kind: "splitterCell", shell: id, row: number(1, invocation) ?? 1, column: number(2, invocation) ?? 1 })
          }
          break
        }
        case "AddControl": {
          const id = targetShell(invocation)
          if (id === undefined) break
          const child = writable(shellArgument(3, invocation))
          if (child === undefined) break
          child.parent = id
          child.cell = { row: number(1, invocation) ?? 1, column: number(2, invocation) ?? 1 }
          break
        }
        case "SetColumnWidth":
        case "SetRowHeight": {
          const index = number(1, invocation)
          if (index === undefined) break
          const layout = model(targetShell(invocation), "splitter")
          if (layout === undefined) break
          const size = parseInteger(replacingMinusSuffix(text(2, invocation))) ?? 0
          if (invocation.name === "SetColumnWidth") layout.columnWidths.set(index, size)
          else layout.rowHeights.set(index, size)
          break
        }
        case "SetDataFromUrl": {
          const target = meanings.get(invocation.target)
          if (target?.kind === "provider") providers[target.value].url = text(3, invocation)
          break
        }
        case "GetDataAsFormat":
        case "data": {
          const result = invocation.result
          const source = meanings.get(invocation.target)
          if (result !== undefined && source !== undefined) meanings.set(result, source)
          break
        }
        case "Handle":
          break
        case "InsertPacket": {
          const target = meanings.get(invocation.target)
          if (target?.kind !== "onDemand") break
          const table = dataObject(meaning(2, invocation))
          if (table === undefined) break
          const onDemand = onDemands[target.value]
          onDemand.packets.push(table)
          // The rows may come after the object became the grid's data table (issue #166).
          model(onDemand.grid, "grid")?.addPacket(table)
          break
        }
        case "GetTable": {
          const result = invocation.result
          const source = meanings.get(invocation.target)
          if (result !== undefined && source !== undefined) meanings.set(result, source)
          break
        }
        case "AddR3Table":
        case "AddItemTable": {
          const id = targetShell(invocation) ?? latestTree
          const table = dataObject(meaning(1, invocation))
          if (table === undefined) break
          const tree = model(id, "tree")
          if (tree === undefined) break
          if (invocation.name === "AddR3Table") tree.addNodes(table)
          else tree.addItems(table)
          break
        }
        case "ABAPExpandNodes":
          model(targetShell(invocation) ?? latestTree, "tree")?.expanded.add(text(1, invocation))
          break
        case "ListDisplay": {
          const tree = model(targetShell(invocation) ?? latestTree, "tree")
          if (tree !== undefined) tree.listDisplay = text(1, invocation) === "1"
          break
        }
        case "RegisterOcxEvent":
        case "RegisterEvent": {
          // provenance: PV-1014
          const id = number(1, invocation)
          const event = number(2, invocation)
          if (id !== undefined && event !== undefined) writable(id)?.events.add(event)
          break
        }
        case "RegisterCachedProp": {
          // provenance: PV-1014
          const name = text(2, invocation)
          const id = number(1, invocation)
          if (id === undefined || name.length === 0 || this.shells.get(id)?.cachedProperties.includes(name) !== false) break
          writable(id)!.cachedProperties.push(name)
          break
        }
        case "Title": {
          const grid = model(targetShell(invocation) ?? latestGrid, "grid")
          if (grid !== undefined) grid.title = text(1, invocation)
          break
        }
        case "AssignProperty2": {
          const property = text(4, invocation)
          const target = shellArgument(3, invocation)
          switch (property) {
            case "InfoTable": {
              // provenance: PV-1010
              const table = dataObject(meaning(1, invocation))
              if (table === undefined) break
              model(target ?? latestGrid, "grid")?.setCatalog(table)
              break
            }
            case "DataTableOnDemand": {
              // provenance: PV-1010
              const id = target ?? latestGrid
              const source = meaning(1, invocation)
              if (source?.kind !== "onDemand") break
              const grid = model(id, "grid")
              if (grid === undefined) break
              // The object replaces the grid's data table, rows of an earlier one included.
              grid.clearCells()
              for (const packet of onDemands[source.value].packets) grid.addPacket(packet)
              onDemands[source.value].grid = id
              break
            }
            case "ExpandedKeys": {
              // provenance: PV-1010
              const table = dataObject(meaning(1, invocation))
              if (table === undefined) break
              model(target ?? latestTree, "tree")?.setExpanded(table)
              break
            }
            default:
              break
          }
          break
        }
        default:
          break
      }
    }
  }

  /**
   * The scene in structure, for the session report: shell ids, classes by kind, parents, links
   * by length, the size of each tree and grid, and the handle Swooey returned for a shell's
   * creation. No node text, no cell, no container name.
   */
  get summary(): string {
    const handleOf = new Map<number, number>()
    for (const [handle, id] of this.shellsByHandle) if (!handleOf.has(id)) handleOf.set(id, handle)
    const shells = Array.from(this.shells.values())
      .sort((a, b) => a.id - b.id)
      .map(shell => {
        let text = `${shell.id}`
        const content = shell.content
        switch (content.kind) {
          case "container":
            text += " container"
            break
          case "splitter":
            text += ` splitter ${content.value.rows}x${content.value.columns}`
            break
          case "tree":
            text += ` tree, ${content.value.nodes.length} node(s), ${content.value.expanded.size} expanded`
            break
          case "grid":
            text += ` grid, ${content.value.columns.length} column(s), ${content.value.rowNumbers.length} row(s)`
            break
          case "image":
            text += " image"
            break
          case "other":
            text += ` other class (${swiftCount(shell.className)} chars)`
            break
        }
        if (shell.parent !== undefined) text += ` in ${shell.parent}`
        if (shell.cell !== undefined) text += ` cell ${shell.cell.row},${shell.cell.column}`
        if (shell.containerName !== undefined) text += `, linked to a container name of ${swiftCount(shell.containerName)} chars`
        if (shell.dockedProgram !== undefined) text += `, docked to a program of ${swiftCount(shell.dockedProgram)} chars`
        const handle = handleOf.get(shell.id)
        if (handle !== undefined) text += `, handle O${handle}`
        return text
      })
    return `control scene after ${this._calls} call(s): ${shells.length === 0 ? "no shells" : shells.join("; ")}`
  }

  /** Drops the oldest shells past `maxShells`. */
  private evict(): void {
    if (!(this.shells.size > ControlScene.maxShells)) return
    const oldest = Array.from(this.shells.values())
      .sort((a, b) => a.created - b.created)
      .slice(0, this.shells.size - ControlScene.maxShells)
    for (const shell of oldest) this.shells.delete(shell.id)
    this.shellsByHandle = new Map(Array.from(this.shellsByHandle).filter(([, id]) => this.shells.has(id)))
  }
}

/** Swift's `max { $0.created < $1.created }`: the first of the latest created, or undefined when there is none. */
function latest(shells: readonly ControlShell[]): ControlShell | undefined {
  let result: ControlShell | undefined
  for (const shell of shells) if (result === undefined || result.created < shell.created) result = shell
  return result
}

/**
 * A number the server writes with a trailing minus (`1-`) as a leading one. (Swift: this file's
 * `extension String`, `text.replacingMinusSuffix`.)
 */
export function replacingMinusSuffix(text: string): string {
  return text.endsWith("-") ? "-" + text.slice(0, -1) : text
}
