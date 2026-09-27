// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DataManagerReportTests.swift (MIT).

// A client's DATAMANAGER document with events and control state (controls/events.md §4,
// PV-1013 to PV-1016), and the input step that carries it with the control focus. Every value is
// invented (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ClientDataManager,
  DataManagerControl,
  DataManagerFirstVisible,
  DataManagerReport,
  MarkupDocument
} from "../../../diag/codec/index.js"
import { ascii } from "../../support/codecTestSupport.js"

/** A double click in a grid (Swift `static let doubleClick`; a fresh value on every call). */
function doubleClick(): DataManagerReport {
  return new DataManagerReport({
    events: [{ shell: 106, event: 3, parameters: ["       0000000003", "DUCK", "3", "1", "0"] }],
    controls: [
      new DataManagerControl(
        106,
        [
          { name: "CurrentCellCol", value: "1" },
          { name: "CurrentCellText", value: "Sir Waddles" }
        ],
        DataManagerFirstVisible.origin
      )
    ]
  })
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe("A client's DATAMANAGER document: events, control state and the control focus", () => {
  /** an event and a control's state, in SAP GUI's elements and attribute order */
  test("document", () => {
    const expected =
      `<?xml version="1.0" encoding="sap*"?><DATAMANAGER><EVENTS><EVENT SHELLID="106" EVENTID="3">` +
      `<PARAM VALUE="       0000000003" PID="0"/><PARAM VALUE="DUCK" PID="1"/><PARAM VALUE="3" PID="2"/><PARAM VALUE="1" PID="3"/>` +
      `<PARAM VALUE="0" PID="4"/></EVENT></EVENTS><CONTROLS><CONTROL SHELLID="106"><PROPERTY VALUE="1" NAME="CurrentCellCol"/>` +
      `<PROPERTY VALUE="Sir Waddles" NAME="CurrentCellText"/><GENERIC FVRIDS="0" FVCID="1" FVRID="1"/></CONTROL></CONTROLS></DATAMANAGER>`
    assert.equal(text(doubleClick().document), expected)
    assert.deepEqual(new DataManagerReport().document, ClientDataManager.bareDocument, "nothing to report: the bare document")
    const stateOnly = new DataManagerReport({ controls: [new DataManagerControl(105, [{ name: "ABAPSelNodeKey", value: "DUCK01" }])] })
    assert.equal(
      text(stateOnly.document),
      `<?xml version="1.0" encoding="sap*"?><DATAMANAGER><CONTROLS><CONTROL SHELLID="105"><PROPERTY VALUE="DUCK01" NAME="ABAPSelNodeKey"/></CONTROL></CONTROLS></DATAMANAGER>`
    )
  })

  /** special and non-ASCII characters are written as references and read back as they were */
  test("escaping", () => {
    const value = "Caf\u{E9} <\"Quack\"> & 'co' \u{1F986}"
    assert.equal(DataManagerReport.escaped(value), "Caf&#233; &lt;&quot;Quack&quot;&gt; &amp; &apos;co&apos; &#129414;")
    const report = new DataManagerReport({ controls: [new DataManagerControl(7, [{ name: "CurrentCellText", value }])] })
    const read = DataManagerReport.read(MarkupDocument.read(report.document))
    assert.ok(read !== undefined)
    assert.deepEqual(read, report)
    assert.equal(DataManagerReport.text(ascii("&#x41;&bogus;&#;&")), "A&bogus;&#;&", "unknown references stay as they are")
  })

  /** a document read back: attributes in any order, unknown elements left out, a missing parameter empty */
  test("reading", () => {
    const document =
      `<?xml version="1.0" encoding="sap*"?><DATAMANAGER><EVENTS><EVENT EVENTID="25" SHELLID="105"><PARAM PID="2" VALUE="nest"/>` +
      `<PARAM VALUE="x"/></EVENT><EVENT SHELLID="POND" EVENTID="1"/></EVENTS><CONTROLS><CONTROL SHELLID="106">` +
      `<PROPERTY NAME="CurrentCellCol" VALUE="2"/><GENERIC FVRID="4" FVCID="2" FVRIDS="0"/></CONTROL></CONTROLS>` +
      `<TABLES><DATACHANGES HANDLE="12"><IT OP="C" IDX="0"/></DATACHANGES></TABLES></DATAMANAGER>`
    const report = DataManagerReport.read(MarkupDocument.read(ascii(document)))
    assert.ok(report !== undefined)
    assert.deepEqual(report.events, [{ shell: 105, event: 25, parameters: ["", "", "nest"] }], "an event without a numeric shell is left out")
    assert.equal(report.controls[0]?.property("CurrentCellCol"), "2")
    assert.deepEqual(report.controls[0]?.firstVisible, { rowSub: 0, column: 2, row: 4 })
    assert.equal(DataManagerReport.read(MarkupDocument.read(ascii("<POND/>"))), undefined)
  })

  // step: needs ClientInput.swift (next wave)
})
