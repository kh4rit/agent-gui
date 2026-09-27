// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/DyntTabstripVectorKeysTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { PENDING_KINDS } from "../../vectors/kinds.js"
import { runVector } from "../../vectors/registry.js"
import { VectorFile } from "../../vectors/vectorFile.js"

/**
 * Task #42: the dynt-atoms runner asks a tabstrip-button (116) vector only for the keys
 * test/vectors/README.md ("dynt-atoms") gives it. The README gives the text keys to FNAME (114),
 * XMLPROP (120), frame (127) and the field variants (121–123, 130–132) only, so a 116 vector
 * written to it carries the header, content and error keys and nothing else.
 */
describe("DYNT vector runner: tabstrip-button keys", () => {
  /**
   * One 116 atom (dynt-atoms.md, "Buttons (115, 116)", PV-0656): a tab of an invented siesta
   * planner, caption "Nap", function code "ZZSNOOZE", id "T9". Built inline, because implementers
   * never add files under the spec-owned test/vectors.
   */
  const readmeConformantVector = [
    "# source: spec",
    "# spec: docs/protocol/dynt-atoms.md#buttons-115-116",
    "# provenance: PV-0140, PV-0602, PV-0603, PV-0630, PV-0656",
    "# kind: dynt-atoms",
    "# description: A tabstrip-button (116) atom with caption Nap, function code ZZSNOOZE and id T9.",
    "# derivation: atom_length 38 = 13 header + 9 fixed payload bytes + 4 + 9 + 3 string bytes; three NUL-terminated strings from payload offset 9.",
    "# expect.atoms: 1",
    "# expect.atom.1.etype: 116",
    "# expect.atom.1.length: 38",
    "# expect.atom.1.dlg_flag_1: 0x00",
    "# expect.atom.1.dlg_flag_2: 0x00",
    "# expect.atom.1.area: 0",
    "# expect.atom.1.block: 1",
    "# expect.atom.1.group: 2",
    "# expect.atom.1.row: 0",
    "# expect.atom.1.col: 4",
    "# expect.atom.1.attr: 0x00",
    "# expect.atom.1.attr.names: none",
    "# expect.atom.1.content_offset: 13",
    "# expect.atom.1.content_length: 25",
    "# expect.error: none",
    "hex:",
    "00 26                     # atom_length 38",
    "00 00                     # dlg_flag_1, dlg_flag_2",
    "74                        # etype 116 (tabstrip button)",
    "00 01 02                  # area, block, group",
    "00 00                     # row 0",
    "00 04                     # col 4",
    "00                        # attribute",
    "0C 01 03                  # v_length 12, v_height 1, page_id 3",
    "00 00 00 00 00 00         # function_code_offset, text_offset, id_offset (numbers only)",
    "4E 61 70 00               # text \"Nap\"",
    "5A 5A 53 4E 4F 4F 5A 45 00  # function code \"ZZSNOOZE\"",
    "54 39 00                  # id \"T9\""
  ].join("\n")

  /** The vector above, as the README defines it, passes: the runner asks for no text keys (bug #42). */
  test("readmeConformantTabstripVectorPasses", () => {
    const vector = VectorFile.parse(readmeConformantVector, "tabstrip-button")
    assert.deepEqual(runVector(vector, PENDING_KINDS), { status: "passed" })
  })
})
