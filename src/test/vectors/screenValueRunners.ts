// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/ScreenVectorRunners.swift (MIT): the server-screen kinds
// of protocol spec v2 whose code is in DiagCodec's foundation, appl-fields, imode-uuids,
// dynt-focus and stringz-fields (docs/protocol/server-screen.md). The menu-entries and
// screen-identity runners need MenuEntries.swift and ScreenIdentity.swift (next wave).

import {
  ApplItem,
  ContainerName,
  DyntFocus,
  InternalModeUUIDs,
  ItemPayloadError,
  KernelVersion,
  ScreenValue,
  ScreenValueEncodingError,
  ScreenValueLayout,
  appendKernelVersion,
  type ByteRange,
  type InternalModeEntry,
  type ScrollInfos
} from "../../diag/codec/index.js"
import { ByteWriter, bytesEqual, concatBytes, hexByte, hexText } from "../../diag/wire/index.js"
import { checkError, compare, itemPayloadErrorClass } from "./codecRunners.js"
import type { Expectations } from "./expectations.js"
import { registerKind } from "./registry.js"
import { NO_ERROR } from "./wireRunners.js"

/**
 * The `expect.field.<name>` keys of an appl-fields value and their values, in value order (README,
 * "appl-fields", layouts table).
 */
export function screenValueFields(value: ScreenValue): [string, number][] {
  switch (value.kind) {
    case "areaSize":
      return [
        ["window_height", value.value.windowHeight],
        ["window_width", value.value.windowWidth],
        ["area_height", value.value.areaHeight],
        ["area_width", value.value.areaWidth]
      ]
    case "fontMetric":
      return [
        ["var_y", value.value.variableY],
        ["var_x", value.value.variableX],
        ["fixed_y", value.value.fixedY],
        ["fixed_x", value.value.fixedX]
      ]
    case "containerGeometry":
      return [
        ["container_id", value.value.containerID],
        ["row", value.value.row],
        ["col", value.value.col],
        ["width", value.value.width],
        ["height", value.value.height]
      ]
    case "scrollInfos":
      return scrollFields(value.value)
    case "scrollInfos2":
      return [
        ...scrollFields(value.value.scroll),
        ["visible_height", value.value.visibleHeight],
        ["visible_width", value.value.visibleWidth],
        ["scroll_flag", value.value.scrollFlag]
      ]
    case "containerLoop":
      return [["lines_per_loop_row", value.value.linesPerLoopRow]]
    case "listFocus":
      return [
        ["version", value.value.version],
        ["row", value.value.row],
        ["col", value.value.col]
      ]
  }
}

function scrollFields(scroll: ScrollInfos): [string, number][] {
  return [
    ["total_height", scroll.totalHeight],
    ["total_width", scroll.totalWidth],
    ["data_height", scroll.dataHeight],
    ["data_width", scroll.dataWidth],
    ["height_offset", scroll.heightOffset],
    ["width_offset", scroll.widthOffset]
  ]
}

/**
 * Reads the input keys `expect.id` and `expect.sid`, which select a layout. When one is missing or
 * malformed (already a recorded problem), the other keys are marked as read.
 */
function applItemInput(expect: Expectations): ApplItem | undefined {
  const id = expect.byte("expect.id")
  const sid = expect.byte("expect.sid")
  if (id === undefined || sid === undefined) {
    expect.consumeAll()
    return undefined
  }
  return ApplItem.of(id, sid)
}

/** Swift `do { … } catch { actualError = VectorNames.errorClass(error) }` on an item value decoder. */
function payloadErrorClass(body: () => void): string {
  try {
    body()
    return NO_ERROR
  } catch (error) {
    if (!(error instanceof ItemPayloadError)) throw error
    return itemPayloadErrorClass(error.info)
  }
}

// MARK: appl-fields

/** The fixed-size value decoders of server-screen.md §8 (README, "appl-fields"). */
function runApplFields(input: Uint8Array, expect: Expectations, failures: string[]): void {
  const item = applItemInput(expect)
  if (!item) return
  const layout = ScreenValueLayout.of(item)
  if (!layout) {
    failures.push(`no appl-fields layout for ${ApplItem.displayName(item)}`)
    expect.consumeAll()
    return
  }
  let value: ScreenValue | undefined
  const actualError = payloadErrorClass(() => {
    value = ScreenValue.decode(layout, input)
  })
  if (!checkError(actualError, expect, failures) || !value) return
  for (const [name, actual] of screenValueFields(value)) compare(`field.${name}`, expect.int(`expect.field.${name}`), actual, failures)
  const encoded = ScreenValue.bytes(value)
  if (!bytesEqual(encoded, input)) failures.push(`round trip: encoding the fields gives ${hexText(encoded)}`)
}

// MARK: imode-uuids

/** The IMODEUUIDS2 decoder (README, "imode-uuids"). */
function runIModeUUIDs(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let uuids: InternalModeUUIDs | undefined
  const actualError = payloadErrorClass(() => {
    uuids = InternalModeUUIDs.decode(input)
  })
  if (!checkError(actualError, expect, failures) || !uuids) return
  const decoded = uuids
  const entries: InternalModeEntry[] = Array.from({ length: decoded.count }, (_, index) => decoded.entry(index, input))
  const count = expect.int("expect.count")
  if (count === undefined) return
  compare("count", count, decoded.count, failures)
  for (let number = 1; number <= count; number++) {
    const uuid = expect.hex(`expect.uuid.${number}`)
    const active = expect.byte(`expect.active.${number}`)
    if (number > entries.length) continue
    const entry = entries[number - 1]
    compare(`uuid.${number}`, uuid === undefined ? undefined : hexText(uuid), hexText(entry.uuid.bytes), failures)
    if (active !== undefined && active !== entry.activeContext)
      failures.push(`active.${number}: expected ${hexByte(active)}, got ${hexByte(entry.activeContext)}`)
  }
  const output = new ByteWriter()
  try {
    InternalModeUUIDs.append(entries, output)
  } catch (error) {
    if (!(error instanceof ScreenValueEncodingError)) throw error
    failures.push(`round trip: the encoder refused the decoded entries (${error.message})`)
  }
  const encoded = output.toBytes()
  if (!bytesEqual(encoded, input)) failures.push(`round trip: encoding the entries gives ${hexText(encoded)}`)
}

// MARK: dynt-focus

/** The DYNT_FOCUS_1 decoder (README, "dynt-focus"). */
function runDyntFocus(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let focus: DyntFocus | undefined
  const actualError = payloadErrorClass(() => {
    focus = DyntFocus.decode(input)
  })
  if (!checkError(actualError, expect, failures) || !focus) return
  compare("area_id", expect.int("expect.area_id"), focus.areaID, failures)
  compare("row", expect.int("expect.row"), focus.row, failures)
  compare("col", expect.int("expect.col"), focus.col, failures)
  compare("row_offset", expect.int("expect.row_offset"), focus.rowOffset, failures)
  compare("col_offset", expect.int("expect.col_offset"), focus.colOffset, failures)
  const containers = focus.containerIDs.of(input).slice()
  const expectedContainers = expect.hex("expect.containers")
  compare("containers", expectedContainers === undefined ? undefined : hexText(expectedContainers), hexText(containers), failures)
  const output = new ByteWriter()
  DyntFocus.append(
    { areaID: focus.areaID, row: focus.row, col: focus.col, rowOffset: focus.rowOffset, colOffset: focus.colOffset, containerIDs: containers },
    output
  )
  const encoded = output.toBytes()
  if (!bytesEqual(encoded, input)) failures.push(`round trip: encoding the fields gives ${hexText(encoded)}`)
}

// MARK: stringz-fields

/** The string splitters of CONTAINER NAME and KERNEL_VERSION (README, "stringz-fields"). */
function runStringzFields(input: Uint8Array, expect: Expectations, failures: string[]): void {
  const item = applItemInput(expect)
  if (!item) return
  const isContainerName = ApplItem.equals(item, ApplItem.container("containerName"))
  const isKernelVersion = ApplItem.equals(item, ApplItem.stSystemInfo("kernelVersion"))
  if (!isContainerName && !isKernelVersion) {
    failures.push(`no stringz-fields layout for ${ApplItem.displayName(item)}`)
    expect.consumeAll()
    return
  }
  let strings: ByteRange[] = []
  let trailing = 0
  const actualError = payloadErrorClass(() => {
    if (isContainerName) {
      const name = ContainerName.decode(input)
      strings = [name.subscreenName, name.containerName, name.subdynproName]
      trailing = name.trailingByteCount
    } else {
      const version = KernelVersion.decode(input)
      strings = [version.databaseVersion, version.kernelVersion, version.patchLevel]
      trailing = version.trailingByteCount
    }
  })
  if (!checkError(actualError, expect, failures) || actualError !== NO_ERROR) return
  compare("trailing", expect.int("expect.trailing"), trailing, failures)
  const count = expect.int("expect.strings")
  if (count === undefined) return
  compare("strings", count, strings.length, failures)
  for (let number = 1; number <= count; number++) {
    const offset = expect.int(`expect.string.${number}.offset`)
    const length = expect.int(`expect.string.${number}.length`)
    if (number > strings.length) continue
    compare(`string ${number} offset`, offset, strings[number - 1].lowerBound, failures)
    compare(`string ${number} length`, length, strings[number - 1].count, failures)
  }
  // Round trip: each string with one zero byte, then the trailing bytes.
  const [first, second, third] = strings.map(range => range.of(input).slice())
  const output = new ByteWriter()
  try {
    if (isContainerName) ContainerName.append(first, second, third, output)
    else appendKernelVersion(first, second, third, output)
  } catch (error) {
    if (!(error instanceof ScreenValueEncodingError)) throw error
    failures.push(`round trip: the encoder refused the decoded strings (${error.message})`)
  }
  const encoded = concatBytes(output.toBytes(), input.subarray(input.length - trailing))
  if (!bytesEqual(encoded, input)) failures.push(`round trip: encoding the strings gives ${hexText(encoded)}`)
}

// menu-entries and screen-identity: needs MenuEntries.swift and ScreenIdentity.swift (next wave).

registerKind("appl-fields", runApplFields)
registerKind("imode-uuids", runIModeUUIDs)
registerKind("dynt-focus", runDyntFocus)
registerKind("stringz-fields", runStringzFields)
