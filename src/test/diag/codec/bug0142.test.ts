// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/Bug0142Tests.swift (MIT).

// Issue #142: the owner's session report counted six repeated identity items (spec gap #54) on a
// popup whose messages hold two window sections, each opened by an SES item (PV-0984): the main
// window's identity, then the popup's. Reading R-EL-23: the identity is the last section's; an item
// once in each section is no repeat; the session's texts come from the first when the last lacks
// them.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AreaSize, ScreenIdentity, ScreenSpecGapError, ServerEcho } from "../../../diag/codec/index.js"
import { appl, ascii, bytes, cat, repeated, throwsInfo } from "../../support/codecTestSupport.js"
import { identityText, rawAreaSize } from "../../support/screenTestSupport.js"

describe("Screen identity: window sections", () => {
  /** An SES simple item (type 0x01, 16 bytes, PV-0420) with modal_number `level`. */
  function ses(level = 0): Uint8Array {
    const value = new Uint8Array(16)
    value[7] = level
    return cat([0x01], value)
  }

  /** The owner's popup message in outline, with invented texts: the transaction, then the main window's section, then the popup's. */
  const twoSections = cat(
    appl(0x06, 0x07, ascii("ZZDAM_MON")),
    ses(),
    appl(0x0c, 0x07, rawAreaSize(22, 84, 22, 84)),
    appl(0x06, 0x0c, ascii("314")),
    appl(0x06, 0x0f, ascii("ZZ_DAM_MONITOR")),
    appl(0x06, 0x10, ascii("ZZLODGE")),
    appl(0x06, 0x0d, ascii("ZZ_DAM_MONITOR")),
    appl(0x06, 0x0e, ascii("1000")),
    appl(0x0c, 0x09, ascii("Watch the Beaver Dam")),
    ses(1),
    appl(0x0c, 0x07, rawAreaSize(5, 56, 5, 56)),
    appl(0x06, 0x0f, ascii("ZZ_DAM_MONITOR")),
    appl(0x06, 0x10, ascii("ZZLOG")),
    appl(0x06, 0x0d, ascii("ZZ_DAM_MONITOR")),
    appl(0x06, 0x0e, ascii("1100")),
    appl(0x0c, 0x09, ascii("Which Dam, Which Beavers?"))
  )

  /** Two sections: the popup's identity and size, the session's texts from the first, no #54 repeat (bug #142). */
  test("popupSections", () => {
    const items = twoSections
    const identity = ScreenIdentity.decode(items)
    assert.equal(identity.windowSections, 2)
    assert.ok(identity.diagnostics.repeatedIdentityItems === 0 && identity.diagnostics.isClean)
    assert.deepEqual(identityText(identity, "sessionTitle", items), ascii("Which Dam, Which Beavers?"))
    assert.deepEqual(identityText(identity, "dynproNumber", items), ascii("1100"))
    assert.deepEqual(identityText(identity, "cuaStatus", items), ascii("ZZLOG"))
    assert.deepEqual(identityText(identity, "tcode", items), ascii("ZZDAM_MON"), "before the first SES: the first section's")
    assert.deepEqual(identityText(identity, "client", items), ascii("314"), "the session's, from the first section")
    assert.equal(identityText(identity, "guiTheme", items), undefined)
    assert.deepEqual(identity.areaSize(), new AreaSize({ windowHeight: 5, windowWidth: 56, areaHeight: 5, areaWidth: 56 }))
    assert.ok(identity.occurrences("dynproName") === 1 && identity.areaSizeOccurrences === 1)
    assert.ok(!identity.isLogonProgram(items))
  })

  /** A repeat within one section is still #54; one SES or none reads the whole message (bug #142). */
  test("repeatsWithinASection", () => {
    const repeated = cat(ses(), appl(0x06, 0x0d, ascii("ZZ_ONE")), ses(1), appl(0x06, 0x0d, ascii("ZZ_TWO")), appl(0x06, 0x0d, ascii("ZZ_THREE")))
    const identity = ScreenIdentity.decode(repeated)
    throwsInfo(() => identity.programName(), ScreenSpecGapError, { kind: "specGap", issue: 54 })
    assert.equal(identity.diagnostics.repeatedIdentityItems, 1)
    const one = cat(appl(0x06, 0x0d, ascii("SAPMSYST")), ses(), appl(0x06, 0x0e, ascii("0020")))
    const logon = ScreenIdentity.decode(one)
    assert.equal(logon.windowSections, 1)
    assert.ok(logon.isLogonProgram(one), "one section: the items before the SES count")
    const none = cat(appl(0x06, 0x0d, ascii("ZZ_A")), appl(0x06, 0x0d, ascii("ZZ_B")))
    const whole = ScreenIdentity.decode(none)
    assert.ok(whole.windowSections === 0 && whole.diagnostics.repeatedIdentityItems === 1)
  })

  /** The echo of a message of two sections: the last section's window state, never the other's (bug #142). */
  test("echoOfTheLastSection", () => {
    const mainCHL = repeated(0x11, 22)
    const popupCHL = repeated(0x22, 22)
    const items = cat(ses(), appl(0x05, 0x01, mainCHL), appl(0x0c, 0x06, [0x33, 0x33]), appl(0x0a, 0x01, [0x44]), ses(1), appl(0x05, 0x01, popupCHL))
    const echo = new ServerEcho(items)
    assert.deepEqual(echo.dynnCHL, popupCHL)
    assert.ok(echo.scrollInfos2 === undefined && echo.containerReset === undefined, "the popup's section has none: not the main window's")
    const one = cat(ses(), appl(0x05, 0x01, mainCHL), appl(0x0a, 0x01, [0x44]), appl(0x0a, 0x01, [0x55]))
    const whole = new ServerEcho(one)
    assert.deepEqual([whole.dynnCHL, whole.containerReset], [mainCHL, bytes(0x44)], "one section: the first CONTAINER RESET, as before")
    assert.ok(echo.replacesWindowState && !whole.replacesWindowState)
    const merged = whole.clone()
    merged.merge(echo, undefined)
    assert.deepEqual(
      [merged.dynnCHL, merged.scrollInfos2, merged.containerReset],
      [popupCHL, undefined, undefined],
      "the popup's window state replaces the older one whole"
    )
    merged.merge(new ServerEcho(appl(0x0a, 0x01, [0x66])), undefined)
    assert.deepEqual([merged.dynnCHL, merged.containerReset], [popupCHL, bytes(0x66)], "one section: the newer value where it has one")
  })
})
