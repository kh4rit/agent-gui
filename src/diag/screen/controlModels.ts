// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ControlModels.swift (MIT).

// The content of the controls a scene holds (docs/protocol/controls/scene.md): a tree's nodes,
// a grid's columns and cells, a splitter's cells. Portable values the app draws natively.
//
// Value semantics: Swift's models are structs. Here `TreeNode` and `GridColumn` are immutable (a
// changed node is a new node), and `TreeModel`, `GridModel`, `SplitterLayout` and `ControlShell`
// are classes with `clone()`. The control scene copies a shell before it changes it, so a model
// read from a scene never changes under its reader; copy one with `clone()` before changing it.

import { parseInteger, type DataObject } from "../codec/index.js"

/**
 * Swift's `String.count` for the texts of this module: the Unicode scalars (as the codec counts a
 * URL's characters; a grapheme cluster of several scalars is rare in a control's texts).
 */
export function swiftCount(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Whether every character of `text` is below U+0300: NFC leaves such a text as it is, and no surrogate occurs. */
function isSimpleText(text: string): boolean {
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) >= 0x300) return false
  return true
}

/**
 * Swift's `String` order (`<`, `==`): the Unicode scalars of the canonically composed (NFC) texts,
 * compared one by one. -1, 0 or 1.
 */
export function swiftCompare(a: string, b: string): number {
  if (a === b) return 0
  if (isSimpleText(a) && isSimpleText(b)) return a < b ? -1 : 1
  const x = a.normalize("NFC")
  const y = b.normalize("NFC")
  let index = 0
  while (index < x.length && index < y.length) {
    const cx = x.codePointAt(index)!
    const cy = y.codePointAt(index)!
    if (cx !== cy) return cx < cy ? -1 : 1
    index += cx > 0xffff ? 2 : 1
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1
}

/** The fields of a `TreeNode` as its initialiser takes them (Swift `TreeNode.init`), the defaults left out. */
export interface TreeNodeFields {
  id: string
  parentKey: string
  text?: string
  isFolder?: boolean
  isHidden?: boolean
  isDisabled?: boolean
  icon?: string | undefined
  forcesExpander?: boolean
}

/**
 * A node of a tree control, from the node table with its text from the item table. Immutable (the
 * Swift struct's `var`s are changed by making a new node: `new TreeNode({ ...node, text })`).
 */
export class TreeNode {
  /** The node key. */
  readonly id: string
  /** The parent's key; empty at the top level. */
  readonly parentKey: string
  readonly text: string
  readonly isFolder: boolean
  readonly isHidden: boolean
  readonly isDisabled: boolean
  /** The icon code of the node's image, when one is named. */
  readonly icon: string | undefined
  /** The node shows an expander though its children are not loaded yet. */
  readonly forcesExpander: boolean

  constructor(fields: TreeNodeFields) {
    this.id = fields.id
    this.parentKey = fields.parentKey
    this.text = fields.text ?? ""
    this.isFolder = fields.isFolder ?? false
    this.isHidden = fields.isHidden ?? false
    this.isDisabled = fields.isDisabled ?? false
    this.icon = fields.icon
    this.forcesExpander = fields.forcesExpander ?? false
  }
}

/** A tree control's content. A Swift struct: `clone()` copies it. */
export class TreeModel {
  /** The nodes in the node table's order. */
  nodes: TreeNode[] = []
  /** The keys of the nodes shown expanded. */
  expanded = new Set<string>()
  /** The tree is a list-like tree (`ListDisplay`). */
  listDisplay = false

  /** The node table's fields by position (PV-1005). (Swift `TreeModel.NodeField`.) */
  static readonly NodeField = { key: 1, parent: 2, hidden: 4, disabled: 5, folder: 6, image: 7, expander: 12 } as const // provenance: PV-1005

  /** The item table's fields by position (PV-1005): the key, and the text as the last field. (Swift `TreeModel.ItemField`.) */
  static readonly ItemField = { key: 1, name: 2 } as const // provenance: PV-1005

  /** A copy: the nodes (immutable) shared, the arrays and the set copied. */
  clone(): TreeModel {
    const copy = new TreeModel()
    copy.nodes = this.nodes.slice()
    copy.expanded = new Set(this.expanded)
    copy.listDisplay = this.listDisplay
    return copy
  }

  /** The visible children of `parentKey` (empty: the top level), in order. (Swift `children(of:)`.) */
  children(parentKey: string): TreeNode[] {
    return this.nodes.filter(node => node.parentKey === parentKey && !node.isHidden)
  }

  hasChildren(key: string): boolean {
    return this.nodes.some(node => node.parentKey === key && !node.isHidden)
  }

  node(key: string): TreeNode | undefined {
    return this.nodes.find(node => node.id === key)
  }

  /** The index of the first node of each key (Swift's `nodes.firstIndex(where:)`, looked up once per table). */
  private firstIndices(): Map<string, number> {
    const indices = new Map<string, number>()
    this.nodes.forEach((node, index) => {
      if (!indices.has(node.id)) indices.set(node.id, index)
    })
    return indices
  }

  /** Adds the rows of a node table. */
  addNodes(table: DataObject): void {
    const F = TreeModel.NodeField
    const indices = this.firstIndices()
    for (let row = 0; row < table.rows.length; row++) {
      const key = table.text(row, F.key)
      if (key === undefined || key.length === 0) continue
      const icon = table.text(row, F.image) ?? ""
      const fields: TreeNodeFields = {
        id: key,
        parentKey: table.text(row, F.parent) ?? "",
        isFolder: table.flag(row, F.folder),
        isHidden: table.flag(row, F.hidden),
        isDisabled: table.flag(row, F.disabled),
        icon: icon.length === 0 ? undefined : icon,
        forcesExpander: table.flag(row, F.expander)
      }
      const index = indices.get(key)
      if (index !== undefined) {
        this.nodes[index] = new TreeNode({ ...fields, text: this.nodes[index].text })
      } else {
        indices.set(key, this.nodes.length)
        this.nodes.push(new TreeNode(fields))
      }
    }
  }

  /**
   * Adds the rows of an item table: a node's label is the text (the last field) of its first
   * item, the one whose name (field 2) sorts first, `1` in every table seen; the other items are
   * further columns, such as an icon column (issue #159). A later table replaces the label.
   */
  addItems(table: DataObject): void {
    const last = table.fields.length > 0 ? table.fields[table.fields.length - 1] : undefined
    if (last === undefined) return
    const F = TreeModel.ItemField
    const indices = this.firstIndices()
    const chosen = new Map<string, string>()
    for (let row = 0; row < table.rows.length; row++) {
      const key = table.text(row, F.key)
      const index = key === undefined ? undefined : indices.get(key)
      if (key === undefined || index === undefined) continue
      const name = table.text(row, F.name) ?? ""
      const earlier = chosen.get(key)
      if (earlier !== undefined && TreeModel.itemOrder(earlier, name)) continue
      chosen.set(key, name)
      this.nodes[index] = new TreeNode({ ...this.nodes[index], text: table.text(row, last.index) ?? "" })
    }
  }

  /** Whether item name `a` comes before `b`: numerically when both are numbers. */
  static itemOrder(a: string, b: string): boolean {
    const x = parseInteger(a)
    const y = parseInteger(b)
    if (x !== undefined && y !== undefined) return x <= y
    return swiftCompare(a, b) <= 0
  }

  /** Sets the expanded keys from a key table: its first field per row. */
  setExpanded(table: DataObject): void {
    const expanded = new Set<string>()
    for (let row = 0; row < table.rows.length; row++) {
      const key = table.text(row, 1)
      if (key !== undefined && key.length > 0) expanded.add(key)
    }
    this.expanded = expanded
  }
}

/** The data types whose cells are numbers (Swift `GridColumn.isNumeric`). */
const NUMERIC_TYPES: readonly string[] = [..."IPNFbs8"] // provenance: PV-1007

/** The fields of a `GridColumn` (Swift `GridColumn.init`). */
export interface GridColumnFields {
  id: string
  position: number
  header: string
  width: number
  dataType: string
}

/** A column of a grid control: a row of its catalog. Immutable. */
export class GridColumn {
  /** The field name. */
  readonly id: string
  /** The position, from 1. */
  readonly position: number
  readonly header: string
  /** The output width in characters. */
  readonly width: number
  /** The data type character (Swift `Character`); a space when unknown. */
  readonly dataType: string

  constructor(fields: GridColumnFields) {
    this.id = fields.id
    this.position = fields.position
    this.header = fields.header
    this.width = fields.width
    this.dataType = fields.dataType
  }

  /** Numbers are right-aligned. */
  get isNumeric(): boolean {
    return NUMERIC_TYPES.includes(this.dataType) // provenance: PV-1007
  }
}

/** A grid control's content: the columns of its catalog and the cells of its packets. A Swift struct: `clone()` copies it. */
export class GridModel {
  title: string | undefined = undefined
  /** The columns in position order. */
  columns: GridColumn[] = []
  /** Cell texts by row number, then by column position. */
  cells = new Map<number, Map<number, string>>()
  /**
   * Each row's id by row number: its marker slot's text, trailing spaces left out and leading
   * ones kept (the row number right-aligned, PV-1008); what a client reports the row by
   * (controls/events.md §4, PV-1013).
   */
  rowIDs = new Map<number, string>()

  /** The catalog's fields by position (PV-1007). (Swift `GridModel.CatalogField`.) */
  static readonly CatalogField = { name: 1, position: 3, header: 4, width: 5, dataType: 13 } as const // provenance: PV-1007

  /**
   * A packet's fields by position (PV-1008): the column position, negative for a row marker,
   * the row number, and the text. (Swift `GridModel.PacketField`.)
   */
  static readonly PacketField = { column: 1, row: 2, text: 4 } as const // provenance: PV-1008

  /** A copy: the columns (immutable) shared, the maps copied. */
  clone(): GridModel {
    const copy = new GridModel()
    copy.title = this.title
    copy.columns = this.columns.slice()
    copy.cells = new Map(Array.from(this.cells, ([row, cells]) => [row, new Map(cells)]))
    copy.rowIDs = new Map(this.rowIDs)
    return copy
  }

  /** Drops every cell and row id: a new data table replaces the old one (issue #166). */
  clearCells(): void {
    this.cells = new Map()
    this.rowIDs = new Map()
  }

  get rowNumbers(): number[] {
    return Array.from(this.cells.keys()).sort((a, b) => a - b)
  }

  /** The text of the cell at `row` and column `position` (Swift `text(row:column:)`); empty when there is none. */
  text(row: number, position: number): string {
    return this.cells.get(row)?.get(position) ?? ""
  }

  setCatalog(table: DataObject): void {
    const F = GridModel.CatalogField
    const columns: GridColumn[] = []
    for (let row = 0; row < table.rows.length; row++) {
      const name = table.text(row, F.name)
      if (name === undefined || name.length === 0) continue
      const position = table.number(row, F.position) ?? row + 1
      const header = table.text(row, F.header) ?? ""
      const width = table.number(row, F.width) ?? Math.max(swiftCount(header), 1)
      const type = firstCharacter(table.text(row, F.dataType)) ?? " "
      columns.push(new GridColumn({ id: name, position, header: header.length === 0 ? name : header, width: Math.max(width, 1), dataType: type }))
    }
    this.columns = columns.sort((a, b) => a.position - b.position)
  }

  addPacket(table: DataObject): void {
    const F = GridModel.PacketField
    for (let row = 0; row < table.rows.length; row++) {
      const column = table.number(row, F.column)
      const number = table.number(row, F.row)
      if (column === undefined || number === undefined) continue
      const text = table.text(row, F.text) ?? ""
      if (column > 0) {
        let cells = this.cells.get(number)
        if (cells === undefined) {
          cells = new Map()
          this.cells.set(number, cells)
        }
        cells.set(column, text)
      } else {
        this.rowIDs.set(number, text)
      }
    }
  }
}

/** Swift `text.first`: the first character, or undefined for an empty or absent text. */
function firstCharacter(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  for (const character of text) return character
  return undefined
}

/** A splitter shell's cells. A Swift struct: `clone()` copies it. */
export class SplitterLayout {
  rows = 1
  columns = 1
  /** Widths as set, by column from 1; 0 or less means an equal share. */
  columnWidths = new Map<number, number>()
  rowHeights = new Map<number, number>()

  clone(): SplitterLayout {
    const copy = new SplitterLayout()
    copy.rows = this.rows
    copy.columns = this.columns
    copy.columnWidths = new Map(this.columnWidths)
    copy.rowHeights = new Map(this.rowHeights)
    return copy
  }

  /** The share of the width column `column` takes, 0 to 1. */
  columnShare(column: number): number {
    return SplitterLayout.share(column, this.columns, this.columnWidths)
  }

  rowShare(row: number): number {
    return SplitterLayout.share(row, this.rows, this.rowHeights)
  }

  /** Sizes above 0 are percentages; the rest share what is left equally. */
  static share(index: number, count: number, sizes: ReadonlyMap<number, number>): number {
    if (!(count > 0)) return 1
    const fixed: number[] = []
    for (let slot = 1; slot <= count; slot++) {
      const size = sizes.get(slot)
      if (size !== undefined && size > 0) fixed.push(Math.min(size, 100))
    }
    const free = count - fixed.length
    const left = Math.max(0, 100 - fixed.reduce((sum, size) => sum + size, 0))
    const size = sizes.get(index)
    if (size !== undefined && size > 0) return Math.min(size, 100) / 100
    return free > 0 ? left / free / 100 : 0
  }
}

/** A shell's content (Swift `ControlShell.Content`). */
export type ControlShellContent =
  /** A container control: linked to the screen or docked, holding one child. */
  | { readonly kind: "container" }
  | { readonly kind: "splitter"; readonly value: SplitterLayout }
  | { readonly kind: "tree"; readonly value: TreeModel }
  | { readonly kind: "grid"; readonly value: GridModel }
  | { readonly kind: "image" }
  /** A class the scene does not model. */
  | { readonly kind: "other" }

export const ControlShellContent = {
  container: { kind: "container" } as ControlShellContent,
  image: { kind: "image" } as ControlShellContent,
  other: { kind: "other" } as ControlShellContent,
  splitter: (value: SplitterLayout): ControlShellContent => ({ kind: "splitter", value }),
  tree: (value: TreeModel): ControlShellContent => ({ kind: "tree", value }),
  grid: (value: GridModel): ControlShellContent => ({ kind: "grid", value }),

  /** A copy of `content`, its model copied. */
  clone(content: ControlShellContent): ControlShellContent {
    switch (content.kind) {
      case "splitter":
        return { kind: "splitter", value: content.value.clone() }
      case "tree":
        return { kind: "tree", value: content.value.clone() }
      case "grid":
        return { kind: "grid", value: content.value.clone() }
      default:
        return content
    }
  }
} as const

/** A cell of a splitter, from 1 (Swift `ControlShell.Cell`). */
export interface ControlShellCell {
  readonly row: number
  readonly column: number
}

/** The values a shell starts with (Swift `ControlShell.init`). */
export interface ControlShellFields {
  id: number
  className: string
  parent?: number | undefined
  cell?: ControlShellCell | undefined
  content: ControlShellContent
  created?: number
}

/** A shell: a control the server created by id. A Swift struct: `clone()` copies it. */
export class ControlShell {
  /** The shell id the server chose. */
  readonly id: number
  readonly className: string
  /** The parent shell's id, if any. */
  parent: number | undefined
  /** The splitter cell the shell sits in, when its parent is a splitter. */
  cell: ControlShellCell | undefined
  /** The screen's custom container the shell is linked to. */
  containerName: string | undefined = undefined
  /** The program the shell is docked to. */
  dockedProgram: string | undefined = undefined
  content: ControlShellContent
  /** The call that created it, for eviction order. */
  created: number
  /**
   * The events the server registered for the shell (`RegisterOcxEvent`, `RegisterEvent`,
   * PV-1014): the only ones a client reports.
   */
  events = new Set<number>()
  /**
   * The properties the server registered for the shell (`RegisterCachedProp`, PV-1014), in
   * order: the only ones a client reports.
   */
  cachedProperties: string[] = []

  constructor(fields: ControlShellFields) {
    this.id = fields.id
    this.className = fields.className
    this.parent = fields.parent
    this.cell = fields.cell
    this.content = fields.content
    this.created = fields.created ?? 0
  }

  /** A copy, its content's model included. */
  clone(): ControlShell {
    const copy = new ControlShell({
      id: this.id,
      className: this.className,
      parent: this.parent,
      cell: this.cell,
      content: ControlShellContent.clone(this.content),
      created: this.created
    })
    copy.containerName = this.containerName
    copy.dockedProgram = this.dockedProgram
    copy.events = new Set(this.events)
    copy.cachedProperties = this.cachedProperties.slice()
    return copy
  }

  /** The content a class name stands for (PV-1009). (Swift `ControlShell.content(forClass:)`.) */
  static contentForClass(name: string): ControlShellContent {
    if (name.includes(".tree.")) return ControlShellContent.tree(new TreeModel()) // provenance: PV-1009
    if (name.includes(".grid.")) return ControlShellContent.grid(new GridModel()) // provenance: PV-1009
    if (name.includes("Splitter")) return ControlShellContent.splitter(new SplitterLayout()) // provenance: PV-1009
    if (name.includes("CONTAINERCTRL")) return ControlShellContent.container // provenance: PV-1009
    if (name.includes(".image.")) return ControlShellContent.image // provenance: PV-1009
    return ControlShellContent.other
  }
}
