// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/MonitorControlTests.swift (MIT).

// The client's own work on a tree's and a grid's delivered content (core-uses.md §1.4, §3):
// the tree's index, filter, type-ahead and Expand All Below; the grid's local sort, filter and
// copy. Every name and text is invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { GridColumn, GridModel, GridRows, TreeIndex, TreeModel, TreeNode } from "../../../diag/screen/index.js"

/** A pond: two folders, ducks in the second, a hidden duck, a lazy folder. */
function pond(): TreeModel {
  const tree = new TreeModel()
  tree.nodes = [
    new TreeNode({ id: "ROOT", parentKey: "", text: "Pond Menu", isFolder: true }),
    new TreeNode({ id: "DEEP", parentKey: "ROOT", text: "The Deep End", isFolder: true }),
    new TreeNode({ id: "PUDDLE", parentKey: "ROOT", text: "The Puddle", isFolder: true }),
    new TreeNode({ id: "D1", parentKey: "PUDDLE", text: "Sir Waddles" }),
    new TreeNode({ id: "D2", parentKey: "PUDDLE", text: "Lady Quackington" }),
    new TreeNode({ id: "D3", parentKey: "PUDDLE", text: "Hidden Mallard", isHidden: true }),
    new TreeNode({ id: "LATER", parentKey: "DEEP", text: "Storage of Bread Crumbs", forcesExpander: true })
  ]
  return tree
}

function grid(): GridModel {
  const grid = new GridModel()
  grid.columns = [
    new GridColumn({ id: "DUCK", position: 1, header: "Duck", width: 12, dataType: "C" }),
    new GridColumn({ id: "CRUMBS", position: 2, header: "Crumbs", width: 8, dataType: "P" })
  ]
  grid.cells = new Map([
    [
      1,
      new Map([
        [1, "Sir Waddles"],
        [2, "1.200,50"]
      ])
    ],
    [
      2,
      new Map([
        [1, "lady Quackington"],
        [2, "12-"]
      ])
    ],
    [
      3,
      new Map([
        [1, "Bob"],
        [2, "300"]
      ])
    ]
  ])
  return grid
}

describe("Monitor controls: tree index and grid rows", () => {
  /** children, ancestors and the rows of expanded nodes */
  test("index", () => {
    const index = new TreeIndex(pond())
    assert.deepEqual(
      index.children("").map(node => node.id),
      ["ROOT"]
    )
    assert.deepEqual(
      index.children("PUDDLE").map(node => node.id),
      ["D1", "D2"],
      "the hidden duck stays out"
    )
    assert.deepEqual(index.ancestors("D1"), ["PUDDLE", "ROOT"])
    assert.ok(index.isExpandable("LATER") && index.isExpandable("ROOT") && !index.isExpandable("D1"))
    assert.deepEqual(
      index.visibleRows(new Set(["ROOT", "PUDDLE"])).map(row => row.id),
      ["ROOT", "DEEP", "PUDDLE", "D1", "D2"]
    )
    assert.deepEqual(
      index.visibleRows(new Set(["ROOT", "PUDDLE"])).map(row => row.depth),
      [0, 1, 1, 2, 2]
    )
    assert.deepEqual(new Set(index.expandableSubtree("ROOT")), new Set(["ROOT", "DEEP", "PUDDLE", "LATER"]))
    assert.equal(index.node("NOPE"), undefined)
  })

  /** a filter keeps the matches and their parents */
  test("filter", () => {
    const index = new TreeIndex(pond())
    const rows = index.filteredRows(node => node.text.toLowerCase().includes("waddles"))
    assert.deepEqual(
      rows.map(row => row.id),
      ["ROOT", "PUDDLE", "D1"]
    )
    assert.deepEqual(
      rows.map(row => row.isMatch),
      [false, false, true]
    )
    assert.equal(index.filteredRows(() => false).length, 0)
  })

  /** type-ahead finds the next node whose text starts with the typed text, wrapping */
  test("typeAhead", () => {
    const rows = new TreeIndex(pond()).visibleRows(new Set(["ROOT", "PUDDLE"]))
    assert.equal(TreeIndex.typeAhead("th", rows, undefined), 1)
    assert.equal(TreeIndex.typeAhead("th", rows, 1), 2)
    assert.equal(TreeIndex.typeAhead("th", rows, 2), 1)
    assert.equal(TreeIndex.typeAhead("LADY", rows, undefined), 4)
    assert.equal(TreeIndex.typeAhead("zz", rows, undefined), undefined)
    assert.equal(TreeIndex.typeAhead("", rows, undefined), undefined)
  })

  /** a tree of 50,000 nodes indexes and filters without a quadratic walk */
  test("largeTree", () => {
    const tree = new TreeModel()
    for (let folder = 0; folder < 500; folder++) {
      tree.nodes.push(new TreeNode({ id: `F${folder}`, parentKey: "", text: `Folder ${folder}`, isFolder: true }))
      for (let leaf = 0; leaf < 99; leaf++) {
        tree.nodes.push(new TreeNode({ id: `F${folder}L${leaf}`, parentKey: `F${folder}`, text: `Activity ${folder}-${leaf}` }))
      }
    }
    const started = performance.now()
    const index = new TreeIndex(tree)
    const rows = index.filteredRows(node => node.text.startsWith("Activity 42-"))
    assert.equal(rows.length, 100)
    assert.ok(performance.now() - started < 2000)
  })

  // MARK: Grid

  /** numbers sort by value, texts without regard to case, equal cells keep their order */
  test("sort", () => {
    const pondGrid = grid()
    assert.deepEqual(GridRows.sorted(pondGrid, pondGrid.rowNumbers, 2, true, true), [2, 3, 1])
    assert.deepEqual(GridRows.sorted(pondGrid, pondGrid.rowNumbers, 2, true, false), [1, 3, 2])
    assert.deepEqual(GridRows.sorted(pondGrid, pondGrid.rowNumbers, 1, false, true), [3, 2, 1])
    assert.deepEqual(GridRows.sorted(pondGrid, [1, 2, 3], 9, false, true), [1, 2, 3])
  })

  /** cell numbers: separators, signs, text */
  test("numbers", () => {
    assert.equal(GridRows.number("1.200,50"), 1200.5)
    assert.equal(GridRows.number("1,200.50"), 1200.5)
    assert.equal(GridRows.number("12-"), -12)
    assert.equal(GridRows.number("-3.5"), -3.5)
    assert.equal(GridRows.number("1.234"), 1234)
    assert.equal(GridRows.number("1,5"), 1.5)
    assert.equal(GridRows.number("1.234.567"), 1_234_567)
    assert.equal(GridRows.number("+7"), 7)
    assert.equal(GridRows.number(""), undefined)
    assert.equal(GridRows.number("quack"), undefined)
    assert.equal(GridRows.compare("10", "9", true), 1)
    assert.equal(GridRows.compare("10", "9", false), -1)
  })

  /** a filter keeps rows with a cell that contains the text; copy keeps the columns' order */
  test("filterAndCopy", () => {
    const pondGrid = grid()
    assert.deepEqual(GridRows.filtered(pondGrid, pondGrid.rowNumbers, "QUACK"), [2])
    assert.deepEqual(GridRows.filtered(pondGrid, pondGrid.rowNumbers, "  "), [1, 2, 3])
    assert.deepEqual(GridRows.cells(pondGrid, [3, 1], pondGrid.columns), [
      ["Bob", "300"],
      ["Sir Waddles", "1.200,50"]
    ])
  })
})

// Not in Swooey: the cases where JavaScript's own number and string handling differs from Swift's.
describe("Grid rows in TypeScript: Swift's numbers and string order", () => {
  /** `Double(text)` reads no number from nothing or a lone point, where `Number` reads 0 or NaN. */
  test("numbersWithoutDigits", () => {
    for (const text of ["...", ",", "-", "+", " - "]) assert.equal(GridRows.number(text), undefined, text)
    assert.equal(GridRows.number("5,"), 5)
    assert.equal(GridRows.number(",5"), 0.5)
  })

  /** Texts compare by Unicode scalars of their composed form, as Swift's `String` does. */
  test("stringOrder", () => {
    const text = String.fromCodePoint
    assert.equal(GridRows.compare(text(0x65, 0x301), text(0xe9), false), 0, "e with a combining acute is the composed e acute")
    assert.equal(GridRows.compare(text(0x1f986), text(0xff21), false), 1, "a scalar above U+FFFF sorts after U+FF21")
    assert.equal(GridRows.compare(" Duck ", "duck", false), 0, "spaces at the ends and case do not count")
  })
})
