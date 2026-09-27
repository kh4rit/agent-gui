// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenStructure.swift (MIT).

// The structures of docs/protocol/elements.md that span several atoms or items, built after the
// item walk from what `ScreenDecoder` collected: radio groups (Reading R-EL-2), tabstrips (R-EL-5),
// table controls (R-EL-7, R-EL-8, R-EL-10), the classic list (R-EL-11, R-EL-20, R-EL-21), the popup
// (R-EL-13) and the cursor (R-EL-17). Each part follows its switch in `ScreenReadings`; at the
// fallback the part stays empty and the elements stay as the walk made them.

import {
  DyntToggle,
  ListLineElement,
  ListRunFlags,
  ListRunWalker,
  PopupWindow,
  TableLayout,
  TableScrollState,
  TabstripButtons,
  type ListWindowState,
  type ScrollInfos,
  type SESValue
} from "../codec/index.js"
import type { ScreenReadings } from "./functionTrigger.js"
import type { ScreenDecoder, ScreenDiagnostics, ScreenTextDecoder } from "./screen.js"
import { ScreenRadioGroup, ScreenRadioGroupID, ScreenTab, ScreenTabstrip } from "./screenControls.js"
import { ScreenElementKind, type ScreenElement, type ScreenElementID } from "./screenElement.js"
import { GridPoint, GridRect, ScreenTextDecoding, TextMarkup, characterCount, type ScreenContainer } from "./screenLayout.js"
import { ListColor, ScreenList, ScreenListLine, ScreenListScroll, ScreenListSegment, type ScreenListWindowSource } from "./screenList.js"
import { ScreenCursor, ScreenPopup, ScreenPresentation } from "./screenPopup.js"
import { ScreenTable, ScreenTableCell, ScreenTableColumn, ScreenTableRow, ScreenTableScroll, ScreenTableSelection } from "./screenTable.js"

/** A column's cells: from its first cell to the cell before the next column. */
interface ColumnSpan {
  readonly start: number
  readonly width: number
}

function spanContains(span: ColumnSpan, column: number): boolean {
  return column >= span.start && column < span.start + Math.max(span.width, 1)
}

/** A list window's state, from whichever item R-EL-11 or R-EL-21 took it (Swift's private `ListWindowChoice`). */
class ListWindowChoice {
  readonly source: ScreenListWindowSource
  /** The fixed header lines at the window's top. */
  readonly headerLines: number
  /** The window's rows; runs below them are left out. 0: no limit. */
  readonly windowRows: number
  /** The first body line shown, from 1. */
  readonly firstLine: number
  readonly totalLines: number
  /** Body rows per page. */
  readonly visibleLines: number
  readonly width: number
  /** The columns shown; 0: as wide as the runs. */
  readonly visibleWidth: number

  private constructor(fields: {
    source: ScreenListWindowSource
    headerLines: number
    windowRows: number
    firstLine: number
    totalLines: number
    visibleLines: number
    width: number
    visibleWidth: number
  }) {
    this.source = fields.source
    this.headerLines = fields.headerLines
    this.windowRows = fields.windowRows
    this.firstLine = fields.firstLine
    this.totalLines = fields.totalLines
    this.visibleLines = fields.visibleLines
    this.width = fields.width
    this.visibleWidth = fields.visibleWidth
  }

  /** R-EL-11's meanings of a CHL value (APPL DYNN CHL, or a plain CHL under R-EL-21). */
  static fromCHL(chl: ListWindowState, source: ScreenListWindowSource): ListWindowChoice {
    return new ListWindowChoice({
      source,
      headerLines: chl.headerLines,
      windowRows: chl.dimRow,
      firstLine: chl.firstLine,
      totalLines: chl.totalLines,
      visibleLines: chl.visibleLines,
      width: chl.width,
      visibleWidth: chl.dimListColumn
    })
  }

  /** R-EL-21's meanings of a SCROLL_INFOS, as R-EL-8 reads it for a table: no header lines, no row limit. */
  static fromScrollInfos(scrollInfos: ScrollInfos): ListWindowChoice {
    const state = TableScrollState.fromScrollInfos(scrollInfos)
    return new ListWindowChoice({
      source: "scrollInfos",
      headerLines: 0,
      windowRows: 0,
      firstLine: state.firstRow,
      totalLines: state.totalRows ?? 0,
      visibleLines: state.visibleRows,
      width: state.totalWidth ?? 0,
      visibleWidth: state.viewportWidth
    })
  }

  /**
   * Whether the state fits a list whose runs span `rowsSeen` rows (R-EL-21): at least one body row
   * per page and a window no smaller than a page, no run below the window, no more body rows than a
   * page holds, and the body lines shown within the total. A state that fails would hide lines of a
   * real list or number them wrongly: a page with more rows than a SCROLL_INFOS's data_height (or a
   * plain CHL's dimlistrow when its dimrow is 0) must have header lines that the state does not say.
   */
  fits(rowsSeen: number): boolean {
    if (!(this.visibleLines >= 1 && this.totalLines >= 1 && this.firstLine >= 1 && (this.windowRows === 0 || this.windowRows >= this.visibleLines))) return false
    if (this.windowRows > 0 && rowsSeen > this.windowRows) return false
    const bodyRows = Math.max(0, rowsSeen - this.headerLines)
    return bodyRows <= this.visibleLines && this.firstLine - 1 + bodyRows <= this.totalLines
  }

  /**
   * The total the list's scroll state carries: APPL DYNN CHL's (R-EL-11). A window of R-EL-21 gives
   * none until #111 confirms its header split, so that the list view fetches no page of a real list
   * on its own (R-EL-12's keys still go when pressed).
   */
  get scrollTotal(): number | undefined {
    return this.source === "dynnCHL" ? this.totalLines : undefined
  }
}

/** Builds the multi-atom structures of one screen from its decoder's results. (Swift internal.) */
export class ScreenStructureBuilder {
  private readonly readings: ScreenReadings
  private readonly containers: readonly ScreenContainer[]
  private readonly elementContainers: readonly (number | undefined)[]
  private readonly tabButtonElements: readonly number[]
  private readonly containerNames: ReadonlyMap<number, string>
  private readonly tableScrollInfos: ReadonlyMap<number, ScrollInfos>
  private readonly ses: SESValue | undefined
  private readonly focus: { row: number; col: number; colOffset: number; container: number } | undefined
  private readonly listWindow: ListWindowState | undefined
  private readonly plainListWindow: ListWindowState | undefined
  private readonly listScrollInfos: ScrollInfos | undefined
  private readonly hasListRuns: boolean

  /** The elements, with their radio group, table cell and tabstrip page set. */
  readonly elements: ScreenElement[]
  radioGroups: ScreenRadioGroup[] = []
  tabstrips: ScreenTabstrip[] = []
  tables: ScreenTable[] = []
  list: ScreenList | undefined = undefined
  cursor: ScreenCursor | undefined = undefined
  /** The decoder's text counts, which the list texts add to. */
  readonly text: ScreenTextDecoder
  readonly diagnostics: ScreenDiagnostics

  constructor(decoder: ScreenDecoder) {
    this.readings = decoder.readings
    this.containers = decoder.containers
    this.elementContainers = decoder.elementContainers
    this.tabButtonElements = decoder.tabButtonElements
    this.containerNames = decoder.containerNames
    this.tableScrollInfos = decoder.tableScrollInfos
    this.ses = decoder.windowSES
    this.focus = decoder.focus
    this.listWindow = decoder.listWindow
    this.plainListWindow = decoder.plainListWindow
    this.listScrollInfos = decoder.listScrollInfos
    this.hasListRuns = decoder.hasListRuns
    this.elements = decoder.elements.slice()
    this.text = decoder.text.clone()
    this.diagnostics = decoder.diagnostics.clone()
  }

  /** Builds every structure; `items` is the message's item sequence (for the list runs). */
  build(items: Uint8Array): void {
    this.buildRadioGroups()
    this.buildTabstrips()
    this.buildTables()
    if (this.hasListRuns && this.readings.list !== "specGap") this.buildList(items)
    this.buildCursor()
  }

  /** The popup the SES item describes (Reading R-EL-13), else a main screen. */
  presentation(title: string | undefined): ScreenPresentation {
    const window = this.ses === undefined ? undefined : PopupWindow.fromSES(this.ses, this.readings.popup)
    if (window === undefined) return ScreenPresentation.main
    let frame: GridRect | undefined
    if (window.row === 0 || window.column === 0 || window.rows === 0 || window.columns === 0) {
      frame = undefined
    } else {
      frame = new GridRect(new GridPoint(window.row - 1, window.column - 1), window.rows, window.columns)
    }
    return ScreenPresentation.popup(new ScreenPopup({ level: window.level, frame, title }))
  }

  private rect(container: ScreenContainer): GridRect {
    return new GridRect(container.origin, container.height, container.width)
  }

  // MARK: Radio groups (R-EL-2)

  private buildRadioGroups(): void {
    const order: ScreenRadioGroupID[] = []
    const members = new Map<string, number[]>()
    /** A group's name under `sharedFieldName`, by area and field name. */
    const names = new Map<string, number>()
    // A button whose state was not read (#107) still belongs to its group, whose selection is then
    // unknown: the user can still choose (Reading R-EL-4, issue #149). Under the `specGap` checkbox
    // Reading every body stays opaque and nothing is grouped, as before.
    for (let index = 0; index < this.elements.length; index++) {
      const element = this.elements[index]
      if (!(element.kind.kind === "radioButton" && (element.isChecked !== undefined || this.readings.checkbox !== "specGap"))) continue
      const atom = element.atom
      let id: ScreenRadioGroupID
      switch (this.readings.radioGroups) {
        case "areaBlockGroup":
          id = new ScreenRadioGroupID(atom.area, DyntToggle.radioGroupKey(atom.block, atom.group))
          break
        case "sharedFieldName": {
          const name = element.fieldName
          if (name === undefined || name.length === 0) continue
          const named = `${atom.area}|${name}`
          const key = names.get(named) ?? ((names.size + 1) & 0xffff)
          names.set(named, key)
          id = new ScreenRadioGroupID(atom.area, key)
          break
        }
        case "specGap":
          return
      }
      const group = members.get(id.mapKey)
      if (group === undefined) {
        order.push(id)
        members.set(id.mapKey, [index])
      } else {
        group.push(index)
      }
    }
    for (const id of order) {
      const indices = members.get(id.mapKey) ?? []
      let selected: ScreenElementID | undefined
      for (const index of indices) {
        if (this.elements[index].isChecked !== true) continue
        if (selected === undefined) selected = this.elements[index].id
        else this.diagnostics.duplicateRadioSelections += 1
      }
      for (const index of indices) this.elements[index].radioGroup = id
      this.radioGroups.push(new ScreenRadioGroup({ id, members: indices.map(index => this.elements[index].id), selected }))
    }
  }

  // MARK: Tabstrips (R-EL-5)

  private buildTabstrips(): void {
    if (this.readings.tabstrip !== "serverPaged") return
    this.containers.forEach((container, index) => {
      if (container.kind !== "tabstrip") return
      const frame = this.rect(container)
      const tabs = this.tabButtonElements.filter(element => this.elementContainers[element] === index).map(element => this.tab(this.elements[element]))
      const active = tabs.findIndex(tab => tab.isActive)
      const activeIndex = active >= 0 ? active : tabs.length === 0 ? undefined : 0
      let page: number | undefined
      for (let candidate = index + 1; candidate < this.containers.length; candidate++) {
        if (this.containers[candidate].kind === "tabstripPage" && frame.containsRect(this.rect(this.containers[candidate]))) {
          page = candidate
          break
        }
      }
      if (page !== undefined) {
        for (let element = 0; element < this.elements.length; element++) {
          if (this.elementContainers[element] === page) this.elements[element].tabstripPage = container.id
        }
      }
      this.tabstrips.push(
        new ScreenTabstrip({ id: container.id, frame, tabs, activeIndex, pageArea: page === undefined ? undefined : this.containers[page].id })
      )
    })
  }

  private tab(element: ScreenElement): ScreenTab {
    const payload = element.atom.payload
    const pageID = payload.kind === "tabstripButton" ? payload.value.pageID : 0
    return new ScreenTab({
      id: element.id,
      caption: element.caption ?? "",
      icon: element.icon,
      tooltip: element.tooltip,
      functionCode: element.functionCode === undefined || element.functionCode.length === 0 ? undefined : element.functionCode,
      pageID,
      isActive: (element.atom.dialogFlags.flag1 & TabstripButtons.activeTabFlag) !== 0,
      isDisabled: element.isDisabled
    })
  }

  // MARK: Table controls (R-EL-7, R-EL-8, R-EL-10)

  private buildTables(): void {
    if (this.readings.table !== "headerBlockZero") return
    this.containers.forEach((container, index) => {
      if (!(container.kind === "table" && container.id !== 0)) return
      const members: number[] = []
      for (let element = 0; element < this.elements.length; element++) if (this.elementContainers[element] === index) members.push(element)
      if (members.length === 0) return
      this.tables.push(this.table(container, index, members))
    })
  }

  private table(container: ScreenContainer, index: number, members: readonly number[]): ScreenTable {
    const elements = this.elements
    const byColumn = (a: number, b: number): number => elements[a].atom.col - elements[b].atom.col
    const header = members.filter(member => elements[member].atom.block === TableLayout.headerBlock && elements[member].kind.kind === "label").sort(byColumn)
    const blocks = new Map<number, number[]>()
    for (const member of members) {
      const block = elements[member].atom.block
      if (!(block >= TableLayout.firstDataBlock)) continue
      const group = blocks.get(block)
      if (group === undefined) blocks.set(block, [member])
      else group.push(member)
    }
    const rowBlocks = Array.from(blocks.keys()).sort((a, b) => a - b)
    this.diagnostics.unmatchedTableAtoms += members.filter(
      member => elements[member].atom.block === TableLayout.headerBlock && elements[member].kind.kind !== "label"
    ).length

    let state: TableScrollState
    const infos = this.tableScrollInfos.get(index)
    if (this.readings.tableScrollState === "scrollInfosAfterContainer" && infos !== undefined) {
      state = TableScrollState.fromScrollInfos(infos)
    } else {
      state = TableScrollState.unknown(Math.max(0, container.height - (header.length === 0 ? 0 : 1)), container.width)
    }
    const scroll = ScreenTableScroll.fromState(state)

    // The columns: the header labels, else the first row's cells (R-EL-7).
    const spans: ColumnSpan[] = []
    const titles: (string | undefined)[] = []
    const names: (string | undefined)[] = []
    if (header.length > 0) {
      for (const label of header) {
        const element = elements[label]
        spans.push({ start: element.atom.col, width: element.width ?? (element.caption === undefined ? 0 : characterCount(element.caption)) })
        titles.push(element.caption)
        names.push(element.fieldName)
      }
    } else if (rowBlocks.length > 0) {
      for (const cell of (blocks.get(rowBlocks[0]) ?? []).slice().sort(byColumn)) {
        if (this.isSelector(elements[cell], [])) continue
        const element = elements[cell]
        spans.push({ start: element.atom.col, width: element.visibleWidth })
        titles.push(undefined)
        names.push(element.fieldName)
      }
    }

    const rows: ScreenTableRow[] = []
    for (const block of rowBlocks) {
      const line = scroll.firstRow + block - TableLayout.firstDataBlock
      const cells: (ScreenElementID | undefined)[] = new Array(spans.length).fill(undefined)
      let selector: number | undefined
      for (const member of (blocks.get(block) ?? []).slice().sort(byColumn)) {
        if (selector === undefined && this.isSelector(elements[member], spans)) {
          selector = member
          continue
        }
        const column = elements[member].atom.col
        const position = spans.findIndex(span => spanContains(span, column))
        if (position < 0 || cells[position] !== undefined) {
          this.diagnostics.unmatchedTableAtoms += 1
          continue
        }
        cells[position] = elements[member].id
        elements[member].table = new ScreenTableCell({ table: container.id, line, column: position })
      }
      rows.push(
        new ScreenTableRow({
          line,
          block,
          cells,
          isSelected: selector === undefined ? false : elements[selector].isChecked === true,
          selector: selector === undefined ? undefined : elements[selector].id
        })
      )
    }

    // Each column's kind from its first cell; the key columns are the leading run of protected ones (R-EL-8).
    const columns: ScreenTableColumn[] = []
    let isKeyRun = true
    for (let position = 0; position < spans.length; position++) {
      let cell: ScreenElement | undefined
      for (const row of rows) {
        const id = row.cells[position]
        if (id === undefined) continue
        cell = elements.find(element => element.id.mapKey === id.mapKey)
        break
      }
      const kind = cell?.kind ?? ScreenElementKind.output
      const isProtected = cell === undefined ? false : cell.kind.kind === "output" || cell.isProtected
      isKeyRun = isKeyRun && isProtected
      columns.push(new ScreenTableColumn({ index: position, title: titles[position], fieldName: names[position], width: spans[position].width, kind, isKey: isKeyRun }))
    }
    const hasSelector = rows.some(row => row.selector !== undefined)
    const containerName = this.containerNames.get(index)
    const name = containerName === undefined || containerName.length === 0 ? undefined : containerName
    return new ScreenTable({
      id: container.id,
      frame: this.rect(container),
      name,
      columns,
      rows,
      scroll,
      selection: new ScreenTableSelection(hasSelector ? "multiple" : "none")
    })
  }

  /** Whether `element` is a row's selector (R-EL-10): a checkbox at column 0 that no column covers. */
  private isSelector(element: ScreenElement, spans: readonly ColumnSpan[]): boolean {
    return (
      element.kind.kind === "checkbox" &&
      element.atom.col === TableLayout.selectorColumn &&
      !spans.some(span => spanContains(span, TableLayout.selectorColumn))
    )
  }

  // MARK: List (R-EL-11, R-EL-20, R-EL-21)

  /**
   * The list of the message's runs (R-EL-11). Rows count from the list window's top, which is the
   * first SBA row the runs use (0 on a list that fills the area): the window's first header lines are
   * fixed, the rows after them the body lines from the window's first line on. Runs below the window
   * are counted and left out. The window state comes from APPL DYNN CHL, else from a plain CHL or a
   * SCROLL_INFOS (R-EL-21), which leave the total unknown. A box run's codes become line elements
   * (R-EL-20).
   */
  private buildList(items: Uint8Array): void {
    const runs = ListRunWalker.runs(items).runs
    if (runs.length === 0) return
    const top = runs.reduce((lowest, run) => Math.min(lowest, run.row), runs[0].row)
    const left = runs.reduce((lowest, run) => Math.min(lowest, run.column), runs[0].column)
    this.diagnostics.plainListWindow = this.plainListWindow
    this.diagnostics.listScrollInfos = this.listScrollInfos
    const bottom = runs.reduce((highest, run) => Math.max(highest, run.row), top)
    const window = this.listWindowChoice(bottom - top + 1)
    const headerCount = window?.headerLines ?? 0
    const windowRows = window?.windowRows ?? 0
    const segments = new Map<number, ScreenListSegment[]>()
    let widest = 0
    for (const run of runs) {
      if (windowRows > 0 && run.row >= top + windowRows) {
        this.diagnostics.unmatchedListLines += 1
        continue
      }
      const style = run.style(this.readings.list)
      const raw = ScreenTextDecoding.trimmingPadding(this.text.decode(run.textRange.of(items)))
      const width = run.length ?? characterCount(raw)
      widest = Math.max(widest, run.column + width)
      const color: ListColor = style.isKnownColor ? ListColor.fromRaw(style.color) ?? "normal" : "normal"
      let segment: ScreenListSegment
      if (style.isBox && this.readings.listBoxes === "lineElements") {
        segment = new ScreenListSegment({
          column: run.column,
          width,
          text: this.boxText(raw),
          color,
          isIntensified: (style.flags & ListRunFlags.intensified) !== 0,
          isInverse: (style.flags & ListRunFlags.inverse) !== 0,
          isBox: true
        })
      } else {
        const markup = TextMarkup.parse(raw)
        segment = new ScreenListSegment({
          column: run.column,
          width,
          text: markup.caption,
          icon: markup.icon,
          color,
          isIntensified: (style.flags & ListRunFlags.intensified) !== 0,
          isInverse: (style.flags & ListRunFlags.inverse) !== 0,
          isHotspot: (style.flags & ListRunFlags.hotspot) !== 0
        })
      }
      const line = segments.get(run.row)
      if (line === undefined) segments.set(run.row, [segment])
      else line.push(segment)
    }
    const firstLine = window?.firstLine ?? 1
    const bodyTop = top + headerCount
    const headerLines: ScreenListLine[] = []
    const lines: ScreenListLine[] = []
    const rows = Array.from(segments.keys()).sort((a, b) => a - b)
    for (const row of rows) {
      const line = (segments.get(row) ?? []).slice().sort((a, b) => a.column - b.column)
      if (row < bodyTop) headerLines.push(new ScreenListLine({ index: 0, row, segments: line }))
      else lines.push(new ScreenListLine({ index: firstLine + row - bodyTop, row, segments: line }))
    }
    const lastRow = rows.length === 0 ? top : rows[rows.length - 1]
    const visibleWidth = window?.visibleWidth ?? 0
    const frame = new GridRect(new GridPoint(top, left), windowRows > 0 ? windowRows : lastRow - top + 1, visibleWidth > 0 ? visibleWidth : widest - left)
    const scroll = new ScreenListScroll({
      firstLine,
      totalLines: window?.scrollTotal,
      visibleLines: window?.visibleLines ?? lastRow + 1 - bodyTop,
      width: window?.width
    })
    this.list = new ScreenList({ frame, headerLines, lines, scroll, windowSource: window?.source })
  }

  /**
   * The window state of the list: APPL DYNN CHL as it came (R-EL-11); without it, under
   * `ListWindowReading` `chlOrScrollInfos`, a plain CHL that fits the runs, else a SCROLL_INFOS
   * outside a table that fits them (R-EL-21). One that does not fit is counted.
   */
  private listWindowChoice(rowsSeen: number): ListWindowChoice | undefined {
    if (this.readings.list !== "runsWithCHL") return undefined
    if (this.listWindow !== undefined) return ListWindowChoice.fromCHL(this.listWindow, "dynnCHL")
    if (this.readings.listWindow !== "chlOrScrollInfos") return undefined
    if (this.plainListWindow !== undefined) {
      const choice = ListWindowChoice.fromCHL(this.plainListWindow, "plainCHL")
      if (choice.fits(rowsSeen)) return choice
      this.diagnostics.implausibleListWindows += 1
    }
    if (this.listScrollInfos !== undefined) {
      const choice = ListWindowChoice.fromScrollInfos(this.listScrollInfos)
      if (choice.fits(rowsSeen)) return choice
      this.diagnostics.implausibleListWindows += 1
    }
    return undefined
  }

  /**
   * A box run's text with each code replaced by its line element's box-drawing character (R-EL-20).
   * A space stays a space; any other character stays as it came and is counted.
   */
  private boxText(codes: string): string {
    let glyphs = ""
    for (const scalar of codes) {
      this.diagnostics.listBoxCells += 1
      const element = ListLineElement.fromCode(scalar)
      if (element !== undefined) {
        glyphs += ListLineElement.glyph(element)
      } else {
        if (scalar !== " ") this.diagnostics.unknownListBoxCodes += 1
        glyphs += scalar
      }
    }
    return glyphs
  }

  // MARK: Cursor (R-EL-17)

  private buildCursor(): void {
    const focus = this.focus
    if (focus === undefined) return
    const position = new GridPoint(focus.row, focus.col)
    this.cursor = new ScreenCursor({
      element: ScreenStructureBuilder.element(position, focus.container, this.elements),
      position,
      area: focus.container,
      offset: focus.colOffset
    })
  }

  /**
   * The element the focus names: the one that starts at `position` in `area`, else the one that
   * covers it. (Swift `element(at:area:in:)`.)
   */
  static element(position: GridPoint, area: number, elements: readonly ScreenElement[]): ScreenElementID | undefined {
    const candidates = elements.filter(element => element.atom.area === area && element.atom.row === position.row)
    const element =
      candidates.find(candidate => candidate.atom.col === position.column) ??
      candidates.find(candidate => position.column >= candidate.column && position.column < candidate.column + Math.max(candidate.visibleWidth, 1))
    return element?.id
  }
}
