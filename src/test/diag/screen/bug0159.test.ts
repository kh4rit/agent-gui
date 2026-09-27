// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0159Tests.swift (MIT).

// Issue #159: a warehouse monitor's tree showed every node's text twice ("Outbound  Outbound").
// Its item table (the owner's dump of 2026-09-26, trial-derived, PV-1005) holds two items per node:
// item `1` with the node's text, and item `2`, a second column with an icon and the same text.
// Swooey joined every item's text into the node's label. The label is the first item's text.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ControlCall } from "../../../diag/codec/index.js"
import { TreeModel } from "../../../diag/screen/index.js"
import { InventedDataObject, InventedField, type InventedCell } from "../../support/inventedDataObject.js"

const { text, integer, short } = InventedField

/** A node table of two nodes and an item table with two items per node, the second with an icon. */
function tree(): TreeModel {
  const nodes = new InventedDataObject(
    "ZZ-NODES",
    [text(12), text(12), integer, text(1), text(1), text(1), text(46), text(46), integer, text(12), text(1), text(1), short],
    [
      ["POND", "", 0, "", "", "X", "", "", 0, "", "", "", 0],
      ["DUCK", "POND", 6, "", "", "", "", "", 0, "", "", "", 0]
    ],
    "TREEV_NODE"
  )
  const itemFields: InventedField[] = [
    text(12),
    text(12),
    integer,
    integer,
    text(1),
    text(1),
    text(1),
    integer,
    text(46),
    text(1),
    text(1),
    integer,
    integer,
    text(1),
    text(1),
    text(1),
    text(1),
    text(216)
  ]
  const item = (key: string, name: string, icon: string, label: string): InventedCell[] => [
    key,
    name,
    2,
    2,
    "",
    "",
    "",
    3,
    icon,
    "",
    "",
    0,
    0,
    "",
    "",
    "",
    icon.length === 0 ? "" : "X",
    label
  ]
  const items = new InventedDataObject(
    "ZZ-ITEMS",
    itemFields,
    [item("POND", "1", "", "Puddle"), item("POND", "2", "@0A@", "Puddle"), item("DUCK", "1", "", "Mallard Mel"), item("DUCK", "2", "@0A@", "Mallard Mel")],
    "ZZTREEITM"
  )
  const tree = new TreeModel()
  tree.addNodes(ControlCall.dataObject(nodes.stream, 1))
  tree.addItems(ControlCall.dataObject(items.stream, 2))
  return tree
}

describe("Issue #159: a tree node's label is its first item's text", () => {
  /** each node's label is its first item's text, once (bug #159) */
  test("firstItemOnly", () => {
    const pond = tree()
    assert.equal(pond.node("POND")?.text, "Puddle")
    assert.equal(pond.node("DUCK")?.text, "Mallard Mel")
  })

  /** items sent again replace the label instead of adding to it (bug #159) */
  test("itemsAgain", () => {
    const pond = tree()
    const again = new InventedDataObject("ZZ-ITEMS-2", [text(12), text(12), text(40)], [["DUCK", "1", "Mallard Mel, now dry"]], "ZZTREEITM")
    pond.addItems(ControlCall.dataObject(again.stream, 3))
    assert.equal(pond.node("DUCK")?.text, "Mallard Mel, now dry")
  })
})
