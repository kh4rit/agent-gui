// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ControlEvents.swift (MIT).

// A user's action on a grid or a tree, as the client reports it to the server (docs/protocol/
// controls/events.md §4, Readings R-CT-38 to R-CT-41): the OK-code that has the server process a
// control event, the control that has the focus, and the DATAMANAGER report of the event and of
// the control's state. The shapes are SAP GUI's in the owner's capture of the runtime-error list
// (trial-derived, PV-1013 to PV-1016).

import { DataManagerControl, DataManagerFirstVisible, DataManagerReport, type DataManagerEvent, type DataManagerProperty } from "../codec/index.js"
import type { ControlShell, GridModel } from "./controlModels.js"
import type { ControlScene } from "./controlScene.js"

/**
 * What a step reports of the controls: the report for its DATAMANAGER document, the shell with
 * the focus, and, for an event, the OK-code that has the server process it.
 */
export class ControlAction {
  /** `%_GC`, the shell and the event (Reading R-CT-38); undefined for a report of state alone. */
  okCode: string | undefined
  /** The shell with the focus: the step's DYNT_CONTROL_FOCUS (Reading R-CT-41). */
  focus: number | undefined
  report: DataManagerReport

  constructor(fields: { okCode?: string | undefined; focus?: number | undefined; report: DataManagerReport }) {
    this.okCode = fields.okCode
    this.focus = fields.focus
    this.report = fields.report
  }
}

/** A cell of a grid: its row number and its column's place among the grid's columns, from 1. */
export interface GridCell {
  row: number
  column: number
}

/** The event a double-click on a grid's cell raises (PV-1014). */
const GRID_DOUBLE_CLICK = 3 // provenance: PV-1014
/** The event a tree node raises when the user opens it (PV-1014). */
const TREE_NODE_OPENED = 25 // provenance: PV-1014
/** The name of a tree's selected-node property (PV-1015). */
const SELECTED_NODE_KEY = "ABAPSelNodeKey" // provenance: PV-1015

/**
 * The events and states a client reports for grids and trees (Readings R-CT-38 to R-CT-41).
 *
 * Swift names the grid's double-click event and the function that builds one alike
 * (`gridDoubleClick`, `gridDoubleClick(in:shell:cell:)`); the function is `gridDoubleClickIn`.
 */
export const ControlEvents = {
  /** The OK-code's first word (PV-1013). */
  okCodePrefix: DataManagerReport.eventOKCodePrefix,
  /** The event a double-click on a grid's cell raises (PV-1014). */
  gridDoubleClick: GRID_DOUBLE_CLICK,
  /** The event a tree node raises when the user opens it (PV-1014). */
  treeNodeOpened: TREE_NODE_OPENED,

  /**
   * The OK-code of `event` in `shell`: `%_GC`, the shell id and the event, one space apart
   * (Reading R-CT-38).
   */
  okCode(shell: number, event: number): string {
    return `${ControlEvents.okCodePrefix} ${shell} ${event}`
  },

  // MARK: Grids

  /** The names of a grid's cached properties (PV-1015). (Swift `ControlEvents.GridProperty`.) */
  GridProperty: {
    currentCellColumn: "CurrentCellCol", // provenance: PV-1015
    currentCellRow: "CurrentCellRow", // provenance: PV-1015
    firstVisibleRow: "FirstVisibleRow", // provenance: PV-1015
    firstVisibleRowID: "FirstVisibleRowID", // provenance: PV-1015
    currentCellColumnID: "CurrentCellColID", // provenance: PV-1015
    currentCellRowID: "CurrentCellRowID", // provenance: PV-1015
    currentCellText: "CurrentCellText" // provenance: PV-1015
  },

  /** The width of a row id: the row number right-aligned, as the server's marker slots carry it (PV-1008, PV-1013). */
  rowIDWidth: 33, // provenance: PV-1013
  /** The digits of the row number in a row id. */
  rowIDDigits: 10, // provenance: PV-1013

  /**
   * The id of `row` in `grid` (Swift `rowID(_:in:)`): its marker slot's text, or the row number
   * written as the server writes it there (ten digits, right-aligned in 33 characters) when no
   * marker came.
   */
  rowID(row: number, grid: GridModel): string {
    const id = grid.rowIDs.get(row)
    if (id !== undefined) return id
    return String(row).padStart(ControlEvents.rowIDDigits, "0").padStart(ControlEvents.rowIDWidth, " ")
  },

  /**
   * A grid's state with `cell` as its current cell (Reading R-CT-40): of the properties the
   * server registered, the current column, the first visible row and its id, the current
   * column's field name and the cell's text, in SAP GUI's order, and the current row and its id
   * when the row is not the first; the first visible cell at the origin.
   */
  gridState(grid: GridModel, shell: ControlShell, cell: GridCell): DataManagerControl | undefined {
    const firstRow = grid.rowNumbers[0]
    if (!(cell.column - 1 >= 0 && cell.column - 1 < grid.columns.length) || firstRow === undefined) return undefined
    const P = ControlEvents.GridProperty
    const column = grid.columns[cell.column - 1]
    const candidates: [string, string][] = [[P.currentCellColumn, String(cell.column)]]
    if (cell.row !== firstRow) candidates.push([P.currentCellRow, String(cell.row)])
    candidates.push([P.firstVisibleRow, String(firstRow)], [P.firstVisibleRowID, ControlEvents.rowID(firstRow, grid)], [P.currentCellColumnID, column.id])
    if (cell.row !== firstRow) candidates.push([P.currentCellRowID, ControlEvents.rowID(cell.row, grid)])
    candidates.push([P.currentCellText, grid.text(cell.row, column.position)])
    const properties: DataManagerProperty[] = candidates.filter(([name]) => shell.cachedProperties.includes(name)).map(([name, value]) => ({ name, value }))
    return new DataManagerControl(shell.id, properties, DataManagerFirstVisible.origin)
  },

  /**
   * A double-click on `cell` of grid `id` (Reading R-CT-39; Swift `gridDoubleClick(in:shell:cell:)`):
   * event 3 with the row id, the column's field name, the row number, the column's place and 0,
   * the grid's state, the OK-code and the focus; undefined when the server registered no
   * double-click for the grid, or the cell is not in it.
   */
  gridDoubleClickIn(scene: ControlScene, id: number, cell: GridCell): ControlAction | undefined {
    const shell = scene.shells.get(id)
    if (shell === undefined || shell.content.kind !== "grid" || !shell.events.has(GRID_DOUBLE_CLICK)) return undefined
    const grid = shell.content.value
    const state = ControlEvents.gridState(grid, shell, cell)
    if (state === undefined) return undefined
    const column = grid.columns[cell.column - 1]
    const event: DataManagerEvent = {
      shell: id,
      event: GRID_DOUBLE_CLICK,
      parameters: [ControlEvents.rowID(cell.row, grid), column.id, String(cell.row), String(cell.column), "0"]
    }
    return new ControlAction({
      okCode: ControlEvents.okCode(id, GRID_DOUBLE_CLICK),
      focus: id,
      report: new DataManagerReport({ events: [event], controls: [state] })
    })
  },

  // MARK: Trees

  /** The name of a tree's selected-node property (PV-1015). */
  selectedNodeKey: SELECTED_NODE_KEY,

  /**
   * A tree's state with node `key` selected (Reading R-CT-40): the selected node's key, when the
   * server registered the property.
   */
  treeState(shell: ControlShell, key: string): DataManagerControl | undefined {
    if (!shell.cachedProperties.includes(SELECTED_NODE_KEY)) return undefined
    return new DataManagerControl(shell.id, [{ name: SELECTED_NODE_KEY, value: key }])
  },

  /**
   * Opening node `key` of tree `id` (Reading R-CT-39; Swift `treeNodeOpen(in:shell:key:)`): event
   * 25 with the node's key, the tree's state, the OK-code and the focus; undefined when the server
   * registered no such event for the tree, or the node is not in it.
   */
  treeNodeOpen(scene: ControlScene, id: number, key: string): ControlAction | undefined {
    const shell = scene.shells.get(id)
    if (shell === undefined || shell.content.kind !== "tree" || !shell.events.has(TREE_NODE_OPENED) || shell.content.value.node(key) === undefined) {
      return undefined
    }
    const event: DataManagerEvent = { shell: id, event: TREE_NODE_OPENED, parameters: [key] }
    const state = ControlEvents.treeState(shell, key)
    return new ControlAction({
      okCode: ControlEvents.okCode(id, TREE_NODE_OPENED),
      focus: id,
      report: new DataManagerReport({ events: [event], controls: state === undefined ? [] : [state] })
    })
  }
} as const
