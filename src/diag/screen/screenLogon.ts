// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/ScreenModel/ScreenLogon.swift (MIT).

// Screens of the logon program the logon gate answers by their structure (docs/credentials.md §4
// rule 3: by screen identity and structure, never by text): the multiple-logon question (issue
// #148, PV-0742, PV-0743).
//
// Swift's `extension Screen` of this file (`mainWindowScreen`) is `ScreenLogon.mainWindowScreen`,
// which takes the screen; `Screen.mainWindowScreen` calls it.

import type { Screen } from "./screen.js"
import { WindowLevelCarry } from "./screenCarry.js"
import type { ScreenElementID } from "./screenElement.js"
import { GridPoint } from "./screenLayout.js"

/** The members Swift's `extension Screen` of ScreenLogon.swift adds; `Screen` calls them. */
export const ScreenLogon = {
  /**
   * The main window a popup message sent with content of its own (Reading R-EL-23, issue #147): the
   * last lower section of level 0 that carries content; undefined otherwise.
   */
  mainWindowScreen(screen: Screen): Screen | undefined {
    for (let index = screen.lowerWindows.length - 1; index >= 0; index--) {
      if (WindowLevelCarry.level(screen.lowerWindows[index]) === 0) return screen.lowerWindows[index]
    }
    return undefined
  }
} as const

/**
 * The question's three answers, by the field name of the radio button that chooses each (Swift
 * `MultipleLogonQuestion.Option`, raw values 1 to 3).
 * - `endOtherLogons`: go on with this logon and end the other logons of the user (`MULTI_LOGON_OPT1`).
 * - `continueLogon`: go on with this logon; the other logons stay, and the server records the
 *   multiple logon (`MULTI_LOGON_OPT2`).
 * - `cancelLogon`: end this logon (`MULTI_LOGON_OPT3`).
 */
export type MultipleLogonQuestionOption = "endOtherLogons" | "continueLogon" | "cancelLogon"

const OPTION_NUMBERS: Readonly<Record<MultipleLogonQuestionOption, number>> = { endOtherLogons: 1, continueLogon: 2, cancelLogon: 3 }

export const MultipleLogonQuestionOption = {
  allCases: ["endOtherLogons", "continueLogon", "cancelLogon"] as readonly MultipleLogonQuestionOption[],

  /** The raw value, 1 to 3. */
  rawValue(option: MultipleLogonQuestionOption): number {
    return OPTION_NUMBERS[option]
  },

  /**
   * The field name (FNAME) of the option's radio button on the owner's system (PV-0743): a protocol
   * identifier, as the logon program's name is.
   */
  fieldName(option: MultipleLogonQuestionOption): string {
    return `MULTI_LOGON_OPT${OPTION_NUMBERS[option]}`
  }
} as const

/**
 * The logon program's multiple-logon question (docs/credentials.md §5.1, issue #148): after a logon
 * step whose password the server accepted, while the same user is logged on elsewhere, the server
 * asks in a popup whether to go on and end the other logons, go on without ending them, or end this
 * logon. The gate recognises it by structure: the logon program (R-SS-5), shown as a popup (its
 * window section's level is 1 or more, Reading R-EL-13), with one radio group holding exactly one
 * radio button for each of the three field names of `MultipleLogonQuestionOption` (PV-0743). Its
 * texts are never read to recognise it.
 */
export class MultipleLogonQuestion {
  /** The radio button of each option. */
  readonly buttons: ReadonlyMap<MultipleLogonQuestionOption, ScreenElementID>
  /** The option whose button the server sent selected, if any. */
  readonly selected: MultipleLogonQuestionOption | undefined
  /**
   * The popup's first text: the first output or label with a text, in reading order (the server says
   * there that the user is logged on already, and where). For the user's own eyes only.
   */
  readonly information: string | undefined

  private constructor(
    buttons: ReadonlyMap<MultipleLogonQuestionOption, ScreenElementID>,
    selected: MultipleLogonQuestionOption | undefined,
    information: string | undefined
  ) {
    this.buttons = buttons
    this.selected = selected
    this.information = information
  }

  /**
   * The question `screen` asks, or undefined when it is not the multiple-logon question: not the
   * logon program, not a popup, or not exactly one radio button for each option's field name.
   * Whether the buttons' states were read (#107) does not matter: the field names say what each
   * chooses. (Swift `init?(_:)`.)
   */
  static of(screen: Screen): MultipleLogonQuestion | undefined {
    if (!screen.isLogonScreen || screen.presentation.kind !== "popup") return undefined
    const buttons = new Map<MultipleLogonQuestionOption, ScreenElementID>()
    for (const element of screen.elements) {
      if (element.kind.kind !== "radioButton") continue
      const name = element.fieldName
      const option = name === undefined ? undefined : MultipleLogonQuestionOption.allCases.find(candidate => MultipleLogonQuestionOption.fieldName(candidate) === name)
      if (option === undefined) continue
      if (buttons.has(option)) return undefined
      buttons.set(option, element.id)
    }
    if (buttons.size !== MultipleLogonQuestionOption.allCases.length) return undefined
    const selected = MultipleLogonQuestionOption.allCases.find(option => {
      const id = buttons.get(option)
      return id !== undefined && screen.element(id)?.isChecked === true
    })
    let first: { caption: string; placement: GridPoint } | undefined
    for (const element of screen.elements) {
      if (element.kind.kind !== "output" && element.kind.kind !== "label") continue
      const caption = element.caption ?? ""
      if (caption.length === 0) continue
      if (first === undefined || GridPoint.compare(element.placement, first.placement) < 0) first = { caption, placement: element.placement }
    }
    return new MultipleLogonQuestion(buttons, selected, first?.caption)
  }
}
