// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0166Tests.swift (MIT): the fillings of the pond's
// grid (Swift `Bug0166Tests.Filling`, `ducks`, `fewerDucks`) and the queue table that carries their
// data objects, which Bug0167Tests shares. Every name and text is invented (D15).

import { InventedControlScene } from "./inventedControlScene.js"
import type { InventedDataObject } from "./inventedDataObject.js"
import { InventedFlushCallTable, type InventedFlushCall } from "./inventedFlushCall.js"

/** One filling of the grid: its catalog, the empty packet and the packet with the rows. */
export interface GridFilling {
  catalog: InventedDataObject
  empty: InventedDataObject
  rows: InventedDataObject
}

/**
 * The Duck Pond's catalog (three columns) and its three rows of ducks, the rows after the
 * assignment. A fresh value on every call.
 */
export function ducks(): GridFilling {
  const empty = InventedControlScene.cells
  empty.url = "SAPR3://ZZ_POND/CELLS_EMPTY"
  empty.rows = []
  return { catalog: InventedControlScene.catalog, empty, rows: InventedControlScene.cells }
}

/** The grid filled again: two columns (the quacks left out) and one duck. */
export function fewerDucks(): GridFilling {
  const filling = ducks()
  filling.catalog.url = "SAPR3://ZZ_POND/CATALOG_AGAIN"
  filling.catalog.rows = filling.catalog.rows.slice(1)
  filling.empty.url = "SAPR3://ZZ_POND/CELLS_EMPTY_AGAIN"
  filling.rows.url = "SAPR3://ZZ_POND/CELLS_AGAIN"
  filling.rows.rows = filling.rows.rows.slice(0, 3)
  return filling
}

/**
 * Puts the fillings' data objects into `call`'s RFC_QUEUE table, numbered 1, 2, … in order (copies:
 * a filling given twice is two objects, as Swift's values are).
 */
export function queueFillings(call: InventedFlushCall, fillings: readonly GridFilling[]): void {
  const objects = fillings.flatMap(filling => [filling.catalog.clone(), filling.empty.clone(), filling.rows.clone()])
  objects.forEach((object, index) => {
    object.sequence = index + 1
    object.id = (index + 1).toString(16).toUpperCase().padStart(4, "0")
  })
  call.tables[2] = new InventedFlushCallTable(
    "RFC_QUEUE",
    1853,
    objects.flatMap(object => object.queueRows)
  )
}
