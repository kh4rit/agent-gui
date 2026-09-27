// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/TreeIndex.swift (MIT).

import type { TreeModel, TreeNode } from "./controlModels.js"

/** One visible row: a node and its depth, and whether a filter matched it (`filteredRows`). (Swift `TreeIndex.Row`.) */
export class TreeIndexRow {
  constructor(
    readonly node: TreeNode,
    readonly depth: number,
    readonly isMatch = false
  ) {}

  get id(): string {
    return this.node.id
  }
}

/**
 * A tree control's nodes indexed by parent, for drawing and navigating large trees (core-uses.md
 * §1.4, §5: expand and collapse within a frame, a local filter over 50,000 loaded nodes). Built
 * once per tree content; every question after that is a lookup.
 */
export class TreeIndex {
  /** A copy of the tree the index was built from (a Swift struct: later changes to it do not reach the index). */
  readonly tree: TreeModel
  /** Visible children by parent key, in node-table order. */
  private readonly childIndices: ReadonlyMap<string, readonly number[]>
  /** Node index by key. */
  private readonly positions: ReadonlyMap<string, number>

  constructor(tree: TreeModel) {
    this.tree = tree.clone()
    const children = new Map<string, number[]>()
    const positions = new Map<string, number>()
    this.tree.nodes.forEach((node, index) => {
      positions.set(node.id, index)
      if (!node.isHidden) {
        const siblings = children.get(node.parentKey)
        if (siblings === undefined) children.set(node.parentKey, [index])
        else siblings.push(index)
      }
    })
    this.childIndices = children
    this.positions = positions
  }

  node(key: string): TreeNode | undefined {
    const position = this.positions.get(key)
    return position === undefined ? undefined : this.tree.nodes[position]
  }

  /** The visible children of `key` (empty: the top level). (Swift `children(of:)`.) */
  children(key: string): TreeNode[] {
    return (this.childIndices.get(key) ?? []).map(index => this.tree.nodes[index])
  }

  hasChildren(key: string): boolean {
    const children = this.childIndices.get(key)
    return children !== undefined && children.length > 0
  }

  /**
   * Whether the node shows an expander: a folder, a node the server marks as having children
   * not loaded yet, or one with loaded children.
   */
  isExpandable(key: string): boolean {
    const node = this.node(key)
    if (node === undefined) return false
    return node.isFolder || node.forcesExpander || this.hasChildren(key)
  }

  /** The node's ancestors, nearest first. (Swift `ancestors(of:)`.) */
  ancestors(key: string): string[] {
    const result: string[] = []
    const seen = new Set<string>([key])
    let current = this.node(key)?.parentKey ?? ""
    while (current.length > 0 && !seen.has(current)) {
      seen.add(current)
      result.push(current)
      current = this.node(current)?.parentKey ?? ""
    }
    return result
  }

  /**
   * Every loaded, expandable descendant of `key`, `key` included when it is expandable: what
   * *Expand All Below* opens (core-uses.md §1.4) among the nodes the client holds.
   * (Swift `expandableSubtree(of:)`.)
   */
  expandableSubtree(key: string): string[] {
    const result: string[] = []
    const stack = [key]
    const seen = new Set<string>()
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      if (seen.has(current)) continue
      seen.add(current)
      if (this.isExpandable(current)) result.push(current)
      for (const index of this.childIndices.get(current) ?? []) stack.push(this.tree.nodes[index].id)
    }
    return result
  }

  /** The rows shown: the top level and the children of every expanded node, in order. */
  visibleRows(expanded: ReadonlySet<string>): TreeIndexRow[] {
    const rows: TreeIndexRow[] = []
    const seen = new Set<string>()
    const walk = (parent: string, depth: number): void => {
      for (const index of this.childIndices.get(parent) ?? []) {
        const node = this.tree.nodes[index]
        if (seen.has(node.id)) continue
        seen.add(node.id)
        rows.push(new TreeIndexRow(node, depth))
        if (expanded.has(node.id)) walk(node.id, depth + 1)
      }
    }
    walk("", 0)
    return rows
  }

  /**
   * The rows a filter leaves: every node it matches, with its ancestors to show where it sits,
   * all expanded; in tree order.
   */
  filteredRows(matching: (node: TreeNode) => boolean): TreeIndexRow[] {
    const matched = new Set<string>()
    const shown = new Set<string>()
    for (const node of this.tree.nodes) {
      if (node.isHidden || !matching(node)) continue
      matched.add(node.id)
      shown.add(node.id)
      for (const ancestor of this.ancestors(node.id)) shown.add(ancestor)
    }
    const rows: TreeIndexRow[] = []
    const seen = new Set<string>()
    const walk = (parent: string, depth: number): void => {
      for (const index of this.childIndices.get(parent) ?? []) {
        const node = this.tree.nodes[index]
        if (!shown.has(node.id) || seen.has(node.id)) continue
        seen.add(node.id)
        rows.push(new TreeIndexRow(node, depth, matched.has(node.id)))
        walk(node.id, depth + 1)
      }
    }
    walk("", 0)
    return rows
  }

  /**
   * Type-ahead (core-uses.md §1.4): the first row after `start` (wrapping) whose text starts with
   * `prefix`, compared without regard to case. (Swift `typeAhead(_:in:after:)`.)
   */
  static typeAhead(prefix: string, rows: readonly TreeIndexRow[], start: number | undefined): number | undefined {
    if (prefix.length === 0 || rows.length === 0) return undefined
    const wanted = prefix.toLowerCase()
    const first = start === undefined ? 0 : (start + 1) % rows.length
    for (let offset = 0; offset < rows.length; offset++) {
      const index = (first + offset) % rows.length
      const node = rows[index].node
      if ((node.text.length === 0 ? node.id : node.text).toLowerCase().startsWith(wanted)) return index
    }
    return undefined
  }
}
