// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0153Tests.swift (MIT).

// Issue #153: the owner's server refused a selection popup, a required field left out, with the
// popup's window section sent again without content (PV-0994) and an E message whose sentence was
// in ST_R3INFO MESSAGE and whose MESTYPE2 held only the field's label (PV-0995). Reading R-EL-23:
// the top window's section without content keeps what its window showed; Reading R-EL-14: the
// text is MESSAGE's, the type MESTYPE2's.
//
// The Beaver Dam screens and the lobby come from the real fake server over TCP
// (src/test/support/screenSession.ts), and those tests skip without it. Swift read every screen of
// beaver-dam.screens from duck-pond-dam compiled in process; `Fixtures.items` reaches only
// `dam-select`, `dam-select-again` and the popup's parts, so `dam-select-refused` and `dam-monitor`
// are reached here by the scenarios' own rules: `dam-select-refused` is duck-pond-dam-refused's
// answer to Enter on the popup (the same beaver-dam.screens), `dam-monitor` duck-pond-dam's answer
// to Execute (F8) on it, after the dam's control call, which the session answers by itself.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { FieldEdits, FunctionTrigger, Screen, ScreenMessageType, ScreenStatusMessage, ScreenStatusMessageID } from "../../../diag/screen/index.js"
import { Fixtures } from "../../support/screenModelTestSupport.js"
import { messageItems, screenOf, skipWithoutFakeServer, withPond, type Pond } from "../../support/screenSession.js"

/** The screens of beaver-dam.screens that `Fixtures.items` has no path to. */
type ReachedDamScreen = "dam-select-refused" | "dam-monitor"

const reached = new Map<ReachedDamScreen, Promise<Uint8Array>>()

/** The Beaver Dam popup, first sent: the lobby's command ZZDAM_MON after the logon. */
async function damSelect(pond: Pond): Promise<Screen> {
  const lobby = screenOf(await pond.logOn(await pond.first()))
  return screenOf(await pond.submit(lobby.inputStep(new FieldEdits(), FunctionTrigger.okCode("ZZDAM_MON")), "the dam popup"))
}

/** The item sequence of `name` as the fake server sends it, reached by the scenario's rules (cached per file). */
function reachedDamItems(name: ReachedDamScreen): Promise<Uint8Array> {
  let items = reached.get(name)
  if (items === undefined) {
    items =
      name === "dam-select-refused"
        ? // duck-pond-dam-refused: `on message * at dam-select send dam-select-refused`.
          withPond("duck-pond-dam-refused", async pond => {
            const select = await damSelect(pond)
            const refused = await pond.submit(select.inputStep(new FieldEdits(), FunctionTrigger.enter), "the refused popup")
            assert.ok(await pond.waitForLog("sent screen dam-select-refused"), pond.server.log.join("\n"))
            return messageItems(refused)
          })
        : // duck-pond-dam: `on vkey 8 at dam-select call dam-control then send dam-monitor`.
          withPond("duck-pond-dam", async pond => {
            const select = await damSelect(pond)
            const monitor = await pond.submit(select.inputStep(new FieldEdits(), FunctionTrigger.virtualKey(8)), "the monitor")
            assert.ok(await pond.waitForLog("sent screen dam-monitor"), pond.server.log.join("\n"))
            return messageItems(monitor)
          })
    reached.set(name, items)
  }
  return items
}

/** Swift `Bug0142Tests.damScreen`: a screen of beaver-dam.screens (duck-pond-dam). */
async function damScreen(name: string): Promise<Screen> {
  if (name === "dam-select-refused" || name === "dam-monitor") return Screen.fromItems(await reachedDamItems(name))
  return Screen.fromItems(await Fixtures.items(name, "duck-pond-dam"))
}

/** The suite's static members (Swift `Self.sentence`). */
const Self = {
  sentence: "Name a colony in the required field Beaver colony, the beavers will not guess"
}

describe("A popup refused with an error message keeps its fields", () => {
  /** the refused popup: two sections, the popup's without content; the status message is MESSAGE's sentence of MESTYPE2's type (bug #153) */
  test("refusedMessage", { skip: skipWithoutFakeServer }, async () => {
    const refused = await damScreen("dam-select-refused")
    assert.equal(refused.windowSections.length, 2)
    assert.equal(refused.windowSections[refused.windowSections.length - 1]?.hasContent, false)
    assert.equal(refused.elements.length, 0)
    assert.equal(refused.message, "E: " + Self.sentence)
    const message = refused.statusMessage
    assert.ok(message !== undefined)
    assert.deepEqual(message.type, ScreenMessageType.error)
    assert.equal(message.text, Self.sentence)
    assert.notEqual(message.id, undefined, "MESTYPE2's class and number")
  })

  /** MESSAGE led by MESTYPE2's type letter gives the text; any other MESSAGE leaves MESTYPE2's; either alone as before (bug #153) */
  test("messageText", () => {
    const typed = new ScreenStatusMessage({
      type: ScreenMessageType.warning,
      text: "Pond",
      id: new ScreenStatusMessageID({ messageClass: "ZZPOND", number: "042" })
    })
    const both = Screen.typedStatusMessage(typed, "W: The pond is deeper than it looks")
    assert.deepEqual(both, new ScreenStatusMessage({ type: ScreenMessageType.warning, text: "The pond is deeper than it looks", id: typed.id }))
    assert.deepEqual(Screen.typedStatusMessage(typed, "E: Not a warning"), typed, "another type's lead")
    assert.deepEqual(Screen.typedStatusMessage(typed, "Mind the swan"), typed, "no lead: R-EL-14 as before")
    assert.deepEqual(Screen.typedStatusMessage(typed, "W: "), typed, "a lead alone")
    assert.deepEqual(Screen.typedStatusMessage(typed, undefined), typed)
    assert.deepEqual(Screen.typedStatusMessage(typed, ""), typed)
    assert.deepEqual(Screen.typedStatusMessage(undefined, "Quack"), new ScreenStatusMessage({ type: ScreenMessageType.none, text: "Quack" }))
    assert.equal(Screen.typedStatusMessage(undefined, undefined), undefined)
  })

  /** the refused popup keeps the fields of the popup it names, with its own cursor on them (bug #153) */
  test("keepsContent", { skip: skipWithoutFakeServer }, async () => {
    const first = await damScreen("dam-select")
    const refused = await damScreen("dam-select-refused")
    assert.ok(refused.keepsContent(first))
    refused.keepContent(first)
    assert.deepEqual(refused.elements, first.elements)
    assert.deepEqual(refused.containers, first.containers)
    const colony = first.elements.find(element => element.fieldName === "ZZDAM-COLONY" && element.kind.kind === "input")
    assert.ok(colony !== undefined)
    assert.deepEqual(refused.cursor?.element, colony.id, "this message's cursor, on the kept field")
    assert.equal(refused.statusMessage?.text, Self.sentence, "its own message")
    assert.equal(refused.identity.title, first.identity.title)
  })

  /** no keep for a section with content, another screen, another level, or a message of one section (bug #153) */
  test("noKeep", { skip: skipWithoutFakeServer }, async () => {
    const first = await damScreen("dam-select")
    const refused = await damScreen("dam-select-refused")
    const again = await damScreen("dam-select-again")
    assert.ok(!again.keepsContent(first), "its section sent its fields")
    const lobby = Screen.fromItems(await Fixtures.items("pond-lobby"))
    assert.ok(!refused.keepsContent(lobby), "another level and program")
    const monitor = await damScreen("dam-monitor")
    assert.ok(!refused.keepsContent(monitor))
    assert.ok(!lobby.keepsContent(lobby), "no window sections")
  })
})
