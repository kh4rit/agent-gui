// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/MockAppsModelTests.swift (MIT).
//
// The Swift tests ran FakeScenarios' ScenarioSession in process; this port runs them against the
// real fake server over TCP (src/test/support/screenSession.ts) and skips without it, or when the
// server does not list the scenario of the five apps or cannot load it. duck-pond-apps is stateful, so every walk
// has a connection (and a server) of its own. The replies are the screens the client receives: the
// frames of a reply are told apart by the server's log, which names each frame it sent.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { isDeepStrictEqual } from "node:util"
import { PageKey } from "../../../diag/codec/index.js"
import {
  FieldEdits,
  FunctionReadings,
  FunctionTrigger,
  ScreenElementKind,
  ScreenInputError,
  ScreenMessageType,
  ScreenPick,
  ScreenStatusMessage,
  type Screen,
  type ScreenElement,
  type ScreenElementID,
  type ScreenFunction
} from "../../../diag/screen/index.js"
import type { ServerMessage } from "../../../diag/session/index.js"
import { throwsInfo } from "../../support/codecTestSupport.js"
import { startFakeServer } from "../../support/fakeServer.js"
import { fakeServerScenarios, screenOf, skipWithoutFakeServer, withPond, type Pond } from "../../support/screenSession.js"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Whether the scenario of the five apps is there (Swift's `hasApps`, which looked in Tests/Scenarios)
 * and this fake server loads it: the skip reason, with the server's error, when not. In process the
 * engine and the scenario files came from one checkout; the binary reads the Tests/Scenarios of the
 * checkout it was built from, which can have moved on since the build.
 */
async function appsMissing(): Promise<string | false> {
  if (skipWithoutFakeServer) return skipWithoutFakeServer
  if (!fakeServerScenarios().includes("duck-pond-apps")) return "the fake server has no scenario duck-pond-apps"
  try {
    const server = await startFakeServer("duck-pond-apps")
    await server.stop()
    return false
  } catch (error) {
    return `the fake server cannot load duck-pond-apps: ${error instanceof Error ? error.message : String(error)}`
  }
}

const skipWithoutApps = await appsMissing()

/** The labels of the frames the server logged as sent so far, in order ("screen apps-lobby"). */
function sentLabels(pond: Pond): string[] {
  return pond.server.log.flatMap(line => {
    const sent = /#\d+ sent (.*), \d+ bytes$/.exec(line)
    return sent === null ? [] : [sent[1]]
  })
}

/**
 * Waits until the server's log names every frame the client has read: the server logs a frame once
 * it has written it, so its line can come after the client read the frame.
 */
async function logCaughtUp(pond: Pond): Promise<void> {
  for (let wait = 0; wait < 200 && pond.sentFrames() < pond.session.diagnostics.messages; wait++) await sleep(5)
  assert.ok(pond.sentFrames() >= pond.session.diagnostics.messages, `the log names every frame read: ${pond.server.log.join("\n")}`)
}

/**
 * A connection to duck-pond-apps, logged on, and the screen it shows (Swift's `Pond`, which held a
 * `ScenarioSession` and the encoder of its connection: here the DiagSession writes the steps).
 */
class AppsPond {
  readings = new FunctionReadings()
  /** The last reply's screens, the base one first (a popup's `close` resends the base). */
  replies: Screen[] = []

  private constructor(
    readonly pond: Pond,
    public screen: Screen
  ) {}

  /** Writes the first message, reads the gate and logs on with Enter. */
  static async open(pond: Pond): Promise<AppsPond> {
    const apps = new AppsPond(pond, screenOf(await pond.first()))
    const edits = new FieldEdits()
    for (const input of apps.screen.inputs) {
      if (input.isPassword) continue
      edits.setText(input.maxLength === 3 ? "314" : "DK", input.id)
    }
    await apps.press(FunctionTrigger.enter, edits)
    return apps
  }

  /** Submits the screen with `trigger`, `edits` and `cursor`; the reply's last screen is the new one. */
  async press(trigger: FunctionTrigger, edits = new FieldEdits(), cursor?: ScreenElementID): Promise<ServerMessage[]> {
    const step = this.screen.inputStep(edits, trigger, { readings: this.readings, cursor })
    await logCaughtUp(this.pond)
    const sentBefore = sentLabels(this.pond).length
    const messages = await this.pond.reply(step)
    await logCaughtUp(this.pond)
    const output = sentLabels(this.pond).slice(sentBefore)
    assert.equal(output.length, messages.length, `each frame the server sent is one message read: ${output.join(", ")}`)
    this.replies = messages.filter((_, index) => output[index].startsWith("screen ")).map(message => screenOf(message))
    const last = this.replies.at(-1)
    if (last !== undefined) this.screen = last
    return messages
  }

  async command(code: string): Promise<void> {
    await this.press(FunctionTrigger.okCode(code))
  }

  /** The element with FNAME `name`, of `kind` when given. */
  field(name: string, kind?: ScreenElementKind): ScreenElement {
    const element = this.screen.elements.find(element => element.fieldName === name && (kind === undefined || isDeepStrictEqual(element.kind, kind)))
    assert.ok(element !== undefined, name)
    return element
  }

  /** The push button or tab function with `code`. */
  function(code: string): ScreenFunction {
    const found = this.screen.functions.find(f => f.code === code)
    assert.ok(found !== undefined, code)
    return found
  }

  get title(): string | undefined {
    return this.screen.identity.title
  }

  get message(): ScreenStatusMessage | undefined {
    return this.screen.statusMessage
  }

  get popupLevel(): number | undefined {
    const presentation = this.screen.presentation
    return presentation.kind === "popup" ? presentation.value.level : undefined
  }
}

/** Runs `body` on a fresh connection to duck-pond-apps, logged on. */
function withApps(body: (pond: AppsPond) => Promise<void>): Promise<void> {
  return withPond("duck-pond-apps", async pond => body(await AppsPond.open(pond)))
}

/** Every screen the apps' walks meet decodes without leftovers. */
function expectClean(screen: Screen, comment?: string): void {
  const diagnostics = screen.diagnostics
  assert.ok(diagnostics.undecodedElements === 0 && diagnostics.unmatchedTableAtoms === 0, comment)
  assert.ok(diagnostics.unmatchedListLines === 0 && diagnostics.duplicateRadioSelections === 0, comment)
  assert.ok(diagnostics.atomsWithoutContainer === 0, comment)
}

/**
 * The five Duck Pond apps end to end through the fake server (design §7, Phase 2): every reply is
 * decoded into a `Screen` with the element Readings, and every next step is that screen's own input
 * step, as the app builds it. The server and the model share the codec's encoder and decoder pairs
 * (docs/protocol/elements.md), so these walks show that what one writes the other reads. Everything
 * on the screens is invented (D15).
 */
describe("Mock apps: the model against the fake server", () => {
  // MARK: ZZQUACK_WIZ

  /** ZZQUACK_WIZ: required field, F4 pick, radios, checkboxes, dropdown, confirmation and info popups */
  test("quackWizard", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZQUACK_WIZ")
      assert.equal(pond.title, "Step 1 of 3: Name Your Quack")
      expectClean(pond.screen)
      const name = pond.field("ZZQUACK-NAME", ScreenElementKind.input)
      assert.ok(name.isRequired)
      assert.deepEqual(pond.screen.cursor?.element, name.id)
      const language = pond.field("ZZQUACK-LANG", ScreenElementKind.dropdown)
      assert.ok(language.dropdown?.selectedKey === "EN" && language.dropdown?.options.length === 4 && language.isRequired)
      assert.equal(pond.function("=ZZPREV").isEnabled, false, "Back is disabled on step 1 (R-EL-19)")

      // Continue with an empty name: E with the cursor on the name.
      await pond.press(FunctionTrigger.function(pond.function("=ZZNEXT")))
      assert.deepEqual(pond.message?.type, ScreenMessageType.error)
      assert.deepEqual(pond.screen.cursor?.element, pond.field("ZZQUACK-NAME", ScreenElementKind.input).id)

      // F4 on the style: the value-help popup, a list with hotspot keys; F2 on HONK picks it.
      const style = pond.field("ZZQUACK-STYLE", ScreenElementKind.input)
      assert.ok(style.hasValueHelp)
      await pond.press(FunctionTrigger.valueHelp(style.id))
      assert.equal(pond.popupLevel, 1)
      const list = pond.screen.list
      assert.ok(list !== undefined)
      expectClean(pond.screen)
      const honk = list.lines.find(line => line.segments[0]?.text === "HONK")
      assert.ok(honk !== undefined)
      assert.ok(honk.segments[0]?.isHotspot === true && honk.segments[0]?.color === "key")
      await pond.press(FunctionTrigger.choose(ScreenPick.list(honk.row, honk.segments[0].column)))
      assert.ok(pond.popupLevel === undefined && pond.title === "Step 1 of 3: Name Your Quack")
      assert.equal(pond.field("ZZQUACK-STYLE", ScreenElementKind.input).text, "HONK")
      assert.deepEqual(pond.message, new ScreenStatusMessage({ type: ScreenMessageType.success, text: "Style copied. Very stylish.", id: pond.message?.id }))

      // A name and German; step 2.
      const edits = new FieldEdits()
      edits.setText("Sir Honksalot", pond.field("ZZQUACK-NAME", ScreenElementKind.input).id)
      edits.setDropdownKey("DE", pond.field("ZZQUACK-LANG", ScreenElementKind.dropdown).id)
      await pond.press(FunctionTrigger.function(pond.function("=ZZNEXT")), edits)
      assert.equal(pond.title, "Step 2 of 3: Tune It")
      expectClean(pond.screen)
      const volume = pond.screen.radioGroups[0]
      assert.ok(volume !== undefined)
      assert.equal(volume.members.length, 4)
      const normal = volume.selected
      assert.ok(normal !== undefined)
      assert.equal(pond.screen.element(normal)?.caption, "Normal")

      // Loud and muted: W once, then step 3 with the values the server kept.
      const tune = new FieldEdits()
      const loud = volume.members.find(member => pond.screen.element(member)?.caption === "Loud")
      assert.ok(loud !== undefined)
      tune.select(loud)
      tune.setChecked(true, pond.field("ZZQUACK-MUTE", ScreenElementKind.checkbox).id)
      await pond.press(FunctionTrigger.function(pond.function("=ZZNEXT")), tune)
      assert.deepEqual(pond.message?.type, ScreenMessageType.warning)
      await pond.press(FunctionTrigger.function(pond.function("=ZZNEXT")))
      assert.equal(pond.title, "Step 3 of 3: Release")
      const summary = pond.screen.elements.flatMap(element => (element.caption === undefined ? [] : [element.caption]))
      assert.ok(summary.includes("Name: Sir Honksalot"))
      assert.ok(summary.includes("Style: HONK, in DE"))
      assert.ok(summary.some(caption => caption.startsWith("Volume: LOUD")))
      assert.ok(summary.some(caption => caption.includes("Muted: X")))

      // Release: a confirmation popup whose default button carries the cursor; Yes: the info popup.
      await pond.press(FunctionTrigger.function(pond.function("=ZZRELEASE")))
      assert.ok(pond.popupLevel === 1 && pond.title === "Release the Quack?")
      const yes = pond.function("=ZZYES")
      if (yes.kind.kind !== "pushButton") {
        assert.fail("Yes is no push button")
      }
      const yesButton = yes.kind.value
      assert.deepEqual(pond.screen.cursor?.element, yesButton, "the default button (R-EL-17)")
      await pond.press(FunctionTrigger.function(yes))
      assert.ok(pond.popupLevel !== undefined && pond.title === "Quack Released")
      await pond.press(FunctionTrigger.enter)
      assert.ok(pond.popupLevel === undefined && pond.screen.identity.program === "ZZ_DUCK_LOBBY")
      assert.ok(pond.message?.type.kind === "success" && pond.message?.text === "Quack 'Sir Honksalot' released.")
    })
  })

  /** ZZQUACK_WIZ: the Message Bakery's S, I, W, E, A and type-less messages */
  test("messageBakery", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZQUACK_WIZ")
      await pond.press(FunctionTrigger.function(pond.function("=ZZBAKERY")))
      assert.equal(pond.title, "The Message Bakery")
      const expected: [string, ScreenMessageType][] = [
        ["=ZZMSG_S", ScreenMessageType.success],
        ["=ZZMSG_W", ScreenMessageType.warning],
        ["=ZZMSG_E", ScreenMessageType.error]
      ]
      for (const [code, type] of expected) {
        await pond.press(FunctionTrigger.function(pond.function(code)))
        assert.deepEqual(pond.message?.type, type, code)
        assert.ok(pond.message?.id !== undefined, code)
        assert.ok(!ScreenMessageType.showsAsDialog(type))
      }
      assert.deepEqual(pond.screen.cursor?.element, pond.field("ZZBAKERY-INPUT", ScreenElementKind.input).id, "E puts the cursor on the field")

      await pond.press(FunctionTrigger.function(pond.function("=ZZMSG_I")))
      const information = pond.message?.type
      assert.ok(information?.kind === "information" && ScreenMessageType.showsAsDialog(information))
      await pond.press(FunctionTrigger.enter)
      assert.deepEqual(pond.message, new ScreenStatusMessage({ type: ScreenMessageType.success, text: "Back to baking.", id: pond.message?.id }))

      await pond.press(FunctionTrigger.function(pond.function("=ZZMSG_PLAIN")))
      assert.ok(isDeepStrictEqual(pond.message?.type, ScreenMessageType.none) && pond.screen.message === "A message without a type. How retro.")

      await pond.press(FunctionTrigger.function(pond.function("=ZZMSG_A")))
      assert.ok(pond.message?.type.kind === "abort" && pond.message?.text === "The wizard has fainted.")
      await pond.press(FunctionTrigger.enter)
      assert.equal(pond.screen.identity.program, "ZZ_DUCK_LOBBY")
    })
  })

  // MARK: ZZDUCK_HR

  /** ZZDUCK_HR: a server-paged tabstrip, radio groups, checkboxes, dropdowns and markers */
  test("duckFile", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZDUCK_HR")
      assert.equal(pond.title, "Duck Personnel File")
      const mode = pond.screen.radioGroups[0]
      assert.ok(mode !== undefined)
      const changing = mode.selected
      assert.ok(changing !== undefined)
      assert.ok(mode.members.length === 2 && pond.screen.element(changing)?.caption === "Changing things")
      const open = new FieldEdits()
      open.setText("D0003", pond.field("ZZDUCK-ID", ScreenElementKind.input).id)
      await pond.press(FunctionTrigger.function(pond.function("=ZZOPEN")), open)
      expectClean(pond.screen)
      const tabstrip = pond.screen.tabstrips[0]
      assert.ok(tabstrip !== undefined)
      assert.ok(tabstrip.tabs.length === 4 && tabstrip.activeIndex === 0)
      const page = tabstrip.pageArea
      assert.ok(page !== undefined)
      const pageElements = pond.screen.elements.filter(element => element.tabstripPage === tabstrip.id)
      assert.ok(pageElements.length > 0 && pageElements.every(element => element.atom.area === page))
      const hatched = pond.field("ZZDUCK-HATCHED", ScreenElementKind.input)
      assert.ok(hatched.isRequired && hatched.inputFormat === "date")
      const speciesOptions = pond.field("ZZDUCK-SPECIES", ScreenElementKind.dropdown).dropdown?.options
      assert.ok(speciesOptions !== undefined && speciesOptions.length > 0)

      // Change a checkbox and a dropdown, then switch to the second tab and back: the server kept them.
      const edits = new FieldEdits()
      const gluten = pond.field("ZZDUCK-GLUTEN", ScreenElementKind.checkbox)
      const allergic = gluten.isChecked
      assert.ok(allergic !== undefined)
      edits.setChecked(!allergic, gluten.id)
      edits.setDropdownKey("RUBR", pond.field("ZZDUCK-SPECIES", ScreenElementKind.dropdown).id)
      const second = tabstrip.tabs[1]
      assert.ok(second.functionCode !== undefined)
      await pond.press(FunctionTrigger.function(pond.function(second.functionCode)), edits)
      const switched = pond.screen.tabstrips[0]
      assert.ok(switched !== undefined)
      assert.equal(switched.activeIndex, 1)
      expectClean(pond.screen)
      const firstCode = switched.tabs[0].functionCode
      assert.ok(firstCode !== undefined)
      await pond.press(FunctionTrigger.function(pond.function(firstCode)))
      assert.equal(pond.screen.tabstrips[0]?.activeIndex, 0)
      assert.equal(pond.field("ZZDUCK-SPECIES", ScreenElementKind.dropdown).dropdown?.selectedKey, "RUBR")
      assert.equal(pond.screen.element(gluten.id)?.isChecked, !allergic)
    })
  })

  // MARK: ZZPOND_CFG

  /** ZZPOND_CFG: a long table with columns, keys, selector, paging, a scroll request and marks */
  test("pondCustomizer", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZPOND_CFG")
      expectClean(pond.screen)
      const table = pond.screen.tables[0]
      assert.ok(table !== undefined)
      assert.deepEqual(
        table.columns.map(column => column.fieldName),
        ["ZZSPOT-ID", "ZZSPOT-NAME", "ZZSPOT-DUCK", "ZZSPOT-QUOTA", "ZZSPOT-HEATED", "ZZSPOT-WATER", "ZZSPOT-SWAN", "ZZSPOT-DATE", "ZZSPOT-REMARK"]
      )
      const kind = ScreenElementKind
      assert.deepEqual(
        table.columns.map(column => column.kind),
        [kind.output, kind.input, kind.input, kind.input, kind.checkbox, kind.dropdown, kind.output, kind.input, kind.input]
      )
      assert.deepEqual(
        table.keyColumns.map(column => column.fieldName),
        ["ZZSPOT-ID"]
      )
      assert.ok(table.selection.mode === "multiple" && table.rows.length === 15)
      assert.ok(table.scroll.firstRow === 1 && table.scroll.totalRows === 1000 && table.scroll.visibleRows === 15)
      assert.ok(table.rows[0]?.line === 1 && table.rows.every(row => row.cells.length === 9 && row.selector !== undefined))

      // Page down with the cursor in the table: rows 16 to 30.
      const cell = table.rows[0].cells[1]
      assert.ok(cell !== undefined)
      await pond.press(FunctionTrigger.virtualKey(PageKey.rawValue("next")), undefined, cell)
      assert.equal(pond.screen.tables[0]?.scroll.firstRow, 16)
      assert.equal(pond.screen.tables[0]?.rows[0]?.line, 16)

      // A scroll request to row 500.
      await pond.press(FunctionTrigger.scrollTable(table.id, 500))
      const scrolled = pond.screen.tables[0]
      assert.ok(scrolled !== undefined)
      assert.ok(scrolled.scroll.firstRow === 500 && scrolled.rows[0]?.line === 500)

      // Mark two rows, then Drain: the confirmation popup.
      const marks = new FieldEdits()
      marks.setTableRowSelected(true, 500, table.id)
      marks.setTableRowSelected(true, 501, table.id)
      await pond.press(FunctionTrigger.virtualKey(14), marks)
      assert.equal(pond.popupLevel, 1)
      expectClean(pond.screen)
      await pond.press(FunctionTrigger.function(pond.function("=ZZYES")))
      assert.equal(pond.popupLevel, undefined)
      assert.equal(pond.screen.tables[0]?.scroll.totalRows, 998)
      assert.deepEqual(pond.message?.type, ScreenMessageType.success)
    })
  })

  // MARK: ZZBREAD_RPT

  /** ZZBREAD_RPT: a selection screen, then a classic list with header lines, paging and line selection */
  test("breadReport", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZBREAD_RPT")
      expectClean(pond.screen)
      assert.equal(pond.screen.radioGroups.length, 1)
      assert.ok(pond.screen.elements.some(element => element.kind.kind === "checkbox"))
      await pond.press(FunctionTrigger.virtualKey(8))
      const list = pond.screen.list
      assert.ok(list !== undefined)
      expectClean(pond.screen)
      assert.ok(list.headerLines.length > 0 && list.scroll.firstLine === 1)
      assert.ok(list.lines[0]?.index === 1 && list.lines.length === list.scroll.visibleLines)
      const total = list.scroll.totalLines
      assert.ok(total !== undefined)
      assert.ok(total > list.scroll.visibleLines)
      const colours = new Set(list.lines.flatMap(line => line.segments).map(segment => segment.color))
      assert.ok(colours.size >= 4)

      await pond.press(FunctionTrigger.virtualKey(PageKey.rawValue("next")))
      const second = pond.screen.list
      assert.ok(second !== undefined)
      assert.ok(second.scroll.firstLine === list.scroll.visibleLines + 1 && second.lines[0]?.index === second.scroll.firstLine)
      await pond.press(FunctionTrigger.virtualKey(PageKey.rawValue("last")))
      const last = pond.screen.list
      assert.ok(last !== undefined)
      assert.equal(last.lines.at(-1)?.index, total)

      const hotspot = last.lines.find(line => line.segments.some(segment => segment.isHotspot))
      assert.ok(hotspot !== undefined)
      const segment = hotspot.segments.find(segment => segment.isHotspot)
      assert.ok(segment !== undefined)
      await pond.press(FunctionTrigger.choose(ScreenPick.list(hotspot.row, segment.column)))
      assert.equal(pond.popupLevel, 1)
      expectClean(pond.screen)
    })
  })

  // MARK: ZZNEST_MON

  /** ZZNEST_MON: a display table, a dropdown and a checkbox that fire, refresh generations */
  test("nestMonitor", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZNEST_MON")
      expectClean(pond.screen)
      const table = pond.screen.tables[0]
      assert.ok(table !== undefined)
      assert.ok(table.columns.every(column => column.kind.kind === "output") && table.columns.every(column => column.isKey))
      assert.ok(table.rows.length === 12 && table.scroll.totalRows === 40)
      const filter = pond.field("ZZNEST-FILTER", ScreenElementKind.dropdown)
      assert.equal(filter.firesFunction, "=ZZFILTER")
      const blame = pond.field("ZZNEST-BLAME", ScreenElementKind.checkbox)
      assert.equal(blame.firesFunction, "=ZZBLAME")

      const edits = new FieldEdits()
      edits.setChecked(true, blame.id)
      await pond.press(FunctionTrigger.elementFunction(blame.id), edits)
      assert.equal(pond.message?.text, "The swan has been blamed. The swan does not care.")
      assert.equal(pond.screen.element(blame.id)?.isChecked, true)

      const red = new FieldEdits()
      red.setDropdownKey("@0A@", filter.id)
      await pond.press(FunctionTrigger.elementFunction(filter.id), red)
      assert.deepEqual(pond.message?.type, ScreenMessageType.success)
      const filtered = pond.screen.tables[0]
      assert.ok(filtered !== undefined)
      const totalRows = filtered.scroll.totalRows
      assert.ok(totalRows !== undefined)
      assert.ok(totalRows < 40)
      expectClean(pond.screen)

      await pond.press(FunctionTrigger.virtualKey(5))
      assert.equal(pond.message?.text, "Refreshed. 1 nest fixed itself; nobody knows how.")
    })
  })

  /** ZZDUCK_HR: Save checks every page and brings the failing field's tab; display mode protects every control */
  test("duckFileChecksAndDisplay", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZDUCK_HR")
      const open = new FieldEdits()
      open.setText("D0003", pond.field("ZZDUCK-ID", ScreenElementKind.input).id)
      await pond.press(FunctionTrigger.function(pond.function("=ZZOPEN")), open)
      const cleared = new FieldEdits()
      cleared.setText("", pond.field("ZZDUCK-HATCHED", ScreenElementKind.input).id)
      const notes = pond.screen.tabstrips[0]?.tabs.at(-1)?.functionCode
      assert.ok(notes !== undefined)
      await pond.press(FunctionTrigger.function(pond.function(notes)), cleared)
      assert.equal(pond.screen.tabstrips[0]?.activeIndex, 3)
      assert.equal(pond.screen.radioGroups.length, 1, "the Notes page's rating")
      await pond.press(FunctionTrigger.virtualKey(11))
      assert.deepEqual(pond.message?.type, ScreenMessageType.error)
      assert.equal(pond.screen.tabstrips[0]?.activeIndex, 0, "the failing field's page")
      assert.deepEqual(pond.screen.cursor?.element, pond.field("ZZDUCK-HATCHED", ScreenElementKind.input).id)
    })

    // A second connection: the scenario keeps its state per connection.
    await withApps(async display => {
      await display.command("ZZDUCK_HR")
      const reading = new FieldEdits()
      reading.setText("D0001", display.field("ZZDUCK-ID", ScreenElementKind.input).id)
      const mode = display.screen.radioGroups[0]
      assert.ok(mode !== undefined)
      const first = mode.members[0]
      assert.ok(first !== undefined)
      reading.select(first)
      await display.press(FunctionTrigger.function(display.function("=ZZOPEN")), reading)
      assert.equal(display.title?.endsWith("(display)"), true)
      const kinds = [ScreenElementKind.input, ScreenElementKind.checkbox, ScreenElementKind.radioButton, ScreenElementKind.dropdown]
      const controls = display.screen.elements.filter(element => kinds.some(kind => isDeepStrictEqual(kind, element.kind)))
      assert.ok(controls.length > 0 && controls.every(element => element.isProtected))
      const edit = new FieldEdits()
      const species = display.field("ZZDUCK-SPECIES", ScreenElementKind.dropdown)
      edit.setDropdownKey("EIDR", species.id)
      throwsInfo(() => display.screen.inputStep(edit, FunctionTrigger.enter), ScreenInputError, { kind: "notEditable", value: species.id })
    })
  })

  /** ZZNEST_MON: F2 on a row opens the detail popup, a restart nests a second popup */
  test("nestDetail", { skip: skipWithoutApps }, async () => {
    await withApps(async pond => {
      await pond.command("ZZNEST_MON")
      const table = pond.screen.tables[0]
      assert.ok(table !== undefined)
      const nest = table.rows[6]?.cells[1]
      assert.ok(nest !== undefined)
      await pond.press(FunctionTrigger.choose(ScreenPick.element(nest)))
      assert.equal(pond.popupLevel, 1)
      expectClean(pond.screen)
      await pond.press(FunctionTrigger.function(pond.function("=ZZRESTART")))
      assert.equal(pond.popupLevel, 2)
      await pond.press(FunctionTrigger.function(pond.function("=ZZNO")))
      assert.equal(pond.popupLevel, 1)
    })
  })
})
