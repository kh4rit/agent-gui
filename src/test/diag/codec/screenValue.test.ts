// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/ScreenValueTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  ApplItem,
  AreaSize,
  CodecSpecGap,
  ContainerGeometry,
  ContainerLoop,
  ContainerName,
  DyntFocus,
  FontMetric,
  InternalModeEntry,
  InternalModeUUID,
  InternalModeUUIDs,
  ItemPayloadError,
  KernelVersion,
  ListFocus,
  ScreenValue,
  ScreenValueEncodingError,
  ScreenValueLayout,
  ScrollInfos,
  ScrollInfos2,
  appendKernelVersion,
  byteRange
} from "../../../diag/codec/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"
import { ascii, bytes, cat, throwsInfo, u32BE, written } from "../../support/codecTestSupport.js"
import { u16BE } from "../../support/dyntTestSupport.js"
import { rawAreaSize } from "../../support/screenTestSupport.js"

/**
 * The fixed-size and content-sized screen values of server-screen.md §5.2, §8.3–§8.6, each checked
 * against bytes written by hand from the spec's tables.
 */
describe("Screen values", () => {
  // MARK: Fixed-size layouts

  test("areaSizeReadsFourBigEndianWords", () => {
    const input = rawAreaSize(0x01020304, 80, 21, 0xffffffff)
    const size = AreaSize.decode(input)
    assert.deepEqual(size, new AreaSize({ windowHeight: 0x01020304, windowWidth: 80, areaHeight: 21, areaWidth: 0xffffffff }))
    assert.deepEqual(
      written(output => size.append(output)),
      input
    )
  })

  test("fontMetricReadsFourBigEndianHalfwords", () => {
    const input = cat(u16BE(17), u16BE(0x0809), u16BE(16), u16BE(9))
    const metric = FontMetric.decode(input)
    assert.deepEqual(metric, new FontMetric({ variableY: 17, variableX: 0x0809, fixedY: 16, fixedX: 9 }))
    assert.deepEqual(
      written(output => metric.append(output)),
      input
    )
  })

  test("containerGeometryReadsIDAndFourHalfwords", () => {
    const input = cat([0xfe], u16BE(258), u16BE(772), u16BE(1286), u16BE(1800))
    const geometry = ContainerGeometry.decode(input)
    assert.deepEqual(geometry, new ContainerGeometry({ containerID: 0xfe, row: 258, col: 772, width: 1286, height: 1800 }))
    assert.deepEqual(
      written(output => geometry.append(output)),
      input
    )
  })

  test("scrollInfosAndScrollInfos2ShareTheirFirstSixWords", () => {
    const six = cat(u32BE(500), u32BE(132), u32BE(480), u32BE(120), u32BE(40), u32BE(0x0a0b0c0d))
    const scroll = ScrollInfos.decode(six)
    assert.deepEqual(
      scroll,
      new ScrollInfos({ totalHeight: 500, totalWidth: 132, dataHeight: 480, dataWidth: 120, heightOffset: 40, widthOffset: 0x0a0b0c0d })
    )
    const input = cat(six, u32BE(18), u32BE(80), [0x5a])
    const scroll2 = ScrollInfos2.decode(input)
    assert.deepEqual(scroll2, new ScrollInfos2({ scroll, visibleHeight: 18, visibleWidth: 80, scrollFlag: 0x5a }))
    assert.deepEqual(
      written(output => scroll2.append(output)),
      input
    )
    assert.deepEqual(
      written(output => scroll.append(output)),
      six
    )
  })

  test("containerLoopAndListFocus", () => {
    assert.deepEqual(ContainerLoop.decode(u16BE(0x0102)), new ContainerLoop({ linesPerLoopRow: 0x0102 }))
    const focus = ListFocus.decode(cat([7], u16BE(300), u16BE(0x0203)))
    assert.deepEqual(focus, new ListFocus({ version: 7, row: 300, col: 0x0203 }))
    const output = new ByteWriter()
    new ContainerLoop({ linesPerLoopRow: 2 }).append(output)
    focus.append(output)
    assert.deepEqual(output.toBytes(), cat(u16BE(2), [7], u16BE(300), u16BE(0x0203)))
  })

  /** IMPL-SS-3: one byte short is `truncated`, one byte over is `overlong`, for every layout. */
  test("everyLayoutDecodesExactlyItsSize", () => {
    for (const layout of ScreenValueLayout.allCases) {
      const size = ScreenValueLayout.size(layout)
      const exact = Uint8Array.from({ length: size }, (_, index) => (index * 37 + 1) & 0xff)
      const value = ScreenValue.decode(layout, exact)
      assert.equal(ScreenValue.layout(value), layout)
      assert.deepEqual(ScreenValue.bytes(value), exact)
      throwsInfo(() => ScreenValue.decode(layout, exact.slice(0, -1)), ItemPayloadError, { kind: "truncated", needed: size, available: size - 1 })
      throwsInfo(() => ScreenValue.decode(layout, cat(exact, [0])), ItemPayloadError, { kind: "overlong", expected: size, actual: size + 1 })
      throwsInfo(() => ScreenValue.decode(layout, new Uint8Array(0)), ItemPayloadError, { kind: "truncated", needed: size, available: 0 })
    }
  })

  test("layoutSizesAreTheSpecsSizes", () => {
    const sizes: Record<ScreenValueLayout, number> = {
      areaSize: 16,
      fontMetric: 8,
      containerGeometry: 9,
      scrollInfos: 24,
      scrollInfos2: 33,
      containerLoop: 2,
      listFocus: 5
    }
    for (const layout of ScreenValueLayout.allCases) assert.equal(ScreenValueLayout.size(layout), sizes[layout], layout)
  })

  /** Dispatch on (id, sid) alone: exactly the pairs of server-screen.md §8 have a fixed layout. */
  test("layoutDispatchCoversExactlyTheSpecifiedPairs", () => {
    const expected = new Map<string, ScreenValueLayout>(
      (
        [
          [ApplItem.varInfo("areaSize"), "areaSize"],
          [ApplItem.varInfo("areaPixelSize"), "areaSize"],
          [ApplItem.stUser("wsize"), "areaSize"],
          [ApplItem.stUser("fontMetric"), "fontMetric"],
          [ApplItem.container("reset"), "containerGeometry"],
          [ApplItem.container("loop"), "containerGeometry"],
          [ApplItem.container("table"), "containerGeometry"],
          [ApplItem.container("tabstrip"), "containerGeometry"],
          [ApplItem.container("tabstripPage"), "containerGeometry"],
          [ApplItem.container("control"), "containerGeometry"],
          [ApplItem.container("subscreen"), "containerGeometry"],
          [ApplItem.varInfo("scrollInfos"), "scrollInfos"],
          [ApplItem.varInfo("scrollInfos2"), "scrollInfos2"],
          [ApplItem.varInfo("containerLoop"), "containerLoop"],
          [ApplItem.varInfo("listFocus"), "listFocus"]
        ] as [ApplItem, ScreenValueLayout][]
      ).map(([item, layout]) => [ApplItem.displayName(item), layout])
    )
    const found = new Map<string, ScreenValueLayout>()
    for (let id = 0; id <= 0xff; id++)
      for (let sid = 0; sid <= 0xff; sid++) {
        const item = ApplItem.of(id, sid)
        const layout = ScreenValueLayout.of(item)
        if (layout !== undefined) found.set(ApplItem.displayName(item), layout)
      }
    assert.deepEqual(found, expected)
    // Pairs neither source decodes have no layout (#33).
    assert.ok(ScreenValueLayout.of(ApplItem.container("default")) === undefined && ScreenValueLayout.of(ApplItem.varInfo("mainAreaPixelSize")) === undefined)
  })

  // MARK: IMODEUUIDS2

  const uuidA = bytes(0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xf0, 0x0d, 0xba, 0xad, 0xf0, 0x0d, 0xde, 0xca, 0xfb, 0xad)
  const uuidB = Uint8Array.from({ length: 16 }, (_, index) => 0x10 + index)

  test("internalModeUUIDsReadCountedEntries", () => {
    const input = cat([2], uuidA, [0], uuidB, [1])
    const uuids = InternalModeUUIDs.decode(input)
    assert.equal(uuids.count, 2)
    assert.deepEqual(uuids.entryRange(0), byteRange(1, 18))
    assert.deepEqual(uuids.entryRange(1), byteRange(18, 35))
    const first = uuids.entry(0, input)
    const second = uuids.entry(1, input)
    assert.ok(first.activeContext === 0)
    assert.deepEqual(first.uuid.bytes, uuidA)
    assert.ok(second.activeContext === 1)
    assert.deepEqual(second.uuid.bytes, uuidB)
    assert.deepEqual(first.uuid, new InternalModeUUID({ high: 0xdeadbeefcafef00dn, low: 0xbaadf00ddecafbadn }))
    assert.deepEqual(
      written(output => InternalModeUUIDs.append([first, second], output)),
      input
    )
    assert.equal(InternalModeUUIDs.decode(bytes(0)).count, 0)
  })

  test("internalModeUUIDsCheckTheirLength", () => {
    throwsInfo(() => InternalModeUUIDs.decode(new Uint8Array(0)), ItemPayloadError, { kind: "truncated", needed: 1, available: 0 })
    throwsInfo(() => InternalModeUUIDs.decode(cat([2], uuidA, [1])), ItemPayloadError, { kind: "truncated", needed: 35, available: 18 })
    throwsInfo(() => InternalModeUUIDs.decode(bytes(0, 0)), ItemPayloadError, { kind: "overlong", expected: 1, actual: 2 })
    throwsInfo(() => InternalModeUUIDs.decode(bytes(0xff)), ItemPayloadError, { kind: "truncated", needed: 1 + 17 * 255, available: 1 })
  })

  test("internalModeUUIDEncoderLimits", () => {
    assert.deepEqual(InternalModeUUID.fromBytes(uuidA)?.bytes, uuidA)
    assert.equal(InternalModeUUID.fromBytes(uuidA.slice(0, -1)), undefined)
    const entry = new InternalModeEntry({ uuid: new InternalModeUUID({ high: 1n, low: 2n }), activeContext: 3 })
    const output = new ByteWriter()
    output.u8(0xee)
    throwsInfo(() => InternalModeUUIDs.append(new Array<InternalModeEntry>(256).fill(entry), output), ScreenValueEncodingError, {
      kind: "tooManyEntries",
      count: 256,
      limit: 255
    })
    assert.deepEqual(output.toBytes(), bytes(0xee), "nothing is appended on failure")
    InternalModeUUIDs.append(new Array<InternalModeEntry>(255).fill(entry), output)
    assert.equal(output.length, 1 + 1 + 255 * 17)
    assert.equal(InternalModeUUIDs.decode(output.toBytes().subarray(1)).count, 255)
  })

  // MARK: DYNT_FOCUS_1

  test("dyntFocusReadsFixedFieldsThenContainerIDs", () => {
    const input = cat([2], u16BE(258), u16BE(772), u16BE(5), u16BE(0x0106), [7, 9, 0xff])
    const focus = DyntFocus.decode(input)
    assert.ok(focus.areaID === 2 && focus.row === 258 && focus.col === 772 && focus.rowOffset === 5 && focus.colOffset === 0x0106)
    assert.deepEqual(focus.containerIDs, byteRange(9, 12))
    assert.deepEqual(focus.containerIDs.of(input), bytes(7, 9, 0xff))
    assert.deepEqual(
      written(output =>
        DyntFocus.append({ areaID: 2, row: 258, col: 772, rowOffset: 5, colOffset: 0x0106, containerIDs: bytes(7, 9, 0xff) }, output)
      ),
      input
    )
    const bare = DyntFocus.decode(input.slice(0, 9))
    assert.ok(bare.containerIDs.isEmpty)
    throwsInfo(() => DyntFocus.decode(input.slice(0, 8)), ItemPayloadError, { kind: "truncated", needed: 9, available: 8 })
  })

  // MARK: CONTAINER NAME and KERNEL_VERSION

  test("containerNameSplitsThreeStrings", () => {
    const input = cat(ascii("ZZPOND_SUB"), [0], ascii("LILYPAD"), [0], ascii("0042"), [0], [0x20])
    const name = ContainerName.decode(input)
    assert.deepEqual([name.subscreenName, name.containerName, name.subdynproName], [byteRange(0, 10), byteRange(11, 18), byteRange(19, 23)])
    assert.equal(name.trailingByteCount, 1)
    const empty = ContainerName.decode(bytes(0, 0, 0))
    assert.deepEqual([empty.subscreenName, empty.containerName, empty.subdynproName], [byteRange(0, 0), byteRange(1, 1), byteRange(2, 2)])
    assert.equal(empty.trailingByteCount, 0)
    for (let count = 0; count < 23; count++) assert.throws(() => ContainerName.decode(input.slice(0, count)), ItemPayloadError)
    assert.deepEqual(
      written(output => ContainerName.append(ascii("ZZPOND_SUB"), ascii("LILYPAD"), ascii("0042"), output)),
      input.slice(0, -1)
    )
  })

  test("zeroTerminatedEncodersRefuseZeroBytes", () => {
    const good = ascii("ok")
    const bad = bytes(0x41, 0x00, 0x42)
    const output = new ByteWriter()
    output.u8(0xee)
    throwsInfo(() => ContainerName.append(bad, good, good, output), ScreenValueEncodingError, { kind: "zeroByteInString", index: 0 })
    throwsInfo(() => appendKernelVersion(good, bad, good, output), ScreenValueEncodingError, { kind: "zeroByteInString", index: 1 })
    throwsInfo(() => appendKernelVersion(good, good, bad, output), ScreenValueEncodingError, { kind: "zeroByteInString", index: 2 })
    assert.deepEqual(output.toBytes(), bytes(0xee), "nothing is appended on failure")
    appendKernelVersion(ascii("QUACKDB 9"), ascii("4242"), new Uint8Array(0), output)
    const version = KernelVersion.decode(output.toBytes().subarray(1))
    assert.deepEqual([version.databaseVersion, version.kernelVersion, version.patchLevel], [byteRange(0, 9), byteRange(10, 14), byteRange(15, 15)])
  })

  // MARK: Text items

  // textItemsAreThoseOfTheSpecsTables: needs ScreenText.swift (next wave)
  // trimmingRemovesTrailingSpacesAndZeros: needs ScreenText.swift and ScreenIdentity.swift (next wave)
  // textItemEncoder: needs ScreenText.swift and ScreenIdentity.swift (next wave)

  // MARK: Spec-gap numbers

  /**
   * Every gap number a screen codec throws names an open spec-gap issue that exists. The check that
   * each issue file exists and is open reads Swooey's issues/ folder, which this repository does
   * not have; the numbers themselves are checked.
   */
  test("specGapNumbersNameOpenIssues", () => {
    const numbers = [
      CodecSpecGap.itemValueLengthPolicy,
      CodecSpecGap.serverScreenComposition,
      CodecSpecGap.menuEntries,
      CodecSpecGap.focusItems,
      CodecSpecGap.atCodesInTexts,
      CodecSpecGap.identityItemRepeats,
      CodecSpecGap.functionTrigger,
      CodecSpecGap.uiEventDataWidth,
      CodecSpecGap.applPayloadLayouts,
      CodecSpecGap.xmlblobValue,
      CodecSpecGap.dyntDialogFlags
    ]
    assert.deepEqual(numbers, [39, 49, 50, 51, 53, 54, 55, 56, 33, 20, 34])
  })
})
