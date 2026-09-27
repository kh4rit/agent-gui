// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/SessionModes.swift (MIT).

// Modes: the SAP sessions of one connection (docs/protocol/session.md §8, docs/architecture.md §4).
// Every DIAG message names its mode in the header's mode byte (Reading R-MO-1); the session keeps
// what the reference input envelope echoes per mode, and each input step carries its window's
// mode (R-MO-2). A message in a mode the session has not seen opens it (R-MO-3); a header-only
// message with com_flag EOC in one of several open modes ends that mode (R-MO-5).

import { ServerEcho } from "../codec/index.js"

/** What the session keeps for one open mode. A Swift struct: `clone()` copies it. */
export class ModeState {
  /**
   * What the reference input envelope echoes in this mode's input steps (client-input.md §11,
   * Readings R-CI-12 and R-CI-15): the latest values of this mode's messages (Reading R-MO-4).
   */
  echo = new ServerEcho()
  /** DIAG messages received in this mode. */
  messages = 0

  /** A copy, the echo included. */
  clone(): ModeState {
    const copy = new ModeState()
    copy.echo = this.echo.clone()
    copy.messages = this.messages
    return copy
  }
}

/**
 * What one server message did to the connection's modes (session.md §8).
 * - `opened`: the message is the first in a mode other than the connection's first: the server
 *   opened a new mode, as it does for `/oCODE` (Reading R-MO-3).
 * - `ended`: the message is header-only with com_flag EOC in one of several open modes: the server
 *   ended that mode and the connection stays (Reading R-MO-5).
 */
export type ModeEvent = "opened" | "ended"
