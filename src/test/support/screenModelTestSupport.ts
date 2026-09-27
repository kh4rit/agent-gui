// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/ScreenModelTestSupport.swift (MIT).

// Shared helpers of the ScreenModel tests (Swift's `Fixtures`). The helpers that compiled a scenario
// of Tests/Scenarios in process (FakeScenarios' `ScenarioLibrary`, `ScreenBuilder`) are not ported:
// their screens come from the real fake server over TCP instead (src/test/support/screenSession.ts),
// asynchronously, and the tests that need them skip unless AGENT_GUI_FAKE_SERVER names the binary.

import assert from "node:assert/strict"
import {
  ApplItem,
  ClientMessageEncoder,
  DiagItemEncoder,
  DyntAtoms,
  type ClientIdentity,
  type ClientInputStep,
  type DyntAtom
} from "../../diag/codec/index.js"
import type { Screen, ScreenElement } from "../../diag/screen/index.js"
import { ByteWriter } from "../../diag/wire/index.js"
import { loadVector } from "../vectors/paths.js"
import type { VectorFile } from "../vectors/vectorFile.js"
import { atomValue } from "./elementScreenBuilder.js"
import { damSelectPart, gate, gateInput, inlineScreenItems, pondIdentity, pondTerminal, scenarioScreenItems, type DamPart } from "./screenSession.js"

export const Fixtures = {
  /**
   * The fake server does not look at CONNECT or SUPPORTDATA (PV-0700), and the values Swooey will
   * send are open (#16, #17, #18), so the tests send zeros. A fresh copy on every read.
   */
  get identity(): ClientIdentity {
    return pondIdentity()
  },

  /** An invented terminal name. */
  terminal: pondTerminal,

  encoder(): ClientMessageEncoder {
    return new ClientMessageEncoder(Fixtures.identity, Fixtures.terminal)
  },

  /**
   * The item sequence of a screen of a scenario (Swift `items(_:of:)`): from the fake server, over
   * TCP, reached by the scenario's rules; the parts of the Beaver Dam popup cut from `dam-select`.
   */
  items(screen: string, scenario = "duck-pond-logon"): Promise<Uint8Array> {
    if (scenario === "duck-pond-dam" && screen.startsWith("dam-") && screen !== "dam-select" && screen !== "dam-select-again") {
      return damSelectPart(screen as DamPart)
    }
    return scenarioScreenItems(screen, scenario)
  },

  /** The item sequence of the one screen of a `.screens` text (Swift `items(screens:)`): sent by the fake server. */
  screens(text: string): Promise<Uint8Array> {
    return inlineScreenItems(text)
  },

  /** One APPL4 DYNT_ATOM item holding `atoms`. */
  atomItem(atoms: Uint8Array): Uint8Array {
    const items = new ByteWriter()
    DiagItemEncoder.appendAPPL4(ApplItem.dynt("atom"), atoms, items)
    return items.toBytes()
  },

  /** The bytes of a spec vector, by its path relative to the repository root (Swift's `Tests/Vectors/…` is `test/vectors/…`). */
  vector(path: string): VectorFile {
    return loadVector(path.replace(/^Tests\/Vectors\//, "test/vectors/"))
  },

  /** The value of the step's DYNT_ATOM item, or undefined when it has none. */
  atomValue(step: ClientInputStep): Uint8Array | undefined {
    return atomValue(step)
  },

  /** The atoms of the step's DYNT_ATOM item, with the value they point into. */
  returnedAtoms(step: ClientInputStep): { atoms: DyntAtom[]; value: Uint8Array } {
    const value = atomValue(step)
    assert.ok(value !== undefined, "the step has a DYNT_ATOM item")
    const walk = DyntAtoms.walk(value)
    assert.equal(walk.error, undefined)
    assert.ok(walk.diagnostics.isClean)
    return { atoms: walk.atoms, value }
  },

  /** The text bytes of a returned atom. */
  text(atom: DyntAtom, value: Uint8Array): Uint8Array {
    const range = atom.textRange
    assert.ok(range !== undefined, "the atom has a text")
    return range.of(value).slice()
  },

  /** The screen the Duck Pond gate shows (from the fake server). */
  gate(): Promise<Screen> {
    return gate()
  },

  /** The input of the gate at `row` (the gate has one input per row). */
  input(screen: Screen, row: number): ScreenElement {
    return gateInput(screen, row)
  }
} as const
