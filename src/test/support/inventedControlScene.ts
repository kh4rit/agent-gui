// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/InventedControlScene.swift (MIT).

import { parseInteger } from "../../diag/codec/index.js"
import { InventedDataObject, InventedField, type InventedCell } from "./inventedDataObject.js"
import { InventedFlushCall, InventedFlushCallTable } from "./inventedFlushCall.js"

/** The automation records of one call, written in order (Swift `InventedControlScene.Recorder`). */
export class InventedControlSceneRecorder {
  descriptors: Uint8Array[] = []
  values: Uint8Array[] = []
  verbs: Uint8Array[] = []

  /** Appends a value record and returns its number (from 1). */
  record(name: string, value: string): number {
    this.values.push(InventedFlushCall.value(name, value.length === 0 ? "000000000" : "000000000" + (value.startsWith("O") ? "" : " ") + value))
    return this.values.length
  }

  /**
   * Appends a verb on record `target` with its arguments (type 12 text, 3 integer, 9 object) and,
   * when `result` is not undefined, a result record pre-filled with it; returns the result's record
   * number. A set-property verb's argument gets the three-column descriptor. An argument written
   * `O<n>-` points at record n, as the server points an object argument at the record an earlier
   * verb's result filled (rfc-tr.md §7.3).
   */
  verb(name: string, flag: string, target: number, args: [type: number, value: string][] = [], result?: string, resultName = "_RESULT"): number | undefined {
    this.verbs.push(InventedFlushCall.verb(target, name, flag))
    const group = this.verbs.length
    args.forEach(([type, value], index) => {
      let record: number
      const number = value.startsWith("O") && value.endsWith("-") ? parseInteger(value.slice(1, -1)) : undefined
      if (number !== undefined) record = number
      else record = this.record("", value)
      this.descriptors.push(InventedFlushCall.descriptor(flag === "S" ? `${group} ${type} ${record}` : `${group} ${type} #${index + 1} ${record}`))
    })
    if (result === undefined) return undefined
    const record = this.record(resultName, result)
    this.descriptors.push(InventedFlushCall.descriptor(`${group} 12 ${resultName} ${record}`))
    return record
  }
}

const { text, integer, short } = InventedField

/**
 * An invented flush call that builds a scene (docs/protocol/controls/scene.md): a container control
 * linked to the screen's custom container `ZZ_POND_CONTAINER`, a splitter of one row and two
 * columns, a tree of ponds in the left cell and a grid of ducks in the right one, with the tree's
 * node and item tables and the grid's catalog and cell packet as data objects, and the events and
 * cached properties the grid and the tree report. Every text and name is invented (D15), the
 * splitter's class name included; the verbs, the other class names, the parameters and the property
 * names are protocol identifiers.
 */
export const InventedControlScene = {
  containerName: "ZZ_POND_CONTAINER",
  gridTitle: "Ducks on the pond (3)",
  /** An invented splitter class: the scene knows a splitter by the word in its name. */
  splitterClass: "ZZ.PondSplitterShell",
  containerClass: "SAPGUI.CONTAINERCTRL.1",
  treeClass: "com.sap.components.controls.tree.SapTree",
  gridClass: "com.sap.components.controls.grid.SapGrid",
  providerClass: "com.sap.gui.beans.GuiDataProvider",
  onDemandClass: "SAP.DataPOnDemand.1",
  /** The cached properties the call registers for the grid, as the owner's server registered them for a list's grid (PV-1015). */
  gridProperties: ["CurrentCellCol", "CurrentCellRow", "FirstVisibleRow", "FirstVisibleRowID", "CurrentCellColID", "CurrentCellRowID", "CurrentCellText"],

  /** The tree's node table: two ponds, one with two ducks and a hidden one in it. */
  get nodes(): InventedDataObject {
    const object = new InventedDataObject(
      "SAPR3://ZZ_POND/NODES",
      [text(12), text(12), integer, text(1), text(1), text(1), text(46), text(46), integer, text(12), text(1), text(1), short],
      [
        ["Root", "", 0, "", "", "X", "", "", 0, "", "", "", 0],
        ["POND01", "Root", 6, "", "", "X", "", "", 0, "", "", "X", 1],
        ["POND02", "Root", 6, "", "", "X", "", "", 0, "", "", "", 1],
        ["DUCK01", "POND02", 6, "", "", "", "@0A@", "", 0, "", "", "", 1],
        ["DUCK02", "POND02", 6, "", "X", "", "", "", 0, "", "", "", 1],
        ["GHOST", "POND02", 6, "X", "", "", "", "", 0, "", "", "", 1]
      ],
      "TREEV_NODE"
    )
    object.id = "0001"
    object.sequence = 1
    return object
  },

  /** The item table: one text item per node. */
  get items(): InventedDataObject {
    const fields: InventedField[] = [
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
      text(300)
    ]
    const row = (key: string, value: string): InventedCell[] => [key, "1", 2, 2, "", "", "", 3, "", "", "", 0, 0, "", "", "", "", value]
    const object = new InventedDataObject(
      "SAPR3://ZZ_POND/ITEMS",
      fields,
      [
        row("Root", "Pond Menu"),
        row("POND01", "The Deep End"),
        row("POND02", "The Puddle"),
        row("DUCK01", "Mallard Mel"),
        row("DUCK02", "Quackers (retired)"),
        row("GHOST", "A duck nobody sees")
      ],
      "SBJTREEITM"
    )
    object.id = "0002"
    object.sequence = 2
    return object
  },

  /** The grid's catalog: three columns in the observed 26-field shape. */
  get catalog(): InventedDataObject {
    const fields: InventedField[] = [
      text(30),
      text(3),
      integer,
      text(40),
      integer,
      text(1),
      integer,
      integer,
      text(40),
      integer,
      integer,
      integer,
      text(1),
      integer,
      text(20),
      text(10),
      text(55),
      integer,
      integer,
      integer,
      integer,
      integer,
      integer,
      integer,
      integer,
      text(300)
    ]
    const column = (name: string, position: number, header: string, width: number, type: string): InventedCell[] => [
      name,
      "",
      position,
      header,
      width,
      "",
      0,
      32,
      header,
      0,
      0,
      0,
      type,
      width,
      header,
      header,
      header,
      position,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ""
    ]
    const object = new InventedDataObject("SAPR3://ZZ_POND/CATALOG", fields, [
      column("QUACKS", 3, "Quacks", 6, "I"),
      column("DUCK", 1, "Duck", 20, "C"),
      column("MOOD", 2, "Mood", 12, "C")
    ])
    object.id = "0003"
    object.sequence = 3
    // Raw rows, as a server sends small tables (PV-0934): the entry then spans several rows.
    object.raw = true
    return object
  },

  /** The grid's cell packet: three rows of three cells, each row led by its marker. */
  get cells(): InventedDataObject {
    const fields: InventedField[] = [
      integer,
      integer,
      integer,
      text(128),
      integer,
      integer,
      integer,
      integer,
      integer,
      text(1),
      integer,
      integer,
      integer,
      integer,
      integer,
      integer,
      integer
    ]
    const cell = (columnNumber: number, rowNumber: number, value: string): InventedCell[] => [
      columnNumber,
      rowNumber,
      0,
      value,
      0,
      0,
      0,
      0,
      0,
      "",
      0,
      0,
      1,
      0,
      0,
      0,
      0
    ]
    const ducks: [string, string, string][] = [
      ["Mallard Mel", "smug", "12"],
      ["Quackers", "damp", "3"],
      ["Sir Waddles", "regal", "40"]
    ]
    const rows: InventedCell[][] = []
    ducks.forEach((duck, index) => {
      rows.push(cell(-1, index + 1, `000000000${index + 1}`))
      rows.push(cell(1, index + 1, duck[0]))
      rows.push(cell(2, index + 1, duck[1]))
      rows.push(cell(3, index + 1, duck[2]))
    })
    const object = new InventedDataObject("SAPR3://ZZ_POND/CELLS", fields, rows)
    object.id = "0004"
    object.sequence = 4
    return object
  },

  /**
   * The call: shells 101 (container), 102 (splitter), 103 and 104 (its cells' containers), 105 (the
   * tree) and 106 (the grid), fed from the four data objects. With `columnPositionHandle`, an
   * on-demand object with that explicit Handle is bound to the grid's ColPosIDOnDemand (PV-1024).
   */
  call(columnPositionHandle?: number): InventedFlushCall {
    const scene = InventedControlScene
    const recorder = new InventedControlSceneRecorder()
    const root = recorder.verb("CreateObject", "C", 1, [
      [12, "{ZZ-POND-ROOT}"],
      [3, "1033"]
    ], "O1-")!
    recorder.verb("CreateControl", "C", root, [
      [3, "101"],
      [12, scene.containerClass],
      [3, "1342177280"],
      [3, "10"]
    ], "")
    recorder.verb("LinkContainer", "C", root, [
      [3, "101"],
      [12, scene.containerName]
    ])
    const splitter = recorder.verb("CreateControl", "C", root, [
      [3, "102"],
      [12, scene.splitterClass],
      [3, "1342177280"],
      [3, "101"]
    ], "")!
    recorder.verb("SetGrid", "C", splitter, [
      [3, "1"],
      [3, "2"]
    ], "")
    const leftCell = recorder.verb("GetContainer", "C", splitter, [
      [3, "1"],
      [3, "1"]
    ], "")!
    const left = recorder.verb("CreateControl2", "C", root, [
      [3, "103"],
      [12, scene.containerClass],
      [3, "1342177280"],
      [9, `O${leftCell}-`]
    ], "")!
    recorder.verb("AddControl", "C", splitter, [
      [3, "1"],
      [3, "1"],
      [9, `O${left}-`]
    ], "")
    const rightCell = recorder.verb("GetContainer", "C", splitter, [
      [3, "1"],
      [3, "2"]
    ], "")!
    recorder.verb("CreateControl2", "C", root, [
      [3, "104"],
      [12, scene.containerClass],
      [3, "1342177280"],
      [9, `O${rightCell}-`]
    ], "")
    recorder.verb("SetColumnWidth", "C", splitter, [
      [3, "1"],
      [3, "40"]
    ], "")
    const tree = recorder.verb("CreateControl", "C", root, [
      [3, "105"],
      [12, scene.treeClass],
      [3, "1409286144"],
      [3, "103"]
    ], "")!
    recorder.verb("ListDisplay", "S", tree, [[3, "1"]])
    for (const [url, method] of [
      [scene.nodes.url, "AddR3Table"],
      [scene.items.url, "AddItemTable"]
    ]) {
      const provider = recorder.verb("CreateObject", "C", 1, [
        [12, scene.providerClass],
        [3, "1033"]
      ], "O1-")!
      recorder.verb("SetDataFromUrl", "C", provider, [
        [12, "APPLICATION"],
        [12, "X-R3TABLE"],
        [12, url]
      ])
      const format = recorder.verb("GetDataAsFormat", "C", provider, [
        [12, ""],
        [12, ""]
      ], "O1-")!
      const data = recorder.verb("data", "G", format, [], "O1-")!
      recorder.verb(method, "C", tree, [[9, `O${data}-`]])
    }
    recorder.verb("ABAPExpandNodes", "C", tree, [
      [12, "Root"],
      [3, "0"]
    ])
    const grid = recorder.verb("CreateControl", "C", root, [
      [3, "106"],
      [12, scene.gridClass],
      [3, "1409286144"],
      [3, "104"]
    ], "")!
    recorder.verb("Title", "S", grid, [[12, scene.gridTitle]])
    const catalogProvider = recorder.verb("CreateObject", "C", 1, [
      [12, scene.providerClass],
      [3, "1033"]
    ], "O1-")!
    recorder.verb("SetDataFromUrl", "C", catalogProvider, [
      [12, "APPLICATION"],
      [12, "X-R3TABLE"],
      [12, scene.catalog.url]
    ])
    const catalogData = recorder.verb("GetDataAsFormat", "C", catalogProvider, [
      [12, "APPLICATION"],
      [12, "X-R3TABLE"]
    ], "O1-")!
    recorder.verb("AssignProperty2", "C", root, [
      [9, `O${catalogData}-`],
      [12, "data"],
      [12, `O${grid}-`],
      [12, "InfoTable"]
    ])
    const onDemand = recorder.verb("CreateObject", "C", 1, [
      [12, scene.onDemandClass],
      [3, "1033"]
    ], "O1-")!
    recorder.verb("Handle", "S", onDemand, [[3, "3"]])
    const cellProvider = recorder.verb("CreateObject", "C", 1, [
      [12, scene.providerClass],
      [3, "1033"]
    ], "O1-")!
    recorder.verb("SetDataFromUrl", "C", cellProvider, [
      [12, "APPLICATION"],
      [12, "X-R3TABLE"],
      [12, scene.cells.url]
    ])
    const cellFormat = recorder.verb("GetDataAsFormat", "C", cellProvider, [
      [12, "APPLICATION"],
      [12, "X-R3TABLE"]
    ], "O1-")!
    const cellData = recorder.verb("data", "G", cellFormat, [], "O1-")!
    recorder.verb("InsertPacket", "C", onDemand, [
      [3, "0"],
      [9, `O${cellData}-`]
    ])
    const table = recorder.verb("GetTable", "C", onDemand, [], "", "_RESULT_QUEUEONLY")!
    recorder.verb("AssignProperty2", "C", root, [
      [12, `O${table}-`],
      [12, ""],
      [12, `O${grid}-`],
      [12, "DataTableOnDemand"]
    ])
    if (columnPositionHandle !== undefined) {
      const positions = recorder.verb("CreateObject", "C", root, [
        [12, scene.onDemandClass],
        [3, "1033"]
      ], "O1-")!
      recorder.verb("Handle", "S", positions, [[3, `${columnPositionHandle}`]])
      const positionTable = recorder.verb("GetTable", "C", positions, [], "O1-")!
      recorder.verb("AssignProperty2", "C", root, [
        [9, `O${positionTable}-`],
        [12, "data"],
        [9, `O${grid}-`],
        [12, "ColPosIDOnDemand"]
      ])
    }
    // The events and cached properties the grid and the tree report (controls/events.md §4).
    recorder.verb("RegisterOcxEvent", "C", root, [
      [3, "106"],
      [3, "3"]
    ])
    for (const name of scene.gridProperties)
      recorder.verb("RegisterCachedProp", "C", root, [
        [3, "106"],
        [12, name]
      ])
    recorder.verb("RegisterOcxEvent", "C", root, [
      [3, "105"],
      [3, "25"]
    ])
    recorder.verb("RegisterCachedProp", "C", root, [
      [3, "105"],
      [12, "ABAPSelNodeKey"]
    ])

    const call = new InventedFlushCall({ descriptors: recorder.descriptors, values: recorder.values, verbs: recorder.verbs })
    call.tables[2] = new InventedFlushCallTable("RFC_QUEUE", 1853, [scene.nodes, scene.items, scene.catalog, scene.cells].flatMap(object => object.queueRows))
    return call
  }
} as const
