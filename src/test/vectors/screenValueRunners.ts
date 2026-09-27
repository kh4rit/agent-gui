// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/VectorSupport/ScreenVectorRunners.swift (MIT): the server-screen kinds
// of protocol spec v2, appl-fields, imode-uuids, dynt-focus, stringz-fields, menu-entries and
// screen-identity (docs/protocol/server-screen.md).

import {
  ApplItem,
  ContainerName,
  DyntFocus,
  InternalModeUUIDs,
  ItemPayloadError,
  KernelVersion,
  MenuEntries,
  MenuEntryFlags,
  ScreenIdentity,
  ScreenIdentityError,
  ScreenSpecGapError,
  ScreenValue,
  ScreenValueEncodingError,
  ScreenValueLayout,
  appendKernelVersion,
  type AreaSize,
  type ByteRange,
  type InternalModeEntry,
  type MenuEntry,
  type MenuEntryWalkErrorInfo,
  type ScreenIdentityErrorInfo,
  type ScreenIdentityText,
  type ScrollInfos
} from "../../diag/codec/index.js"
import { ByteWriter, bytesEqual, concatBytes, hexByte, hexText } from "../../diag/wire/index.js"
import { checkError, compare, itemPayloadErrorClass, itemWalkErrorClass } from "./codecRunners.js"
import { dyntAtomWalkErrorClass } from "./dyntRunners.js"
import type { Expectations } from "./expectations.js"
import { registerKind } from "./registry.js"
import { NO_ERROR } from "./wireRunners.js"

/** Error classes of the menu-entries kind. */
export function menuEntryWalkErrorClass(info: MenuEntryWalkErrorInfo): string {
  switch (info.kind) {
    case "truncated":
      return "truncated"
    case "lengthMismatch":
      return "entry-length-mismatch"
  }
}

/** Error classes of the screen-identity kind: a failing walk reports the walker's own class (README, "screen-identity"). */
export function screenIdentityErrorClass(info: ScreenIdentityErrorInfo): string {
  switch (info.kind) {
    case "items":
      return itemWalkErrorClass(info.value.info)
    case "atoms":
      return dyntAtomWalkErrorClass(info.value.info)
  }
}

/**
 * A `text` value (README, "Value types") for bytes the decoder found: the bytes as printable ASCII,
 * or, when they are not, a marker that no vector text equals.
 */
export function vectorText(bytes: Uint8Array): string {
  if (bytes.length === 0) return "(empty text)"
  if (!bytes.every(byte => byte >= 0x20 && byte <= 0x7e)) return `(not printable ASCII: ${hexText(bytes)})`
  return String.fromCharCode(...bytes)
}

/** The screen-identity text keys and the identity texts they name, in the README's order. */
export const identityTextKeys: readonly { readonly key: string; readonly text: ScreenIdentityText }[] = [
  { key: "dbname", text: "dbName" },
  { key: "client", text: "client" },
  { key: "cpuname", text: "cpuName" },
  { key: "tcode", text: "tcode" },
  { key: "dynproname", text: "dynproName" },
  { key: "dynpronumber", text: "dynproNumber" },
  { key: "cuaname", text: "cuaName" },
  { key: "cuastatus", text: "cuaStatus" },
  { key: "gui_theme", text: "guiTheme" },
  { key: "session_title", text: "sessionTitle" },
  { key: "session_icon", text: "sessionIcon" }
]

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

// MARK: menu-entries

/** The menu-entry walker (README, "menu-entries"). Entries produced before an error count. */
function runMenuEntries(input: Uint8Array, expect: Expectations, failures: string[]): void {
  const walk = MenuEntries.walk(input)
  compare("error", expect.string("expect.error"), walk.error ? menuEntryWalkErrorClass(walk.error.info) : NO_ERROR, failures)
  if (walk.error) compare("error.entry", expect.int("expect.error.entry"), walk.error.entryIndex, failures)
  checkEntryLayout(walk.entries, input, failures)
  const count = expect.int("expect.entries")
  if (count === undefined) return
  compare("entries", count, walk.entries.length, failures)
  for (let number = 1; number <= count; number++)
    checkMenuEntry(number, number <= walk.entries.length ? walk.entries[number - 1] : undefined, expect, failures)
}

const MENU_ENTRY_INT_KEYS = [
  "offset",
  "length",
  "position_1",
  "position_2",
  "position_3",
  "position_4",
  "virtual_key",
  "text_offset",
  "text_length",
  "accelerator_offset",
  "accelerator_length",
  "info_offset",
  "info_length"
] as const

function checkMenuEntry(number: number, entry: MenuEntry | undefined, expect: Expectations, failures: string[]): void {
  const prefix = `expect.entry.${number}.`
  const ints = MENU_ENTRY_INT_KEYS.map(key => [key, expect.int(prefix + key)] as const)
  const flags = expect.byte(prefix + "flags")
  const flagNames = expect.names(prefix + "flags.names")
  const returnCodes = expect.hex(prefix + "return_codes")
  const functionCodes = expect.hex(prefix + "function_codes")
  if (!entry) return
  const fields = entry.fields
  const actual: Record<(typeof MENU_ENTRY_INT_KEYS)[number], number> = {
    offset: entry.offset,
    length: entry.length,
    position_1: fields.position1,
    position_2: fields.position2,
    position_3: fields.position3,
    position_4: fields.position4,
    virtual_key: fields.virtualKey,
    text_offset: entry.text.lowerBound,
    text_length: entry.text.count,
    accelerator_offset: entry.accelerator.lowerBound,
    accelerator_length: entry.accelerator.count,
    info_offset: entry.info.lowerBound,
    info_length: entry.info.count
  }
  for (const [key, expected] of ints) compare(`entry ${number} ${key}`, expected, actual[key], failures)
  if (flags !== undefined && flags !== fields.flags) failures.push(`entry ${number} flags: expected ${hexByte(flags)}, got ${hexByte(fields.flags)}`)
  compare(`entry ${number} flags.names`, flagNames, MenuEntryFlags.names(fields.flags), failures)
  compare(`entry ${number} return_codes`, returnCodes === undefined ? undefined : hexText(returnCodes), hexText(fields.returnCodes.bytes), failures)
  compare(
    `entry ${number} function_codes`,
    functionCodes === undefined ? undefined : hexText(functionCodes),
    hexText(fields.functionCodes.bytes),
    failures
  )
}

/**
 * Implementation checks every vector gets: the entries tile the input from offset 0, and re-encoding
 * each entry from its fields and strings gives back its bytes.
 */
function checkEntryLayout(entries: readonly MenuEntry[], input: Uint8Array, failures: string[]): void {
  let offset = 0
  for (const entry of entries) {
    if (entry.offset !== offset || entry.endOffset > input.length) {
      failures.push(`entry ${entry.index} does not start where entry ${entry.index - 1} ended`)
      return
    }
    offset = entry.endOffset
    const output = new ByteWriter()
    try {
      MenuEntries.appendEntry(entry.fields, entry.text.of(input).slice(), entry.accelerator.of(input).slice(), entry.info.of(input).slice(), output)
    } catch (error) {
      if (!(error instanceof ScreenValueEncodingError)) throw error
      failures.push(`entry ${entry.index}: the encoder refused it (${error.message})`)
    }
    const encoded = output.toBytes()
    if (!bytesEqual(encoded, input.subarray(entry.offset, entry.endOffset))) failures.push(`entry ${entry.index}: re-encoding gives ${hexText(encoded)}`)
  }
}

// MARK: screen-identity

/**
 * Screen-identity extraction (README, "screen-identity"): the item walker, then the text, AREASIZE,
 * atom and menu decoders, with R-SS-4 trimming. No round trip.
 */
function runScreenIdentity(input: Uint8Array, expect: Expectations, failures: string[]): void {
  let identity: ScreenIdentity | undefined
  let actualError = NO_ERROR
  try {
    identity = ScreenIdentity.decode(input)
  } catch (error) {
    if (!(error instanceof ScreenIdentityError)) throw error
    actualError = screenIdentityErrorClass(error.info)
  }
  if (!checkError(actualError, expect, failures) || !identity) return
  for (const { key, text } of identityTextKeys) {
    const expected = expect.string(`expect.${key}`)
    let actual: string
    try {
      const range = identity.text(text)
      actual = range === undefined ? "none" : vectorText(range.of(input))
    } catch (error) {
      if (!(error instanceof ScreenSpecGapError)) throw error
      actual = `(spec gap: ${error.message})`
    }
    compare(key, expected, actual, failures)
  }
  checkArea(identity, expect, failures)
  compare("atoms", expect.int("expect.atoms"), identity.atomCount, failures)
  compare("efields", expect.int("expect.efields"), identity.inputFieldCount, failures)
  compare("efields.invisible", expect.int("expect.efields.invisible"), identity.passwordFieldCount, failures)
  compare("menus", expect.int("expect.menus"), identity.menuCount, failures)
  compare("menu_entries", expect.int("expect.menu_entries"), identity.menuEntryCount, failures)
}

function checkArea(identity: ScreenIdentity, expect: Expectations, failures: string[]): void {
  const area = expect.string("expect.area")
  if (area === undefined) return
  let size: AreaSize | undefined
  try {
    size = identity.areaSize()
  } catch (error) {
    if (!(error instanceof ScreenSpecGapError)) throw error
    failures.push(`area: ${error.message}`)
    return
  }
  switch (area) {
    case "present": {
      const names = ["window_height", "window_width", "area_height", "area_width"] as const
      const expected = names.map(name => [name, expect.int(`expect.area.${name}`)] as const)
      if (!size) {
        failures.push(`area: expected present, got ${identity.areaSizeOccurrences === 0 ? "none" : "an undecodable AREASIZE"}`)
        return
      }
      const actual = [size.windowHeight, size.windowWidth, size.areaHeight, size.areaWidth]
      expected.forEach(([name, value], index) => compare(`area.${name}`, value, actual[index], failures))
      break
    }
    case "none":
      if (identity.areaSizeOccurrences !== 0) failures.push("area: expected none, got an AREASIZE item")
      break
    default:
      failures.push(`area: '${area}' is neither present nor none`)
  }
}

registerKind("appl-fields", runApplFields)
registerKind("imode-uuids", runIModeUUIDs)
registerKind("dynt-focus", runDyntFocus)
registerKind("stringz-fields", runStringzFields)
registerKind("menu-entries", runMenuEntries)
registerKind("screen-identity", runScreenIdentity)
