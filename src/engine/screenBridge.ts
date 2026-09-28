// SPDX-License-Identifier: MIT
// The parts of Swooey's SwooeyApp ScreenBridge that agent-gui keeps (MIT): how a message is read
// as a screen, and the input step of a submission on a screen.

import { UIEventFunctionKey, type ClientInputStep } from "../diag/codec/index.js"
import {
  MultipleLogonQuestion,
  Screen,
  ScreenReadings,
  type FieldEdits,
  type FunctionReadings,
  type FunctionTrigger,
  type ScreenElementID,
  type ScreenPick
} from "../diag/screen/index.js"
import type { ServerMessage } from "../diag/session/index.js"

export const ScreenBridge = {
  /**
   * The screen `message` shows (Swift `ScreenBridge.screen`); throws `ScreenDecodingError`. The
   * unverified nesting of subscreens stays within the GUI blob opt-in (#188).
   */
  screen(message: ServerMessage): Screen {
    const readings = new ScreenReadings({ nestedSubscreens: message.control?.guiBlob !== undefined })
    return Screen.fromMessage(message, { codePage: message.codePage, readings })
  },

  /**
   * The input step of a submission on `screen` (Swift `ScreenBridge.inputStep`); throws
   * `ScreenInputError`. On the logon program's multiple-logon question confirmed natively (its
   * numeric radios and the Enter event of PV-1028), the step carries the corrected session state
   * (PV-1034, verified live); every other step keeps its SES as received. Swooey's transient #148
   * comparisons (reference header, popup state, APPL4 carriers, GUI document) are developer
   * toggles, off by default, and not carried over.
   */
  inputStep(
    screen: Screen,
    edits: FieldEdits,
    trigger: FunctionTrigger,
    options: { readings: FunctionReadings; cursor?: ScreenElementID; listCursor?: ScreenPick }
  ): ClientInputStep {
    const step = screen.inputStep(edits, trigger, { readings: options.readings, cursor: options.cursor, listCursor: options.listCursor })
    // #148: never change the credentials screen or another transaction.
    if (MultipleLogonQuestion.of(screen) !== undefined && sameBytes(step.uiEvent, UIEventFunctionKey.multipleLogonEnter)) {
      step.nativeLogonSession = true // provenance: PV-1034
    }
    return step
  }
} as const

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index])
}
