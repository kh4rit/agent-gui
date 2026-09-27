// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/ScreenModelTests/Bug0158Tests.swift (MIT).

// Issue #158: a runtime-error list and a monitor's parameter popup showed a placeholder or a
// blank area where their grid belonged. The grid's shell was linked to the custom container's
// name (`LinkContainer`), which the screen's CONTAINER NAME item carries in its first string; the
// second holds the program and the third the screen number (trial-derived, PV-1011: the owner's
// session report of 2026-09-26 showed 21, 20 and 4 bytes for a 21-character container name, a
// 20-character program and a four-digit screen). Swooey took the second string for the name.
//
// Swift's `ScreenPlacementTests.Items` (ScreenPlacementTests.swift) is rebuilt below with the
// members this file uses, since only this file may be written.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ApplItem, ContainerGeometry, ContainerName, DiagItemEncoder, type ApplSIDContainer } from "../../../diag/codec/index.js"
import { Screen } from "../../../diag/screen/index.js"
import { ByteWriter } from "../../../diag/wire/index.js"

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Item sequences built with DiagCodec's encoders (Swift `ScreenPlacementTests.Items`). */
class Items {
  readonly writer = new ByteWriter()

  get bytes(): Uint8Array {
    return this.writer.toBytes()
  }

  container(sid: ApplSIDContainer, geometry: { id: number; row: number; col: number; width: number; height: number }): void {
    const value = new ByteWriter()
    new ContainerGeometry({ containerID: geometry.id, row: geometry.row, col: geometry.col, width: geometry.width, height: geometry.height }).append(value)
    DiagItemEncoder.appendAPPL(ApplItem.container(sid), value.toBytes(), this.writer)
  }

  reset(): void {
    this.container("reset", { id: 0, row: 0, col: 0, width: 0, height: 0 })
  }

  containerName(subscreen: string, container: string, subdynpro: string): void {
    const value = new ByteWriter()
    ContainerName.append(utf8(subscreen), utf8(container), utf8(subdynpro), value)
    DiagItemEncoder.appendAPPL(ApplItem.container("containerName"), value.toBytes(), this.writer)
  }
}

describe("Issue #158: a custom container's name is the first string of CONTAINER NAME", () => {
  /** a CONTROL container's name is the element name, not the program (bug #158) */
  test("controlName", () => {
    const items = new Items()
    items.reset()
    items.container("control", { id: 1, row: 2, col: 1, width: 80, height: 14 })
    items.containerName("ZZ_DUCK_GRID_CONTAINER", "ZZ_DUCK_PROGRAM", "0100")
    const screen = Screen.fromItems(items.bytes)
    const control = screen.containers.find(container => container.kind === "control")
    assert.ok(control !== undefined, "the screen has a CONTROL container")
    assert.equal(control.name, "ZZ_DUCK_GRID_CONTAINER")
  })

  /** an empty first string names nothing (bug #158) */
  test("emptyName", () => {
    const items = new Items()
    items.reset()
    items.container("loop", { id: 1, row: 1, col: 1, width: 20, height: 4 })
    items.containerName("", "ZZ_DUCK_PROGRAM", "0100")
    const screen = Screen.fromItems(items.bytes)
    assert.equal(screen.containers[0]?.name, undefined)
  })
})
