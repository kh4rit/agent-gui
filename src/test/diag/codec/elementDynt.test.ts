// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ElementDyntTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  CodecSpecGap,
  CursorContainerReading,
  DropdownReading,
  DyntAtomEncoder,
  DyntAtomEncodingError,
  DyntAttributes,
  DyntCombobox,
  DyntElementType,
  FieldMarkerReading,
  FieldMarkers,
  TabstripReading,
  ValueHelpReading,
  ZZValueList
} from "../../../diag/codec/index.js"
import { ascii, cat, throwsInfo, written } from "../../support/codecTestSupport.js"
import { field2Content, rawAtom, tabstripContent, u16BE, walkAtoms } from "../../support/dyntTestSupport.js"
import { bytesText, decodeCombobox, decodeTabs, elementHeader, encodeCombobox, encodeTab } from "../../support/elementTestSupport.js"

const etype = DyntElementType.of

/**
 * Dropdowns (elements.md Reading R-EL-3, invented), tabstrip buttons (R-EL-5), field markers
 * (R-EL-16) and the cursor's container ids (R-EL-17): encoder bytes, decoders and fallbacks.
 */
describe("Screen elements: dropdowns, tabs, markers", () => {
  // MARK: Dropdowns

  const water = new ZZValueList({
    values: [
      { key: "FRESH", text: "Fresh" },
      { key: "SOUP", text: "Duck soup (no!)" }
    ],
    functionCode: "=ZZFILTER"
  })

  test("valueListXML", () => {
    assert.equal(
      water.xml,
      `<ZZValueList empty="0" function="=ZZFILTER"><ZZValue key="FRESH">Fresh</ZZValue><ZZValue key="SOUP">Duck soup (no!)</ZZValue></ZZValueList>`
    )
    const empty = new ZZValueList({ values: [{ key: "A&B", text: `<Mud> & "puddles" 'n' stuff` }], allowsEmpty: true })
    assert.equal(
      empty.xml,
      `<ZZValueList empty="1"><ZZValue key="A&amp;B">&lt;Mud&gt; &amp; &quot;puddles&quot; &apos;n&apos; stuff</ZZValue></ZZValueList>`
    )
    assert.equal(
      empty.propertyText("Pick a puddle & paddle"),
      "<Propertybag><DefaultTooltip>Pick a puddle &amp; paddle</DefaultTooltip>" + empty.xml + "</Propertybag>"
    )
    assert.equal(water.propertyText(), "<Propertybag>" + water.xml + "</Propertybag>")
  })

  for (const tooltip of [undefined, "Where the ducks bathe"])
    test(`valueListRoundTrip(${tooltip})`, () => {
      const parsed = ZZValueList.fromPropertyText(water.propertyText(tooltip))
      assert.ok(parsed)
      assert.deepEqual(parsed, water)
      const escaped = new ZZValueList({ values: [{ key: "A&B", text: `<Mud> & "puddles"` }], allowsEmpty: true })
      assert.deepEqual(ZZValueList.fromPropertyText(escaped.propertyText()), escaped)
    })

  test("valueListLeniency", () => {
    const text =
      "<Propertybag>\n  <ZZValueList function='=ZZGO' empty=\"1\">\n    <ZZValue key='MUD'>Mostly &#109;ud &#x21;</ZZValue>\n  </ZZValueList>\n</Propertybag>"
    const parsed = ZZValueList.fromPropertyText(text)
    assert.ok(parsed)
    assert.deepEqual(parsed.values, [{ key: "MUD", text: "Mostly mud !" }])
    assert.ok(parsed.allowsEmpty)
    assert.equal(parsed.functionCode, "=ZZGO")
    const bare = ZZValueList.fromPropertyText('<Propertybag><ZZValueList empty="1"/></Propertybag>')
    assert.ok(bare)
    assert.ok(bare.values.length === 0 && bare.allowsEmpty && bare.functionCode === undefined)
    assert.equal(ZZValueList.fromPropertyText('<ZZValueList><ZZValue key="K">&bogus; &amp</ZZValue></ZZValueList>')?.values[0]?.text, "&bogus; &amp")
  })

  for (const text of [
    "<Propertybag><DefaultTooltip>Quack</DefaultTooltip></Propertybag>",
    "<Propertybag><ZZValueListing/></Propertybag>",
    '<ZZValueList><ZZValue key="A">no end',
    "<ZZValueList><ZZValue>keyless</ZZValue></ZZValueList>",
    '<ZZValueList><ZZValue key="A"/></ZZValueList>',
    "<ZZValueList empty=1></ZZValueList>",
    '<ZZValueList><ZZValue key="A">a<b</ZZValue></ZZValueList>',
    "<ZZValueList><Other/></ZZValueList>",
    '<ZZValueList empty="1"',
    ""
  ])
    test(`notAValueList(${JSON.stringify(text)})`, () => {
      assert.equal(ZZValueList.fromPropertyText(text), undefined)
    })

  const filter = rawAtom(126, { content: field2Content(ascii("ALL"), { mlen: 14, maxNrChars: 5 }), row: 2, col: 70, attr: 0xc0 })

  test("encodesCombobox", () => {
    const header = elementHeader(etype("combobox1"), 2, 70, { attributes: DyntCombobox.attributes })
    assert.deepEqual(encodeCombobox(header, { mlen: 14, maxNrChars: 5, key: "ALL" }), filter)
    throwsInfo(() => encodeCombobox(elementHeader(etype("efield2"), 1, 1), { mlen: 1, maxNrChars: 1, key: "A" }), DyntAtomEncodingError, {
      kind: "wrongElementType",
      value: etype("efield2")
    })
    throwsInfo(() => encodeCombobox(header, { mlen: 1, maxNrChars: 1, key: "K".repeat(256) }), DyntAtomEncodingError, {
      kind: "textTooLong",
      length: 256
    })
  })

  test("decodesCombobox", () => {
    const combobox = decodeCombobox(filter)
    assert.ok(combobox)
    assert.equal(combobox.field.dlen, 3)
    assert.equal(combobox.field.mlen, 14)
    assert.equal(bytesText(filter, combobox.field.textRange), "ALL")
    assert.notEqual(decodeCombobox(rawAtom(117, { content: field2Content(ascii("BAD")) })), undefined)
    assert.equal(decodeCombobox(rawAtom(126, { content: field2Content(ascii("BAD"), { dlen: 2 }) })), undefined)
    assert.equal(decodeCombobox(rawAtom(126, { content: [0, 0, 1] })), undefined)
    assert.equal(decodeCombobox(rawAtom(130, { content: field2Content(ascii("BAD")) })), undefined)
    assert.equal(decodeCombobox(filter, "specGap"), undefined)
    assert.equal(DropdownReading.allCases[0], "zzValueList")
  })

  // MARK: Tabstrips

  /**
   * The active tab "Personal" (`=ZZTAB_PERS`, short name `PERS`) of tabstrip 3, written by hand:
   * vlength 8, vheight 1, page 1, then the offsets of the function code (31), the caption (22) and
   * the short name (43), counted from the atom's first byte, then the three strings.
   */
  const personal = rawAtom(116, {
    content: cat([8, 1, 1], u16BE(31), u16BE(22), u16BE(43), ascii("Personal"), [0], ascii("=ZZTAB_PERS"), [0], ascii("PERS"), [0]),
    flags: [0x40, 0],
    area: 3,
    block: 1,
    row: 0,
    col: 2
  })
  const personalName = rawAtom(114, { content: ascii("ZZTAB-PERS"), area: 3, block: 1, row: 0, col: 2 })

  test("encodesTab", () => {
    const header = elementHeader(etype("tabstripButton"), 0, 2, { area: 3 })
    const bytes = encodeTab(header, { vLength: 8, pageID: 1, caption: "Personal", code: "=ZZTAB_PERS", short: "PERS", fieldName: "ZZTAB-PERS", active: true })
    assert.deepEqual(bytes, cat(personal, personalName))
    const inactive = encodeTab(header, { vLength: 8, pageID: 1, caption: "Personal", code: "=ZZTAB_PERS", short: "PERS", fieldName: undefined, active: false })
    assert.equal(inactive.length, personal.length)
    assert.equal(inactive[2], 0)
    throwsInfo(
      () =>
        encodeTab(elementHeader(etype("pushbutton2"), 0, 0), { vLength: 1, pageID: 1, caption: "A", code: "=A", short: "A", fieldName: undefined, active: false }),
      DyntAtomEncodingError,
      { kind: "wrongElementType", value: etype("pushbutton2") }
    )
    assert.throws(
      () => encodeTab(header, { vLength: 1, pageID: 1, caption: "Q".repeat(65_520), code: "=A", short: "A", fieldName: undefined, active: false }),
      DyntAtomEncodingError
    )
  })

  test("decodesTabs", () => {
    const job = encodeTab(elementHeader(etype("tabstripButton"), 0, 12, { area: 3 }), {
      vLength: 3,
      pageID: 2,
      caption: "Job",
      code: "=ZZTAB_JOB",
      short: "JOB",
      fieldName: undefined,
      active: false
    })
    const value = cat(personal, personalName, job)
    const buttons = decodeTabs(value)
    assert.ok(buttons)
    assert.equal(buttons.tabs.length, 2)
    assert.equal(buttons.walkError, undefined)
    const first = buttons.tabs[0]
    assert.ok(first.isActive)
    assert.ok(!first.isDisabled)
    assert.ok(first.offsetsCountFromAtomStart)
    assert.equal(bytesText(value, first.fieldNameRange), "ZZTAB-PERS")
    assert.equal(bytesText(value, first.button.functionCodeRange), "=ZZTAB_PERS")
    assert.equal(buttons.tabs[1].fieldNameRange, undefined)
    assert.ok(buttons.tabs[1].offsetsCountFromAtomStart)
    assert.ok(!buttons.tabs[1].isActive)
    assert.equal(buttons.activeIndex(3), 0)
    assert.equal(buttons.tabsInArea(4).length, 0)
    assert.equal(buttons.activeIndex(4), undefined)
  })

  test("tabEdgeCases", () => {
    const legacy = rawAtom(116, { content: tabstripContent({ text: ascii("Pond"), functionCode: ascii("=ZZP"), id: ascii("P") }), attr: 0x01 })
    const label = rawAtom(132, { content: field2Content(ascii("Not a tab")) })
    const value = cat(label, legacy, [0x00, 0x20])
    const buttons = decodeTabs(value)
    assert.ok(buttons)
    assert.equal(buttons.tabs.length, 1)
    assert.ok(!buttons.tabs[0].offsetsCountFromAtomStart)
    assert.ok(buttons.tabs[0].isDisabled)
    assert.notEqual(buttons.walkError, undefined)
    assert.equal(decodeTabs(personal, "specGap"), undefined)
    assert.equal(TabstripReading.allCases[0], "serverPaged")
  })

  // MARK: Field markers

  test("markers", () => {
    const all = FieldMarkers.of(0x0003, DyntAttributes.justRight | DyntAttributes.matchCode | DyntAttributes.yes3D)
    assert.equal(all, FieldMarkers.required | FieldMarkers.date | FieldMarkers.numeric | FieldMarkers.valueHelp)
    assert.equal(
      FieldMarkers.of(0x0003, DyntAttributes.justRight | DyntAttributes.matchCode, "attributesOnly"),
      FieldMarkers.numeric | FieldMarkers.valueHelp
    )
    assert.equal(FieldMarkers.of(0x0003, DyntAttributes.justRight | DyntAttributes.matchCode, "specGap"), 0)
    assert.equal(FieldMarkers.of(0, DyntAttributes.protected | DyntAttributes.yes3D), 0)
    assert.equal(FieldMarkers.of(0x0100, 0), 0)
    assert.equal(FieldMarkers.flag1(all), 0x0003)
    assert.equal(FieldMarkers.attributes(all), DyntAttributes.justRight | DyntAttributes.matchCode)
    assert.equal(FieldMarkers.dialogFlag1(all), 0x24)
    const none: FieldMarkers = 0
    assert.ok(FieldMarkers.flag1(none) === 0 && FieldMarkers.attributes(none) === 0 && FieldMarkers.dialogFlag1(none) === 0)
    assert.equal(FieldMarkerReading.allCases[0], "flag1Bits")
  })

  test("markersRoundTrip", () => {
    const markers = FieldMarkers.required | FieldMarkers.date
    const header = elementHeader(etype("efield2"), 4, 20, { attributes: FieldMarkers.attributes(markers), flags: [FieldMarkers.dialogFlag1(markers), 0] })
    const bytes = written(output =>
      DyntAtomEncoder.appendField(header, { flag1: FieldMarkers.flag1(markers), mlen: 10, maxNrChars: 10, text: ascii("01.04.2026") }, output)
    )
    const atom = walkAtoms(bytes).atoms[0]
    assert.ok(atom)
    assert.equal(atom.payload.kind, "field", "not a field")
    if (atom.payload.kind !== "field") return
    assert.equal(FieldMarkers.of(atom.payload.value.flag1, atom.attributes), markers)
  })

  // MARK: Value help and the cursor

  test("valueHelpAndCursor", () => {
    assert.equal(ValueHelpReading.functionNumber, 4)
    assert.equal(ValueHelpReading.allCases[0], "functionKey4")
    assert.deepEqual(CursorContainerReading.containerIDs("area", 4), [4])
    // needs InputEnvelope.swift (other wave): `containerIDs(area: 0) == InputFocus.containerIDs` and
    // `alwaysZero.containerIDs(area: 4) == InputFocus.containerIDs`; InputFocus.containerIDs is [0].
    assert.deepEqual(CursorContainerReading.containerIDs("area", 0), [0])
    assert.deepEqual(CursorContainerReading.containerIDs("alwaysZero", 4), [0])
    assert.equal(CursorContainerReading.allCases[0], "area")
  })

  test("gapIssues", () => {
    assert.deepEqual(
      [
        CodecSpecGap.toggleElements,
        CodecSpecGap.dropdownValues,
        CodecSpecGap.tabstripPages,
        CodecSpecGap.tableControlItems,
        CodecSpecGap.listOutput,
        CodecSpecGap.popups,
        CodecSpecGap.statusMessageTypes,
        CodecSpecGap.valueHelp,
        CodecSpecGap.fieldMarkers
      ],
      [107, 108, 109, 110, 111, 112, 113, 114, 115]
    )
  })
})
