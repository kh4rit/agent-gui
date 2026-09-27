// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import type { AgentScreen } from "../engine/agentScreen.js"
import { describeChange, formatScreen, plainText } from "../snapshot.js"

const pond: AgentScreen = {
  system: "PND",
  session: "S1",
  transaction: "ZZPOND_CFG",
  program: "ZZ_POND_CFG",
  screenNumber: "0100",
  title: "Customize the Pond: Overview",
  message: { type: "S", text: "Ducks counted: 57", id: "ZZ", number: "042" },
  functions: [
    { ref: "k1", text: "Enter", virtualKey: 0, where: "standard", enabled: true },
    { ref: "k2", text: "Save", key: "Ctrl+S", virtualKey: 11, where: "standard", enabled: true },
    { ref: "k3", text: "@0Y@New Entries", key: "F5", virtualKey: 5, where: "toolbar", enabled: true },
    { ref: "k4", text: "Print", key: "Ctrl+P", virtualKey: 86, where: "standard", enabled: false },
    { ref: "k5", text: "Quack all", code: "=ZZQUACK", where: "button", enabled: true },
    { ref: "k6", text: "Settings", virtualKey: 40, where: "menu", menuPath: ["Pond", "Extras"], enabled: true }
  ],
  fields: [
    { ref: "f1", kind: "label", text: "Pond", row: 2, column: 1, width: 10 },
    { ref: "f2", kind: "input", label: "Pond", name: "ZZV_RULES-POND", text: "001", row: 2, column: 15, width: 3, maxLength: 3, editable: true, required: true, valueHelp: true },
    { ref: "f3", kind: "input", label: "Secret quack", row: 3, column: 15, width: 8, editable: true, password: true },
    { ref: "f4", kind: "checkbox", text: "Frozen", checked: true, row: 4, column: 1, width: 10, editable: true },
    { ref: "f5", kind: "button", text: "", functionRef: "k5", row: 5, column: 1, width: 4 },
    { ref: "f10", kind: "input", text: "12", name: "ZZV_RULES-DUCKS", row: 8, column: 5, width: 3, editable: true, table: { ref: "t1", row: 1, column: 1 } }
  ],
  tables: [
    {
      ref: "t1",
      name: "ZZV_RULES",
      columns: [
        { title: "Pond", name: "ZZV_RULES-POND", key: true, width: 3 },
        { title: "Duck limit", name: "ZZV_RULES-DUCKS", width: 3 }
      ],
      rows: [
        { row: 1, selected: false, cells: ["001", "12"], cellRefs: [undefined, "f10"] },
        { row: 2, selected: true, cells: ["002", "7"], cellRefs: [undefined, "f11"] }
      ],
      firstRow: 1,
      visibleRows: 2,
      totalRows: 57,
      selectable: true
    }
  ],
  tabs: [],
  controls: [
    {
      ref: "c1",
      kind: "tree",
      area: "DOCK",
      tree: {
        nodes: [
          { key: "N1", text: "Duck Pond Guide", depth: 0, hasChildren: true, expanded: true },
          { key: "N2", text: "Define ponds", depth: 1, items: ["@0Y@", "Docs"] }
        ]
      }
    }
  ],
  cursor: "f2",
  logonScreen: false,
  notices: []
}

test("the compact snapshot names identity, message, functions, fields, tables and trees", () => {
  const text = formatScreen(pond)
  assert.match(text, /^S1 · PND · ZZPOND_CFG · ZZ_POND_CFG 0100/)
  assert.match(text, /message: S Ducks counted: 57 \(ZZ 042\)/)
  assert.match(text, /k2 Save \[Ctrl\+S\]/)
  assert.match(text, /k3 New Entries \[F5\]/)
  assert.doesNotMatch(text, /k4 Print/)
  assert.match(text, /1 disabled function not shown/)
  assert.match(text, /f2 input "Pond" \(ZZV_RULES-POND\) = "001"  \[required, F4, max 3\]/)
  assert.match(text, /f3 password "Secret quack"/)
  assert.match(text, /f4 checkbox \[x\] "Frozen"/)
  assert.match(text, /f5 button "Quack all" → k5/)
  // the label named as f2's label is left out
  assert.doesNotMatch(text, /f1 label/)
  // table cells show their references; the grid lists rows and marks
  assert.match(text, /table t1 ZZV_RULES: rows 1-2 of 57, rows can be marked \(gui_table t1 reads more\); a cell is t1:ROW:COLUMN/)
  assert.match(text, /\| row \| mark \| Pond \(ZZV_RULES-POND\)\* \| Duck limit \(ZZV_RULES-DUCKS\) \|/)
  assert.match(text, /\| 2 \| \[x\] \| 002 \| 7 \|/)
  assert.match(text, /\[-\] Duck Pond Guide  \{N1\}/)
  assert.match(text, /Define ponds  \{N2\}  \| Docs/)
  assert.doesNotMatch(text, /@0Y@/)
  // table cells do not appear again under fields
  assert.doesNotMatch(text, /f10 input/)
})

test("the full snapshot adds menus, disabled functions and positions", () => {
  const text = formatScreen(pond, { detail: "full" })
  assert.match(text, /Pond > Extras > k6 Settings/)
  assert.match(text, /k4 Print \[Ctrl\+P\] \(disabled\)/)
  assert.match(text, /f1 label "Pond" @2,1/)
})

test("icon codes are removed from texts", () => {
  assert.equal(plainText("@0Y@New Entries"), "New Entries")
  assert.equal(plainText("@0Y\\QCreate@"), "")
})

test("what changed", () => {
  const popup: AgentScreen = { ...pond, popup: { title: "Which pond?", level: 1 }, message: undefined }
  assert.equal(describeChange(pond, popup), 'popup opened "Which pond?"')
  assert.equal(describeChange(popup, { ...pond, message: undefined }), "popup closed")
  assert.match(describeChange(undefined, pond), /^screen ZZ_POND_CFG 0100; message S: Ducks counted: 57/)
  assert.equal(describeChange(pond, { ...pond, message: undefined }), "same screen")
})
