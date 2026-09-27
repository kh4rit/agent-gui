// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ApplRegistryTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplID, ApplItem, ApplSID, type ApplSIDTable } from "../../../diag/codec/index.js"

describe("APPL registry", () => {
  /** Each table's sids resolve through ApplItem and back, under the table's own id. */
  function checkTable<S extends string>(table: ApplSIDTable<S>, count: number, wrap: (sid: S) => ApplItem): void {
    const idByte = ApplID.rawValue(table.applID)
    assert.equal(table.allCases.length, count, ApplID.name(table.applID))
    const names = new Set<string>()
    for (const sid of table.allCases) {
      const item = ApplItem.of(idByte, table.rawValue(sid))
      assert.deepEqual(item, wrap(sid))
      assert.ok(ApplItem.id(item) === idByte && ApplItem.sid(item) === table.rawValue(sid))
      assert.equal(ApplItem.applID(item), table.applID)
      assert.equal(ApplItem.idName(item), ApplID.name(table.applID))
      assert.equal(ApplItem.sidName(item), table.name(sid))
      assert.ok(ApplItem.isRegistered(item))
      assert.equal(ApplID.sidName(table.applID, table.rawValue(sid)), table.name(sid))
      assert.equal(ApplItem.displayName(item), ApplID.name(table.applID) + " " + table.name(sid))
      names.add(table.name(sid))
    }
    assert.equal(names.size, count, "sid names are unique within a table")
    for (let byte = 0; byte <= 0xff; byte++) {
      if (table.fromRaw(byte) !== undefined) continue
      const item = ApplItem.of(idByte, byte)
      assert.deepEqual(item, ApplItem.unknownSID(table.applID, byte))
      assert.ok(ApplItem.id(item) === idByte && ApplItem.sid(item) === byte && ApplItem.sidName(item) === undefined && !ApplItem.isRegistered(item))
      assert.equal(ApplID.sidName(table.applID, byte), undefined)
    }
  }

  test("everySIDTable", () => {
    checkTable(ApplSID.Script, 4, ApplItem.script)
    checkTable(ApplSID.Graph, 2, ApplItem.graph)
    checkTable(ApplSID.Ixos, 3, ApplItem.ixos)
    checkTable(ApplSID.StUser, 37, ApplItem.stUser)
    checkTable(ApplSID.Dynn, 2, ApplItem.dynn)
    checkTable(ApplSID.StSystemInfo, 42, ApplItem.stSystemInfo)
    checkTable(ApplSID.Popu, 1, ApplItem.popu)
    checkTable(ApplSID.RfcTr, 12, ApplItem.rfcTR)
    checkTable(ApplSID.Dynt, 23, ApplItem.dynt)
    checkTable(ApplSID.Container, 12, ApplItem.container)
    checkTable(ApplSID.MnuEntry, 4, ApplItem.mnuEntry)
    checkTable(ApplSID.VarInfo, 15, ApplItem.varInfo)
    checkTable(ApplSID.Control, 1, ApplItem.control)
    checkTable(ApplSID.UIEvent, 1, ApplItem.uiEvent)
    checkTable(ApplSID.AccList, 2, ApplItem.accList)
    checkTable(ApplSID.Rcui, 9, ApplItem.rcui)
    checkTable(ApplSID.GuiPacket, 2, ApplItem.guiPacket)
  })

  test("theSeventeenIDs", () => {
    assert.equal(ApplID.allCases.length, 17)
    assert.deepEqual(
      ApplID.allCases.map(ApplID.rawValue),
      [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0e, 0x0f, 0x12, 0x13, 0x14]
    )
    assert.deepEqual(ApplID.allCases.map(ApplID.name), [
      "SCRIPT",
      "GRAPH",
      "IXOS",
      "ST_USER",
      "DYNN",
      "ST_R3INFO",
      "POPU",
      "RFC_TR",
      "DYNT",
      "CONTAINER",
      "MNUENTRY",
      "VARINFO",
      "CONTROL",
      "UI_EVENT",
      "ACC_LIST",
      "RCUI",
      "GUI_PACKET"
    ])
    for (const id of [0x00, 0x0d, 0x10, 0x11, 0x15, 0xff]) {
      const item = ApplItem.of(id, 0x02)
      assert.deepEqual(item, ApplItem.unknownID(id, 0x02))
      assert.ok(
        ApplItem.id(item) === id &&
          ApplItem.sid(item) === 0x02 &&
          ApplItem.applID(item) === undefined &&
          ApplItem.idName(item) === undefined &&
          ApplItem.sidName(item) === undefined
      )
    }
    assert.equal(ApplItem.displayName(ApplItem.of(0x0d, 0x01)), "id 0x0D sid 0x01")
    assert.equal(ApplItem.displayName(ApplItem.of(0x04, 0x0a)), "ST_USER sid 0x0A")
  })

  /**
   * Spot checks against the spec's tables and its named items (items.md, "Named items used in this
   * spec"; "Name collisions").
   */
  test("namedItemsAndCollisions", () => {
    assert.deepEqual(ApplItem.of(0x04, 0x02), ApplItem.stUser("connect"))
    assert.deepEqual(ApplItem.of(0x04, 0x0b), ApplItem.stUser("supportData"))
    assert.deepEqual(ApplItem.of(0x04, 0x26), ApplItem.stUser("dialogStepNumber"))
    assert.deepEqual(ApplItem.of(0x06, 0x23), ApplItem.stSystemInfo("codepageDiagGUI"))
    assert.deepEqual(ApplItem.of(0x06, 0x11), ApplItem.stSystemInfo("supportData"))
    assert.deepEqual(ApplItem.of(0x09, 0x02), ApplItem.dynt("atom"))
    assert.deepEqual(ApplItem.of(0x05, 0x01), ApplItem.dynn("chl"))
    assert.deepEqual(ApplItem.of(0x0c, 0x04), ApplItem.varInfo("okcode"))
    assert.equal(ApplItem.sidName(ApplItem.of(0x08, 0x00)), "RFC_TR_REQ", "RFC_TR's sids start at 0x00")
    assert.deepEqual(ApplItem.of(0x04, 0x0a), ApplItem.unknownSID("stUser", 0x0a), "ST_USER has no sid 0x0A")
    assert.deepEqual(ApplItem.of(0x0a, 0x07), ApplItem.unknownSID("container", 0x07))
    assert.deepEqual(ApplItem.of(0x0a, 0x0b), ApplItem.unknownSID("container", 0x0b))
    assert.equal(ApplItem.sidName(ApplItem.of(0x02, 0x03)), "GRAPH RELEASE 3")
    assert.equal(ApplItem.sidName(ApplItem.of(0x05, 0x03)), "XMLPROP DYNPRO")
    assert.equal(ApplItem.sidName(ApplItem.of(0x0a, 0x06)), "NAME")
    assert.equal(ApplItem.sidName(ApplItem.of(0x0c, 0x05)), "CONTAINER")
    assert.equal(ApplItem.sidName(ApplItem.of(0x0a, 0x0a)), "CONTROL")
    assert.equal(ApplItem.sidName(ApplItem.of(0x09, 0x05)), "TABLE_ROW_DAT_INPUT_DUMMY")
    assert.deepEqual(ApplSID.Dynt.allCases.filter(ApplSID.Dynt.isNamedByWiresharkOnly), ["tableFieldXMLProp", "splitterHeader"])
    assert.equal(ApplItem.sidName(ApplItem.of(0x06, 0x2a)), "STD_TOOLBAR_ITEMS")
    assert.equal(ApplItem.sidName(ApplItem.of(0x13, 0x09)), "RCUI_CONNECT_DATA")
  })
})
