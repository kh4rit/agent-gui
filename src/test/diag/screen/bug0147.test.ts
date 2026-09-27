// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0147Tests.swift (MIT).

// Issue #147: the owner's answer to a logon step while logged on elsewhere (PV-0986) held two
// window sections that both carried content: the logon screen again as the main window, and the
// multiple-logon question as a popup. Swooey read every content item of the message into the top
// window and drew 29 elements into one canvas. Reading R-EL-23, extended: content items belong to
// the section they follow; a popup gets only its own section's elements, containers and focus, and
// the main window's section is a screen of its own. The fake server's `duck-pond-paddling` plays
// the shape with invented texts (D15).
//
// The paddling question (duck-pond-paddling, reached by its logon step) and the Beaver Dam popup
// (duck-pond-dam) come from the real fake server over TCP (src/test/support/screenSession.ts), and
// the tests skip without it.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { GridPoint, Screen, ScreenPresentation, ScreenReadings } from "../../../diag/screen/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { skipWithoutFakeServer } from "../../support/screenSession.js"

/** The suite's static members (Swift `Bug0147Tests.paddleQuestion`). */
const Self = {
  /** The paddling question: the gate again as the main window, the question as a popup. */
  async paddleQuestion(readings: ScreenReadings = new ScreenReadings()): Promise<Screen> {
    return Screen.fromItems(await Fixtures.items("paddle-question", "duck-pond-paddling"), { readings })
  }
}

describe("Content per window section", () => {
  /** the popup gets only its own section's elements, radio group and containers (bug #147) */
  test("popupContent", { skip: skipWithoutFakeServer }, async () => {
    const screen = await Self.paddleQuestion()
    assert.ok(screen.identity.program === "SAPMSYST" && screen.identity.screenNumber === "4250")
    assert.equal(screen.elements.length, 10, screen.debugDescription)
    assert.ok(
      !screen.elements.some(element => (element.fieldName ?? "").startsWith("ZZPOND") || (element.fieldName ?? "").startsWith("ZZNOTICE")),
      "none of the gate's elements"
    )
    assert.equal(screen.containers.length, 0, "the gate's step loop is the main window's")
    assert.ok(screen.radioGroups.length === 1 && screen.radioGroups[0]?.members.length === 3)
    assert.equal(screen.diagnostics.atomsWithoutContainer, 0)
  })

  /** the main window's section is a screen of its own: the gate with its content, the inputs protected (bug #147) */
  test("mainWindowContent", { skip: skipWithoutFakeServer }, async () => {
    const screen = await Self.paddleQuestion()
    assert.equal(screen.lowerWindows.length, 1)
    const main = screen.mainWindowScreen
    assert.ok(main !== undefined)
    assert.deepEqual(main.presentation, ScreenPresentation.main)
    assert.ok(main.identity.program === "SAPMSYST" && main.identity.screenNumber === "4242")
    assert.equal(main.identity.title, "Welcome to the Duck Pond")
    assert.ok(main.size?.rows === 18 && main.size?.columns === 64)
    assert.equal(main.elements.length, 11, main.debugDescription)
    assert.ok(main.inputs.length === 3 && main.inputs.every(input => input.isProtected))
    assert.ok(!main.inputs.some(input => input.isPassword), "the secret quack's label came without its field")
    const loop = main.containers.find(container => container.kind === "loop")
    assert.ok(loop !== undefined)
    assert.equal(loop.id, 1)
    const line = main.elements.find(element => element.fieldName === "ZZNOTICE-LINE")
    assert.ok(line !== undefined)
    assert.deepEqual(line.placement, new GridPoint(2, 33), "placed at the loop's origin")
    assert.equal(main.radioGroups.length, 0)
    assert.ok(main.windowSections.length === 0 && main.lowerWindows.length === 0)
  })

  /** each section says whether it carries content, and how many elements (bug #147) */
  test("sectionCounts", { skip: skipWithoutFakeServer }, async () => {
    const sections = (await Self.paddleQuestion()).windowSections
    assert.ok(sections.length === 2)
    assert.ok(sections[0].hasContent && sections[0].elementCount === 11)
    assert.ok(sections[1].hasContent && sections[1].elementCount === 10)
  })

  /** a main section without content (the dam popup) leaves its window as it was (bug #147) */
  test("sectionWithoutContent", { skip: skipWithoutFakeServer }, async () => {
    const screen = Screen.fromItems(await Fixtures.items("dam-select", "duck-pond-dam"))
    assert.ok(screen.lowerWindows.length === 0 && screen.mainWindowScreen === undefined)
    assert.deepEqual(
      screen.windowSections.map(section => section.hasContent),
      [false, true]
    )
    assert.deepEqual(
      screen.windowSections.map(section => section.elementCount),
      [0, 10]
    )
    assert.equal(screen.elements.length, 10)
  })

  /** the fallback reads the message as one screen, as before R-EL-23 */
  test("wholeMessage", { skip: skipWithoutFakeServer }, async () => {
    const readings = new ScreenReadings()
    readings.windowSections = "wholeMessage"
    const screen = await Self.paddleQuestion(readings)
    assert.ok(screen.elements.length === 21 && screen.lowerWindows.length === 0)
  })
})
